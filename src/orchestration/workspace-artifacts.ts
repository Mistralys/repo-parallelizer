import * as path from 'node:path';
import type { AppConfig } from '../config/config.types.js';
import type { ProjectManager } from '../models/project/project.manager.js';
import type { RepositoryManager } from '../models/repository/repository.manager.js';
import type { ProjectWorkspace } from '../models/project/project.types.js';
import type { Repository } from '../models/repository/repository.types.js';
import { generateWorkspaceFile, removeWorkspaceFile, getWorkspaceFilePath } from './vscode-workspace.js';
import {
    writeWorkspaceIndexFiles,
    removeWorkspaceIndexFiles,
    type WorkspaceIndexContext,
} from './workspace-index.js';
import { writeCustomFiles, removeCustomFileCopy } from './custom-files.js';
import { customFileRelativePath, type CustomFile } from '../models/project/custom-file.js';
import { repositoryFileRelativePath } from '../models/repository/repository-file.js';
import { getToolVersion } from '../utils/version.js';
import { getToolRoot } from '../utils/paths.js';
import type { RepositoryInfoSyncOrchestrator } from './repository-info-sync.js';
import type { ErrorLogManager } from '../error-log/error-log.manager.js';
import type { RepositoryFileManager } from '../models/repository/repository-file.manager.js';

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
 *
 * **`.workspace/info.json` is a repository-level artefact, not a
 * per-workspace one:** unlike the `.code-workspace` file and the three index
 * files, the repository info file lives inside the repository's own managed
 * main folder, independent of any particular project/workspace pairing. This
 * orchestrator nonetheless triggers its sync from the same choke-point
 * (`regenerateWorkspace()`, and directly from `regenerateForRepository()`),
 * since every path that can mutate repository metadata already funnels
 * through here. A thrown sync failure is caught and logged rather than
 * propagated, so it never breaks the unrelated per-workspace artefacts.
 */
export class WorkspaceArtifactsOrchestrator {
    constructor(
        private readonly config: AppConfig,
        private readonly projectManager: ProjectManager,
        private readonly repositoryManager: RepositoryManager,
        private readonly repositoryInfoSync?: RepositoryInfoSyncOrchestrator,
        private readonly errorLogManager?: ErrorLogManager,
        /**
         * Source of the `AGENTS.md` "Repository Files" table's `ListInAgents`
         * rows (Milestone 2). Optional — kept at the end and defaulted so
         * every existing construction site (most of this project's tests)
         * keeps compiling unchanged; `repositoryFiles` in the rendered
         * context is simply omitted (no section rendered) when not injected.
         */
        private readonly repositoryFileManager?: RepositoryFileManager,
    ) {}

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /**
     * Runs {@link RepositoryInfoSyncOrchestrator.syncRepository} for a single
     * repository, catching and logging any failure so a sync problem never
     * breaks the artefact regeneration call that triggered it. A no-op when
     * `repositoryInfoSync` was not injected.
     */
    private safeSync(repositoryId: string): void {
        if (!this.repositoryInfoSync) {
            return;
        }
        try {
            this.repositoryInfoSync.syncRepository(repositoryId);
        } catch (error) {
            this.errorLogManager?.append({
                Severity: 'warning',
                Source: 'workspace-info',
                Operation: 'sync',
                Context: { RepositoryId: repositoryId },
                Message: `Failed to sync repository info for "${repositoryId}": ` +
                    `${error instanceof Error ? error.message : String(error)}`,
            });
        }
    }

    private repoPath(projectId: string, workspaceId: string, repoId: string): string {
        return path.join(this.config.projectsFolder, projectId, workspaceId, repoId);
    }

    private wsFilePath(projectId: string, workspaceId: string): string {
        return getWorkspaceFilePath(this.config.projectsFolder, projectId, workspaceId);
    }

    private guiUrl(projectId: string, workspaceId: string): string {
        return `http://localhost:${this.config.serverPort}/#/projects/${projectId}/workspaces/${workspaceId}`;
    }

    /**
     * Builds the `AGENTS.md` "Repository Files" rows: `ListInAgents` files of
     * sync-enabled repositories only, in `repositories`' own order (which is
     * already `project.Repositories` order — see {@link regenerateWorkspace}).
     * No filesystem check — sourced entirely from
     * `RepositoryFileManager.list()`, Paralizer's own data. Returns `[]` when
     * no `RepositoryFileManager` was injected (see the constructor doc).
     */
    private buildRepositoryFileRows(repositories: readonly Repository[]) {
        if (!this.repositoryFileManager) {
            return [];
        }
        const manager = this.repositoryFileManager;
        return repositories
            .filter((repo) => repo.InfoSync?.Enabled === true)
            .flatMap((repo) =>
                manager.list(repo.Id)
                    .filter((file) => file.ListInAgents)
                    .map((file) => ({
                        repositoryId: repo.Id,
                        path: repositoryFileRelativePath(file),
                        label: file.Label,
                        description: file.Description,
                    })),
            );
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
            customFiles: (project.CustomFiles ?? [])
                .filter((file) => file.ListInAgents)
                .map((file) => ({
                    path: customFileRelativePath(file),
                    label: file.Label,
                    description: file.Description,
                })),
            repositoryFiles: this.buildRepositoryFileRows(repositories),
            guiUrl: this.guiUrl(projectId, workspaceId),
            toolVersion: getToolVersion(),
            toolRoot: getToolRoot(),
            generatedAt: new Date().toISOString(),
        };

        // No-op (no mkdir, no write) when the workspace folder does not yet
        // exist on disk — see the class-level doc comment.
        writeWorkspaceIndexFiles(indexContext);

        // Custom files share the same trigger and the same no-op-when-the-
        // workspace-folder-is-missing semantics as the index files.
        writeCustomFiles(
            this.config.projectsFolder,
            projectId,
            workspaceId,
            project.CustomFiles ?? [],
            repositories.map((repo) => repo.Id),
        );

        // Repository info sync is a repository-level artefact — see the
        // class-level doc comment. A failure here is logged and never
        // propagates out of this call.
        for (const repo of repositories) {
            this.safeSync(repo.Id);
        }
    }

    /**
     * Deletes the on-disk copies of `file` from every workspace of the
     * project, pruning directories left empty. Used when a custom file is
     * deleted, or when an edit moves/renames it (pass the *previous*
     * definition). Callers should follow up with {@link regenerateProject}.
     *
     * @throws {Error} If the project does not exist.
     */
    removeCustomFileCopies(projectId: string, file: CustomFile): void {
        const project = this.projectManager.getById(projectId);
        if (!project) {
            throw new Error(
                `Cannot remove custom file copies: project with ID "${projectId}" does not exist.`
            );
        }
        for (const workspaceId of Object.keys(project.Workspaces)) {
            removeCustomFileCopy(this.config.projectsFolder, projectId, workspaceId, file);
        }
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
     *
     * Also triggers a repository info sync for `repositoryId` once up front,
     * independent of project membership — a repository with no project at
     * all is still a valid repository-level sync target, since the info file
     * is a repository-level artefact (see the class-level doc comment), not
     * a per-project one.
     */
    regenerateForRepository(repositoryId: string): void {
        this.safeSync(repositoryId);

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
