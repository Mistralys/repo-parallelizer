import * as fs from 'fs';
import * as path from 'path';

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
 */
export function getConfigPath(): string {
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
