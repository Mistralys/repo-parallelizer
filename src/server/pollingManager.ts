import * as path from 'node:path';
import type { AppConfig } from '../config/config.types.js';
import type { ProjectManager } from '../models/project/project.manager.js';
import type { WorkspaceManager } from '../models/workspace/workspace.manager.js';
import type { GitStatusInfo } from '../git/git.types.js';
import { fetchAndGetStatus } from '../git/git-status.js';
import type { ErrorLogManager } from '../error-log/error-log.manager.js';
import type { ErrorLogContext } from '../error-log/error-log.types.js';

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
 * const mgr = new PollingManager(
 *     config,
 *     projectManager,
 *     workspaceManager,
 *     undefined,          // fetchStatusFn — omit to use the real git layer
 *     errorLogManager,    // optional; omit to run without error logging
 * );
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
 *
 * `errorLogManager` is an optional `ErrorLogManager` instance.  When provided,
 * fetch failures are logged at warning severity with source `'polling'` and
 * operation `'status-poll'`.  Deduplication ensures at most one log entry per
 * repo path per sweep-to-sweep cycle; entries are cleared when the repo
 * recovers so subsequent failures still produce a log entry.
 */
export class PollingManager {
    /** In-memory cache: absolute repo path → latest status snapshot. */
    private readonly cache = new Map<string, GitStatusInfo>();

    /** Node.js interval handle returned by `setInterval`. */
    private intervalHandle: ReturnType<typeof setInterval> | null = null;

    /** True while a poll sweep is already running (prevents overlap). */
    private sweepInProgress = false;

    /**
     * Tracks repo paths that have already produced an error log entry in the
     * current or most recent sweep cycle.  Prevents flooding the log with
     * repeated entries for persistently unreachable repositories.
     *
     * A path is removed when the repo recovers (successful fetch), so the
     * next failure will produce a fresh log entry.
     */
    private readonly failedPaths = new Set<string>();

    constructor(
        private readonly config: AppConfig,
        private readonly projectManager: ProjectManager,
        private readonly workspaceManager: WorkspaceManager,
        private readonly fetchStatusFn: FetchStatusFn = fetchAndGetStatus,
        private readonly errorLogManager?: ErrorLogManager,
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
     * Restarts the background polling loop with a new interval.
     *
     * Stops the current loop (if running) and immediately starts a new one with
     * `intervalSeconds`.  This is the correct way to apply a live interval change
     * without creating a new `PollingManager` instance.
     *
     * @param intervalSeconds  The new polling interval in seconds.
     */
    restart(intervalSeconds: number): void {
        this.stop();
        this.start(intervalSeconds);
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
     * Individual fetch failures are swallowed so that a single unreachable
     * repository does not prevent the others from being updated.  When an
     * `ErrorLogManager` is configured, failures are logged (with deduplication).
     *
     * @throws {Error} If the project or workspace does not exist (propagated
     *   from `WorkspaceManager`).
     */
    async refreshWorkspace(projectId: string, workspaceId: string): Promise<void> {
        const repoPaths = this.getRepoPaths(projectId, workspaceId);
        await this.fetchWithStagger(repoPaths);
        this.persistLastActivity();
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
     * Iterates the current cache, computes the maximum `lastActivity` ISO
     * timestamp for each project, and calls `projectManager.updateLastActivity()`
     * for every project that has at least one cached entry with a non-null
     * `lastActivity`.
     *
     * Projects where every cached entry has `null` `lastActivity` are skipped.
     * Cache entries whose repo path cannot be parsed by `extractContext()` (i.e.
     * the function returns an empty object with no `ProjectId`) are ignored
     * silently.
     *
     * @remarks
     * The "maximum" timestamp is determined by lexicographic string comparison,
     * which is correct for ISO 8601 strings that share a **consistent timezone
     * offset** (e.g. all `Z`).  All `lastActivity` values originate from git
     * commit timestamps that the git layer normalises to a single offset, so
     * this comparison is safe.  Introducing mixed offsets (e.g. `'Z'` alongside
     * `'+05:00'`) would produce incorrect max results — do not relax the
     * normalisation constraint in the git layer without updating this method.
     */
    private persistLastActivity(): void {
        // Build a per-project map of the maximum lastActivity timestamp.
        const maxByProject = new Map<string, string>();

        for (const [repoPath, status] of this.cache) {
            if (status.lastActivity === null) {
                continue;
            }
            const context = extractContext(repoPath, this.config.projectsFolder);
            if (!context.ProjectId) {
                continue;
            }
            const projectId = context.ProjectId;
            const existing = maxByProject.get(projectId);
            // ISO 8601 strings with a consistent timezone offset (e.g. always 'Z')
            // sort correctly with lexicographic comparison.  All lastActivity values
            // originate from git commit timestamps normalised to a single offset, so
            // this comparison is safe.  Mixed offsets (e.g. 'Z' vs '+05:00') would
            // produce incorrect results — do not relax the normalisation constraint.
            if (existing === undefined || status.lastActivity > existing) {
                maxByProject.set(projectId, status.lastActivity);
            }
        }

        for (const [projectId, maxTimestamp] of maxByProject) {
            this.projectManager.updateLastActivity(projectId, maxTimestamp);
        }
    }

    /**
     * Fetches status for each repo path sequentially with a `STAGGER_MS` delay
     * between calls.  Errors from individual fetches are caught and, when an
     * `ErrorLogManager` is configured, logged at warning severity with
     * deduplication — at most one log entry per repo path per sweep-to-sweep
     * cycle.  A previously failing repo that recovers is removed from the dedup
     * set so that a future failure can produce a new entry.
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
                // Recovery: clear the dedup flag so the next failure is logged.
                this.failedPaths.delete(repoPath);
            } catch (err) {
                // Log at most one warning per repo path per sweep cycle.
                if (this.errorLogManager && !this.failedPaths.has(repoPath)) {
                    const context = extractContext(repoPath, this.config.projectsFolder);
                    const message = err instanceof Error ? err.message : String(err);
                    this.errorLogManager.append({
                        Severity: 'warning',
                        Source: 'polling',
                        Operation: 'status-poll',
                        Context: context,
                        Message: `Failed to fetch status for repository: ${message}`,
                        Details: `Repository path: ${repoPath}`,
                    });
                    this.failedPaths.add(repoPath);
                }
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
        this.persistLastActivity();
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Extracts `ProjectId`, `WorkspaceId`, and `RepositoryId` from an absolute
 * repo path by resolving it relative to `projectsFolder` and splitting on the
 * OS path separator.
 *
 * Assumes the convention:
 *   `{projectsFolder}/{projectId}/{workspaceId}/{repoId}`
 *
 * Returns an empty `ErrorLogContext` object if the path cannot be parsed
 * (e.g. the path is not under `projectsFolder`, or has fewer than 3 segments).
 */
function extractContext(
    repoPath: string,
    projectsFolder: string,
): ErrorLogContext {
    const relative = path.relative(projectsFolder, repoPath);
    const segments = relative.split(path.sep).filter(Boolean);
    if (segments.length < 3) {
        return {};
    }
    const [projectId, workspaceId, repositoryId] = segments;
    return {
        ProjectId: projectId,
        WorkspaceId: workspaceId,
        RepositoryId: repositoryId,
    };
}
