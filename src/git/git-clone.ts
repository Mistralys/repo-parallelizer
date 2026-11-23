import { runGit } from './git-cli.js';
import type { CloneOptions, GitResult } from './git.types.js';

/**
 * Substring that appears in a server's error response when it does not
 * support partial-clone filtering (`uploadpack.allowFilter` is unset or the
 * server is too old). Callers that request `CloneOptions.filter` should check
 * for this substring in a failed clone's `stderr` and retry without the
 * filter rather than surfacing a confusing low-level git error.
 */
export const FILTER_UNSUPPORTED_WARNING = 'filtering not recognized by server';

/**
 * Allowlist of URL prefixes/schemes that are safe to pass to `git clone`.
 *
 * This list explicitly excludes dangerous transport protocols such as `ext::`
 * and `rsh::` which can execute arbitrary shell commands on the client side.
 * Local absolute paths (starting with `/`) and the `file://` scheme are
 * included because they are safe and needed for local-only operations.
 */
const ALLOWED_URL_PREFIXES: readonly string[] = [
    'https://',
    'http://',
    'git://',
    'ssh://',
    'git@',     // SCP-style SSH, e.g. git@github.com:org/repo.git
    'file://',  // explicit local-file transport
    '/',        // absolute local path (Unix)
];

/**
 * Returns true when the given URL/path is safe to pass to `git clone`.
 */
function isAllowedUrl(url: string): boolean {
    if (!url || url.trim().length === 0) return false;
    return ALLOWED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/**
 * Clones a Git repository to the specified destination path.
 *
 * Before invoking git, the URL is validated against an allowlist of safe
 * transport schemes.  Dangerous protocols such as `ext::` and `rsh::` are
 * rejected immediately with `exitCode: 128` and a descriptive stderr message.
 *
 * Builds the git argument array from CloneOptions and delegates execution to
 * runGit(). The promise resolves for all normal outcomes including non-zero
 * exit codes; the caller inspects `GitResult.exitCode` to determine success or
 * failure. The promise rejects only for spawn-level failures (e.g. ENOENT when
 * git is not found on PATH).
 *
 * @param url         - Remote URL or local path of the repository to clone.
 * @param destination - Local path where the clone should be created.
 * @param options     - Optional clone settings (depth, branch, bare, timeoutMs).
 */
export function cloneRepository(
    url: string,
    destination: string,
    options: CloneOptions = {},
): Promise<GitResult> {
    if (!isAllowedUrl(url)) {
        return Promise.resolve({
            exitCode: 128,
            stdout: '',
            stderr: `fatal: repository URL uses a disallowed transport protocol: '${url}'`,
        });
    }

    if (url.startsWith('http://') || url.startsWith('git://')) {
        const protocol = url.startsWith('http://') ? 'http://' : 'git://';
        console.warn(
            `Warning: cloning over cleartext protocol (${protocol}). Consider using https:// or ssh:// for security.`,
        );
    }

    const args: string[] = ['clone'];

    if (options.depth !== undefined) {
        args.push('--depth', String(options.depth));
    }

    if (options.branch !== undefined) {
        args.push('--branch', options.branch);
    }

    if (options.bare === true) {
        args.push('--bare');
    }

    if (options.filter !== undefined) {
        args.push(`--filter=${options.filter}`);
    }

    if (options.noCheckout === true) {
        args.push('--no-checkout');
    }

    args.push(url, destination);

    return runGit(args, undefined, options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : undefined);
}

/**
 * Configures cone-mode sparse-checkout for a repository, restricting the
 * working tree to the given top-level paths.
 *
 * Typically used after a `cloneRepository()` call made with
 * `noCheckout: true`, so that only the desired paths are ever written to
 * disk. Each path is validated against a `-`-prefix guard before being
 * passed to git, since a `-`-prefixed value would otherwise be
 * misinterpreted as a flag by `git sparse-checkout set`.
 *
 * @param repoPath - Absolute path to the local repository.
 * @param paths    - Top-level paths (relative to the repository root) to
 *                   include in the sparse working tree.
 * @returns A `GitResult`; the promise resolves rather than throws for a
 *   rejected (`-`-prefixed) path, mirroring the validation-failure pattern
 *   used by `createBranch()`/`switchBranch()` in `git-branch.ts`.
 */
export function setSparseCheckout(repoPath: string, paths: string[]): Promise<GitResult> {
    const invalidPath = paths.find((p) => p.startsWith('-'));
    if (invalidPath !== undefined) {
        return Promise.resolve({
            exitCode: 128,
            stdout: '',
            stderr: `fatal: sparse-checkout path must not start with '-': '${invalidPath}'`,
        });
    }

    return runGit(['sparse-checkout', 'set', '--cone', '--', ...paths], repoPath);
}
