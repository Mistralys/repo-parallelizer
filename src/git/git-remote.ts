import { runGit } from './git-cli.js';
import { stripEmbeddedCredentials } from './git-credentials.js';
import type { GitResult } from './git.types.js';

/**
 * Pattern a branch or ref name must match before being interpolated into a
 * git refspec or passed as a positional ref argument.
 *
 * Deliberately conservative: letters, digits, `.`, `_`, `/`, and `-` only.
 * A leading `-` and any `..` segment are rejected separately (see
 * {@link isValidRefName}) since both are meaningful to git (flag injection
 * and parent-traversal in a ref path, respectively) and are technically
 * matched by the character class above.
 */
const SAFE_REFNAME_PATTERN = /^[A-Za-z0-9._/-]+$/;

/**
 * Validates a branch or ref name against {@link SAFE_REFNAME_PATTERN}, and
 * additionally rejects a leading `-` (flag-injection guard, consistent with
 * `createBranch()`/`switchBranch()` in `git-branch.ts`) and any `..` segment
 * (ref path traversal guard).
 *
 * @param name - The branch or ref name to validate.
 */
function isValidRefName(name: string): boolean {
    if (!name) return false;
    if (name.startsWith('-')) return false;
    if (name.includes('..')) return false;
    return SAFE_REFNAME_PATTERN.test(name);
}

/**
 * Returns a `GitResult` describing a rejected branch/ref argument, in the
 * same shape used by `createBranch()`/`switchBranch()` in `git-branch.ts`.
 *
 * @param label - The argument name being rejected (for the error message).
 * @param value - The rejected value.
 */
function invalidRefResult(label: string, value: string): GitResult {
    return {
        exitCode: 128,
        stdout: '',
        stderr: `fatal: '${value}' is not a valid ${label}`,
    };
}

/**
 * Reads the configured URL for a remote.
 *
 * @param repoPath - Absolute path to the local repository.
 * @param remote   - Remote name. Defaults to `"origin"`.
 * @returns The trimmed remote URL, or `null` when the remote does not exist
 *   or the command otherwise fails.
 */
export async function getRemoteUrl(repoPath: string, remote: string = 'origin'): Promise<string | null> {
    const result = await runGit(['remote', 'get-url', remote], repoPath);
    if (result.exitCode !== 0) return null;
    return result.stdout.trim();
}

/**
 * Sets (or replaces) the URL configured for a remote.
 *
 * **SECURITY:** When `url` embeds a credential token (see
 * `injectCredentialToken()` in `git-credentials.ts`), the token is written to
 * the repository's local git config (`.git/config`) on disk for as long as
 * the URL remains set. Callers that use this to temporarily inject a
 * credential for a single fetch/push must restore the plain URL afterwards
 * (e.g. via a second `setRemoteUrl()` call) rather than leaving the
 * authenticated URL configured indefinitely.
 *
 * @param repoPath - Absolute path to the local repository.
 * @param url      - The URL to configure for the remote.
 * @param remote   - Remote name. Defaults to `"origin"`.
 */
export function setRemoteUrl(repoPath: string, url: string, remote: string = 'origin'): Promise<GitResult> {
    return runGit(['remote', 'set-url', remote, url], repoPath);
}

/**
 * Fetches a single branch from `origin` via an explicit refspec, rather than
 * the default "fetch everything configured" behavior of `fetchRemote()` in
 * `git-branch.ts`.
 *
 * Used together with `setRemoteUrl()`: the caller temporarily points `origin`
 * at an authenticated URL, calls `fetchBranch()`, then restores the plain URL.
 *
 * @param repoPath - Absolute path to the local repository.
 * @param branch   - Branch name to fetch (validated against the safe refname
 *                   pattern; an invalid name resolves with `exitCode: 128`
 *                   rather than being passed to git).
 * @param options  - Optional partial-clone `filter` and `timeoutMs`.
 */
export function fetchBranch(
    repoPath: string,
    branch: string,
    options: { filter?: 'blob:none'; timeoutMs?: number } = {},
): Promise<GitResult> {
    if (!isValidRefName(branch)) {
        return Promise.resolve(invalidRefResult('branch name', branch));
    }

    const args = ['fetch'];
    if (options.filter !== undefined) {
        args.push(`--filter=${options.filter}`);
    }
    args.push('origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`);

    return runGit(args, repoPath, options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : undefined);
}

/**
 * Pushes the currently checked-out `HEAD` to the given branch on `origin`.
 *
 * @param repoPath  - Absolute path to the local repository.
 * @param branch    - Destination branch name on `origin` (validated against
 *                    the safe refname pattern).
 * @param timeoutMs - Optional timeout in milliseconds for the push.
 */
export function pushHead(repoPath: string, branch: string, timeoutMs?: number): Promise<GitResult> {
    if (!isValidRefName(branch)) {
        return Promise.resolve(invalidRefResult('branch name', branch));
    }

    return runGit(
        ['push', 'origin', `HEAD:refs/heads/${branch}`],
        repoPath,
        timeoutMs !== undefined ? { timeoutMs } : undefined,
    );
}

/**
 * Fast-forwards the current branch to the remote-tracking ref for `branch`.
 *
 * Uses `--ff-only` so the merge fails loudly (non-zero exit code) rather than
 * creating a merge commit or silently diverging when the histories have
 * diverged — the caller is expected to treat a non-zero exit code as "a
 * fast-forward merge is not possible" rather than attempting error recovery
 * here.
 *
 * @param repoPath - Absolute path to the local repository.
 * @param branch   - Branch name whose remote-tracking ref
 *                   (`refs/remotes/origin/<branch>`) should be merged in
 *                   (validated against the safe refname pattern).
 */
export function mergeFastForward(repoPath: string, branch: string): Promise<GitResult> {
    if (!isValidRefName(branch)) {
        return Promise.resolve(invalidRefResult('branch name', branch));
    }

    return runGit(['merge', '--ff-only', `refs/remotes/origin/${branch}`], repoPath);
}

/**
 * Counts commits by which `HEAD` is ahead of and behind the remote-tracking
 * ref for `branch`.
 *
 * @param repoPath - Absolute path to the local repository.
 * @param branch   - Branch name whose remote-tracking ref
 *                   (`refs/remotes/origin/<branch>`) `HEAD` is compared
 *                   against (validated against the safe refname pattern).
 * @returns `{ ahead: 0, behind: 0 }` when `branch` fails validation or the
 *   underlying git command fails (e.g. the remote-tracking ref does not
 *   exist yet because nothing has been fetched).
 */
export async function countAheadBehind(
    repoPath: string,
    branch: string,
): Promise<{ ahead: number; behind: number }> {
    if (!isValidRefName(branch)) {
        return { ahead: 0, behind: 0 };
    }

    const result = await runGit(
        ['rev-list', '--left-right', '--count', `HEAD...refs/remotes/origin/${branch}`],
        repoPath,
    );
    if (result.exitCode !== 0) {
        return { ahead: 0, behind: 0 };
    }

    const [aheadStr, behindStr] = result.stdout.trim().split(/\s+/);
    return {
        ahead: parseInt(aheadStr ?? '', 10) || 0,
        behind: parseInt(behindStr ?? '', 10) || 0,
    };
}

/**
 * Lists paths that differ between two refs (commits, branches, or tags).
 *
 * @param repoPath - Absolute path to the local repository.
 * @param fromRef  - The starting ref (validated against the safe refname
 *                   pattern — this also accepts a full commit SHA, which
 *                   matches the same character class).
 * @param toRef    - The ending ref (same validation as `fromRef`).
 * @returns The list of changed paths, or an empty array when either ref
 *   fails validation or the underlying git command fails.
 */
export async function changedPathsBetween(
    repoPath: string,
    fromRef: string,
    toRef: string,
): Promise<string[]> {
    if (!isValidRefName(fromRef) || !isValidRefName(toRef)) {
        return [];
    }

    const result = await runGit(['diff', '--name-only', fromRef, toRef], repoPath);
    if (result.exitCode !== 0) {
        return [];
    }

    return result.stdout.split('\n').filter((line) => line.length > 0);
}

/**
 * Normalises a remote URL for comparison: strips embedded credentials,
 * lowercases the hostname, and drops a trailing `/` and/or `.git` suffix.
 *
 * @param url - The URL to normalise.
 */
function normalizeRemoteUrl(url: string): string {
    const stripped = stripEmbeddedCredentials(url).trim();

    try {
        const parsed = new URL(stripped);
        const host = parsed.hostname.toLowerCase();
        const port = parsed.port ? `:${parsed.port}` : '';
        let pathname = parsed.pathname;
        if (pathname.endsWith('.git')) pathname = pathname.slice(0, -4);
        if (pathname.endsWith('/')) pathname = pathname.slice(0, -1);
        return `${parsed.protocol}//${host}${port}${pathname}`;
    } catch {
        // Not parseable as a WHATWG URL — likely an SCP-style SSH URL
        // (e.g. "git@github.com:org/repo.git"). Lowercase only the host
        // portion (hostnames are case-insensitive); the path portion after
        // the colon is left as-is since repository paths can be
        // case-sensitive on some hosts.
        let path = stripped;
        if (path.endsWith('.git')) path = path.slice(0, -4);
        if (path.endsWith('/')) path = path.slice(0, -1);

        const scpMatch = /^([^@/:]+@)?([^:/]+):(.*)$/.exec(path);
        if (scpMatch) {
            const [, userinfo = '', host, rest] = scpMatch;
            return `${userinfo}${host.toLowerCase()}:${rest}`;
        }
        return path.toLowerCase();
    }
}

/**
 * Compares two remote URLs for equivalence, ignoring embedded credentials,
 * hostname case, and a trailing `/` or `.git` suffix.
 *
 * @param a - First URL to compare.
 * @param b - Second URL to compare.
 */
export function remoteUrlsMatch(a: string, b: string): boolean {
    return normalizeRemoteUrl(a) === normalizeRemoteUrl(b);
}
