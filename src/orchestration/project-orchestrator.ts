import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppConfig } from '../config/config.types.js';
import type { ProjectManager } from '../models/project/project.manager.js';
import { STABLE_WORKSPACE_ID } from '../models/workspace/workspace.types.js';
import {
    generateWorkspaceFile,
    removeWorkspaceFile,
    getWorkspaceFilePath,
} from './vscode-workspace.js';
import type { WorkspaceOrchestrator } from './workspace-orchestrator.js';
import type { OrchestrationResult } from './orchestration.types.js';

/**
 * High-level orchestrator for project lifecycle operations.
 * Composes the stateless filesystem layer with data-model reads/writes
 * delegated to ProjectManager, and workspace filesystem work delegated
 * to WorkspaceOrchestrator.
 *
 * Responsibility split:
 * - ProjectManager: business-rule validation and data persistence.
 * - WorkspaceOrchestrator: workspace folder management, repository cloning,
 *   and VS Code workspace file generation.
 * - ProjectOrchestrator: project folder management, cascading VS Code file
 *   cleanup/regeneration across all workspaces.
 *
 * ## Project creation flow
 *
 * `createProject()` calls `ProjectManager.create()` (which auto-creates the
 * STABLE workspace data entry), then delegates filesystem setup for the STABLE
 * workspace to `WorkspaceOrchestrator.createWorkspace()`.
 *
 * ## Path-traversal guard
 *
 * `deleteProject()` validates that the computed project path remains under
 * `config.projectsFolder` before performing any recursive deletion.
 */
export class ProjectOrchestrator {
    constructor(
        private readonly config: AppConfig,
        private readonly projectManager: ProjectManager,
        private readonly workspaceOrchestrator: WorkspaceOrchestrator,
    ) {}

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private projectFolder(projectId: string): string {
        return path.join(this.config.projectsFolder, projectId);
    }

    private wsFilePath(projectId: string, workspaceId: string): string {
        return getWorkspaceFilePath(this.config.projectsFolder, projectId, workspaceId);
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Creates a new project: creates the data entry (including the STABLE
     * workspace record), creates the project folder on disk, and delegates
     * STABLE workspace creation (repository cloning and VS Code file generation)
     * to the WorkspaceOrchestrator.
     *
     * @returns Clone results for the repositories in the STABLE workspace.
     * @throws {Error} If `ProjectManager.create()` validation fails (invalid ID,
     *   unknown repository IDs, duplicate project, etc.).
     */
    async createProject(
        name: string,
        repositoryIds: string[],
        description?: string,
        id?: string,
    ): Promise<OrchestrationResult> {
        const project = this.projectManager.create(name, repositoryIds, description, id);

        try {
            // Create the project root folder before delegating to the workspace
            // orchestrator so that the project directory exists beforehand.
            fs.mkdirSync(this.projectFolder(project.Id), { recursive: true });

            return await this.workspaceOrchestrator.createWorkspace(project.Id, STABLE_WORKSPACE_ID);
        } catch (error) {
            // Roll back the data entry so no orphaned record is left behind.
            this.projectManager.remove(project.Id);
            throw error;
        }
    }

    /**
     * Deletes a project: removes the project folder on disk (recursively),
     * removes all associated VS Code workspace files, and removes the project
     * data entry from the store.
     *
     * The project folder is silently skipped if it does not exist on disk.
     *
     * @throws {Error} If no project with the given ID exists.
     * @throws {Error} If the computed project path is not under `projectsFolder`
     *   (path-traversal guard).
     */
    deleteProject(projectId: string): void {
        const project = this.projectManager.getById(projectId);
        if (!project) {
            throw new Error(
                `Cannot delete project: project with ID "${projectId}" does not exist.`
            );
        }

        const projectFolder = this.projectFolder(projectId);
        const resolvedProjectFolder = path.resolve(projectFolder);
        const resolvedProjectsFolder = path.resolve(this.config.projectsFolder);

        if (!resolvedProjectFolder.startsWith(resolvedProjectsFolder + path.sep)) {
            throw new Error(
                `Security check failed: project path "${resolvedProjectFolder}" is not under ` +
                `projectsFolder "${resolvedProjectsFolder}".`
            );
        }

        // Remove the project folder (contains all workspace sub-folders and repository clones).
        if (fs.existsSync(projectFolder)) {
            fs.rmSync(projectFolder, { recursive: true, force: true });
        }

        // Remove the VS Code workspace file for each workspace in the project.
        for (const workspaceId of Object.keys(project.Workspaces)) {
            removeWorkspaceFile(this.wsFilePath(projectId, workspaceId));
        }

        // Remove the project data entry and update the project index.
        // ProjectManager.remove() handles both the project JSON file and the index.
        this.projectManager.remove(projectId);
    }

    /**
     * Renames a project: updates the data entry and project JSON filename via
     * `ProjectManager.rename()`, renames the project folder on disk, and
     * recreates all VS Code workspace files using the new project ID and updated
     * folder paths.
     *
     * The project folder rename is skipped if the folder does not exist on disk.
     * Old VS Code workspace files are replaced with newly generated ones that
     * reference the renamed project path.
     *
     * @throws {Error} If `newId` is not valid kebab-case.
     * @throws {Error} If no project with `oldId` exists.
     * @throws {Error} If a project with `newId` already exists.
     */
    renameProject(oldId: string, newId: string): void {
        // Read existing project data before renaming so we have the workspace
        // list and repository list available for VS Code file regeneration.
        const project = this.projectManager.getById(oldId);
        if (!project) {
            throw new Error(
                `Cannot rename project: project with ID "${oldId}" does not exist.`
            );
        }

        // Path-traversal guard: compute the destination path and verify it stays
        // under projectsFolder before modifying any data or filesystem state.
        const oldProjectFolder = this.projectFolder(oldId);
        const newProjectFolder = this.projectFolder(newId);
        const resolvedNewProjectFolder = path.resolve(newProjectFolder);
        const resolvedProjectsFolder = path.resolve(this.config.projectsFolder);
        if (!resolvedNewProjectFolder.startsWith(resolvedProjectsFolder + path.sep)) {
            throw new Error(
                `Security check failed: new project path "${resolvedNewProjectFolder}" is not under ` +
                `projectsFolder "${resolvedProjectsFolder}"`
            );
        }

        // Update data entry (renames the project JSON file, updates index, updates DateModified).
        const renamedProject = this.projectManager.rename(oldId, newId);

        // Rename the project folder on disk.
        if (fs.existsSync(oldProjectFolder)) {
            fs.renameSync(oldProjectFolder, newProjectFolder);
        }

        // For each workspace: remove the stale VS Code workspace file and generate
        // a new one that reflects the new project ID and updated folder paths.
        for (const workspaceId of Object.keys(renamedProject.Workspaces)) {
            const oldFilePath = this.wsFilePath(oldId, workspaceId);
            const newFilePath = this.wsFilePath(newId, workspaceId);

            const repoPaths = renamedProject.Repositories.map((repoId) => ({
                slug: repoId,
                path: path.join(newProjectFolder, workspaceId, repoId),
            }));

            generateWorkspaceFile(workspaceId, repoPaths, newFilePath);
            removeWorkspaceFile(oldFilePath);
        }
    }
}
