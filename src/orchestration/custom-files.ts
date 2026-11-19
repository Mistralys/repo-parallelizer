import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    isLexicallyContained,
    resolveRootRealPath,
    escapesRootViaRealpath,
    isDirectoryShaped,
} from '../utils/path-guard.js';
import {
    applyLineEndingPolicy,
    customFileRelativePath,
    isExecutableFile,
    RESERVED_ROOT_FILE_NAMES,
    type CustomFile,
} from '../models/project/custom-file.js';

/**
 * Writes and removes a project's custom files inside a workspace folder.
 *
 * Every target goes through the same guard chain as the generated index files
 * (lexical containment → realpath symlink-escape → directory-shape) against
 * the *workspace folder* as root, so a custom file can never be written
 * outside the workspace — not via `..`, not via a symlink planted in a
 * sub-folder. A target that fails a guard is reported in `skipped` and never
 * throws.
 *
 * The workspace folder must already exist: like the index files, custom files
 * are a no-op for an uninitialised workspace (no `mkdir` of the root).
 *
 * Local edits to a copy are intentionally overwritten on every sync — the
 * project definition is the single source of truth.
 */

/** Result of a write or remove pass. Values are workspace-relative paths. */
export interface CustomFilesResult {
    written: string[];
    skipped: string[];
}

function workspaceFolderOf(projectsFolder: string, projectId: string, workspaceId: string): string {
    return path.join(projectsFolder, projectId, workspaceId);
}

/**
 * Runs the guard chain for one target. Returns the resolved absolute path
 * when the target is safe to write/delete, or `null` when it must be skipped.
 */
function guardedTarget(workspaceFolder: string, file: CustomFile): string | null {
    const target = path.resolve(workspaceFolder, ...customFileRelativePath(file).split('/'));
    const resolvedRoot = path.resolve(workspaceFolder);

    if (target === resolvedRoot || !isLexicallyContained(target, resolvedRoot)) return null;
    if (escapesRootViaRealpath(target, resolveRootRealPath(workspaceFolder))) return null;
    if (isDirectoryShaped(target)) return null;
    return target;
}

/**
 * Syncs `files` into one workspace: creates missing directories, overwrites
 * the content, and applies the executable bit (POSIX only — on Windows
 * `chmod` has no effect and scripts run by extension).
 *
 * Files whose first path segment is a repository folder, or that collide
 * with a generated root index file, are skipped as a defence-in-depth
 * counterpart to the save-time validation (a repository may have been added
 * to the project after the file was defined).
 */
export function writeCustomFiles(
    projectsFolder: string,
    projectId: string,
    workspaceId: string,
    files: readonly CustomFile[],
    repositoryIds: readonly string[],
): CustomFilesResult {
    const workspaceFolder = workspaceFolderOf(projectsFolder, projectId, workspaceId);
    const result: CustomFilesResult = { written: [], skipped: [] };

    if (!fs.existsSync(workspaceFolder)) return result;

    const repoNames = new Set(repositoryIds.map((id) => id.toLowerCase()));

    for (const file of files) {
        const rel = customFileRelativePath(file);
        const first = rel.split('/')[0].toLowerCase();

        const reserved = file.Directory === ''
            && RESERVED_ROOT_FILE_NAMES.some((n) => n.toLowerCase() === file.FileName.toLowerCase());
        if (reserved || repoNames.has(first)) {
            result.skipped.push(rel);
            continue;
        }

        const target = guardedTarget(workspaceFolder, file);
        if (target === null) {
            result.skipped.push(rel);
            continue;
        }

        try {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            // Re-check after mkdir: a directory component may have been a symlink created in between.
            if (guardedTarget(workspaceFolder, file) === null) {
                result.skipped.push(rel);
                continue;
            }
            fs.writeFileSync(target, applyLineEndingPolicy(file.FileName, file.Content), 'utf8');
            if (process.platform !== 'win32') {
                fs.chmodSync(target, isExecutableFile(file.FileName, file.Content) ? 0o755 : 0o644);
            }
            result.written.push(rel);
        } catch {
            result.skipped.push(rel);
        }
    }

    return result;
}

/**
 * Deletes the copy of `file` from one workspace, then prunes any directories
 * that became empty (stopping at the workspace root, which is never removed).
 * Tolerates a missing file or workspace as a silent no-op.
 *
 * @returns `true` when a file was deleted.
 */
export function removeCustomFileCopy(
    projectsFolder: string,
    projectId: string,
    workspaceId: string,
    file: CustomFile,
): boolean {
    const workspaceFolder = workspaceFolderOf(projectsFolder, projectId, workspaceId);
    if (!fs.existsSync(workspaceFolder)) return false;

    const target = guardedTarget(workspaceFolder, file);
    if (target === null) return false;

    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(target);
    } catch {
        return false;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) return false;

    fs.rmSync(target);

    // Prune empty parents up to (not including) the workspace root.
    const resolvedRoot = path.resolve(workspaceFolder);
    let dir = path.dirname(target);
    while (dir !== resolvedRoot && isLexicallyContained(dir, resolvedRoot)) {
        try {
            if (fs.readdirSync(dir).length > 0) break;
            fs.rmdirSync(dir);
        } catch {
            break;
        }
        dir = path.dirname(dir);
    }
    return true;
}
