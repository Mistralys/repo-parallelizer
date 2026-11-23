import { runGit } from './git-cli.js';
import type { GitResult, PathStatusEntry } from './git.types.js';

/**
 * Commit author identity passed to `commitPaths()`.
 *
 * Both fields are written as `-c user.name=<name>`/`-c user.email=<email>`
 * config overrides for the single `commit` invocation only — the
 * repository's persisted `user.name`/`user.email` config is never modified.
 */
export interface CommitIdentity {
    /** Author/committer display name. */
    name: string;
    /** Author/committer email address. */
    email: string;
}

/**
 * Returns a `GitResult` describing a rejected argument, in the same shape
 * used by `createBranch()`/`switchBranch()` in `git-branch.ts`.
 */
function invalidArgResult(message: string): GitResult {
    return { exitCode: 128, stdout: '', stderr: `fatal: ${message}` };
}

/**
 * Validates a commit-identity field (`name` or `email`): must be non-empty,
 * must not contain a newline (which would otherwise terminate the `-c`
 * config assignment early and let the remainder be interpreted as a
 * separate git argument), and must not start with `-` (flag-injection
 * guard).
 */
function isValidIdentityValue(value: string): boolean {
    if (!value) return false;
    if (value.includes('\n')) return false;
    if (value.startsWith('-')) return false;
    return true;
}

/**
 * Queries the working-tree status scoped to a single pathspec via
 * `git status --porcelain -- <pathspec>`.
 *
 * Unlike `getGitStatus()` in `git-status.ts` (which reports the whole
 * working tree), this only ever inspects files matched by `pathspec` —
 * intended for callers that manage a narrow, well-known set of files (e.g.
 * the `.workspace/info.json` sync artifact) and must not be influenced by
 * unrelated changes elsewhere in the repository.
 *
 * @param repoPath - Absolute path to the local repository.
 * @param pathspec - A git pathspec (e.g. a single file or directory path),
 *                   passed to git after a literal `--` separator so it is
 *                   never interpreted as a flag.
 * @returns The parsed status entries, or an empty array when the underlying
 *   git command fails (e.g. `repoPath` is not a git repository).
 */
export async function getPathStatus(repoPath: string, pathspec: string): Promise<PathStatusEntry[]> {
    const result = await runGit(['status', '--porcelain', '--', pathspec], repoPath);
    if (result.exitCode !== 0) {
        return [];
    }

    return result.stdout
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => ({
            code: line.slice(0, 2),
            path: line.slice(3),
        }));
}

/**
 * Stages all changes (additions, modifications, deletions) scoped to a
 * single pathspec via `git add -A -- <pathspec>`.
 *
 * @param repoPath - Absolute path to the local repository.
 * @param pathspec - A git pathspec, passed after a literal `--` separator.
 */
export function stagePaths(repoPath: string, pathspec: string): Promise<GitResult> {
    return runGit(['add', '-A', '--', pathspec], repoPath);
}

/**
 * Commits already-staged changes scoped to a single pathspec, using a
 * one-off author/committer identity.
 *
 * Runs `git -c user.name=<name> -c user.email=<email> commit -m <message> --
 * <pathspec>`. The identity is supplied purely as config overrides for this
 * single invocation and never written to the repository's persisted
 * `user.name`/`user.email` config.
 *
 * @param repoPath - Absolute path to the local repository.
 * @param pathspec - A git pathspec restricting the commit to matching paths,
 *                   passed after a literal `--` separator.
 * @param message  - The commit message. Rejected (without invoking git) when
 *                   empty or whitespace-only.
 * @param identity - The one-off author/committer identity. Rejected
 *                   (without invoking git) when either field is empty,
 *                   contains a newline, or starts with `-`.
 */
export function commitPaths(
    repoPath: string,
    pathspec: string,
    message: string,
    identity: CommitIdentity,
): Promise<GitResult> {
    if (!message || message.trim().length === 0) {
        return Promise.resolve(invalidArgResult('commit message must not be empty'));
    }

    if (!isValidIdentityValue(identity.name)) {
        return Promise.resolve(invalidArgResult(`invalid commit identity name: '${identity.name}'`));
    }

    if (!isValidIdentityValue(identity.email)) {
        return Promise.resolve(invalidArgResult(`invalid commit identity email: '${identity.email}'`));
    }

    return runGit(
        [
            '-c', `user.name=${identity.name}`,
            '-c', `user.email=${identity.email}`,
            'commit', '-m', message, '--', pathspec,
        ],
        repoPath,
    );
}

/**
 * Reads the staged (index) file mode for every path matching `pathspec`, via
 * `git ls-files -s -z -- <pathspec>` (Milestone 2 — the executable bit
 * fix-up `commitAndPush()` runs before committing).
 *
 * Each `ls-files -s` record is `<mode> <sha1> <stage>\t<path>`, NUL-separated
 * by `-z` so a path containing any character (including a newline) is parsed
 * unambiguously. `mode` is the raw octal string git reports (e.g. `100644`
 * or `100755`).
 *
 * @param repoPath - Absolute path to the local repository.
 * @param pathspec - A git pathspec, passed after a literal `--` separator.
 *                   A `pathspec` starting with `-` is rejected without
 *                   spawning git, resolving to an empty map (mirroring
 *                   `getPathStatus()`'s "empty on failure" contract, since
 *                   this function has no `GitResult` to report through).
 */
export async function getIndexModes(repoPath: string, pathspec: string): Promise<Map<string, string>> {
    const modes = new Map<string, string>();
    if (pathspec.startsWith('-')) {
        return modes;
    }

    const result = await runGit(['ls-files', '-s', '-z', '--', pathspec], repoPath);
    if (result.exitCode !== 0) {
        return modes;
    }

    for (const record of result.stdout.split('\0')) {
        if (record.length === 0) continue;
        const tabIndex = record.indexOf('\t');
        if (tabIndex === -1) continue;
        const mode = record.slice(0, tabIndex).split(' ')[0];
        const recordPath = record.slice(tabIndex + 1);
        if (mode) {
            modes.set(recordPath, mode);
        }
    }

    return modes;
}

/**
 * Sets or clears the POSIX executable bit on already-staged paths via
 * `git update-index --chmod=(+|-)x -- <paths...>`, an index-only change that
 * survives into the next commit of that index regardless of the working
 * tree's actual file mode or `core.filemode` — the only cross-platform way
 * to commit the executable bit (Milestone 2, decision 8).
 *
 * @param repoPath   - Absolute path to the local repository.
 * @param paths      - Paths to update, passed after a literal `--` separator.
 *                     Resolves with no-op success (`exitCode: 0`) when empty,
 *                     without spawning git.
 * @param executable - `true` to set the executable bit, `false` to clear it.
 * @returns A rejected (`exitCode: 128`, `fatal: ...`) result without
 *   spawning git when any path starts with `-` (flag-injection guard,
 *   mirroring `setSparseCheckout()` in `git-clone.ts`).
 */
export function setIndexExecutable(repoPath: string, paths: readonly string[], executable: boolean): Promise<GitResult> {
    if (paths.length === 0) {
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    }

    const invalidPath = paths.find((p) => p.startsWith('-'));
    if (invalidPath !== undefined) {
        return Promise.resolve(invalidArgResult(`path must not start with '-': '${invalidPath}'`));
    }

    const chmodFlag = executable ? '--chmod=+x' : '--chmod=-x';
    return runGit(['update-index', chmodFlag, '--', ...paths], repoPath);
}

/**
 * Lists every path currently staged in the index, via
 * `git diff --cached --name-only -z`. Used by `commitAndPush()` (Milestone 2)
 * to confirm nothing outside `.workspace/` is staged before committing the
 * index directly (see {@link commitStaged}).
 *
 * @param repoPath - Absolute path to the local repository.
 * @returns The staged paths, or an empty array when the underlying git
 *   command fails.
 */
export async function getStagedPaths(repoPath: string): Promise<string[]> {
    const result = await runGit(['diff', '--cached', '--name-only', '-z'], repoPath);
    if (result.exitCode !== 0) {
        return [];
    }

    return result.stdout.split('\0').filter((p) => p.length > 0);
}

/**
 * Commits whatever is currently staged, using a one-off author/committer
 * identity, with no pathspec — unlike {@link commitPaths}, which scopes the
 * commit to a pathspec but, by rebuilding the listed entries from the
 * working tree, discards an index-only `--chmod` change under
 * `core.filemode=false` (Milestone 2, decision 8). Committing the staged
 * index directly preserves it.
 *
 * Runs `git -c user.name=<name> -c user.email=<email> commit -m <message>`.
 * The identity is supplied purely as config overrides for this single
 * invocation and never written to the repository's persisted
 * `user.name`/`user.email` config.
 *
 * @param repoPath - Absolute path to the local repository.
 * @param message  - The commit message. Rejected (without invoking git) when
 *                   empty or whitespace-only.
 * @param identity - The one-off author/committer identity. Rejected
 *                   (without invoking git) when either field is empty,
 *                   contains a newline, or starts with `-`.
 */
export function commitStaged(
    repoPath: string,
    message: string,
    identity: CommitIdentity,
): Promise<GitResult> {
    if (!message || message.trim().length === 0) {
        return Promise.resolve(invalidArgResult('commit message must not be empty'));
    }

    if (!isValidIdentityValue(identity.name)) {
        return Promise.resolve(invalidArgResult(`invalid commit identity name: '${identity.name}'`));
    }

    if (!isValidIdentityValue(identity.email)) {
        return Promise.resolve(invalidArgResult(`invalid commit identity email: '${identity.email}'`));
    }

    return runGit(
        [
            '-c', `user.name=${identity.name}`,
            '-c', `user.email=${identity.email}`,
            'commit', '-m', message,
        ],
        repoPath,
    );
}
