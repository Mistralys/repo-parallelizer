/**
 * Repository Files — small per-repository files (e.g. wrapper scripts) that
 * Paralizer syncs through git into each repository's `.workspace/files/`
 * folder (Milestone 2).
 *
 * This module is pure (no filesystem access): it holds the type and the
 * input validation/normalisation rules shared by `RepositoryFileManager`
 * (validation on save) and later orchestration modules (folder-side read/write,
 * hashing). It builds on the generic, scope-neutral rules in
 * `../file-definition.ts` the same way `../project/custom-file.ts` does for
 * project-level custom files.
 */

import {
    checkPathSegment,
    joinRelativePath,
    normaliseDirectory,
    validateDescription,
    validateFileContent,
    validateLabel,
    isExecutableFile,
    FILE_DEFINITION_MAX_CONTENT_BYTES,
    FILE_DEFINITION_MAX_LABEL_LENGTH,
    FILE_DEFINITION_MAX_DESCRIPTION_LENGTH,
} from '../file-definition.js';

/** Maximum UTF-8 size of a repository file's content, in bytes. */
export const REPOSITORY_FILE_MAX_CONTENT_BYTES = FILE_DEFINITION_MAX_CONTENT_BYTES;

/** Maximum length of a label. */
export const REPOSITORY_FILE_MAX_LABEL_LENGTH = FILE_DEFINITION_MAX_LABEL_LENGTH;

/** Maximum length of a description. */
export const REPOSITORY_FILE_MAX_DESCRIPTION_LENGTH = FILE_DEFINITION_MAX_DESCRIPTION_LENGTH;

/**
 * Maximum number of repository files a single repository may hold. Bounds the
 * cost of parsing a repository's file store on every `RepositoryFileManager`
 * call and the folder-side hash/diff work in later work packages.
 */
export const REPOSITORY_FILE_MAX_COUNT = 64;

/**
 * Path segments (compared case-insensitively, at any depth) that are reserved
 * inside the `.workspace/files/` folder and may not appear in a repository
 * file's `Directory` or `FileName`.
 */
export const RESERVED_REPOSITORY_FILE_SEGMENTS: readonly string[] = ['.git'];

/** A single repository file definition, stored per-repository in `repository-files/{repoId}.json`. */
export interface RepositoryFile {
    /** Stable unique identifier (UUID), machine-local. Never written to `info.json`. */
    Id: string;

    /**
     * Directory relative to the repository's `.workspace/files/` folder, using
     * `/` separators and no leading/trailing slash. Empty string means the
     * `files/` root itself.
     */
    Directory: string;

    /** File name including extension. Never contains a path separator. */
    FileName: string;

    /** Short human-readable label. */
    Label: string;

    /** Description of what the file is for. May be empty. */
    Description: string;

    /** UTF-8 text content written verbatim (apart from the line-ending policy). */
    Content: string;

    /**
     * Whether the file must carry the POSIX executable bit when committed.
     * Explicit (not heuristic-only like `CustomFile`), because the heuristic
     * is unreliable to round-trip through git on Windows.
     */
    Executable: boolean;

    /** Whether the file is listed in the generated workspace `AGENTS.md`. Default `false`. */
    ListInAgents: boolean;

    /** ISO 8601 timestamp of the last change. Machine-local; not hashed. */
    DateModified: string;
}

/** Mutable user-supplied fields of a repository file. */
export interface RepositoryFileInput {
    Directory: string;
    FileName: string;
    Label: string;
    Description: string;
    Content: string;

    /**
     * Explicit executable flag. When omitted, defaults from
     * `isExecutableFile(FileName, Content)`.
     */
    Executable?: boolean;

    ListInAgents: boolean;
}

/** Builds the `.workspace/files/`-relative path (`dir/name`) of a repository file. */
export function repositoryFileRelativePath(file: Pick<RepositoryFile, 'Directory' | 'FileName'>): string {
    return joinRelativePath(file.Directory, file.FileName);
}

/**
 * Validates and normalises user input for a repository file.
 *
 * Containment and safety rules: the path is relative to the repository's
 * `.workspace/files/` folder; absolute paths, drive letters, empty/`.`/`..`
 * segments and separators in the file name are all rejected via the shared
 * `file-definition.ts` rules. The `.git` segment (see
 * `RESERVED_REPOSITORY_FILE_SEGMENTS`) is rejected at any depth, compared
 * case-insensitively. Collision rule: the path must not equal another
 * repository file's path (case-insensitive, for cross-OS safety).
 *
 * @param input  Raw input.
 * @param others The repository's other files (exclude the one being edited).
 * @returns The normalised input, with `Executable` resolved to a definite boolean.
 * @throws {Error} With a user-presentable message on the first violation,
 *   including when `others.length` is already at `REPOSITORY_FILE_MAX_COUNT`.
 */
export function validateRepositoryFileInput(
    input: RepositoryFileInput,
    others: readonly RepositoryFile[],
): Omit<RepositoryFileInput, 'Executable'> & { Executable: boolean } {
    if (others.length >= REPOSITORY_FILE_MAX_COUNT) {
        throw new Error(`A repository can hold at most ${REPOSITORY_FILE_MAX_COUNT} files.`);
    }

    const label = validateLabel(input.Label, REPOSITORY_FILE_MAX_LABEL_LENGTH);
    const description = validateDescription(input.Description, REPOSITORY_FILE_MAX_DESCRIPTION_LENGTH);
    const fileName = input.FileName.trim();
    const rawDirectory = input.Directory.trim().replace(/\\/g, '/');

    if (fileName === '') throw new Error('File name is required.');
    if (/[\\/]/.test(fileName)) {
        throw new Error('File name must not contain path separators — use the directory field for the location.');
    }
    const nameProblem = checkPathSegment(fileName, 'File name');
    if (nameProblem) throw new Error(nameProblem);

    if (rawDirectory.startsWith('/') || /^[a-zA-Z]:/.test(rawDirectory)) {
        throw new Error('Directory must be relative to the `.workspace/files/` folder (no leading "/" or drive letter).');
    }
    const directory = normaliseDirectory(rawDirectory);
    if (directory !== '') {
        for (const segment of directory.split('/')) {
            const problem = checkPathSegment(segment, 'Directory');
            if (problem) throw new Error(problem);
        }
    }

    const allSegments = directory === '' ? [fileName] : [...directory.split('/'), fileName];
    const reservedHit = allSegments.find((segment) =>
        RESERVED_REPOSITORY_FILE_SEGMENTS.some((reserved) => reserved.toLowerCase() === segment.toLowerCase()),
    );
    if (reservedHit !== undefined) {
        throw new Error(`"${reservedHit}" is a reserved path segment and cannot be used inside the \`.workspace/files/\` folder.`);
    }

    const relPath = repositoryFileRelativePath({ Directory: directory, FileName: fileName });
    const lowerPath = relPath.toLowerCase();

    if (others.some((o) => repositoryFileRelativePath(o).toLowerCase() === lowerPath)) {
        throw new Error(`Another file already uses the path "${relPath}" in the \`.workspace/files/\` folder.`);
    }

    validateFileContent(input.Content, REPOSITORY_FILE_MAX_CONTENT_BYTES);

    const executable = input.Executable === undefined
        ? isExecutableFile(fileName, input.Content)
        : input.Executable === true;

    return {
        Directory: directory,
        FileName: fileName,
        Label: label,
        Description: description,
        Content: input.Content,
        Executable: executable,
        ListInAgents: input.ListInAgents === true,
    };
}
