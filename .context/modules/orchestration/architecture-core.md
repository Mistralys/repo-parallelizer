# Orchestration - Architecture
_SOURCE: Orchestrator types and implementation classes_
# Orchestrator types and implementation classes
```
// Structure of documents
└── src/
    └── orchestration/
        └── branch-orchestrator.ts
        └── orchestration.types.ts
        └── project-orchestrator.ts
        └── repository-orchestrator.ts
        └── vscode-workspace.ts
        └── workspace-orchestrator.ts

```
###  Path: `/src/orchestration/branch-orchestrator.ts`

```ts
import * as path from 'node:path';
import type { AppConfig } from '../config/config.types.js';
import type { ProjectManager } from '../models/project/project.manager.js';
import type { WorkspaceManager } from '../models/workspace/workspace.manager.js';
import {
    branchExists,
    createBranch,
    fetchRemote,
    listBranches,
    switchBranch,
} from '../git/git-branch.js';
import type { BranchInfo } from '../git/git.types.js';
import { FETCH_TIMEOUT_MS } from './orchestration.types.js';
import type { BranchSwitchResult } from './orchestration.types.js';
import type { ErrorLogManager } from '../error-log/error-log.manager.js';

/**
 * High-level orchestrator for branch operations across all repositories in a
 * workspace. Composes the stateless git layer with data-model reads/writes.
 */
export class BranchOrchestrator {
    constructor(
        private readonly config: AppConfig,
        private readonly projectManager: ProjectManager,
        private readonly workspaceManager: WorkspaceManager,
        private readonly errorLogManager?: ErrorLogManager,
    ) {}

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private repoPath(projectId: string, workspaceId: string, repoId: string): string {
        return path.join(this.config.projectsFolder, projectId, workspaceId, repoId);
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Fetches from remote and returns the full branch list for every repository
     * in the workspace.
     *
     * Fetch failures (no network, no remote configured, etc.) are silently
     * ignored so that the branch list always reflects at least the locally
     * known state of each repository.
     *
     * @param projectId   - Project ID.
     * @param workspaceId - Workspace ID.
     * @returns A map of repository ID to branch info arrays.
     *
     * @throws {Error} If the project does not exist.
     */
    async getAvailableBranches(
        projectId: string,
        workspaceId: string,
    ): Promise<Map<string, BranchInfo[]>> {
        const project = this.projectManager.getById(projectId);
        if (!project) {
            throw new Error(
                `Cannot get branches: project "${projectId}" does not exist.`
            );
        }

        const result = new Map<string, BranchInfo[]>();

        await Promise.all(
            project.Repositories.map(async (repoId) => {
                const repoDir = this.repoPath(projectId, workspaceId, repoId);
                // Best-effort fetch: failures are swallowed so listing always works.
                await fetchRemote(repoDir, 'origin', FETCH_TIMEOUT_MS).catch(() => undefined);
                const branches = await listBranches(repoDir);
                result.set(repoId, branches);
            }),
        );

        return result;
    }

    /**
     * Compiles a deduplicated, case-insensitive, sorted list of branch names
     * from across all repositories in the map.
     *
     * Remote-tracking branch names (e.g. `origin/main`) are normalised to their
     * short form (e.g. `main`) so that a branch known both locally and as a
     * remote-tracking ref appears only once. The first-seen casing is preserved.
     *
     * @param branchMap - Map returned by `getAvailableBranches()`.
     * @returns Sorted, deduplicated branch name list for use in UI suggestions.
     */
    compileBranchSuggestions(branchMap: Map<string, BranchInfo[]>): string[] {
        // lowercase canonical name → first-seen display name
        const seen = new Map<string, string>();

        for (const branches of branchMap.values()) {
            for (const branch of branches) {
                // Normalise remote-tracking refs: "origin/main" → "main"
                const name = branch.isRemote
                    ? branch.name.slice(branch.name.indexOf('/') + 1)
                    : branch.name;

                const lower = name.toLowerCase();
                if (!seen.has(lower)) {
                    seen.set(lower, name);
                }
            }
        }

        return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
    }

    /**
     * Switches each repository in the workspace to the specified branch.
     *
     * For each `repoId → branchName` entry in `branchAssignments`:
     * - If the branch does not exist locally **or** as a remote-tracking ref,
     *   it is created with `git switch -c`.
     * - If the branch already exists (locally or remotely), the repository is
     *   switched to it with `git switch`.
     *
     * The workspace's `DateModified` timestamp is updated only if at least one
     * repository branch-switch succeeded. When every operation fails, the
     * timestamp is left unchanged to avoid recording a modification that never
     * actually happened.
     *
     * @param projectId        - Project ID.
     * @param workspaceId      - Workspace ID.
     * @param branchAssignments - Map of repository ID to target branch name.
     * @returns Structured result with per-repository outcomes.
     *
     * @throws {Error} When the project or workspace does not exist. Unlike
     *   {@link getAvailableBranches}, this method does **not** validate project
     *   or workspace existence before iterating `branchAssignments`. Any error
     *   surfaces only when `workspaceManager.update()` is called at the very
     *   end — after all per-repository operations have already completed.
     * @remarks If `errorLogManager` is injected and `errorLogManager.append()`
     *   itself throws (e.g. disk full when writing `error-log.json`), that
     *   exception propagates out of the `Promise.all` callback and converts a
     *   per-repository branch-switch failure into a full rejection of this
     *   method. Logging exceptions are **not** swallowed.
     */
    async switchBranches(
        projectId: string,
        workspaceId: string,
        branchAssignments: Record<string, string>,
    ): Promise<BranchSwitchResult> {
        const results: BranchSwitchResult['results'] = {};

        await Promise.all(
            Object.entries(branchAssignments).map(async ([repoId, branchName]) => {
                const repoDir = this.repoPath(projectId, workspaceId, repoId);
                try {
                    const existsLocally = await branchExists(repoDir, branchName);
                    const existsRemotely = existsLocally
                        ? false
                        : await branchExists(repoDir, branchName, 'origin');

                    const gitResult =
                        existsLocally || existsRemotely
                            ? await switchBranch(repoDir, branchName)
                            : await createBranch(repoDir, branchName);

                    if (gitResult.exitCode === 0) {
                        results[repoId] = { success: true, conflict: false };
                    } else {
                        const combinedOutput = gitResult.stderr + '\n' + gitResult.stdout;
                        const hasConflict =
                            /conflict/i.test(combinedOutput) ||
                            /overwritten by (checkout|switch)/i.test(combinedOutput);
                        const errorMessage = gitResult.stderr.trim() || `git exited with code ${gitResult.exitCode}`;
                        this.errorLogManager?.append({
                            Severity: 'error',
                            Source: 'branch-switch',
                            Operation: 'branch-switch',
                            Context: { ProjectId: projectId, WorkspaceId: workspaceId, RepositoryId: repoId },
                            Message: errorMessage,
                        });
                        results[repoId] = {
                            success: false,
                            conflict: hasConflict,
                            error: errorMessage,
                        };
                    }
                } catch (err) {
                    const errorMessage = (err as Error).message;
                    this.errorLogManager?.append({
                        Severity: 'error',
                        Source: 'branch-switch',
                        Operation: 'branch-switch',
                        Context: { ProjectId: projectId, WorkspaceId: workspaceId, RepositoryId: repoId },
                        Message: errorMessage,
                    });
                    results[repoId] = {
                        success: false,
                        conflict: false,
                        error: errorMessage,
                    };
                }
            }),
        );

        // Only update DateModified when at least one branch switch succeeded.
        const anySuccess = Object.values(results).some((r) => r.success);
        if (anySuccess) {
            this.workspaceManager.update(projectId, workspaceId, {});
        }

        return { results };
    }
}

```
###  Path: `/src/orchestration/orchestration.types.ts`

```ts
/**
 * Timeout applied to `cloneRepository()` calls in orchestrators.
 * Generous default to accommodate large repositories on slow connections.
 * Extract to `AppConfig` in a future phase if user-configurability is needed.
 */
export const CLONE_TIMEOUT_MS = 120_000;

/**
 * Timeout applied to `fetchAndGetStatus()` calls in orchestrators.
 * Shorter than clone timeout because fetches are incremental.
 */
export const FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Orchestration result types
// ---------------------------------------------------------------------------

/**
 * Per-repository outcome of a clone operation performed by an orchestrator.
 */
export interface OrchestrationRepoResult {
    /** The repository ID this outcome pertains to. */
    repositoryId: string;

    /** True when the operation completed without error. */
    success: boolean;

    /** Human-readable error description when `success` is false. */
    error?: string;
}

/**
 * Aggregate result returned by orchestration operations that act on
 * multiple repositories (e.g. workspace creation, addRepositoryToProject).
 */
export interface OrchestrationResult {
    /** Per-repository outcomes, one entry per repository processed. */
    results: OrchestrationRepoResult[];
}

// ---------------------------------------------------------------------------
// Repository orchestration result types
// ---------------------------------------------------------------------------

/**
 * Per-workspace clone outcome produced by `RepositoryOrchestrator.addRepositoryToProject()`.
 */
export interface WorkspaceCloneResult {
    /** The workspace ID this outcome pertains to. */
    workspaceId: string;

    /** True when the clone operation completed without error. */
    success: boolean;

    /** Human-readable error description when `success` is false. */
    error?: string;
}

/**
 * Aggregate result returned by `RepositoryOrchestrator.addRepositoryToProject()`.
 */
export interface AddRepositoryResult {
    /** Per-workspace clone outcomes, one entry per workspace processed. */
    workspaceResults: WorkspaceCloneResult[];
}

// ---------------------------------------------------------------------------
// Branch switch result types
// ---------------------------------------------------------------------------

/**
 * Per-repository outcome of a branch-switch operation.
 */
export interface BranchSwitchRepoResult {
    /** True when the branch switch completed without error. */
    success: boolean;

    /** True when the operation encountered a merge conflict. */
    conflict: boolean;

    /** Human-readable error description when `success` is false. */
    error?: string;
}

/**
 * Aggregate result returned by `BranchOrchestrator.switchBranches()`.
 * Keyed by repository ID so callers can look up individual outcomes directly.
 */
export interface BranchSwitchResult {
    /**
     * Per-repository branch-switch outcomes, keyed by repository ID.
     * Every repository included in `branchAssignments` will have an entry here.
     */
    results: Record<string, BranchSwitchRepoResult>;
}

```
###  Path: `/src/orchestration/project-orchestrator.ts`

```ts
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

```
###  Path: `/src/orchestration/repository-orchestrator.ts`

```ts
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
import type { ErrorLogManager } from '../error-log/error-log.manager.js';

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
        private readonly errorLogManager?: ErrorLogManager,
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
     * @remarks If `errorLogManager` is injected and `errorLogManager.append()`
     *   itself throws (e.g. disk full when writing `error-log.json`), that
     *   exception propagates out of the `Promise.all` callback and converts a
     *   per-workspace clone failure into a full rejection of this method.
     *   Logging exceptions are **not** swallowed.
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
                    const errorMessage = stripEmbeddedCredentials(gitResult.stderr) || `git clone exited with code ${gitResult.exitCode}`;
                    this.errorLogManager?.append({
                        Severity: 'error',
                        Source: 'clone',
                        Operation: 'add-repository',
                        Context: { ProjectId: projectId, WorkspaceId: workspaceId, RepositoryId: repositoryId },
                        Message: errorMessage,
                    });
                    return {
                        workspaceId,
                        success: false,
                        error: errorMessage,
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

```
###  Path: `/src/orchestration/vscode-workspace.ts`

```ts
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

```
###  Path: `/src/orchestration/workspace-orchestrator.ts`

```ts
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
     * @throws {Error} If `newId` is not a valid workspace ID (2–6 uppercase ASCII letters).
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
                `Invalid workspace ID "${newId}": must be 2–6 uppercase ASCII letters (A–Z) ` +
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

```
---
**File Statistics**
- **Size**: 48.25 KB
- **Lines**: 1207
File: `modules/orchestration/architecture-core.md`
