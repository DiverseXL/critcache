import fs from "node:fs";
import chalk from "chalk";
import pLimit from "p-limit";
import type { WalkedFile } from "./walker.js";
import { analyzeFile, synthesize, type AnalyzeFileResult, type RepoSynthesis } from "./btl-client.js";

/** Per-file state tracked for the live render. */
type FileStatus = "pending" | "running" | "done" | "error";

interface FileRow {
  file: WalkedFile;
  status: FileStatus;
  result?: AnalyzeFileResult;
}

export interface RunResult {
  rows: FileRow[];
  synthesis: RepoSynthesis | null;
  synthesisError?: string;
  totalSavedUsd: number;
  totalBenchmarkCostUsd: number;
  totalChargeUsd: number;
  cacheHits: number;
  cacheMisses: number;
}

const MAX_FILE_READ_SIZE = 200 * 1024; // matches walker's default cap, belt-and-suspenders

/** Truncates a relative path for display so long monorepo paths don't wrap the line. */
function displayPath(relPath: string, maxLen = 50): string {
  if (relPath.length <= maxLen) return relPath;
  return "…" + relPath.slice(-(maxLen - 1));
}

function statusIcon(status: FileStatus): string {
  switch (status) {
    case "pending":
      return chalk.dim("○");
    case "running":
      return chalk.yellow("◐");
    case "done":
      return chalk.green("●");
    case "error":
      return chalk.red("✕");
  }
}

function cacheTierBadge(tier: string | undefined): string {
  if (!tier || tier === "none" || tier === "miss") return chalk.dim("[miss]");
  // BTL Runtime returns values like "exact_response_cache", "prefix_cache" etc.
  // Shorten them for display: "exact_response_cache" → "exact", "prefix_cache" → "prefix"
  const shortTier = tier.replace("_response_cache", "").replace("_cache", "");
  return chalk.cyan(`[${shortTier}]`);
}

/** Renders one row's current state as a single terminal line. */
function renderRow(row: FileRow): string {
  const icon = statusIcon(row.status);
  const path = displayPath(row.file.relPath);

  if (row.status === "pending" || row.status === "running") {
    return `  ${icon} ${path}`;
  }

  if (row.status === "error") {
    const msg = row.result?.requestError ?? row.result?.parseError ?? "unknown error";
    return `  ${icon} ${path} ${chalk.red(`— ${msg.slice(0, 60)}`)}`;
  }

  // done
  const usage = row.result?.usage;
  const saved = usage?.savedUsd !== undefined ? `$${usage.savedUsd.toFixed(4)} saved` : "—";
  const badge = cacheTierBadge(usage?.cacheTier);
  return `  ${icon} ${path} ${badge} ${chalk.dim(saved)}`;
}

/**
 * Moves the cursor up `n` lines and clears each, so we can redraw the
 * whole file list in place rather than scrolling a new block every update.
 */
function redrawLines(lines: string[], previousLineCount: number) {
  if (previousLineCount > 0) {
    process.stdout.write(`\x1b[${previousLineCount}A`); // move cursor up
  }
  for (const line of lines) {
    process.stdout.write("\x1b[2K" + line + "\n"); // clear line, write new content
  }
}

/**
 * Runs analysis across all walked files with bounded concurrency,
 * rendering live progress in place. Returns the full result set plus
 * aggregated savings totals for the final summary table.
 */
export async function runAnalysis(
  files: WalkedFile[],
  concurrency: number
): Promise<RunResult> {
  const rows: FileRow[] = files.map((file) => ({ file, status: "pending" }));
  const limit = pLimit(concurrency);

  let previousLineCount = 0;
  function rerender() {
    const lines = rows.map(renderRow);
    redrawLines(lines, previousLineCount);
    previousLineCount = lines.length;
  }

  // Initial draw so the user sees the full pending list immediately.
  rerender();

  const tasks = rows.map((row) =>
    limit(async () => {
      row.status = "running";
      rerender();

      let content: string;
      try {
        content = fs.readFileSync(row.file.absPath, "utf-8").slice(0, MAX_FILE_READ_SIZE);
      } catch (err) {
        row.status = "error";
        row.result = {
          analysis: null,
          usage: { cacheTier: undefined, benchmarkCostUsd: undefined, customerChargeUsd: undefined, savedUsd: undefined, requestId: undefined, responseTimeMs: undefined },
          requestError: `Failed to read file: ${(err as Error).message}`,
        };
        rerender();
        return;
      }

      const result = await analyzeFile(row.file.relPath, content);
      row.result = result;
      row.status = result.requestError || result.parseError ? "error" : "done";
      rerender();
    })
  );

  await Promise.all(tasks);

  // Aggregate totals across every row that has usage data.
  let totalSavedUsd = 0;
  let totalBenchmarkCostUsd = 0;
  let totalChargeUsd = 0;
  let cacheHits = 0;
  let cacheMisses = 0;

  for (const row of rows) {
    const usage = row.result?.usage;
    if (!usage) continue;

    totalSavedUsd += usage.savedUsd ?? 0;
    totalBenchmarkCostUsd += usage.benchmarkCostUsd ?? 0;
    totalChargeUsd += usage.customerChargeUsd ?? 0;

    if (usage.cacheTier && usage.cacheTier !== "none" && usage.cacheTier !== "miss") {
      cacheHits += 1;
    } else if (row.status === "done") {
      cacheMisses += 1;
    }
  }

  // Run the synthesis pass over every successfully-analyzed file.
  // This is one extra BTL call, separate from the per-file ones above,
  // so its cost/savings get folded into the same running totals.
  const successfulAnalyses = rows
    .filter((row) => row.status === "done" && row.result?.analysis)
    .map((row) => ({ path: row.file.relPath, ...row.result!.analysis! }));

  let synthesis: RepoSynthesis | null = null;
  let synthesisError: string | undefined;

  if (successfulAnalyses.length > 0) {
    console.log(chalk.dim("\nSynthesizing repo-level findings…"));
    const synthResult = await synthesize(successfulAnalyses);

    synthesis = synthResult.synthesis;
    synthesisError = synthResult.requestError ?? synthResult.parseError;

    totalSavedUsd += synthResult.usage.savedUsd ?? 0;
    totalBenchmarkCostUsd += synthResult.usage.benchmarkCostUsd ?? 0;
    totalChargeUsd += synthResult.usage.customerChargeUsd ?? 0;
  } else {
    synthesisError = "No successfully analyzed files to synthesize from.";
  }

  return {
    rows,
    synthesis,
    synthesisError,
    totalSavedUsd,
    totalBenchmarkCostUsd,
    totalChargeUsd,
    cacheHits,
    cacheMisses,
  };
}