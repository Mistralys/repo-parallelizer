import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { guardedFileTarget, pruneEmptyParents } from '../utils/path-guard.js';
import { checkPathSegment, isExecutableFile, applyLineEndingPolicy } from '../models/file-definition.js';
import {
    REPOSITORY_FILE_MAX_CONTENT_BYTES,
    RESERVED_REPOSITORY_FILE_SEGMENTS,
    repositoryFileRelativePath,
    type RepositoryFile,
} from '../models/repository/repository-file.js';
import { REPOSITORY_INFO_FOLDER_NAME } from './repository-info.js';

/**
 * Reads and writes the managed clone's `.workspace/files/` folder — the
 * committed-to-git counterpart of `RepositoryFileManager`'s data layer
 * (Milestone 2). Mirrors `custom-files.ts`'s writer pattern (same guard chain
 * via `guardedFileTarget()`/`pruneEmptyParents()`), but diverges where the
 * two features differ: these files are committed, so the writer is
 * write-only-if-changed and deletes by set difference against the data set,
 * rather than unconditionally overwriting and tracking a single previous
 * definition.
 *
 * Pure filesystem module — no manager or git access. Callers (the sync
 * orchestrator) resolve `mainFolder` and drive git.
 */

/** Folder name, relative to `.workspace/`, holding repository files. */
export const REPOSITORY_FILES_FOLDER_NAME = 'files';

/** Fixed problem marker used when a regular file cannot be read at all. */
const PROBLEM_UNREADABLE = 'File could not be read.';

/** Metadata fields read from `info.json`'s `Files` entries, keyed by `Path` (case-insensitive). */
export interface RepositoryFileMetadataEntry {
    Path: string;
    Label: string;
    Description: string;
    Executable: boolean;
    ListInAgents: boolean;
}

/** The metadata half of a {@link RepositoryFolderFile} — same shape minus `Path`. */
export interface RepositoryFolderFileMetadata {
    Label: string;
    Description: string;
    Executable: boolean;
    ListInAgents: boolean;
}

/**
 * One regular file found under `.workspace/files/`, joined with its `info.json`
 * metadata (or defaults, when unlisted).
 */
export interface RepositoryFolderFile {
    /** Path relative to `.workspace/files/`, `/`-separated. */
    path: string;

    /**
     * The file's content. UTF-8 decoded text when `problem` is unset. When
     * `problem` is set (and is not the unreadable marker), this holds the raw
     * bytes decoded as latin1 — a lossless, 1-byte-per-character encoding —
     * so {@link canonicalFilesForHash} can reconstruct the exact original
     * bytes for hashing. Empty when the file could not be read at all.
     */
    content: string;

    metadata: RepositoryFolderFileMetadata;

    /** Human-readable reason the file cannot be treated as a normal repository file, if any. */
    problem?: string;
}

/** Result of {@link readRepositoryFilesFolder}. */
export interface ReadRepositoryFilesFolderResult {
    /** Every regular file found, with or without a `problem`. */
    files: RepositoryFolderFile[];
    /** Paths (relative, `/`-separated) of symlinks and any other non-regular entry found under `files/`. */
    unsafeEntries: string[];
}

/** One row of {@link canonicalFilesForHash}'s output. */
export type RepositoryFileHashEntry = [
    path: string,
    label: string,
    description: string,
    executable: boolean,
    listInAgents: boolean,
    contentHash: string,
];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function filesFolderPath(mainFolder: string): string {
    return path.join(mainFolder, REPOSITORY_INFO_FOLDER_NAME, REPOSITORY_FILES_FOLDER_NAME);
}

// ---------------------------------------------------------------------------
// Folder walk (shared by the reader and the writer's delete pass)
// ---------------------------------------------------------------------------

interface FolderWalkResult {
    /** Relative, `/`-separated paths of every regular file found. */
    regularFiles: string[];
    /** Relative, `/`-separated paths of every symlink or other non-regular entry found. */
    unsafeEntries: string[];
}

/**
 * Walks `root` recursively without ever following a symlink: a directory
 * entry that is itself a symlink is reported in `unsafeEntries` and never
 * descended into, whether it points to a file or a directory. Any entry that
 * is neither a regular file, a directory, nor a symlink (a FIFO, socket, or
 * device file) is also reported in `unsafeEntries`. Returns empty results
 * when `root` does not exist.
 */
function walkFilesFolder(root: string): FolderWalkResult {
    const regularFiles: string[] = [];
    const unsafeEntries: string[] = [];

    function walk(dir: string, relPrefix: string): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`;

            if (entry.isSymbolicLink()) {
                unsafeEntries.push(rel);
                continue;
            }
            if (entry.isDirectory()) {
                walk(path.join(dir, entry.name), rel);
                continue;
            }
            if (entry.isFile()) {
                regularFiles.push(rel);
                continue;
            }
            unsafeEntries.push(rel);
        }
    }

    if (fs.existsSync(root)) {
        walk(root, '');
    }
    return { regularFiles, unsafeEntries };
}

/**
 * Checks every `/`-separated segment of `relPath` against the shared
 * path-segment safety rules and the reserved `.git` segment (any depth,
 * case-insensitive). Returns the first problem message found, or `undefined`
 * when every segment is safe.
 */
function pathProblem(relPath: string): string | undefined {
    for (const segment of relPath.split('/')) {
        const problem = checkPathSegment(segment, 'Path');
        if (problem) return problem;
        if (RESERVED_REPOSITORY_FILE_SEGMENTS.some((reserved) => reserved.toLowerCase() === segment.toLowerCase())) {
            return `"${segment}" is a reserved path segment and cannot be used inside the \`.workspace/files/\` folder.`;
        }
    }
    return undefined;
}

function defaultMetadataFor(
    fileName: string,
    content: string,
    meta: RepositoryFileMetadataEntry | undefined,
): RepositoryFolderFileMetadata {
    if (meta) {
        return { Label: meta.Label, Description: meta.Description, Executable: meta.Executable, ListInAgents: meta.ListInAgents };
    }
    return { Label: fileName, Description: '', Executable: isExecutableFile(fileName, content), ListInAgents: false };
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Reads every regular file under `<mainFolder>/.workspace/files/`, joined
 * with `metadata` (typically `info.json`'s `Files` array) by case-insensitive
 * path.
 *
 * - A file on disk without a matching metadata entry gets defaults: `Label`
 *   is the file name, `Description` is empty, `Executable` is resolved via
 *   `isExecutableFile()`, and `ListInAgents` is `false`.
 * - A metadata entry without a matching file on disk is ignored.
 * - A regular file that breaks the model rules (an invalid or reserved path
 *   segment, content over the size limit, embedded binary data) or cannot be
 *   read at all is still returned, with `problem` set — never dropped. This
 *   is what keeps {@link canonicalFilesForHash} able to detect that the file
 *   changed, rather than silently treating it as absent.
 * - Symlinks and any other non-regular entry are reported only in
 *   `unsafeEntries`, never read and never followed.
 *
 * @param mainFolder Absolute path to the repository's managed main folder.
 * @param metadata   The repository's `info.json` `Files` metadata (or `[]`).
 */
export function readRepositoryFilesFolder(
    mainFolder: string,
    metadata: readonly RepositoryFileMetadataEntry[],
): ReadRepositoryFilesFolderResult {
    const root = filesFolderPath(mainFolder);
    const { regularFiles, unsafeEntries } = walkFilesFolder(root);

    const metadataByPath = new Map<string, RepositoryFileMetadataEntry>();
    for (const entry of metadata) {
        metadataByPath.set(entry.Path.toLowerCase(), entry);
    }

    const files: RepositoryFolderFile[] = regularFiles.map((relPath): RepositoryFolderFile => {
        const meta = metadataByPath.get(relPath.toLowerCase());
        const fileName = relPath.split('/').pop() as string;
        const absPath = path.join(root, ...relPath.split('/'));

        let raw: Buffer;
        try {
            raw = fs.readFileSync(absPath);
        } catch {
            return {
                path: relPath,
                content: '',
                metadata: defaultMetadataFor(fileName, '', meta),
                problem: PROBLEM_UNREADABLE,
            };
        }

        const segmentProblem = pathProblem(relPath);
        if (segmentProblem) {
            const rawContent = raw.toString('latin1');
            return { path: relPath, content: rawContent, metadata: defaultMetadataFor(fileName, rawContent, meta), problem: segmentProblem };
        }

        if (raw.length > REPOSITORY_FILE_MAX_CONTENT_BYTES) {
            const rawContent = raw.toString('latin1');
            return {
                path: relPath,
                content: rawContent,
                metadata: defaultMetadataFor(fileName, rawContent, meta),
                problem: `File exceeds the maximum size of ${REPOSITORY_FILE_MAX_CONTENT_BYTES / 1024} KB.`,
            };
        }

        if (raw.includes(0)) {
            const rawContent = raw.toString('latin1');
            return {
                path: relPath,
                content: rawContent,
                metadata: defaultMetadataFor(fileName, rawContent, meta),
                problem: 'File must be plain text (binary data is not supported).',
            };
        }

        const content = raw.toString('utf8');
        return { path: relPath, content, metadata: defaultMetadataFor(fileName, content, meta) };
    });

    return { files, unsafeEntries };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/** Result of {@link writeRepositoryFiles}. Values are `.workspace/files/`-relative paths. */
export interface WriteRepositoryFilesResult {
    /** Files whose content or executable mode was written (i.e. it had changed). */
    written: string[];
    /** Regular files deleted because they were no longer in the data set. */
    removed: string[];
    /** Targets refused by the guard chain, and existing entries the delete pass declined to touch (symlinks, other non-regular entries, or anything it could not safely re-check). */
    skipped: string[];
}

/**
 * Syncs `files` into `<mainFolder>/.workspace/files/`: creates missing
 * directories, writes content and the POSIX executable mode only when they
 * differ from what is already on disk, and deletes every regular file under
 * `files/` that is not in `files` (the "delete by set difference" pass).
 *
 * Every write target goes through the same guard chain as `custom-files.ts`'s
 * writer (lexical containment → realpath symlink-escape → directory-shape),
 * re-checked after `mkdir` in case a directory component was replaced by a
 * symlink in between. A target that fails a guard is reported in `skipped`
 * and never throws.
 *
 * The delete pass re-confirms each candidate with `lstat` immediately before
 * removal and only ever removes a plain regular file — never a symlink or any
 * other non-regular entry, which are left in place and reported in `skipped`
 * instead, so a teammate's commit under `files/` that sync does not yet
 * understand is never silently destroyed. Directories left empty by a
 * deletion are pruned upward, stopping at (and never removing) `files/`
 * itself.
 *
 * The executable mode is set (via `chmod`) only on POSIX platforms — on
 * Windows the permission bit has no effect and scripts run by extension.
 *
 * @param mainFolder Absolute path to the repository's managed main folder.
 * @param files      The repository's current files, from `RepositoryFileManager.list()`.
 */
export function writeRepositoryFiles(
    mainFolder: string,
    files: readonly RepositoryFile[],
): WriteRepositoryFilesResult {
    const root = filesFolderPath(mainFolder);
    const result: WriteRepositoryFilesResult = { written: [], removed: [], skipped: [] };
    const expectedAbsolutePaths = new Set<string>();

    for (const file of files) {
        const rel = repositoryFileRelativePath(file);

        try {
            // `root` (`.workspace/files/`) may not exist yet on the very first
            // write, so `guardedFileTarget()` cannot be called before it does
            // (it would reject every target). Resolve the target lexically
            // first, purely to know which directory to create, then run the
            // full guard chain once `root` exists — unlike `custom-files.ts`'s
            // writer, whose workspace-folder root is guaranteed to already
            // exist, here the pre-mkdir guard would have nothing to check
            // against.
            const lexicalTarget = path.resolve(root, ...rel.split('/'));
            fs.mkdirSync(path.dirname(lexicalTarget), { recursive: true });

            const target = guardedFileTarget(root, rel);
            if (target === null) {
                result.skipped.push(rel);
                continue;
            }

            expectedAbsolutePaths.add(target);

            const desiredContent = applyLineEndingPolicy(file.FileName, file.Content);
            let contentChanged = !fs.existsSync(target);
            if (!contentChanged) {
                try {
                    contentChanged = fs.readFileSync(target, 'utf8') !== desiredContent;
                } catch {
                    contentChanged = true;
                }
            }
            if (contentChanged) {
                fs.writeFileSync(target, desiredContent, 'utf8');
            }

            let modeChanged = false;
            if (process.platform !== 'win32') {
                const desiredMode = file.Executable ? 0o755 : 0o644;
                let currentMode: number | undefined;
                try {
                    currentMode = fs.statSync(target).mode & 0o777;
                } catch {
                    currentMode = undefined;
                }
                if (currentMode !== desiredMode) {
                    fs.chmodSync(target, desiredMode);
                    modeChanged = true;
                }
            }

            if (contentChanged || modeChanged) {
                result.written.push(rel);
            }
        } catch {
            result.skipped.push(rel);
        }
    }

    // Delete pass: remove every regular file under `files/` not in the data set.
    const { regularFiles, unsafeEntries } = walkFilesFolder(root);
    result.skipped.push(...unsafeEntries);

    const parentsToPrune: string[] = [];
    for (const relPath of regularFiles) {
        const absPath = path.resolve(root, ...relPath.split('/'));
        if (expectedAbsolutePaths.has(absPath)) continue;

        try {
            const stat = fs.lstatSync(absPath);
            if (!stat.isFile()) {
                result.skipped.push(relPath);
                continue;
            }
            fs.rmSync(absPath);
            result.removed.push(relPath);
            parentsToPrune.push(path.dirname(absPath));
        } catch {
            result.skipped.push(relPath);
        }
    }

    for (const parent of parentsToPrune) {
        pruneEmptyParents(parent, root);
    }

    return result;
}

// ---------------------------------------------------------------------------
// Canonical hash input
// ---------------------------------------------------------------------------

/**
 * Builds the canonical, order-independent representation of `files` used to
 * hash a repository's file set (folded into `repository-info.ts`'s
 * `hashRepositoryInfoPayload()` by a later work package).
 *
 * Every entry in `files` counts — including a `problem` file — so that a
 * teammate's committed binary, oversized, invalid-path, or unreadable file
 * always changes the hash and surfaces as `incoming` (or `conflict`) rather
 * than being silently treated as unchanged (and, because the delete pass
 * only ever runs in a `write-required` state, never reaching deletion without
 * an explicit import decision):
 * - A normal file hashes `sha256` of its LF-normalised content, so a
 *   Windows `core.autocrlf` checkout never looks like an incoming change.
 * - A `problem` file (other than unreadable) hashes `sha256` of its raw
 *   bytes — no line-ending normalisation, since the content is not
 *   necessarily text.
 * - An unreadable file contributes the fixed string `'unreadable'` in place
 *   of a content hash, since its bytes could not be read at all.
 *
 * `files` must already exclude symlinks and other non-regular entries (see
 * {@link readRepositoryFilesFolder}'s `unsafeEntries`) — they cannot be
 * represented as data and are never part of this hash.
 *
 * The result is sorted by lowercased `path`, so the hash is independent of
 * filesystem iteration order.
 */
export function canonicalFilesForHash(files: readonly RepositoryFolderFile[]): RepositoryFileHashEntry[] {
    const entries: RepositoryFileHashEntry[] = files.map((file) => {
        let contentHash: string;
        if (file.problem === PROBLEM_UNREADABLE) {
            contentHash = 'unreadable';
        } else if (file.problem !== undefined) {
            contentHash = crypto.createHash('sha256').update(Buffer.from(file.content, 'latin1')).digest('hex');
        } else {
            const normalised = file.content.replace(/\r\n|\r/g, '\n');
            contentHash = crypto.createHash('sha256').update(normalised, 'utf8').digest('hex');
        }

        return [
            file.path,
            file.metadata.Label,
            file.metadata.Description,
            file.metadata.Executable,
            file.metadata.ListInAgents,
            contentHash,
        ];
    });

    return entries.sort((a, b) => {
        const left = a[0].toLowerCase();
        const right = b[0].toLowerCase();
        return left < right ? -1 : left > right ? 1 : 0;
    });
}
