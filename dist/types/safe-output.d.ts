/**
 * Replace a report without following a destination symlink or exposing a
 * partially written file. POSIX files are owner-only; Windows files inherit
 * the destination directory ACL.
 */
export declare function writePrivateFileAtomic(destination: string, content: string): void;
/**
 * Create a repository-relative private output without traversing a symlinked
 * parent. This is intentionally separate from the generic atomic writer:
 * most output commands require an existing parent, while portable receipts
 * need to create their conventional `.agent-vigil` directory on first use.
 */
export declare function writePrivateFileAtomicWithin(root: string, destination: string, content: string): void;
/**
 * Create a new owner-only file without replacing an existing directory entry.
 * This is used for append-only evidence where replacement would erase history.
 */
export declare function writePrivateFileExclusive(destination: string, content: string): void;
export declare function appendPrivateFileAtomic(destination: string, content: string): void;
