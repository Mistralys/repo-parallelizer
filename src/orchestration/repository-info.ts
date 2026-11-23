import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
    isLexicallyContained,
    resolveRootRealPath,
    escapesRootViaRealpath,
} from '../utils/path-guard.js';
import { stripEmbeddedCredentials } from '../git/git-credentials.js';
import type { Repository } from '../models/repository/repository.types.js';
// Type-only: `repository-files.ts` imports `REPOSITORY_INFO_FOLDER_NAME` (a
// runtime value) from this module, so only a type-only import back is safe —
// it is erased at compile time and never creates a runtime circular import.
import type { RepositoryFileHashEntry } from './repository-files.js';

/**
 * Pure, filesystem-only module for the per-repository `.workspace/info.json`
 * sync file and its companion `README.md`: rendering, parsing, hashing,
 * diffing and sync-state evaluation. Mirrors `workspace-index.ts`'s
 * pure-module pattern — no manager or git access; callers (the sync
 * orchestrator in `repository-info-sync.ts`) resolve paths and drive git.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Folder name, relative to the managed main folder, holding the sync artefacts. */
export const REPOSITORY_INFO_FOLDER_NAME = '.workspace';

/** File name of the sync data file inside {@link REPOSITORY_INFO_FOLDER_NAME}. */
export const REPOSITORY_INFO_FILE_NAME = 'info.json';

/** File name of the generated explanatory README inside {@link REPOSITORY_INFO_FOLDER_NAME}. */
export const REPOSITORY_INFO_README_FILE_NAME = 'README.md';

/**
 * Current schema version written to every `info.json`. A file whose
 * `SchemaVersion` exceeds this value was written by a newer Paralizer and is
 * classified `unsupported-schema` by {@link readRepositoryInfoFile} rather
 * than risking a destructive downgrade-rewrite.
 */
export const REPOSITORY_INFO_SCHEMA_VERSION = 1;

/** Top-level keys this module knows about; anything else is preserved verbatim on rewrite. */
const KNOWN_TOP_LEVEL_KEYS = new Set(['SchemaVersion', 'Id', 'Name', 'Url', 'Description', 'Settings', 'Files']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Metadata persisted for a single file in `info.json`'s `Files` array — no
 * content and no `ContentHash` (content lives under `.workspace/files/`,
 * read and hashed by `repository-files.ts`; `info.json` only ever carries
 * the labelling metadata).
 */
export type RepositoryInfoFileMetadata = Pick<RepositoryInfoFileEntry, 'Path' | 'Label' | 'Description' | 'Executable' | 'ListInAgents'>;

/**
 * One file within `RepositoryInfoPayload.Files`. `ContentHash` is populated
 * in memory only, from `canonicalFilesForHash()` (`repository-files.ts`) —
 * it is never written to `info.json` (see {@link RepositoryInfoFileMetadata}).
 * A read directly from `info.json` (via {@link readRepositoryInfoFile}) has
 * no way to know the real content hash — it is set to `''` there, and it is
 * the caller's responsibility (joining with `readRepositoryFilesFolder()` /
 * `canonicalFilesForHash()`) to rebuild a fully-populated entry before
 * hashing a folder-side payload.
 */
export interface RepositoryInfoFileEntry {
    Path: string;
    Label: string;
    Description: string;
    Executable: boolean;
    ListInAgents: boolean;
    ContentHash: string;
}

/**
 * Persisted shape of `.workspace/info.json`. Carries an index signature
 * because an older Paralizer must preserve top-level keys written by a
 * newer one that it does not itself know about (see
 * {@link renderRepositoryInfoFile}).
 */
export interface RepositoryInfoFile {
    SchemaVersion: number;
    Id: string;
    Name: string;
    /** Informational only — never hashed, diffed or imported. See module docs. */
    Url?: string;
    Description: string;
    Settings: Record<string, unknown>;
    /** Per-file metadata, sorted by `Path`. Absent on an un-upgraded M1 file — treated the same as `[]`. */
    Files?: RepositoryInfoFileMetadata[];
    [key: string]: unknown;
}

/** The synced field set: everything that participates in the hash, diff and import. */
export interface RepositoryInfoPayload {
    Id: string;
    Name: string;
    Description: string;
    /** Optional (and treated as `[]` wherever read) so every pre-Milestone-2 payload literal stays valid. */
    Files?: RepositoryInfoFileEntry[];
}

/** Result of {@link readRepositoryInfoFile}. */
export interface RepositoryInfoReadResult {
    status: 'absent' | 'ok' | 'invalid' | 'unsupported-schema';
    /** Present when `status === 'ok'`. */
    payload?: RepositoryInfoPayload;
    /** Present when `status === 'ok'` — the full parsed record, for unknown-key preservation on rewrite. */
    raw?: RepositoryInfoFile;
    /** Present when `status === 'invalid'` — a human-readable diagnostic. */
    error?: string;
}

/**
 * Sync state returned by {@link evaluateRepositoryInfoSync}. `'disabled'` and
 * `'main-folder-unavailable'` are short-circuit states applied by the caller
 * (the sync orchestrator) before this module's evaluation ever runs.
 */
export type RepositoryInfoSyncState =
    | 'disabled'
    | 'main-folder-unavailable'
    | 'in-sync'
    | 'write-required'
    | 'incoming'
    | 'conflict'
    | 'invalid-file'
    | 'id-mismatch'
    | 'unsupported-schema';

/** Synced fields offered for import. A string-literal union, extendable when a future field is synced. */
export type RepositoryInfoImportField = 'Name' | 'Description';

/** A single differing field between the current repository data and the folder's incoming file, for the import dialog. */
export interface RepositoryInfoFieldDiff {
    field: RepositoryInfoImportField;
    current: string;
    incoming: string;
}

/** One field that differs between the local and folder sides of a `'changed'` {@link RepositoryFileDiff}. */
export interface RepositoryFileFieldChange {
    field: 'Label' | 'Description' | 'Executable' | 'ListInAgents' | 'Content';
    local: string | boolean;
    incoming: string | boolean;
}

/**
 * A single differing file between the local (Paralizer data) and folder
 * (incoming) file sets, for the import dialog. See {@link diffRepositoryFiles}.
 */
export interface RepositoryFileDiff {
    path: string;
    /**
     * `'incoming-only'` — present in the folder, not locally (a teammate
     * added it). `'local-only'` — present locally, not in the folder (a
     * teammate removed it, or it has not been pushed yet). `'changed'` —
     * present on both sides with at least one differing field.
     */
    kind: 'incoming-only' | 'local-only' | 'changed';
    /** Present only for `kind === 'changed'` — the specific fields that differ. */
    changes?: RepositoryFileFieldChange[];
    /**
     * Set when the folder-side file cannot be treated as a normal repository
     * file (binary, oversized, unreadable, or an invalid/reserved path
     * segment — see `readRepositoryFilesFolder()`'s `problem`). Never set for
     * `kind === 'local-only'`, since that data only ever comes from the
     * folder side. Joined onto the pure diff by the caller
     * (`RepositoryInfoSyncOrchestrator`), which is the only place that reads
     * the folder's actual files — this module stays filesystem-free.
     */
    problem?: string;
}

/** Every valid value for a single per-file decision in `applyImport()`'s `files` request. */
export type RepositoryFileImportAction = 'add' | 'discard' | 'keep' | 'delete' | 'overwrite';

/** A single per-file import decision in an `applyImport()` request. */
export interface RepositoryFileImportSelection {
    path: string;
    action: RepositoryFileImportAction;
}

/** The actions allowed for a diff of each kind — `applyImport()`'s action table. */
const ALLOWED_FILE_IMPORT_ACTIONS: Record<RepositoryFileDiff['kind'], readonly RepositoryFileImportAction[]> = {
    'incoming-only': ['add', 'discard'],
    'local-only': ['keep', 'delete'],
    changed: ['overwrite', 'keep'],
};

/**
 * The action a diff resolves to when its path is omitted from an
 * `applyImport()` request (or no selection is passed at all). Always the
 * side that keeps Paralizer's own data — `discard` for `incoming-only`,
 * `keep` otherwise — mirroring the existing "an omitted field keeps the
 * local value" rule for `fields`. It is also always the one safe action for
 * a `problem` diff (see {@link resolveFileImportAction}), so the two rules
 * share this single source of truth.
 */
export function defaultFileImportAction(kind: RepositoryFileDiff['kind']): RepositoryFileImportAction {
    return kind === 'incoming-only' ? 'discard' : 'keep';
}

/**
 * Resolves the action to apply for a single file diff, validating it against
 * `applyImport()`'s action table.
 *
 * @param diff      The file diff being resolved (see {@link diffRepositoryFiles}).
 * @param requested The caller's selection for this path, or `undefined` when
 *                  the path was omitted from the request — resolved to
 *                  {@link defaultFileImportAction}.
 * @throws {Error} `requested` is not one of the actions allowed for
 *   `diff.kind`, or `diff.problem` is set and the resolved action is not the
 *   one safe, non-destructive action for that kind (`discard` for
 *   `incoming-only`, `keep` for `changed`).
 */
export function resolveFileImportAction(
    diff: RepositoryFileDiff,
    requested: RepositoryFileImportAction | undefined,
): RepositoryFileImportAction {
    const action = requested ?? defaultFileImportAction(diff.kind);
    const allowed = ALLOWED_FILE_IMPORT_ACTIONS[diff.kind];

    if (!allowed.includes(action)) {
        throw new Error(
            `Unsupported import action "${action}" for file "${diff.path}" (kind "${diff.kind}"). ` +
            `Allowed actions: ${allowed.join(', ')}.`,
        );
    }

    const safeAction = defaultFileImportAction(diff.kind);
    if (diff.problem !== undefined && action !== safeAction) {
        throw new Error(
            `File "${diff.path}" cannot be imported as-is (${diff.problem}) — only "${safeAction}" is allowed.`,
        );
    }

    return action;
}

/** Parameters for {@link evaluateRepositoryInfoSync}. */
export interface EvaluateRepositoryInfoSyncParams {
    /** Hash of Paralizer's current data for this repository (see {@link hashRepositoryInfoPayload}). */
    dataHash: string;
    /** The folder's current read result (see {@link readRepositoryInfoFile}). */
    folder: RepositoryInfoReadResult;
    /** The hash recorded as of the last write/accept, or `undefined` when none has ever been recorded. */
    lastWrittenHash?: string;
    /** The repository's own ID, compared against the folder file's `Id` for mismatch detection. */
    repositoryId: string;
}

// ---------------------------------------------------------------------------
// Payload / hashing
// ---------------------------------------------------------------------------

/** Sorts a file-entry array by lowercased `Path`, independent of filesystem/iteration order (mirrors `canonicalFilesForHash()`'s own sort). Returns a new array; never mutates `files`. */
function sortFilesByPath<T extends { Path: string }>(files: readonly T[]): T[] {
    return [...files].sort((a, b) => {
        const left = a.Path.toLowerCase();
        const right = b.Path.toLowerCase();
        return left < right ? -1 : left > right ? 1 : 0;
    });
}

/**
 * Builds the synced payload for a repository: `Id`, `Name`, `Description`
 * (`''` when the repository has none set), and `Files` — converted from
 * `canonicalFilesForHash()`'s tuples (`repository-files.ts`) into
 * {@link RepositoryInfoFileEntry} objects and sorted by `Path`.
 *
 * @param repo  The repository to build the payload for.
 * @param files The repository's current files' canonical hash entries (see
 *              `canonicalFilesForHash()`), or `[]` for a repository with no
 *              files (the default — keeps every existing call site that
 *              predates Milestone 2 compiling and behaving identically).
 */
export function buildRepositoryInfoPayload(
    repo: Repository,
    files: readonly RepositoryFileHashEntry[] = [],
): RepositoryInfoPayload {
    const entries: RepositoryInfoFileEntry[] = files.map(([path, label, description, executable, listInAgents, contentHash]) => ({
        Path: path,
        Label: label,
        Description: description,
        Executable: executable,
        ListInAgents: listInAgents,
        ContentHash: contentHash,
    }));

    return {
        Id: repo.Id,
        Name: repo.Name,
        Description: repo.Description ?? '',
        Files: sortFilesByPath(entries),
    };
}

/**
 * Builds the informational `Url` value written to `info.json`: the
 * repository's registered URL with any embedded credential stripped. Never
 * hashed, diffed or imported — see the module-level `Url` note.
 */
export function buildInformationalUrl(repo: Repository): string {
    return stripEmbeddedCredentials(repo.Url);
}

/**
 * Hashes the synced payload (`Id`, `Name`, `Description`, `Files` — `Url`
 * excluded) with SHA-256, so formatting-only edits to the file never
 * register as a data change and an `Url`-only difference never affects the
 * sync state.
 *
 * **Compatibility rule:** when `payload.Files` is empty, the hash is
 * byte-identical to Milestone 1's — `sha256(JSON.stringify([Id, Name,
 * Description]))`, with no fourth element at all — so a repository that has
 * no files keeps its existing M1 baseline valid across the upgrade (no
 * spurious `conflict`). Only when `Files` is non-empty is a fourth element
 * appended: the `canonicalFilesForHash()`-shaped tuples (`[Path, Label,
 * Description, Executable, ListInAgents, ContentHash]`), sorted by `Path` so
 * the hash never depends on the order `Files` happened to be built in.
 */
export function hashRepositoryInfoPayload(payload: RepositoryInfoPayload): string {
    const files = payload.Files ?? [];
    const base: unknown[] = [payload.Id, payload.Name, payload.Description];
    if (files.length > 0) {
        const tuples = sortFilesByPath(files).map((f) => [f.Path, f.Label, f.Description, f.Executable, f.ListInAgents, f.ContentHash]);
        base.push(tuples);
    }
    const json = JSON.stringify(base);
    return crypto.createHash('sha256').update(json).digest('hex');
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function infoFolderPath(mainFolder: string): string {
    return path.join(mainFolder, REPOSITORY_INFO_FOLDER_NAME);
}

function infoFilePath(mainFolder: string): string {
    return path.join(infoFolderPath(mainFolder), REPOSITORY_INFO_FILE_NAME);
}

function readmeFilePath(mainFolder: string): string {
    return path.join(infoFolderPath(mainFolder), REPOSITORY_INFO_README_FILE_NAME);
}

/**
 * Reads and classifies `.workspace/info.json` under `mainFolder`.
 *
 * - **absent** — the file does not exist. Never an error; sync creates it.
 * - **invalid** — unparseable JSON, a non-object/array top level, a
 *   non-numeric `SchemaVersion`, a missing/non-string `Id`/`Name`/`Description`,
 *   or a malformed `Files` (not an array, or an entry missing a string
 *   `Path`/`Label`/`Description` or boolean `Executable`/`ListInAgents`).
 * - **unsupported-schema** — `SchemaVersion` exceeds
 *   {@link REPOSITORY_INFO_SCHEMA_VERSION} (written by a newer Paralizer).
 * - **ok** — `payload` (the synced fields) and `raw` (the full parsed
 *   record, for unknown-key preservation on rewrite) are both populated.
 *   `Url` is read but never validated: a missing or non-string `Url` does
 *   not make the file `invalid` (see the module-level `Url` note). An absent
 *   `Files` (an un-upgraded M1 file) is treated as `[]`. Every parsed entry's
 *   `ContentHash` is set to `''` — `info.json` never stores one; see
 *   {@link RepositoryInfoFileEntry}.
 *
 * @param mainFolder - Absolute path to the repository's managed main folder.
 */
export function readRepositoryInfoFile(mainFolder: string): RepositoryInfoReadResult {
    const filePath = infoFilePath(mainFolder);

    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return { status: 'absent' };
        }
        return { status: 'invalid', error: `Cannot read info.json: ${(err as Error).message}` };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        return { status: 'invalid', error: `info.json is not valid JSON: ${(err as Error).message}` };
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { status: 'invalid', error: 'info.json must be a JSON object.' };
    }

    const record = parsed as Record<string, unknown>;

    const schemaVersion = record['SchemaVersion'];
    if (typeof schemaVersion !== 'number') {
        return { status: 'invalid', error: 'info.json is missing a numeric "SchemaVersion" field.' };
    }
    if (schemaVersion > REPOSITORY_INFO_SCHEMA_VERSION) {
        return { status: 'unsupported-schema' };
    }

    const id = record['Id'];
    const name = record['Name'];
    const description = record['Description'];
    if (typeof id !== 'string' || typeof name !== 'string' || typeof description !== 'string') {
        return { status: 'invalid', error: 'info.json is missing a string "Id", "Name" or "Description" field.' };
    }

    const filesRaw = record['Files'];
    const files: RepositoryInfoFileEntry[] = [];
    if (filesRaw !== undefined) {
        if (!Array.isArray(filesRaw)) {
            return { status: 'invalid', error: 'info.json\'s "Files" field must be an array.' };
        }
        for (const entry of filesRaw) {
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
                return { status: 'invalid', error: 'info.json\'s "Files" entries must be objects.' };
            }
            const e = entry as Record<string, unknown>;
            if (
                typeof e['Path'] !== 'string' ||
                typeof e['Label'] !== 'string' ||
                typeof e['Description'] !== 'string' ||
                typeof e['Executable'] !== 'boolean' ||
                typeof e['ListInAgents'] !== 'boolean'
            ) {
                return {
                    status: 'invalid',
                    error: 'info.json\'s "Files" entries must have a string "Path"/"Label"/"Description" and a boolean "Executable"/"ListInAgents".',
                };
            }
            files.push({
                Path: e['Path'],
                Label: e['Label'],
                Description: e['Description'],
                Executable: e['Executable'],
                ListInAgents: e['ListInAgents'],
                ContentHash: '',
            });
        }
    }

    return {
        status: 'ok',
        payload: { Id: id, Name: name, Description: description, Files: files },
        raw: record as unknown as RepositoryInfoFile,
    };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/** Returns the top-level keys of `existingRaw` that this module does not itself manage, for preservation on rewrite. */
function extractUnknownTopLevelKeys(existingRaw?: RepositoryInfoFile): Record<string, unknown> {
    if (!existingRaw) return {};
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(existingRaw)) {
        if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
            result[key] = existingRaw[key];
        }
    }
    return result;
}

/**
 * Renders the content string for `.workspace/info.json`.
 *
 * `SchemaVersion` is always the current {@link REPOSITORY_INFO_SCHEMA_VERSION}.
 * Unknown top-level keys and an unrecognised (or absent) `Settings` value in
 * `existingRaw` are preserved verbatim, so an older Paralizer never strips
 * data written by a newer one. `Url` is always written from
 * `informationalUrl` — never read back from `existingRaw`. `Files` is always
 * rendered from `payload.Files`, sorted by `Path`, as exactly `Path`,
 * `Label`, `Description`, `Executable` and `ListInAgents` per entry — never
 * `ContentHash` or any content — and `[]` when `payload.Files` is empty;
 * `Files` is in {@link KNOWN_TOP_LEVEL_KEYS}, so it is never also duplicated
 * via `extractUnknownTopLevelKeys()`.
 *
 * @param payload          The synced fields to write (`Id`, `Name`, `Description`, `Files`).
 * @param informationalUrl The informational `Url` value (see {@link buildInformationalUrl}).
 * @param existingRaw      The previously parsed file, when one exists, for unknown-key preservation.
 */
export function renderRepositoryInfoFile(
    payload: RepositoryInfoPayload,
    informationalUrl: string,
    existingRaw?: RepositoryInfoFile,
): string {
    const existingSettings = existingRaw?.['Settings'];
    const settings: Record<string, unknown> =
        existingSettings !== null && typeof existingSettings === 'object' && !Array.isArray(existingSettings)
            ? (existingSettings as Record<string, unknown>)
            : {};

    const files: RepositoryInfoFileMetadata[] = sortFilesByPath(payload.Files ?? []).map((f) => ({
        Path: f.Path,
        Label: f.Label,
        Description: f.Description,
        Executable: f.Executable,
        ListInAgents: f.ListInAgents,
    }));

    const file: RepositoryInfoFile = {
        SchemaVersion: REPOSITORY_INFO_SCHEMA_VERSION,
        Id: payload.Id,
        Name: payload.Name,
        Url: informationalUrl,
        Description: payload.Description,
        Settings: settings,
        Files: files,
        ...extractUnknownTopLevelKeys(existingRaw),
    };

    return `${JSON.stringify(file, null, 4)}\n`;
}

/**
 * Renders the fixed, machine-independent text of `.workspace/README.md`.
 *
 * Contains no absolute path or install location — it points readers to the
 * `AGENTS.md` at the root of the surrounding workspace folder instead, which
 * carries the Paralizer CLI section. Deterministic: identical on every
 * machine, so it never causes cross-machine churn and never affects the
 * sync hash (the README is generated, not data). Includes a fixed `files/`
 * section (Milestone 2) describing the sibling `.workspace/files/` folder.
 */
export function renderRepositoryInfoReadme(): string {
    return [
        `# ${REPOSITORY_INFO_FOLDER_NAME}`,
        '',
        'This folder holds repository information for multi-repository workspaces, ' +
        'managed by the Paralizer tool.',
        '',
        `\`${REPOSITORY_INFO_FILE_NAME}\` is generated: its \`Name\`, \`Description\`, \`Url\` and \`Files\` fields ` +
        'are written by Paralizer from the data it holds. Manual edits are overwritten on the next ' +
        'sync unless made through Paralizer.',
        '',
        'Credentials and other machine-local settings are never stored here.',
        '',
        'Changes made in this folder are reviewed and committed by the repository owners, like any ' +
        'other change.',
        '',
        'To find Paralizer: see the `AGENTS.md` file at the root of the surrounding workspace folder ' +
        '— it carries a "Paralizer CLI" section describing where it is installed and how to use it.',
        '',
        '## files/',
        '',
        'The sibling `files/` folder holds small per-repository files — such as wrapper scripts — that ' +
        'Paralizer syncs through git, alongside this repository, for every teammate working on it.',
        '',
        'These files are delivered through git only: Paralizer never pushes or pulls them over any other ' +
        'channel. Commit and push them like any other change, and pull to pick up a teammate\'s addition.',
        '',
        'Every file under `files/` is maintained by Paralizer: a manual edit made directly in this folder ' +
        'is overwritten on the next sync unless made through Paralizer.',
        '',
        'A script under `files/` marked executable can be run directly, e.g. `sh .workspace/files/<name>.sh`, ' +
        'from the repository root.',
        '',
        `Each file's label, description and flags are listed in \`${REPOSITORY_INFO_FILE_NAME}\`'s \`Files\` array.`,
        '',
        '_This file is generated by Paralizer and overwritten on every sync._',
    ].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Sync-state evaluation
// ---------------------------------------------------------------------------

/**
 * Implements the sync decision table, driven by the hash only (so an `Url`-
 * only difference between the folder's file and Paralizer's data evaluates
 * as `in-sync`).
 *
 * | Folder file status | Condition | State |
 * |---|---|---|
 * | absent | — | `write-required` |
 * | invalid | — | `invalid-file` |
 * | unsupported-schema | — | `unsupported-schema` |
 * | ok | `Id` ≠ `repositoryId` | `id-mismatch` |
 * | ok | folderHash = dataHash | `in-sync` |
 * | ok | no baseline (`lastWrittenHash` unset) | `conflict` |
 * | ok | folder = baseline, data ≠ baseline | `write-required` (local edit) |
 * | ok | folder ≠ baseline, data = baseline | `incoming` |
 * | ok | folder ≠ baseline, data ≠ baseline | `conflict` |
 *
 * Recording the hash as a new baseline when an `in-sync` folder's hash
 * differs from a stale `lastWrittenHash` is the caller's responsibility —
 * this function only ever returns the state.
 *
 * `'disabled'` and `'main-folder-unavailable'` are never returned here: the
 * caller applies those as short-circuit states before ever calling this
 * function (sync disabled, or the main folder missing/unusable).
 */
export function evaluateRepositoryInfoSync(params: EvaluateRepositoryInfoSyncParams): RepositoryInfoSyncState {
    const { dataHash, folder, lastWrittenHash, repositoryId } = params;

    if (folder.status === 'absent') return 'write-required';
    if (folder.status === 'invalid') return 'invalid-file';
    if (folder.status === 'unsupported-schema') return 'unsupported-schema';

    // folder.status === 'ok'
    const payload = folder.payload as RepositoryInfoPayload;
    if (payload.Id !== repositoryId) return 'id-mismatch';

    const folderHash = hashRepositoryInfoPayload(payload);
    if (folderHash === dataHash) return 'in-sync';

    if (lastWrittenHash === undefined) return 'conflict';

    const folderMatchesBaseline = folderHash === lastWrittenHash;
    const dataMatchesBaseline = dataHash === lastWrittenHash;

    if (folderMatchesBaseline && !dataMatchesBaseline) return 'write-required';
    if (!folderMatchesBaseline && dataMatchesBaseline) return 'incoming';
    return 'conflict';
}

/**
 * Compares the current repository payload against an incoming (folder) one,
 * for the import dialog. Only `Name` and `Description` are compared — `Url`
 * is informational only and never offered for import.
 */
export function diffRepositoryInfo(
    current: RepositoryInfoPayload,
    incoming: RepositoryInfoPayload,
): RepositoryInfoFieldDiff[] {
    const diffs: RepositoryInfoFieldDiff[] = [];
    if (current.Name !== incoming.Name) {
        diffs.push({ field: 'Name', current: current.Name, incoming: incoming.Name });
    }
    if (current.Description !== incoming.Description) {
        diffs.push({ field: 'Description', current: current.Description, incoming: incoming.Description });
    }
    return diffs;
}

/**
 * Compares the local (Paralizer data) and folder (incoming) file sets, for
 * the import dialog.
 *
 * - A path present only in `folder` is reported `'incoming-only'` (a
 *   teammate added it).
 * - A path present only in `local` is reported `'local-only'` (a teammate
 *   removed it, or it has not been pushed/pulled yet).
 * - A path present on both sides with any differing field (`Label`,
 *   `Description`, `Executable`, `ListInAgents` or `ContentHash`, reported
 *   as `'Content'`) is reported `'changed'`, with every differing field
 *   listed in `changes`.
 * - A path present on both sides with every field equal produces no entry
 *   at all — in particular, since `ContentHash` is computed from
 *   `canonicalFilesForHash()`'s LF-normalised content, a CRLF-only
 *   difference never surfaces, and since `Executable` here is the metadata
 *   flag (not a raw filesystem mode bit), a file-mode-only difference never
 *   surfaces either.
 *
 * Paths are matched case-insensitively (mirroring `readRepositoryFilesFolder()`),
 * but `path` in the result is always the original-cased value from `folder`
 * when present, otherwise from `local`.
 *
 * @param local  The repository's current files (see {@link buildRepositoryInfoPayload}'s `Files`).
 * @param folder The folder's incoming files, built the same way from the folder's actual content.
 */
export function diffRepositoryFiles(
    local: readonly RepositoryInfoFileEntry[],
    folder: readonly RepositoryInfoFileEntry[],
): RepositoryFileDiff[] {
    const localByPath = new Map<string, RepositoryInfoFileEntry>();
    for (const entry of local) {
        localByPath.set(entry.Path.toLowerCase(), entry);
    }
    const folderByPath = new Map<string, RepositoryInfoFileEntry>();
    for (const entry of folder) {
        folderByPath.set(entry.Path.toLowerCase(), entry);
    }

    const diffs: RepositoryFileDiff[] = [];

    for (const [lowerPath, folderEntry] of folderByPath) {
        const localEntry = localByPath.get(lowerPath);
        if (localEntry === undefined) {
            diffs.push({ path: folderEntry.Path, kind: 'incoming-only' });
            continue;
        }

        const changes: RepositoryFileFieldChange[] = [];
        if (localEntry.Label !== folderEntry.Label) {
            changes.push({ field: 'Label', local: localEntry.Label, incoming: folderEntry.Label });
        }
        if (localEntry.Description !== folderEntry.Description) {
            changes.push({ field: 'Description', local: localEntry.Description, incoming: folderEntry.Description });
        }
        if (localEntry.Executable !== folderEntry.Executable) {
            changes.push({ field: 'Executable', local: localEntry.Executable, incoming: folderEntry.Executable });
        }
        if (localEntry.ListInAgents !== folderEntry.ListInAgents) {
            changes.push({ field: 'ListInAgents', local: localEntry.ListInAgents, incoming: folderEntry.ListInAgents });
        }
        if (localEntry.ContentHash !== folderEntry.ContentHash) {
            changes.push({ field: 'Content', local: localEntry.ContentHash, incoming: folderEntry.ContentHash });
        }

        if (changes.length > 0) {
            diffs.push({ path: folderEntry.Path, kind: 'changed', changes });
        }
    }

    for (const [lowerPath, localEntry] of localByPath) {
        if (!folderByPath.has(lowerPath)) {
            diffs.push({ path: localEntry.Path, kind: 'local-only' });
        }
    }

    return diffs;
}

// ---------------------------------------------------------------------------
// Write guard chain
// ---------------------------------------------------------------------------

/** Returns true when `targetPath` exists on disk as a plain file (not a directory). */
function isFileShaped(targetPath: string): boolean {
    try {
        return fs.statSync(targetPath).isFile();
    } catch {
        return false;
    }
}

/**
 * Shared guard-chain-and-write-only-if-changed implementation for
 * {@link writeRepositoryInfoFile} and {@link writeRepositoryInfoReadme}.
 *
 * Guard chain (root = `mainFolder`): lexical containment → realpath
 * symlink-escape → directory-shape check on the info folder (rejects a
 * `.workspace` name already occupied by a plain file, which would make
 * `mkdir` fail). A target that fails any guard is reported as not written,
 * never throws.
 */
function writeGuarded(mainFolder: string, targetPath: string, content: string): { written: boolean } {
    const resolvedMainFolder = path.resolve(mainFolder);
    const realMainFolder = resolveRootRealPath(mainFolder);
    const resolvedTarget = path.resolve(targetPath);

    if (!isLexicallyContained(resolvedTarget, resolvedMainFolder)) {
        return { written: false };
    }

    if (escapesRootViaRealpath(resolvedTarget, realMainFolder)) {
        return { written: false };
    }

    const folderPath = infoFolderPath(mainFolder);
    if (isFileShaped(folderPath)) {
        return { written: false };
    }

    fs.mkdirSync(folderPath, { recursive: true });

    let existing: string | null = null;
    if (fs.existsSync(targetPath)) {
        try {
            existing = fs.readFileSync(targetPath, 'utf8');
        } catch {
            // Unreadable existing file — treat conservatively as not writable
            // rather than risking clobbering something we cannot inspect.
            return { written: false };
        }
    }

    if (existing === content) {
        return { written: false };
    }

    fs.writeFileSync(targetPath, content, 'utf8');
    return { written: true };
}

/**
 * Writes `content` to `.workspace/info.json` under `mainFolder`, through the
 * guard chain described at {@link writeGuarded}, and only when the rendered
 * bytes differ from the existing file (so an unchanged second write leaves
 * the file's mtime untouched and `git status --porcelain` clean).
 *
 * @param mainFolder - Absolute path to the repository's managed main folder.
 * @param content    - The rendered file content (see {@link renderRepositoryInfoFile}).
 */
export function writeRepositoryInfoFile(mainFolder: string, content: string): { written: boolean } {
    return writeGuarded(mainFolder, infoFilePath(mainFolder), content);
}

/**
 * Writes the generated `.workspace/README.md` under `mainFolder`, through
 * the same guard chain and write-only-if-changed rule as
 * {@link writeRepositoryInfoFile}. The content is always
 * {@link renderRepositoryInfoReadme}'s fixed text — a hand-edited README is
 * silently overwritten on the next call where it differs.
 *
 * @param mainFolder - Absolute path to the repository's managed main folder.
 */
export function writeRepositoryInfoReadme(mainFolder: string): { written: boolean } {
    return writeGuarded(mainFolder, readmeFilePath(mainFolder), renderRepositoryInfoReadme());
}

/**
 * Returns the info folder's pathspec, suitable for scoping a git status,
 * staging or commit command to this module's files (e.g. `git status
 * --porcelain -- .workspace/`).
 */
export function infoFolderPathspec(): string {
    return `${REPOSITORY_INFO_FOLDER_NAME}/`;
}
