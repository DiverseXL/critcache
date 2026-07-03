import fs from "node:fs";
import chalk from "chalk";
import pLimit from "p-limit";
import { analyzeFile, synthesize, } from "./btl-client.js";
// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------
const MAX_FILE_READ_SIZE = 200 * 1024; // belt-and-suspenders match for walker's cap
/** Truncates a relative path for display so long monorepo paths don't wrap. */
function displayPath(relPath, maxLen = 50) {
    if (relPath.length <= maxLen)
        return relPath;
    return "…" + relPath.slice(-(maxLen - 1));
}
function statusIcon(status) {
    switch (status) {
        case "pending": return chalk.dim("○");
        case "running": return chalk.yellow("◐");
        case "done": return chalk.green("●");
        case "error": return chalk.red("✕");
    }
}
function cacheTierBadge(tier) {
    if (!tier || tier === "none" || tier === "miss")
        return chalk.dim("[miss]");
    return chalk.cyan(`[${tier}]`);
}
/** Renders one row's current state as a single terminal line. */
function renderRow(row) {
    const icon = statusIcon(row.status);
    const p = displayPath(row.file.relPath);
    if (row.status === "pending" || row.status === "running") {
        return `  ${icon} ${p}`;
    }
    if (row.status === "error") {
        const msg = row.result?.requestError ?? row.result?.parseError ?? "unknown error";
        return `  ${icon} ${p} ${chalk.red(`— ${msg.slice(0, 60)}`)}`;
    }
    // done
    const usage = row.result?.usage;
    const saved = usage?.savedUsd !== undefined ? `$${usage.savedUsd.toFixed(4)} saved` : "—";
    const badge = cacheTierBadge(usage?.cacheTier);
    return `  ${icon} ${p} ${badge} ${chalk.dim(saved)}`;
}
/**
 * Moves the cursor up `previousLineCount` lines and clears each line,
 * so we can redraw the whole file list in place rather than scrolling a
 * new block every update. File rows stay in their original walker-order
 * positions on screen regardless of which one finishes first.
 */
function redrawLines(lines, previousLineCount) {
    if (previousLineCount > 0) {
        process.stdout.write(`\x1b[${previousLineCount}A`); // move cursor up N lines
    }
    for (const line of lines) {
        process.stdout.write("\x1b[2K" + line + "\n"); // clear line, write new content
    }
}
// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------
/**
 * Runs BTL analysis across all walked files with bounded concurrency,
 * rendering live in-place progress in the terminal. After all per-file
 * calls complete, fires one synthesis call and folds its cost into totals.
 *
 * Returns the full per-file result set, synthesis output, and aggregated
 * savings totals for the final summary table and report writer.
 */
export async function runAnalysis(files, concurrency) {
    const rows = files.map((file) => ({ file, status: "pending" }));
    const limit = pLimit(concurrency);
    let previousLineCount = 0;
    function rerender() {
        const lines = rows.map(renderRow);
        redrawLines(lines, previousLineCount);
        previousLineCount = lines.length;
    }
    // Draw the full pending list immediately so the user sees scope upfront.
    rerender();
    const tasks = rows.map((row) => limit(async () => {
        row.status = "running";
        rerender();
        // Read file (sync is fine — we're inside an async p-limit task)
        let content;
        try {
            content = fs.readFileSync(row.file.absPath, "utf-8").slice(0, MAX_FILE_READ_SIZE);
        }
        catch (err) {
            row.status = "error";
            row.result = {
                analysis: null,
                usage: {
                    cacheTier: undefined,
                    benchmarkCostUsd: undefined,
                    customerChargeUsd: undefined,
                    savedUsd: undefined,
                },
                requestError: `Failed to read file: ${err.message}`,
            };
            rerender();
            return;
        }
        const result = await analyzeFile(row.file.relPath, content);
        row.result = result;
        row.status = result.requestError || result.parseError ? "error" : "done";
        rerender();
    }));
    await Promise.all(tasks);
    // ---------------------------------------------------------------------------
    // Aggregate per-file totals
    // ---------------------------------------------------------------------------
    let totalSavedUsd = 0;
    let totalBenchmarkCostUsd = 0;
    let totalChargeUsd = 0;
    let cacheHits = 0;
    let cacheMisses = 0;
    for (const row of rows) {
        const usage = row.result?.usage;
        if (!usage)
            continue;
        totalSavedUsd += usage.savedUsd ?? 0;
        totalBenchmarkCostUsd += usage.benchmarkCostUsd ?? 0;
        totalChargeUsd += usage.customerChargeUsd ?? 0;
        // A hit is any tier that isn't explicitly "no cache".
        // NOTE: verify exact strings against a live BTL response —
        // could be "none", "miss", undefined, or empty string.
        const tier = usage.cacheTier;
        if (tier && tier !== "none" && tier !== "miss") {
            cacheHits += 1;
        }
        else if (row.status === "done") {
            cacheMisses += 1;
        }
    }
    // ---------------------------------------------------------------------------
    // Synthesis pass — one extra BTL call across all successful analyses
    // ---------------------------------------------------------------------------
    const successfulAnalyses = rows
        .filter((row) => row.status === "done" && row.result?.analysis)
        .map((row) => ({ path: row.file.relPath, ...row.result.analysis }));
    let synthesis = null;
    let synthesisError;
    if (successfulAnalyses.length > 0) {
        console.log(chalk.dim("\nSynthesizing repo-level findings…"));
        const synthResult = await synthesize(successfulAnalyses);
        synthesis = synthResult.synthesis;
        synthesisError = synthResult.requestError ?? synthResult.parseError;
        // Fold synthesis call's cost into the running totals
        totalSavedUsd += synthResult.usage.savedUsd ?? 0;
        totalBenchmarkCostUsd += synthResult.usage.benchmarkCostUsd ?? 0;
        totalChargeUsd += synthResult.usage.customerChargeUsd ?? 0;
    }
    else {
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
//# sourceMappingURL=runner.js.map