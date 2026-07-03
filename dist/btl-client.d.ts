/**
 * BTL Runtime client.
 *
 * One responsibility: send a file's content through BTL Runtime's
 * /v1/chat/completions endpoint using a FIXED system prompt + schema,
 * and return both the parsed analysis and the raw savings/cache headers.
 *
 * The system prompt below must stay byte-identical across every call —
 * that repetition is exactly what lets BTL's exact/prefix caching kick in.
 * Do not template or vary this string per file.
 */
/** Shape of the structured analysis we expect back from the model. */
export interface FileAnalysis {
    role: string;
    complexity: "low" | "medium" | "high" | string;
    test_gaps: string;
    security_note: string;
    summary: string;
}
/** Savings/cache metadata read off the BTL Runtime response headers. */
export interface BtlUsageInfo {
    cacheTier: string | undefined;
    benchmarkCostUsd: number | undefined;
    customerChargeUsd: number | undefined;
    savedUsd: number | undefined;
}
export interface AnalyzeFileResult {
    analysis: FileAnalysis | null;
    usage: BtlUsageInfo;
    /** Set if the model response couldn't be parsed as the expected JSON shape. */
    parseError?: string;
    /** Set if the HTTP call itself failed (network, auth, non-2xx). */
    requestError?: string;
}
/** Repo-level findings produced by the synthesis pass over all file analyses. */
export interface RepoSynthesis {
    architecture_overview: string;
    top_risks: string[];
    next_steps: string[];
}
export interface SynthesizeResult {
    synthesis: RepoSynthesis | null;
    usage: BtlUsageInfo;
    parseError?: string;
    requestError?: string;
}
/**
 * Sends one file's content to BTL Runtime for analysis.
 * Never throws — all failure modes are reported back on the result object
 * so a single bad file never crashes the whole repo scan.
 */
export declare function analyzeFile(relPath: string, content: string): Promise<AnalyzeFileResult>;
/**
 * One extra call: takes every successfully-parsed per-file analysis and asks
 * the model to produce repo-level findings. Expects an array of
 * { path, ...FileAnalysis } objects as input.
 */
export declare function synthesize(fileAnalyses: Array<{
    path: string;
} & FileAnalysis>): Promise<SynthesizeResult>;
//# sourceMappingURL=btl-client.d.ts.map