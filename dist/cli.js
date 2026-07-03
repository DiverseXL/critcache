#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { walkRepo } from "./walker.js";
import { runAnalysis } from "./runner.js";
import { writeReport } from "./report.js";
import { runComparison, renderComparisonTable } from "./compare.js";
const program = new Command();
program
    .name("critcache")
    .description("Fan out parallel AI code-review agents across a repo through BTL Runtime, " +
    "and watch the cache savings land live.")
    .version("0.1.0");
// ---------------------------------------------------------------------------
// Shared helper
// ---------------------------------------------------------------------------
/**
 * Resolves a repo path into a ranked, capped file list, handling and
 * reporting errors consistently across every command that needs this step.
 * Returns null if resolution failed or no files were found — callers should
 * treat null as "stop, the error/message has already been printed."
 */
function resolveFiles(repo, maxFiles) {
    let files;
    try {
        files = walkRepo(repo, { maxFiles });
    }
    catch (err) {
        console.error(chalk.red(`\nFailed to walk repo: ${err.message}\n`));
        process.exitCode = 1;
        return null;
    }
    if (files.length === 0) {
        console.log(chalk.yellow("No reviewable files found. Check the path and try again."));
        return null;
    }
    return files;
}
// ---------------------------------------------------------------------------
// analyze command
// ---------------------------------------------------------------------------
program
    .command("analyze")
    .description("Analyze a repo: pick files, review them via BTL Runtime, report savings.")
    .argument("<repo>", "Path to the repo to analyze")
    .option("-m, --max-files <n>", "Maximum number of files to analyze", "20")
    .option("-c, --concurrency <n>", "Number of parallel requests", "6")
    .option("-o, --output <path>", "Output report path", "critcache-report.md")
    .action(async (repo, opts) => {
    const maxFiles = Number.parseInt(opts.maxFiles, 10);
    const concurrency = Number.parseInt(opts.concurrency, 10);
    if (Number.isNaN(maxFiles) || maxFiles < 1) {
        console.error(chalk.red("Error: --max-files must be a positive integer"));
        process.exitCode = 1;
        return;
    }
    if (Number.isNaN(concurrency) || concurrency < 1) {
        console.error(chalk.red("Error: --concurrency must be a positive integer"));
        process.exitCode = 1;
        return;
    }
    console.log(chalk.bold(`\ncritcache — scanning ${chalk.cyan(repo)}\n`));
    const files = resolveFiles(repo, maxFiles);
    if (!files)
        return;
    console.log(chalk.dim(`Found ${files.length} file(s) to review` +
        ` (cap ${maxFiles}, concurrency ${concurrency}):\n`));
    const result = await runAnalysis(files, concurrency);
    // Summary table
    const table = new Table({
        head: [chalk.bold("Metric"), chalk.bold("Value")],
        style: { head: [] },
    });
    table.push(["Files analyzed", String(result.rows.length)], ["Cache hits", String(result.cacheHits)], ["Cache misses", String(result.cacheMisses)], ["Benchmark cost (no caching)", `$${result.totalBenchmarkCostUsd.toFixed(4)}`], ["Actual charge (via BTL)", `$${result.totalChargeUsd.toFixed(4)}`], [
        chalk.green.bold("Total saved"),
        chalk.green.bold(`$${result.totalSavedUsd.toFixed(4)}`),
    ]);
    if (result.totalBenchmarkCostUsd > 0) {
        const pct = (result.totalSavedUsd / result.totalBenchmarkCostUsd) * 100;
        table.push([chalk.bold("Savings rate"), chalk.bold(`${pct.toFixed(1)}%`)]);
    }
    console.log("\n" + table.toString());
    if (result.synthesisError) {
        console.log(chalk.yellow(`\nSynthesis note: ${result.synthesisError}`));
    }
    try {
        writeReport(result, opts.output, repo);
        console.log(chalk.dim(`\nFull report written to ${opts.output}\n`));
    }
    catch (err) {
        console.error(chalk.red(`\nFailed to write report: ${err.message}\n`));
    }
});
// ---------------------------------------------------------------------------
// compare command
// ---------------------------------------------------------------------------
program
    .command("compare")
    .description("Run analysis twice on the same repo back-to-back to prove BTL Runtime's " +
    "cache savings, cold vs warm.")
    .argument("<repo>", "Path to the repo to analyze")
    .option("-m, --max-files <n>", "Maximum number of files to analyze", "20")
    .option("-c, --concurrency <n>", "Number of parallel requests", "6")
    .action(async (repo, opts) => {
    const maxFiles = Number.parseInt(opts.maxFiles, 10);
    const concurrency = Number.parseInt(opts.concurrency, 10);
    if (Number.isNaN(maxFiles) || maxFiles < 1) {
        console.error(chalk.red("Error: --max-files must be a positive integer"));
        process.exitCode = 1;
        return;
    }
    if (Number.isNaN(concurrency) || concurrency < 1) {
        console.error(chalk.red("Error: --concurrency must be a positive integer"));
        process.exitCode = 1;
        return;
    }
    console.log(chalk.bold(`\ncritcache compare — ${chalk.cyan(repo)}\n`));
    console.log(chalk.dim("Running the same analysis twice, back to back, " +
        "to show BTL's cache kick in.\n"));
    const files = resolveFiles(repo, maxFiles);
    if (!files)
        return;
    console.log(chalk.dim(`Found ${files.length} file(s)` +
        ` (cap ${maxFiles}, concurrency ${concurrency}).`));
    const comparison = await runComparison(files, concurrency);
    console.log(chalk.bold.cyan("\n— Results —\n"));
    console.log(renderComparisonTable(comparison));
    const hitRate1 = comparison.pass1.rows.length > 0
        ? (comparison.pass1.cacheHits / comparison.pass1.rows.length) * 100
        : 0;
    const hitRate2 = comparison.pass2.rows.length > 0
        ? (comparison.pass2.cacheHits / comparison.pass2.rows.length) * 100
        : 0;
    if (hitRate2 > hitRate1) {
        console.log(chalk.green.bold(`\nCache hit rate jumped from ${hitRate1.toFixed(0)}% to ` +
            `${hitRate2.toFixed(0)}% on the warm pass.\n`));
    }
    else {
        console.log(chalk.yellow(`\nNo improvement in cache hit rate ` +
            `(${hitRate1.toFixed(0)}% → ${hitRate2.toFixed(0)}%). ` +
            `This can happen if BTL's cache TTL is short or caching is ` +
            `disabled for this key — worth checking the BTL dashboard.\n`));
    }
});
program.parse();
//# sourceMappingURL=cli.js.map