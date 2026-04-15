import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppConfig } from '../config/config.types.js';
import type { ProjectManager } from '../models/project/project.manager.js';
import type { WorkspaceManager } from '../models/workspace/workspace.manager.js';
import type { RepositoryManager } from '../models/repository/repository.manager.js';
import { cloneRepository } from '../git/git-clone.js';
import { injectCredentials, stripEmbeddedCredentials } from '../git/git-credentials.js';
import {
    generateWorkspaceFile,
    removeWorkspaceFile,
    getWorkspaceFilePath,
} from './vscode-workspace.js';
import { STABLE_WORKSPACE_ID } from '../models/workspace/workspace.types.js';
import { isValidWorkspaceId } from '../utils/slug.js';
import { CLONE_TIMEOUT_MS } from './orchestration.types.js';
import type { OrchestrationResult, OrchestrationRepoResult } from './orchestration.types.js';
import type { ErrorLogManager } from '../error-log/error-log.manager.js';

/**
 * High-level orchestrator for workspace lifecycle operations.
 * Composes the stateless git and file-system layers with data-model reads/writes.
 *
 * Responsibility split:
 * - WorkspaceManager: business-rule validation and data persistence.
 * - WorkspaceOrchestrator: git cloning, folder management, and VS Code file generation.
 *
 * ## Workspace creation flow
 *
 * The caller is expected to create the workspace data entry (via
 * `WorkspaceManager.create()`) before calling `createWorkspace()`.
 * `createWorkspace()` handles only the filesystem side: creating the folder,
 * cloning repositories, and generating the VS Code .code-workspace file.
 *
 * ## STABLE workspace invariant
 *
 * `deleteWorkspace()` and `renameWorkspace()` both reject the STABLE
 * workspace ID. This mirrors the protection enforced at the data layer by
 * `WorkspaceManager`.
 */
export class WorkspaceOrchestrator {
    constructor(
        private readonly config: AppConfig,
        private readonly projectManager: ProjectManager,
        private readonly workspaceManager: WorkspaceManager,
        private readonly repositoryManager: RepositoryManager,
        private readonly errorLogManager?: ErrorLogManager,
    ) {}

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private workspaceFolder(projectId: string, workspaceId: string): string {
        return path.join(this.config.projectsFolder, projectId, workspaceId);
    }

    private repoPath(projectId: string, workspaceId: string, repoId: string): string {
        return path.join(this.config.projectsFolder, projectId, workspaceId, repoId);
    }

    private wsFilePath(projectId: string, workspaceId: string): string {
        return getWorkspaceFilePath(this.config.projectsFolder, projectId, workspaceId);
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Creates the workspace folder on disk, clones all project repositories into
     * it, and generates a VS Code .code-workspace file.
     *
     * Clone failures are captured per-repository in the returned result and do
     * not abort the operation: the workspace folder and .code-workspace file are
     * always created even when some clones fail.
     *
     * The workspace data entry is expected to already exist (created by the
     * caller via `WorkspaceManager.create()` before invoking this method).
     *
     * @throws {Error} If the project does not exist.
     * @remarks If `errorLogManager` is injected and `errorLogManager.append()`
     *   itself throws (e.g. disk full when writing `error-log.json`), that
     *   exception propagates out of the `Promise.all` callback and converts a
     *   per-repository clone failure into a full rejection of this method.
     *   Logging exceptions are **not** swallowed.
     */
    async createWorkspace(projectId: string, workspaceId: string): Promise<OrchestrationResult> {
        const project = this.projectManager.getById(projectId);
        if (!project) {
            throw new Error(
                `Cannot create workspace: project with ID "${projectId}" does not exist.`
            );
        }

        const wsFolder = this.workspaceFolder(projectId, workspaceId);
        fs.mkdirSync(wsFolder, { recursive: true });

        const resolvedProjectsFolder = path.resolve(this.config.projectsFolder);

        const repoResults: OrchestrationRepoResult[] = await Promise.all(
            project.Repositories.map(async (repoId): Promise<OrchestrationRepoResult> => {
                const repo = this.repositoryManager.getById(repoId);
                if (!repo) {
                    return {
                        repositoryId: repoId,
                        success: false,
                        error: `Repository with ID "${repoId}" does not exist in the repository store.`,
                    };
                }

                const destination = this.repoPath(projectId, workspaceId, repoId);

                // Skip repos that are already cloned on disk (idempotent retry).
                // Check for `.git` rather than just the directory: a failed clone
                // may leave behind an empty or partial directory that is not a
                // usable repository.
                if (fs.existsSync(path.join(destination, '.git'))) {
                    return { repositoryId: repoId, success: true };
                }

                // Remove leftover directory from a previously failed clone so
                // that `git clone` can create it cleanly.
                if (fs.existsSync(destination)) {
                    // Path-traversal guard: ensure the clone destination stays under projectsFolder.
                    const resolvedDest = path.resolve(destination);
                    if (!resolvedDest.startsWith(resolvedProjectsFolder + path.sep)) {
                        throw new Error(
                            `Security check failed: clone path "${resolvedDest}" is not under ` +
                            `projectsFolder "${resolvedProjectsFolder}"`
                        );
                    }
                    fs.rmSync(destination, { recursive: true, force: true });
                }

                const cloneUrl = injectCredentials(repo.Url, this.config.gitCredentials ?? {});
                const gitResult = await cloneRepository(cloneUrl, destination, {
                    depth: this.config.cloneDepth > 0 ? this.config.cloneDepth : undefined,
                    timeoutMs: CLONE_TIMEOUT_MS,
                });

                if (gitResult.exitCode !== 0) {
                    const errorMessage = stripEmbeddedCredentials(gitResult.stderr) || `git clone exited with code ${gitResult.exitCode}`;
                    this.errorLogManager?.append({
                        Severity: 'error',
                        Source: 'clone',
                        Operation: 'workspace-setup',
                        Context: { ProjectId: projectId, WorkspaceId: workspaceId, RepositoryId: repoId },
                        Message: errorMessage,
                    });
                    return {
                        repositoryId: repoId,
                        success: false,
                        error: errorMessage,
                    };
                }

                return { repositoryId: repoId, success: true };
            }),
        );

        const repoPaths = project.Repositories.map((repoId) => ({
            slug: repoId,
            path: this.repoPath(projectId, workspaceId, repoId),
        }));

        generateWorkspaceFile(
            workspaceId,
            repoPaths,
            this.wsFilePath(projectId, workspaceId),
        );

        return { results: repoResults };
    }

    /**
     * Deletes a workspace: removes the workspace folder on disk, the VS Code
     * .code-workspace file, and the workspace data entry.
     *
     * The workspace folder is silently skipped if it does not exist on disk.
     *
     * @throws {Error} If attempting to delete the STABLE workspace.
     * @throws {Error} If the computed workspace path is not under `projectsFolder`
     *   (path-traversal guard).
     * @throws {Error} If the project does not exist.
     * @throws {Error} If the workspace data entry does not exist.
     */
    deleteWorkspace(projectId: string, workspaceId: string): void {
        if (workspaceId === STABLE_WORKSPACE_ID) {
            throw new Error(
                `Cannot delete the STABLE workspace: it is the default workspace for ` +
                `project "${projectId}" and cannot be deleted.`
            );
        }

        const wsFolder = this.workspaceFolder(projectId, workspaceId);
        const resolvedWsFolder = path.resolve(wsFolder);
        const resolvedProjectsFolder = path.resolve(this.config.projectsFolder);

        if (!resolvedWsFolder.startsWith(resolvedProjectsFolder + path.sep)) {
            throw new Error(
                `Security check failed: workspace path "${resolvedWsFolder}" is not under ` +
                `projectsFolder "${resolvedProjectsFolder}".`
            );
        }

        if (fs.existsSync(wsFolder)) {
            fs.rmSync(wsFolder, { recursive: true, force: true });
        }

        removeWorkspaceFile(this.wsFilePath(projectId, workspaceId));
        this.workspaceManager.remove(projectId, workspaceId);
    }

    /**
     * Renames a workspace: renames the folder on disk, replaces the VS Code
     * .code-workspace file (updating both the filename and the folder paths
     * inside it), and updates the workspace data entry.
     *
     * The workspace folder rename is skipped if the folder does not exist on
     * disk (e.g. workspace was created but `createWorkspace()` was never called).
     *
     * @throws {Error} If attempting to rename the STABLE workspace.
     * @throws {Error} If the project does not exist.
     * @throws {Error} If the workspace `oldId` does not exist in the project data.
     * @throws {Error} If `newId` is not a valid workspace ID (2–10 uppercase ASCII letters).
     * @throws {Error} If a workspace with `newId` already exists in the project.
     */
    renameWorkspace(projectId: string, oldId: string, newId: string): void {
        if (oldId === STABLE_WORKSPACE_ID) {
            throw new Error(
                `Cannot rename the STABLE workspace: it is the default workspace for ` +
                `project "${projectId}" and cannot be renamed.`
            );
        }

        // Read project data to obtain repository list and project name.
        // This also acts as a fast-fail check for project existence.
        const project = this.projectManager.getById(projectId);
        if (!project) {
            throw new Error(
                `Cannot rename workspace: project with ID "${projectId}" does not exist.`
            );
        }

        // Pre-validate workspace existence before any filesystem changes to
        // avoid leaving the filesystem in a partially updated state.
        if (!(oldId in project.Workspaces)) {
            throw new Error(
                `Cannot rename: workspace "${oldId}" does not exist in project "${projectId}".`
            );
        }

        // Pre-validate newId before any I/O to avoid partial-update states.
        // Note: workspaceManager.rename() performs the same checks internally;
        // the duplication here is intentional to fail fast before any filesystem
        // mutation rather than after.
        if (!isValidWorkspaceId(newId)) {
            throw new Error(
                `Invalid workspace ID "${newId}": must be 2–10 uppercase ASCII letters (A–Z) ` +
                `with no digits or special characters.`
            );
        }

        if (newId === oldId) {
            throw new Error(
                `Cannot rename workspace "${oldId}": the new ID must be different from the current ID.`
            );
        }

        if (newId in project.Workspaces) {
            throw new Error(
                `Cannot rename: a workspace with ID "${newId}" already exists in project "${projectId}".`
            );
        }

        // Path-traversal guard.
        const oldWsFolderGuard = this.workspaceFolder(projectId, oldId);
        const resolvedOldWsFolder = path.resolve(oldWsFolderGuard);
        const resolvedProjectsFolder = path.resolve(this.config.projectsFolder);

        if (!resolvedOldWsFolder.startsWith(resolvedProjectsFolder + path.sep)) {
            throw new Error(
                `Security check failed: workspace path "${resolvedOldWsFolder}" is not under ` +
                `projectsFolder "${resolvedProjectsFolder}".`
            );
        }

        // Rename the workspace folder on disk.
        const oldWsFolder = this.workspaceFolder(projectId, oldId);
        const newWsFolder = this.workspaceFolder(projectId, newId);
        if (fs.existsSync(oldWsFolder)) {
            fs.renameSync(oldWsFolder, newWsFolder);
        }

        // Replace the old VS Code .code-workspace file with an updated one at
        // the new path. Folder entries reference the new workspace directory.
        const oldFilePath = this.wsFilePath(projectId, oldId);
        const newFilePath = this.wsFilePath(projectId, newId);

        const repoPaths = project.Repositories.map((repoId) => ({
            slug: repoId,
            path: this.repoPath(projectId, newId, repoId),
        }));

        generateWorkspaceFile(newId, repoPaths, newFilePath);
        removeWorkspaceFile(oldFilePath);

        // Update the workspace data entry (also validates newId format/uniqueness).
        this.workspaceManager.rename(projectId, oldId, newId);
    }
}
