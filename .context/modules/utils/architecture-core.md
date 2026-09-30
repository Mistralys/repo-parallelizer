# Utilities - Architecture
_SOURCE: Path resolution and slug utility functions_
# Path resolution and slug utility functions
```
// Structure of documents
└── src/
    └── utils/
        └── path-guard.ts
        └── paths.ts
        └── slug.ts
        └── version.ts

```
###  Path: `/src/utils/path-guard.ts`

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Filesystem path-containment and symlink-escape guards.
 *
 * Extracted from `src/orchestration/workspace-index.ts`'s write-guard chain
 * (allowlist → realpath symlink-escape → shape) so the same, carefully
 * hardened logic can be reused by a second consumer without duplicating a
 * security-sensitive fix.
 *
 * Consumers:
 * - `src/orchestration/workspace-index.ts` — `writeWorkspaceIndexFiles()`'s
 *   guard chain, protecting generated index-file writes.
 * - `src/orchestration/repository-orchestrator.ts` — `removeRepositoryFromProject()`'s
 *   clone-folder deletion guard.
 */

// ---------------------------------------------------------------------------
// Guards (lexical containment -> realpath symlink-escape -> shape)
// ---------------------------------------------------------------------------

/**
 * Lexical containment check: does `resolvedTarget` sit strictly under
 * `resolvedRoot`? Purely string-based — does not touch the filesystem, and
 * therefore cannot see through a symlink (see {@link escapesRootViaRealpath}
 * for that layer).
 */
export function isLexicallyContained(resolvedTarget: string, resolvedRoot: string): boolean {
    return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
}

/**
 * Walks upward from `targetPath` to the deepest ancestor that actually
 * exists on disk. `targetPath` itself is expected not to exist yet in the
 * common case (a file this writer is about to create).
 */
function findDeepestExistingAncestor(targetPath: string): string {
    let current = targetPath;
    while (!fs.existsSync(current)) {
        const parent = path.dirname(current);
        if (parent === current) {
            // Reached the filesystem root without finding anything that
            // exists — return it so the caller's realpath call still
            // resolves to something rather than looping forever.
            return current;
        }
        current = parent;
    }
    return current;
}

/** Upper bound on symlink chain length {@link bestEffortRealpath} will follow before giving up. */
export const MAX_SYMLINK_RESOLUTION_DEPTH = 40;

/**
 * Resolves the link target of the symlink at `linkPath`, as an absolute path.
 * A relative link target is resolved against the symlink's own directory,
 * matching POSIX symlink semantics.
 */
function resolveSymlinkTarget(linkPath: string): string {
    const linkTarget = fs.readlinkSync(linkPath);
    return path.isAbsolute(linkTarget) ? linkTarget : path.resolve(path.dirname(linkPath), linkTarget);
}

/**
 * Best-effort realpath resolution that, unlike `fs.realpathSync`, does not
 * require the final path component to exist — so it also resolves a
 * *broken* symlink (one whose target does not exist).
 *
 * `fs.existsSync()` (used by {@link findDeepestExistingAncestor}) follows
 * symlinks and returns `false` for a broken symlink, exactly as it does for
 * a path that plainly does not exist. That made a broken symlink planted at
 * a write target invisible to the ancestor walk: the walk skipped straight
 * over the symlink itself and landed on its parent directory, which sits
 * inside the root, so the escape was never detected even though the symlink
 * pointed outside it. This function closes that gap by `lstat`-ing the exact
 * target path first — before ever asking whether it "exists" — so a symlink
 * is always followed explicitly, whether or not it is broken.
 *
 * Follows an arbitrary chain of symlinks (including one where an
 * intermediate hop is itself broken) up to {@link MAX_SYMLINK_RESOLUTION_DEPTH}
 * levels, then throws — the caller treats that as an escape, matching the
 * existing conservative-on-error behaviour of this guard chain.
 */
export function bestEffortRealpath(targetPath: string, depth = 0): string {
    if (depth > MAX_SYMLINK_RESOLUTION_DEPTH) {
        throw new Error(`Too many levels of symbolic links while resolving "${targetPath}"`);
    }

    let lst: fs.Stats | null;
    try {
        lst = fs.lstatSync(targetPath);
    } catch {
        lst = null;
    }

    if (lst !== null && lst.isSymbolicLink()) {
        return bestEffortRealpath(resolveSymlinkTarget(targetPath), depth + 1);
    }

    const ancestor = findDeepestExistingAncestor(targetPath);
    const resolvedAncestor = fs.realpathSync(ancestor);
    const suffix = path.relative(ancestor, targetPath);
    return suffix === '' ? resolvedAncestor : path.resolve(resolvedAncestor, suffix);
}

/**
 * Resolves `projectsFolder`'s own real path, for use as the root compared
 * against a realpath'd target ancestor in {@link escapesRootViaRealpath}.
 * Falls back to a lexical `path.resolve` if the root itself cannot be
 * realpath'd (e.g. it does not exist yet) — a case that should not arise in
 * practice, since a workspace folder existing under it implies the root
 * exists too, but the fallback keeps this helper crash-free regardless.
 */
export function resolveRootRealPath(projectsFolder: string): string {
    try {
        return fs.realpathSync(projectsFolder);
    } catch {
        return path.resolve(projectsFolder);
    }
}

/**
 * Real-path symlink-escape check: resolves `targetPath` — following any
 * symlink along the way, including a symlink at the target's own leaf
 * position, even when that symlink is broken — and reports whether the
 * resolved path escapes `resolvedRoot`. Catches a symlink planted under an
 * otherwise lexically-valid path that points outside the intended root — the
 * one class of escape a lexical check alone cannot see.
 */
export function escapesRootViaRealpath(targetPath: string, resolvedRoot: string): boolean {
    try {
        const resolved = bestEffortRealpath(targetPath);
        return !isLexicallyContained(resolved, resolvedRoot);
    } catch {
        // Unresolvable target (e.g. a symlink cycle or permission error) is
        // treated conservatively as an escape.
        return true;
    }
}

/**
 * Shape check: rejects a target path that already exists on disk as a
 * directory, so a degenerate collision (e.g. something named `README.md`
 * that is actually a folder) is reported as rejected rather than crashing
 * on the subsequent write call.
 */
export function isDirectoryShaped(targetPath: string): boolean {
    try {
        return fs.statSync(targetPath).isDirectory();
    } catch {
        return false;
    }
}

```
###  Path: `/src/utils/paths.ts`

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Shape of the folder-path section of config.json.
 *
 * Both properties accept either a **relative** path or an **absolute** path:
 * - **Relative paths** are resolved against the tool root (the directory that
 *   contains `package.json`), regardless of the process's current working
 *   directory.
 * - **Absolute paths** are returned as-is without any modification.
 *
 * Example config.json values:
 * ```json
 * { "storageFolder": "data/storage", "projectsFolder": "/Users/me/projects" }
 * ```
 */
export interface FolderConfig {
    /** Path to the storage directory (relative to tool root, or absolute). */
    storageFolder: string;
    /** Path to the projects directory (relative to tool root, or absolute). */
    projectsFolder: string;
}

let _toolRoot: string | undefined;

/**
 * Returns the tool's root directory (the directory containing package.json),
 * regardless of the current working directory. Result is cached after the
 * first call to avoid repeated filesystem walks.
 */
export function getToolRoot(): string {
    if (_toolRoot !== undefined) {
        return _toolRoot;
    }
    let dir = __dirname;
    while (true) {
        if (fs.existsSync(path.join(dir, 'package.json'))) {
            _toolRoot = dir;
            return _toolRoot;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            throw new Error(
                'Could not locate tool root: no package.json found while walking up from ' +
                __dirname
            );
        }
        dir = parent;
    }
}

/**
 * Returns the absolute path to the tool's config.json file.
 *
 * The path can be overridden via the `PARALIZER_CONFIG_PATH` environment
 * variable, which is useful in tests and CI to avoid writing to the real
 * project-root config.json.
 */
export function getConfigPath(): string {
    const override = process.env['PARALIZER_CONFIG_PATH'];
    if (override) {
        return override;
    }
    return path.join(getToolRoot(), 'config.json');
}

/**
 * Resolves the storage folder path.
 * Relative paths are resolved against the tool root; absolute paths are returned unchanged.
 */
export function getStorageFolder(config: FolderConfig): string {
    const { storageFolder } = config;
    return path.isAbsolute(storageFolder)
        ? storageFolder
        : path.resolve(getToolRoot(), storageFolder);
}

/**
 * Resolves the projects folder path.
 * Relative paths are resolved against the tool root; absolute paths are returned unchanged.
 */
export function getProjectsFolder(config: FolderConfig): string {
    const { projectsFolder } = config;
    return path.isAbsolute(projectsFolder)
        ? projectsFolder
        : path.resolve(getToolRoot(), projectsFolder);
}

```
###  Path: `/src/utils/slug.ts`

```ts
/**
 * Converts a string to kebab-case.
 *
 * - Trims leading/trailing whitespace.
 * - Lowercases all characters.
 * - Replaces runs of non-alphanumeric characters with a single hyphen.
 * - Strips any leading or trailing hyphens that result from the replacement.
 *
 * **Non-ASCII characters** (accented letters, CJK, emoji, etc.) are stripped
 * rather than transliterated — e.g. `"héllo"` → `"h-llo"`. Users with
 * non-Latin project names should be aware the output may be shorter than
 * expected.
 *
 * **All-special input** (e.g. `"!@#$%"`) returns an empty string. Callers
 * that accept arbitrary user input should guard against empty output and fall
 * back to a default slug if needed.
 *
 * Examples:
 *   "My Cool Project"     → "my-cool-project"
 *   "  hello   world  "  → "hello-world"
 *   "foo___bar--baz"      → "foo-bar-baz"
 *   "123 My Project"      → "123-my-project"
 *   "héllo"               → "h-llo"
 *   "!@#$%"               → ""
 */
export function toKebabCase(input: string): string {
    return input
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Returns true if the input is a valid kebab-case string:
 * one or more lowercase alphanumeric segments separated by single hyphens,
 * with no leading/trailing hyphens.
 *
 * Examples:
 *   "my-project"  → true
 *   "My_Project"  → false
 *   "foo--bar"    → false
 *   "-leading"    → false
 */
export function isValidKebabCase(input: string): boolean {
    return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(input);
}

/**
 * Infers a kebab-case slug from a Git remote URL.
 * Supports both HTTPS (https://github.com/user/repo.git) and SSH
 * (git@github.com:user/repo.git) formats. Strips the trailing ".git" suffix.
 *
 * **Malformed or empty input** does not throw — instead it returns an empty
 * string. Callers must guard against empty-string output before using the
 * result as a workspace or project identifier.
 *
 * Examples:
 *   "https://github.com/user/my-repo.git"  → "my-repo"
 *   "git@github.com:user/my-repo.git"      → "my-repo"
 *   ""                                      → ""
 *   "not-a-url"                             → "not-a-url"
 */
export function inferSlugFromUrl(url: string): string {
    const withoutGit = url.replace(/\.git$/i, '');
    // Split on both '/' and ':' to handle SSH and HTTPS URL formats
    const segments = withoutGit.split(/[/:]/);
    const repoName = segments[segments.length - 1];
    return toKebabCase(repoName);
}

/**
 * Returns true if the string is a valid workspace identifier:
 * 2–10 uppercase ASCII letters.
 *
 * **Digits are not accepted** — workspace IDs must consist of letters only
 * (A–Z). For example, `"AB1"` returns false. If your workflow requires
 * alphanumeric IDs the regex `^[A-Z]{2,10}$` will need to be updated.
 *
 * Examples:
 *   "AB"      → true
 *   "a"       → false   (too short, wrong case)
 *   "TOOLONGNAME" → false   (exceeds 10 characters)
 *   "AB1"         → false   (digit not permitted)
 */
export function isValidWorkspaceId(id: string): boolean {
    return /^[A-Z]{2,10}$/.test(id);
}

```
###  Path: `/src/utils/version.ts`

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getToolRoot } from './paths.js';

/**
 * Returns the tool's own version string, read from its `package.json`
 * (located at {@link getToolRoot}).
 *
 * No-argument by design: unlike a generic `readVersion(pkgPath)` reader,
 * callers never need to know where the tool's own `package.json` lives —
 * that knowledge is resolved internally via `getToolRoot()`.
 *
 * @returns The `version` field from the tool's `package.json`, or `'unknown'`
 *          when the file is missing, unreadable, or does not contain a
 *          non-empty string `version` field. Never throws.
 */
export function getToolVersion(): string {
    try {
        const pkgPath = path.join(getToolRoot(), 'package.json');
        const raw = fs.readFileSync(pkgPath, 'utf8');
        const pkg = JSON.parse(raw) as { version?: unknown };
        return typeof pkg.version === 'string' && pkg.version.length > 0
            ? pkg.version
            : 'unknown';
    } catch {
        return 'unknown';
    }
}

```
---
**File Statistics**
- **Size**: 13.82 KB
- **Lines**: 398
File: `modules/utils/architecture-core.md`
