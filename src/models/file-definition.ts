/**
 * Shared, scope-neutral file-definition rules: path-segment safety, directory
 * normalisation, relative-path joining, label/description/content validation,
 * the executable-type heuristic, and the on-disk line-ending policy.
 *
 * These rules have no notion of "project" or "repository" — they describe
 * what makes a user-supplied file name, directory, label, description, and
 * content safe and well-formed, independent of where the file is stored.
 * Two consumers build their own scope-specific validation on top:
 * - `src/models/project/custom-file.ts` — project-level custom files.
 * - `src/models/repository/custom-file.ts` — repository-level custom files
 *   (Milestone 2).
 */

/** Maximum UTF-8 size of a file's content, in bytes. */
export const FILE_DEFINITION_MAX_CONTENT_BYTES = 256 * 1024;

/** Maximum length of a label. */
export const FILE_DEFINITION_MAX_LABEL_LENGTH = 120;

/** Maximum length of a description. */
export const FILE_DEFINITION_MAX_DESCRIPTION_LENGTH = 1000;

/** Characters that are invalid in a path segment on at least one supported OS. */
// eslint-disable-next-line no-control-regex
const INVALID_SEGMENT_CHARS = /[<>:"|?*\u0000-\u001f]/;

/** Windows reserved device names (case-insensitive, with or without extension). */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * Returns an error message when `segment` is not a safe single path
 * component on every supported OS, or `undefined` when it is fine.
 *
 * @param segment The path segment to check (a directory component or a file name).
 * @param what    Human-readable label used at the start of the error message
 *                (e.g. `"File name"` or `"Directory"`).
 */
export function checkPathSegment(segment: string, what: string): string | undefined {
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

/** Joins a normalised `directory` (may be `''` for the root) and `fileName` into a relative path. */
export function joinRelativePath(directory: string, fileName: string): string {
    return directory === '' ? fileName : `${directory}/${fileName}`;
}

/**
 * Validates a label: required, trimmed, and bounded by `maxLength`.
 *
 * @throws {Error} When the trimmed label is empty or exceeds `maxLength`.
 * @returns The trimmed label.
 */
export function validateLabel(rawLabel: string, maxLength: number): string {
    const label = rawLabel.trim();
    if (label === '') throw new Error('Label is required.');
    if (label.length > maxLength) {
        throw new Error(`Label must be at most ${maxLength} characters.`);
    }
    return label;
}

/**
 * Validates a description: trimmed and bounded by `maxLength`. An empty
 * description is allowed.
 *
 * @throws {Error} When the trimmed description exceeds `maxLength`.
 * @returns The trimmed description.
 */
export function validateDescription(rawDescription: string, maxLength: number): string {
    const description = rawDescription.trim();
    if (description.length > maxLength) {
        throw new Error(`Description must be at most ${maxLength} characters.`);
    }
    return description;
}

/**
 * Validates file content: bounded UTF-8 byte size, and no embedded NUL byte
 * (binary data is not supported).
 *
 * @throws {Error} When `content` exceeds `maxBytes` or contains a NUL byte.
 */
export function validateFileContent(content: string, maxBytes: number): void {
    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
        throw new Error(`Content exceeds the maximum size of ${maxBytes / 1024} KB.`);
    }
    if (content.includes('\u0000')) {
        throw new Error('Content must be plain text (binary data is not supported).');
    }
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
