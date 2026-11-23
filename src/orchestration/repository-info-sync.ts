import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
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
import {
    stagePaths,
    getIndexModes,
    setIndexExecutable,
    getStagedPaths,
    commitStaged,
} from '../git/git-commit.js';
import { NotFoundError } from '../errors.js';
import { FETCH_TIMEOUT_MS, PUSH_TIMEOUT_MS } from './orchestration.types.js';
import { INFO_COMMIT_AUTHOR_NAME, INFO_COMMIT_AUTHOR_EMAIL } from '../config/config.constants.js';
import { resolveRemoteAuth } from './remote-auth.js';
import {
    REPOSITORY_INFO_FOLDER_NAME,
    REPOSITORY_INFO_FILE_NAME,
    REPOSITORY_INFO_README_FILE_NAME,
    buildRepositoryInfoPayload,
    buildInformationalUrl,
    hashRepositoryInfoPayload,
    readRepositoryInfoFile,
    renderRepositoryInfoFile,
    evaluateRepositoryInfoSync,
    diffRepositoryInfo,
    diffRepositoryFiles,
    resolveFileImportAction,
    writeRepositoryInfoFile,
    writeRepositoryInfoReadme,
    infoFolderPathspec,
    type RepositoryInfoPayload,
    type RepositoryInfoReadResult,
    type RepositoryInfoFileEntry,
    type RepositoryInfoSyncState,
    type RepositoryInfoFieldDiff,
    type RepositoryInfoImportField,
    type RepositoryFileDiff,
    type RepositoryFileImportAction,
    type RepositoryFileImportSelection,
} from './repository-info.js';
import {
    readRepositoryFilesFolder,
    writeRepositoryFiles,
    canonicalFilesForHash,
    REPOSITORY_FILES_FOLDER_NAME,
    type RepositoryFolderFile,
    type RepositoryFileMetadataEntry,
    type WriteRepositoryFilesResult,
} from './repository-files.js';
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
import { guardedFileTarget } from '../utils/path-guard.js';
import {
    repositoryFileRelativePath,
    validateRepositoryFileSet,
    type RepositoryFile,
} from '../models/repository/repository-file.js';
import type { RepositoryFileManager } from '../models/repository/repository-file.manager.js';
import type { HealthIssue, HealthReport } from './health.types.js';
import type { AppConfig } from '../config/config.types.js';
import type { RepositoryManager } from '../models/repository/repository.manager.js';
import type { ErrorLogManager } from '../error-log/error-log.manager.js';
import type { Repository, RepositoryInfoSyncSettings } from '../models/repository/repository.types.js';

// ---------------------------------------------------------------------------
// Files helpers — bridge RepositoryFileManager's data layer (model, real
// `Content`) and `repository-files.ts`'s folder layer (reader/writer/hash).
// ---------------------------------------------------------------------------

/** Converts a repository's stored files (`RepositoryFileManager.list()`) into the shape `canonicalFilesForHash()` expects. */
function toFolderFiles(files: readonly RepositoryFile[]): RepositoryFolderFile[] {
    return files.map((file) => ({
        path: repositoryFileRelativePath(file),
        content: file.Content,
        contentKind: 'text',
        metadata: {
            Label: file.Label,
            Description: file.Description,
            Executable: file.Executable,
            ListInAgents: file.ListInAgents,
        },
    }));
}

/** Builds the synced payload for `repo`'s own data, including its current files. */
function buildLocalPayload(repo: Repository, localFiles: readonly RepositoryFile[]): RepositoryInfoPayload {
    const hashEntries = canonicalFilesForHash(toFolderFiles(localFiles));
    return buildRepositoryInfoPayload(repo, hashEntries);
}

/**
 * Reads `.workspace/files/` under `mainFolder` (via `readRepositoryFilesFolder()`),
 * keyed by `payload`'s own `Files` metadata, and returns both the raw
 * per-file folder reads (content, metadata, `problem`) and
 * `canonicalFilesForHash()`'s hashed tuples converted into
 * {@link RepositoryInfoFileEntry} objects. The single read both
 * {@link withFolderFileHashesAndFiles} (which every sync-state evaluation
 * needs) and the import preview/apply flow (which also needs each file's raw
 * content and `problem`, to build the per-file diff and apply `add`/
 * `overwrite`) are built from.
 */
function readFolderFiles(
    mainFolder: string,
    payload: RepositoryInfoPayload,
): { folderFiles: RepositoryFolderFile[]; hashedEntries: RepositoryInfoFileEntry[] } {
    const metadata: RepositoryFileMetadataEntry[] = (payload.Files ?? []).map((f) => ({
        Path: f.Path,
        Label: f.Label,
        Description: f.Description,
        Executable: f.Executable,
        ListInAgents: f.ListInAgents,
    }));

    const { files: folderFiles } = readRepositoryFilesFolder(mainFolder, metadata);
    const hashEntries = canonicalFilesForHash(folderFiles);
    const hashedEntries: RepositoryInfoFileEntry[] = hashEntries.map(
        ([entryPath, label, description, executable, listInAgents, contentHash]) => ({
            Path: entryPath,
            Label: label,
            Description: description,
            Executable: executable,
            ListInAgents: listInAgents,
            ContentHash: contentHash,
        }),
    );

    return { folderFiles, hashedEntries };
}

/**
 * Reconstructs `raw`'s payload with real per-file content hashes (see
 * {@link readFolderFiles}), additionally returning the raw per-file folder
 * reads for callers (the import preview/apply flow) that need each file's
 * actual content and `problem` alongside the hashed payload.
 * `readRepositoryInfoFile()` alone can never populate `ContentHash` (it only
 * ever parses `info.json`, which never stores content) — this is what makes
 * the folder-side hash sensitive to an incoming file's actual content, not
 * just its metadata.
 *
 * A non-`'ok'` read (absent/invalid/unsupported-schema) is returned
 * unchanged, with no folder files — there is no payload to reconstruct.
 */
function withFolderFileHashesAndFiles(
    mainFolder: string,
    raw: RepositoryInfoReadResult,
): { read: RepositoryInfoReadResult; folderFiles: RepositoryFolderFile[] } {
    if (raw.status !== 'ok' || !raw.payload) {
        return { read: raw, folderFiles: [] };
    }

    const { folderFiles, hashedEntries } = readFolderFiles(mainFolder, raw.payload);
    return { read: { ...raw, payload: { ...raw.payload, Files: hashedEntries } }, folderFiles };
}

/** Convenience wrapper over {@link withFolderFileHashesAndFiles} for callers that only need the hashed payload. */
function withFolderFileHashes(mainFolder: string, raw: RepositoryInfoReadResult): RepositoryInfoReadResult {
    return withFolderFileHashesAndFiles(mainFolder, raw).read;
}

/**
 * Joins `diffRepositoryFiles()`'s pure diff against `folderFiles`' `problem`
 * data (see {@link RepositoryFileDiff.problem}), by case-insensitive path.
 * `local-only` entries never get a `problem` — that data only ever comes
 * from the folder side.
 */
function buildFileDiffs(
    local: readonly RepositoryInfoFileEntry[],
    folder: readonly RepositoryInfoFileEntry[],
    folderFiles: readonly RepositoryFolderFile[],
): RepositoryFileDiff[] {
    const problemsByPath = new Map<string, string>();
    for (const file of folderFiles) {
        if (file.problem !== undefined) {
            problemsByPath.set(file.path.toLowerCase(), file.problem);
        }
    }

    return diffRepositoryFiles(local, folder).map((diff) => {
        const problem = problemsByPath.get(diff.path.toLowerCase());
        return problem !== undefined ? { ...diff, problem } : diff;
    });
}

/** Splits a `.workspace/files/`-relative path (`repositoryFileRelativePath()`'s output) back into `Directory`/`FileName`. */
function splitFileRelativePath(relPath: string): { directory: string; fileName: string } {
    const slashIndex = relPath.lastIndexOf('/');
    return slashIndex === -1
        ? { directory: '', fileName: relPath }
        : { directory: relPath.slice(0, slashIndex), fileName: relPath.slice(slashIndex + 1) };
}

/**
 * Ties the pure `repository-info.ts` module and the git-backed
 * `repository-main-folder.ts` module together into the public operations the
 * GUI/REST layer drives: a synchronous, filesystem-only sync usable from the
 * existing artefact choke-point, plus the async settings/refresh/import/
 * commit-and-push/recreate operations, each serialised per repository via
 * {@link RepositoryInfoSyncOrchestrator.runLocked}.
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

/**
 * {@link RepositoryInfoSyncStatus}, extended with `filterFallback` for the
 * three methods that perform a clone or fetch of their own and may therefore
 * have fallen back to a full transfer (`saveSettings()` on enable, `refresh()`,
 * `recreateManagedClone()`). `filterFallback` is `true` only when that
 * clone/fetch fell back; it is omitted (not `false`) otherwise. Mirrors the
 * existing {@link CommitPushResult} precedent. Never present on
 * {@link RepositoryInfoSyncOrchestrator.getStatus}'s result, which performs no
 * clone or fetch of its own.
 */
export type RepositoryInfoSyncRemoteStatus = RepositoryInfoSyncStatus & { filterFallback?: boolean };

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
 * Maps `pendingChanges` (relative paths, as reported by `inspectMainFolder()`'s
 * `pendingChanges` / `getPathStatus()` scoped to `.workspace/`) onto the
 * change areas named in the default commit message, in a fixed order with no
 * duplicates: `info.json` for `.workspace/info.json`, `README` for
 * `.workspace/README.md`, and `files` for any path under
 * `.workspace/files/`. Any other pending path (there should be none, since
 * the pathspec is already scoped to `.workspace/`) is silently ignored —
 * this is a display helper, not a validator.
 *
 * @param pendingChanges The pending change paths to describe.
 */
export function describeInfoChangeAreas(pendingChanges: readonly string[]): string[] {
    const infoJsonPath = `${REPOSITORY_INFO_FOLDER_NAME}/${REPOSITORY_INFO_FILE_NAME}`;
    const readmePath = `${REPOSITORY_INFO_FOLDER_NAME}/${REPOSITORY_INFO_README_FILE_NAME}`;
    const filesPrefix = `${REPOSITORY_INFO_FOLDER_NAME}/${REPOSITORY_FILES_FOLDER_NAME}/`;

    const areas: string[] = [];
    if (pendingChanges.includes(infoJsonPath)) {
        areas.push('info.json');
    }
    if (pendingChanges.includes(readmePath)) {
        areas.push('README');
    }
    if (pendingChanges.some((p) => p.startsWith(filesPrefix))) {
        areas.push('files');
    }

    return areas;
}

/**
 * Builds the default commit message offered by the Commit & Push dialog,
 * well within `MAX_INFO_COMMIT_MESSAGE_LENGTH`. With no pending changes (or
 * none that map to a known area), the message is exactly M1's
 * `Update .workspace for "{repoId}" via Paralizer`; otherwise the areas
 * (see {@link describeInfoChangeAreas}) are appended in parentheses, e.g.
 * `Update .workspace for "{repoId}" via Paralizer (info.json, files)`.
 *
 * @param pendingChanges The pending change paths to describe, as reported by
 *                       the current sync status. Defaults to `[]`, which
 *                       keeps every pre-Milestone-2 call site compiling and
 *                       behaving identically.
 */
export function buildDefaultInfoCommitMessage(repositoryId: string, pendingChanges: readonly string[] = []): string {
    const base = `Update ${REPOSITORY_INFO_FOLDER_NAME} for "${repositoryId}" via Paralizer`;
    const areas = describeInfoChangeAreas(pendingChanges);
    return areas.length > 0 ? `${base} (${areas.join(', ')})` : base;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class RepositoryInfoSyncOrchestrator {
    /**
     * Per-repository async mutex: maps a repository ID to a promise that
     * resolves once every operation queued for it so far has settled (success
     * or failure). See {@link runLocked}.
     */
    private readonly locks = new Map<string, Promise<unknown>>();

    constructor(
        private readonly config: AppConfig,
        private readonly repositoryManager: RepositoryManager,
        private readonly repositoryFileManager: RepositoryFileManager,
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
     * Throws {@link SyncPreconditionError} when info sync is not enabled for
     * the repository; otherwise returns normally. A thin, reusable guard for
     * the mutation surfaces built on this orchestrator (REST routes, CLI
     * commands) that need the same precondition every async method here
     * already enforces for itself.
     *
     * @throws {NotFoundError} If no repository with this ID exists.
     * @throws {SyncPreconditionError} Info sync is not enabled.
     */
    assertSyncEnabled(repositoryId: string): void {
        const repo = this.getRepoOrThrow(repositoryId);
        if (!repo.InfoSync?.Enabled) {
            throw new SyncPreconditionError(`Info sync is not enabled for repository "${repositoryId}".`);
        }
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
     *
     * Public (formerly private `withRepositoryLock`) so the mutation surfaces
     * built on top of this orchestrator (REST routes, CLI commands) can
     * serialise their own multi-step operations (e.g. a file add followed by
     * a folder write) behind the same per-repository lock this orchestrator
     * itself uses.
     */
    runLocked<T>(repositoryId: string, fn: () => Promise<T>): Promise<T> {
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
     * usable), a files-folder health sweep (Milestone 2 — also only
     * meaningful when the folder is usable), and a credential-availability
     * check (meaningful regardless of folder usability, since it blocks every
     * async operation this orchestrator offers).
     *
     * @param mainFolder Absolute path to the repository's managed main
     *   folder — only read from when `usable` (never written to).
     */
    private buildHealthReport(
        repo: Repository,
        inspection: MainFolderInspection,
        usable: boolean,
        state: RepositoryInfoSyncState,
        mainFolder: string,
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

            issues.push(...this.buildFilesHealthIssues(repo, mainFolder));
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

    /**
     * Milestone 2 files-folder health sweep, called only when the main
     * folder is usable. Purely read-only (no write, including no dry-run
     * `mkdir`): every check is a `fs` read/stat, so calling this from
     * `getStatus()` on every poll never mutates the managed clone.
     *
     * - `info-sync-files-unsafe-entry` — a symlink or other non-regular
     *   entry sits under `files/` ({@link readRepositoryFilesFolder}'s
     *   `unsafeEntries`); it is never followed, read or deleted, so it stays
     *   reported until a human removes it.
     * - `info-sync-files-invalid-incoming` — a regular file under `files/`
     *   carries any {@link RepositoryFolderFile} `problem` (binary, oversized,
     *   unreadable, an invalid/reserved path segment, a metadata violation, or
     *   a case collision with another folder file); resolving it requires
     *   looking at the incoming change, hence `fixAction: 'import'`.
     * - `info-sync-files-write-skipped` — one of the repository's own files
     *   (`RepositoryFileManager.list()`) resolves to a write target that the
     *   shared guard chain ({@link guardedFileTarget}) refuses (a symlink
     *   escape, or a path segment already occupied by a plain file) — the
     *   same check `writeRepositoryFiles()` itself applies before writing,
     *   run here without writing so a refusal surfaces even outside a sync.
     */
    private buildFilesHealthIssues(repo: Repository, mainFolder: string): HealthIssue[] {
        const issues: HealthIssue[] = [];

        const localFiles = this.repositoryFileManager.list(repo.Id);
        const metadata: RepositoryFileMetadataEntry[] = localFiles.map((f) => ({
            Path: repositoryFileRelativePath(f),
            Label: f.Label,
            Description: f.Description,
            Executable: f.Executable,
            ListInAgents: f.ListInAgents,
        }));
        const { files: folderFiles, unsafeEntries } = readRepositoryFilesFolder(mainFolder, metadata);

        if (unsafeEntries.length > 0) {
            issues.push({
                type: 'info-sync-files-unsafe-entry',
                severity: 'warning',
                message: `${unsafeEntries.length} symlink or other non-regular entr${unsafeEntries.length === 1 ? 'y' : 'ies'} ` +
                    `found under the \`files/\` folder and left untouched: ${unsafeEntries.join(', ')}.`,
                fixAction: 'none',
                repositoryId: repo.Id,
            });
        }

        const invalidFiles = folderFiles.filter((f) => f.problem !== undefined);
        if (invalidFiles.length > 0) {
            issues.push({
                type: 'info-sync-files-invalid-incoming',
                severity: 'warning',
                message: `${invalidFiles.length} file(s) under the \`files/\` folder cannot be synced as-is: ` +
                    `${invalidFiles.map((f) => `${f.path} (${f.problem})`).join('; ')}.`,
                fixAction: 'import',
                repositoryId: repo.Id,
            });
        }

        const filesRoot = path.join(mainFolder, REPOSITORY_INFO_FOLDER_NAME, REPOSITORY_FILES_FOLDER_NAME);
        const skippedTargets = localFiles
            .map((f) => repositoryFileRelativePath(f))
            .filter((rel) => guardedFileTarget(filesRoot, rel) === null);
        if (skippedTargets.length > 0) {
            issues.push({
                type: 'info-sync-files-write-skipped',
                severity: 'warning',
                message: `${skippedTargets.length} file(s) could not be written under the \`files/\` folder because ` +
                    `the write target was refused: ${skippedTargets.join(', ')}.`,
                fixAction: 'none',
                repositoryId: repo.Id,
            });
        }

        return issues;
    }

    /**
     * Logs the write-pass outcome of a {@link writeRepositoryFiles} call: a
     * `warning` entry listing `result.skipped` (refused write targets and
     * untouched unsafe entries) when non-empty, and an `info` entry listing
     * `result.removed` (files deleted because they left the data set) when
     * non-empty. Does nothing when both lists are empty, or when no
     * `errorLogManager` was injected.
     *
     * Logging the write transition itself (rather than a health issue's
     * first appearance) needs no persisted "last seen" fingerprint and
     * naturally covers both a sync and an import write from the same choke
     * point.
     *
     * @param operation `'sync-files'` from {@link syncRepository}, `'import'`
     *   from {@link applyImport} — both call sites of this helper.
     */
    private logFilesWriteOutcome(
        repositoryId: string,
        result: WriteRepositoryFilesResult,
        operation: 'sync-files' | 'import',
    ): void {
        if (!this.errorLogManager) {
            return;
        }

        if (result.skipped.length > 0) {
            this.errorLogManager.append({
                Severity: 'warning',
                Source: 'workspace-info',
                Operation: operation,
                Context: { RepositoryId: repositoryId },
                Message: `${result.skipped.length} file(s) under the \`files/\` folder could not be written for ` +
                    `repository "${repositoryId}": ${result.skipped.join(', ')}.`,
            });
        }

        if (result.removed.length > 0) {
            this.errorLogManager.append({
                Severity: 'info',
                Source: 'workspace-info',
                Operation: operation,
                Context: { RepositoryId: repositoryId },
                Message: `${result.removed.length} file(s) removed from the \`files/\` folder for repository ` +
                    `"${repositoryId}": ${result.removed.join(', ')}.`,
            });
        }
    }

    // -------------------------------------------------------------------------
    // Synchronous, filesystem-only sync — safe to call from the artefact choke-point
    // -------------------------------------------------------------------------

    /**
     * Synchronous and filesystem-only: resolves the managed main folder,
     * short-circuits when sync is disabled or the folder is unavailable,
     * otherwise reads/hashes/evaluates and writes `.workspace/info.json`,
     * then the repository's files under `.workspace/files/` (Milestone 2),
     * each only when its content actually differs. Safe to call repeatedly
     * (a small file read, a files-folder read, and a hash per call when
     * nothing changed), which is what lets it run inside the existing
     * synchronous artefact choke-point (`WorkspaceArtifactsOrchestrator`,
     * WP-008) without making every regenerate caller async.
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

        const localFiles = this.repositoryFileManager.list(repositoryId);
        const dataPayload = buildLocalPayload(repo, localFiles);
        const dataHash = hashRepositoryInfoPayload(dataPayload);
        const folderRead = withFolderFileHashes(mainFolder, readRepositoryInfoFile(mainFolder));
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
            const filesWriteResult = writeRepositoryFiles(mainFolder, localFiles);
            this.logFilesWriteOutcome(repositoryId, filesWriteResult, 'sync-files');
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

        if (!repo.InfoSync?.Enabled) {
            return {
                enabled: false,
                mainFolder: null,
                state: 'disabled',
                pendingChanges: [],
                defaultCommitMessage: buildDefaultInfoCommitMessage(repositoryId),
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
            const localFiles = this.repositoryFileManager.list(repositoryId);
            const dataPayload = buildLocalPayload(repo, localFiles);
            const dataHash = hashRepositoryInfoPayload(dataPayload);
            const folderRead = withFolderFileHashes(mainFolder, readRepositoryInfoFile(mainFolder));
            state = evaluateRepositoryInfoSync({
                dataHash,
                folder: folderRead,
                lastWrittenHash: repo.InfoSync.LastWrittenHash,
                repositoryId,
            });
        }

        const health = this.buildHealthReport(repo, inspection, usable, state, mainFolder);

        return {
            enabled: true,
            mainFolder: { ...inspection, path: mainFolder },
            state,
            pendingChanges: inspection.pendingChanges,
            lastSyncedAt: repo.InfoSync.LastSyncedAt,
            defaultCommitMessage: buildDefaultInfoCommitMessage(repositoryId, inspection.pendingChanges),
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
    ): Promise<RepositoryInfoSyncRemoteStatus> {
        return this.runLocked(repositoryId, async () => {
            const repo = this.getRepoOrThrow(repositoryId);
            const currentlyEnabled = repo.InfoSync?.Enabled ?? false;
            let filterFallback = false;

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
            const status = await this.getStatus(repositoryId);
            return filterFallback ? { ...status, filterFallback: true } : status;
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
    async refresh(repositoryId: string): Promise<RepositoryInfoSyncRemoteStatus> {
        return this.runLocked(repositoryId, async () => {
            const repo = this.getRepoOrThrow(repositoryId);
            if (!repo.InfoSync?.Enabled) {
                throw new SyncPreconditionError(`Info sync is not enabled for repository "${repositoryId}".`);
            }
            let filterFallback = false;

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
                filterFallback = true;
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

            const status = await this.getStatus(repositoryId);
            return filterFallback ? { ...status, filterFallback: true } : status;
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
    ): Promise<{ state: RepositoryInfoSyncState; fields: RepositoryInfoFieldDiff[]; files: RepositoryFileDiff[] }> {
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

        const localFiles = this.repositoryFileManager.list(repositoryId);
        const dataPayload = buildLocalPayload(repo, localFiles);
        const dataHash = hashRepositoryInfoPayload(dataPayload);
        const { read: folderRead, folderFiles } = withFolderFileHashesAndFiles(mainFolder, readRepositoryInfoFile(mainFolder));
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
        const files = buildFileDiffs(dataPayload.Files ?? [], folderRead.payload!.Files ?? [], folderFiles);
        return { state, fields, files };
    }

    /**
     * Applies the selected fields and per-file actions from the incoming
     * file onto the repository's data, writes the merged result back
     * (write-only-if-changed) and records the hash. An empty/omitted
     * `fields` or `files` array is valid — it keeps every local value, still
     * rewrites the file from Paralizer's data, and resolves the state to
     * `in-sync`.
     *
     * Files are resolved per diff via `resolveFileImportAction()`
     * (`repository-info.ts`) — a path in `input.files` not omitted from the
     * request, or defaulted otherwise. `filesMutated` is `true` when at least
     * one resolved action is `'add'`, `'overwrite'` or `'delete'`; `'discard'`/
     * `'keep'` alone leave it `false`. Only when `filesMutated` is the
     * resulting file set validated via `validateRepositoryFileSet()` — before
     * any mutation (including the fields update below), so a rejected set
     * leaves nothing behind, and its normalised output is what gets applied
     * and written. A field-only import (`filesMutated` is `false`) therefore
     * never validates the untouched stored set — a legacy row that already
     * breaks a rule does not block an unrelated field import.
     *
     * Fields are applied through `RepositoryManager.update()`, which
     * enforces the description length limit, and runs after file validation
     * so a rejected file set never leaves a partial import (fields applied,
     * files not) behind. Files are then applied in one
     * `RepositoryFileManager.replaceAll()` call — only when `filesMutated` —
     * with `'add'` creating a new file from the incoming folder content,
     * `'overwrite'` replacing an existing file's content/metadata in place
     * (keeping its `Id`), `'delete'` removing a local-only file, and
     * `'discard'`/`'keep'` no-ops on Paralizer's own data (the discarded or
     * superseded file is removed from the managed clone by the merged write
     * below, exactly like M1's `write-required` delete pass, and the file
     * store is left unwritten). Any refused or removed `files/` write from
     * the merged write is logged via `logFilesWriteOutcome()`.
     *
     * Never touches `Url`, `CredentialId`, or the managed clone directly —
     * `Url` is informational only and is not an importable field.
     *
     * @throws {NotFoundError} If no repository with this ID exists.
     * @throws {SyncPreconditionError} Sync is not enabled, the main folder is
     *   unusable, or re-evaluating the state no longer requires an import
     *   (e.g. another request already resolved it).
     * @throws {Error} `input.files` names a path outside the current import
     *   diff, or requests an action `resolveFileImportAction()` rejects
     *   (unsupported for the diff's kind, or disallowed on a `problem` file).
     * @throws {Error} The resulting file set fails `validateRepositoryFileSet()`
     *   (the 64-file count cap, case-insensitive path uniqueness, or any
     *   per-file rule) when the import adds, overwrites or deletes a file —
     *   including when the offending file is an untouched, already-stored
     *   one; the message names it. Nothing is mutated.
     */
    async applyImport(
        repositoryId: string,
        input: { fields: RepositoryInfoImportField[]; files?: RepositoryFileImportSelection[] },
    ): Promise<RepositoryInfoSyncStatus> {
        return this.runLocked(repositoryId, async () => {
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
            // runLocked) may already have resolved it.
            const localFiles = this.repositoryFileManager.list(repositoryId);
            const dataPayload = buildLocalPayload(repo, localFiles);
            const dataHash = hashRepositoryInfoPayload(dataPayload);
            const { read: folderRead, folderFiles } = withFolderFileHashesAndFiles(mainFolder, readRepositoryInfoFile(mainFolder));
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
            const fields = input.fields;
            const selectedName = fields.includes('Name');
            const selectedDescription = fields.includes('Description');

            // Resolve and validate every file diff's action up front — before
            // the repository-fields mutation below — so a bad `files`
            // selection (an unknown path, or an action `resolveFileImportAction()`
            // rejects) never leaves a partial import behind (fields applied,
            // files not).
            const fileDiffs = buildFileDiffs(dataPayload.Files ?? [], incoming.Files ?? [], folderFiles);
            const diffPathsLower = new Set(fileDiffs.map((d) => d.path.toLowerCase()));
            const selectionByPath = new Map<string, RepositoryFileImportAction>();
            for (const selection of input.files ?? []) {
                if (!diffPathsLower.has(selection.path.toLowerCase())) {
                    throw new Error(
                        `Cannot apply import: file "${selection.path}" is not part of the current import diff.`,
                    );
                }
                selectionByPath.set(selection.path.toLowerCase(), selection.action);
            }

            const resolvedActions = fileDiffs.map((diff) => ({
                diff,
                action: resolveFileImportAction(diff, selectionByPath.get(diff.path.toLowerCase())),
            }));

            const folderFilesByPath = new Map<string, RepositoryFolderFile>();
            for (const file of folderFiles) {
                folderFilesByPath.set(file.path.toLowerCase(), file);
            }
            const localFilesByPath = new Map<string, RepositoryFile>();
            for (const file of localFiles) {
                localFilesByPath.set(repositoryFileRelativePath(file).toLowerCase(), file);
            }

            let resultFiles: RepositoryFile[] = [...localFiles];
            const now = new Date().toISOString();

            for (const { diff, action } of resolvedActions) {
                const lowerPath = diff.path.toLowerCase();

                if (action === 'add') {
                    const folderFile = folderFilesByPath.get(lowerPath)!;
                    const { directory, fileName } = splitFileRelativePath(diff.path);
                    resultFiles.push({
                        Id: randomUUID(),
                        Directory: directory,
                        FileName: fileName,
                        Label: folderFile.metadata.Label,
                        Description: folderFile.metadata.Description,
                        Content: folderFile.content,
                        Executable: folderFile.metadata.Executable,
                        ListInAgents: folderFile.metadata.ListInAgents,
                        DateModified: now,
                    });
                } else if (action === 'overwrite') {
                    const folderFile = folderFilesByPath.get(lowerPath)!;
                    const existing = localFilesByPath.get(lowerPath)!;
                    const index = resultFiles.findIndex((f) => f.Id === existing.Id);
                    resultFiles[index] = {
                        ...existing,
                        Label: folderFile.metadata.Label,
                        Description: folderFile.metadata.Description,
                        Content: folderFile.content,
                        Executable: folderFile.metadata.Executable,
                        ListInAgents: folderFile.metadata.ListInAgents,
                        DateModified: now,
                    };
                } else if (action === 'delete') {
                    const existing = localFilesByPath.get(lowerPath)!;
                    const index = resultFiles.findIndex((f) => f.Id === existing.Id);
                    if (index !== -1) {
                        resultFiles.splice(index, 1);
                    }
                }
                // 'discard' and 'keep' leave resultFiles untouched.
            }

            // `filesMutated` gates both the pre-check below and the
            // `replaceAll()` choke point further down, so the two always agree
            // on when the resulting set needs validating: an import that adds,
            // overwrites or deletes a file can introduce new/changed file data
            // and must be validated before anything is mutated; a field-only
            // import (every action `'keep'`/`'discard'`) leaves `resultFiles`
            // identical to the stored set and must not fail on a legacy row it
            // never touches.
            const filesMutated = resolvedActions.some(
                ({ action }) => action === 'add' || action === 'overwrite' || action === 'delete',
            );

            if (filesMutated) {
                // Validate and normalise before any mutation (including the
                // fields update below) — a validation failure here must leave
                // the repository's fields, file store, managed clone and
                // recorded hash all untouched.
                resultFiles = validateRepositoryFileSet(resultFiles);
            }

            let updatedRepo = repo;
            if (selectedName || selectedDescription) {
                updatedRepo = this.repositoryManager.update(repositoryId, {
                    name: selectedName ? incoming.Name : repo.Name,
                    description: selectedDescription ? incoming.Description : (repo.Description ?? ''),
                });
            }

            if (filesMutated) {
                this.repositoryFileManager.replaceAll(repositoryId, resultFiles);
            }

            const mergedPayload = buildLocalPayload(updatedRepo, resultFiles);
            const mergedHash = hashRepositoryInfoPayload(mergedPayload);
            const informationalUrl = buildInformationalUrl(updatedRepo);
            const content = renderRepositoryInfoFile(mergedPayload, informationalUrl, folderRead.raw);
            writeRepositoryInfoFile(mainFolder, content);
            const filesWriteResult = writeRepositoryFiles(mainFolder, resultFiles);
            this.logFilesWriteOutcome(repositoryId, filesWriteResult, 'import');
            writeRepositoryInfoReadme(mainFolder);
            this.repositoryManager.recordInfoSyncWrite(repositoryId, mergedHash);

            const fileActionsDescription = resolvedActions.length > 0
                ? resolvedActions.map(({ diff, action }) => `${action}: ${diff.path}`).join(', ')
                : '(none)';

            this.errorLogManager?.append({
                Severity: 'audit',
                Source: 'workspace-info',
                Operation: 'import',
                Context: { RepositoryId: repositoryId },
                Message: `Imported repository info field(s) [${fields.join(', ') || '(none — kept local values)'}] ` +
                    `and file action(s) [${fileActionsDescription}] for repository "${repositoryId}".`,
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
        return this.runLocked(repositoryId, async () => {
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

            const localFiles = this.repositoryFileManager.list(repositoryId);
            const dataPayload = buildLocalPayload(repo, localFiles);
            const dataHash = hashRepositoryInfoPayload(dataPayload);
            const folderRead = withFolderFileHashes(mainFolder, readRepositoryInfoFile(mainFolder));
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

            // The managed clone is Paralizer's alone — anything staged
            // outside its own info-sync artefacts is unexpected and should
            // abort rather than be silently committed.
            const infoFolderPrefix = `${REPOSITORY_INFO_FOLDER_NAME}/`;
            const stagedPaths = await getStagedPaths(mainFolder);
            const pathOutsideInfoFolder = stagedPaths.find(
                (p) => p !== REPOSITORY_INFO_FOLDER_NAME && !p.startsWith(infoFolderPrefix),
            );
            if (pathOutsideInfoFolder !== undefined) {
                throw new SyncPreconditionError(
                    `Cannot commit & push: a staged path lies outside "${REPOSITORY_INFO_FOLDER_NAME}/" ` +
                    `("${pathOutsideInfoFolder}").`,
                );
            }

            // Fix up the executable bit on the staged index for repository
            // files: `update-index --chmod` is the only cross-platform way
            // to commit it (see `setIndexExecutable()`'s docs) — a newly
            // staged file's index mode otherwise reflects the working tree's
            // actual file mode (or `core.filemode`'s default when that is
            // unreliable), not necessarily `RepositoryFile.Executable`.
            const filesPathspec = `${REPOSITORY_INFO_FOLDER_NAME}/${REPOSITORY_FILES_FOLDER_NAME}`;
            const indexModes = await getIndexModes(mainFolder, filesPathspec);
            const toMarkExecutable: string[] = [];
            const toClearExecutable: string[] = [];
            for (const file of localFiles) {
                const indexPath = `${filesPathspec}/${repositoryFileRelativePath(file)}`;
                const currentMode = indexModes.get(indexPath);
                if (currentMode === undefined) {
                    // Not staged — either unchanged since the last commit
                    // (already has the correct mode) or not yet written to
                    // the managed clone at all.
                    continue;
                }

                const isCurrentlyExecutable = currentMode === '100755';
                if (file.Executable && !isCurrentlyExecutable) {
                    toMarkExecutable.push(indexPath);
                } else if (!file.Executable && isCurrentlyExecutable) {
                    toClearExecutable.push(indexPath);
                }
            }

            for (const [paths, executable] of [[toMarkExecutable, true], [toClearExecutable, false]] as const) {
                const chmodResult = await setIndexExecutable(mainFolder, paths, executable);
                if (chmodResult.exitCode !== 0) {
                    throw new RemoteOperationError(
                        `Failed to set the executable bit for repository "${repositoryId}": ` +
                        stripEmbeddedCredentials(chmodResult.stderr.trim()),
                    );
                }
            }

            const trimmedMessage = options.message?.trim();
            const commitMessage = trimmedMessage && trimmedMessage.length > 0
                ? trimmedMessage
                : buildDefaultInfoCommitMessage(repositoryId, inspection.pendingChanges);

            const commitResult = await commitStaged(
                mainFolder,
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
    ): Promise<RepositoryInfoSyncRemoteStatus> {
        return this.runLocked(repositoryId, async () => {
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
            const status = await this.getStatus(repositoryId);
            return filterFallback ? { ...status, filterFallback: true } : status;
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
