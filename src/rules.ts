import fs from "node:fs";
import path from "node:path";

/**
 * The filename for custom review rules placed at the repo root.
 *
 * Format: markdown-style headings (`# Security`) with bullet points under
 * each section describing the team's review priorities:
 *
 * ```critcacherules
 * # Security
 * - Flag hardcoded credentials, API keys, or tokens
 * - Check for SQL injection vulnerabilities in raw queries
 *
 * # Performance
 * - Look for N+1 query patterns in database calls
 * - Flag large objects passed by value
 * ```
 */
const RULES_FILENAME = ".critcacherules";

/**
 * Loads the `.critcacherules` file from the repo root, returning its
 * trimmed content if it exists and is non-empty, or `null` if the file
 * is absent, empty, or unreadable.
 *
 * Non-fatal by design — rules are optional. A missing rules file is not
 * an error; it simply means no custom review focus areas are active.
 */
export function loadRules(repoRoot: string): string | null {
  const resolvedRoot = path.resolve(repoRoot);
  const filePath = path.join(resolvedRoot, RULES_FILENAME);

  try {
    const content = fs.readFileSync(filePath, "utf-8").trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

/**
 * Appends custom review rules to the base system prompt.
 *
 * The base system prompt (`SYSTEM_PROMPT`) is kept byte-identical — this
 * function produces the derived prompt that includes rules. Since rules
 * are a repo-level constant (not per-file), all calls in the same run get
 * the same derived prompt, preserving BTL's exact-match caching.
 *
 * When no rules are present, returns the base prompt unchanged so the
 * cache key is identical to a no-rules run.
 */
export function buildSystemPrompt(
  basePrompt: string,
  rulesContent: string | null,
): string {
  if (!rulesContent) return basePrompt;

  return [
    basePrompt,
    "",
    "---",
    "## Custom review rules",
    "",
    "The team has defined the following review priorities. Apply these",
    "alongside the standard analysis, incorporating relevant findings into",
    "the test_gaps, security_note, or summary fields as appropriate:",
    "",
    rulesContent,
  ].join("\n");
}
