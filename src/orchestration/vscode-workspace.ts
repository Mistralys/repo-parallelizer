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
 * Format: `{projectsFolder}/{projectSlug}/{projectSlug}-{workspaceId}.code-workspace`
 *
 * The file is nested inside the per-project subdirectory so that each
 * project's on-disk footprint (repositories + workspace file) is
 * self-contained under a single directory.
 */
export function getWorkspaceFilePath(
    projectsFolder: string,
    projectSlug: string,
    workspaceId: string,
): string {
    return path.join(projectsFolder, projectSlug, `${projectSlug}-${workspaceId}.code-workspace`);
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

/**
 * One-time migration utility: moves `.code-workspace` files from the legacy
 * flat layout (`{projectsFolder}/{slug}-*.code-workspace`) into the nested
 * per-project layout (`{projectsFolder}/{slug}/{slug}-*.code-workspace`).
 *
 * Behaviour:
 * - Only files whose base name starts with a known project slug followed by `-`
 *   are considered.  Unrecognized files are left untouched.
 * - Files that are already at the correct target location are skipped (the
 *   function is idempotent).
 * - The target parent directory is created if it does not already exist.
 *
 * @param projectsFolder  Absolute path to the root folder that contains all
 *                        project subdirectories and (legacy) flat workspace files.
 * @param projectSlugs    Array of known project slug strings.  Only files
 *                        matching one of these slugs are migrated.
 * @returns               The number of files that were actually moved.
 */
export function migrateWorkspaceFiles(
    projectsFolder: string,
    projectSlugs: string[],
): number {
    let moved = 0;

    // Build a Set for O(1) slug lookups.
    const slugSet = new Set(projectSlugs);

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(projectsFolder, { withFileTypes: true });
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            // projectsFolder does not yet exist — nothing to migrate.
            return 0;
        }
        throw err;
    }

    for (const entry of entries) {
        if (!entry.isFile()) continue;

        const fileName = entry.name;
        if (!fileName.endsWith('.code-workspace')) continue;

        // Determine which known slug this file belongs to, if any.
        // File names are of the form `{slug}-{workspaceId}.code-workspace`.
        // We find the matching slug by checking whether the file name starts
        // with `{slug}-`.  If multiple slugs could match (e.g. `foo` and
        // `foo-bar`), we pick the longest matching slug (most specific).
        let matchedSlug: string | null = null;
        for (const slug of slugSet) {
            if (fileName.startsWith(`${slug}-`)) {
                if (matchedSlug === null || slug.length > matchedSlug.length) {
                    matchedSlug = slug;
                }
            }
        }

        if (matchedSlug === null) continue; // unrecognized file — leave it alone

        const sourcePath = path.join(projectsFolder, fileName);
        const targetDir  = path.join(projectsFolder, matchedSlug);
        const targetPath = path.join(targetDir, fileName);

        // Already at the correct location — idempotency guard.
        if (sourcePath === targetPath) continue;

        // If the file somehow already exists at the target, skip to avoid
        // overwriting (treat as already migrated).
        if (fs.existsSync(targetPath)) continue;

        fs.mkdirSync(targetDir, { recursive: true });
        fs.renameSync(sourcePath, targetPath);
        moved++;
    }

    return moved;
}
