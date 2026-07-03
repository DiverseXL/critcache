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
/**
 * Recursively walk `rootDir`, respecting .gitignore and built-in exclusions.
 * Returns up to `maxFiles` files ranked by:
 *   1. Extension priority (source files before config/docs)
 *   2. File size descending (larger = more code = more interesting to review)
 */
export declare function walkRepo(rootDir: string, options?: number | WalkOptions): RankedFile[];
//# sourceMappingURL=walker.d.ts.map