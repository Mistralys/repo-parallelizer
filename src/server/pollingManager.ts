import * as path from 'node:path';
import type { AppConfig } from '../config/config.types.js';
import type { ProjectManager } from '../models/project/project.manager.js';
import type { WorkspaceManager } from '../models/workspace/workspace.manager.js';
import type { GitStatusInfo } from '../git/git.types.js';
import { fetchAndGetStatus } from '../git/git-status.js';

/**
 * Signature of the function used to fetch live status for a single repo path.
 * Exposed as a type alias so tests can substitute a mock without touching the
 * real git layer.
 */
export type FetchStatusFn = (repoPath: string) => Promise<GitStatusInfo>;

/**
 * Small per-repo stagger applied between successive fetch calls within a
 * single poll sweep.  Spreading I/O over 150 ms per repo prevents
 * thundering-herd spikes when a workspace has many repositories.
 */
const STAGGER_MS = 150;

/**
 * Manages a background polling loop that keeps an in-memory cache of
 * `GitStatusInfo` values up-to-date for every repository in every workspace
 * of every project.
 *
 * ## Lifecycle
 *
 * ```
 * const mgr = new PollingManager(config, projectManager, workspaceManager);
 * mgr.start(30);            // poll every 30 seconds
 * mgr.getStatus('/path');   // O(1) cache read
 * await mgr.refreshWorkspace('my-project', 'STABLE');  // on-demand refresh
 * mgr.stop();               // cancel the background loop
 * ```
 *
 * ## Staggered fetches
 *
 * Within each poll sweep the manager introduces a small per-repo delay
 * (`STAGGER_MS`) between successive `fetchAndGetStatus` calls so that
 * all repositories are *not* hammered simultaneously.  The stagger is
 * applied in insertion order; no delay is added before the first repo.
 *
 * ## Dependency injection
 *
 * `fetchStatusFn` defaults to the real `fetchAndGetStatus` from the git layer.
 * Tests may pass a mock to avoid real git I/O.
 */
export class PollingManager {
    /** In-memory cache: absolute repo path → latest status snapshot. */
    private readonly cache = new Map<string, GitStatusInfo>();

    /** Node.js interval handle returned by `setInterval`. */
    private intervalHandle: ReturnType<typeof setInterval> | null = null;

    /** True while a poll sweep is already running (prevents overlap). */
    private sweepInProgress = false;

    constructor(
        private readonly config: AppConfig,
        private readonly projectManager: ProjectManager,
        private readonly workspaceManager: WorkspaceManager,
        private readonly fetchStatusFn: FetchStatusFn = fetchAndGetStatus,
    ) {}

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Starts the background polling loop.
     *
     * If `start()` is called while the loop is already running it is a no-op —
     * the existing interval is preserved and not reset.
     *
     * @param intervalSeconds  How often (in seconds) to run a full poll sweep.
     */
    start(intervalSeconds: number): void {
        if (this.intervalHandle !== null) {
            return; // already running
        }

        const intervalMs = intervalSeconds * 1000;

        this.intervalHandle = setInterval(() => {
            if (this.sweepInProgress) return; // skip overlapping sweeps
            this.sweepInProgress = true;
            this.runSweep().finally(() => {
                this.sweepInProgress = false;
            });
        }, intervalMs);

        // Allow Node.js to exit even if the interval is still active
        if (typeof this.intervalHandle.unref === 'function') {
            this.intervalHandle.unref();
        }
    }

    /**
     * Stops the background polling loop.
     *
     * Any sweep already in progress continues to completion (its cache writes
     * are harmless); no further sweeps will be scheduled after `stop()` returns.
     * Calling `stop()` when the loop is not running is a no-op.
     */
    stop(): void {
        if (this.intervalHandle !== null) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
    }

    /**
     * Returns the most recently cached `GitStatusInfo` for the given absolute
     * repo path, or `null` if the repo has not been polled yet.
     */
    getStatus(repoPath: string): GitStatusInfo | null {
        return this.cache.get(repoPath) ?? null;
    }

    /**
     * Fetches live status for every repository in the specified workspace,
     * updates the in-memory cache with the results, and resolves when all
     * fetches have completed.
     *
     * Fetches are staggered by `STAGGER_MS` to avoid hammering the network.
     * Individual fetch failures are silently swallowed so that a single
     * unreachable repository does not prevent the others from being updated.
     *
     * @throws {Error} If the project or workspace does not exist (propagated
     *   from `WorkspaceManager`).
     */
    async refreshWorkspace(projectId: string, workspaceId: string): Promise<void> {
        const repoPaths = this.getRepoPaths(projectId, workspaceId);
        await this.fetchWithStagger(repoPaths);
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /**
     * Collects the absolute paths of all repositories that belong to the given
     * workspace.  The path convention mirrors `WorkspaceOrchestrator.repoPath()`:
     *   `{projectsFolder}/{projectId}/{workspaceId}/{repoId}`
     */
    private getRepoPaths(projectId: string, workspaceId: string): string[] {
        const project = this.projectManager.getById(projectId);
        if (!project) {
            throw new Error(
                `PollingManager: project "${projectId}" does not exist.`,
            );
        }
        // Validate the workspace exists
        const ws = this.workspaceManager.getById(projectId, workspaceId);
        if (!ws) {
            throw new Error(
                `PollingManager: workspace "${workspaceId}" does not exist in project "${projectId}".`,
            );
        }

        return project.Repositories.map((repoId) =>
            path.join(this.config.projectsFolder, projectId, workspaceId, repoId),
        );
    }

    /**
     * Collects the absolute paths of every repository in every workspace of
     * every project that currently exists in the data store.
     */
    private getAllRepoPaths(): string[] {
        const repoPaths: string[] = [];
        for (const entry of this.projectManager.list()) {
            const project = this.projectManager.getById(entry.Id);
            if (!project) continue;
            for (const workspaceId of Object.keys(project.Workspaces)) {
                for (const repoId of project.Repositories) {
                    repoPaths.push(
                        path.join(
                            this.config.projectsFolder,
                            entry.Id,
                            workspaceId,
                            repoId,
                        ),
                    );
                }
            }
        }
        return repoPaths;
    }

    /**
     * Fetches status for each repo path sequentially with a `STAGGER_MS` delay
     * between calls.  Errors from individual fetches are caught and ignored so
     * that one failing repo does not abort the rest.
     */
    private async fetchWithStagger(repoPaths: string[]): Promise<void> {
        for (let i = 0; i < repoPaths.length; i++) {
            if (i > 0) {
                await delay(STAGGER_MS);
            }
            const repoPath = repoPaths[i];
            try {
                const status = await this.fetchStatusFn(repoPath);
                this.cache.set(repoPath, status);
            } catch {
                // Silently ignore errors for individual repos (e.g. unreachable)
            }
        }
    }

    /**
     * One full poll sweep: fetches staggered status for every repo path across
     * all projects and workspaces.
     */
    private async runSweep(): Promise<void> {
        const repoPaths = this.getAllRepoPaths();
        await this.fetchWithStagger(repoPaths);
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
