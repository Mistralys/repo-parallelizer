# Git - Architecture
_SOURCE: Git types and CLI wrapper functions_
# Git types and CLI wrapper functions
```
// Structure of documents
└── src/
    └── git/
        └── git-branch.ts
        └── git-cli.ts
        └── git-clone.ts
        └── git-credentials.ts
        └── git-status.ts
        └── git.types.ts

```
###  Path: `/src/git/git-branch.ts`

```ts
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

```
###  Path: `/src/git/git-cli.ts`

```ts
import { spawn } from 'node:child_process';
import type { GitResult, RunGitOptions } from './git.types.js';

/**
 * Spawns a git sub-process and collects its output.
 *
 * The process is always spawned with `shell: false` to prevent shell
 * injection — arguments must be provided as a pre-split array, never
 * as a single concatenated string.
 *
 * The promise **resolves** for all normal outcomes including non-zero exit
 * codes; the caller inspects `GitResult.exitCode` and decides whether to
 * treat the result as an error.
 *
 * The promise **rejects** only for spawn-level failures such as ENOENT
 * (git binary not found on PATH).
 *
 * When `options.timeoutMs` is set, an `AbortController` is used to kill the
 * process after the specified duration; in that case the promise resolves
 * with `exitCode: -1` and a descriptive stderr message rather than hanging.
 *
 * When `options.maxBufferBytes` is set (default 10 MB), the process is killed
 * and the promise resolves with `exitCode: -1` if the combined stdout + stderr
 * size exceeds the limit.  The partial output captured before the limit is
 * returned in `stdout`.
 *
 * @param args    - Git arguments, e.g. `['clone', '--depth', '1', url, dest]`.
 * @param cwd     - Working directory for the spawned process. Defaults to the
 *                  calling process's current working directory when omitted.
 * @param options - Optional timeout and buffer-limit controls.
 */
export function runGit(args: string[], cwd?: string, options?: RunGitOptions): Promise<GitResult> {
    return new Promise((resolve, reject) => {
        const maxBufferBytes = options?.maxBufferBytes ?? 10 * 1024 * 1024; // 10 MB default

        // Set up AbortController for optional timeout.
        const controller = options?.timeoutMs !== undefined ? new AbortController() : undefined;

        // Disable all credential helpers and interactive auth prompts so that git
        // fails fast (exit 128) on unauthenticated remotes instead of hanging.
        //   GIT_TERMINAL_PROMPT=0  — suppresses TTY-based git prompts.
        //   GIT_ASKPASS=echo       — replaces any credential helper (e.g. osxkeychain
        //                            on macOS, libsecret on Linux, DPAPI on Windows)
        //                            with a no-op binary that immediately returns empty
        //                            credentials.  Together these two vars provide
        //                            defence-in-depth.  Do NOT remove GIT_ASKPASS or
        //                            replace 'echo' — it is the primary guard against
        //                            osxkeychain hanging on 401 HTTP responses.
        const proc = spawn('git', args, {
            shell: false,
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
            ...(controller ? { signal: controller.signal } : {}),
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let totalBytes = 0;
        let bufferLimitExceeded = false;
        let aborted = false;
        let settled = false;

        // Arm the timeout.
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        if (controller !== undefined && options?.timeoutMs !== undefined) {
            const timeoutMs = options.timeoutMs;
            timeoutHandle = setTimeout(() => {
                aborted = true;
                controller.abort();
            }, timeoutMs);
        }

        /** Resolves the promise exactly once and clears any pending timeout. */
        function settle(result: GitResult): void {
            if (settled) return;
            settled = true;
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
            resolve(result);
        }

        proc.stdout.on('data', (chunk: Buffer) => {
            if (bufferLimitExceeded) return;
            totalBytes += chunk.length;
            if (totalBytes > maxBufferBytes) {
                bufferLimitExceeded = true;
                proc.kill();
                return;
            }
            stdoutChunks.push(chunk);
        });

        proc.stderr.on('data', (chunk: Buffer) => {
            if (bufferLimitExceeded) return;
            totalBytes += chunk.length;
            if (totalBytes > maxBufferBytes) {
                bufferLimitExceeded = true;
                proc.kill();
                return;
            }
            stderrChunks.push(chunk);
        });

        proc.on('error', (err: NodeJS.ErrnoException) => {
            // AbortError is emitted when the AbortController fires — the 'close'
            // event will follow and settle the promise with exitCode -1.
            if (err.name === 'AbortError') return;
            if (settled) return;
            settled = true;
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
            reject(err);
        });

        proc.on('close', (code: number | null) => {
            if (aborted) {
                settle({
                    exitCode: -1,
                    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                    stderr: `git process was aborted after ${options!.timeoutMs}ms timeout`,
                });
                return;
            }
            if (bufferLimitExceeded) {
                settle({
                    exitCode: -1,
                    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                    stderr: `git output exceeded buffer limit of ${maxBufferBytes} bytes; process terminated`,
                });
                return;
            }
            settle({
                exitCode: code ?? 1,
                stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                stderr: Buffer.concat(stderrChunks).toString('utf8'),
            });
        });
    });
}

/**
 * Runs a git command and returns trimmed stdout on success.
 *
 * Throws an `Error` when the process exits with a non-zero code. The error
 * message includes the exit code and the trimmed stderr output to aid
 * diagnosis.
 *
 * @param args - Git arguments.
 * @param cwd  - Working directory for the spawned process.
 */
export async function runGitOrThrow(args: string[], cwd?: string): Promise<string> {
    const result = await runGit(args, cwd);
    if (result.exitCode !== 0) {
        throw new Error(
            `git ${args[0] ?? '(unknown)'} failed (exit ${result.exitCode}):\n${result.stderr.trim()}`,
        );
    }
    return result.stdout.trim();
}

```
###  Path: `/src/git/git-clone.ts`

```ts
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

```
###  Path: `/src/git/git-credentials.ts`

```ts
/**
 * Utility functions for resolving and injecting credentials into git remote URLs.
 *
 * Only HTTPS URLs are supported. SSH URLs (`git@...`) are left unchanged because
 * SSH authentication is handled by the SSH agent or key — not by inline tokens.
 */

/**
 * Extracts the hostname from an HTTPS git URL.
 *
 * @param url - The remote URL to inspect (e.g. "https://github.com/org/repo.git").
 * @returns The hostname string (e.g. "github.com"), or `null` when the URL is
 *   not a valid HTTPS URL (SSH, malformed, or empty).
 */
export function extractHost(url: string): string | null {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return null;
        return parsed.hostname || null;
    } catch {
        return null;
    }
}

/**
 * Injects a token credential into an HTTPS URL as the userinfo component.
 *
 * If the credentials map contains an entry whose key matches the URL's hostname,
 * the token is inserted as `https://<token>@<host>/...`. If no matching entry
 * exists, or the URL is not HTTPS, the original URL is returned unchanged.
 *
 * The token is written as the username only (no password component) since
 * Personal Access Tokens are typically passed in the username field.
 *
 * **Security note:** Token injection is performed via WHATWG URL object property
 * assignment (`parsed.username = token`), NOT string concatenation. The URL
 * serialiser automatically percent-encodes special characters in the token (e.g.
 * `@`, `/`, `#`), preventing URL injection even with adversarially-crafted values.
 *
 * @param url         - The remote URL to modify.
 * @param credentials - Map of hostname → token (e.g. `{ "github.com": "ghp_abc" }`).
 * @returns The URL with credentials injected, or the original URL if no match.
 */
export function injectCredentials(url: string, credentials: Record<string, string>): string {
    const host = extractHost(url);
    if (host === null) return url;

    const token = credentials[host];
    if (!token) return url;

    try {
        const parsed = new URL(url);
        parsed.username = token;
        parsed.password = '';
        return parsed.toString();
    } catch {
        return url;
    }
}

/**
 * Returns `true` when the URL contains an embedded username (and optional password)
 * in the userinfo section (e.g. `https://token@github.com/...`).
 *
 * Always returns `false` for non-HTTPS or malformed URLs.
 *
 * @param url - The URL to inspect.
 */
export function hasEmbeddedCredentials(url: string): boolean {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return false;
        return parsed.username !== '';
    } catch {
        return false;
    }
}

/**
 * Redacts embedded HTTPS credentials from a URL or arbitrary string (e.g. a
 * git error message such as `"fatal: repository 'https://token@host/...' not found"`).
 *
 * Pure HTTPS URLs are sanitised via the WHATWG URL object (clean user/password
 * removal). All other inputs — non-HTTPS URLs, prose strings, and unparseable
 * values — fall through to a regex scrub that replaces any `https?://…@` pattern
 * with `https://***@`, preserving the host and path while redacting the token.
 *
 * @param input - The URL or string to sanitise.
 * @returns The sanitised string, or the original if no embedded credentials are
 *   found.
 */
export function stripEmbeddedCredentials(input: string): string {
    if (!input) return input;
    try {
        const parsed = new URL(input);
        if (parsed.protocol === 'https:') {
            parsed.username = '';
            parsed.password = '';
            return parsed.toString();
        }
        // Non-HTTPS valid URL (e.g. git:// or a prose string the WHATWG parser
        // accepted with a non-standard scheme like "fatal:") — fall through to
        // the regex scrub below to redact any embedded https credentials.
    } catch {
        // Not parseable as a URL — fall through to regex scrub.
    }
    // Scrub any embedded https credential patterns present in prose strings
    // (e.g. git error: "fatal: repository 'https://token@host/...' not found").
    return input.replace(/(https?:\/\/)[^@\s]*@/g, '$1***@');
}

```
###  Path: `/src/git/git-status.ts`

```ts
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

```
###  Path: `/src/git/git.types.ts`

```ts
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

```
---
**File Statistics**
- **Size**: 27.51 KB
- **Lines**: 755
File: `modules/git/architecture-core.md`
