import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";

/**
 * The four components that determine whether a BTL Runtime call
 * hits or misses the cache. If any of these change between runs,
 * every call becomes a cache miss — even if the file content is identical.
 *
 * File content (user message) is intentionally excluded — that's
 * expected to vary per file and is not a cacheability concern.
 */
export interface PromptComponents {
    systemPrompt: string;
    schema: string;
    model: string;
    temperature: number;
    /** Content of the .critcacherules file, or empty string if none. */
    rules: string;
}

export interface PromptFingerprint {
    system: string;   // 7-char hex hash of system prompt
    schema: string;   // 7-char hex hash of output schema
    model: string;    // model name as-is (short enough to show directly)
    temperature: string; // temperature as string
    overall: string;  // 7-char hex hash of all four combined
    timestamp: string;
    /** Short hash of the active .critcacherules content, or empty if none. */
    rules: string; // ISO timestamp of when this fingerprint was computed
    /**
     * Optional context label, e.g. "PR vs main" or "PR vs origin/main".
     * Set by review-pr so the fingerprint box shows what mode was used.
     * Does NOT affect caching — prompts are identical regardless of context.
     */
    contextLabel?: string;
}

export interface FingerprintDiff {
    current: PromptFingerprint;
    previous: PromptFingerprint | null;
    changed: (keyof Omit<PromptFingerprint, "overall" | "timestamp" | "contextLabel">)[];
    cacheImpact: "stable" | "busted" | "first-run";
}

const EMPTY_RULES_HASH = "";

const FINGERPRINT_FILE = ".critcache/fingerprint.json";

/** Produces a short 7-character hex hash of a string — same style as git. */
function shortHash(input: string): string {
    return crypto
        .createHash("sha256")
        .update(input)
        .digest("hex")
        .slice(0, 7);
}

/**
 * Computes a PromptFingerprint from the four cache-determining components.
 * Called once per run, before any file analysis begins.
 *
 * @param components - The cache-determining components (prompt, schema, model, temperature)
 * @param contextLabel - Optional label for the fingerprint box (e.g. "PR vs main").
 *                       This is display-only and does not affect caching.
 */
export function computeFingerprint(
    components: PromptComponents,
    contextLabel?: string
): PromptFingerprint {
    const systemHash = shortHash(components.systemPrompt);
    const schemaHash = shortHash(components.schema);
    const tempStr = String(components.temperature);
    // Hash the rules content — empty string if no rules, producing a stable
    // "no rules" hash so identical non-rules runs produce the same fingerprint.
    const rulesHash = components.rules ? shortHash(components.rules) : EMPTY_RULES_HASH;

    // Overall hash combines all five so any single change busts the overall.
    const overallHash = shortHash(
        components.systemPrompt +
        components.schema +
        components.model +
        tempStr +
        components.rules  // rules are part of the cache key
    );

    return {
        system: systemHash,
        schema: schemaHash,
        model: components.model,
        temperature: tempStr,
        overall: overallHash,
        timestamp: new Date().toISOString(),
        contextLabel,
        rules: rulesHash,
    };
}

/**
 * Loads the previous fingerprint from .critcache/fingerprint.json.
 * Returns null if no previous fingerprint exists (first run).
 */
export function loadPreviousFingerprint(repoRoot: string): PromptFingerprint | null {
    const filePath = path.join(repoRoot, FINGERPRINT_FILE);
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(raw) as PromptFingerprint;
    } catch {
        return null;
    }
}

/**
 * Saves the current fingerprint to .critcache/fingerprint.json.
 * Creates the .critcache directory if it doesn't exist.
 */
export function saveFingerprint(repoRoot: string, fingerprint: PromptFingerprint): void {
    const dirPath = path.join(repoRoot, ".critcache");
    const filePath = path.join(dirPath, "fingerprint.json");

    try {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
        fs.writeFileSync(filePath, JSON.stringify(fingerprint, null, 2), "utf-8");
    } catch {
        // Non-fatal — fingerprint storage failure shouldn't crash the run.
    }
}

/**
 * Diffs the current fingerprint against the previous one.
 * Returns which components changed and the overall cache impact.
 * contextLabel is intentionally excluded from the diff — it's display-only.
 */
export function diffFingerprints(
    current: PromptFingerprint,
    previous: PromptFingerprint | null
): FingerprintDiff {
    if (!previous) {
        return {
            current,
            previous: null,
            changed: [],
            cacheImpact: "first-run",
        };
    }

    const changed: FingerprintDiff["changed"] = [];

    if (current.system !== previous.system) changed.push("system");
    if (current.schema !== previous.schema) changed.push("schema");
    if (current.model !== previous.model) changed.push("model");
    if (current.temperature !== previous.temperature) changed.push("temperature");
    if (current.rules !== previous.rules) changed.push("rules");

    return {
        current,
        previous,
        changed,
        cacheImpact: changed.length > 0 ? "busted" : "stable",
    };
}

/** Formats a time ago string from an ISO timestamp. */
function timeAgo(isoTimestamp: string): string {
    const diff = Date.now() - new Date(isoTimestamp).getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return "just now";
}

/**
 * Renders the fingerprint diff as a terminal box.
 * Printed once at the start of every analyze/compare/watch run.
 *
 * If the fingerprint has a contextLabel (e.g. "PR vs main"), it's displayed
 * as a distinct row so the developer can see which context produced this run.
 */
export function renderFingerprintBox(diff: FingerprintDiff): string {
    const { current, previous, changed, cacheImpact } = diff;
    const lines: string[] = [];

    const width = 51;

    lines.push(chalk.dim(`┌─ Prompt Fingerprint ${"─".repeat(width - 22)}┐`));

    // Helper to render one row
    function row(
        label: string,
        currentVal: string,
        previousVal?: string,
        wasChanged?: boolean
    ): string {
        const labelPad = label.padEnd(12);
        let valueStr: string;

        if (wasChanged && previousVal) {
            valueStr = `${chalk.dim(previousVal)} → ${chalk.yellow(currentVal)}  ${chalk.yellow("⚠ changed")}`;
        } else if (cacheImpact === "first-run") {
            valueStr = `${chalk.cyan(currentVal)}  ${chalk.dim("(first run)")}`;
        } else {
            valueStr = `${chalk.green(currentVal)}  ${chalk.dim("✓ stable")}`;
        }

        return `│ ${chalk.dim(labelPad)} ${valueStr}`;
    }

    lines.push(row(
        "system",
        current.system,
        previous?.system,
        changed.includes("system")
    ));

    lines.push(row(
        "schema",
        current.schema,
        previous?.schema,
        changed.includes("schema")
    ));

    lines.push(row(
        "model",
        current.model,
        previous?.model,
        changed.includes("model")
    ));

    lines.push(row(
        "temperature",
        current.temperature,
        previous?.temperature,
        changed.includes("temperature")
    ));

    // Rules row — always shown
    const rulesLabel = current.rules ? `${chalk.cyan(current.rules)}  ${chalk.dim("active")}` : chalk.dim("(none)");
    lines.push(`│ ${chalk.dim("rules".padEnd(12))} ${rulesLabel}`);

    // Context label row — only shown when set (e.g. "PR vs main")
    if (current.contextLabel) {
        lines.push(
            `│ ${chalk.dim("context".padEnd(12))} ${chalk.magenta(current.contextLabel)}`
        );
    }

    lines.push(chalk.dim(`│ ${"─".repeat(width - 2)}`));

    // Overall status row
    const overallStatus =
        cacheImpact === "first-run"
            ? chalk.dim("first run — baseline saved")
            : cacheImpact === "stable"
                ? chalk.green("✓ cache-friendly")
                : chalk.red("✗ cache busted");

    lines.push(`│ ${chalk.dim("overall".padEnd(12))} ${chalk.dim(current.overall)}  ${overallStatus}`);

    if (previous) {
        const ago = timeAgo(previous.timestamp);
        lines.push(`│ ${chalk.dim("last run".padEnd(12))} ${chalk.dim(ago)}`);
    }

    lines.push(chalk.dim(`└${"─".repeat(width)}┘`));

    // Warning block if cache was busted
    if (cacheImpact === "busted" && changed.length > 0) {
        lines.push("");
        lines.push(chalk.yellow(`  ⚠ Prompt fingerprint changed since last run.`));
        lines.push(chalk.yellow(`    Changed: ${changed.join(", ")}`));
        lines.push(chalk.dim(`    Expect cache misses until the prompt stabilizes.`));
        lines.push(chalk.dim(`    Run 'critcache compare .' after stabilizing to verify cache recovery.`));
    }

    if (cacheImpact === "stable" && previous) {
        lines.push(chalk.dim(`  ✓ Prompt unchanged — BTL Runtime cache should warm normally.`));
    }

    return lines.join("\n");
}