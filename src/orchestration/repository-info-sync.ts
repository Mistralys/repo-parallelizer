import * as fs from 'node:fs';
import * as path from 'node:path';
import { runGit } from '../git/git-cli.js';
import { stripEmbeddedCredentials } from '../git/git-credentials.js';
import { FILTER_UNSUPPORTED_WARNING } from '../git/git-clone.js';
import {
    setRemoteUrl,
    fetchBranch,
    pushHead,
    mergeFastForward,
    countAheadBehind,
    changedPathsBetween,
} from '../git/git-remote.js';
import { stagePaths, commitPaths } from '../git/git-commit.js';
import { NotFoundError } from '../errors.js';
import { FETCH_TIMEOUT_MS, PUSH_TIMEOUT_MS } from './orchestration.types.js';
import { INFO_COMMIT_AUTHOR_NAME, INFO_COMMIT_AUTHOR_EMAIL } from '../config/config.constants.js';
import { resolveRemoteAuth } from './remote-auth.js';
import {
    REPOSITORY_INFO_FOLDER_NAME,
    buildRepositoryInfoPayload,
    buildInformationalUrl,
    hashRepositoryInfoPayload,
    readRepositoryInfoFile,
    renderRepositoryInfoFile,
    evaluateRepositoryInfoSync,
    diffRepositoryInfo,
    writeRepositoryInfoFile,
    writeRepositoryInfoReadme,
    infoFolderPathspec,
    type RepositoryInfoSyncState,
    type RepositoryInfoFieldDiff,
    type RepositoryInfoImportField,
} from './repository-info.js';
import {
    resolveMainFolderPath,
    inspectMainFolder,
    createManagedClone,
    removeManagedClone,
    deriveMainFolderIssues,
    isMainFolderUsable,
    MainFolderPreconditionError,
    type MainFolderInspection,
} from './repository-main-folder.js';
import type { HealthIssue, HealthReport } from './health.types.js';
import type { AppConfig } from '../config/config.types.js';
import type { RepositoryManager } from '../models/repository/repository.manager.js';
import type { ErrorLogManager } from '../error-log/error-log.manager.js';
import type { Repository, RepositoryInfoSyncSettings } from '../models/repository/repository.types.js';

/**
 * Ties the pure `repository-info.ts` module and the git-backed
 * `repository-main-folder.ts` module together into the public operations the
 * GUI/REST layer drives: a synchronous, filesystem-only sync usable from the
 * existing artefact choke-point, plus the async settings/refresh/import/
 * commit-and-push/recreate operations, each serialised per repository via
 * {@link RepositoryInfoSyncOrchestrator.withRepositoryLock}.
 *
 * `syncRepository()` is the only method intended to run on every artefact
 * regeneration; every other method performs real git I/O and is only ever
 * invoked from an explicit user action (settings toggle, refresh button,
 * import dialog, commit & push, or a health-issue fix action).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a single {@link RepositoryInfoSyncOrchestrator.syncRepository} call. */
export interface RepositoryInfoSyncResult {
    state: RepositoryInfoSyncState;
    /** `true` when `.workspace/info.json` was actually (re)written to disk during this call. */
    written: boolean;
}

/** Status returned by {@link RepositoryInfoSyncOrchestrator.getStatus} and every mutating async method. */
export interface RepositoryInfoSyncStatus {
    enabled: boolean;
    /** `null` only when sync is disabled; otherwise always populated, even when the folder is missing/unusable. */
    mainFolder: (MainFolderInspection & { path: string }) | null;
    state: RepositoryInfoSyncState;
    pendingChanges: string[];
    lastSyncedAt?: string;
    defaultCommitMessage: string;
    health: HealthReport;
}

/** Input accepted by {@link RepositoryInfoSyncOrchestrator.saveSettings}. */
export interface RepositoryInfoSyncSettingsInput {
    enabled: boolean;
    discardPendingChanges?: boolean;
}

/** Result of {@link RepositoryInfoSyncOrchestrator.commitAndPush}. */
export interface CommitPushResult {
    committed: boolean;
    pushed: boolean;
    commitSha?: string;
    filterFallback?: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when an operation's precondition is not met (wrong state, wrong branch, nothing pending, etc). Message is credential-stripped. */
export class SyncPreconditionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SyncPreconditionError';
    }
}

/** Thrown when disabling sync or recreating the managed clone would discard pending changes, and the caller did not opt in via `discardPendingChanges`. */
export class PendingChangesError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PendingChangesError';
    }
}

/** Thrown for a remote git failure (clone/fetch/push/commit/merge). Message is always credential-stripped. */
export class RemoteOperationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RemoteOperationError';
    }
}

// ---------------------------------------------------------------------------
// Default commit message
// ---------------------------------------------------------------------------

/**
 * Builds the default commit message offered by the Commit & Push dialog,
 * well within `MAX_INFO_COMMIT_MESSAGE_LENGTH`.
 */
export function buildDefaultInfoCommitMessage(repositoryId: string): string {
    return `Update ${REPOSITORY_INFO_FOLDER_NAME} for "${repositoryId}" via Paralizer`;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class RepositoryInfoSyncOrchestrator {
    /**
     * Per-repository async mutex: maps a repository ID to a promise that
     * resolves once every operation queued for it so far has settled (success
     * or failure). See {@link withRepositoryLock}.
     */
    private readonly locks = new Map<string, Promise<unknown>>();

    constructor(
        private readonly config: AppConfig,
        private readonly repositoryManager: RepositoryManager,
        private readonly errorLogManager?: ErrorLogManager,
    ) {}

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private getRepoOrThrow(repositoryId: string): Repository {
        const repo = this.repositoryManager.getById(repositoryId);
        if (!repo) {
            throw new NotFoundError(`Repository with ID "${repositoryId}" does not exist.`);
        }
        return repo;
    }

    /**
     * Serialises every git-backed operation (`saveSettings`, `refresh`,
     * `applyImport`, `commitAndPush`, `recreateManagedClone`) on the same
     * repository, so two concurrent GUI requests can never run `git` commands
     * against the same working copy at once (which would otherwise race on
     * `.git/index.lock`).
     *
     * `fn` always runs after every previously queued operation for the same
     * `repositoryId` has settled, regardless of whether that prior operation
     * succeeded or failed. The map entry is removed once no further operation
     * is queued behind it, so the map does not grow unbounded over a long
     * server lifetime.
     */
    private withRepositoryLock<T>(repositoryId: string, fn: () => Promise<T>): Promise<T> {
        const prior = this.locks.get(repositoryId) ?? Promise.resolve();
        const result = prior.then(fn, fn);
        const bookkeeping = result.then(
            () => undefined,
            () => undefined,
        );
        this.locks.set(repositoryId, bookkeeping);
        void bookkeeping.finally(() => {
            if (this.locks.get(repositoryId) === bookkeeping) {
                this.locks.delete(repositoryId);
            }
        });
        return result;
    }

    /**
     * Builds the health report for `getStatus()`: remaps the main folder's
     * generic issue types onto the `info-sync-*` vocabulary this module owns,
     * adds sync-state-derived issues (only meaningful when the folder is
     * usable), and a credential-availability check (meaningful regardless of
     * folder usability, since it blocks every async operation this
     * orchestrator offers).
     */
    private buildHealthReport(
        repo: Repository,
        inspection: MainFolderInspection,
        usable: boolean,
        state: RepositoryInfoSyncState,
    ): HealthReport {
        const issues: HealthIssue[] = [];

        for (const issue of deriveMainFolderIssues(inspection)) {
            let type: string;
            switch (issue.type) {
                case 'main-folder-missing':
                case 'main-folder-not-git':
                    type = 'info-sync-main-folder-missing';
                    break;
                case 'main-folder-remote-mismatch':
                    type = 'info-sync-remote-mismatch';
                    break;
                case 'main-folder-wrong-branch':
                    type = 'info-sync-wrong-branch';
                    break;
                default:
                    type = issue.type;
            }
            issues.push({ ...issue, type, repositoryId: repo.Id });
        }

        if (usable) {
            if (inspection.behind > 0) {
                issues.push({
                    type: 'info-sync-behind-remote',
                    severity: 'warning',
                    message: `The managed main folder is ${inspection.behind} commit(s) behind the remote.`,
                    fixAction: 'refresh',
                    repositoryId: repo.Id,
                });
            }

            if (inspection.pendingChanges.length > 0) {
                issues.push({
                    type: 'info-sync-pending-changes',
                    severity: 'warning',
                    message: `The managed main folder has ${inspection.pendingChanges.length} pending change(s) to commit.`,
                    fixAction: 'commit-push',
                    repositoryId: repo.Id,
                });
            }

            if (state === 'incoming') {
                issues.push({
                    type: 'info-sync-import-available',
                    severity: 'warning',
                    message: 'An incoming change to the repository info is available to import.',
                    fixAction: 'import',
                    repositoryId: repo.Id,
                });
            } else if (state === 'conflict') {
                issues.push({
                    type: 'info-sync-conflict',
                    severity: 'warning',
                    message: 'The repository info file and Paralizer\'s data have both changed since the last sync.',
                    fixAction: 'import',
                    repositoryId: repo.Id,
                });
            } else if (state === 'invalid-file') {
                issues.push({
                    type: 'info-sync-invalid-file',
                    severity: 'error',
                    message: 'The repository info file is not valid and cannot be read.',
                    fixAction: 'none',
                    repositoryId: repo.Id,
                });
            } else if (state === 'id-mismatch') {
                issues.push({
                    type: 'info-sync-id-mismatch',
                    severity: 'error',
                    message: 'The repository info file belongs to a different repository ID.',
                    fixAction: 'none',
                    repositoryId: repo.Id,
                });
            } else if (state === 'unsupported-schema') {
                issues.push({
                    type: 'info-sync-unsupported-schema',
                    severity: 'warning',
                    message: 'The repository info file was written by a newer version of Paralizer.',
                    fixAction: 'none',
                    repositoryId: repo.Id,
                });
            }
        }

        const credentials = this.config.gitCredentials ?? [];
        const authResolution = resolveRemoteAuth(repo, credentials);
        if (!authResolution.ok) {
            issues.push({
                type: 'info-sync-credential-missing',
                severity: 'warning',
                message: authResolution.message,
                fixAction: 'configure-credential',
                repositoryId: repo.Id,
            });
        }

        return { healthy: issues.length === 0, issues };
    }

    // -------------------------------------------------------------------------
    // Synchronous, filesystem-only sync — safe to call from the artefact choke-point
    // -------------------------------------------------------------------------

    /**
     * Synchronous and filesystem-only: resolves the managed main folder,
     * short-circuits when sync is disabled or the folder is unavailable,
     * otherwise reads/hashes/evaluates and writes `.workspace/info.json` only
     * when its rendered bytes differ. Safe to call repeatedly and cheaply
     * (one small file read and a hash per call when nothing changed), which
     * is what lets it run inside the existing synchronous artefact
     * choke-point (`WorkspaceArtifactsOrchestrator`, WP-008) without making
     * every regenerate caller async.
     *
     * Never throws for an ordinary "nothing to do" outcome (disabled, no main
     * folder yet); only a genuinely unexpected failure (e.g. `NotFoundError`
     * for an unknown repository ID, or a filesystem error from `fs`) escapes.
     *
     * @param repositoryId The repository whose `.workspace/info.json` should be synced.
     */
    syncRepository(repositoryId: string): RepositoryInfoSyncResult {
        const repo = this.getRepoOrThrow(repositoryId);

        if (!repo.InfoSync?.Enabled) {
            return { state: 'disabled', written: false };
        }

        const mainFolder = resolveMainFolderPath(this.config, repositoryId);
        if (!fs.existsSync(path.join(mainFolder, '.git'))) {
            return { state: 'main-folder-unavailable', written: false };
        }

        const dataPayload = buildRepositoryInfoPayload(repo);
        const dataHash = hashRepositoryInfoPayload(dataPayload);
        const folderRead = readRepositoryInfoFile(mainFolder);
        const state = evaluateRepositoryInfoSync({
            dataHash,
            folder: folderRead,
            lastWrittenHash: repo.InfoSync.LastWrittenHash,
            repositoryId,
        });

        let written = false;

        if (state === 'write-required') {
            const informationalUrl = buildInformationalUrl(repo);
            const content = renderRepositoryInfoFile(dataPayload, informationalUrl, folderRead.raw);
            written = writeRepositoryInfoFile(mainFolder, content).written;
            this.repositoryManager.recordInfoSyncWrite(repositoryId, dataHash);
        } else if (state === 'in-sync' && repo.InfoSync.LastWrittenHash !== dataHash) {
            // Stale or missing baseline on an otherwise-matching file: record
            // the hash as the new baseline without writing anything.
            this.repositoryManager.recordInfoSyncWrite(repositoryId, dataHash);
        }

        // The README is generated, not data: write it whenever it differs,
        // independent of the decision table above, except in the states where
        // doing so would be premature or wrong (see repository-info.ts docs).
        const readmeExcludedStates: RepositoryInfoSyncState[] = [
            'disabled',
            'main-folder-unavailable',
            'id-mismatch',
            'incoming',
            'conflict',
        ];
        if (!readmeExcludedStates.includes(state)) {
            writeRepositoryInfoReadme(mainFolder);
        }

        return { state, written };
    }

    // -------------------------------------------------------------------------
    // Status (async, no network calls)
    // -------------------------------------------------------------------------

    /**
     * Combines `inspectMainFolder()`, the evaluated sync state and the
     * derived health report. Makes no network calls — `inspectMainFolder()`
     * reads local git state only (no fetch).
     *
     * @param repositoryId The repository to report status for.
     * @throws {NotFoundError} If no repository with this ID exists.
     */
    async getStatus(repositoryId: string): Promise<RepositoryInfoSyncStatus> {
        const repo = this.getRepoOrThrow(repositoryId);
        const defaultCommitMessage = buildDefaultInfoCommitMessage(repositoryId);

        if (!repo.InfoSync?.Enabled) {
            return {
                enabled: false,
                mainFolder: null,
                state: 'disabled',
                pendingChanges: [],
                defaultCommitMessage,
                health: { healthy: true, issues: [] },
            };
        }

        const mainFolder = resolveMainFolderPath(this.config, repositoryId);
        const inspection = await inspectMainFolder(mainFolder, repo.Url);
        const usable = isMainFolderUsable(inspection);

        let state: RepositoryInfoSyncState;
        if (!usable) {
            state = 'main-folder-unavailable';
        } else {
            const dataPayload = buildRepositoryInfoPayload(repo);
            const dataHash = hashRepositoryInfoPayload(dataPayload);
            const folderRead = readRepositoryInfoFile(mainFolder);
            state = evaluateRepositoryInfoSync({
                dataHash,
                folder: folderRead,
                lastWrittenHash: repo.InfoSync.LastWrittenHash,
                repositoryId,
            });
        }

        const health = this.buildHealthReport(repo, inspection, usable, state);

        return {
            enabled: true,
            mainFolder: { ...inspection, path: mainFolder },
            state,
            pendingChanges: inspection.pendingChanges,
            lastSyncedAt: repo.InfoSync.LastSyncedAt,
            defaultCommitMessage,
            health,
        };
    }

    // -------------------------------------------------------------------------
    // Settings (enable / disable)
    // -------------------------------------------------------------------------

    /**
     * Enables or disables info sync for a repository.
     *
     * **Disabling:** refuses with {@link PendingChangesError} when the
     * managed clone has pending changes, unless `input.discardPendingChanges`
     * is `true`; otherwise removes the managed clone and clears `InfoSync`
     * entirely (so `LastWrittenHash` never survives a disable/re-enable
     * cycle).
     *
     * **Enabling:** creates the managed clone (an async git clone) and
     * persists `{ Enabled: true }` with no hash — only after the clone
     * succeeds, so a failed enable leaves no `InfoSync` setting behind.
     *
     * Either way, `syncRepository()` runs before the status is returned.
     *
     * @throws {NotFoundError} If no repository with this ID exists.
     * @throws {PendingChangesError} Disabling with pending changes, not discarded.
     * @throws {RemoteOperationError} No credential resolves, or the clone fails.
     * @throws {SyncPreconditionError} The remote has no commits / no resolvable default branch.
     */
    async saveSettings(
        repositoryId: string,
        input: RepositoryInfoSyncSettingsInput,
    ): Promise<RepositoryInfoSyncStatus> {
        return this.withRepositoryLock(repositoryId, async () => {
            const repo = this.getRepoOrThrow(repositoryId);
            const currentlyEnabled = repo.InfoSync?.Enabled ?? false;

            if (!input.enabled) {
                if (currentlyEnabled) {
                    const mainFolder = resolveMainFolderPath(this.config, repositoryId);
                    const inspection = await inspectMainFolder(mainFolder, repo.Url);
                    if (inspection.pendingChanges.length > 0 && !input.discardPendingChanges) {
                        throw new PendingChangesError(
                            `Cannot disable info sync for repository "${repositoryId}": the managed main folder ` +
                            `has pending changes. Pass discardPendingChanges to proceed.`,
                        );
                    }

                    removeManagedClone(this.config, repositoryId);

                    this.errorLogManager?.append({
                        Severity: 'info',
                        Source: 'workspace-info',
                        Operation: 'remove-main-folder',
                        Context: { RepositoryId: repositoryId },
                        Message: `Info sync disabled for repository "${repositoryId}"; managed main folder removed.`,
                    });
                }

                this.repositoryManager.setInfoSyncSettings(repositoryId, null);
            } else if (!currentlyEnabled) {
                const credentials = this.config.gitCredentials ?? [];
                const authResolution = resolveRemoteAuth(repo, credentials);
                if (!authResolution.ok) {
                    throw new RemoteOperationError(authResolution.message);
                }

                let filterFallback = false;
                try {
                    const cloneResult = await createManagedClone(this.config, repo, authResolution.url);
                    filterFallback = cloneResult.filterFallback;
                } catch (err) {
                    if (err instanceof MainFolderPreconditionError) {
                        throw new SyncPreconditionError(err.message);
                    }
                    throw new RemoteOperationError(err instanceof Error ? err.message : String(err));
                }

                // Persist only after the clone succeeds, so a failed enable
                // leaves no InfoSync setting (and no partial clone) behind.
                this.repositoryManager.setInfoSyncSettings(repositoryId, { Enabled: true });

                if (filterFallback) {
                    this.errorLogManager?.append({
                        Severity: 'warning',
                        Source: 'workspace-info',
                        Operation: 'clone-main-folder',
                        Context: { RepositoryId: repositoryId },
                        Message: `Server does not support partial-clone filtering for repository ` +
                            `"${repositoryId}"; a full clone was used instead.`,
                    });
                }

                this.errorLogManager?.append({
                    Severity: 'info',
                    Source: 'workspace-info',
                    Operation: 'clone-main-folder',
                    Context: { RepositoryId: repositoryId },
                    Message: `Managed main folder created for repository "${repositoryId}".`,
                });
            }

            this.syncRepository(repositoryId);
            return this.getStatus(repositoryId);
        });
    }

    // -------------------------------------------------------------------------
    // Refresh
    // -------------------------------------------------------------------------

    /**
     * Re-points `origin` at the current authenticated URL, fetches the
     * default branch, fast-forwards when behind and nothing is pending, then
     * runs `syncRepository()`.
     *
     * @throws {NotFoundError} If no repository with this ID exists.
     * @throws {SyncPreconditionError} Sync is not enabled, or the main folder is unusable.
     * @throws {RemoteOperationError} No credential resolves, or the fetch/fast-forward fails.
     */
    async refresh(repositoryId: string): Promise<RepositoryInfoSyncStatus> {
        return this.withRepositoryLock(repositoryId, async () => {
            const repo = this.getRepoOrThrow(repositoryId);
            if (!repo.InfoSync?.Enabled) {
                throw new SyncPreconditionError(`Info sync is not enabled for repository "${repositoryId}".`);
            }

            const mainFolder = resolveMainFolderPath(this.config, repositoryId);
            const inspectionBefore = await inspectMainFolder(mainFolder, repo.Url);
            if (!isMainFolderUsable(inspectionBefore)) {
                throw new SyncPreconditionError(
                    `Cannot refresh: the managed main folder for repository "${repositoryId}" is unavailable.`,
                );
            }

            const credentials = this.config.gitCredentials ?? [];
            const authResolution = resolveRemoteAuth(repo, credentials);
            if (!authResolution.ok) {
                throw new RemoteOperationError(authResolution.message);
            }

            const setUrlResult = await setRemoteUrl(mainFolder, authResolution.url);
            if (setUrlResult.exitCode !== 0) {
                throw new RemoteOperationError(
                    `Failed to configure the remote for repository "${repositoryId}": ` +
                    stripEmbeddedCredentials(setUrlResult.stderr.trim()),
                );
            }

            const defaultBranch = inspectionBefore.defaultBranch!;
            const fetchResult = await fetchBranch(mainFolder, defaultBranch, {
                filter: 'blob:none',
                timeoutMs: FETCH_TIMEOUT_MS,
            });
            if (fetchResult.exitCode !== 0) {
                throw new RemoteOperationError(
                    `Failed to fetch for repository "${repositoryId}": ` +
                    stripEmbeddedCredentials(fetchResult.stderr.trim()),
                );
            }

            if (fetchResult.stderr.includes(FILTER_UNSUPPORTED_WARNING)) {
                this.errorLogManager?.append({
                    Severity: 'warning',
                    Source: 'workspace-info',
                    Operation: 'refresh',
                    Context: { RepositoryId: repositoryId },
                    Message: `Server does not support partial-clone filtering for repository ` +
                        `"${repositoryId}"; a full fetch was used instead.`,
                });
            }

            const inspectionAfterFetch = await inspectMainFolder(mainFolder, repo.Url);
            if (inspectionAfterFetch.behind > 0 && inspectionAfterFetch.pendingChanges.length === 0) {
                const mergeResult = await mergeFastForward(mainFolder, defaultBranch);
                if (mergeResult.exitCode !== 0) {
                    throw new RemoteOperationError(
                        `Failed to fast-forward repository "${repositoryId}": ` +
                        stripEmbeddedCredentials(mergeResult.stderr.trim()),
                    );
                }
            }

            this.syncRepository(repositoryId);

            this.errorLogManager?.append({
                Severity: 'info',
                Source: 'workspace-info',
                Operation: 'refresh',
                Context: { RepositoryId: repositoryId },
                Message: `Refreshed the managed main folder for repository "${repositoryId}".`,
            });

            return this.getStatus(repositoryId);
        });
    }

    // -------------------------------------------------------------------------
    // Import
    // -------------------------------------------------------------------------

    /**
     * Returns the per-field diff for the import dialog. Requires state
     * `incoming` or `conflict` (which, per `evaluateRepositoryInfoSync()`'s
     * decision table, already guarantees the file reads `ok` and its `Id`
     * matches `repositoryId` — both are implied preconditions, not re-checked
     * separately here).
     *
     * @throws {NotFoundError} If no repository with this ID exists.
     * @throws {SyncPreconditionError} Sync is not enabled, the main folder is
     *   unusable, or the state is not `incoming`/`conflict`.
     */
    async getImportPreview(
        repositoryId: string,
    ): Promise<{ state: RepositoryInfoSyncState; fields: RepositoryInfoFieldDiff[] }> {
        const repo = this.getRepoOrThrow(repositoryId);
        if (!repo.InfoSync?.Enabled) {
            throw new SyncPreconditionError(`Info sync is not enabled for repository "${repositoryId}".`);
        }

        const mainFolder = resolveMainFolderPath(this.config, repositoryId);
        const inspection = await inspectMainFolder(mainFolder, repo.Url);
        if (!isMainFolderUsable(inspection)) {
            throw new SyncPreconditionError(
                `Cannot preview import: the managed main folder for repository "${repositoryId}" is unavailable.`,
            );
        }

        const dataPayload = buildRepositoryInfoPayload(repo);
        const dataHash = hashRepositoryInfoPayload(dataPayload);
        const folderRead = readRepositoryInfoFile(mainFolder);
        const state = evaluateRepositoryInfoSync({
            dataHash,
            folder: folderRead,
            lastWrittenHash: repo.InfoSync.LastWrittenHash,
            repositoryId,
        });

        if (state !== 'incoming' && state !== 'conflict') {
            throw new SyncPreconditionError(
                `Cannot preview import: info sync state must be "incoming" or "conflict" (current: "${state}").`,
            );
        }

        const fields = diffRepositoryInfo(dataPayload, folderRead.payload!);
        return { state, fields };
    }

    /**
     * Applies the selected fields from the incoming file onto the
     * repository's data (through `RepositoryManager.update()`, which enforces
     * the description length limit), writes the merged result back (write-
     * only-if-changed) and records the hash. An empty `fields` array is
     * valid — it keeps every local value, still rewrites the file from
     * Paralizer's data, and resolves the state to `in-sync`.
     *
     * Never touches `Url`, `CredentialId`, or the managed clone — `Url` is
     * informational only and is not an importable field.
     *
     * @throws {NotFoundError} If no repository with this ID exists.
     * @throws {SyncPreconditionError} Sync is not enabled, the main folder is
     *   unusable, or re-evaluating the state no longer requires an import
     *   (e.g. another request already resolved it).
     */
    async applyImport(
        repositoryId: string,
        fields: RepositoryInfoImportField[],
    ): Promise<RepositoryInfoSyncStatus> {
        return this.withRepositoryLock(repositoryId, async () => {
            const repo = this.getRepoOrThrow(repositoryId);
            if (!repo.InfoSync?.Enabled) {
                throw new SyncPreconditionError(`Info sync is not enabled for repository "${repositoryId}".`);
            }

            const mainFolder = resolveMainFolderPath(this.config, repositoryId);
            const inspection = await inspectMainFolder(mainFolder, repo.Url);
            if (!isMainFolderUsable(inspection)) {
                throw new SyncPreconditionError(
                    `Cannot apply import: the managed main folder for repository "${repositoryId}" is unavailable.`,
                );
            }

            // Re-read and re-validate: the state must still call for an
            // import — a concurrent caller (serialised behind this one by
            // withRepositoryLock) may already have resolved it.
            const dataPayload = buildRepositoryInfoPayload(repo);
            const dataHash = hashRepositoryInfoPayload(dataPayload);
            const folderRead = readRepositoryInfoFile(mainFolder);
            const state = evaluateRepositoryInfoSync({
                dataHash,
                folder: folderRead,
                lastWrittenHash: repo.InfoSync.LastWrittenHash,
                repositoryId,
            });

            if (state !== 'incoming' && state !== 'conflict') {
                throw new SyncPreconditionError(
                    `Cannot apply import: info sync state must be "incoming" or "conflict" (current: "${state}").`,
                );
            }

            const incoming = folderRead.payload!;
            const selectedName = fields.includes('Name');
            const selectedDescription = fields.includes('Description');

            let updatedRepo = repo;
            if (selectedName || selectedDescription) {
                updatedRepo = this.repositoryManager.update(repositoryId, {
                    name: selectedName ? incoming.Name : repo.Name,
                    description: selectedDescription ? incoming.Description : (repo.Description ?? ''),
                });
            }

            const mergedPayload = buildRepositoryInfoPayload(updatedRepo);
            const mergedHash = hashRepositoryInfoPayload(mergedPayload);
            const informationalUrl = buildInformationalUrl(updatedRepo);
            const content = renderRepositoryInfoFile(mergedPayload, informationalUrl, folderRead.raw);
            writeRepositoryInfoFile(mainFolder, content);
            writeRepositoryInfoReadme(mainFolder);
            this.repositoryManager.recordInfoSyncWrite(repositoryId, mergedHash);

            this.errorLogManager?.append({
                Severity: 'audit',
                Source: 'workspace-info',
                Operation: 'import',
                Context: { RepositoryId: repositoryId },
                Message: `Imported repository info field(s) [${fields.join(', ') || '(none — kept local values)'}] ` +
                    `for repository "${repositoryId}".`,
            });

            return this.getStatus(repositoryId);
        });
    }

    // -------------------------------------------------------------------------
    // Commit & Push
    // -------------------------------------------------------------------------

    /**
     * Commits and pushes pending `.workspace/` changes in the managed main
     * folder.
     *
     * Refuses with {@link SyncPreconditionError} when the folder is
     * unavailable, the checkout is not on the default branch, the sync state
     * is `incoming`/`conflict`/`invalid-file`/`id-mismatch`/`unsupported-schema`,
     * or there is nothing pending. Otherwise re-points `origin`, fetches, and
     * — when behind — refuses if the upstream change touches the info folder
     * (import first) or fast-forwards. The commit is scoped to the info
     * folder via a pathspec and always carries the fixed Paralizer identity.
     * Every surfaced git error is credential-stripped; a push rejected for
     * lack of permission gets an explanatory hint appended.
     *
     * @throws {NotFoundError} If no repository with this ID exists.
     * @throws {SyncPreconditionError} A precondition above is not met.
     * @throws {RemoteOperationError} No credential resolves, or a git command fails.
     */
    async commitAndPush(
        repositoryId: string,
        options: { message?: string } = {},
    ): Promise<CommitPushResult> {
        return this.withRepositoryLock(repositoryId, async () => {
            const repo = this.getRepoOrThrow(repositoryId);
            if (!repo.InfoSync?.Enabled) {
                throw new SyncPreconditionError(`Info sync is not enabled for repository "${repositoryId}".`);
            }

            const mainFolder = resolveMainFolderPath(this.config, repositoryId);
            const inspection = await inspectMainFolder(mainFolder, repo.Url);

            if (!isMainFolderUsable(inspection)) {
                throw new SyncPreconditionError(
                    `Cannot commit & push: the managed main folder for repository "${repositoryId}" is unavailable.`,
                );
            }

            if (inspection.defaultBranch === null || inspection.currentBranch !== inspection.defaultBranch) {
                throw new SyncPreconditionError(
                    'Cannot commit & push: the managed main folder is not checked out on the default branch.',
                );
            }

            const dataPayload = buildRepositoryInfoPayload(repo);
            const dataHash = hashRepositoryInfoPayload(dataPayload);
            const folderRead = readRepositoryInfoFile(mainFolder);
            const state = evaluateRepositoryInfoSync({
                dataHash,
                folder: folderRead,
                lastWrittenHash: repo.InfoSync.LastWrittenHash,
                repositoryId,
            });

            const blockedStates: RepositoryInfoSyncState[] = [
                'incoming',
                'conflict',
                'invalid-file',
                'id-mismatch',
                'unsupported-schema',
            ];
            if (blockedStates.includes(state)) {
                throw new SyncPreconditionError(`Cannot commit & push: info sync state is "${state}".`);
            }

            if (inspection.pendingChanges.length === 0) {
                throw new SyncPreconditionError('Cannot commit & push: there are no pending changes to commit.');
            }

            const credentials = this.config.gitCredentials ?? [];
            const authResolution = resolveRemoteAuth(repo, credentials);
            if (!authResolution.ok) {
                throw new RemoteOperationError(authResolution.message);
            }

            const defaultBranch = inspection.defaultBranch;

            const setUrlResult = await setRemoteUrl(mainFolder, authResolution.url);
            if (setUrlResult.exitCode !== 0) {
                throw new RemoteOperationError(
                    `Failed to configure the remote for repository "${repositoryId}": ` +
                    stripEmbeddedCredentials(setUrlResult.stderr.trim()),
                );
            }

            const fetchResult = await fetchBranch(mainFolder, defaultBranch, {
                filter: 'blob:none',
                timeoutMs: FETCH_TIMEOUT_MS,
            });
            if (fetchResult.exitCode !== 0) {
                throw new RemoteOperationError(
                    `Failed to fetch for repository "${repositoryId}": ` +
                    stripEmbeddedCredentials(fetchResult.stderr.trim()),
                );
            }

            const filterFallback = fetchResult.stderr.includes(FILTER_UNSUPPORTED_WARNING);

            const aheadBehind = await countAheadBehind(mainFolder, defaultBranch);
            if (aheadBehind.behind > 0) {
                // changedPathsBetween() diffs the whole tree (it has no
                // pathspec parameter) — filter its result to the info folder
                // ourselves rather than relying on it to scope the diff.
                const changedPaths = await changedPathsBetween(
                    mainFolder,
                    'HEAD',
                    `refs/remotes/origin/${defaultBranch}`,
                );
                const infoPrefix = `${REPOSITORY_INFO_FOLDER_NAME}/`;
                const touchesInfoFolder = changedPaths.some(
                    (p) => p === REPOSITORY_INFO_FOLDER_NAME || p.startsWith(infoPrefix),
                );
                if (touchesInfoFolder) {
                    throw new SyncPreconditionError(
                        'Cannot commit & push: upstream changed the info folder. Import the incoming changes first.',
                    );
                }

                const mergeResult = await mergeFastForward(mainFolder, defaultBranch);
                if (mergeResult.exitCode !== 0) {
                    throw new RemoteOperationError(
                        `Failed to fast-forward repository "${repositoryId}": ` +
                        stripEmbeddedCredentials(mergeResult.stderr.trim()),
                    );
                }
            }

            const stageResult = await stagePaths(mainFolder, infoFolderPathspec());
            if (stageResult.exitCode !== 0) {
                throw new RemoteOperationError(
                    `Failed to stage changes for repository "${repositoryId}": ` +
                    stripEmbeddedCredentials(stageResult.stderr.trim()),
                );
            }

            const trimmedMessage = options.message?.trim();
            const commitMessage = trimmedMessage && trimmedMessage.length > 0
                ? trimmedMessage
                : buildDefaultInfoCommitMessage(repositoryId);

            const commitResult = await commitPaths(
                mainFolder,
                infoFolderPathspec(),
                commitMessage,
                { name: INFO_COMMIT_AUTHOR_NAME, email: INFO_COMMIT_AUTHOR_EMAIL },
            );
            if (commitResult.exitCode !== 0) {
                throw new RemoteOperationError(
                    `Failed to commit changes for repository "${repositoryId}": ` +
                    stripEmbeddedCredentials(commitResult.stderr.trim()),
                );
            }

            const commitShaResult = await runGit(['rev-parse', 'HEAD'], mainFolder);
            const commitSha = commitShaResult.exitCode === 0 ? commitShaResult.stdout.trim() : undefined;

            const pushResult = await pushHead(mainFolder, defaultBranch, PUSH_TIMEOUT_MS);
            if (pushResult.exitCode !== 0) {
                const strippedStderr = stripEmbeddedCredentials(pushResult.stderr.trim());
                const isPermissionDenied = /\b403\b|permission denied|denied\b/i.test(strippedStderr);
                const hint = isPermissionDenied
                    ? ' The configured credential may not have write access to this repository.'
                    : '';
                throw new RemoteOperationError(
                    `Failed to push changes for repository "${repositoryId}": ${strippedStderr}${hint}`,
                );
            }

            // Best-effort re-fetch to update the tracking ref; the push
            // already succeeded, so a failure here is logged, not thrown.
            const refetchResult = await fetchBranch(mainFolder, defaultBranch, {
                filter: 'blob:none',
                timeoutMs: FETCH_TIMEOUT_MS,
            });
            if (refetchResult.exitCode !== 0) {
                this.errorLogManager?.append({
                    Severity: 'warning',
                    Source: 'workspace-info',
                    Operation: 'commit-push',
                    Context: { RepositoryId: repositoryId },
                    Message: `Pushed successfully for repository "${repositoryId}" but the follow-up fetch failed: ` +
                        stripEmbeddedCredentials(refetchResult.stderr.trim()),
                });
            }

            this.errorLogManager?.append({
                Severity: 'audit',
                Source: 'workspace-info',
                Operation: 'commit-push',
                Context: { RepositoryId: repositoryId },
                Message: `Committed and pushed "${REPOSITORY_INFO_FOLDER_NAME}" changes for repository ` +
                    `"${repositoryId}"${commitSha ? ` (commit ${commitSha})` : ''}.`,
            });

            return { committed: true, pushed: true, commitSha, filterFallback };
        });
    }

    // -------------------------------------------------------------------------
    // Recreate / remove
    // -------------------------------------------------------------------------

    /**
     * Removes and re-clones the managed main folder. Refuses with
     * {@link PendingChangesError} when it has pending changes, unless
     * `discardPendingChanges` is `true`. Clears `LastWrittenHash` (the new
     * clone is a fresh, baseline-less folder, so a differing file routes
     * through the import dialog rather than being silently treated as
     * `in-sync` against a stale hash), preserving `LastSyncedAt` otherwise.
     *
     * @throws {NotFoundError} If no repository with this ID exists.
     * @throws {SyncPreconditionError} Sync is not enabled on this repository,
     *   or the remote has no commits / no resolvable default branch.
     * @throws {PendingChangesError} Pending changes exist and were not discarded.
     * @throws {RemoteOperationError} No credential resolves, or the clone fails.
     */
    async recreateManagedClone(
        repositoryId: string,
        options: { discardPendingChanges?: boolean } = {},
    ): Promise<RepositoryInfoSyncStatus> {
        return this.withRepositoryLock(repositoryId, async () => {
            const repo = this.getRepoOrThrow(repositoryId);
            if (!repo.InfoSync?.Enabled) {
                throw new SyncPreconditionError(`Info sync is not enabled for repository "${repositoryId}".`);
            }

            const mainFolder = resolveMainFolderPath(this.config, repositoryId);
            const inspection = await inspectMainFolder(mainFolder, repo.Url);
            if (inspection.pendingChanges.length > 0 && !options.discardPendingChanges) {
                throw new PendingChangesError(
                    `Cannot recreate the managed main folder for repository "${repositoryId}": it has pending ` +
                    'changes. Pass discardPendingChanges to proceed.',
                );
            }

            removeManagedClone(this.config, repositoryId);

            const preservedSettings: RepositoryInfoSyncSettings = { Enabled: true };
            if (repo.InfoSync.LastSyncedAt !== undefined) {
                preservedSettings.LastSyncedAt = repo.InfoSync.LastSyncedAt;
            }
            this.repositoryManager.setInfoSyncSettings(repositoryId, preservedSettings);

            const credentials = this.config.gitCredentials ?? [];
            const authResolution = resolveRemoteAuth(repo, credentials);
            if (!authResolution.ok) {
                throw new RemoteOperationError(authResolution.message);
            }

            let filterFallback = false;
            try {
                const cloneResult = await createManagedClone(this.config, repo, authResolution.url);
                filterFallback = cloneResult.filterFallback;
            } catch (err) {
                if (err instanceof MainFolderPreconditionError) {
                    throw new SyncPreconditionError(err.message);
                }
                throw new RemoteOperationError(err instanceof Error ? err.message : String(err));
            }

            if (filterFallback) {
                this.errorLogManager?.append({
                    Severity: 'warning',
                    Source: 'workspace-info',
                    Operation: 'clone-main-folder',
                    Context: { RepositoryId: repositoryId },
                    Message: `Server does not support partial-clone filtering for repository ` +
                        `"${repositoryId}"; a full clone was used instead.`,
                });
            }

            this.errorLogManager?.append({
                Severity: 'info',
                Source: 'workspace-info',
                Operation: 'clone-main-folder',
                Context: { RepositoryId: repositoryId },
                Message: `Managed main folder recreated for repository "${repositoryId}".`,
            });

            this.syncRepository(repositoryId);
            return this.getStatus(repositoryId);
        });
    }

    /**
     * Synchronously removes the managed main folder, with no settings
     * mutation and no git operations beyond the filesystem removal already
     * performed by `removeManagedClone()`. Used by the deletion cascade
     * (`RepositoryOrchestrator.deleteRepositoryGlobally()`, WP-010) after the
     * repository's data entry has already been removed, so there is no
     * `InfoSync` setting left to clear.
     */
    removeManagedFolder(repositoryId: string): void {
        removeManagedClone(this.config, repositoryId);
    }
}
