import * as fs from 'node:fs';
import * as path from 'node:path';
import { cloneRepository, setSparseCheckout, FILTER_UNSUPPORTED_WARNING } from '../git/git-clone.js';
import { getCurrentBranch, getDefaultBranch, switchBranch, branchExists } from '../git/git-branch.js';
import { getRemoteUrl, remoteUrlsMatch, countAheadBehind } from '../git/git-remote.js';
import { getPathStatus } from '../git/git-commit.js';
import { stripEmbeddedCredentials } from '../git/git-credentials.js';
import { isLexicallyContained, resolveRootRealPath, escapesRootViaRealpath } from '../utils/path-guard.js';
import { infoFolderPathspec, REPOSITORY_INFO_FOLDER_NAME } from './repository-info.js';
import { CLONE_TIMEOUT_MS } from './orchestration.types.js';
import type { HealthIssue } from './health.types.js';
import type { AppConfig } from '../config/config.types.js';
import type { Repository } from '../models/repository/repository.types.js';

/**
 * Resolves and git-inspects the managed main folder — the Paralizer-managed
 * partial/sparse clone that is the *only* location Paralizer ever reads or
 * writes `.workspace/` from, kept separate from any clone the user already
 * has under `projectsFolder`. Creation, removal, and read-only inspection of
 * that clone all live here; the sync orchestrator (`repository-info-sync.ts`,
 * WP-007) drives these functions and the pure `repository-info.ts` module
 * together.
 */

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Directory name, relative to `AppConfig.storageFolder`, holding every managed main folder clone. */
export const MANAGED_MAIN_FOLDER_DIR = 'repositories';

/**
 * Returns the root directory under which every repository's managed main
 * folder clone lives: `{storageFolder}/repositories/`.
 */
export function getManagedMainFolderRoot(config: Pick<AppConfig, 'storageFolder'>): string {
    return path.join(config.storageFolder, MANAGED_MAIN_FOLDER_DIR);
}

/**
 * Resolves the managed main folder path for a single repository:
 * `{storageFolder}/repositories/{repoId}/`.
 *
 * Deliberately takes only `config` and `repoId` — there is no user-supplied
 * path or "mode" field anywhere in this sync feature (see
 * `RepositoryInfoSyncSettings` in `repository.types.ts`), so there is nothing
 * else this function could accept without silently growing a second,
 * unsanctioned way to point at a main folder.
 */
export function resolveMainFolderPath(config: Pick<AppConfig, 'storageFolder'>, repoId: string): string {
    return path.join(getManagedMainFolderRoot(config), repoId);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link createManagedClone} for a git failure that is not a
 * precondition violation (e.g. the remote is unreachable, authentication was
 * rejected). The message is always credential-stripped.
 */
export class MainFolderGitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MainFolderGitError';
    }
}

/**
 * Thrown by {@link createManagedClone} when the remote cannot support a
 * managed clone regardless of retrying (e.g. an empty repository with no
 * commits, or a default branch that does not resolve to any remote-tracking
 * ref). The message is always credential-stripped and phrased as an
 * actionable instruction ("push an initial commit first") rather than an
 * opaque low-level git error.
 */
export class MainFolderPreconditionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MainFolderPreconditionError';
    }
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

/**
 * Snapshot of the managed main folder's git state, as reported by
 * {@link inspectMainFolder}.
 */
export interface MainFolderInspection {
    /** Whether the folder exists on disk at all. */
    exists: boolean;
    /** Whether the folder is a git repository (has a `.git` entry). Always `false` when `exists` is `false`. */
    isGitRepository: boolean;
    /** The configured `origin` remote URL, credential-stripped. `null` when not a git repository. */
    remoteUrl: string | null;
    /** Whether `remoteUrl` matches the repository's registered URL (via {@link remoteUrlsMatch}). `false` when not a git repository. */
    remoteMatches: boolean;
    /** The currently checked-out branch, or `null` for detached HEAD or when not a git repository. */
    currentBranch: string | null;
    /** The repository's resolved default branch, or `null` when not a git repository. */
    defaultBranch: string | null;
    /** Commits `HEAD` is ahead of `refs/remotes/origin/<defaultBranch>`. `0` when not a git repository. */
    ahead: number;
    /** Commits `HEAD` is behind `refs/remotes/origin/<defaultBranch>`. `0` when not a git repository. */
    behind: number;
    /** Paths reported by `git status --porcelain`, scoped to the `.workspace/` info folder only. Empty when not a git repository. */
    pendingChanges: string[];
}

/** A `MainFolderInspection` for a folder that does not exist (or is not a git repository), shared by both short-circuit branches of {@link inspectMainFolder}. */
function emptyInspection(exists: boolean): MainFolderInspection {
    return {
        exists,
        isGitRepository: false,
        remoteUrl: null,
        remoteMatches: false,
        currentBranch: null,
        defaultBranch: null,
        ahead: 0,
        behind: 0,
        pendingChanges: [],
    };
}

/**
 * Git-inspects the managed main folder at `folder`.
 *
 * Skips git entirely (no sub-processes spawned) when the folder does not
 * exist, or exists but has no `.git` entry — both are ordinary states (sync
 * disabled, or a clone that failed/was never created), not errors.
 *
 * Otherwise runs the independent read-only git calls (`getRemoteUrl()`,
 * `getCurrentBranch()`, `getDefaultBranch()`, `getPathStatus()` scoped to the
 * info folder) in parallel, then computes `ahead`/`behind` against
 * `refs/remotes/origin/<defaultBranch>` once `defaultBranch` is known.
 *
 * @param folder  Absolute path to the managed main folder (see {@link resolveMainFolderPath}).
 * @param repoUrl The repository's registered URL, compared against the
 *                folder's configured `origin` via {@link remoteUrlsMatch}.
 */
export async function inspectMainFolder(folder: string, repoUrl: string): Promise<MainFolderInspection> {
    const exists = fs.existsSync(folder);
    if (!exists) {
        return emptyInspection(false);
    }

    const isGitRepository = fs.existsSync(path.join(folder, '.git'));
    if (!isGitRepository) {
        return emptyInspection(true);
    }

    const [rawRemoteUrl, currentBranch, defaultBranch, pendingEntries] = await Promise.all([
        getRemoteUrl(folder),
        getCurrentBranch(folder),
        getDefaultBranch(folder),
        getPathStatus(folder, infoFolderPathspec()),
    ]);

    const { ahead, behind } = await countAheadBehind(folder, defaultBranch);

    return {
        exists: true,
        isGitRepository: true,
        remoteUrl: rawRemoteUrl !== null ? stripEmbeddedCredentials(rawRemoteUrl) : null,
        remoteMatches: rawRemoteUrl !== null && remoteUrlsMatch(rawRemoteUrl, repoUrl),
        currentBranch,
        defaultBranch,
        ahead,
        behind,
        pendingChanges: pendingEntries.map((entry) => entry.path),
    };
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

/**
 * Derives main-folder-level health issues from an inspection: a missing
 * folder, a folder that is not a git repository, a configured remote that
 * does not match the repository's registered URL, and a checkout that is not
 * on the resolved default branch.
 *
 * Scoped to the main folder itself — sync-state issues (e.g. an incoming
 * change available for import) are derived from `evaluateRepositoryInfoSync()`
 * in `repository-info.ts` by the sync orchestrator (WP-007), not here.
 *
 * @param inspection The result of {@link inspectMainFolder}.
 */
export function deriveMainFolderIssues(inspection: MainFolderInspection): HealthIssue[] {
    const issues: HealthIssue[] = [];

    if (!inspection.exists) {
        issues.push({
            type: 'main-folder-missing',
            severity: 'warning',
            message: 'The managed main folder does not exist.',
            fixAction: 'recreate-main-folder',
        });
        return issues;
    }

    if (!inspection.isGitRepository) {
        issues.push({
            type: 'main-folder-not-git',
            severity: 'error',
            message: 'The managed main folder exists but is not a git repository.',
            fixAction: 'recreate-main-folder',
        });
        return issues;
    }

    if (!inspection.remoteMatches) {
        issues.push({
            type: 'main-folder-remote-mismatch',
            severity: 'error',
            message: 'The managed main folder\'s remote does not match the repository\'s registered URL.',
            fixAction: 'recreate-main-folder',
        });
    }

    if (inspection.defaultBranch !== null && inspection.currentBranch !== inspection.defaultBranch) {
        issues.push({
            type: 'main-folder-wrong-branch',
            severity: 'warning',
            message: `The managed main folder is checked out on "${inspection.currentBranch ?? '(detached HEAD)'}" instead of the default branch "${inspection.defaultBranch}".`,
            fixAction: 'recreate-main-folder',
        });
    }

    return issues;
}

/**
 * Whether the managed main folder is in a state the sync orchestrator can
 * read from and write to: it exists, is a git repository, and its remote
 * matches the repository's registered URL.
 *
 * Deliberately does **not** require being on the default branch — a wrong
 * branch is reported as a health issue (see {@link deriveMainFolderIssues})
 * but still permits a read-only sync evaluation; only `commitAndPush()`
 * (WP-007) refuses outright when off the default branch.
 */
export function isMainFolderUsable(inspection: MainFolderInspection): boolean {
    return inspection.exists && inspection.isGitRepository && inspection.remoteMatches;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** Result of a successful {@link createManagedClone} call. */
export interface CreateManagedCloneResult {
    /** Absolute path to the newly created managed main folder. */
    path: string;
    /** The repository's resolved default branch, now checked out. */
    defaultBranch: string;
    /** `true` when the server did not support partial-clone filtering and a full clone was used instead. */
    filterFallback: boolean;
}

/** Removes `destination` if it exists, swallowing any filesystem error — used to clean up a partially created clone before an error propagates. */
function removeIfExists(destination: string): void {
    try {
        if (fs.existsSync(destination)) {
            fs.rmSync(destination, { recursive: true, force: true });
        }
    } catch {
        // Best-effort cleanup only — the caller is already about to throw a
        // more specific error, and a cleanup failure here must not mask it.
    }
}

/**
 * Creates the managed main folder: a partial clone (`--filter=blob:none`)
 * with cone-mode sparse-checkout restricted to the `.workspace/` info
 * folder, checked out on the repository's default branch.
 *
 * Sequence: guard the destination (reject if something already exists there)
 * → `git clone --filter=blob:none --no-checkout` → `sparse-checkout set
 * --cone .workspace` → resolve the default branch → verify
 * `refs/remotes/origin/<default>` exists, throwing
 * {@link MainFolderPreconditionError} when it does not (empty remote, or a
 * default branch that resolves to nothing fetchable) → `checkout <default>`.
 *
 * A server that does not support partial-clone filtering does not fail the
 * clone: git itself silently falls back to a full clone and emits
 * {@link FILTER_UNSUPPORTED_WARNING} as a warning on stderr with `exitCode: 0`
 * — this function detects that warning and reports it via `filterFallback`
 * rather than retrying the clone without `--filter` itself (a retry would
 * duplicate work git already did).
 *
 * Any failure from the clone step onward removes the partially created
 * destination before the error propagates, so a failed call never leaves a
 * half-built clone on disk. The destination-already-exists guard runs before
 * anything is created, so it never deletes a pre-existing folder it did not
 * itself create.
 *
 * @param config  Supplies `storageFolder` (via {@link resolveMainFolderPath}).
 * @param repo    The repository whose managed main folder is being created.
 * @param authUrl The git-ready remote URL (with credential injected when
 *                required — see `resolveRemoteAuth()` in `remote-auth.ts`),
 *                set as `origin`'s URL so later lazy blob fetches succeed
 *                without re-authenticating. Consumed immediately; never
 *                itself returned or logged by this function.
 * @throws {MainFolderGitError} On any git failure other than an unresolvable
 *   default branch (e.g. an unreachable or rejected remote).
 * @throws {MainFolderPreconditionError} When the remote has no commits, or
 *   its resolved default branch does not exist as a remote-tracking ref.
 */
export async function createManagedClone(
    config: Pick<AppConfig, 'storageFolder'>,
    repo: Repository,
    authUrl: string,
): Promise<CreateManagedCloneResult> {
    const destination = resolveMainFolderPath(config, repo.Id);

    if (fs.existsSync(destination)) {
        throw new MainFolderGitError(
            `Cannot create managed main folder for repository "${repo.Id}": a file or folder already exists at "${destination}".`,
        );
    }

    const cloneResult = await cloneRepository(authUrl, destination, {
        filter: 'blob:none',
        noCheckout: true,
        timeoutMs: CLONE_TIMEOUT_MS,
    });

    if (cloneResult.exitCode !== 0) {
        removeIfExists(destination);
        throw new MainFolderGitError(
            `Failed to clone managed main folder for repository "${repo.Id}": ${stripEmbeddedCredentials(cloneResult.stderr.trim())}`,
        );
    }

    const filterFallback = cloneResult.stderr.includes(FILTER_UNSUPPORTED_WARNING);

    const sparseResult = await setSparseCheckout(destination, [REPOSITORY_INFO_FOLDER_NAME]);
    if (sparseResult.exitCode !== 0) {
        removeIfExists(destination);
        throw new MainFolderGitError(
            `Failed to configure sparse-checkout for repository "${repo.Id}": ${stripEmbeddedCredentials(sparseResult.stderr.trim())}`,
        );
    }

    const defaultBranch = await getDefaultBranch(destination);
    const defaultBranchExistsOnOrigin = await branchExists(destination, defaultBranch, 'origin');
    if (!defaultBranchExistsOnOrigin) {
        removeIfExists(destination);
        throw new MainFolderPreconditionError(
            `Repository "${repo.Id}" has no commits on a resolvable default branch ` +
            `("${defaultBranch}" does not exist on "origin"). Push an initial commit first.`,
        );
    }

    const checkoutResult = await switchBranch(destination, defaultBranch);
    if (checkoutResult.exitCode !== 0) {
        removeIfExists(destination);
        throw new MainFolderGitError(
            `Failed to check out default branch "${defaultBranch}" for repository "${repo.Id}": ${stripEmbeddedCredentials(checkoutResult.stderr.trim())}`,
        );
    }

    return { path: destination, defaultBranch, filterFallback };
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

/**
 * Removes the managed main folder for a repository, guarded by the same
 * two-layer check (strict-descendant lexical containment, then a realpath
 * symlink-escape check) as `removeRepositoryFromProject()` in
 * `repository-orchestrator.ts` — so a planted symlink at the destination's
 * leaf position cannot redirect the deletion outside the managed root.
 *
 * Refuses (returns `false` without touching the filesystem) rather than
 * throwing, since the only two failure modes here — a guard rejection or a
 * folder that was never created — are both ordinary "nothing to do" outcomes
 * for this boolean-returning API.
 *
 * @param config Supplies `storageFolder` (via {@link getManagedMainFolderRoot}).
 * @param repoId The repository whose managed main folder should be removed.
 * @returns `true` when the folder existed and was removed; `false` when the
 *   guard rejected the path or the folder did not exist.
 */
export function removeManagedClone(config: Pick<AppConfig, 'storageFolder'>, repoId: string): boolean {
    const managedRoot = getManagedMainFolderRoot(config);
    const destination = resolveMainFolderPath(config, repoId);

    const resolvedRoot = path.resolve(managedRoot);
    const realRoot = resolveRootRealPath(managedRoot);
    const resolvedDestination = path.resolve(destination);

    // Path-traversal guard, layer 1: strict-descendant lexical check.
    // Deliberately does NOT permit equality with resolvedRoot (unlike the
    // shared isLexicallyContained() helper's equality-permitting contract,
    // which suits a writer path but not this delete path) — mirrors
    // removeRepositoryFromProject()'s layer 1 check.
    if (!isLexicallyContained(resolvedDestination, resolvedRoot) || resolvedDestination === resolvedRoot) {
        return false;
    }

    // Path-traversal guard, layer 2: realpath symlink-escape check. Catches a
    // planted symlink (including a broken one) at the destination's leaf
    // position that resolves outside the managed root even though the
    // lexical check above passed.
    if (escapesRootViaRealpath(resolvedDestination, realRoot)) {
        return false;
    }

    if (!fs.existsSync(destination)) {
        return false;
    }

    fs.rmSync(destination, { recursive: true, force: true });
    return true;
}
