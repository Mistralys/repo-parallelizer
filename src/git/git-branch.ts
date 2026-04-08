import { runGit, runGitOrThrow } from './git-cli.js';
import type { BranchInfo, GitResult } from './git.types.js';

/**
 * Lists all branches in a repository, including remote-tracking branches.
 *
 * Remote-tracking branches (e.g. origin/main) have `isRemote: true`.
 * The branch that is currently checked out has `isCurrent: true`.
 * Symbolic remote HEAD pointers (e.g. origin/HEAD) are excluded.
 *
 * @param repoPath - Absolute path to the local repository.
 */
export async function listBranches(repoPath: string): Promise<BranchInfo[]> {
    // Output columns: full refname, HEAD marker, short name, upstream short name
    const format = '%(refname)\t%(HEAD)\t%(refname:short)\t%(upstream:short)';
    const output = await runGitOrThrow(['branch', '-a', `--format=${format}`], repoPath);

    if (!output) return [];

    return output
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [refname, head, shortName, upstream] = line.split('\t');
            return { refname, head, shortName, upstream };
        })
        .filter(({ shortName }) => {
            // Exclude origin/HEAD → origin/main symbolic pointers
            return !shortName.endsWith('/HEAD');
        })
        .map(({ refname, head, shortName, upstream }) => {
            const isRemote = refname.startsWith('refs/remotes/');
            const info: BranchInfo = {
                name: shortName,
                isCurrent: head === '*',
                isRemote,
            };
            if (upstream) info.upstream = upstream;
            return info;
        });
}

/**
 * Returns the name of the currently checked-out branch, or `null` when the
 * repository is in detached HEAD state.
 *
 * @param repoPath - Absolute path to the local repository.
 */
export async function getCurrentBranch(repoPath: string): Promise<string | null> {
    const result = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
    if (result.exitCode !== 0) return null;
    const branch = result.stdout.trim();
    // git outputs "HEAD" when in detached HEAD state
    return branch === 'HEAD' ? null : branch;
}

/**
 * Returns the name of the repository's default branch (typically "main" or
 * "master").
 *
 * Resolution order:
 * 1. Read the remote HEAD symbolic ref (`refs/remotes/origin/HEAD`).
 * 2. Check whether a local or remote branch named "main" exists.
 * 3. Check whether a local or remote branch named "master" exists.
 * 4. Fall back to "main".
 *
 * @param repoPath - Absolute path to the local repository.
 */
export async function getDefaultBranch(repoPath: string): Promise<string> {
    // Attempt 1: remote HEAD symref (most reliable when remote is configured)
    const symrefResult = await runGit(
        ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
        repoPath,
    );
    if (symrefResult.exitCode === 0) {
        const ref = symrefResult.stdout.trim(); // e.g. "origin/main"
        const slash = ref.indexOf('/');
        if (slash !== -1) return ref.slice(slash + 1);
    }

    // Attempt 2: does "main" exist locally or as a remote-tracking branch?
    const mainLocal = await runGit(['rev-parse', '--verify', 'refs/heads/main'], repoPath);
    if (mainLocal.exitCode === 0) return 'main';

    const mainRemote = await runGit(
        ['rev-parse', '--verify', 'refs/remotes/origin/main'],
        repoPath,
    );
    if (mainRemote.exitCode === 0) return 'main';

    // Attempt 3: does "master" exist?
    const masterLocal = await runGit(['rev-parse', '--verify', 'refs/heads/master'], repoPath);
    if (masterLocal.exitCode === 0) return 'master';

    const masterRemote = await runGit(
        ['rev-parse', '--verify', 'refs/remotes/origin/master'],
        repoPath,
    );
    if (masterRemote.exitCode === 0) return 'master';

    // Last resort
    return 'main';
}

/**
 * Creates a new branch and immediately checks it out.
 *
 * The promise resolves with a `GitResult`; the caller may inspect `exitCode`
 * and `stderr` for conflict or validation errors.
 *
 * @param repoPath   - Absolute path to the local repository.
 * @param branchName - Name of the new branch to create.
 */
export function createBranch(repoPath: string, branchName: string): Promise<GitResult> {
    if (branchName.startsWith('-')) {
        return Promise.resolve({
            exitCode: 128,
            stdout: '',
            stderr: `fatal: '${branchName}' is not a valid branch name`,
        });
    }
    return runGit(['switch', '-c', branchName], repoPath);
}

/**
 * Switches to an existing branch.
 *
 * The promise resolves rather than throws for non-zero exit codes, allowing
 * the caller to inspect `exitCode` and `stderr` (e.g. for conflict detection).
 *
 * @param repoPath   - Absolute path to the local repository.
 * @param branchName - Name of the branch to switch to.
 */
export function switchBranch(repoPath: string, branchName: string): Promise<GitResult> {
    if (branchName.startsWith('-')) {
        return Promise.resolve({
            exitCode: 128,
            stdout: '',
            stderr: `fatal: '${branchName}' is not a valid branch name`,
        });
    }
    return runGit(['switch', branchName], repoPath);
}

/**
 * Checks whether a branch exists in the repository.
 *
 * When `remote` is provided, checks the remote-tracking ref
 * (`refs/remotes/<remote>/<branchName>`). When omitted, checks the local ref
 * (`refs/heads/<branchName>`).
 *
 * @param repoPath   - Absolute path to the local repository.
 * @param branchName - Branch name to look up (without the remote prefix).
 * @param remote     - Optional remote name (e.g. "origin"). Omit for local-only check.
 *
 * @remarks
 * Neither `branchName` nor `remote` is validated against a safe refname pattern.
 * A path-traversal value (e.g. `branchName = '../config'`) causes the constructed
 * ref (`refs/remotes/origin/../config`) to resolve to an unintended ref, which may
 * produce a false-positive `true` result. Validate both parameters before passing
 * untrusted input. A future cleanup WP will add the same `'-'` prefix guard that
 * is already present on `createBranch()` and `switchBranch()`.
 */
export async function branchExists(
    repoPath: string,
    branchName: string,
    remote?: string,
): Promise<boolean> {
    // Guard against flag-injection: a branch name starting with '-' can never
    // be a valid ref and would be misinterpreted as a flag by git.
    if (branchName.startsWith('-')) return false;
    const ref = remote
        ? `refs/remotes/${remote}/${branchName}`
        : `refs/heads/${branchName}`;
    const result = await runGit(['rev-parse', '--verify', ref], repoPath);
    return result.exitCode === 0;
}

/**
 * Fetches updates from a remote.
 *
 * When `remote` is omitted, git fetches all configured remotes. The promise
 * resolves for all normal outcomes including non-zero exit codes; the caller
 * inspects `GitResult.exitCode`.
 *
 * @param repoPath - Absolute path to the local repository.
 * @param remote   - Optional remote name (e.g. "origin").
 */
export function fetchRemote(repoPath: string, remote?: string, timeoutMs?: number): Promise<GitResult> {
    // The remote argument is either a trusted name (e.g. "origin") supplied by
    // internal callers or omitted entirely — it is intentionally not validated
    // against a denylist because all currently known callers pass a literal
    // constant.  Wild-card or user-supplied remotes should be validated before
    // reaching this function.
    const args = remote ? ['fetch', remote] : ['fetch'];
    return runGit(args, repoPath, timeoutMs !== undefined ? { timeoutMs } : undefined);
}
