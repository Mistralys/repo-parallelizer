# Server - Architecture Routes
_SOURCE: REST API route handlers_
# REST API route handlers
```
// Structure of documents
└── src/
    └── server/
        └── routes/
            └── branches.ts
            └── config.ts
            └── error-log.ts
            └── projects.ts
            └── repositories.ts
            └── status.ts
            └── workspaces.ts

```
###  Path: `/src/server/routes/branches.ts`

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Router } from '../router.js';
import type { BranchOrchestrator } from '../../orchestration/branch-orchestrator.js';
import type { WorkspaceManager } from '../../models/workspace/workspace.manager.js';
// NotFoundError is used in the orchestrator catch block (GET branches handler).
import { NotFoundError } from '../../errors.js';
import { parseJsonBody, sendJson, sendError, isPlainObject } from '../requestUtils.js';
import type { BranchInfo } from '../../git/git.types.js';
import type { WorkspaceInfo } from '../../models/workspace/workspace.types.js';

// ---------------------------------------------------------------------------
// Response shape for the GET branches endpoint
// ---------------------------------------------------------------------------

export interface BranchesResponse {
    /** Branches grouped by repository ID. */
    branches: Record<string, BranchInfo[]>;
    /** Compiled, sorted, deduplicated branch name suggestions for UI. */
    suggestions: string[];
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers the two branch-related routes nested under a workspace on the
 * provided `Router` instance.
 *
 * | Method | Path                                                      | Success | Failure |
 * |--------|-----------------------------------------------------------|---------|---------|
 * | GET    | /api/projects/:id/workspaces/:wid/branches               | 200     | 404     |
 * | POST   | /api/projects/:id/workspaces/:wid/branches/switch        | 200     | 400/404 |
 *
 * @param router           - The Router to register routes on.
 * @param orchestrator     - Provides `getAvailableBranches()`, `compileBranchSuggestions()`,
 *                           and `switchBranches()`.
 * @param workspaceManager - Used to verify that the requested workspace exists before
 *                           delegating to the orchestrator.
 */
export function registerBranchRoutes(
    router: Router,
    orchestrator: BranchOrchestrator,
    workspaceManager: WorkspaceManager,
): void {
    /**
     * Look up a workspace by project and workspace ID.
     *
     * Sends a `404` response and returns `undefined` when the workspace
     * (or its parent project) cannot be found.
     *
     * @param res         - The outgoing HTTP response (used to send the 404 error).
     * @param projectId   - The ID of the parent project.
     * @param workspaceId - The ID of the workspace to look up.
     * @returns The matching `WorkspaceInfo` on success, or `undefined` when a 404
     *          has already been written to `res`.
     */
    function resolveWorkspace(
        res: ServerResponse,
        projectId: string,
        workspaceId: string,
    ): WorkspaceInfo | undefined {
        try {
            const ws = workspaceManager.getById(projectId, workspaceId);
            if (ws === undefined) {
                sendError(res, 404, `Workspace "${workspaceId}" not found in project "${projectId}".`);
                return undefined;
            }
            return ws;
        } catch (err) {
            sendError(res, 404, err instanceof Error ? err.message : 'Not found.');
            return undefined;
        }
    }

    // ------------------------------------------------------------------
    // GET /api/projects/:id/workspaces/:wid/branches
    //   Returns available branches per repository + compiled suggestions.
    // ------------------------------------------------------------------
    router.get('/api/projects/:id/workspaces/:wid/branches', async (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const { id: projectId, wid: workspaceId } = params;

        // Validate workspace existence before issuing git operations.
        if (resolveWorkspace(res, projectId, workspaceId) === undefined) return;

        try {
            const branchMap = await orchestrator.getAvailableBranches(projectId, workspaceId);
            const suggestions = orchestrator.compileBranchSuggestions(branchMap);

            // Convert the Map to a plain object for JSON serialisation.
            const branches: Record<string, BranchInfo[]> = {};
            for (const [repoId, infos] of branchMap) {
                branches[repoId] = infos;
            }

            const payload: BranchesResponse = { branches, suggestions };
            sendJson(res, 200, payload);
        } catch (err) {
            if (err instanceof NotFoundError) {
                sendError(res, 404, err.message);
            } else {
                sendError(res, 500, 'Internal server error.');
            }
        }
    });

    // ------------------------------------------------------------------
    // POST /api/projects/:id/workspaces/:wid/branches/switch
    //   Executes branch-switch assignments, returns per-repo results.
    // ------------------------------------------------------------------
    router.post('/api/projects/:id/workspaces/:wid/branches/switch', async (
        req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const { id: projectId, wid: workspaceId } = params;

        // Validate workspace existence before touching the filesystem.
        if (resolveWorkspace(res, projectId, workspaceId) === undefined) return;

        let body: unknown;
        try {
            body = await parseJsonBody(req);
        } catch (err) {
            sendError(res, 400, err instanceof Error ? err.message : 'Invalid request body.');
            return;
        }

        if (!isPlainObject(body)) {
            sendError(res, 400, 'Request body must be a JSON object.');
            return;
        }

        const { assignments } = body as { assignments?: unknown };

        if (!isPlainObject(assignments)) {
            sendError(res, 400, 'Missing or invalid field: assignments must be a non-empty object.');
            return;
        }

        if (Object.keys(assignments).length === 0) {
            sendError(res, 400, 'Field assignments must not be empty.');
            return;
        }

        // Ensure all values are strings.
        for (const [key, value] of Object.entries(assignments)) {
            if (typeof value !== 'string') {
                sendError(res, 400, `Assignment value for repository "${key}" must be a string branch name.`);
                return;
            }
        }

        const branchAssignments = assignments as Record<string, string>;

        try {
            const result = await orchestrator.switchBranches(projectId, workspaceId, branchAssignments);
            sendJson(res, 200, result);
        } catch (err) {
            sendError(res, 500, err instanceof Error ? err.message : 'Branch switch failed.');
        }
    });
}

```
###  Path: `/src/server/routes/config.ts`

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Router } from '../router.js';
import type { AppConfig } from '../../config/config.types.js';
import type { PollingManager } from '../pollingManager.js';
import { saveConfigField } from '../../config/config.js';
import { parseJsonBody, sendJson, sendError, isPlainObject } from '../requestUtils.js';

// Polling-interval bounds — shared with settings UI (gui/public/js/views/settings.js).
import {
    MIN_POLLING_INTERVAL_SECONDS,
    MAX_POLLING_INTERVAL_SECONDS,
} from '../../config/config.constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Masks a credential token for display in API responses.
 * Shows the last 4 characters of the token prefixed with `****`.
 * Tokens shorter than 4 characters are fully masked as `****`.
 */
function maskToken(token: string): string {
    return token.length < 4 ? '****' : '****' + token.slice(-4);
}

/**
 * Extracts and lowercases the scheme from a URL string (the part before the
 * first `:`). Returns an empty string when no colon is present.
 *
 * @example extractScheme('https://example.com') // → 'https'
 * @example extractScheme('javascript:alert(1)') // → 'javascript'
 */
function extractScheme(url: string): string {
    const colonIdx = url.indexOf(':');
    return colonIdx !== -1 ? url.slice(0, colonIdx).toLowerCase() : '';
}

/**
 * Returns a copy of the credentials map with all tokens masked.
 */
function buildMaskedCredentials(
    credentials: Record<string, string> | undefined,
): Record<string, string> {
    if (!credentials) return {};
    const masked: Record<string, string> = {};
    for (const [host, token] of Object.entries(credentials)) {
        masked[host] = maskToken(token);
    }
    return masked;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Named-options interface
// ---------------------------------------------------------------------------

export interface ConfigRoutesOptions {
    router: Router;
    appConfig: AppConfig;
    /** Optional absolute path to `config.json`. Defaults to the tool-root `config.json`. */
    configPath?: string;
    /** Optional `PollingManager`. When provided, PUT /api/config/polling restarts the loop. */
    pollingManager?: PollingManager;
}

/**
 * Registers REST endpoints for managing application configuration in
 * `config.json`.
 *
 * **Credentials endpoints:**
 *
 * | Method | Path                              | Description               |
 * |--------|-----------------------------------|---------------------------|
 * | GET    | /api/config/credentials           | List credentials (masked) |
 * | PUT    | /api/config/credentials           | Add / update an entry     |
 * | DELETE | /api/config/credentials/:host     | Remove an entry           |
 *
 * **Polling endpoints:**
 *
 * | Method | Path                    | Description                                          |
 * |--------|-------------------------|------------------------------------------------------|
 * | GET    | /api/config/polling     | Return current `gitPollingIntervalSeconds`           |
 * | PUT    | /api/config/polling     | Update the polling interval (min 10 s, max 86400 s)  |
 *
 * **Webserver URL endpoints:**
 *
 * | Method | Path                         | Description                              |
 * |--------|------------------------------|------------------------------------------|
 * | GET    | /api/config/webserver-url    | Return current `webserverUrl` (or null)  |
 * | PUT    | /api/config/webserver-url    | Update the webserver URL                 |
 *
 * Changes take effect immediately (the in-memory `appConfig` is mutated) and
 * are persisted to `config.json` via `saveConfigField()`.
 *
 * **Security:** tokens are never returned in full — only the last 4 characters
 * are exposed. The `host` field is validated against an injection-safe pattern.
 *
 * @param options - Named-options bag: `router`, `appConfig`, optional
 *   `configPath` (defaults to tool-root `config.json`), optional
 *   `pollingManager` (restarts polling loop when present).
 */
export function registerConfigRoutes(options: ConfigRoutesOptions): void {
    const { router, appConfig, configPath, pollingManager } = options;
    // ------------------------------------------------------------------
    // GET /api/config/credentials — list all (tokens masked)
    // ------------------------------------------------------------------
    router.get('/api/config/credentials', (
        _req: IncomingMessage,
        res: ServerResponse,
        _params: Record<string, string>,
    ): void => {
        sendJson(res, 200, buildMaskedCredentials(appConfig.gitCredentials));
    });

    // ------------------------------------------------------------------
    // PUT /api/config/credentials — add or update a single entry
    // ------------------------------------------------------------------
    router.put('/api/config/credentials', async (
        req: IncomingMessage,
        res: ServerResponse,
        _params: Record<string, string>,
    ): Promise<void> => {
        let body: unknown;
        try {
            body = await parseJsonBody(req);
        } catch (err) {
            sendError(res, 400, err instanceof Error ? err.message : 'Invalid request body.');
            return;
        }

        if (!isPlainObject(body)) {
            sendError(res, 400, 'Request body must be a JSON object.');
            return;
        }

        const { host, token } = body as { host?: unknown; token?: unknown };

        if (typeof host !== 'string' || host.trim() === '') {
            sendError(res, 400, 'Missing or invalid field "host": must be a non-empty string.');
            return;
        }

        if (typeof token !== 'string' || token.trim() === '') {
            sendError(res, 400, 'Missing or invalid field "token": must be a non-empty string.');
            return;
        }

        const cleanHost = host.trim();

        // Security: reject hosts with path separators or whitespace to prevent
        // key injection that could interfere with URL credential injection.
        if (/[\s/\\]/.test(cleanHost)) {
            sendError(res, 400, 'Field "host" must not contain path separators or whitespace.');
            return;
        }

        // Defence-in-depth: reject prototype-pollution keys.
        if (['__proto__', 'constructor', 'prototype'].includes(cleanHost)) {
            sendError(res, 400, 'Field "host" contains a reserved name.');
            return;
        }

        const cleanToken = token.trim();

        // Update in-memory config.
        if (!appConfig.gitCredentials) {
            appConfig.gitCredentials = {};
        }
        appConfig.gitCredentials[cleanHost] = cleanToken;

        // Persist to disk.
        saveConfigField('gitCredentials', appConfig.gitCredentials, configPath);

        sendJson(res, 200, buildMaskedCredentials(appConfig.gitCredentials));
    });

    // ------------------------------------------------------------------
    // DELETE /api/config/credentials/:host — remove a single entry
    // Sync handler (no request body to parse — unlike the async PUT above).
    // ------------------------------------------------------------------
    router.delete('/api/config/credentials/:host', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        let host: string;
        try {
            host = decodeURIComponent(params['host']);
        } catch {
            sendError(res, 400, 'Malformed host parameter.');
            return;
        }

        if (!appConfig.gitCredentials || !(host in appConfig.gitCredentials)) {
            sendError(res, 404, `No credential entry found for host "${host}".`);
            return;
        }

        delete appConfig.gitCredentials[host];

        // When the map is empty, remove the field entirely (undefined removes
        // it from config.json via saveConfigField).
        const isEmpty = Object.keys(appConfig.gitCredentials).length === 0;
        if (isEmpty) {
            appConfig.gitCredentials = undefined;
        }

        saveConfigField('gitCredentials', appConfig.gitCredentials, configPath);

        sendJson(res, 200, buildMaskedCredentials(appConfig.gitCredentials));
    });

    // ------------------------------------------------------------------
    // GET /api/config/polling — return the current polling interval
    // ------------------------------------------------------------------
    router.get('/api/config/polling', (
        _req: IncomingMessage,
        res: ServerResponse,
        _params: Record<string, string>,
    ): void => {
        sendJson(res, 200, {
            gitPollingIntervalSeconds: appConfig.gitPollingIntervalSeconds,
        });
    });

    // ------------------------------------------------------------------
    // PUT /api/config/polling — update the polling interval
    // Validates: must be a finite integer >= 10.
    // ------------------------------------------------------------------
    router.put('/api/config/polling', async (
        req: IncomingMessage,
        res: ServerResponse,
        _params: Record<string, string>,
    ): Promise<void> => {
        let body: unknown;
        try {
            body = await parseJsonBody(req);
        } catch (err) {
            sendError(res, 400, err instanceof Error ? err.message : 'Invalid request body.');
            return;
        }

        if (!isPlainObject(body)) {
            sendError(res, 400, 'Request body must be a JSON object.');
            return;
        }

        const { seconds } = body as { seconds?: unknown };

        if (typeof seconds !== 'number') {
            sendError(res, 400, 'Missing or invalid field "seconds": must be a number.');
            return;
        }

        if (!Number.isFinite(seconds) || !Number.isInteger(seconds)) {
            sendError(res, 400, 'Field "seconds" must be a finite integer.');
            return;
        }

        if (seconds < MIN_POLLING_INTERVAL_SECONDS) {
            sendError(
                res,
                400,
                `Field "seconds" must be at least ${MIN_POLLING_INTERVAL_SECONDS}. Received: ${seconds}.`,
            );
            return;
        }

        if (seconds > MAX_POLLING_INTERVAL_SECONDS) {
            sendError(
                res,
                400,
                `Field "seconds" must be at most ${MAX_POLLING_INTERVAL_SECONDS} (24 hours). Received: ${seconds}.`,
            );
            return;
        }

        // Update in-memory config.
        appConfig.gitPollingIntervalSeconds = seconds;

        // Persist to disk.
        saveConfigField('gitPollingIntervalSeconds', seconds, configPath);

        // Restart the polling loop with the new interval (if a manager was provided).
        if (pollingManager !== undefined) {
            pollingManager.restart(seconds);
        }

        sendJson(res, 200, { gitPollingIntervalSeconds: appConfig.gitPollingIntervalSeconds });
    });

    // ------------------------------------------------------------------
    // GET /api/config/webserver-url — return the current webserver URL
    // ------------------------------------------------------------------
    router.get('/api/config/webserver-url', (
        _req: IncomingMessage,
        res: ServerResponse,
        _params: Record<string, string>,
    ): void => {
        sendJson(res, 200, { webserverUrl: appConfig.webserverUrl ?? null });
    });

    // ------------------------------------------------------------------
    // PUT /api/config/webserver-url — update the webserver URL
    // ------------------------------------------------------------------
    router.put('/api/config/webserver-url', async (
        req: IncomingMessage,
        res: ServerResponse,
        _params: Record<string, string>,
    ): Promise<void> => {
        let body: unknown;
        try {
            body = await parseJsonBody(req);
        } catch (err) {
            sendError(res, 400, err instanceof Error ? err.message : 'Invalid request body.');
            return;
        }

        if (!isPlainObject(body)) {
            sendError(res, 400, 'Request body must be a JSON object.');
            return;
        }

        const { url } = body as { url?: unknown };

        if (typeof url !== 'string') {
            sendError(res, 400, 'Missing or invalid field "url": must be a string.');
            return;
        }

        const trimmed = url.trim();

        if (trimmed !== '') {
            // Defence-in-depth: reject dangerous URL schemes.
            const scheme = extractScheme(trimmed);
            if (['javascript', 'data', 'vbscript'].includes(scheme)) {
                sendError(res, 400, `URL scheme "${scheme}:" is not permitted.`);
                return;
            }
        }

        // Strip trailing slashes to prevent double-slash in constructed URLs.
        const cleanUrl = trimmed !== '' ? trimmed.replace(/\/+$/, '') : undefined;

        // Update in-memory config.
        appConfig.webserverUrl = cleanUrl;

        // Persist to disk.
        saveConfigField('webserverUrl', cleanUrl, configPath);

        sendJson(res, 200, { webserverUrl: appConfig.webserverUrl ?? null });
    });
}

```
###  Path: `/src/server/routes/error-log.ts`

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Router } from '../router.js';
import type { ErrorLogManager } from '../../error-log/error-log.manager.js';
import type { ErrorSeverity } from '../../error-log/error-log.types.js';
import { sendJson, sendError } from '../requestUtils.js';

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers the error-log REST routes on the provided `Router` instance.
 *
 * | Method | Path                  | Success | Failure    |
 * |--------|-----------------------|---------|------------|
 * | GET    | /api/error-log        | 200     | —          |
 * | GET    | /api/error-log/:id    | 200     | 400 / 404  |
 * | DELETE | /api/error-log        | 204     | —          |
 *
 * @param router           - The Router to register routes on.
 * @param errorLogManager  - Provides `list()`, `sources()`, `getById()`, and `clear()`.
 */
export function registerErrorLogRoutes(
    router: Router,
    errorLogManager: ErrorLogManager,
): void {
    // ------------------------------------------------------------------
    // GET /api/error-log — list entries with optional filtering/pagination
    //
    // Query parameters (all optional):
    //
    //   severity  "error" | "warning"
    //             Filter by severity level. Any other value is silently
    //             ignored (treated as no filter).
    //
    //   source    string
    //             Exact-match filter on the entry's Source field.
    //             Case-sensitive; no allowlist — intended for internal use.
    //
    //   limit     integer >= 0  (default: 100)
    //             Maximum number of entries to return. Defaults to 100 to
    //             prevent unbounded result sets. Passing limit=0 returns an
    //             empty `entries` array while still populating `total` — useful
    //             for polling the current count without fetching entry data.
    //             Non-numeric and negative values are clamped to 0.
    //
    //   offset    integer >= 0  (default: 0 / omitted)
    //             Zero-based offset into the filtered result set for
    //             pagination. Negative values are treated as 0.
    //
    // Response shape (HTTP 200):
    //
    //   {
    //     "entries": [
    //       {
    //         "Id": 42,
    //         "Timestamp": "2026-04-11T09:00:00.000Z",
    //         "Severity": "error" | "warning",
    //         "Source": "<string>",
    //         "Operation": "<string>",
    //         "Context": { ... },
    //         "Message": "<string>",
    //         "Details": "<string>" | undefined
    //       },
    //       ...
    //     ],
    //     "total": N   // post-filter, pre-pagination count
    //   }
    //
    // Entries are returned newest first (reverse-chronological order).
    // `total` reflects how many entries match the active filters before
    // `limit` / `offset` are applied — useful for building pagination UIs.
    // ------------------------------------------------------------------
    router.get('/api/error-log', (
        req: IncomingMessage,
        res: ServerResponse,
        _params: Record<string, string>,
    ): void => {
        // Parse query parameters from the URL.
        const rawUrl = req.url ?? '';
        const queryString = rawUrl.includes('?') ? rawUrl.split('?')[1] : '';
        const qs = new URLSearchParams(queryString);

        const severityRaw = qs.get('severity') ?? undefined;
        const source = qs.get('source') ?? undefined;
        const limitRaw = qs.get('limit');
        const offsetRaw = qs.get('offset');

        // Validate and cast severity to the union type.
        const severity =
            severityRaw === 'error' || severityRaw === 'warning'
                ? (severityRaw as ErrorSeverity)
                : undefined;

        // Default limit to 100 to prevent unbounded query results.
        const limit = limitRaw !== null ? Math.max(0, parseInt(limitRaw, 10) || 0) : 100;
        const offset = offsetRaw !== null ? Math.max(0, parseInt(offsetRaw, 10) || 0) : undefined;

        const result = errorLogManager.list({ severity, source, limit, offset });
        sendJson(res, 200, result);
    });

    // ------------------------------------------------------------------
    // GET /api/error-log/sources — distinct source values in the store
    //
    // Returns the sorted list of unique Source values currently stored in
    // the error log. Useful for populating filter dropdowns dynamically.
    //
    // Response shape (HTTP 200):
    //   { "sources": ["branch-switch", "clone", "fetch", ...] }
    //
    // Note: this route MUST be registered before GET /api/error-log/:id so
    // that the literal path segment "sources" is not captured as an :id.
    // ------------------------------------------------------------------
    router.get('/api/error-log/sources', (
        _req: IncomingMessage,
        res: ServerResponse,
        _params: Record<string, string>,
    ): void => {
        const sources = errorLogManager.sources();
        sendJson(res, 200, { sources });
    });

    // ------------------------------------------------------------------
    // GET /api/error-log/:id — get a single entry by numeric ID
    // ------------------------------------------------------------------
    router.get('/api/error-log/:id', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        const rawId = params['id'];

        // Reject non-numeric or otherwise invalid ID formats (e.g. "abc", "1.5", "12abc").
        if (!/^\d+$/.test(rawId)) {
            sendError(res, 400, `Invalid error log ID: "${rawId}". ID must be a positive integer.`);
            return;
        }

        const id = parseInt(rawId, 10);

        // The regex above guarantees `id` is a non-negative finite integer, so
        // we only need to guard `id <= 0` to reject "0" as an invalid ID (IDs start at 1).
        if (id <= 0) {
            sendError(res, 400, `Invalid error log ID: "${rawId}". ID must be a positive integer.`);
            return;
        }

        const entry = errorLogManager.getById(id);
        if (entry === undefined) {
            sendError(res, 404, `Error log entry with ID ${id} not found.`);
            return;
        }

        sendJson(res, 200, entry);
    });

    // ------------------------------------------------------------------
    // DELETE /api/error-log — clear all entries
    // ------------------------------------------------------------------
    router.delete('/api/error-log', (
        _req: IncomingMessage,
        res: ServerResponse,
        _params: Record<string, string>,
    ): void => {
        errorLogManager.clear();

        // 204 No Content — no body
        res.writeHead(204, {});
        res.end('');
    });
}

```
###  Path: `/src/server/routes/projects.ts`

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Router } from '../router.js';
import type { ProjectManager } from '../../models/project/project.manager.js';
import { NotFoundError } from '../../errors.js';
import { parseJsonBody, sendJson, sendError, isPlainObject } from '../requestUtils.js';
import type { ProjectData } from '../../models/project/project.types.js';

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers the eight standard routes for the `/api/projects` resource group
 * and its nested `/repositories` sub-resource on the provided `Router` instance.
 *
 * All handlers delegate to the supplied `ProjectManager` (and optionally
 * `RepositoryManager`) and map results or errors to the appropriate HTTP
 * status codes:
 *
 * | Method | Path                                      | Success | Failure |
 * |--------|-------------------------------------------|---------|---------|
 * | GET    | /api/projects                             | 200     | —       |
 * | GET    | /api/projects/:id                         | 200     | 404     |
 * | POST   | /api/projects                             | 201     | 400     |
 * | PUT    | /api/projects/:id                         | 200     | 404     |
 * | PUT    | /api/projects/:id/rename                  | 200     | 404/400 |
 * | DELETE | /api/projects/:id                         | 204     | 404     |
 * | POST   | /api/projects/:id/repositories            | 200     | 404/400 |
 * | DELETE | /api/projects/:id/repositories/:repoId   | 204     | 404     |
 */
export function registerProjectRoutes(
    router: Router,
    projectManager: ProjectManager,
): void {
    /**
     * Look up a project by ID.
     *
     * Sends a `404` response and returns `undefined` when the project
     * cannot be found.
     *
     * @param res       - The outgoing HTTP response (used to send the 404 error).
     * @param projectId - The ID of the project to look up.
     * @returns The matching `ProjectData` on success, or `undefined` when a 404
     *          has already been written to `res`.
     */
    function resolveProject(
        res: ServerResponse,
        projectId: string,
    ): ProjectData | undefined {
        const project = projectManager.getById(projectId);
        if (project === undefined) {
            sendError(res, 404, `Project with ID "${projectId}" not found.`);
            return undefined;
        }
        return project;
    }

    // ------------------------------------------------------------------
    // GET /api/projects — list all
    // ------------------------------------------------------------------
    router.get('/api/projects', (
        _req: IncomingMessage,
        res: ServerResponse,
        _params: Record<string, string>,
    ): void => {
        const projects = projectManager.list();
        sendJson(res, 200, projects);
    });

    // ------------------------------------------------------------------
    // GET /api/projects/:id — get one by ID
    // ------------------------------------------------------------------
    router.get('/api/projects/:id', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        const project = resolveProject(res, params['id']);
        if (project === undefined) return;
        sendJson(res, 200, project);
    });

    // ------------------------------------------------------------------
    // POST /api/projects — create
    // ------------------------------------------------------------------
    router.post('/api/projects', async (
        req: IncomingMessage,
        res: ServerResponse,
        _params: Record<string, string>,
    ): Promise<void> => {
        let body: unknown;
        try {
            body = await parseJsonBody(req);
        } catch (err) {
            sendError(res, 400, err instanceof Error ? err.message : 'Invalid request body.');
            return;
        }

        if (!isPlainObject(body)) {
            sendError(res, 400, 'Request body must be a JSON object.');
            return;
        }

        const { name, repositoryIds, description, id } = body as {
            name?: unknown;
            repositoryIds?: unknown;
            description?: unknown;
            id?: unknown;
        };

        if (typeof name !== 'string' || name.trim() === '') {
            sendError(res, 400, 'Missing required field: name (non-empty string).');
            return;
        }

        const repoIds: string[] = [];
        if (repositoryIds !== undefined) {
            if (!Array.isArray(repositoryIds)) {
                sendError(res, 400, 'Field repositoryIds must be an array of strings.');
                return;
            }
            for (const rid of repositoryIds as unknown[]) {
                if (typeof rid !== 'string') {
                    sendError(res, 400, 'Field repositoryIds must contain only strings.');
                    return;
                }
                repoIds.push(rid);
            }
        }

        const explicitId = typeof id === 'string' ? id : undefined;
        const desc = typeof description === 'string' ? description : undefined;

        try {
            const project = projectManager.create(name.trim(), repoIds, desc, explicitId);
            sendJson(res, 201, project);
        } catch (err) {
            sendError(res, 400, err instanceof Error ? err.message : 'Could not create project.');
        }
    });

    // ------------------------------------------------------------------
    // PUT /api/projects/:id — update name / description
    // ------------------------------------------------------------------
    router.put('/api/projects/:id', async (
        req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const id = params['id'];

        let body: unknown;
        try {
            body = await parseJsonBody(req);
        } catch (err) {
            sendError(res, 400, err instanceof Error ? err.message : 'Invalid request body.');
            return;
        }

        if (!isPlainObject(body)) {
            sendError(res, 400, 'Request body must be a JSON object.');
            return;
        }

        const { name, description } = body as { name?: unknown; description?: unknown };

        const changes: { Name?: string; Description?: string } = {};
        if (typeof name === 'string') changes.Name = name;
        if (typeof description === 'string') changes.Description = description;

        if (Object.keys(changes).length === 0) {
            sendError(res, 400, 'At least one of name or description must be provided.');
            return;
        }

        try {
            const updated = projectManager.update(id, changes);
            sendJson(res, 200, updated);
        } catch (err) {
            sendError(res, 404, err instanceof Error ? err.message : 'Project not found.');
        }
    });

    // ------------------------------------------------------------------
    // PUT /api/projects/:id/rename — rename (change project ID)
    // ------------------------------------------------------------------
    router.put('/api/projects/:id/rename', async (
        req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const oldId = params['id'];

        let body: unknown;
        try {
            body = await parseJsonBody(req);
        } catch (err) {
            sendError(res, 400, err instanceof Error ? err.message : 'Invalid request body.');
            return;
        }

        if (!isPlainObject(body)) {
            sendError(res, 400, 'Request body must be a JSON object.');
            return;
        }

        const { newId } = body as { newId?: unknown };

        if (typeof newId !== 'string' || newId.trim() === '') {
            sendError(res, 400, 'Missing required field: newId (non-empty string).');
            return;
        }

        try {
            const renamed = projectManager.rename(oldId, newId.trim());
            sendJson(res, 200, renamed);
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Could not rename project.';
            const is404 = err instanceof NotFoundError;
            sendError(res, is404 ? 404 : 400, msg);
        }
    });

    // ------------------------------------------------------------------
    // DELETE /api/projects/:id — delete a project
    // ------------------------------------------------------------------
    router.delete('/api/projects/:id', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        try {
            projectManager.remove(params['id']);
        } catch {
            sendError(res, 404, `Project with ID "${params['id']}" not found.`);
            return;
        }
        res.writeHead(204, {});
        res.end('');
    });

    // ------------------------------------------------------------------
    // POST /api/projects/:id/repositories — link a repo to a project
    // ------------------------------------------------------------------
    router.post('/api/projects/:id/repositories', async (
        req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const projectId = params['id'];

        let body: unknown;
        try {
            body = await parseJsonBody(req);
        } catch (err) {
            sendError(res, 400, err instanceof Error ? err.message : 'Invalid request body.');
            return;
        }

        if (!isPlainObject(body)) {
            sendError(res, 400, 'Request body must be a JSON object.');
            return;
        }

        const { repositoryId } = body as { repositoryId?: unknown };

        if (typeof repositoryId !== 'string' || repositoryId.trim() === '') {
            sendError(res, 400, 'Missing required field: repositoryId (non-empty string).');
            return;
        }

        try {
            const updated = projectManager.addRepository(projectId, repositoryId.trim());
            sendJson(res, 200, updated);
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Could not link repository.';
            const is404 = err instanceof NotFoundError;
            sendError(res, is404 ? 404 : 400, msg);
        }
    });

    // ------------------------------------------------------------------
    // DELETE /api/projects/:id/repositories/:repoId — unlink a repo
    // ------------------------------------------------------------------
    router.delete('/api/projects/:id/repositories/:repoId', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        try {
            projectManager.removeRepository(params['id'], params['repoId']);
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Not found.';
            sendError(res, 404, msg);
            return;
        }
        res.writeHead(204, {});
        res.end('');
    });
}

```
###  Path: `/src/server/routes/repositories.ts`

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Router } from '../router.js';
import type { RepositoryManager } from '../../models/repository/repository.manager.js';
import { NotFoundError } from '../../errors.js';
import { parseJsonBody, sendJson, sendError, isPlainObject } from '../requestUtils.js';
import type { Repository } from '../../models/repository/repository.types.js';

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers the five standard CRUD routes for the `/api/repositories` resource
 * group on the provided `Router` instance.
 *
 * All handlers delegate to the supplied `RepositoryManager` and map results
 * or errors to the appropriate HTTP status codes:
 *
 * | Method | Path                    | Success | Failure       |
 * |--------|-------------------------|---------|---------------|
 * | GET    | /api/repositories       | 200     | —             |
 * | GET    | /api/repositories/:id   | 200     | 404           |
 * | POST   | /api/repositories       | 201     | 400           |
 * | PUT    | /api/repositories/:id   | 200     | 404           |
 * | DELETE | /api/repositories/:id   | 204     | 404           |
 */
export function registerRepositoryRoutes(
    router: Router,
    repoManager: RepositoryManager,
): void {
    /**
     * Look up a repository by ID.
     *
     * Sends a `404` response and returns `undefined` when the repository
     * cannot be found.
     *
     * @param res          - The outgoing HTTP response (used to send the 404 error).
     * @param repositoryId - The ID of the repository to look up.
     * @returns The matching `Repository` on success, or `undefined` when a 404
     *          has already been written to `res`.
     */
    function resolveRepository(
        res: ServerResponse,
        repositoryId: string,
    ): Repository | undefined {
        const repo = repoManager.getById(repositoryId);
        if (repo === undefined) {
            sendError(res, 404, `Repository with ID "${repositoryId}" not found.`);
            return undefined;
        }
        return repo;
    }

    // ------------------------------------------------------------------
    // GET /api/repositories — list all
    // ------------------------------------------------------------------
    router.get('/api/repositories', (
        _req: IncomingMessage,
        res: ServerResponse,
        _params: Record<string, string>,
    ): void => {
        const repos = repoManager.list();
        sendJson(res, 200, repos);
    });

    // ------------------------------------------------------------------
    // GET /api/repositories/:id — get one
    // ------------------------------------------------------------------
    router.get('/api/repositories/:id', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        const repo = resolveRepository(res, params['id']);
        if (repo === undefined) return;
        sendJson(res, 200, repo);
    });

    // ------------------------------------------------------------------
    // POST /api/repositories — create
    // ------------------------------------------------------------------
    router.post('/api/repositories', async (
        req: IncomingMessage,
        res: ServerResponse,
        _params: Record<string, string>,
    ): Promise<void> => {
        let body: unknown;
        try {
            body = await parseJsonBody(req);
        } catch (err) {
            sendError(res, 400, err instanceof Error ? err.message : 'Invalid request body.');
            return;
        }

        if (!isPlainObject(body)) {
            sendError(res, 400, 'Request body must be a JSON object.');
            return;
        }

        const { url, name, id } = body as {
            url?: unknown;
            name?: unknown;
            id?: unknown;
        };

        if (typeof url !== 'string' || url.trim() === '') {
            sendError(res, 400, 'Missing required field: url (non-empty string).');
            return;
        }

        const params: { url: string; name?: string; id?: string } = { url: url.trim() };
        if (typeof name === 'string') params.name = name;
        if (typeof id === 'string') params.id = id;

        try {
            const repo = repoManager.add(params);
            sendJson(res, 201, repo);
        } catch (err) {
            sendError(res, 400, err instanceof Error ? err.message : 'Could not create repository.');
        }
    });

    // ------------------------------------------------------------------
    // PUT /api/repositories/:id — update
    // ------------------------------------------------------------------
    router.put('/api/repositories/:id', async (
        req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const id = params['id'];

        if (!repoManager.exists(id)) {
            sendError(res, 404, `Repository with ID "${id}" not found.`);
            return;
        }

        let body: unknown;
        try {
            body = await parseJsonBody(req);
        } catch (err) {
            sendError(res, 400, err instanceof Error ? err.message : 'Invalid request body.');
            return;
        }

        if (!isPlainObject(body)) {
            sendError(res, 400, 'Request body must be a JSON object.');
            return;
        }

        const { name } = body as { name?: unknown };

        if (typeof name !== 'string' || name.trim() === '') {
            sendError(res, 400, 'Missing required field: name (non-empty string).');
            return;
        }

        try {
            const updated = repoManager.update(id, { name: name.trim() });
            sendJson(res, 200, updated);
        } catch (err) {
            // update() throws NotFoundError if the ID was removed
            // between the exists() check and the update() call (race condition).
            if (err instanceof NotFoundError) {
                sendError(res, 404, err.message);
            } else {
                sendError(res, 500, 'Internal server error.');
            }
        }
    });

    // ------------------------------------------------------------------
    // DELETE /api/repositories/:id — delete
    // ------------------------------------------------------------------
    router.delete('/api/repositories/:id', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        const id = params['id'];

        try {
            repoManager.remove(id);
        } catch (err) {
            if (err instanceof NotFoundError) {
                sendError(res, 404, `Repository with ID "${id}" not found.`);
            } else {
                sendError(res, 500, 'Internal server error.');
            }
            return;
        }

        // 204 No Content — no body
        res.writeHead(204, {});
        res.end('');
    });
}

```
###  Path: `/src/server/routes/status.ts`

```ts
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Router } from '../router.js';
import type { PollingManager } from '../pollingManager.js';
import type { ProjectManager } from '../../models/project/project.manager.js';
import type { WorkspaceManager } from '../../models/workspace/workspace.manager.js';
import type { AppConfig } from '../../config/config.types.js';
import type { GitStatusInfo } from '../../git/git.types.js';
import type { ProjectData } from '../../models/project/project.types.js';
import type { WorkspaceInfo } from '../../models/workspace/workspace.types.js';
import { NotFoundError } from '../../errors.js';
import { sendJson, sendError } from '../requestUtils.js';

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

/**
 * Keyed by repository ID; values are the cached status snapshot (or null if
 * the repository has not been polled yet).
 */
export type WorkspaceStatusResponse = Record<string, GitStatusInfo | null>;

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers the two git-status routes nested under a workspace on the
 * provided `Router` instance.
 *
 * | Method | Path                                                 | Success | Failure |
 * |--------|------------------------------------------------------|---------|---------|
 * | GET    | /api/projects/:id/workspaces/:wid/status            | 200     | 404     |
 * | POST   | /api/projects/:id/workspaces/:wid/status/refresh    | 200     | 404     |
 *
 * @param router           - The Router to register routes on.
 * @param pollingManager   - Provides `getStatus(repoPath)` and `refreshWorkspace()`.
 * @param projectManager   - Used to resolve repository IDs for a project so that
 *                           repo paths can be computed for cache lookups.
 * @param workspaceManager - Used to verify that the requested workspace exists.
 * @param config           - Application configuration (provides `projectsFolder`).
 */
export function registerStatusRoutes(
    router: Router,
    pollingManager: PollingManager,
    projectManager: ProjectManager,
    workspaceManager: WorkspaceManager,
    config: AppConfig,
): void {
    /**
     * Look up a project by ID.
     *
     * Sends a `404` response and returns `undefined` when the project
     * cannot be found.
     *
     * @param res       - The outgoing HTTP response (used to send the 404 error).
     * @param projectId - The ID of the project to look up.
     * @returns The matching `ProjectData` on success, or `undefined` when a 404
     *          has already been written to `res`.
     */
    function resolveProject(
        res: ServerResponse,
        projectId: string,
    ): ProjectData | undefined {
        const project = projectManager.getById(projectId);
        if (!project) {
            sendError(res, 404, `Project with ID "${projectId}" not found.`);
            return undefined;
        }
        return project;
    }

    /**
     * Look up a workspace by project and workspace ID.
     *
     * Sends a `404` response and returns `undefined` when the workspace
     * (or its parent project) cannot be found.
     *
     * @param res         - The outgoing HTTP response (used to send the 404 error).
     * @param projectId   - The ID of the parent project.
     * @param workspaceId - The ID of the workspace to look up.
     * @returns The matching `WorkspaceInfo` on success, or `undefined` when a 404
     *          has already been written to `res`.
     */
    function resolveWorkspace(
        res: ServerResponse,
        projectId: string,
        workspaceId: string,
    ): WorkspaceInfo | undefined {
        try {
            const ws = workspaceManager.getById(projectId, workspaceId);
            if (ws === undefined) {
                sendError(res, 404, `Workspace "${workspaceId}" not found in project "${projectId}".`);
                return undefined;
            }
            return ws;
        } catch (err) {
            sendError(res, 404, err instanceof Error ? err.message : 'Not found.');
            return undefined;
        }
    }

    // ------------------------------------------------------------------
    // GET /api/projects/:id/workspaces/:wid/status
    //   Returns the cached GitStatusInfo for all repos in the workspace.
    //   No git subprocess is spawned — reads in-memory cache only.
    // ------------------------------------------------------------------
    router.get('/api/projects/:id/workspaces/:wid/status', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        const { id: projectId, wid: workspaceId } = params;

        // Validate project exists
        const project = resolveProject(res, projectId);
        if (project === undefined) return;

        // Validate workspace exists
        if (resolveWorkspace(res, projectId, workspaceId) === undefined) return;

        // Build per-repo status map from cache — no git I/O.
        const statusMap: WorkspaceStatusResponse = {};
        for (const repoId of project.Repositories) {
            const repoPath = path.join(config.projectsFolder, projectId, workspaceId, repoId);
            statusMap[repoId] = pollingManager.getStatus(repoPath);
        }

        sendJson(res, 200, statusMap);
    });

    // ------------------------------------------------------------------
    // POST /api/projects/:id/workspaces/:wid/status/refresh
    //   Triggers an on-demand PollingManager.refreshWorkspace() call and
    //   returns 200 with the freshly updated cache snapshot.
    // ------------------------------------------------------------------
    router.post('/api/projects/:id/workspaces/:wid/status/refresh', async (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const { id: projectId, wid: workspaceId } = params;

        // Validate project exists before doing any I/O.
        const project = resolveProject(res, projectId);
        if (project === undefined) return;

        // Validate workspace exists.
        if (resolveWorkspace(res, projectId, workspaceId) === undefined) return;

        // Refresh: pollingManager updates its cache with fresh git status.
        try {
            await pollingManager.refreshWorkspace(projectId, workspaceId);
        } catch (err) {
            if (err instanceof NotFoundError) {
                sendError(res, 404, err.message);
            } else {
                sendError(res, 500, 'Internal server error.');
            }
            return;
        }

        // Return the freshly cached status for all repos in the workspace.
        const statusMap: WorkspaceStatusResponse = {};
        for (const repoId of project.Repositories) {
            const repoPath = path.join(config.projectsFolder, projectId, workspaceId, repoId);
            statusMap[repoId] = pollingManager.getStatus(repoPath);
        }

        sendJson(res, 200, statusMap);
    });
}

```
###  Path: `/src/server/routes/workspaces.ts`

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Router } from '../router.js';
import type { WorkspaceManager } from '../../models/workspace/workspace.manager.js';
import type { WorkspaceOrchestrator } from '../../orchestration/workspace-orchestrator.js';
import type { ProjectManager } from '../../models/project/project.manager.js';
import type { AppConfig } from '../../config/config.types.js';
import type { ErrorLogManager } from '../../error-log/error-log.manager.js';
import type { WorkspaceInfo } from '../../models/workspace/workspace.types.js';
import { NotFoundError } from '../../errors.js';
import { parseJsonBody, sendJson, sendError, isPlainObject } from '../requestUtils.js';
import { generateWorkspaceFile, getWorkspaceFilePath } from '../../orchestration/vscode-workspace.js';
import { checkWorkspaceHealth } from '../../orchestration/workspace-health.js';
import { launchApplication } from '../app-launcher.js';

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers workspace routes for the `/api/projects/:id/workspaces` resource
 * group on the provided `Router` instance.
 *
 * Handlers delegate to the supplied `WorkspaceManager`, `ProjectManager`,
 * and (on launch failure) `ErrorLogManager`, mapping results or errors to the
 * appropriate HTTP status codes:
 *
 * | Method | Path                                                              | Success | Failure     |
 * |--------|-------------------------------------------------------------------|---------|-------------|
 * | GET    | /api/projects/:id/workspaces                                     | 200     | 404         |
 * | POST   | /api/projects/:id/workspaces                                     | 201     | 400/404     |
 * | GET    | /api/projects/:id/workspaces/:wid                                | 200     | 404         |
 * | PUT    | /api/projects/:id/workspaces/:wid                                | 200     | 400/404     |
 * | PUT    | /api/projects/:id/workspaces/:wid/rename                         | 200     | 400/404     |
 * | DELETE | /api/projects/:id/workspaces/:wid                                | 204     | 404         |
 * | POST   | /api/projects/:id/workspaces/:wid/setup                          | 200     | 400/404/500 |
 * | GET    | /api/projects/:id/workspaces/:wid/health                         | 200     | 404         |
 * | POST   | /api/projects/:id/workspaces/:wid/regenerate-workspace-file      | 200     | 400/404/500 |
 * | POST   | /api/projects/:id/workspaces/:wid/launch/vscode                  | 200     | 400/404/500 |
 * | POST   | /api/projects/:id/workspaces/:wid/launch/github-desktop/:rid     | 200     | 400/404/500 |
 */
export function registerWorkspaceRoutes(
    router: Router,
    workspaceManager: WorkspaceManager,
    workspaceOrchestrator: WorkspaceOrchestrator,
    appConfig: AppConfig,
    projectManager: ProjectManager,
    errorLogManager: ErrorLogManager,
    /**
     * Overrides the default `launchApplication` function.
     *
     * **For testing only.** Production callers must not pass this argument.
     * When omitted, the real `launchApplication` (from `app-launcher.ts`) is used.
     *
     * @param command - Application command name (e.g. `'code'`, `'github'`).
     * @param args    - Arguments passed to the spawned process.
     * @returns       A Promise that resolves when the application launches successfully,
     *                or rejects with an `Error` if the OS-level spawn fails.
     */
    launchFn: (command: string, args: string[]) => Promise<void> = launchApplication,
): void {

    // Helper: compute absolute workspace folder path.
    function workspaceFolder(projectId: string, workspaceId: string): string {
        return path.join(appConfig.projectsFolder, projectId, workspaceId);
    }

    // Helper: augment a WorkspaceInfo with an `Initialized` boolean and `FolderPath` string.
    function withInitialized<T extends { ProjectID: string; WorkspaceID: string }>(ws: T): T & { Initialized: boolean; FolderPath: string } {
        const wsFolder = workspaceFolder(ws.ProjectID, ws.WorkspaceID);
        return { ...ws, Initialized: fs.existsSync(wsFolder), FolderPath: wsFolder };
    }

    /**
     * Look up a workspace by project and workspace ID.
     *
     * Sends a `404` response and returns `undefined` when the workspace (or its
     * parent project) cannot be found, so callers can use a one-line early-exit
     * guard:
     *
     * ```ts
     * const workspace = resolveWorkspace(res, projectId, workspaceId);
     * if (workspace === undefined) return; // 404 already sent
     * ```
     *
     * @param res         - The outgoing HTTP response (used to send the 404 error).
     * @param projectId   - The ID of the parent project.
     * @param workspaceId - The ID of the workspace to look up.
     * @returns The matching `WorkspaceInfo` on success, or `undefined` when a 404
     *          has already been written to `res`.
     */
    function resolveWorkspace(
        res: ServerResponse,
        projectId: string,
        workspaceId: string,
    ): WorkspaceInfo | undefined {
        try {
            const ws = workspaceManager.getById(projectId, workspaceId);
            if (ws === undefined) {
                sendError(res, 404, `Workspace "${workspaceId}" not found in project "${projectId}".`);
                return undefined;
            }
            return ws;
        } catch (err) {
            sendError(res, 404, err instanceof Error ? err.message : 'Not found.');
            return undefined;
        }
    }

    // ------------------------------------------------------------------
    // GET /api/projects/:id/workspaces — list all workspaces
    // ------------------------------------------------------------------
    router.get('/api/projects/:id/workspaces', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        try {
            const workspaces = workspaceManager.list(params['id']);
            sendJson(res, 200, workspaces.map(withInitialized));
        } catch (err) {
            if (err instanceof NotFoundError) {
                sendError(res, 404, err.message);
            } else {
                sendError(res, 500, 'Internal server error.');
            }
        }
    });

    // ------------------------------------------------------------------
    // POST /api/projects/:id/workspaces — create a workspace
    // ------------------------------------------------------------------
    router.post('/api/projects/:id/workspaces', async (
        req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        let body: unknown;
        try {
            body = await parseJsonBody(req);
        } catch (err) {
            sendError(res, 400, err instanceof Error ? err.message : 'Invalid request body.');
            return;
        }

        if (!isPlainObject(body)) {
            sendError(res, 400, 'Request body must be a JSON object.');
            return;
        }

        const { workspaceId, description } = body as {
            workspaceId?: unknown;
            description?: unknown;
        };

        if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
            sendError(res, 400, 'Missing required field: workspaceId (non-empty string).');
            return;
        }

        const desc = typeof description === 'string' ? description : undefined;

        try {
            const created = workspaceManager.create(params['id'], workspaceId.trim(), desc);
            sendJson(res, 201, created);
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Could not create workspace.';
            const is404 = err instanceof NotFoundError;
            sendError(res, is404 ? 404 : 400, msg);
        }
    });

    // ------------------------------------------------------------------
    // GET /api/projects/:id/workspaces/:wid — get one workspace
    // ------------------------------------------------------------------
    router.get('/api/projects/:id/workspaces/:wid', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        const workspace = resolveWorkspace(res, params['id'], params['wid']);
        if (workspace === undefined) return;
        sendJson(res, 200, withInitialized(workspace));
    });

    // ------------------------------------------------------------------
    // PUT /api/projects/:id/workspaces/:wid — update workspace description
    // ------------------------------------------------------------------
    router.put('/api/projects/:id/workspaces/:wid', async (
        req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        let body: unknown;
        try {
            body = await parseJsonBody(req);
        } catch (err) {
            sendError(res, 400, err instanceof Error ? err.message : 'Invalid request body.');
            return;
        }

        if (!isPlainObject(body)) {
            sendError(res, 400, 'Request body must be a JSON object.');
            return;
        }

        const { description } = body as { description?: unknown };

        if (typeof description !== 'string') {
            sendError(res, 400, 'Missing required field: description (string).');
            return;
        }

        try {
            const updated = workspaceManager.update(params['id'], params['wid'], { Description: description });
            sendJson(res, 200, updated);
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Not found.';
            const is404 = err instanceof NotFoundError;
            sendError(res, is404 ? 404 : 400, msg);
        }
    });

    // ------------------------------------------------------------------
    // PUT /api/projects/:id/workspaces/:wid/rename — rename a workspace
    // ------------------------------------------------------------------
    router.put('/api/projects/:id/workspaces/:wid/rename', async (
        req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        let body: unknown;
        try {
            body = await parseJsonBody(req);
        } catch (err) {
            sendError(res, 400, err instanceof Error ? err.message : 'Invalid request body.');
            return;
        }

        if (!isPlainObject(body)) {
            sendError(res, 400, 'Request body must be a JSON object.');
            return;
        }

        const { newId } = body as { newId?: unknown };

        if (typeof newId !== 'string' || newId.trim() === '') {
            sendError(res, 400, 'Missing required field: newId (non-empty string).');
            return;
        }

        try {
            const renamed = workspaceManager.rename(params['id'], params['wid'], newId.trim());
            sendJson(res, 200, renamed);
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Could not rename workspace.';
            const is404 = err instanceof NotFoundError;
            sendError(res, is404 ? 404 : 400, msg);
        }
    });

    // ------------------------------------------------------------------
    // DELETE /api/projects/:id/workspaces/:wid — delete a workspace
    // ------------------------------------------------------------------
    router.delete('/api/projects/:id/workspaces/:wid', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        try {
            workspaceManager.remove(params['id'], params['wid']);
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Not found.';
            const is404 = err instanceof NotFoundError;
            sendError(res, is404 ? 404 : 400, msg);
            return;
        }
        res.writeHead(204, {});
        res.end('');
    });

    // ------------------------------------------------------------------
    // POST /api/projects/:id/workspaces/:wid/setup — initialize workspace
    // filesystem (create folder, clone repos, generate .code-workspace file).
    // Idempotent: skips repositories whose folder already exists on disk.
    // ------------------------------------------------------------------
    router.post('/api/projects/:id/workspaces/:wid/setup', async (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const projectId = params['id'];
        const workspaceId = params['wid'];

        // Verify workspace data entry exists
        if (resolveWorkspace(res, projectId, workspaceId) === undefined) return;

        try {
            const result = await workspaceOrchestrator.createWorkspace(projectId, workspaceId);
            sendJson(res, 200, result);
        } catch (err) {
            sendError(res, 500, err instanceof Error ? err.message : 'Failed to set up workspace.');
        }
    });

    // ------------------------------------------------------------------
    // POST /api/projects/:id/workspaces/:wid/regenerate-workspace-file
    // Regenerates the .code-workspace file from the current project
    // repository list without cloning. Lightweight, no git operations.
    // ------------------------------------------------------------------
    router.post('/api/projects/:id/workspaces/:wid/regenerate-workspace-file', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        const projectId = params['id'];
        const workspaceId = params['wid'];

        // Verify project exists.
        const project = projectManager.getById(projectId);
        if (!project) {
            sendError(res, 404, `Project "${projectId}" not found.`);
            return;
        }

        // Verify workspace data entry exists.
        if (resolveWorkspace(res, projectId, workspaceId) === undefined) return;

        // Verify workspace folder exists on disk (workspace must be initialized).
        const wsFolder = workspaceFolder(projectId, workspaceId);
        if (!fs.existsSync(wsFolder)) {
            sendError(res, 400, `Workspace folder does not exist. Run setup first.`);
            return;
        }

        try {
            const repoPaths = project.Repositories.map((repoId) => ({
                slug: repoId,
                path: path.join(appConfig.projectsFolder, projectId, workspaceId, repoId),
            }));
            const wsFilePath = getWorkspaceFilePath(appConfig.projectsFolder, projectId, workspaceId);
            generateWorkspaceFile(workspaceId, repoPaths, wsFilePath);
            sendJson(res, 200, { success: true });
        } catch (err) {
            sendError(res, 500, err instanceof Error ? err.message : 'Failed to regenerate workspace file.');
        }
    });

    // ------------------------------------------------------------------
    // GET /api/projects/:id/workspaces/:wid/health
    // Returns a WorkspaceHealthReport describing any structural issues.
    // Uninitialized workspaces (folder not yet created) are considered
    // healthy and return { healthy: true, issues: [] } immediately.
    // ------------------------------------------------------------------
    router.get('/api/projects/:id/workspaces/:wid/health', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        const projectId   = params['id'];
        const workspaceId = params['wid'];

        // Verify project exists and obtain its repository list.
        const project = projectManager.getById(projectId);
        if (!project) {
            sendError(res, 404, `Project "${projectId}" not found.`);
            return;
        }

        // Verify workspace data entry exists.
        if (resolveWorkspace(res, projectId, workspaceId) === undefined) return;

        // Uninitialized workspaces are considered healthy — they have not been
        // set up yet, so structural checks are not applicable.
        const wsDir = workspaceFolder(projectId, workspaceId);
        if (!fs.existsSync(wsDir)) {
            sendJson(res, 200, { healthy: true, issues: [] });
            return;
        }

        const report = checkWorkspaceHealth(
            projectId,
            workspaceId,
            appConfig.projectsFolder,
            project.Repositories,
        );
        sendJson(res, 200, report);
    });

    // ------------------------------------------------------------------
    // POST /api/projects/:id/workspaces/:wid/launch/vscode
    // Opens the workspace's .code-workspace file in VS Code.
    // ------------------------------------------------------------------
    router.post('/api/projects/:id/workspaces/:wid/launch/vscode', async (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const projectId   = params['id'];
        const workspaceId = params['wid'];

        // Verify workspace data entry exists.
        if (resolveWorkspace(res, projectId, workspaceId) === undefined) return;

        // Verify the .code-workspace file exists on disk.
        const wsFilePath = getWorkspaceFilePath(appConfig.projectsFolder, projectId, workspaceId);
        if (!fs.existsSync(wsFilePath)) {
            sendError(res, 400, 'Workspace file does not exist. Run setup first.');
            return;
        }

        try {
            await launchFn('code', [wsFilePath]);
            sendJson(res, 200, { success: true });
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to launch VS Code.';
            errorLogManager.append({
                Severity: 'error',
                Source: 'app-launcher',
                Operation: 'launch-vscode',
                Context: { ProjectId: projectId, WorkspaceId: workspaceId },
                Message: message,
            });
            sendError(res, 500, message);
        }
    });

    // ------------------------------------------------------------------
    // POST /api/projects/:id/workspaces/:wid/launch/github-desktop/:rid
    // Opens a repository directory in GitHub Desktop.
    // ------------------------------------------------------------------
    router.post('/api/projects/:id/workspaces/:wid/launch/github-desktop/:rid', async (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const projectId   = params['id'];
        const workspaceId = params['wid'];
        const repoId      = params['rid'];

        // Verify project exists and contains the requested repository.
        const project = projectManager.getById(projectId);
        if (!project) {
            sendError(res, 404, `Project "${projectId}" not found.`);
            return;
        }
        // repoId is validated against the project allow-list here, which also prevents
        // path traversal: only IDs that were registered (kebab-case validated at creation
        // time) can match, so a segment like '..' can never reach the filesystem join below.
        if (!project.Repositories.includes(repoId)) {
            sendError(res, 404, `Repository "${repoId}" not found in project "${projectId}".`);
            return;
        }

        // Verify workspace data entry exists.
        if (resolveWorkspace(res, projectId, workspaceId) === undefined) return;

        // Verify the repository directory exists on disk.
        const repoDir = path.join(appConfig.projectsFolder, projectId, workspaceId, repoId);
        if (!fs.existsSync(repoDir)) {
            sendError(res, 400, 'Repository directory does not exist. Run setup first.');
            return;
        }

        try {
            await launchFn('github', [repoDir]);
            sendJson(res, 200, { success: true });
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to launch GitHub Desktop.';
            errorLogManager.append({
                Severity: 'error',
                Source: 'app-launcher',
                Operation: 'launch-github-desktop',
                Context: { ProjectId: projectId, WorkspaceId: workspaceId, RepositoryId: repoId },
                Message: message,
            });
            sendError(res, 500, message);
        }
    });
}

```
---
**File Statistics**
- **Size**: 73.68 KB
- **Lines**: 1905
File: `modules/server/architecture-routes.md`
