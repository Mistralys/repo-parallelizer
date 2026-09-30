import * as path from 'node:path';
import type { AppConfig } from '../config/config.types.js';
import type { ProjectManager } from '../models/project/project.manager.js';
import type { RepositoryManager } from '../models/repository/repository.manager.js';
import type { ProjectWorkspace } from '../models/project/project.types.js';
import { generateWorkspaceFile, removeWorkspaceFile, getWorkspaceFilePath } from './vscode-workspace.js';
import {
    writeWorkspaceIndexFiles,
    removeWorkspaceIndexFiles,
    type WorkspaceIndexContext,
} from './workspace-index.js';
import { getToolVersion } from '../utils/version.js';

/**
 * Overrides accepted by {@link WorkspaceArtifactsOrchestrator.regenerateWorkspace}.
 */
export interface RegenerateWorkspaceOverrides {
    /**
     * Supplies the workspace's `Description`/`Notes` metadata directly,
     * bypassing the `project.Workspaces[workspaceId]` lookup.
     *
     * `WorkspaceOrchestrator.renameWorkspace()` moves the workspace folder on
     * disk and regenerates the artefact set for the *new* workspace ID before
     * `WorkspaceManager.rename()` updates `project.Workspaces` — at that point
     * `project.Workspaces[newId]` does not exist yet (only `project.Workspaces[oldId]`
     * does). Passing the pre-rename `ProjectWorkspace` entry here lets
     * `regenerateWorkspace()` render the new artefacts without requiring the
     * caller to reorder its own filesystem-before-metadata-validation flow —
     * that reordering was explicitly rejected in the plan's Structural
     * Improvements as out of proportion to this plan's goal.
     */
    workspaceMeta?: ProjectWorkspace;
}

/**
 * Single choke-point for the "per-workspace artefact set": the VS Code
 * `.code-workspace` file plus the three generated index files
 * (`README.md`, `AGENTS.md`, `CLAUDE.md`).
 *
 * Every caller that needs to create, refresh, or remove a workspace's
 * on-disk artefacts goes through this orchestrator instead of calling
 * `generateWorkspaceFile()` / `writeWorkspaceIndexFiles()` directly, so a
 * future third artefact only needs to be wired in here rather than at every
 * call site individually.
 *
 * **`.code-workspace` vs. index-file initialisation semantics differ:**
 * `generateWorkspaceFile()` writes (and `mkdir -p`s its parent directory)
 * unconditionally, regardless of whether the workspace folder itself has
 * been created yet — this orchestrator preserves that behaviour unchanged.
 * `writeWorkspaceIndexFiles()`, by contrast, is a deliberate no-op (no
 * `mkdir`, no write) when the workspace folder does not exist on disk, since
 * an index file's presence is not a load-bearing "is this workspace
 * initialised" signal the way the workspace folder itself is. Calling
 * `regenerateWorkspace()` for a workspace whose folder has not yet been
 * created therefore still produces a `.code-workspace` file while silently
 * skipping the index files.
 */
export class WorkspaceArtifactsOrchestrator {
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

    private guiUrl(projectId: string, workspaceId: string): string {
        return `http://localhost:${this.config.serverPort}/#/projects/${projectId}/workspaces/${workspaceId}`;
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Regenerates the full artefact set (`.code-workspace` + the three index
     * files) for a single workspace.
     *
     * Repository IDs listed in `project.Repositories` that no longer exist in
     * the repository store are silently skipped — they are omitted from both
     * the `.code-workspace` folder list and the index-file repository table,
     * rather than throwing.
     *
     * @param overrides.workspaceMeta - See {@link RegenerateWorkspaceOverrides}.
     * @throws {Error} If the project does not exist.
     * @throws {Error} If `overrides.workspaceMeta` is omitted and
     *   `workspaceId` is not present in `project.Workspaces`.
     */
    regenerateWorkspace(
        projectId: string,
        workspaceId: string,
        overrides?: RegenerateWorkspaceOverrides,
    ): void {
        const project = this.projectManager.getById(projectId);
        if (!project) {
            throw new Error(
                `Cannot regenerate workspace artefacts: project with ID "${projectId}" does not exist.`
            );
        }

        const workspaceMeta = overrides?.workspaceMeta ?? project.Workspaces[workspaceId];
        if (!workspaceMeta) {
            throw new Error(
                `Cannot regenerate workspace artefacts: workspace "${workspaceId}" does not exist ` +
                `in project "${projectId}".`
            );
        }

        // Resolve repositories, skipping IDs absent from the repository store
        // rather than throwing — a repository can be deleted globally while
        // still (transiently) listed on a project.
        const repositories = project.Repositories
            .map((repoId) => this.repositoryManager.getById(repoId))
            .filter((repo): repo is NonNullable<typeof repo> => repo !== undefined);

        const repoPaths = repositories.map((repo) => ({
            slug: repo.Id,
            path: this.repoPath(projectId, workspaceId, repo.Id),
        }));

        // `.code-workspace` generation is unchanged: it writes unconditionally,
        // creating the parent directory if needed, even for a workspace whose
        // own folder has not been created yet.
        generateWorkspaceFile(workspaceId, repoPaths, this.wsFilePath(projectId, workspaceId));

        const indexContext: WorkspaceIndexContext = {
            projectsFolder: this.config.projectsFolder,
            projectId,
            projectName: project.Name,
            projectDescription: project.Description,
            workspaceId,
            workspaceDescription: workspaceMeta.Description,
            workspaceNotes: workspaceMeta.Notes ?? '',
            repositories: repositories.map((repo) => ({
                id: repo.Id,
                name: repo.Name,
                description: repo.Description ?? '',
                url: repo.Url,
            })),
            guiUrl: this.guiUrl(projectId, workspaceId),
            toolVersion: getToolVersion(),
            generatedAt: new Date().toISOString(),
        };

        // No-op (no mkdir, no write) when the workspace folder does not yet
        // exist on disk — see the class-level doc comment.
        writeWorkspaceIndexFiles(indexContext);
    }

    /**
     * Regenerates the artefact set for every workspace of `projectId`.
     *
     * @throws {Error} If the project does not exist.
     */
    regenerateProject(projectId: string): void {
        const project = this.projectManager.getById(projectId);
        if (!project) {
            throw new Error(
                `Cannot regenerate project artefacts: project with ID "${projectId}" does not exist.`
            );
        }

        for (const workspaceId of Object.keys(project.Workspaces)) {
            this.regenerateWorkspace(projectId, workspaceId);
        }
    }

    /**
     * Regenerates the artefact set for every workspace of every project that
     * currently lists `repositoryId` among its repositories.
     *
     * Uses `ProjectManager.list()` + `getById()` to enumerate all projects;
     * projects that do not reference the repository are skipped without error.
     */
    regenerateForRepository(repositoryId: string): void {
        for (const entry of this.projectManager.list()) {
            const project = this.projectManager.getById(entry.Id);
            if (!project) continue;
            if (!project.Repositories.includes(repositoryId)) continue;

            this.regenerateProject(entry.Id);
        }
    }

    /**
     * Removes the full artefact set (`.code-workspace` + the three generated
     * index files) for a single workspace.
     *
     * Tolerates the absence of any or all of the artefacts — each underlying
     * remover (`removeWorkspaceFile()`, `removeWorkspaceIndexFiles()`) is
     * already a silent no-op for a missing file.
     */
    removeWorkspace(projectId: string, workspaceId: string): void {
        removeWorkspaceFile(this.wsFilePath(projectId, workspaceId));
        removeWorkspaceIndexFiles(this.config.projectsFolder, projectId, workspaceId);
    }
}
