import { runGit } from './git-cli.js';
import type { CloneOptions, GitResult } from './git.types.js';

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

    args.push(url, destination);

    return runGit(args, undefined, options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : undefined);
}
