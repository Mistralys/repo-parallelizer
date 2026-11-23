/**
 * Custom Files — project-level files that are copied into every workspace
 * of the project and kept in sync with their definition.
 *
 * This module is pure (no filesystem access): it holds the type, the input
 * validation/normalisation rules, and the executable-type heuristic shared by
 * `ProjectManager` (validation on save) and the artefact writer
 * (`src/orchestration/custom-files.ts`).
 *
 * The generic, scope-neutral file rules (path-segment safety, directory
 * normalisation, label/description/content validation, the executable-type
 * heuristic, and the line-ending policy) live in `../file-definition.ts` and
 * are re-exported here under their established public names.
 */

import {
    checkPathSegment,
    joinRelativePath,
    normaliseDirectory,
    validateDescription,
    validateFileContent,
    validateLabel,
    isExecutableFile,
    applyLineEndingPolicy,
    FILE_DEFINITION_MAX_CONTENT_BYTES,
    FILE_DEFINITION_MAX_LABEL_LENGTH,
    FILE_DEFINITION_MAX_DESCRIPTION_LENGTH,
} from '../file-definition.js';

export {
    normaliseDirectory,
    isExecutableFile,
    applyLineEndingPolicy,
};

/** Maximum UTF-8 size of a custom file's content, in bytes. */
export const CUSTOM_FILE_MAX_CONTENT_BYTES = FILE_DEFINITION_MAX_CONTENT_BYTES;

/** Maximum length of a label. */
export const CUSTOM_FILE_MAX_LABEL_LENGTH = FILE_DEFINITION_MAX_LABEL_LENGTH;

/** Maximum length of a description. */
export const CUSTOM_FILE_MAX_DESCRIPTION_LENGTH = FILE_DEFINITION_MAX_DESCRIPTION_LENGTH;

/**
 * File names (compared case-insensitively) that the workspace index
 * generator owns at the workspace root. A custom file may not target them.
 */
export const RESERVED_ROOT_FILE_NAMES: readonly string[] = ['README.md', 'AGENTS.md', 'CLAUDE.md'];

/** A single custom file definition, stored in `ProjectData.CustomFiles`. */
export interface CustomFile {
    /** Stable unique identifier (UUID). Survives edits of path/name. */
    Id: string;

    /**
     * Directory relative to the workspace root, using `/` separators and no
     * leading/trailing slash. Empty string means the workspace root itself.
     */
    Directory: string;

    /** File name including extension. Never contains a path separator. */
    FileName: string;

    /** Short human-readable label. */
    Label: string;

    /** Description of what the file is for. May be empty. */
    Description: string;

    /** UTF-8 text content written verbatim (apart from line-ending policy). */
    Content: string;

    /** Whether the file is listed in the generated workspace `AGENTS.md`. Default `false`. */
    ListInAgents: boolean;

    /** ISO 8601 timestamp of the last change. */
    DateModified: string;
}

/** Mutable user-supplied fields of a custom file. */
export interface CustomFileInput {
    Directory: string;
    FileName: string;
    Label: string;
    Description: string;
    Content: string;
    ListInAgents: boolean;
}

/** Builds the workspace-relative path (`dir/name`) of a custom file. */
export function customFileRelativePath(file: Pick<CustomFile, 'Directory' | 'FileName'>): string {
    return joinRelativePath(file.Directory, file.FileName);
}

/**
 * Validates and normalises user input for a custom file.
 *
 * Containment rules (the target must stay inside the workspace root):
 * absolute paths, drive letters, empty/`.`/`..` segments and separators in
 * the file name are all rejected. Collision rules: the path must not be a
 * generated index file, sit inside a repository folder, or equal another
 * custom file's path (case-insensitive, for cross-OS safety).
 *
 * @param input        Raw input.
 * @param repositoryIds Repository folder names of the project.
 * @param others       The project's other custom files (exclude the one being edited).
 * @returns The normalised input.
 * @throws {Error} With a user-presentable message on the first violation.
 */
export function validateCustomFileInput(
    input: CustomFileInput,
    repositoryIds: readonly string[],
    others: readonly CustomFile[],
): CustomFileInput {
    const label = validateLabel(input.Label, CUSTOM_FILE_MAX_LABEL_LENGTH);
    const description = validateDescription(input.Description, CUSTOM_FILE_MAX_DESCRIPTION_LENGTH);
    const fileName = input.FileName.trim();
    const rawDirectory = input.Directory.trim().replace(/\\/g, '/');

    if (fileName === '') throw new Error('File name is required.');
    if (/[\\/]/.test(fileName)) {
        throw new Error('File name must not contain path separators — use the directory field for the location.');
    }
    const nameProblem = checkPathSegment(fileName, 'File name');
    if (nameProblem) throw new Error(nameProblem);

    if (rawDirectory.startsWith('/') || /^[a-zA-Z]:/.test(rawDirectory)) {
        throw new Error('Directory must be relative to the workspace root (no leading "/" or drive letter).');
    }
    const directory = normaliseDirectory(rawDirectory);
    if (directory !== '') {
        for (const segment of directory.split('/')) {
            const problem = checkPathSegment(segment, 'Directory');
            if (problem) throw new Error(problem);
        }
    }

    const relPath = customFileRelativePath({ Directory: directory, FileName: fileName });
    const lowerPath = relPath.toLowerCase();

    if (directory === '' && RESERVED_ROOT_FILE_NAMES.some((n) => n.toLowerCase() === fileName.toLowerCase())) {
        throw new Error(`"${fileName}" is generated for every workspace and cannot be used as a custom file.`);
    }

    const firstSegment = relPath.split('/')[0].toLowerCase();
    const clash = repositoryIds.find((id) => id.toLowerCase() === firstSegment);
    if (clash !== undefined) {
        throw new Error(`The path points into the folder of repository "${clash}" — choose a location outside repository folders.`);
    }

    if (others.some((o) => customFileRelativePath(o).toLowerCase() === lowerPath)) {
        throw new Error(`Another custom file already uses the path "${relPath}".`);
    }

    validateFileContent(input.Content, CUSTOM_FILE_MAX_CONTENT_BYTES);

    return {
        Directory: directory,
        FileName: fileName,
        Label: label,
        Description: description,
        Content: input.Content,
        ListInAgents: input.ListInAgents === true,
    };
}
