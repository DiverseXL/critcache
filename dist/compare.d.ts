import type { WalkedFile } from "./walker.js";
import { type RunResult } from "./runner.js";
export interface CompareResult {
    pass1: RunResult;
    pass2: RunResult;
    pass1DurationMs: number;
    pass2DurationMs: number;
}
/**
 * Runs the full analysis pass twice, back to back, over the same file set.
 * The point is purely demonstrative: pass 1 is the "cold" run (mostly cache
 * misses, since BTL hasn't seen this exact prompt+file combination before),
 * pass 2 is the "warm" run immediately after (should land mostly cache hits
 * on exact/prefix tiers, since the prompt scaffolding + file content are
 * byte-identical to pass 1).
 *
 * This function does not invent any new BTL-calling logic — it's a thin
 * orchestrator that calls runAnalysis twice and times each pass.
 */
export declare function runComparison(files: WalkedFile[], concurrency: number): Promise<CompareResult>;
/**
 * Renders the pass1 vs pass2 delta as a terminal table. Kept separate from
 * runComparison so the orchestration logic and the presentation logic can
 * change independently.
 */
export declare function renderComparisonTable(result: CompareResult): string;
//# sourceMappingURL=compare.d.ts.map