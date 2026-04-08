/**
 * Result of running a Git command via runGit().
 */
export interface GitResult {
    /** Process exit code. 0 indicates success. */
    exitCode: number;
    /** Standard output captured from the process. */
    stdout: string;
    /** Standard error captured from the process. */
    stderr: string;
}

/**
 * A snapshot of the repository's working-tree status.
 */
export interface GitStatusInfo {
    /** Currently checked-out branch name, or null when HEAD is detached. */
    currentBranch: string | null;
    /** Number of commits the local branch is ahead of its upstream tracking branch. */
    localCommits: number;
    /** Number of commits the upstream tracking branch is ahead of the local branch. */
    unfetchedCommits: number;
    /** Number of entries reported by `git status --porcelain` (staged, unstaged, and untracked). */
    modifiedFiles: number;
    /** ISO 8601 timestamp of the most recent commit, or null for an empty repository. */
    lastActivity: string | null;
    /** True when the working tree contains unresolved merge conflicts. */
    hasConflicts: boolean;
}

/**
 * Metadata about a single Git branch.
 */
export interface BranchInfo {
    /** Full branch name (e.g. "main", "origin/main"). */
    name: string;
    /** True when this branch is currently checked out. */
    isCurrent: boolean;
    /** True when this is a remote-tracking branch. */
    isRemote: boolean;
    /** Name of the configured upstream branch, if any. */
    upstream?: string;
}

/**
 * Options controlling a git clone operation.
 */
export interface CloneOptions {
    /** Truncate history to this many commits. Omit for a full clone. */
    depth?: number;
    /** Check out a specific branch instead of the remote default. */
    branch?: string;
    /** Perform a bare clone (no working tree). */
    bare?: boolean;
    /** Abort the clone if it has not completed within this many milliseconds. */
    timeoutMs?: number;
}

/**
 * Options controlling a runGit() invocation.
 */
export interface RunGitOptions {
    /** Abort the git process if it has not exited within this many milliseconds. */
    timeoutMs?: number;
    /**
     * Kill the git process and return a partial result when the accumulated
     * stdout + stderr size exceeds this many bytes. Defaults to 10 MB.
     */
    maxBufferBytes?: number;
}
