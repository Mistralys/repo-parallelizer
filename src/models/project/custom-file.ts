/**
 * Custom Files — project-level files that are copied into every workspace
 * of the project and kept in sync with their definition.
 *
 * This module is pure (no filesystem access): it holds the type, the input
 * validation/normalisation rules, and the executable-type heuristic shared by
 * `ProjectManager` (validation on save) and the artefact writer
 * (`src/orchestration/custom-files.ts`).
 */

/** Maximum UTF-8 size of a custom file's content, in bytes. */
export const CUSTOM_FILE_MAX_CONTENT_BYTES = 256 * 1024;

/** Maximum length of a label. */
export const CUSTOM_FILE_MAX_LABEL_LENGTH = 120;

/** Maximum length of a description. */
export const CUSTOM_FILE_MAX_DESCRIPTION_LENGTH = 1000;

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

/** Characters that are invalid in a path segment on at least one supported OS. */
// eslint-disable-next-line no-control-regex
const INVALID_SEGMENT_CHARS = /[<>:"|?*\u0000-\u001f]/;

/** Windows reserved device names (case-insensitive, with or without extension). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Returns an error message when `segment` is not a safe single path
 * component on every supported OS, or `undefined` when it is fine.
 */
function checkSegment(segment: string, what: string): string | undefined {
    if (segment === '') return `${what} must not contain empty path segments.`;
    if (segment === '.' || segment === '..') return `${what} must not contain "." or ".." segments.`;
    if (INVALID_SEGMENT_CHARS.test(segment)) {
        return `${what} contains characters that are not allowed (< > : " | ? * or control characters).`;
    }
    if (/[. ]$/.test(segment)) return `${what} segments must not end with a dot or a space.`;
    if (WINDOWS_RESERVED.test(segment)) return `${what} uses a reserved system name ("${segment}").`;
    return undefined;
}

/**
 * Normalises a user-typed directory: trims, converts `\` to `/`, strips
 * leading `./` and surrounding slashes. Does not validate.
 */
export function normaliseDirectory(raw: string): string {
    let dir = raw.trim().replace(/\\/g, '/');
    while (dir.startsWith('./')) dir = dir.slice(2);
    if (dir === '.') dir = '';
    return dir.replace(/\/+$/, '');
}

/** Builds the workspace-relative path (`dir/name`) of a custom file. */
export function customFileRelativePath(file: Pick<CustomFile, 'Directory' | 'FileName'>): string {
    return file.Directory === '' ? file.FileName : `${file.Directory}/${file.FileName}`;
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
    const label = input.Label.trim();
    const description = input.Description.trim();
    const fileName = input.FileName.trim();
    const rawDirectory = input.Directory.trim().replace(/\\/g, '/');

    if (label === '') throw new Error('Label is required.');
    if (label.length > CUSTOM_FILE_MAX_LABEL_LENGTH) {
        throw new Error(`Label must be at most ${CUSTOM_FILE_MAX_LABEL_LENGTH} characters.`);
    }
    if (description.length > CUSTOM_FILE_MAX_DESCRIPTION_LENGTH) {
        throw new Error(`Description must be at most ${CUSTOM_FILE_MAX_DESCRIPTION_LENGTH} characters.`);
    }

    if (fileName === '') throw new Error('File name is required.');
    if (/[\\/]/.test(fileName)) {
        throw new Error('File name must not contain path separators — use the directory field for the location.');
    }
    const nameProblem = checkSegment(fileName, 'File name');
    if (nameProblem) throw new Error(nameProblem);

    if (rawDirectory.startsWith('/') || /^[a-zA-Z]:/.test(rawDirectory)) {
        throw new Error('Directory must be relative to the workspace root (no leading "/" or drive letter).');
    }
    const directory = normaliseDirectory(rawDirectory);
    if (directory !== '') {
        for (const segment of directory.split('/')) {
            const problem = checkSegment(segment, 'Directory');
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

    if (Buffer.byteLength(input.Content, 'utf8') > CUSTOM_FILE_MAX_CONTENT_BYTES) {
        throw new Error(`Content exceeds the maximum size of ${CUSTOM_FILE_MAX_CONTENT_BYTES / 1024} KB.`);
    }
    if (input.Content.includes('\u0000')) {
        throw new Error('Content must be plain text (binary data is not supported).');
    }

    return {
        Directory: directory,
        FileName: fileName,
        Label: label,
        Description: description,
        Content: input.Content,
        ListInAgents: input.ListInAgents === true,
    };
}

/** Extensions of POSIX shell scripts that need the executable bit. */
const EXECUTABLE_EXTENSIONS = ['.sh', '.bash', '.zsh', '.ksh', '.command'];

/**
 * Decides whether a file should be marked executable (POSIX `chmod 755`).
 *
 * True for shell-script extensions, or for any file whose content starts with
 * a `#!` shebang. Windows scripts (`.bat`, `.cmd`, `.ps1`) are run by
 * extension and need no permission bit, so they are not "executable" here.
 */
export function isExecutableFile(fileName: string, content: string): boolean {
    const lower = fileName.toLowerCase();
    if (EXECUTABLE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
    return content.startsWith('#!');
}

/**
 * Applies the on-disk line-ending policy for a file: Windows batch files
 * (`.bat`, `.cmd`) are written with CRLF; POSIX scripts are written with LF
 * (a CRLF shebang breaks execution); all other files are kept as typed.
 */
export function applyLineEndingPolicy(fileName: string, content: string): string {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.bat') || lower.endsWith('.cmd')) {
        return content.replace(/\r\n|\r|\n/g, '\r\n');
    }
    if (isExecutableFile(fileName, content)) {
        return content.replace(/\r\n|\r/g, '\n');
    }
    return content;
}
