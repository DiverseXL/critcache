#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import path from "node:path";
import { walkRepo } from "./walker.js";
import { runAnalysis } from "./runner.js";
import { writeReport } from "./report.js";
import { runComparison, renderComparisonTable } from "./compare.js";
import { fetchModels, fetchProviders, fetchStats, getPromptComponents, runCacheCoach, setRulesContent } from "./btl-client.js";
import { loadRules } from "./rules.js";
import { watchRepo } from "./watch.js";
import { getDiffFiles, getDiffLabel } from "./diff.js";
import { buildSarifReport, writeSarifReport, deriveSarifPath, toRuleId } from "./sarif.js";
import {
  computeFingerprint,
  loadPreviousFingerprint,
  saveFingerprint,
  diffFingerprints,
  renderFingerprintBox,
} from "./fingerprint.js";

const program = new Command();

function printBanner() {
  console.log(chalk.green(`
  ▄▄▄ ▄▄▄ ▄ ▄▄▄ ▄▄▄ ▄▄▄ ▄▄▄ ▄ ▄ ▄▄▄
  █   █▄▄ █  █  █   █▀█ █   █▀█ █▀▀
  ▀▀▀ ▀   ▀  ▀  ▀▀▀ ▀ ▀ ▀▀▀ ▀ ▀ ▀▀▀`));
  console.log(chalk.dim(`  v0.1.6 · parallel AI code review · powered by BTL Runtime`));
  console.log(chalk.dim(`  ─────────────────────────────────────────────────\n`));
}

program
  .name("critcache")
  .description("Fan out parallel AI code-review agents across a repo through BTL Runtime, and watch the cache savings land live.")
  .version("0.1.0");

/**
 * Computes, diffs, renders, and saves the prompt fingerprint for a given repo.
 * Called at the start of analyze, compare, watch, and review-pr to show
 * developers whether the prompt architecture changed since the last run.
 *
 * @param repoPath - Path to the repo root
 * @param contextLabel - Optional label for the fingerprint box (e.g. "PR vs main")
 */
/**
 * Loads .critcacherules from the repo root and sets it on the BTL client.
 * Called once at the start of every command that performs analysis.
 * Non-fatal — rules are optional, and a missing file is silently ignored.
 */
function applyRules(repoPath: string): void {
  const resolvedRoot = path.resolve(repoPath);
  const rulesContent = loadRules(resolvedRoot);
  setRulesContent(rulesContent);

  if (rulesContent) {
    console.log(chalk.dim(`  Custom review rules active from .critcacherules`));
  }
}

/**
 * Computes, diffs, renders, and saves the prompt fingerprint for a given repo.
 * Called at the start of analyze, compare, watch, and review-pr to show
 * developers whether the prompt architecture changed since the last run.
 *
 * @param repoPath - Path to the repo root
 * @param contextLabel - Optional label for the fingerprint box (e.g. "PR vs main")
 */
function printFingerprint(repoPath: string, contextLabel?: string): void {
  const resolvedRoot = path.resolve(repoPath);
  const components = getPromptComponents();
  const current = computeFingerprint(components, contextLabel);
  const previous = loadPreviousFingerprint(resolvedRoot);
  const diff = diffFingerprints(current, previous);

  console.log(renderFingerprintBox(diff));
  console.log();

  saveFingerprint(resolvedRoot, current);
}

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
  .option("--sarif", "Also emit SARIF v2.1 output for GitHub Code Scanning / VS Code Sarif Viewer integration")
  .action(async (repo: string, opts: { maxFiles: string; concurrency: string; output: string; sarif?: boolean }) => {
    const maxFiles = Number.parseInt(opts.maxFiles, 10);
    const concurrency = Number.parseInt(opts.concurrency, 10);

    console.log(chalk.bold(`\ncritcache — scanning ${chalk.cyan(repo)}\n`));

    applyRules(repo);
    printFingerprint(repo);

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

    // SARIF output (optional)
    if (opts.sarif) {
      try {
        const sarifReport = buildSarifReport(result, repo);
        const sarifPath = deriveSarifPath(opts.output);
        writeSarifReport(sarifPath, sarifReport);
        console.log(chalk.dim(`SARIF output written to ${sarifPath}`));
        const absSarifPath = path.resolve(sarifPath);
        console.log(chalk.dim(`  Open in VS Code: code ${absSarifPath}`));
      } catch (err) {
        console.error(chalk.red(`Failed to write SARIF report: ${(err as Error).message}`));
      }
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

    applyRules(repo);
    printFingerprint(repo);

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
        table.push(["Total spend", `$${result.summary.totalSpend.toFixed(4)}`]);
      if (result.summary.totalSaved !== undefined)
        table.push([chalk.green.bold("Total saved"), chalk.green.bold(`$${result.summary.totalSaved.toFixed(4)}`)]);
      if (result.summary.cacheHitRate !== undefined)
        table.push(["Cache hit rate", `${result.summary.cacheHitRate.toFixed(1)}%`]);
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

program
  .command("watch")
  .description("Watch your repo for file changes and re-analyze through BTL Runtime live — showing cache hits, latency, and analysis diffs as you code.")
  .argument("<repo>", "Path to the repo to watch")
  .option("-m, --max-files <n>", "Maximum number of files to watch", "20")
  .option("-d, --debounce <ms>", "Debounce delay in ms after a file save", "600")
  .option("--sarif", "Also emit SARIF v2.1 output (updated on each file change for VS Code SARIF Viewer integration)")
  .action(async (repo: string, opts: { maxFiles: string; debounce: string; sarif?: boolean }) => {
    printBanner();

    const maxFiles = Number.parseInt(opts.maxFiles, 10);
    const debounceMs = Number.parseInt(opts.debounce, 10);

    applyRules(repo);
    printFingerprint(repo);

    // Set up SARIF output path for live watch mode
    const sarifOutput = opts.sarif ? "critcache-watch.sarif" : undefined;
    if (sarifOutput) {
      console.log(chalk.dim(`  SARIF output will be written to ${sarifOutput} on each change\n`));
    }

    try {
      await watchRepo(repo, {
        maxFiles,
        debounceMs,
        onAnalysis: (relPath, result) => {
          if (!sarifOutput) return;
          if (!result.analysis) return;

          // Build a single-result SARIF for live viewer consumption
          const sarifReport = {
            version: "2.1.0",
            $schema: "https://json.schemastore.org/sarif-2.1.0.json",
            runs: [
              {
                tool: {
                  driver: {
                    name: "critcache",
                    version: "0.1.4",
                    informationUri: "https://critcache.vercel.app",
                  },
                },
                results: [
                  {
                    ruleId: toRuleId(result.analysis.role),
                    level: "note",
                    message: { text: result.analysis.summary },
                    locations: [
                      {
                        physicalLocation: {
                          artifactLocation: { uri: encodeURI(relPath) },
                        },
                      },
                    ],
                    properties: {
                      complexity: result.analysis.complexity,
                      role: result.analysis.role,
                      cacheTier: result.usage.cacheTier ?? "none",
                      responseTimeMs: result.usage.responseTimeMs,
                    },
                  },
                ],
              },
            ],
          };

          try {
            writeSarifReport(sarifOutput, sarifReport);
          } catch {
            // Silent — don't crash the watcher for a write error
          }
        },
      });
    } catch (err) {
      console.error(chalk.red(`Watch error: ${(err as Error).message}`));
      process.exitCode = 1;
    }
  });

program
  .command("review-pr")
  .description("Analyze only the files changed in a PR branch vs a target (e.g. main, origin/main). Pipes git diff output into the existing analysis pipeline — no GitHub API needed.")
  .argument("<repo>", "Path to the repo containing the PR branch")
  .argument("<target>", "Target branch/ref to diff against (e.g. main, origin/main, HEAD~1)")
  .option("-c, --concurrency <n>", "Number of parallel requests", "6")
  .option("-o, --output <path>", "Output report path", "critcache-pr-report.md")
  .option("--sarif", "Also emit SARIF v2.1 output for GitHub Code Scanning / VS Code Sarif Viewer integration")
  .action(async (repo: string, target: string, opts: { concurrency: string; output: string; sarif?: boolean }) => {
    const concurrency = Number.parseInt(opts.concurrency, 10);

    console.log(chalk.bold(`\ncritcache review-pr — diffing ${chalk.cyan(repo)} against ${chalk.cyan(target)}\n`));

    applyRules(repo);

    // Compute and show the fingerprint with the PR context label
    const contextLabel = getDiffLabel(target);
    printFingerprint(repo, contextLabel);

    // Resolve diff files using git
    let files;
    try {
      files = getDiffFiles({
        repoRoot: path.resolve(repo),
        target,
      });
    } catch (err) {
      console.error(chalk.red(`Error: ${(err as Error).message}`));
      process.exitCode = 1;
      return;
    }

    if (files.length === 0) {
      console.log(chalk.yellow(`No changes found between the current branch and "${target}". Nothing to review.`));
      return;
    }

    console.log(chalk.dim(`Diff vs ${target}: ${files.length} changed file(s) to review (concurrency ${concurrency}):\n`));

    // Run the existing analysis pipeline on the diffed files
    const result = await runAnalysis(files, concurrency);

    // --- Final summary table ---
    const table = new Table({ head: [chalk.bold("Metric"), chalk.bold("Value")] });
    table.push(
      ["PR files analyzed", String(result.rows.length)],
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
      writeReport(result, opts.output, `${repo} (PR vs ${target})`);
      console.log(chalk.dim(`\nPR review report written to ${opts.output}`));
    } catch (err) {
      console.error(chalk.red(`Failed to write report: ${(err as Error).message}`));
    }

    // SARIF output (optional)
    if (opts.sarif) {
      try {
        const sarifReport = buildSarifReport(result, `${repo} (PR vs ${target})`);
        const sarifPath = deriveSarifPath(opts.output);
        writeSarifReport(sarifPath, sarifReport);
        console.log(chalk.dim(`SARIF output written to ${sarifPath}`));
        const absSarifPath = path.resolve(sarifPath);
        console.log(chalk.dim(`  Open in VS Code: code ${absSarifPath}`));
      } catch (err) {
        console.error(chalk.red(`Failed to write SARIF report: ${(err as Error).message}`));
      }
    }
  });

program
  .command("providers")
  .description("Show the health and routing status of all providers connected to BTL Runtime.")
  .action(async () => {
    printBanner();
    console.log(chalk.bold(`\nFetching provider catalog from BTL Runtime...\n`));

    const result = await fetchProviders();

    if (result.requestError) {
      console.error(chalk.red(`Error: ${result.requestError}`));
      process.exitCode = 1;
      return;
    }

    if (result.providers.length === 0 && result.raw) {
      console.log(chalk.dim("Raw response from BTL Runtime:"));
      console.log(chalk.dim(JSON.stringify(result.raw, null, 2)));
      console.log(chalk.dim(`\nView full breakdown at https://runtime.badtheorylabs.com/dashboard/providers`));
      return;
    }

    if (result.providers.length === 0) {
      console.log(chalk.yellow("No provider data returned. Check your GATEWAY_API_KEY."));
      return;
    }

    const table = new Table({
      head: [chalk.bold("Provider"), chalk.bold("Status"), chalk.bold("Latency")],
    });

    for (const provider of result.providers) {
      const isHealthy = provider.healthy !== false && provider.status !== "degraded";
      const statusDisplay = isHealthy
        ? chalk.green("● healthy")
        : chalk.red("✕ degraded");
      const latencyDisplay = provider.latency_ms !== undefined
        ? chalk.dim(`${provider.latency_ms}ms`)
        : chalk.dim("—");
      const nameDisplay = provider.name ?? provider.id;

      table.push([nameDisplay, statusDisplay, latencyDisplay]);
    }

    console.log(table.toString());
    console.log(chalk.dim(`\nBTL Runtime automatically routes to the cheapest healthy provider.`));
    console.log(chalk.dim(`View full details at https://runtime.badtheorylabs.com/dashboard/providers`));
  });

program
  .command("coach")
  .description("Analyze your prompt architecture and get concrete recommendations for improving BTL Runtime cache hit rate.")
  .action(async () => {
    printBanner();
    console.log(chalk.bold(`\ncritcache coach — analyzing your prompt architecture...\n`));

    // Get current fingerprint for context
    const components = getPromptComponents();
    const fingerprint = computeFingerprint(components);

    // Get workspace stats for cache hit rate context
    const statsResult = await fetchStats();
    const hitRate = statsResult.summary?.cacheHitRate ?? 0;
    const totalRequests = statsResult.summary?.totalRequests ?? 0;

    const result = await runCacheCoach(
      fingerprint.system,
      components.model,
      components.temperature,
      !!components.rules,
      hitRate,
      totalRequests
    );

    if (result.requestError) {
      console.error(chalk.red(`Error: ${result.requestError}`));
      process.exitCode = 1;
      return;
    }

    // Cacheability score bar
    const score = result.cacheabilityScore;
    const scoreColor = score >= 80 ? chalk.green : score >= 50 ? chalk.yellow : chalk.red;
    const barFilled = Math.round(score / 10);
    const bar = scoreColor("█".repeat(barFilled)) + chalk.dim("░".repeat(10 - barFilled));

    console.log(`  ${bar} ${scoreColor.bold(`${score}/100`)} cacheability score\n`);

    if (result.currentFindings.length > 0) {
      console.log(chalk.bold("Current findings:\n"));
      for (const finding of result.currentFindings) {
        console.log(`  ${chalk.dim("•")} ${finding}`);
      }
      console.log();
    }

    if (result.recommendations.length > 0) {
      console.log(chalk.bold("Recommendations:\n"));
      for (const rec of result.recommendations) {
        console.log(`  ${chalk.green("→")} ${rec}`);
      }
      console.log();
    }

    if (result.estimatedImprovement) {
      console.log(chalk.cyan(`  ${result.estimatedImprovement}\n`));
    }

    console.log(chalk.dim(`  Run 'critcache compare .' after making changes to verify improvement.`));
  });

program.parse();