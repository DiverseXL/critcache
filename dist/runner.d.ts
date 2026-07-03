import type { WalkedFile } from "./walker.js";
import { type AnalyzeFileResult, type RepoSynthesis } from "./btl-client.js";
/** Per-file state tracked for the live render. */
type FileStatus = "pending" | "running" | "done" | "error";
interface FileRow {
    file: WalkedFile;
    status: FileStatus;
    result?: AnalyzeFileResult;
}
export interface RunResult {
    rows: FileRow[];
    synthesis: RepoSynthesis | null;
    synthesisError?: string;
    totalSavedUsd: number;
    totalBenchmarkCostUsd: number;
    totalChargeUsd: number;
    cacheHits: number;
    cacheMisses: number;
}
/**
 * Runs BTL analysis across all walked files with bounded concurrency,
 * rendering live in-place progress in the terminal. After all per-file
 * calls complete, fires one synthesis call and folds its cost into totals.
 *
 * Returns the full per-file result set, synthesis output, and aggregated
 * savings totals for the final summary table and report writer.
 */
export declare function runAnalysis(files: WalkedFile[], concurrency: number): Promise<RunResult>;
export {};
//# sourceMappingURL=runner.d.ts.map