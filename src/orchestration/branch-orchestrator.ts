import * as path from 'path';
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

/**
 * High-level orchestrator for branch operations across all repositories in a
 * workspace. Composes the stateless git layer with data-model reads/writes.
 */
export class BranchOrchestrator {
    constructor(
        private readonly config: AppConfig,
        private readonly projectManager: ProjectManager,
        private readonly workspaceManager: WorkspaceManager,
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
                        results[repoId] = {
                            success: false,
                            conflict: hasConflict,
                            error: gitResult.stderr.trim() || `git exited with code ${gitResult.exitCode}`,
                        };
                    }
                } catch (err) {
                    results[repoId] = {
                        success: false,
                        conflict: false,
                        error: (err as Error).message,
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
