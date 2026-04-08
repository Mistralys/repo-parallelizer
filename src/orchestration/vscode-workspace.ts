import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A single folder entry in a VS Code .code-workspace file.
 */
interface WorkspaceFolder {
    path: string;
    name: string;
}

/**
 * Minimal shape of the VS Code .code-workspace JSON file.
 * We only enforce the `folders` property; all other properties are preserved as-is.
 */
interface VsCodeWorkspaceFile {
    folders: WorkspaceFolder[];
    [key: string]: unknown;
}

/**
 * Returns the absolute path for a VS Code .code-workspace file.
 *
 * Format: `{projectsFolder}/{projectSlug}-{workspaceId}.code-workspace`
 */
export function getWorkspaceFilePath(
    projectsFolder: string,
    projectSlug: string,
    workspaceId: string,
): string {
    return path.join(projectsFolder, `${projectSlug}-${workspaceId}.code-workspace`);
}

/**
 * Creates or updates a VS Code .code-workspace file.
 *
 * - If the file does **not** exist, a new file is created with the `folders`
 *   array and an empty `settings` object.
 * - If the file **does** exist, only the `folders` property is replaced;
 *   all other properties (`settings`, `extensions`, custom keys, etc.) are
 *   preserved verbatim.
 *
 * Each folder entry has the form:
 * ```json
 * { "path": "<absolute-path>", "name": "<slug> (<workspaceId>)" }
 * ```
 *
 * @param workspaceId  Workspace identifier used in folder display names.
 * @param repoPaths    Ordered list of repository entries to include as folders.
 * @param filePath     Absolute path where the .code-workspace file is written.
 */
export function generateWorkspaceFile(
    workspaceId: string,
    repoPaths: { slug: string; path: string }[],
    filePath: string,
): void {
    const folders: WorkspaceFolder[] = repoPaths.map((repo) => ({
        path: repo.path,
        name: `${repo.slug} (${workspaceId})`,
    }));

    let existing: VsCodeWorkspaceFile | null = null;
    if (fs.existsSync(filePath)) {
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            existing = JSON.parse(raw) as VsCodeWorkspaceFile;
        } catch {
            // Unreadable or invalid JSON — treat as non-existent and recreate.
            existing = null;
        }
    }

    const output: VsCodeWorkspaceFile =
        existing !== null
            ? { ...existing, folders }
            : { folders, settings: {} };

    const parentDir = path.dirname(filePath);
    fs.mkdirSync(parentDir, { recursive: true });

    fs.writeFileSync(filePath, JSON.stringify(output, null, 4) + '\n', 'utf8');
}

/**
 * Deletes the VS Code workspace file at the given path.
 * Silent no-op if the file does not exist.
 */
export function removeWorkspaceFile(filePath: string): void {
    try {
        fs.rmSync(filePath);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return;
        }
        throw err;
    }
}
