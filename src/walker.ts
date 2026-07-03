import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Ignore } from "ignore";
const _require = createRequire(import.meta.url);
const ignore: () => Ignore = _require("ignore");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RankedFile {
  /** Absolute path */
  absPath: string;
  /** Path relative to the repo root (used as the display key) */
  relPath: string;
  /** File size in bytes */
  sizeBytes: number;
}

/** Alias used by runner.ts — same shape as RankedFile. */
export type WalkedFile = RankedFile;

/** Options accepted by walkRepo. */
export interface WalkOptions {
  /** Maximum number of files to return. @default 20 */
  maxFiles?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Extensions we care about, in descending priority order.
 * Files with earlier extensions rank higher than files with later ones.
 */
const EXT_PRIORITY: string[] = [
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".swift",
  ".c", ".cpp", ".h", ".hpp", ".cs",
  ".rb", ".php", ".scala", ".ex", ".exs",
  ".vue", ".svelte", ".astro",
  ".sql", ".graphql", ".proto",
  ".sh", ".bash", ".zsh",
  ".yaml", ".yml", ".toml", ".json", ".env",
  ".md", ".mdx",
];

/**
 * Glob-style patterns we always skip, regardless of .gitignore.
 * Covers lock files, generated directories, and binary artifacts.
 */
const ALWAYS_IGNORE: string[] = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".nuxt/",
  ".turbo/",
  "coverage/",
  ".cache/",
  "__pycache__/",
  "*.pyc",
  "*.pyo",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.d.ts",
  "*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.ico", "*.svg",
  "*.woff", "*.woff2", "*.ttf", "*.eot",
  "*.pdf", "*.zip", "*.tar", "*.gz",
  "*.exe", "*.dll", "*.so", "*.dylib",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extPriority(filePath: string): number {
  const ext = path.extname(filePath).toLowerCase();
  const idx = EXT_PRIORITY.indexOf(ext);
  return idx === -1 ? EXT_PRIORITY.length : idx; // unknown exts sort last
}

function readGitignore(dir: string): string[] {
  const gitignorePath = path.join(dir, ".gitignore");
  try {
    return fs.readFileSync(gitignorePath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

/**
 * Recursively walk `rootDir`, respecting .gitignore and built-in exclusions.
 * Returns up to `maxFiles` files ranked by:
 *   1. Extension priority (source files before config/docs)
 *   2. File size descending (larger = more code = more interesting to review)
 */
export function walkRepo(
  rootDir: string,
  options?: number | WalkOptions,
): RankedFile[] {
  const maxFiles =
    typeof options === "number"
      ? options
      : (options?.maxFiles ?? 20);
  const absRoot = path.resolve(rootDir);

  if (!fs.existsSync(absRoot)) {
    throw new Error(`Directory not found: ${absRoot}`);
  }
  if (!fs.statSync(absRoot).isDirectory()) {
    throw new Error(`Not a directory: ${absRoot}`);
  }

  // Build the ignore filter
  const ig = ignore()
    .add(ALWAYS_IGNORE)
    .add(readGitignore(absRoot));

  const collected: RankedFile[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission denied or disappeared — skip silently
    }

    for (const entry of entries) {
      const absPath = path.join(dir, entry.name);
      const relPath = path.relative(absRoot, absPath).replace(/\\/g, "/");

      // Skip dotfiles (.gitignore, .env.example, .eslintrc, etc.)
      // These are configuration files, not source code worth reviewing.
      // README/LICENSE still get through since they don't start with a dot.
      if (!entry.isDirectory() && entry.name.startsWith(".")) continue;

      // Check against ignore rules (ignore expects POSIX-style paths)
      const checkPath = entry.isDirectory() ? relPath + "/" : relPath;
      if (ig.ignores(checkPath)) continue;

      if (entry.isDirectory()) {
        walk(absPath);
      } else if (entry.isFile()) {
        let sizeBytes = 0;
        try {
          sizeBytes = fs.statSync(absPath).size;
        } catch {
          continue;
        }
        // Skip empty files and very large blobs (>500 KB — probably generated)
        if (sizeBytes === 0 || sizeBytes > 500_000) continue;

        collected.push({ absPath, relPath, sizeBytes });
      }
    }
  }

  walk(absRoot);

  // Sort: ext priority ASC (lower idx = better), then size DESC
  collected.sort((a, b) => {
    const extDiff = extPriority(a.relPath) - extPriority(b.relPath);
    if (extDiff !== 0) return extDiff;
    return b.sizeBytes - a.sizeBytes;
  });

  return collected.slice(0, maxFiles);
}
