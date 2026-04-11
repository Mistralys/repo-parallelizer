import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppConfig } from '../config/config.types.js';
import type { ProjectManager } from '../models/project/project.manager.js';
import type { RepositoryManager } from '../models/repository/repository.manager.js';
import { cloneRepository } from '../git/git-clone.js';
import { injectCredentials, stripEmbeddedCredentials } from '../git/git-credentials.js';
import {
    generateWorkspaceFile,
    getWorkspaceFilePath,
} from './vscode-workspace.js';
import { CLONE_TIMEOUT_MS } from './orchestration.types.js';
import type { AddRepositoryResult, WorkspaceCloneResult } from './orchestration.types.js';

/**
 * High-level orchestrator for repository lifecycle operations within projects.
 * Composes the stateless git and filesystem layers with data-model reads/writes.
 *
 * Responsibility split:
 * - ProjectManager: business-rule validation and data persistence.
 * - RepositoryManager: global repository store persistence.
 * - RepositoryOrchestrator: repository clone management across all workspaces
 *   and VS Code workspace file consistency.
 *
 * ## Partial-failure handling
 *
 * `addRepositoryToProject()` captures per-workspace clone failures in the
 * returned result and does not abort: already-cloned workspaces are kept and
 * the data update is not rolled back.
 *
 * ## Path-traversal guard
 *
 * All delete operations validate that computed clone paths remain under
 * `config.projectsFolder` before performing any filesystem removal.
 */
export class RepositoryOrchestrator {
    constructor(
        private readonly config: AppConfig,
        private readonly projectManager: ProjectManager,
        private readonly repositoryManager: RepositoryManager,
    ) {}

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private repoPath(projectId: string, workspaceId: string, repoId: string): string {
        return path.join(this.config.projectsFolder, projectId, workspaceId, repoId);
    }

    private wsFilePath(projectId: string, workspaceId: string): string {
        return getWorkspaceFilePath(this.config.projectsFolder, projectId, workspaceId);
    }

    private regenerateWorkspaceFile(
        projectId: string,
        workspaceId: string,
        repositoryIds: string[],
    ): void {
        const repoPaths = repositoryIds.map((repoId) => ({
            slug: repoId,
            path: this.repoPath(projectId, workspaceId, repoId),
        }));

        generateWorkspaceFile(workspaceId, repoPaths, this.wsFilePath(projectId, workspaceId));
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Adds a repository to a project: updates the project data, then clones
     * the repository into each existing workspace folder, and regenerates all
     * VS Code workspace files.
     *
     * Clone failures for individual workspaces are captured in the returned
     * result and do not abort the operation. The project data update is not
     * rolled back on clone failure.
     *
     * @returns Per-workspace clone outcomes.
     * @throws {Error} If the repository does not exist in the global store.
     * @throws {Error} If the project does not exist.
     * @throws {Error} If the repository is already listed in the project.
     */
    async addRepositoryToProject(
        projectId: string,
        repositoryId: string,
    ): Promise<AddRepositoryResult> {
        const repo = this.repositoryManager.getById(repositoryId);
        if (!repo) {
            throw new Error(
                `Cannot add repository: repository with ID "${repositoryId}" does not exist.`
            );
        }

        // Update project data (also validates project existence and no duplicate repo).
        this.projectManager.addRepository(projectId, repositoryId);

        // Re-read project to get the confirmed, updated workspace list.
        const project = this.projectManager.getById(projectId)!;

        const resolvedProjectsFolder = path.resolve(this.config.projectsFolder);

        const workspaceResults: WorkspaceCloneResult[] = await Promise.all(
            Object.keys(project.Workspaces).map(async (workspaceId): Promise<WorkspaceCloneResult> => {
                const destination = this.repoPath(projectId, workspaceId, repositoryId);

                // Path-traversal guard: ensure the clone destination stays under projectsFolder.
                const resolvedDest = path.resolve(destination);
                if (!resolvedDest.startsWith(resolvedProjectsFolder + path.sep)) {
                    throw new Error(
                        `Security check failed: clone path "${resolvedDest}" is not under ` +
                        `projectsFolder "${resolvedProjectsFolder}"`
                    );
                }

                const cloneUrl = injectCredentials(repo.Url, this.config.gitCredentials ?? {});
                const gitResult = await cloneRepository(cloneUrl, destination, {
                    depth: this.config.cloneDepth > 0 ? this.config.cloneDepth : undefined,
                    timeoutMs: CLONE_TIMEOUT_MS,
                });

                if (gitResult.exitCode !== 0) {
                    return {
                        workspaceId,
                        success: false,
                        error: stripEmbeddedCredentials(gitResult.stderr) || `git clone exited with code ${gitResult.exitCode}`,
                    };
                }

                return { workspaceId, success: true };
            }),
        );

        // Regenerate all VS Code workspace files to include the new repository.
        for (const workspaceId of Object.keys(project.Workspaces)) {
            this.regenerateWorkspaceFile(projectId, workspaceId, project.Repositories);
        }

        return { workspaceResults };
    }

    /**
     * Removes a repository from a project: deletes clone folders from all
     * workspace folders, updates the project data, and regenerates all VS Code
     * workspace files.
     *
     * Clone folder deletions are skipped silently when the folder does not exist.
     * Each clone path is validated to be under `projectsFolder` before deletion.
     *
     * @throws {Error} If the project does not exist.
     * @throws {Error} If the repository is not listed in the project.
     */
    removeRepositoryFromProject(projectId: string, repositoryId: string): void {
        const project = this.projectManager.getById(projectId);
        if (!project) {
            throw new Error(
                `Cannot remove repository: project with ID "${projectId}" does not exist.`
            );
        }

        const resolvedProjectsFolder = path.resolve(this.config.projectsFolder);

        // Delete clone folders from all workspaces.
        for (const workspaceId of Object.keys(project.Workspaces)) {
            const clonePath = this.repoPath(projectId, workspaceId, repositoryId);
            const resolvedClonePath = path.resolve(clonePath);

            // Path-traversal guard.
            if (!resolvedClonePath.startsWith(resolvedProjectsFolder + path.sep)) {
                throw new Error(
                    `Security check failed: clone path "${resolvedClonePath}" is not under ` +
                    `projectsFolder "${resolvedProjectsFolder}".`
                );
            }

            if (fs.existsSync(clonePath)) {
                fs.rmSync(clonePath, { recursive: true, force: true });
            }
        }

        // Update project data (also validates that repositoryId is listed in the project).
        this.projectManager.removeRepository(projectId, repositoryId);

        // Re-read updated project so VS Code files reflect the current repo list.
        const updatedProject = this.projectManager.getById(projectId)!;

        // Regenerate all VS Code workspace files without the removed repository.
        for (const workspaceId of Object.keys(updatedProject.Workspaces)) {
            this.regenerateWorkspaceFile(
                projectId,
                workspaceId,
                updatedProject.Repositories,
            );
        }
    }

    /**
     * Globally removes a repository: removes it from all projects that reference
     * it (both filesystem clones and data entries), then removes it from the
     * global repository store.
     *
     * Projects that do not have the repository clone on disk are handled
     * gracefully — the clone folder removal is a no-op when the path does not exist.
     *
     * @throws {Error} If the repository does not exist in the global store.
     */
    deleteRepositoryGlobally(repositoryId: string): void {
        if (!this.repositoryManager.getById(repositoryId)) {
            throw new Error(
                `Cannot delete repository globally: repository with ID "${repositoryId}" does not exist.`
            );
        }

        // Remove the repository from every project that references it.
        const allProjects = this.projectManager.list();
        for (const entry of allProjects) {
            const project = this.projectManager.getById(entry.Id);
            if (!project) continue;
            if (!project.Repositories.includes(repositoryId)) continue;

            this.removeRepositoryFromProject(entry.Id, repositoryId);
        }

        // Remove the repository from the global store.
        this.repositoryManager.remove(repositoryId);
    }
}
