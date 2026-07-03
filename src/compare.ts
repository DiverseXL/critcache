import chalk from "chalk";
import Table from "cli-table3";
import type { WalkedFile } from "./walker.js";
import { runAnalysis, type RunResult } from "./runner.js";

export interface CompareResult {
  pass1: RunResult;
  pass2: RunResult;
  pass1DurationMs: number;
  pass2DurationMs: number;
}

/**
 * Runs the full analysis pass twice, back to back, over the same file set.
 * The point is purely demonstrative: pass 1 is the "cold" run (mostly cache
 * misses, since BTL hasn't seen this exact prompt+file combination before),
 * pass 2 is the "warm" run immediately after (should land mostly cache hits
 * on exact/prefix tiers, since the prompt scaffolding + file content are
 * byte-identical to pass 1).
 *
 * This function does not invent any new BTL-calling logic — it's a thin
 * orchestrator that calls runAnalysis twice and times each pass.
 */
export async function runComparison(
  files: WalkedFile[],
  concurrency: number,
): Promise<CompareResult> {
  console.log(chalk.bold.cyan("\n— Pass 1: cold run —\n"));
  const pass1Start = Date.now();
  const pass1 = await runAnalysis(files, concurrency);
  const pass1DurationMs = Date.now() - pass1Start;

  console.log(chalk.dim(`\nPass 1 completed in ${(pass1DurationMs / 1000).toFixed(1)}s`));

  console.log(chalk.bold.cyan("\n— Pass 2: warm run (same files, same prompts) —\n"));
  const pass2Start = Date.now();
  const pass2 = await runAnalysis(files, concurrency);
  const pass2DurationMs = Date.now() - pass2Start;

  console.log(chalk.dim(`\nPass 2 completed in ${(pass2DurationMs / 1000).toFixed(1)}s`));

  return { pass1, pass2, pass1DurationMs, pass2DurationMs };
}

// ---------------------------------------------------------------------------
// Delta helpers
// ---------------------------------------------------------------------------

/** Computes a percentage delta, handling the zero-baseline case safely. */
function pctDelta(before: number, after: number): string {
  if (before === 0) return after === 0 ? "0%" : "n/a";
  const delta = ((after - before) / before) * 100;
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)}%`;
}

/**
 * Computes a percentage-POINT delta (after − before), not a ratio. Used for
 * the hit-rate row specifically: going from 0% to 100% is meaningless as a
 * ratio ("n/a", can't divide by zero) but perfectly meaningful as "+100 pts".
 */
function pointDelta(before: number, after: number): string {
  const delta = after - before;
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${delta.toFixed(0)} pts`;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * Renders the pass1 vs pass2 delta as a terminal table. Kept separate from
 * runComparison so the orchestration logic and the presentation logic can
 * change independently.
 */
export function renderComparisonTable(result: CompareResult): string {
  const { pass1, pass2, pass1DurationMs, pass2DurationMs } = result;

  const table = new Table({
    head: [
      chalk.bold("Metric"),
      chalk.bold("Pass 1 (cold)"),
      chalk.bold("Pass 2 (warm)"),
      chalk.bold("Δ"),
    ],
    style: { head: [] },
  });

  const hitRate1 =
    pass1.rows.length > 0 ? (pass1.cacheHits / pass1.rows.length) * 100 : 0;
  const hitRate2 =
    pass2.rows.length > 0 ? (pass2.cacheHits / pass2.rows.length) * 100 : 0;

  table.push(
    [
      "Cache hit rate",
      `${hitRate1.toFixed(0)}%`,
      chalk.green(`${hitRate2.toFixed(0)}%`),
      pointDelta(hitRate1, hitRate2), // pts, not ratio — avoids division by zero on a 0% baseline
    ],
    [
      "Cache hits",
      String(pass1.cacheHits),
      chalk.green(String(pass2.cacheHits)),
      `${pass2.cacheHits - pass1.cacheHits >= 0 ? "+" : ""}${pass2.cacheHits - pass1.cacheHits}`,
    ],
    [
      "Total charge",
      `$${pass1.totalChargeUsd.toFixed(4)}`,
      chalk.green(`$${pass2.totalChargeUsd.toFixed(4)}`),
      pctDelta(pass1.totalChargeUsd, pass2.totalChargeUsd),
    ],
    [
      "Total saved",
      `$${pass1.totalSavedUsd.toFixed(4)}`,
      chalk.green(`$${pass2.totalSavedUsd.toFixed(4)}`),
      pctDelta(pass1.totalSavedUsd, pass2.totalSavedUsd),
    ],
    [
      "Wall time",
      `${(pass1DurationMs / 1000).toFixed(1)}s`,
      chalk.green(`${(pass2DurationMs / 1000).toFixed(1)}s`),
      pctDelta(pass1DurationMs, pass2DurationMs),
    ],
  );

  return table.toString();
}
