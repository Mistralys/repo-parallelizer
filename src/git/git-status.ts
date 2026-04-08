import { runGit } from './git-cli.js';
import { fetchRemote, getCurrentBranch } from './git-branch.js';
import type { GitStatusInfo } from './git.types.js';

/**
 * Two-character XY codes from `git status --porcelain` that indicate an
 * unresolved merge conflict:
 *   UU  — both modified
 *   AA  — both added
 *   DD  — both deleted
 *   AU  — added by us, unmerged
 *   UA  — added by them, unmerged
 *   DU  — deleted by us, unmerged
 *   UD  — deleted by them, unmerged
 */
const CONFLICT_CODES = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);

/**
 * Queries the working-tree status and returns a structured snapshot.
 *
 * All Git sub-commands are run in parallel (they are all read-only).
 *
 * - `currentBranch`: the checked-out branch name, or null for detached HEAD.
 * - `localCommits`: commits ahead of the upstream tracking branch; 0 when no
 *   upstream is configured.
 * - `unfetchedCommits`: commits behind the upstream tracking branch; 0 when no
 *   upstream is configured. Reflects the last-fetched remote state — call
 *   {@link fetchAndGetStatus} to get an up-to-date count.
 * - `modifiedFiles`: total entries reported by `git status --porcelain` (staged, unstaged, and untracked).
 * - `lastActivity`: ISO 8601 timestamp of the most recent commit; null for an
 *   empty repository (no commits yet).
 * - `hasConflicts`: true when the porcelain output contains unresolved markers.
 *
 * @param repoPath - Absolute path to the local repository.
 */
export async function getGitStatus(repoPath: string): Promise<GitStatusInfo> {
    const [currentBranch, aheadResult, behindResult, porcelainResult, logResult] =
        await Promise.all([
            getCurrentBranch(repoPath),
            runGit(['rev-list', '--count', '@{upstream}..HEAD'], repoPath),
            runGit(['rev-list', '--count', 'HEAD..@{upstream}'], repoPath),
            runGit(['status', '--porcelain'], repoPath),
            runGit(['log', '-1', '--format=%cI'], repoPath),
        ]);

    const localCommits =
        aheadResult.exitCode === 0 ? parseInt(aheadResult.stdout.trim(), 10) || 0 : 0;

    const unfetchedCommits =
        behindResult.exitCode === 0 ? parseInt(behindResult.stdout.trim(), 10) || 0 : 0;

    const porcelainLines = porcelainResult.stdout.split('\n').filter((line) => line.length > 0);
    const modifiedFiles = porcelainLines.length;
    const hasConflicts = porcelainLines.some((line) => CONFLICT_CODES.has(line.slice(0, 2)));

    const lastActivity = logResult.exitCode === 0 ? logResult.stdout.trim() || null : null;

    return {
        currentBranch,
        localCommits,
        unfetchedCommits,
        modifiedFiles,
        lastActivity,
        hasConflicts,
    };
}

/**
 * Fetches updates from the `origin` remote, then returns the working-tree
 * status via {@link getGitStatus}.
 *
 * The fetch is best-effort: failures (no network, no remote configured, etc.)
 * are silently ignored so that the status query always runs. In that case
 * `unfetchedCommits` reflects the last known remote state rather than the live
 * remote state.
 *
 * @param repoPath  - Absolute path to the local repository.
 * @param timeoutMs - Optional timeout in milliseconds for the fetch operation.
 */
export async function fetchAndGetStatus(repoPath: string, timeoutMs?: number): Promise<GitStatusInfo> {
    await fetchRemote(repoPath, 'origin', timeoutMs).catch(() => undefined);
    return getGitStatus(repoPath);
}
