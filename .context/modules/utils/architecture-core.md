# Utilities - Architecture
_SOURCE: Path resolution and slug utility functions_
# Path resolution and slug utility functions
```
// Structure of documents
└── src/
    └── utils/
        └── paths.ts
        └── slug.ts

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
---
**File Statistics**
- **Size**: 6.29 KB
- **Lines**: 203
File: `modules/utils/architecture-core.md`
