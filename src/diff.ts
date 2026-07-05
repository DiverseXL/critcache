import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { WalkedFile } from "./walker.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Basenames we always skip in diff output, matching walker.ts's ALWAYS_IGNORE.
 * Lock files and generated artifacts that add no review value.
 */
const ALWAYS_SKIP_BASENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
]);

/** File extensions that signal generated or minified output. */
const GENERATED_EXTENSIONS = new Set([
  ".min.js",
  ".min.css",
  ".d.ts",
  ".map",
]);

/** Directory prefixes that should never be reviewed even if git tracks them. */
const SKIP_DIR_PREFIXES = [
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".nuxt/",
  ".turbo/",
  "coverage/",
  ".cache/",
  "__pycache__/",
];

const MAX_FILE_SIZE = 500_000; // 500 KB — same as walker.ts

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GetDiffOptions {
  /** Absolute path to the repo root. */
  repoRoot: string;
  /**
   * Git ref to diff against, e.g. "main", "origin/main", "HEAD~1".
   * We use three-dot syntax: `<target>...HEAD`
   */
  target: string;
  /** Maximum number of files to return. @default 50 */
  maxFiles?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the relative path matches something we should skip.
 * Mirrors walker.ts's ALWAYS_IGNORE logic for the diff case.
 */
function shouldSkip(relPath: string): boolean {
  const base = path.basename(relPath);

  // Lock / generated files by basename
  if (ALWAYS_SKIP_BASENAMES.has(base)) return true;

  // Dotfiles (e.g. .gitignore, .env.example, .eslintrc)
  if (base.startsWith(".")) return true;

  // Generated extensions
  const ext = path.extname(base).toLowerCase();
  if (GENERATED_EXTENSIONS.has(ext)) return true;

  // Directory prefixes
  for (const prefix of SKIP_DIR_PREFIXES) {
    if (relPath.startsWith(prefix)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Runs `git diff <target>...HEAD --name-only --diff-filter=AM` and returns
 * the changed files as `WalkedFile[]`, compatible with `runAnalysis()`.
 *
 * **Three-dot diff (`<target>...HEAD`)** means: "commits on the current branch
 * that aren't reachable from `<target>`" — exactly what you want for PR review.
 *
 * **--diff-filter=AM** excludes deleted (D) and renamed (R) files since
 * deleted files can't be analyzed and renames add no new content.
 *
 * No GitHub API needed. Works on any git repo with any remote.
 */
export function getDiffFiles(opts: GetDiffOptions): WalkedFile[] {
  const { repoRoot, target, maxFiles = 50 } = opts;
  const absRoot = path.resolve(repoRoot);

  // Verify the repo exists before we shell out
  if (!fs.existsSync(absRoot)) {
    throw new Error(`Repository not found: ${absRoot}`);
  }

  // Verify the target exists as a known git ref
  try {
    execSync(`git rev-parse --verify "${target}"`, {
      cwd: absRoot,
      encoding: "utf-8",
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    throw new Error(
      `Target branch/ref not found: "${target}". ` +
      `Make sure the branch exists (try "origin/${target}" or "${target}") ` +
      `and that you've fetched it.`
    );
  }

  // Run the diff
  let stdout: string;
  try {
    stdout = execSync(
      `git diff ${target}...HEAD --name-only --diff-filter=AM`,
      { cwd: absRoot, encoding: "utf-8", maxBuffer: 1024 * 1024 }
    );
  } catch (err) {
    throw new Error(
      `Failed to run git diff against "${target}": ${(err as Error).message}`
    );
  }

  const lines = stdout.trim().split("\n").filter(Boolean);

  if (lines.length === 0) {
    return [];
  }

  const files: WalkedFile[] = [];

  for (const relPath of lines) {
    // Normalize path separators so walker-style POSIX paths are consistent
    const normalizedRel = relPath.replace(/\\/g, "/");

    // Apply skip filters
    if (shouldSkip(normalizedRel)) continue;

    const absPath = path.resolve(absRoot, normalizedRel);

    // Stat the file — skip if it was deleted between the diff and now
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      continue;
    }

    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_SIZE) {
      continue;
    }

    files.push({
      absPath,
      relPath: normalizedRel,
      sizeBytes: stat.size,
    });
  }

  // Sort by size descending (larger files first = more interesting to review)
  files.sort((a, b) => b.sizeBytes - a.sizeBytes);

  return maxFiles > 0 ? files.slice(0, maxFiles) : files;
}

/**
 * Returns a human-readable label for the fingerprint box, e.g.
 * "PR vs main" or "PR vs origin/main".
 */
export function getDiffLabel(target: string): string {
  return `PR vs ${target}`;
}
