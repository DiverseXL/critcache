import fs from "node:fs";
import path from "node:path";
import type { RunResult } from "./runner.js";

export interface WriteReportOptions {
  /** Label for the repo, e.g. "." or "./my-project (PR vs main)" */
  repoLabel: string;
  /** If true, emit a PR-specific header with diff context */
  isPrReview?: boolean;
  /** The git ref this PR was compared against (shown in PR mode) */
  prTarget?: string;
}

/**
 * Returns an emoji + label for a complexity string.
 */
function complexityBadge(complexity: string | undefined): string {
  switch (complexity?.toLowerCase()) {
    case "high":
      return "🔴 High";
    case "medium":
      return "🟡 Medium";
    case "low":
      return "🟢 Low";
    default:
      return "⚪ Unknown";
  }
}

/**
 * Renders a RunResult as a clean markdown report and writes it to disk.
 * Kept separate from runner.ts so the formatting logic can be iterated
 * on independently of the live-render/concurrency logic.
 */
export function writeReport(
  result: RunResult,
  outputPath: string,
  repoLabel: string,
): void {
  const opts: WriteReportOptions = { repoLabel };
  // Auto-detect PR reports by looking for "PR vs" in the label
  if (repoLabel.includes("(PR vs")) {
    opts.isPrReview = true;
    const match = repoLabel.match(/PR vs\s+([^)\s]+)/);
    if (match) opts.prTarget = match[1];
  }
  renderReport(result, outputPath, opts);
}

/**
 * Internal render function — split out so the public API stays stable
 * while the rendering logic can use the full options object.
 */
function renderReport(
  result: RunResult,
  outputPath: string,
  opts: WriteReportOptions,
): void {
  const lines: string[] = [];

  // ---------------------------------------------------------------------------
  // Header
  // ---------------------------------------------------------------------------
  lines.push(`# critcache report — ${opts.repoLabel}`);
  lines.push("");
  lines.push(`> Generated ${new Date().toISOString()}`);
  lines.push("");
  if (opts.isPrReview) {
    lines.push(
      `> 🎯 **PR review** — analyzing only the files changed vs \`${opts.prTarget ?? "target"}\`.`,
    );
    lines.push(
      `> SARIF output is compatible with GitHub Code Scanning — upload \`*.sarif\` to see results in the Security tab.`,
    );
    lines.push("");
  }

  // ---------------------------------------------------------------------------
  // Savings summary table
  // ---------------------------------------------------------------------------
  lines.push("## 💰 Savings summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Files analyzed | ${result.rows.length} |`);
  lines.push(`| Cache hits | ${result.cacheHits} |`);
  lines.push(`| Cache misses | ${result.cacheMisses} |`);
  lines.push(`| Benchmark cost (no caching) | $${result.totalBenchmarkCostUsd.toFixed(4)} |`);
  lines.push(`| Actual charge (via BTL) | $${result.totalChargeUsd.toFixed(4)} |`);
  lines.push(`| **Total saved** | **$${result.totalSavedUsd.toFixed(4)}** |`);

  if (result.totalBenchmarkCostUsd > 0) {
    const pct = (result.totalSavedUsd / result.totalBenchmarkCostUsd) * 100;
    lines.push(`| Savings rate | ${pct.toFixed(1)}% |`);
  }
  lines.push("");

  // ---------------------------------------------------------------------------
  // Cache performance summary
  // ---------------------------------------------------------------------------
  const hitRate =
    result.rows.length > 0
      ? ((result.cacheHits / result.rows.length) * 100).toFixed(0)
      : "0";
  lines.push(`> **Cache hit rate:** ${hitRate}% · ` +
    `${result.cacheHits} hits · ${result.cacheMisses} misses · ` +
    `$${result.totalSavedUsd.toFixed(4)} total saved`);
  lines.push("");

  // ---------------------------------------------------------------------------
  // Security & risk highlights (PR-specific callout)
  // ---------------------------------------------------------------------------
  const securityFindings: Array<{ file: string; note: string }> = [];
  const highComplexityFiles: string[] = [];

  for (const row of result.rows) {
    const analysis = row.result?.analysis;
    if (!analysis) continue;

    if (analysis.security_note && analysis.security_note !== "none apparent") {
      securityFindings.push({ file: row.file.relPath, note: analysis.security_note });
    }
    if (analysis.complexity?.toLowerCase() === "high") {
      highComplexityFiles.push(row.file.relPath);
    }
  }

  if (securityFindings.length > 0 || highComplexityFiles.length > 0) {
    lines.push("## ⚠️ Highlights");
    lines.push("");

    if (securityFindings.length > 0) {
      lines.push("### Security notes");
      lines.push("");
      for (const f of securityFindings) {
        lines.push(`- \`${f.file}\` — ${f.note}`);
      }
      lines.push("");
    }

    if (highComplexityFiles.length > 0) {
      lines.push("### High-complexity files");
      lines.push("");
      for (const f of highComplexityFiles) {
        lines.push(`- \`${f}\``);
      }
      lines.push("");
    }
  }

  // ---------------------------------------------------------------------------
  // Repo-level synthesis
  // ---------------------------------------------------------------------------
  if (opts.isPrReview) {
    lines.push("## 🧠 PR-level findings");
  } else {
    lines.push("## 🧠 Repo-level findings");
  }
  lines.push("");

  if (result.synthesis) {
    lines.push("### Architecture overview");
    lines.push("");
    lines.push(result.synthesis.architecture_overview);
    lines.push("");

    lines.push("### Top risks");
    lines.push("");
    if (result.synthesis.top_risks.length === 0) {
      lines.push("_None flagged._");
    } else {
      for (const risk of result.synthesis.top_risks) {
        lines.push(`- ⚠️ ${risk}`);
      }
    }
    lines.push("");

    lines.push("### Suggested next steps");
    lines.push("");
    if (result.synthesis.next_steps.length === 0) {
      lines.push("_None suggested._");
    } else {
      for (const step of result.synthesis.next_steps) {
        lines.push(`- 💡 ${step}`);
      }
    }
    lines.push("");
  } else {
    lines.push(
      `_Synthesis unavailable: ${result.synthesisError ?? "unknown reason"}_`,
    );
    lines.push("");
  }

  // ---------------------------------------------------------------------------
  // Per-file detail — sorted by complexity (high first)
  // ---------------------------------------------------------------------------
  if (opts.isPrReview) {
    lines.push("## 📄 Changed files analyzed");
  } else {
    lines.push("## 📄 Per-file analysis");
  }
  lines.push("");

  // Sort: high complexity first, then medium, then low, then errors last
  const sortedRows = [...result.rows].sort((a, b) => {
    const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const aComplexity = a.result?.analysis?.complexity?.toLowerCase() ?? "unknown";
    const bComplexity = b.result?.analysis?.complexity?.toLowerCase() ?? "unknown";
    const aOrder = order[aComplexity] ?? 3;
    const bOrder = order[bComplexity] ?? 3;
    if (aOrder !== bOrder) return aOrder - bOrder;
    // Secondary sort: errors after done
    if (a.status === "error" && b.status !== "error") return 1;
    if (a.status !== "error" && b.status === "error") return -1;
    return a.file.relPath.localeCompare(b.file.relPath);
  });

  for (const row of sortedRows) {
    lines.push(`### \`${row.file.relPath}\``);
    lines.push("");

    if (row.status === "error") {
      const msg = row.result?.requestError ?? row.result?.parseError ?? "unknown error";
      lines.push(`❌ **Error:** ${msg}`);
      lines.push("");
      continue;
    }

    const analysis = row.result?.analysis;
    const usage = row.result?.usage;

    if (analysis) {
      const badge = complexityBadge(analysis.complexity);
      lines.push(`| | |`);
      lines.push(`|---|---|`);
      lines.push(`| **Role** | ${analysis.role} |`);
      lines.push(`| **Complexity** | ${badge} |`);
      lines.push(`| **Test gaps** | ${analysis.test_gaps} |`);
      lines.push(`| **Security note** | ${analysis.security_note} |`);
      lines.push(`| **Summary** | ${analysis.summary} |`);
    }

    if (usage) {
      const tier = usage.cacheTier ?? "unknown";
      const saved = usage.savedUsd !== undefined ? `$${usage.savedUsd.toFixed(4)}` : "n/a";
      const tierLabel = tier === "none" || tier === "miss"
        ? "❌ Miss"
        : "✅ Hit";
      lines.push(`| **Cache** | ${tierLabel} (\`${tier}\`) · **Saved:** ${saved} |`);
    }

    lines.push("");
  }

  // ---------------------------------------------------------------------------
  // Footer
  // ---------------------------------------------------------------------------
  lines.push("---");
  lines.push("");

  if (opts.isPrReview) {
    lines.push(
      `_Generated by [critcache](https://github.com/) — ` +
      `powered by BTL Runtime. Upload \`*.sarif\` to GitHub for Code Scanning integration._`,
    );
  } else {
    lines.push(
      `_Generated by [critcache](https://github.com/) — powered by BTL Runtime._`,
    );
  }
  lines.push("");

  const fullOutputPath = path.resolve(outputPath);
  fs.writeFileSync(fullOutputPath, lines.join("\n"), "utf-8");
}
