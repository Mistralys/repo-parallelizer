# Server - Architecture Core
_SOURCE: Server infrastructure: router, static serving, polling, request utilities_
# Server infrastructure: router, static serving, polling, request utilities
```
// Structure of documents
└── src/
    └── server/
        └── index.ts
        └── pollingManager.ts
        └── requestUtils.ts
        └── router.ts
        └── staticServer.ts

```
###  Path: `/src/server/index.ts`

```ts
import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from '../config/config.types.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { ProjectManager } from '../models/project/project.manager.js';
import { WorkspaceManager } from '../models/workspace/workspace.manager.js';
import { WorkspaceOrchestrator } from '../orchestration/workspace-orchestrator.js';
import { BranchOrchestrator } from '../orchestration/branch-orchestrator.js';
import { ErrorLogManager } from '../error-log/error-log.manager.js';
import { PollingManager } from './pollingManager.js';
import { Router } from './router.js';
import { serveStatic } from './staticServer.js';
import { sendError } from './requestUtils.js';
import { registerRepositoryRoutes } from './routes/repositories.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerBranchRoutes } from './routes/branches.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerErrorLogRoutes } from './routes/error-log.js';
import { migrateWorkspaceFiles } from '../orchestration/vscode-workspace.js';

// ---------------------------------------------------------------------------
// Public configuration type
// ---------------------------------------------------------------------------

/**
 * Configuration accepted by `startServer()`.
 *
 * Most fields are pulled directly from `AppConfig`; `serverPort` and
 * `pollIntervalSeconds` can be overridden here so callers (especially tests)
 * can spin up an ephemeral server on port 0 without editing the full config.
 */
export interface ServerConfig {
    /** TCP port to listen on.  Defaults to `config.serverPort ?? 4200`. */
    serverPort?: number;
    /** Absolute path to the directory of static files to serve. */
    staticDir: string;
    /** How often (in seconds) to poll git remotes.  Defaults to 30. */
    pollIntervalSeconds?: number;
    /** Full application config forwarded to managers / orchestrators. */
    appConfig: AppConfig;
}

// ---------------------------------------------------------------------------
// Module-level state  (one server instance at a time)
// ---------------------------------------------------------------------------
//
// Only a single HTTP server and a single PollingManager can be active per
// Node.js process.  This is intentional for the CLI use case.
//
// **Test authors:** always call `await stopServer()` in an `afterEach` /
// `afterAll` hook to release the port and reset these references before the
// next test suite starts a fresh server.

let _server: http.Server | null = null;
let _pollingManager: PollingManager | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Wires all server components together, starts listening, and kicks off the
 * background polling loop.
 *
 * The returned promise resolves once the server is actually listening on the
 * chosen port (i.e. after the `listening` event fires).
 *
 * If the port is already in use (`EADDRINUSE`), the promise rejects with a
 * descriptive `Error` and an actionable log message is printed to stderr.
 *
 * Calling `startServer()` while a server is already running throws
 * synchronously.
 *
 * Internally creates an `ErrorLogManager` shared across all subsystems
 * (WorkspaceOrchestrator, BranchOrchestrator, PollingManager, and Router);
 * no external reference is returned.
 */
export function startServer(config: ServerConfig): Promise<void> {
    if (_server !== null) {
        throw new Error('Server is already running. Call stopServer() first.');
    }

    const port = config.serverPort ?? config.appConfig.serverPort ?? 4200;
    const pollInterval = config.pollIntervalSeconds ?? config.appConfig.gitPollingIntervalSeconds ?? 30;

    // ------------------------------------------------------------------
    // Instantiate managers & orchestrators
    // ------------------------------------------------------------------
    const repoManager = new RepositoryManager(config.appConfig);
    const projectManager = new ProjectManager(config.appConfig, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);
    const errorLogManager = new ErrorLogManager(config.appConfig);
    const workspaceOrchestrator = new WorkspaceOrchestrator(
        config.appConfig,
        projectManager,
        workspaceManager,
        repoManager,
        errorLogManager,
    );
    const branchOrchestrator = new BranchOrchestrator(
        config.appConfig,
        projectManager,
        workspaceManager,
        errorLogManager,
    );
    const pollingManager = new PollingManager(
        config.appConfig,
        projectManager,
        workspaceManager,
        undefined,       // fetchStatusFn — use the default real git layer
        errorLogManager,
    );

    // ------------------------------------------------------------------
    // One-time migration: move .code-workspace files from flat layout to
    // per-project subdirectory layout (idempotent, safe to run every startup).
    // ------------------------------------------------------------------
    const projectSlugs = projectManager.list().map((p) => p.Id);
    const migratedCount = migrateWorkspaceFiles(config.appConfig.projectsFolder, projectSlugs);
    if (migratedCount > 0) {
        process.stdout.write(
            `[repo-parallelizer] Migrated ${migratedCount} workspace file(s) to per-project subdirectories.\n`,
        );
    }

    // ------------------------------------------------------------------
    // Build the router and register all route groups
    // ------------------------------------------------------------------
    const router = new Router();
    router.setErrorLogManager(errorLogManager);
    registerRepositoryRoutes(router, repoManager);
    registerProjectRoutes(router, projectManager);
    registerWorkspaceRoutes(router, workspaceManager, workspaceOrchestrator, config.appConfig, projectManager);
    registerBranchRoutes(router, branchOrchestrator, workspaceManager);
    registerStatusRoutes(router, pollingManager, projectManager, workspaceManager, config.appConfig);
    registerConfigRoutes({ router, appConfig: config.appConfig, pollingManager });
    registerErrorLogRoutes(router, errorLogManager);

    // ------------------------------------------------------------------
    // Create HTTP server with the static-first request pipeline
    // ------------------------------------------------------------------
    const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
        // Static files are checked first; if the file exists it is served and
        // we return immediately without consulting the router.
        serveStatic(req, res, config.staticDir)
            .then((served) => {
                if (!served) {
                    // Not a static file — hand off to the API router.
                    // The router writes its own 404 when nothing matches.
                    router.handle(req, res);
                }
            })
            .catch(() => {
                // Should not happen (serveStatic only rejects on programmer
                // error), but guard anyway to avoid unhandled-rejection noise.
                sendError(res, 500, 'Internal server error.');
            });
    });

    // ------------------------------------------------------------------
    // Return a promise that resolves on 'listening' and rejects on error
    // ------------------------------------------------------------------
    return new Promise<void>((resolve, reject) => {
        server.once('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'EADDRINUSE') {
                process.stderr.write(
                    `[repo-parallelizer] ERROR: Port ${port} is already in use.\n` +
                    `  Try a different port by setting "serverPort" in your config.json.\n`,
                );
            }
            reject(err);
        });

        server.listen(port, '127.0.0.1', () => {
            // Store module-level references so stopServer() can reach them.
            _server = server;
            _pollingManager = pollingManager;

            // Kick off the background git polling loop.
            pollingManager.start(pollInterval);

            resolve();
        });
    });
}

/**
 * Gracefully shuts down the HTTP listener and stops the background polling
 * loop.  Resolves when the server has fully closed.
 *
 * Safe to call before any requests have been served.  If no server is
 * currently running this function is a no-op and resolves immediately.
 */
export function stopServer(): Promise<void> {
    // Stop polling immediately (synchronous, safe to call multiple times).
    if (_pollingManager !== null) {
        _pollingManager.stop();
        _pollingManager = null;
    }

    if (_server === null) {
        return Promise.resolve();
    }

    const server = _server;
    _server = null;

    return new Promise<void>((resolve, reject) => {
        server.close((err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

```
###  Path: `/src/server/pollingManager.ts`

```ts
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

```
###  Path: `/src/server/requestUtils.ts`

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';

const BODY_LIMIT = 1 * 1024 * 1024; // 1 MB

/**
 * Reads the body of an IncomingMessage, enforces a 1 MB size limit, and
 * resolves with the parsed JSON object.  Rejects with a descriptive error
 * if the body exceeds the limit or contains malformed JSON.
 */
export function parseJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let settled = false;

        function fail(err: Error): void {
            if (!settled) {
                settled = true;
                reject(err);
            }
        }

        req.on('data', (chunk: Buffer) => {
            if (settled) return;
            totalBytes += chunk.length;
            if (totalBytes > BODY_LIMIT) {
                // Destroy the stream so no further 'data' events fire.
                // We set `settled` before calling destroy() so the 'error'
                // event that some stream implementations emit on destroy does
                // not race against our own rejection.
                settled = true;
                req.destroy();
                reject(new Error(`Request body exceeds the 1 MB limit`));
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => {
            if (settled) return;
            const raw = Buffer.concat(chunks).toString('utf8');
            try {
                resolve(JSON.parse(raw));
                settled = true;
            } catch {
                fail(new Error(`Invalid JSON body: ${raw.slice(0, 120)}`));
            }
        });

        req.on('error', (err: Error) => {
            fail(new Error(`Error reading request body: ${err.message}`));
        });
    });
}

/**
 * Writes a JSON response with the given HTTP status code.
 * Always sets `Content-Type: application/json`.
 */
export function sendJson(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

/**
 * Sends a JSON error response with the shape `{ error: string }`.
 */
export function sendError(res: ServerResponse, status: number, message: string): void {
    sendJson(res, status, { error: message });
}

/**
 * Matches `url` against a `:named`-segment pattern (e.g. `/repos/:id/branches/:branch`)
 * and returns an object mapping each named segment to its captured value.
 * Returns `null` when the URL does not match the pattern.
 *
 * Only the **pathname** portion of the URL is compared — query strings and
 * trailing slashes on the pattern side are not supported.
 *
 * Examples:
 *   extractParams('/repos/:id', '/repos/42')         → { id: '42' }
 *   extractParams('/repos/:id', '/repos/42/extra')   → null
 *   extractParams('/repos/:id', '/other/42')         → null
 */
export function extractParams(
    pattern: string,
    url: string,
): Record<string, string> | null {
    // Strip query string from the incoming URL
    const pathname = url.split('?')[0];

    const patternSegments = pattern.split('/');
    const urlSegments = pathname.split('/');

    if (patternSegments.length !== urlSegments.length) {
        return null;
    }

    const params: Record<string, string> = {};

    for (let i = 0; i < patternSegments.length; i++) {
        const p = patternSegments[i];
        const u = urlSegments[i];

        if (p.startsWith(':')) {
            // Named parameter — capture the value
            const name = p.slice(1);
            params[name] = u;
        } else if (p !== u) {
            // Static segment mismatch
            return null;
        }
    }

    return params;
}

/**
 * Narrows an `unknown` value to an object (not null, not an array).
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

```
###  Path: `/src/server/router.ts`

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extractParams, sendError } from './requestUtils.js';
import type { ErrorLogManager } from '../error-log/error-log.manager.js';

/** Handler function signature used for all registered routes. */
export type RouteHandler = (
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
) => void | Promise<void>;

/** Internal entry stored for each registered route. */
interface RouteEntry {
    method: string;
    pattern: string;
    handler: RouteHandler;
}

/**
 * Lightweight HTTP router for the Node.js built-in `http` server.
 *
 * Register routes with `get`, `post`, `put`, or `delete`, then call
 * `handle(req, res)` from your `http.createServer` callback.
 *
 * Routing rules:
 *  - Exact-method + pattern match  → handler is invoked with extracted params.
 *  - Path matches but wrong method → 405 JSON with correct `Allow` header.
 *  - No path match at all          → 404 JSON.
 *
 * Optionally supply an {@link ErrorLogManager} via {@link Router.setErrorLogManager}
 * to capture unhandled handler rejections in the error log.
 *
 * **Public methods:**
 * - {@link Router.get}, {@link Router.post}, {@link Router.put}, {@link Router.delete} — register route handlers.
 * - {@link Router.handle} — dispatch an incoming request.
 * - {@link Router.setErrorLogManager} — attach an {@link ErrorLogManager} for rejection logging.
 */
export class Router {
    private readonly routes: RouteEntry[] = [];
    private errorLogManager: ErrorLogManager | undefined;

    /**
     * Attaches an {@link ErrorLogManager} to the router.
     *
     * When set, any unhandled rejection from a route handler is appended to the
     * error log with `source: 'route-handler'` and `operation` set to the
     * request URL. The existing behavior of not sending an additional error
     * response to the client is preserved.
     */
    setErrorLogManager(manager: ErrorLogManager): void {
        this.errorLogManager = manager;
    }

    // ------------------------------------------------------------------
    // Registration helpers
    // ------------------------------------------------------------------

    get(pattern: string, handler: RouteHandler): this {
        return this.register('GET', pattern, handler);
    }

    post(pattern: string, handler: RouteHandler): this {
        return this.register('POST', pattern, handler);
    }

    put(pattern: string, handler: RouteHandler): this {
        return this.register('PUT', pattern, handler);
    }

    delete(pattern: string, handler: RouteHandler): this {
        return this.register('DELETE', pattern, handler);
    }

    private register(method: string, pattern: string, handler: RouteHandler): this {
        this.routes.push({ method, pattern, handler });
        return this;
    }

    // ------------------------------------------------------------------
    // Dispatch
    // ------------------------------------------------------------------

    /**
     * Dispatches the incoming request to the first matching handler.
     *
     * Pass this method as the `http.createServer` callback (or call it from
     * within one):
     *
     * ```ts
     * const server = http.createServer((req, res) => router.handle(req, res));
     * ```
     */
    handle(req: IncomingMessage, res: ServerResponse): void {
        const url = req.url ?? '/';
        const method = (req.method ?? 'GET').toUpperCase();

        // Track which methods are registered for the matched path (for 405).
        const allowedMethods: string[] = [];

        for (const entry of this.routes) {
            const params = extractParams(entry.pattern, url);
            if (params === null) {
                // Path does not match this entry — keep looking.
                continue;
            }

            // Path matched — record the method.
            if (!allowedMethods.includes(entry.method)) {
                allowedMethods.push(entry.method);
            }

            if (entry.method === method) {
                // Full match: invoke the handler.
                void Promise.resolve(entry.handler(req, res, params)).catch((err: unknown) => {
                    // Handlers are responsible for writing their own error
                    // responses — the router does not send an additional one.
                    // If an ErrorLogManager is attached, record the rejection.
                    if (this.errorLogManager !== undefined) {
                        const error = err instanceof Error ? err : undefined;
                        this.errorLogManager.append({
                            Severity: 'error',
                            Source: 'route-handler',
                            Operation: url,
                            Context: {},
                            Message: error?.message ?? String(err),
                            Details: error?.stack,
                        });
                    }
                });
                return;
            }
        }

        if (allowedMethods.length > 0) {
            // Path is known but the method is not registered → 405.
            res.writeHead(405, {
                'Content-Type': 'application/json',
                Allow: allowedMethods.join(', '),
            });
            res.end(JSON.stringify({ error: `Method ${method} not allowed` }));
            return;
        }

        // No path match at all → 404.
        sendError(res, 404, `Cannot ${method} ${url}`);
    }
}

```
###  Path: `/src/server/staticServer.ts`

```ts
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError } from './requestUtils.js';

// ---------------------------------------------------------------------------
// MIME type map
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
};

const DEFAULT_MIME = 'application/octet-stream';

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Serves a static file from `baseDir` for the URL in `req`.
 *
 * - `/` (root) is silently remapped to `index.html`.
 * - A path that resolves outside `baseDir` (directory traversal) gets a 403
 *   **without any filesystem I/O**.
 * - If the resolved file does not exist, `false` is returned so the caller
 *   can fall through to the API router.
 * - Otherwise the file is streamed to the response with an appropriate
 *   `Content-Type` header and `true` is returned.
 *
 * @param req     Incoming HTTP request (only `req.url` is read).
 * @param res     ServerResponse to write to.
 * @param baseDir Absolute path to the static files directory.
 * @returns       `true` if the file was served (or a 403 was sent),
 *                `false` if the file was not found.
 */
export async function serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    baseDir: string,
): Promise<boolean> {
    // Strip query string and decode percent-encoding.
    const rawUrl = req.url ?? '/';
    let urlPath = rawUrl.split('?')[0];

    // Decode before resolving so %2e%2e won't slip past the prefix check.
    try {
        urlPath = decodeURIComponent(urlPath);
    } catch {
        sendError(res, 400, 'Malformed URL');
        return true;
    }

    // Root → index.html
    if (urlPath === '/' || urlPath === '') {
        urlPath = '/index.html';
    }

    // Resolve to an absolute path (path.join already normalises `..` segments).
    const resolved = path.resolve(baseDir, '.' + urlPath);

    // Guard: the resolved path must still be inside baseDir.
    // We append sep to baseDir so /foo/barbaz doesn't match /foo/bar.
    const safeBase = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
    if (!resolved.startsWith(safeBase) && resolved !== baseDir) {
        sendError(res, 403, 'Forbidden');
        return true;
    }

    // File existence check (avoids throwing on stat for missing files).
    if (!existsSync(resolved)) {
        return false;
    }

    // Make sure it's a regular file, not a directory.
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) {
        return false;
    }

    // Determine Content-Type from extension.
    const ext = path.extname(resolved).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? DEFAULT_MIME;

    const headers: Record<string, string | number> = {
        'Content-Type': contentType,
        'Content-Length': fileStat.size,
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
    };

    if (contentType.startsWith('text/html')) {
        headers['Content-Security-Policy'] = "default-src 'self'";
    }

    res.writeHead(200, headers);

    await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(resolved);
        stream.pipe(res);
        stream.on('end', resolve);
        stream.on('error', reject);
    });

    return true;
}

```
---
**File Statistics**
- **Size**: 35.36 KB
- **Lines**: 965
File: `modules/server/architecture-core.md`
