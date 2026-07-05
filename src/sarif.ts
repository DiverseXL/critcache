import fs from "node:fs";
import path from "node:path";
import type { RunResult } from "./runner.js";

/**
 * Converts an analysis role string into a valid SARIF ruleId.
 * - Lowercases, replaces non-alphanumeric runs with "-"
 * - Strips leading/trailing hyphens, caps at 60 chars
 *
 * Shared by both buildSarifReport and CLI watch inline builder.
 */
export function toRuleId(role: string): string {
  return `critcache/${role
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)}`;
}

/**
 * Builds a SARIF v2.1 JSON object from a critcache RunResult.
 *
 * SARIF (Static Analysis Results Interchange Format) is the OASIS standard
 * for static analysis tool output. GitHub Code Scanning, VS Code (via the
 * SARIF Viewer extension), GitLab, and Azure DevOps all consume SARIF
 * natively — no integration code needed on critcache's side.
 *
 * Each successfully analyzed file produces one SARIF result with:
 * - ruleId derived from the analysis role
 * - message.text from the file summary
 * - artifactLocation.uri set to the URI-encoded relative file path
 * - custom properties for complexity, test gaps, security note, and cache tier
 *
 * The repo-level synthesis is emitted as additional results with level "note"
 * so they appear as informational findings in the consumer.
 */
export function buildSarifReport(
  result: RunResult,
  repoLabel: string,
): object {
  const results: object[] = [];

  for (const row of result.rows) {
    if (row.status !== "done" || !row.result?.analysis) {
      // Skipped or errored — emit a warning result if there's a request/parse error
      if (row.status === "error" && row.result) {
        const errMsg = row.result.requestError ?? row.result.parseError ?? "Unknown error";
        results.push({
          ruleId: "critcache/error",
          level: "error",
          message: { text: errMsg },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: encodeURI(row.file.relPath) },
              },
            },
          ],
        });
      }
      continue;
    }

    const analysis = row.result.analysis;
    const usage = row.result.usage;

    const ruleId = toRuleId(analysis.role);

    // Primary result: file summary
    results.push({
      ruleId,
      level: "note",
      message: { text: analysis.summary },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: encodeURI(row.file.relPath) },
          },
        },
      ],
      properties: {
        complexity: analysis.complexity,
        role: analysis.role,
        testGaps: analysis.test_gaps,
        securityNote: analysis.security_note,
        cacheTier: usage?.cacheTier ?? "none",
        savedUsd: usage?.savedUsd,
      },
    });

    // If there's a non-trivial security note, emit it as a separate
    // warning-level result so consumers surface it more prominently.
    if (analysis.security_note && analysis.security_note !== "none apparent") {
      results.push({
        ruleId: "critcache/security",
        level: "warning",
        message: { text: analysis.security_note },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: encodeURI(row.file.relPath) },
            },
          },
        ],
        properties: {
          cacheTier: usage?.cacheTier ?? "none",
        },
      });
    }

    // If there's a non-trivial test gap, emit it as a separate result too.
    if (analysis.test_gaps && analysis.test_gaps !== "none apparent") {
      results.push({
        ruleId: "critcache/test-coverage",
        level: "note",
        message: { text: analysis.test_gaps },
        locations: [
          {
            physicalLocation: {
              artifactLocation: { uri: encodeURI(row.file.relPath) },
            },
          },
        ],
        properties: {
          cacheTier: usage?.cacheTier ?? "none",
        },
      });
    }
  }

  // Add repo-level synthesis as informational results (no file location)
  if (result.synthesis) {
    if (result.synthesis.top_risks.length > 0) {
      for (const risk of result.synthesis.top_risks) {
        results.push({
          ruleId: "critcache/synthesis/risk",
          level: "warning",
          message: { text: risk },
        });
      }
    }

    if (result.synthesis.next_steps.length > 0) {
      for (const step of result.synthesis.next_steps) {
        results.push({
          ruleId: "critcache/synthesis/next-step",
          level: "note",
          message: { text: step },
        });
      }
    }
  }

  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "critcache",
            version: "0.1.4",
            informationUri: "https://critcache.vercel.app",
            fullName: "critcache — parallel AI code review",
            semanticVersion: "0.1.4",
          },
        },
        results,
        properties: {
          repoLabel,
          totalFilesAnalyzed: result.rows.length,
          totalCacheHits: result.cacheHits,
          totalCacheMisses: result.cacheMisses,
          totalSavedUsd: result.totalSavedUsd,
          totalBenchmarkCostUsd: result.totalBenchmarkCostUsd,
          totalChargeUsd: result.totalChargeUsd,
        },
      },
    ],
  };
}

/**
 * Writes a SARIF report to disk. Derives the .sarif filename from the
 * markdown output path by replacing the extension, so both reports
 * land next to each other.
 *
 * @param sarifPath - Output path for the .sarif file
 * @param sarifReport - The SARIF JSON object from buildSarifReport
 */
export function writeSarifReport(
  sarifPath: string,
  sarifReport: object,
): void {
  const fullPath = path.resolve(sarifPath);
  fs.writeFileSync(fullPath, JSON.stringify(sarifReport, null, 2), "utf-8");
}

/**
 * Derives a .sarif path from a markdown report path.
 * e.g. "critcache-report.md" → "critcache-report.sarif"
 *      "critcache-pr-report.md" → "critcache-pr-report.sarif"
 */
export function deriveSarifPath(mdPath: string): string {
  return mdPath.replace(/\.\w+$/, "") + ".sarif";
}
