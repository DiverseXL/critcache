import type { RunResult } from "./runner.js";
/**
 * Renders a RunResult as a clean markdown report and writes it to disk.
 * Kept separate from runner.ts so the formatting logic can be iterated
 * on independently of the live-render/concurrency logic.
 */
export declare function writeReport(result: RunResult, outputPath: string, repoLabel: string): void;
//# sourceMappingURL=report.d.ts.map