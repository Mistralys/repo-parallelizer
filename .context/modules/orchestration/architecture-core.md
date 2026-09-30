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
        └── workspace-artifacts.ts
        └── workspace-health.ts
        └── workspace-index.ts
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
import type { WorkspaceOrchestrator } from './workspace-orchestrator.js';
import type { WorkspaceArtifactsOrchestrator } from './workspace-artifacts.js';
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
        private readonly workspaceArtifacts: WorkspaceArtifactsOrchestrator,
    ) {}

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private projectFolder(projectId: string): string {
        return path.join(this.config.projectsFolder, projectId);
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

        // Remove the full artefact set (VS Code workspace file + generated
        // index files) for each workspace in the project.
        for (const workspaceId of Object.keys(project.Workspaces)) {
            this.workspaceArtifacts.removeWorkspace(projectId, workspaceId);
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

        // For each workspace: regenerate the full artefact set under the new
        // project ID (the project data entry and the on-disk folder have
        // already been renamed above, so the choke-point resolves the new
        // paths correctly), then remove the stale artefact set at the old
        // project path.
        for (const workspaceId of Object.keys(renamedProject.Workspaces)) {
            this.workspaceArtifacts.regenerateWorkspace(newId, workspaceId);
            this.workspaceArtifacts.removeWorkspace(oldId, workspaceId);
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
import { resolveCredential, injectCredentialToken, extractHost, stripEmbeddedCredentials } from '../git/git-credentials.js';
import type { WorkspaceArtifactsOrchestrator } from './workspace-artifacts.js';
import { CLONE_TIMEOUT_MS } from './orchestration.types.js';
import type { AddRepositoryResult, WorkspaceCloneResult } from './orchestration.types.js';
import type { ErrorLogManager } from '../error-log/error-log.manager.js';
import { resolveRootRealPath, escapesRootViaRealpath } from '../utils/path-guard.js';

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
 * `removeRepositoryFromProject()` uses a two-layer guard (strict-descendant
 * lexical containment, then a realpath symlink-escape check via
 * `../utils/path-guard.js`) so a planted symlink cannot escape the lexical
 * check alone; `addRepositoryToProject()` retains the lexical-only guard, as
 * it only ever computes a fresh destination for `git clone` rather than
 * resolving a path that could already contain an attacker-controlled symlink.
 */
export class RepositoryOrchestrator {
    constructor(
        private readonly config: AppConfig,
        private readonly projectManager: ProjectManager,
        private readonly repositoryManager: RepositoryManager,
        private readonly workspaceArtifacts: WorkspaceArtifactsOrchestrator,
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
     * @remarks **Credential coherence:** When a repository has an explicit
     *   `CredentialId`, `resolveCredential()` performs only an ID lookup and does
     *   **not** cross-validate the credential's configured host against the
     *   repository URL's hostname. The `credential-options` endpoint already
     *   filters available credentials by host, so mismatches are unlikely in
     *   practice — but callers that set `CredentialId` programmatically must
     *   ensure coherence themselves.
     *   See {@link resolveCredential} for the full security note.
     * @remarks **Credential success logging:** After a successful credential-based
     *   clone (`credential !== null`), a `Source: 'credentials'`, `Severity: 'info'`
     *   log entry is written. This allows `checkWorkspaceHealth()` to suppress
     *   stale `credential-missing` badges by inspecting the most recent entry per
     *   repository.
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

                const credentials = this.config.gitCredentials ?? [];
                const credential = resolveCredential(repo.Url, credentials, repo.CredentialId);
                const host = extractHost(repo.Url);

                // When no credential resolves for an HTTPS URL, report a descriptive
                // error rather than attempting an unauthenticated clone that would
                // likely fail with an unhelpful git error message.
                if (credential === null && host !== null) {
                    const errorMessage =
                        `Repository '${repo.Name}' requires a credential for host '${host}'. ` +
                        `Please select a credential in the repository settings.`;
                    this.errorLogManager?.append({
                        Severity: 'error',
                        Source: 'credentials',
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

                const cloneUrl = credential !== null
                    ? injectCredentialToken(repo.Url, credential.token)
                    : repo.Url;

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

                // Write a credential success entry so that checkWorkspaceHealth()
                // can suppress stale credential-missing badges for this repository.
                if (credential !== null) {
                    this.errorLogManager?.append({
                        Severity: 'info',
                        Source: 'credentials',
                        Operation: 'add-repository',
                        Context: { ProjectId: projectId, WorkspaceId: workspaceId, RepositoryId: repositoryId },
                        Message: `Repository '${repo.Name}' cloned successfully using credential '${credential.label}'.`,
                    });
                }

                return { workspaceId, success: true };
            }),
        );

        // Regenerate the full artefact set for every workspace so it reflects
        // the newly added repository.
        this.workspaceArtifacts.regenerateProject(projectId);

        return { workspaceResults };
    }

    /**
     * Removes a repository from a project: deletes clone folders from all
     * workspace folders, updates the project data, and regenerates all VS Code
     * workspace files.
     *
     * Clone folder deletions are skipped silently when the folder does not exist.
     * Each clone path is validated to be under `projectsFolder` before deletion,
     * via a two-layer guard: a strict-descendant lexical check (which also
     * rejects equality with `projectsFolder` itself — a malformed/persisted
     * repository or workspace ID must never resolve to the projects root),
     * followed by a realpath symlink-escape check that catches a planted
     * symlink a lexical check alone cannot see through.
     *
     * When an `errorLogManager` is injected, a `Severity: 'audit'`,
     * `Operation: 'unlink-repository'` entry is emitted unconditionally once
     * the data and filesystem mutations succeed — regardless of whether the
     * subsequent artefact regeneration succeeds. Regeneration is downstream
     * reconciliation, not part of the audited event: a transient
     * `regenerateProject()` failure is caught and logged as a
     * `Severity: 'warning'`, `Source: 'workspace-index'` entry instead of
     * suppressing the audit record of a deletion that genuinely happened. A
     * guard failure (thrown before any mutation) still leaves no entry behind.
     *
     * @throws {Error} If the project does not exist.
     * @throws {Error} If the repository is not listed in the project. Checked
     *   up front, before any clone folder is deleted, so an unlisted
     *   repository can never cause a partial, unassociated deletion.
     * @throws {Error} If any clone path fails the path-traversal guard (lexical
     *   containment or realpath symlink-escape).
     */
    removeRepositoryFromProject(projectId: string, repositoryId: string): void {
        const project = this.projectManager.getById(projectId);
        if (!project) {
            throw new Error(
                `Cannot remove repository: project with ID "${projectId}" does not exist.`
            );
        }

        if (!project.Repositories.includes(repositoryId)) {
            throw new Error(
                `Repository "${repositoryId}" is not listed in project "${projectId}".`
            );
        }

        const resolvedProjectsFolder = path.resolve(this.config.projectsFolder);
        const realProjectsFolder = resolveRootRealPath(this.config.projectsFolder);

        // Delete clone folders from all workspaces.
        for (const workspaceId of Object.keys(project.Workspaces)) {
            const clonePath = this.repoPath(projectId, workspaceId, repositoryId);
            const resolvedClonePath = path.resolve(clonePath);

            // Path-traversal guard, layer 1: strict-descendant lexical check.
            // Deliberately does NOT permit equality with resolvedProjectsFolder
            // (unlike the shared isLexicallyContained() helper, whose
            // equality-permitting contract suits the writer path but not this
            // delete path).
            if (!resolvedClonePath.startsWith(resolvedProjectsFolder + path.sep)) {
                throw new Error(
                    `Security check failed: clone path "${resolvedClonePath}" is not under ` +
                    `projectsFolder "${resolvedProjectsFolder}".`
                );
            }

            // Path-traversal guard, layer 2: realpath symlink-escape check.
            // Catches a planted symlink (including a broken one) at the clone
            // path's leaf that resolves outside projectsFolder even though the
            // lexical check above passed.
            if (escapesRootViaRealpath(resolvedClonePath, realProjectsFolder)) {
                throw new Error(
                    `Security check failed: clone path "${resolvedClonePath}" is not under ` +
                    `projectsFolder "${resolvedProjectsFolder}".`
                );
            }

            if (fs.existsSync(clonePath)) {
                fs.rmSync(clonePath, { recursive: true, force: true });
            }
        }

        // Update project data. The pre-loop check above already validated the
        // association; this call re-validates it as defense in depth.
        this.projectManager.removeRepository(projectId, repositoryId);

        // Audit trail — the audited event ("repository unlinked and clone
        // folders removed") is already complete at this point, so the entry
        // is emitted unconditionally from here on, regardless of whether the
        // downstream artefact regeneration below succeeds. A guard failure or
        // an unlisted repository, both handled above, still throw before this
        // point and so still produce no entry.
        this.errorLogManager?.append({
            Severity: 'audit',
            Source: 'repository-audit',
            Operation: 'unlink-repository',
            Context: { ProjectId: projectId, RepositoryId: repositoryId },
            Message: `Repository "${repositoryId}" was unlinked from project "${projectId}" and its clone folders removed.`,
        });

        // Regenerate the full artefact set for every workspace so it reflects
        // the current (post-removal) repository list. This is best-effort
        // downstream reconciliation, not part of the audited event above: a
        // transient failure here must not erase the audit record of a
        // deletion that genuinely happened, so it is caught and logged as a
        // warning instead of propagating.
        try {
            this.workspaceArtifacts.regenerateProject(projectId);
        } catch (error) {
            this.errorLogManager?.append({
                Severity: 'warning',
                Source: 'workspace-index',
                Operation: 'unlink-repository',
                Context: { ProjectId: projectId, RepositoryId: repositoryId },
                Message: `Failed to regenerate workspace artefacts for project "${projectId}" after ` +
                    `unlinking repository "${repositoryId}": ${error instanceof Error ? error.message : String(error)}`,
            });
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
     * When an `errorLogManager` is injected, each per-project cascade step
     * emits its own `unlink-repository` audit entry via
     * {@link removeRepositoryFromProject}, and — only after the global-store
     * removal below also succeeds — a single summary `delete-repository-global`
     * entry is emitted, with `Details` naming every affected project ID. If
     * `repositoryManager.remove()` throws, this method throws too, no summary
     * entry is written, and the per-project entries already emitted during the
     * cascade are left in place (they describe cascade steps that did
     * genuinely complete).
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
        const affectedProjectIds: string[] = [];
        for (const entry of allProjects) {
            const project = this.projectManager.getById(entry.Id);
            if (!project) continue;
            if (!project.Repositories.includes(repositoryId)) continue;

            this.removeRepositoryFromProject(entry.Id, repositoryId);
            affectedProjectIds.push(entry.Id);
        }

        // Remove the repository from the global store.
        this.repositoryManager.remove(repositoryId);

        // Audit trail — the summary entry is emitted only after the global
        // removal above has succeeded, so a throw here (after the per-project
        // cascade already completed) leaves no summary entry behind while the
        // per-project entries already written remain intact.
        this.errorLogManager?.append({
            Severity: 'audit',
            Source: 'repository-audit',
            Operation: 'delete-repository-global',
            Context: { RepositoryId: repositoryId },
            Message: `Repository "${repositoryId}" was deleted globally, affecting ${affectedProjectIds.length} project(s).`,
            Details: JSON.stringify(affectedProjectIds),
        });
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

```
###  Path: `/src/orchestration/workspace-artifacts.ts`

```ts
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

```
###  Path: `/src/orchestration/workspace-health.ts`

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getWorkspaceFilePath } from './vscode-workspace.js';
import { checkIndexFileStatus } from './workspace-index.js';
import type { ErrorLogManager } from '../error-log/error-log.manager.js';

export interface WorkspaceHealthIssue {
    type: string;
    severity: 'error' | 'warning';
    message: string;
    fixAction: string;
    repositoryId?: string;
}

export interface WorkspaceHealthReport {
    healthy: boolean;
    issues: WorkspaceHealthIssue[];
}

/**
 * Performs a side-effect-free health check on a workspace.
 *
 * Checks:
 * 1. Whether the VS Code .code-workspace file exists on disk.
 * 2. Whether each repository directory contains a `.git` entry
 *    (i.e. has been successfully cloned).
 * 3. Whether the three generated index files (`README.md`, `AGENTS.md`,
 *    `CLAUDE.md`) are present and marker-managed, via the read-only
 *    {@link checkIndexFileStatus} probe. This function never inspects an
 *    index file's content itself, and never imports the generated-marker
 *    constants — {@link checkIndexFileStatus} is the single source of truth
 *    for marker detection (shared with the writer and remover in
 *    `workspace-index.ts`), so this check cannot drift out of sync with what
 *    the writer considers managed vs. hand-authored.
 * 4. (Optional) Whether the error log contains recent credential-missing entries
 *    for repositories in this workspace. Only performed when `errorLogManager`
 *    is provided.
 *
 * Note on `.git` detection: the clone check uses `fs.existsSync` on the `.git`
 * path entry, which returns `true` for both a `.git` directory (standard clone)
 * and a `.git` file (git worktree pointer). Both forms are treated as a
 * successfully cloned repository. If you need to distinguish between a full
 * clone and a worktree, use `fs.statSync().isDirectory()` instead.
 *
 * @param projectId       Project identifier (used as the project slug in paths).
 * @param workspaceId     Workspace identifier.
 * @param projectsFolder  Root folder where projects are stored on disk.
 * @param repositoryIds   Ordered list of repository IDs belonging to the workspace.
 * @param errorLogManager Optional error log manager. When provided, the health
 *                        report includes `credential-missing` issues for repositories
 *                        whose most recent `Source: 'credentials'` log entry has
 *                        `Severity: 'error'`. Both `'error'` and `'info'` entries
 *                        are evaluated — a newer `'info'` entry (written after a
 *                        successful credential-based clone) suppresses the issue.
 * @returns               A health report with a `healthy` flag and an array of issues.
 *
 * @remarks
 * **Stale credential-missing badge resolution:**
 * The credential check (Check 3) surfaces `credential-missing` issues only when
 * the *most recent* `Source: 'credentials'` entry for a repository has
 * `Severity: 'error'`. After a user assigns a credential and the next setup run
 * completes successfully, the orchestrators write a `Severity: 'info'` entry for
 * that repository. Because entries are returned newest-first and the Set
 * de-duplication keeps only the first (most recent) entry per repository, a
 * subsequent `'info'` entry suppresses the stale `'error'` — clearing the amber
 * badge without deleting history. If the credential is later removed and an error
 * entry is written again, that error entry re-surfaces the issue.
 */
export function checkWorkspaceHealth(
    projectId: string,
    workspaceId: string,
    projectsFolder: string,
    repositoryIds: string[],
    errorLogManager?: ErrorLogManager,
): WorkspaceHealthReport {
    const issues: WorkspaceHealthIssue[] = [];

    // Check 1: VS Code workspace file exists.
    const workspaceFilePath = getWorkspaceFilePath(projectsFolder, projectId, workspaceId);
    if (!fs.existsSync(workspaceFilePath)) {
        issues.push({
            type: 'workspace-file-missing',
            severity: 'warning',
            message: 'VS Code workspace file is missing.',
            fixAction: 'regenerate-workspace-file',
        });
    }

    // Check 2: Each repository has been cloned (has a .git subdirectory).
    for (const repoId of repositoryIds) {
        const repoPath = path.join(projectsFolder, projectId, workspaceId, repoId);
        if (!fs.existsSync(path.join(repoPath, '.git'))) {
            issues.push({
                type: 'repository-not-cloned',
                severity: 'warning',
                message: `Repository "${repoId}" is not cloned.`,
                fixAction: 'setup-workspace',
                repositoryId: repoId,
            });
        }
    }

    // Check 3: Generated index-file status (README.md / AGENTS.md / CLAUDE.md).
    // checkIndexFileStatus() already returns empty arrays when the workspace
    // folder does not exist, so no separate folder-existence branch is needed
    // here — an uninitialised workspace naturally reports no index issues.
    const indexStatus = checkIndexFileStatus(projectsFolder, projectId, workspaceId);
    if (indexStatus.missing.length > 0) {
        issues.push({
            type: 'workspace-index-missing',
            severity: 'warning',
            message: `Generated index file(s) missing: ${indexStatus.missing.join(', ')}.`,
            fixAction: 'regenerate-workspace-file',
        });
    }
    if (indexStatus.unmanaged.length > 0) {
        issues.push({
            type: 'workspace-index-unmanaged',
            severity: 'warning',
            message: `Index file(s) are hand-authored and not managed by paralizer: ${indexStatus.unmanaged.join(', ')}.`,
            // No automated fix is offered for a hand-authored file — regenerating
            // would either be a silent no-op (the writer already skips it) or,
            // if forced, would clobber content the user wrote deliberately.
            fixAction: 'none',
        });
    }

    // Check 4: (Optional) Credential-missing errors from the most recent credential operation.
    // Query all credential entries (both 'error' and 'info') for this workspace
    // and inspect the most recent entry per repository. A 'credential-missing'
    // health issue is only surfaced when the most recent entry has Severity: 'error'.
    // A newer Severity: 'info' entry (written after a successful credential-based
    // clone) suppresses the stale error badge without deleting history.
    // Entries are returned newest-first from errorLogManager.list(), so the Set
    // de-duplication naturally keeps only the most recent entry per repository.
    if (errorLogManager) {
        const { entries } = errorLogManager.list({ source: 'credentials' });

        // Filter to entries scoped to this workspace.
        const wsEntries = entries.filter(
            (e) =>
                e.Context.WorkspaceId === workspaceId &&
                e.Context.ProjectId === projectId &&
                e.Context.RepositoryId !== undefined,
        );

        // De-duplicate by repository ID, keeping only the most recent entry per repo.
        // Relies on errorLogManager.list() returning entries newest-first — see ErrorLogManager.list().
        // Only push a credential-missing issue when the most recent entry is an error.
        const seenRepos = new Set<string>();
        for (const entry of wsEntries) {
            const repoId = entry.Context.RepositoryId!;
            if (!seenRepos.has(repoId)) {
                seenRepos.add(repoId);
                if (entry.Severity === 'error') {
                    issues.push({
                        type: 'credential-missing',
                        severity: 'warning',
                        message: entry.Message,
                        fixAction: 'configure-credential',
                        repositoryId: repoId,
                    });
                }
                // Severity: 'info' means the most recent credential operation
                // succeeded — suppress any stale credential-missing badge.
            }
        }
    }

    return {
        healthy: issues.length === 0,
        issues,
    };
}

```
###  Path: `/src/orchestration/workspace-index.ts`

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    isLexicallyContained,
    resolveRootRealPath,
    escapesRootViaRealpath,
    isDirectoryShaped,
} from '../utils/path-guard.js';

/**
 * Base names of the three generated per-workspace index files, in the order
 * they are written by {@link writeWorkspaceIndexFiles} and probed by
 * {@link checkIndexFileStatus}.
 *
 * - `README.md` — human-facing index, browsed directly in the workspace folder.
 * - `AGENTS.md` — the same index plus an agent-directives block, loaded into an
 *   agent's context when it starts working in the folder.
 * - `CLAUDE.md` — a one-line `@AGENTS.md` pointer, mirroring the pattern this
 *   repository already uses at its own root, so agents without native
 *   `AGENTS.md` support still find the directives.
 */
export const WORKSPACE_INDEX_FILE_NAMES: readonly string[] = ['README.md', 'AGENTS.md', 'CLAUDE.md'];

/**
 * Marks the start of the block of each index file that is owned and
 * regenerated by this module. Text before this marker is preserved verbatim
 * across regenerations.
 */
export const GENERATED_BEGIN_MARKER = '<!-- paralizer:generated:begin -->';

/**
 * Marks the end of the generated block. Text after this marker is preserved
 * verbatim across regenerations.
 */
export const GENERATED_END_MARKER = '<!-- paralizer:generated:end -->';

/**
 * A single repository row rendered into the workspace index tables.
 */
export interface WorkspaceIndexRepositoryRow {
    /** Repository ID — also the folder name under the workspace folder. */
    id: string;

    /** Repository display name. */
    name: string;

    /** Repository description. Empty string when none is set. */
    description: string;

    /** Remote Git URL. */
    url: string;
}

/**
 * Everything the renderers need to produce the three index files for one
 * workspace. Callers (the artefact choke-point in `workspace-artifacts.ts`)
 * are responsible for resolving this context from the data layer; this
 * module never reads `ProjectManager`/`RepositoryManager` itself.
 */
export interface WorkspaceIndexContext {
    /** Root folder containing all project subdirectories. */
    projectsFolder: string;

    /** Project ID (also the per-project subdirectory name). */
    projectId: string;

    /** Project display name. */
    projectName: string;

    /** Project description. Empty string when none is set. */
    projectDescription: string;

    /** Workspace ID. */
    workspaceId: string;

    /** Workspace description. Empty string when none is set. */
    workspaceDescription: string;

    /** Workspace free-text notes. Empty string when none are set. */
    workspaceNotes: string;

    /** Repository rows, in the order they should appear in the table (`project.Repositories` order). */
    repositories: WorkspaceIndexRepositoryRow[];

    /** Absolute URL to this workspace's GUI page (built from `config.serverPort`). */
    guiUrl: string;

    /** The tool's own version, from `getToolVersion()`. */
    toolVersion: string;

    /** ISO 8601 timestamp recorded as the generation time. */
    generatedAt: string;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Neutralises a string for safe embedding as a single Markdown table cell.
 *
 * Escapes `|` (which would otherwise be interpreted as a column separator),
 * collapses CR/LF sequences to a single space (a raw newline inside a cell
 * breaks the row), and trims leading/trailing whitespace.
 *
 * Used for every user-supplied string embedded in the generated index body —
 * not only literal table cells — because a value containing an unescaped `|`
 * or newline placed anywhere near the table can also corrupt Markdown table
 * parsing in surrounding lines (AC-06).
 */
export function escapeMarkdownCell(value: string): string {
    return value
        .replace(/\|/g, '\\|')
        .replace(/\r\n|\r|\n/g, ' ')
        .trim();
}

/**
 * Renders the shared metadata + repository-table body used by both
 * `README.md` and `AGENTS.md`. Deterministic apart from `ctx.generatedAt`.
 */
function renderIndexBody(ctx: WorkspaceIndexContext): string {
    const lines: string[] = [];

    lines.push(`# ${escapeMarkdownCell(ctx.projectName)} — Workspace ${ctx.workspaceId}`);
    lines.push('');

    const projectDescription = escapeMarkdownCell(ctx.projectDescription);
    if (projectDescription !== '') {
        lines.push(projectDescription);
        lines.push('');
    }

    lines.push(`**Workspace:** ${ctx.workspaceId}`);

    const workspaceDescription = escapeMarkdownCell(ctx.workspaceDescription);
    if (workspaceDescription !== '') {
        lines.push('');
        lines.push(workspaceDescription);
    }

    const workspaceNotes = escapeMarkdownCell(ctx.workspaceNotes);
    if (workspaceNotes !== '') {
        lines.push('');
        lines.push(`**Notes:** ${workspaceNotes}`);
    }

    lines.push('');
    lines.push('## Repositories');
    lines.push('');
    lines.push('| Folder | Name | Description | Remote URL |');
    lines.push('|---|---|---|---|');

    for (const repo of ctx.repositories) {
        const name = escapeMarkdownCell(repo.name);
        const description = escapeMarkdownCell(repo.description);
        const url = escapeMarkdownCell(repo.url);
        lines.push(`| ${repo.id} | ${name} | ${description} | ${url} |`);
    }

    lines.push('');
    lines.push(`**GUI:** ${ctx.guiUrl}`);
    lines.push('');
    lines.push(`_Generated by paralizer ${ctx.toolVersion} at ${ctx.generatedAt}._`);

    return lines.join('\n');
}

/**
 * Directives block appended to `AGENTS.md` only. Deliberately excludes live
 * git state (branch, dirty status, ahead/behind) — the GUI owns that, and a
 * generated file reporting it would be wrong within minutes.
 */
const AGENT_DIRECTIVES_BLOCK = [
    '## Agent Directives',
    '',
    '- Each subfolder listed above is an independent git repository with its own instruction files (e.g. `AGENTS.md`, `CLAUDE.md`) that must be read before working in it.',
    '- Do not use relative imports across repository/folder boundaries.',
    '- Live branch, working-tree status, and ahead/behind counts are not tracked in this file — use the Paralizer GUI link above for current git state.',
    '- Content between the generated markers above is regenerated automatically; edits outside the markers are preserved.',
].join('\n');

/**
 * Renders the generated body of `README.md`: project/workspace metadata, the
 * repository table, and the GUI link. Omits the agent-directives block.
 */
export function renderWorkspaceReadme(ctx: WorkspaceIndexContext): string {
    return renderIndexBody(ctx);
}

/**
 * Renders the generated body of `AGENTS.md`: the same content as
 * {@link renderWorkspaceReadme} plus the agent-directives block.
 */
export function renderWorkspaceAgents(ctx: WorkspaceIndexContext): string {
    return `${renderIndexBody(ctx)}\n\n${AGENT_DIRECTIVES_BLOCK}`;
}

/**
 * Renders the generated body of `CLAUDE.md`: a single `@AGENTS.md` pointer
 * line, mirroring this repository's own root `CLAUDE.md`. Keeps the design
 * independent of any particular agent's native `AGENTS.md` support.
 */
export function renderClaudePointer(): string {
    return '@AGENTS.md';
}

// ---------------------------------------------------------------------------
// Marker detection (single implementation — shared by merge, remove, and
// the status probe, per AC-08 / AC-19)
// ---------------------------------------------------------------------------

/**
 * The single implementation of "does this file's content contain the
 * generated-block begin marker" — the predicate every other marker-aware
 * function in this module is built on.
 */
function hasBeginMarker(content: string): boolean {
    return content.includes(GENERATED_BEGIN_MARKER);
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merges a freshly rendered generated body into an existing file's content,
 * preserving everything outside the generated fence.
 *
 * - When `existing` is `null` (file does not yet exist), returns a new file
 *   consisting of exactly the fenced block.
 * - When `existing` contains no begin marker, it is treated as hand-authored:
 *   the content is returned unchanged and `skipped` is `true`.
 * - Otherwise, the region between the begin and end markers is replaced with
 *   `generatedBody`; text before the begin marker and after the end marker
 *   (if present) is preserved verbatim. When no end marker follows the begin
 *   marker, the fenced replacement extends to the end of the file.
 *
 * @param existing      - Current file content, or `null` if the file does not exist.
 * @param generatedBody - The freshly rendered content to place inside the fence.
 */
export function mergeGeneratedContent(
    existing: string | null,
    generatedBody: string,
): { content: string; skipped: boolean } {
    const fenced = `${GENERATED_BEGIN_MARKER}\n${generatedBody}\n${GENERATED_END_MARKER}`;

    if (existing === null) {
        return { content: `${fenced}\n`, skipped: false };
    }

    if (!hasBeginMarker(existing)) {
        return { content: existing, skipped: true };
    }

    const beginIdx = existing.indexOf(GENERATED_BEGIN_MARKER);
    const endIdx = existing.indexOf(GENERATED_END_MARKER, beginIdx);

    const before = existing.slice(0, beginIdx);
    const after = endIdx === -1 ? '' : existing.slice(endIdx + GENERATED_END_MARKER.length);

    return { content: `${before}${fenced}${after}`, skipped: false };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Resolves the workspace folder for `ctx.projectId` / `ctx.workspaceId` and
 * writes (or merges into) the three generated index files.
 *
 * - **No-op, no `mkdir`, when the workspace folder does not exist.** The
 *   folder's existence is a load-bearing signal elsewhere in the system (an
 *   uninitialised workspace is reported healthy, and the regenerate-file
 *   endpoint rejects it); writing an index file into a folder that does not
 *   exist would fabricate an initialised-looking workspace.
 * - For each of the three target files, runs — in order — the lexical
 *   containment check, the realpath symlink-escape check, and the
 *   directory-shape check, before any read or write. A target that fails any
 *   guard is reported in `skipped` rather than written, and never throws.
 * - A target that exists without the generated begin marker is treated as
 *   hand-authored: left untouched and reported in `skipped` (AC-08).
 *
 * @returns The base names written, and the base names skipped (guard
 *          rejection or hand-authored file), each drawn from
 *          {@link WORKSPACE_INDEX_FILE_NAMES}.
 */
export function writeWorkspaceIndexFiles(ctx: WorkspaceIndexContext): { written: string[]; skipped: string[] } {
    const workspaceFolder = path.join(ctx.projectsFolder, ctx.projectId, ctx.workspaceId);

    if (!fs.existsSync(workspaceFolder)) {
        return { written: [], skipped: [] };
    }

    // Two distinct roots are used by the two guards below, deliberately kept
    // separate rather than unified into one:
    // - `resolvedProjectsFolder` (lexical `path.resolve`, no symlink
    //   resolution) is compared against a target path built the same
    //   (lexical) way, so it catches a `..`-escaping `projectId`/`workspaceId`.
    // - `realProjectsFolder` (realpath) is compared against a realpath'd
    //   target ancestor, so it catches a symlink escape.
    // Comparing a realpath'd target against a lexical-only root (or vice
    // versa) would misfire on any system where the configured root itself
    // sits behind a symlink (e.g. macOS's `/tmp` -> `/private/tmp`), rejecting
    // every legitimate write.
    const resolvedProjectsFolder = path.resolve(ctx.projectsFolder);
    const realProjectsFolder = resolveRootRealPath(ctx.projectsFolder);

    const bodiesByName: Record<string, string> = {
        'README.md': renderWorkspaceReadme(ctx),
        'AGENTS.md': renderWorkspaceAgents(ctx),
        'CLAUDE.md': renderClaudePointer(),
    };

    const written: string[] = [];
    const skipped: string[] = [];

    for (const name of WORKSPACE_INDEX_FILE_NAMES) {
        const targetPath = path.join(workspaceFolder, name);
        const resolvedTarget = path.resolve(targetPath);

        if (!isLexicallyContained(resolvedTarget, resolvedProjectsFolder)) {
            skipped.push(name);
            continue;
        }

        if (escapesRootViaRealpath(resolvedTarget, realProjectsFolder)) {
            skipped.push(name);
            continue;
        }

        if (isDirectoryShaped(resolvedTarget)) {
            skipped.push(name);
            continue;
        }

        let existing: string | null = null;
        if (fs.existsSync(targetPath)) {
            try {
                existing = fs.readFileSync(targetPath, 'utf8');
            } catch {
                // Unreadable existing file — treat conservatively as
                // hand-authored/unmanaged rather than risking clobbering it.
                skipped.push(name);
                continue;
            }
        }

        const { content, skipped: mergeSkipped } = mergeGeneratedContent(existing, bodiesByName[name]);
        if (mergeSkipped) {
            skipped.push(name);
            continue;
        }

        fs.writeFileSync(targetPath, content, 'utf8');
        written.push(name);
    }

    return { written, skipped };
}

// ---------------------------------------------------------------------------
// Remover
// ---------------------------------------------------------------------------

/**
 * Removes the generated index files for a workspace.
 *
 * Only removes a file that contains the generated begin marker; a
 * hand-authored file (no marker) is left in place, mirroring the writer's
 * skip guarantee (AC-08). Tolerates a missing workspace folder or a missing
 * individual file (`ENOENT`) as a silent no-op for that file.
 */
export function removeWorkspaceIndexFiles(projectsFolder: string, projectId: string, workspaceId: string): void {
    const workspaceFolder = path.join(projectsFolder, projectId, workspaceId);

    for (const name of WORKSPACE_INDEX_FILE_NAMES) {
        const targetPath = path.join(workspaceFolder, name);

        let content: string;
        try {
            content = fs.readFileSync(targetPath, 'utf8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw err;
        }

        if (!hasBeginMarker(content)) continue;

        try {
            fs.rmSync(targetPath);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw err;
        }
    }
}

// ---------------------------------------------------------------------------
// Status probe
// ---------------------------------------------------------------------------

/**
 * Read-only status probe for the three generated index files, consumed by
 * `checkWorkspaceHealth()`. Shares {@link hasBeginMarker} — the module's one
 * marker-detection primitive — with {@link mergeGeneratedContent} and
 * {@link removeWorkspaceIndexFiles}, so a file reported here as `unmanaged`
 * is guaranteed to be the same file the writer would report as skipped
 * (AC-08, AC-19).
 *
 * Classifies each file in {@link WORKSPACE_INDEX_FILE_NAMES} as:
 * - **missing** — absent from disk;
 * - **present-managed** — exists and contains the begin marker (listed in
 *   neither returned array);
 * - **present-unmanaged** — exists without the begin marker (hand-authored).
 *
 * Returns both arrays empty when the workspace folder does not exist, so
 * callers need no separate folder-existence branch. Performs no writes and
 * no `mkdir`.
 */
export function checkIndexFileStatus(
    projectsFolder: string,
    projectId: string,
    workspaceId: string,
): { missing: string[]; unmanaged: string[] } {
    const workspaceFolder = path.join(projectsFolder, projectId, workspaceId);

    const missing: string[] = [];
    const unmanaged: string[] = [];

    if (!fs.existsSync(workspaceFolder)) {
        return { missing, unmanaged };
    }

    for (const name of WORKSPACE_INDEX_FILE_NAMES) {
        const targetPath = path.join(workspaceFolder, name);

        if (!fs.existsSync(targetPath)) {
            missing.push(name);
            continue;
        }

        let content: string;
        try {
            content = fs.readFileSync(targetPath, 'utf8');
        } catch {
            // Unreadable — treat conservatively as unmanaged rather than
            // throwing out of a documented side-effect-free status probe.
            unmanaged.push(name);
            continue;
        }

        if (!hasBeginMarker(content)) {
            unmanaged.push(name);
        }
    }

    return { missing, unmanaged };
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
import { resolveCredential, injectCredentialToken, extractHost, stripEmbeddedCredentials } from '../git/git-credentials.js';
import type { WorkspaceArtifactsOrchestrator } from './workspace-artifacts.js';
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
        private readonly workspaceArtifacts: WorkspaceArtifactsOrchestrator,
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
     * @remarks **Credential coherence:** When a repository has an explicit
     *   `CredentialId`, `resolveCredential()` performs only an ID lookup and does
     *   **not** cross-validate the credential's configured host against the
     *   repository URL's hostname. The `credential-options` endpoint already
     *   filters available credentials by host, so mismatches are unlikely in
     *   practice — but callers that set `CredentialId` programmatically must
     *   ensure coherence themselves.
     *   See {@link resolveCredential} for the full security note.
     * @remarks **Credential success logging:** After a successful credential-based
     *   clone (`credential !== null`), a `Source: 'credentials'`, `Severity: 'info'`
     *   log entry is written. This allows `checkWorkspaceHealth()` to suppress
     *   stale `credential-missing` badges by inspecting the most recent entry per
     *   repository.
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

                const credentials = this.config.gitCredentials ?? [];
                const credential = resolveCredential(repo.Url, credentials, repo.CredentialId);
                const host = extractHost(repo.Url);

                // When no credential resolves for an HTTPS URL, report a descriptive
                // error rather than attempting an unauthenticated clone that would
                // likely fail with an unhelpful git error message.
                if (credential === null && host !== null) {
                    const errorMessage =
                        `Repository '${repo.Name}' requires a credential for host '${host}'. ` +
                        `Please select a credential in the repository settings.`;
                    this.errorLogManager?.append({
                        Severity: 'error',
                        Source: 'credentials',
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

                const cloneUrl = credential !== null
                    ? injectCredentialToken(repo.Url, credential.token)
                    : repo.Url;

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

                // Write a credential success entry so that checkWorkspaceHealth()
                // can suppress stale credential-missing badges for this repository.
                if (credential !== null) {
                    this.errorLogManager?.append({
                        Severity: 'info',
                        Source: 'credentials',
                        Operation: 'workspace-setup',
                        Context: { ProjectId: projectId, WorkspaceId: workspaceId, RepositoryId: repoId },
                        Message: `Repository '${repo.Name}' cloned successfully using credential '${credential.label}'.`,
                    });
                }

                return { repositoryId: repoId, success: true };
            }),
        );

        this.workspaceArtifacts.regenerateWorkspace(projectId, workspaceId);

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

        this.workspaceArtifacts.removeWorkspace(projectId, workspaceId);
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

        // Regenerate the full artefact set (`.code-workspace` + index files)
        // under the new workspace ID, then remove the old artefact set. The
        // pre-rename `ProjectWorkspace` entry is passed explicitly because
        // `project.Workspaces[newId]` does not exist until
        // `workspaceManager.rename()` runs below — see
        // `RegenerateWorkspaceOverrides.workspaceMeta`.
        this.workspaceArtifacts.regenerateWorkspace(projectId, newId, {
            workspaceMeta: project.Workspaces[oldId],
        });
        this.workspaceArtifacts.removeWorkspace(projectId, oldId);

        // Update the workspace data entry (also validates newId format/uniqueness).
        this.workspaceManager.rename(projectId, oldId, newId);
    }
}

```
---
**File Statistics**
- **Size**: 94.42 KB
- **Lines**: 2270
File: `modules/orchestration/architecture-core.md`
