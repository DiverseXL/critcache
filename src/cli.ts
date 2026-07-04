#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { walkRepo } from "./walker.js";
import { runAnalysis } from "./runner.js";
import { writeReport } from "./report.js";
import { runComparison, renderComparisonTable } from "./compare.js";
import { fetchModels, fetchStats } from "./btl-client.js";

const program = new Command();

function printBanner() {
  console.log(chalk.green(`
  ▄▄▄ ▄▄▄ ▄ ▄▄▄ ▄▄▄ ▄▄▄ ▄▄▄ ▄ ▄ ▄▄▄
  █   █▄▄ █  █  █   █▀█ █   █▀█ █▀▀
  ▀▀▀ ▀   ▀  ▀  ▀▀▀ ▀ ▀ ▀▀▀ ▀ ▀ ▀▀▀`));
  console.log(chalk.dim(`  v0.1.1 · parallel AI code review · powered by BTL Runtime`));
  console.log(chalk.dim(`  ─────────────────────────────────────────────────\n`));
}

program
  .name("critcache")
  .description("Fan out parallel AI code-review agents across a repo through BTL Runtime, and watch the cache savings land live.")
  .version("0.1.0");

/**
 * Resolves a repo path into a ranked, capped file list, handling and
 * reporting errors consistently across every command that needs this step.
 * Returns null if resolution failed or no files were found — callers should
 * treat null as "stop, the error/message has already been printed."
 */
function resolveFiles(repo: string, maxFiles: number) {
  let files;
  try {
    files = walkRepo(repo, { maxFiles });
  } catch (err) {
    console.error(chalk.red(`Failed to walk repo: ${(err as Error).message}`));
    process.exitCode = 1;
    return null;
  }

  if (files.length === 0) {
    console.log(chalk.yellow("No reviewable files found. Check the path and try again."));
    return null;
  }

  return files;
}

program
  .command("analyze")
  .description("Analyze a repo: pick files, review them via BTL Runtime, report savings.")
  .argument("<repo>", "Path to the repo to analyze")
  .option("-m, --max-files <n>", "Maximum number of files to analyze", "20")
  .option("-c, --concurrency <n>", "Number of parallel requests", "6")
  .option("-o, --output <path>", "Output report path", "critcache-report.md")
  .action(async (repo: string, opts: { maxFiles: string; concurrency: string; output: string }) => {
    const maxFiles = Number.parseInt(opts.maxFiles, 10);
    const concurrency = Number.parseInt(opts.concurrency, 10);

    console.log(chalk.bold(`\ncritcache — scanning ${chalk.cyan(repo)}\n`));

    const files = resolveFiles(repo, maxFiles);
    if (!files) return;

    console.log(chalk.dim(`Found ${files.length} file(s) to review (capped at ${maxFiles}, concurrency ${concurrency}):\n`));

    const result = await runAnalysis(files, concurrency);

    // --- Final summary table ---
    const table = new Table({ head: [chalk.bold("Metric"), chalk.bold("Value")] });
    table.push(
      ["Files analyzed", String(result.rows.length)],
      ["Cache hits", String(result.cacheHits)],
      ["Cache misses", String(result.cacheMisses)],
      ["Benchmark cost (no caching)", `$${result.totalBenchmarkCostUsd.toFixed(4)}`],
      ["Actual charge (via BTL)", `$${result.totalChargeUsd.toFixed(4)}`],
      [chalk.green.bold("Total saved"), chalk.green.bold(`$${result.totalSavedUsd.toFixed(4)}`)]
    );

    console.log("\n" + table.toString());

    if (result.synthesisError) {
      console.log(chalk.yellow(`\nSynthesis note: ${result.synthesisError}`));
    }

    try {
      writeReport(result, opts.output, repo);
      console.log(chalk.dim(`\nFull report written to ${opts.output}`));
    } catch (err) {
      console.error(chalk.red(`Failed to write report: ${(err as Error).message}`));
    }
  });

program
  .command("compare")
  .description("Run analysis twice on the same repo back-to-back to prove BTL Runtime's cache savings, cold vs warm.")
  .argument("<repo>", "Path to the repo to analyze")
  .option("-m, --max-files <n>", "Maximum number of files to analyze", "20")
  .option("-c, --concurrency <n>", "Number of parallel requests", "6")
  .action(async (repo: string, opts: { maxFiles: string; concurrency: string }) => {
    const maxFiles = Number.parseInt(opts.maxFiles, 10);
    const concurrency = Number.parseInt(opts.concurrency, 10);

    console.log(chalk.bold(`\ncritcache compare — ${chalk.cyan(repo)}\n`));
    console.log(chalk.dim("Running the same analysis twice, back to back, to show BTL's cache kick in.\n"));

    const files = resolveFiles(repo, maxFiles);
    if (!files) return;

    console.log(chalk.dim(`Found ${files.length} file(s) (capped at ${maxFiles}, concurrency ${concurrency}).`));

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
      console.log(
        chalk.green.bold(
          `\nCache hit rate jumped from ${hitRate1.toFixed(0)}% to ${hitRate2.toFixed(0)}% on the warm pass.`
        )
      );
    } else {
      console.log(
        chalk.yellow(
          `\nNo improvement in cache hit rate (${hitRate1.toFixed(0)}% → ${hitRate2.toFixed(0)}%). ` +
          `This can happen if BTL's cache TTL is short or caching is disabled for this key — worth checking the BTL dashboard.`
        )
      );
    }
  });

program
  .command("models")
  .description("List available models on BTL Runtime.")
  .action(async () => {
    printBanner();
    console.log(chalk.bold(`\nFetching available models from BTL Runtime...\n`));

    const result = await fetchModels();

    if (result.requestError) {
      console.error(chalk.red(`Error: ${result.requestError}`));
      process.exitCode = 1;
      return;
    }

    if (result.models.length === 0) {
      console.log(chalk.yellow("No models returned. Check your GATEWAY_API_KEY."));
      return;
    }

    const table = new Table({
      head: [chalk.bold("Model ID"), chalk.bold("Owner")],
    });

    for (const model of result.models) {
      const isBtl = model.owned_by === "btl" || model.id.startsWith("btl-");
      const idDisplay = isBtl ? chalk.green(model.id) : model.id;
      table.push([idDisplay, model.owned_by ?? "—"]);
    }

    console.log(table.toString());
    console.log(chalk.dim(`\nPass any model ID as BTL_MODEL env var:`));
    console.log(chalk.dim(`  BTL_MODEL=btl-2 npx critcache analyze .`));
  });

program
  .command("stats")
  .description("Show cumulative spend and savings across all critcache runs in your BTL Runtime workspace.")
  .action(async () => {
    printBanner();
    console.log(chalk.bold(`\nFetching usage summary from BTL Runtime...\n`));

    const result = await fetchStats();

    if (result.requestError) {
      console.error(chalk.red(`Error: ${result.requestError}`));
      process.exitCode = 1;
      return;
    }

    if (!result.summary && !result.raw) {
      console.log(chalk.yellow("No usage data returned."));
      return;
    }

    if (result.summary) {
      const table = new Table({ head: [chalk.bold("Metric"), chalk.bold("Value")] });

      if (result.summary.totalRequests !== undefined)
        table.push(["Total requests", String(result.summary.totalRequests)]);
      if (result.summary.totalSpend !== undefined)
        table.push(["Benchmark cost", `$${result.summary.totalSpend.toFixed(4)}`]);
      if (result.summary.totalSaved !== undefined)
        table.push([chalk.green.bold("Total saved"), chalk.green.bold(`$${result.summary.totalSaved.toFixed(4)}`)]);
      if (result.summary.cachedTokens !== undefined)
        table.push(["Cached input tokens", result.summary.cachedTokens.toLocaleString()]);
      if (result.summary.cacheHitRate !== undefined)
        table.push(["Cache hit rate", `${result.summary.cacheHitRate.toFixed(0)}%`]);
      if (result.summary.period)
        table.push(["Period", result.summary.period]);

      console.log(table.toString());
    }

    // If BTL's response shape differs from what we expected,
    // print the raw JSON as a fallback so nothing is hidden.
    if (result.raw && Object.keys(result.raw).length > 0 && !result.summary?.totalRequests) {
      console.log(chalk.dim("\nRaw response from BTL Runtime:"));
      console.log(chalk.dim(JSON.stringify(result.raw, null, 2)));
    }

    console.log(chalk.dim(`\nView full breakdown at https://runtime.badtheorylabs.com/dashboard`));
  });

program.parse();