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
const KNOWN_TOP_LEVEL_KEYS = new Set(['SchemaVersion', 'Id', 'Name', 'Url', 'Description', 'Settings']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
    [key: string]: unknown;
}

/** The synced field set: everything that participates in the hash, diff and import. */
export interface RepositoryInfoPayload {
    Id: string;
    Name: string;
    Description: string;
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

/**
 * Builds the synced payload for a repository: `Id`, `Name`, and `Description`
 * (`''` when the repository has none set).
 */
export function buildRepositoryInfoPayload(repo: Repository): RepositoryInfoPayload {
    return { Id: repo.Id, Name: repo.Name, Description: repo.Description ?? '' };
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
 * Hashes the synced payload (`Id`, `Name`, `Description` — `Url` excluded)
 * with SHA-256, so formatting-only edits to the file never register as a
 * data change and an `Url`-only difference never affects the sync state.
 */
export function hashRepositoryInfoPayload(payload: RepositoryInfoPayload): string {
    const json = JSON.stringify([payload.Id, payload.Name, payload.Description]);
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
 *   non-numeric `SchemaVersion`, or a missing/non-string `Id`/`Name`/`Description`.
 * - **unsupported-schema** — `SchemaVersion` exceeds
 *   {@link REPOSITORY_INFO_SCHEMA_VERSION} (written by a newer Paralizer).
 * - **ok** — `payload` (the synced fields) and `raw` (the full parsed
 *   record, for unknown-key preservation on rewrite) are both populated.
 *   `Url` is read but never validated: a missing or non-string `Url` does
 *   not make the file `invalid` (see the module-level `Url` note).
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

    return {
        status: 'ok',
        payload: { Id: id, Name: name, Description: description },
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
 * `informationalUrl` — never read back from `existingRaw`.
 *
 * @param payload          The synced fields to write (`Id`, `Name`, `Description`).
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

    const file: RepositoryInfoFile = {
        SchemaVersion: REPOSITORY_INFO_SCHEMA_VERSION,
        Id: payload.Id,
        Name: payload.Name,
        Url: informationalUrl,
        Description: payload.Description,
        Settings: settings,
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
 * sync hash (the README is generated, not data).
 */
export function renderRepositoryInfoReadme(): string {
    return [
        `# ${REPOSITORY_INFO_FOLDER_NAME}`,
        '',
        'This folder holds repository information for multi-repository workspaces, ' +
        'managed by the Paralizer tool.',
        '',
        `\`${REPOSITORY_INFO_FILE_NAME}\` is generated: its \`Name\`, \`Description\` and \`Url\` fields ` +
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
