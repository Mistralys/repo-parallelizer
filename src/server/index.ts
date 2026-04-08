import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from '../config/config.types.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { ProjectManager } from '../models/project/project.manager.js';
import { WorkspaceManager } from '../models/workspace/workspace.manager.js';
import { BranchOrchestrator } from '../orchestration/branch-orchestrator.js';
import { PollingManager } from './pollingManager.js';
import { Router } from './router.js';
import { serveStatic } from './staticServer.js';
import { sendError } from './requestUtils.js';
import { registerRepositoryRoutes } from './routes/repositories.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerBranchRoutes } from './routes/branches.js';
import { registerStatusRoutes } from './routes/status.js';

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
    const branchOrchestrator = new BranchOrchestrator(
        config.appConfig,
        projectManager,
        workspaceManager,
    );
    const pollingManager = new PollingManager(
        config.appConfig,
        projectManager,
        workspaceManager,
    );

    // ------------------------------------------------------------------
    // Build the router and register all route groups
    // ------------------------------------------------------------------
    const router = new Router();
    registerRepositoryRoutes(router, repoManager);
    registerProjectRoutes(router, projectManager);
    registerWorkspaceRoutes(router, workspaceManager);
    registerBranchRoutes(router, branchOrchestrator, workspaceManager);
    registerStatusRoutes(router, pollingManager, projectManager, workspaceManager, config.appConfig);

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

        server.listen(port, () => {
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
