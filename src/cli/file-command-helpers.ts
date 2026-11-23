/**
 * Scope-neutral CLI helpers shared by `custom-files.ts` (project-level
 * custom files) and `repo-files.ts` (repository-level files, Milestone 2):
 * argument parsing, content-source reading, `--flag`/`--no-flag` pair
 * reading, and file-reference resolution (exact ID, case-insensitive path,
 * unique ID prefix).
 *
 * Every helper here is scope-neutral apart from message nouns, which callers
 * supply as parameters — dispatch, help text, the sync hook and success/
 * failure wording stay in each command module, since those genuinely differ
 * between the two scopes.
 */
import * as fs from 'node:fs';
import { parseArgs } from 'node:util';

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

/** Success. */
export const EXIT_OK = 0;
/** A usage or validation error; nothing was changed. */
export const EXIT_ERROR = 1;
/** The definition was saved, but syncing afterwards failed. */
export const EXIT_SYNC_FAILED = 2;

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Thrown for malformed command lines; reported as a plain error by the command's dispatcher. */
export class UsageError extends Error {}

/**
 * Parses `args` with `node:util`'s `parseArgs()` (`allowPositionals: true,
 * strict: true`), converting a parse failure into a {@link UsageError} with a
 * `(see 'paralizer help')` hint, instead of letting `parseArgs()`'s own error
 * propagate uncaught.
 */
export function parseCommandArgs<T extends Record<string, { type: 'string' | 'boolean' }>>(
    args: string[],
    options: T,
) {
    try {
        return parseArgs({ args, options, allowPositionals: true, strict: true });
    } catch (err) {
        throw new UsageError(`${(err as Error).message} (see 'paralizer help')`);
    }
}

/**
 * Requires `positionals` to have exactly `count` entries, throwing a
 * {@link UsageError} with a `Usage: paralizer <commandName> <usage>` message
 * otherwise.
 *
 * @param commandName - The command group name (e.g. `custom-files`,
 *                      `repo-files`), interpolated into the usage message.
 */
export function requirePositionals(
    positionals: string[],
    count: number,
    usage: string,
    commandName: string,
): void {
    if (positionals.length !== count) {
        throw new UsageError(`Usage: paralizer ${commandName} ${usage}`);
    }
}

/** Shared `add`/`update` field options, common to every file-backed command group. */
export const FILE_FIELD_OPTIONS = {
    'file-name': { type: 'string' },
    label: { type: 'string' },
    directory: { type: 'string' },
    description: { type: 'string' },
    'list-in-agents': { type: 'boolean' },
    'no-list-in-agents': { type: 'boolean' },
    'content-file': { type: 'string' },
    stdin: { type: 'boolean' },
    content: { type: 'string' },
} as const;

// ---------------------------------------------------------------------------
// Content source
// ---------------------------------------------------------------------------

/**
 * Reads the content from whichever single source option was given
 * (`--content-file <path>`, `--stdin`, or `--content <text>`), or returns
 * `undefined` when none was given — the caller decides whether that is an
 * error (`add`, which requires one) or means "leave unchanged" (`update`).
 *
 * `--content-file -` reads standard input, exactly like `--stdin`.
 *
 * @throws {UsageError} More than one source option was given.
 * @throws {Error} `--content-file <path>` could not be read.
 */
export async function readContentSource(
    values: { 'content-file'?: string; stdin?: boolean; content?: string },
    readStdin: () => Promise<string>,
): Promise<string | undefined> {
    const sources = [
        values['content-file'] !== undefined,
        values.stdin === true,
        values.content !== undefined,
    ].filter(Boolean).length;
    if (sources > 1) {
        throw new UsageError('Use only one of --content-file, --stdin and --content.');
    }

    if (values.content !== undefined) return values.content;
    if (values.stdin === true || values['content-file'] === '-') return readStdin();
    if (values['content-file'] !== undefined) {
        try {
            return fs.readFileSync(values['content-file'], 'utf8');
        } catch (err) {
            throw new Error(`Cannot read content file "${values['content-file']}": ${(err as Error).message}`);
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// --flag / --no-flag pairs
// ---------------------------------------------------------------------------

/**
 * Reads a mutually-exclusive `--<name>` / `--no-<name>` boolean pair:
 * `true` when `--<name>` was given, `false` when `--no-<name>` was given,
 * `undefined` when neither was (the caller decides the default — e.g. `false`
 * for `add`, "leave unchanged" for `update`).
 *
 * @throws {UsageError} Both flags were given.
 */
export function readFlagPair(values: Record<string, unknown>, name: string): boolean | undefined {
    const positive = values[name] === true;
    const negative = values[`no-${name}`] === true;
    if (positive && negative) {
        throw new UsageError(`Use only one of --${name} and --no-${name}.`);
    }
    if (positive) return true;
    if (negative) return false;
    return undefined;
}

// ---------------------------------------------------------------------------
// File reference resolution
// ---------------------------------------------------------------------------

/** Minimum length of an ID prefix accepted as a file reference. */
const MIN_ID_PREFIX = 4;

/**
 * Finds a file by exact ID, then by relative path (case-insensitive, `\`
 * accepted), then by unique ID prefix (at least {@link MIN_ID_PREFIX}
 * characters).
 *
 * @param relativePath - Computes the scope-specific relative path for a
 *                       file, used both for path matching and in resolved
 *                       messages.
 * @param noun         - Human-readable singular noun for this scope (e.g.
 *                       `"custom file"`, `"repository file"`), interpolated
 *                       into the ambiguous/no-match messages.
 * @param listHint      - The command line to suggest in the no-match
 *                        message (e.g. `"paralizer custom-files list
 *                        <project-id>"`).
 * @throws {Error} When nothing or more than one file matches.
 */
export function resolveFileReference<T extends { Id: string }>(
    files: readonly T[],
    ref: string,
    options: { relativePath: (file: T) => string; noun: string; listHint: string },
): T {
    const { relativePath, noun, listHint } = options;
    const normalised = ref.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();

    const byId = files.find((f) => f.Id.toLowerCase() === normalised);
    if (byId) return byId;

    const byPath = files.find((f) => relativePath(f).toLowerCase() === normalised);
    if (byPath) return byPath;

    if (normalised.length >= MIN_ID_PREFIX) {
        const byPrefix = files.filter((f) => f.Id.toLowerCase().startsWith(normalised));
        if (byPrefix.length === 1) return byPrefix[0];
        if (byPrefix.length > 1) {
            throw new Error(`"${ref}" matches several ${noun}s — use a longer ID prefix or the path.`);
        }
    }
    throw new Error(`No ${noun} matches "${ref}". Run '${listHint}' to see them.`);
}

// ---------------------------------------------------------------------------
// Standard input
// ---------------------------------------------------------------------------

/** Reads all of standard input as UTF-8 text. */
export async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    return Buffer.concat(chunks).toString('utf8');
}
