import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { walkRepo } from "./walker.js";
import { analyzeFile, type AnalyzeFileResult, type FileAnalysis } from "./btl-client.js";

export interface WatchOptions {
    maxFiles?: number;
    debounceMs?: number;
    /**
     * Optional callback invoked after every successful file analysis.
     * Receives the file path and the full analysis result, allowing
     * the caller to update SARIF output, forward to a dashboard, etc.
     */
    onAnalysis?: (relPath: string, result: AnalyzeFileResult) => void;
}

interface FileRecord {
    relPath: string;
    absPath: string;
    lastAnalysis: FileAnalysis | null;
    lastResponseTimeMs: number | undefined;
    /** Called on every re-analysis (first analysis and subsequent changes) */
    onAnalysis?: (relPath: string, result: AnalyzeFileResult) => void;
}

const DEFAULT_DEBOUNCE_MS = 600;

/**
 * Computes a human-readable diff between two FileAnalysis objects.
 * Only prints fields that actually changed — keeps output tight.
 */
function diffAnalysis(
    prev: FileAnalysis | null,
    next: FileAnalysis
): string[] {
    if (!prev) return ["  First analysis — no previous result to compare."];

    const lines: string[] = [];
    const fields: (keyof FileAnalysis)[] = [
        "role",
        "complexity",
        "test_gaps",
        "security_note",
        "summary",
    ];

    for (const field of fields) {
        if (prev[field] !== next[field]) {
            lines.push(
                `  ${chalk.dim(field + ":")} ${chalk.red(String(prev[field]))} ${chalk.dim("→")} ${chalk.green(String(next[field]))}`
            );
        }
    }

    if (lines.length === 0) {
        lines.push(chalk.dim("  Analysis unchanged from previous run."));
    }

    return lines;
}

/**
 * Formats the response time as a cache hit/miss badge.
 * Same logic as runner.ts — hits are under 2000ms.
 */
function timingBadge(responseTimeMs: number | undefined): string {
    if (responseTimeMs === undefined) return chalk.dim("[unknown]");
    if (responseTimeMs < 2000) return chalk.cyan(`[hit ${responseTimeMs}ms]`);
    return chalk.dim(`[miss ${responseTimeMs}ms]`);
}

/**
 * Analyzes a single changed file and prints the result + diff inline.
 * Called by the debounced file watcher on every detected change.
 */
async function handleFileChange(record: FileRecord): Promise<void> {
    const timestamp = new Date().toLocaleTimeString();

    console.log(
        `\n${chalk.dim(timestamp)} ${chalk.bold(record.relPath)} ${chalk.yellow("changed")} — re-analyzing...`
    );

    let content: string;
    try {
        content = fs.readFileSync(record.absPath, "utf-8");
    } catch {
        console.log(chalk.red(`  Could not read file — skipping.`));
        return;
    }

    const result = await analyzeFile(record.relPath, content);

    if (result.requestError || result.parseError) {
        const err = result.requestError ?? result.parseError;
        console.log(chalk.red(`  Error: ${err}`));
        return;
    }

    if (!result.analysis) {
        console.log(chalk.red(`  No analysis returned.`));
        return;
    }

    // Fire the optional callback so the CLI can update SARIF output, etc.
    record.onAnalysis?.(record.relPath, result);

    const badge = timingBadge(result.usage.responseTimeMs);
    console.log(`  ${badge}`);

    const diffLines = diffAnalysis(record.lastAnalysis, result.analysis);
    for (const line of diffLines) {
        console.log(line);
    }

    // Update the record for the next diff
    record.lastAnalysis = result.analysis;
    record.lastResponseTimeMs = result.usage.responseTimeMs;
}

/**
 * Starts the file watcher on a repo directory.
 *
 * - Uses Node's built-in fs.watch (no extra deps)
 * - Debounces rapid saves so one keystroke-save = one analysis call
 * - Only watches files that pass the same filters as the walker
 * - Runs until the process receives SIGINT (Ctrl+C)
 */
export async function watchRepo(
    rootDir: string,
    options: WatchOptions = {}
): Promise<void> {
    const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const maxFiles = options.maxFiles ?? 20;

    const resolvedRoot = path.resolve(rootDir);

    // Build an initial file map from the walker so we only watch
    // files that are actually worth analyzing.
    const walkedFiles = walkRepo(resolvedRoot, { maxFiles });

    if (walkedFiles.length === 0) {
        console.log(chalk.yellow("No reviewable files found in this repo."));
        return;
    }

    // Build a lookup map from absPath → FileRecord for fast watcher callbacks.
    const fileMap = new Map<string, FileRecord>();
    for (const f of walkedFiles) {
        fileMap.set(f.absPath, {
            relPath: f.relPath,
            absPath: f.absPath,
            lastAnalysis: null,
            lastResponseTimeMs: undefined,
            onAnalysis: options.onAnalysis,
        });
    }

    console.log(
        chalk.bold(`\ncritcache watch — ${chalk.cyan(rootDir)}\n`) +
        chalk.dim(`Watching ${walkedFiles.length} file(s). Press Ctrl+C to stop.\n`)
    );

    for (const f of walkedFiles) {
        console.log(`  ${chalk.dim("○")} ${f.relPath}`);
    }

    console.log(
        chalk.dim(`\nBTL Runtime caching is active — first analysis of each file will be a miss,`)
    );
    console.log(
        chalk.dim(`subsequent saves will hit the cache and return in under 1 second.\n`)
    );

    // Debounce timers — one per file path so rapid saves don't stack.
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    // fs.watch is recursive on Windows and macOS, not on Linux.
    // We watch the root directory recursively to catch changes in any subdir.
    const watcher = fs.watch(
        resolvedRoot,
        { recursive: true },
        (eventType, filename) => {
            if (!filename) return;

            // Resolve the changed file to an absolute path.
            const absPath = path.join(resolvedRoot, filename);
            const record = fileMap.get(absPath);

            // Ignore files not in our watch list.
            if (!record) return;
            if (eventType !== "change") return;

            // Debounce: cancel any pending timer for this file and restart it.
            const existing = debounceTimers.get(absPath);
            if (existing) clearTimeout(existing);

            const timer = setTimeout(async () => {
                debounceTimers.delete(absPath);
                await handleFileChange(record);
            }, debounceMs);

            debounceTimers.set(absPath, timer);
        }
    );

    // Clean up on Ctrl+C
    process.on("SIGINT", () => {
        watcher.close();
        for (const timer of debounceTimers.values()) {
            clearTimeout(timer);
        }
        console.log(chalk.dim("\n\nWatch session ended."));
        process.exit(0);
    });

    // Keep the process alive — the watcher runs until SIGINT.
    await new Promise<void>(() => { });
}