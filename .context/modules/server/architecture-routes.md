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
            └── notes.ts
            └── projects.ts
            └── repositories.ts
            └── status.ts
            └── version.ts
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
import type { AppConfig, GitCredentialEntry } from '../../config/config.types.js';
import type { PollingManager } from '../pollingManager.js';
import type { ErrorLogManager } from '../../error-log/error-log.manager.js';
import { saveConfigField } from '../../config/config.js';
import { parseJsonBody, sendJson, sendError, isPlainObject } from '../requestUtils.js';
import { toKebabCase } from '../../utils/slug.js';

// Polling-interval bounds — shared with settings UI (gui/public/js/views/settings.js).
import {
    MIN_POLLING_INTERVAL_SECONDS,
    MAX_POLLING_INTERVAL_SECONDS,
    MIN_NOTES_CARD_HEIGHT,
    MAX_NOTES_CARD_HEIGHT,
    MIN_NOTES_COLUMNS,
    MAX_NOTES_COLUMNS,
    MAX_CREDENTIAL_ID_LENGTH,
    MAX_CREDENTIAL_LABEL_LENGTH,
    MAX_CREDENTIAL_HOST_LENGTH,
    MAX_CREDENTIAL_TOKEN_LENGTH,
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
 * Type guard that returns `true` when `value` is a finite integer number.
 * Used by PUT route handlers to validate numeric config fields.
 *
 * @param value - The value to test (any type accepted).
 * @returns `true` when `value` is of type `number`, finite, and an integer; `false` otherwise.
 */
function isValidFiniteInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}

/**
 * Returns a copy of the credentials array with all tokens masked.
 */
function buildMaskedCredentials(
    credentials: GitCredentialEntry[] | undefined,
): GitCredentialEntry[] {
    if (!credentials) return [];
    return credentials.map((entry) => ({ ...entry, token: maskToken(entry.token) }));
}

/**
 * Generates a unique kebab-case ID from a label, appending a numeric suffix
 * (-2, -3, ...) when the base ID is already taken.
 *
 * @param label - The human-readable label to derive an ID from.
 * @param existingIds - The set of IDs already in use; the returned ID is
 *   guaranteed not to be a member of this set.
 * @returns A kebab-case string ID that is unique within `existingIds`.
 *
 * @remarks
 * When `toKebabCase(label)` returns an empty string (e.g. because `label`
 * consists entirely of special characters such as `"!!!"`), the function falls
 * back to `"credential"` as the base ID. Suffix disambiguation (-2, -3, …)
 * is still applied when needed, so labels like `"!!!"` and `"???"` resolve to
 * `"credential"` and `"credential-2"` respectively.
 *
 * @example
 * generateUniqueId('GitHub Personal', new Set())       // → 'github-personal'
 * generateUniqueId('GitHub Personal', new Set(['github-personal'])) // → 'github-personal-2'
 * generateUniqueId('!!!', new Set())                   // → 'credential'
 */
function generateUniqueId(label: string, existingIds: Set<string>): string {
    const baseId = toKebabCase(label) || 'credential';
    let candidateId = baseId;
    let suffix = 2;
    while (existingIds.has(candidateId)) {
        candidateId = `${baseId}-${suffix}`;
        suffix++;
    }
    return candidateId;
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
    /** Optional `ErrorLogManager`. When provided, credential mutations are audit-logged. */
    errorLogManager?: ErrorLogManager;
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
 * | DELETE | /api/config/credentials/:id       | Remove an entry           |
 *
 * `GET` returns a `GitCredentialEntry[]` array with tokens masked (`****` + last 4 chars).
 *
 * `PUT` request body: `{ id?: string, label: string, host?: string, token?: string }`.
 * When `id` is omitted (create): `host` and `token` are required; an ID is
 * auto-generated from `label` as a kebab-case string with a numeric suffix
 * (-2, -3, …) appended on collision.
 * When `id` matches an existing entry (update): `host` and `token` are optional;
 * omitting either retains the existing stored value. Only `label` is always required.
 * Response: the updated `GitCredentialEntry[]` array with tokens masked.
 *
 * `DELETE` response: the remaining `GitCredentialEntry[]` array with tokens masked
 * (empty array `[]` when the last entry is removed). Returns 404 when the `id` is unknown.
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
 * **Notes display endpoints:**
 *
 * | Method | Path                          | Description                                                                                                         |
 * |--------|-------------------------------|---------------------------------------------------------------------------------------------------------------------|
 * | GET    | /api/config/notes-display     | Return current `notesCardHeight` and `notesColumns`                                                                 |
 * | PUT    | /api/config/notes-display     | Update notes display settings (partial updates — all fields optional). Fields: `notesCardHeight` ∈ [120, 800] (integer px), `notesColumns` ∈ [1, 6] (integer) |
 *
 * Changes take effect immediately (the in-memory `appConfig` is mutated) and
 * are persisted to `config.json` via `saveConfigField()`.
 *
 * **Security:** tokens are never returned in full — only the last 4 characters
 * are exposed. The `host` field is validated to reject `/`, `\`, null bytes,
 * and whitespace (see WP-004 / constraints.md § Hostname Format).
 *
 * @param options - Named-options bag.
 * @param options.router - Express-style router to register routes on.
 * @param options.appConfig - Live application config object (mutated in-place on PUT).
 * @param options.configPath - Optional absolute path to `config.json`. Defaults to the tool-root `config.json`.
 * @param options.pollingManager - Optional `PollingManager`; when provided, `PUT /api/config/polling` restarts the polling loop.
 * @param options.errorLogManager - Optional `ErrorLogManager`; when provided, credential mutations (create, update, delete) are audit-logged at `Severity: 'audit'`, `Source: 'credential-audit'`.
 */
export function registerConfigRoutes(options: ConfigRoutesOptions): void {
    const { router, appConfig, configPath, pollingManager, errorLogManager } = options;
    // ------------------------------------------------------------------
    // GET /api/config/credentials — list all (tokens masked)
    // Returns GitCredentialEntry[] with tokens masked.
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
    //
    // Request body: { id?: string, label: string, host?: string, token?: string }
    //
    // - When `id` is omitted (create path): `host` and `token` are required.
    //   Auto-generates a kebab-case ID from `label`, appending a numeric suffix
    //   (-2, -3, …) if needed to avoid collisions.
    // - When `id` is provided and matches an existing entry (update path):
    //   `host` and `token` are optional — omitting them retains the existing
    //   values. Only `label` is always required.
    // - When `id` is provided and does NOT match any existing entry: treated as
    //   a create with an explicit ID; `host` and `token` are required.
    //
    // Returns 400 when the resulting ID would collide with an existing entry
    // that is NOT the one being updated (duplicate-ID rejection).
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

        const { id, label, host, token } = body as {
            id?: unknown;
            label?: unknown;
            host?: unknown;
            token?: unknown;
        };

        // Validate label — always required.
        if (typeof label !== 'string' || label.trim() === '') {
            sendError(res, 400, 'Missing or invalid field "label": must be a non-empty string.');
            return;
        }

        // Validate optional `id` field when provided.
        if (id !== undefined && (typeof id !== 'string' || id.trim() === '')) {
            sendError(res, 400, 'Field "id", when provided, must be a non-empty string.');
            return;
        }

        const existingCredentials: GitCredentialEntry[] = appConfig.gitCredentials ?? [];

        // Resolve the existing entry early — needed to determine whether host/token
        // may be omitted (update path) or are required (create path).
        let resolvedExistingIndex = -1;
        let resolvedExistingEntry: GitCredentialEntry | undefined;
        if (typeof id === 'string' && id.trim() !== '') {
            const cleanIdEarly = id.trim();
            resolvedExistingIndex = existingCredentials.findIndex((e) => e.id === cleanIdEarly);
            if (resolvedExistingIndex !== -1) {
                resolvedExistingEntry = existingCredentials[resolvedExistingIndex];
            }
        }
        const isUpdatePath = resolvedExistingEntry !== undefined;

        // Validate host: required for create, optional for update (retains existing value).
        if (!isUpdatePath && (typeof host !== 'string' || host.trim() === '')) {
            sendError(res, 400, 'Missing or invalid field "host": must be a non-empty string.');
            return;
        }
        // Reject unsafe host values when host is explicitly provided.
        if (typeof host === 'string' && host.trim() !== '' && /[/\\\0\s]/.test(host)) {
            sendError(res, 400, 'Invalid field "host": must not contain /, \\, null bytes, or whitespace.');
            return;
        }

        // Validate token: required for create, optional for update (retains existing value).
        if (!isUpdatePath && (typeof token !== 'string' || token.trim() === '')) {
            sendError(res, 400, 'Missing or invalid field "token": must be a non-empty string.');
            return;
        }

        // Per-field length limits.
        if (typeof id === 'string' && id.trim().length > MAX_CREDENTIAL_ID_LENGTH) {
            sendError(res, 400, `"id" exceeds maximum length of ${MAX_CREDENTIAL_ID_LENGTH} characters.`);
            return;
        }
        if (label.trim().length > MAX_CREDENTIAL_LABEL_LENGTH) {
            sendError(res, 400, `"label" exceeds maximum length of ${MAX_CREDENTIAL_LABEL_LENGTH} characters.`);
            return;
        }
        if (typeof host === 'string' && host.trim().length > MAX_CREDENTIAL_HOST_LENGTH) {
            sendError(res, 400, `"host" exceeds maximum length of ${MAX_CREDENTIAL_HOST_LENGTH} characters.`);
            return;
        }
        if (typeof token === 'string' && token.trim().length > MAX_CREDENTIAL_TOKEN_LENGTH) {
            sendError(res, 400, `"token" exceeds maximum length of ${MAX_CREDENTIAL_TOKEN_LENGTH} characters.`);
            return;
        }

        const cleanLabel = label.trim();
        // Use the provided value; on the update path fall back to the existing entry's value.
        // Lowercased — hostnames are case-insensitive, and matching elsewhere compares
        // against a URL-derived host that is always lowercase (extractHost()).
        const cleanHost = (typeof host === 'string' && host.trim() !== '')
            ? host.trim().toLowerCase()
            : resolvedExistingEntry!.host;
        const cleanToken = (typeof token === 'string' && token.trim() !== '')
            ? token.trim()
            : resolvedExistingEntry!.token;

        let savedEntry: GitCredentialEntry;
        let auditOperation: string;

        if (id !== undefined) {
            // --- Upsert path: id is explicitly provided ---
            const cleanId = (id as string).trim();

            if (resolvedExistingIndex === -1) {
                // New entry with an explicit ID — no existing entry matches, so create.
                // host and token were validated as required above (isUpdatePath === false).
                savedEntry = { id: cleanId, label: cleanLabel, host: cleanHost, token: cleanToken };
                appConfig.gitCredentials = [...existingCredentials, savedEntry];
                auditOperation = 'create-credential';
            } else {
                // Replace the existing entry at the same position.
                savedEntry = { id: cleanId, label: cleanLabel, host: cleanHost, token: cleanToken };
                const updated = [...existingCredentials];
                updated[resolvedExistingIndex] = savedEntry;
                appConfig.gitCredentials = updated;
                auditOperation = 'update-credential';
            }
        } else {
            // --- Create path: no id provided — auto-generate from label ---
            const existingIds = new Set(existingCredentials.map((e) => e.id));
            const newId = generateUniqueId(cleanLabel, existingIds);
            savedEntry = { id: newId, label: cleanLabel, host: cleanHost, token: cleanToken };
            appConfig.gitCredentials = [...existingCredentials, savedEntry];
            auditOperation = 'create-credential';
        }

        // Persist to disk.
        saveConfigField('gitCredentials', appConfig.gitCredentials, configPath);

        // Audit log — never include the token value.
        errorLogManager?.append({
            Severity: 'audit',
            Source: 'credential-audit',
            Operation: auditOperation,
            Context: {},
            Message: `Credential "${savedEntry.id}" (label: "${savedEntry.label}", host: "${savedEntry.host}") was ${auditOperation === 'create-credential' ? 'created' : 'updated'}.`,
        });

        sendJson(res, 200, buildMaskedCredentials(appConfig.gitCredentials));
    });

    // ------------------------------------------------------------------
    // DELETE /api/config/credentials/:id — remove a single entry by id
    // Sync handler (no request body to parse — unlike the async PUT above).
    // ------------------------------------------------------------------
    router.delete('/api/config/credentials/:id', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        let credId: string;
        try {
            credId = decodeURIComponent(params['id']);
        } catch {
            sendError(res, 400, 'Malformed id parameter.');
            return;
        }

        const existing = appConfig.gitCredentials ?? [];
        const idx = existing.findIndex((e) => e.id === credId);

        if (idx === -1) {
            sendError(res, 404, `No credential entry found with id "${credId}".`);
            return;
        }

        const deletedEntry = existing[idx];
        const updated = existing.filter((_, i) => i !== idx);

        // When the array is empty, remove the field entirely.
        appConfig.gitCredentials = updated.length > 0 ? updated : undefined;

        saveConfigField('gitCredentials', appConfig.gitCredentials, configPath);

        // Audit log — never include the token value.
        errorLogManager?.append({
            Severity: 'audit',
            Source: 'credential-audit',
            Operation: 'delete-credential',
            Context: {},
            Message: `Credential "${deletedEntry.id}" (label: "${deletedEntry.label}", host: "${deletedEntry.host}") was deleted.`,
        });

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

        if (!isValidFiniteInteger(seconds)) {
            sendError(res, 400, 'Missing or invalid field "seconds": must be a finite integer.');
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

    // ------------------------------------------------------------------
    // GET /api/config/notes-display — return current notes display settings
    // ------------------------------------------------------------------
    router.get('/api/config/notes-display', (
        _req: IncomingMessage,
        res: ServerResponse,
        _params: Record<string, string>,
    ): void => {
        sendJson(res, 200, {
            notesCardHeight: appConfig.notesCardHeight,
            notesColumns: appConfig.notesColumns,
        });
    });

    // ------------------------------------------------------------------
    // PUT /api/config/notes-display — update notes display settings
    // Accepts partial updates: only provided fields are modified.
    // Validates: notesCardHeight ∈ [MIN_NOTES_CARD_HEIGHT, MAX_NOTES_CARD_HEIGHT]
    //            notesColumns    ∈ [MIN_NOTES_COLUMNS,    MAX_NOTES_COLUMNS]
    // ------------------------------------------------------------------
    router.put('/api/config/notes-display', async (
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

        const { notesCardHeight, notesColumns } = body as {
            notesCardHeight?: unknown;
            notesColumns?: unknown;
        };

        // Validate notesCardHeight if provided.
        if (notesCardHeight !== undefined) {
            if (!isValidFiniteInteger(notesCardHeight)) {
                sendError(res, 400, 'Field "notesCardHeight" must be a finite integer.');
                return;
            }
            if (notesCardHeight < MIN_NOTES_CARD_HEIGHT) {
                sendError(
                    res,
                    400,
                    `Field "notesCardHeight" must be at least ${MIN_NOTES_CARD_HEIGHT}. Received: ${notesCardHeight}.`,
                );
                return;
            }
            if (notesCardHeight > MAX_NOTES_CARD_HEIGHT) {
                sendError(
                    res,
                    400,
                    `Field "notesCardHeight" must be at most ${MAX_NOTES_CARD_HEIGHT}. Received: ${notesCardHeight}.`,
                );
                return;
            }
        }

        // Validate notesColumns if provided.
        if (notesColumns !== undefined) {
            if (!isValidFiniteInteger(notesColumns)) {
                sendError(res, 400, 'Field "notesColumns" must be a finite integer.');
                return;
            }
            if (notesColumns < MIN_NOTES_COLUMNS) {
                sendError(
                    res,
                    400,
                    `Field "notesColumns" must be at least ${MIN_NOTES_COLUMNS}. Received: ${notesColumns}.`,
                );
                return;
            }
            if (notesColumns > MAX_NOTES_COLUMNS) {
                sendError(
                    res,
                    400,
                    `Field "notesColumns" must be at most ${MAX_NOTES_COLUMNS}. Received: ${notesColumns}.`,
                );
                return;
            }
        }

        // Apply and persist only the fields that were provided.
        if (notesCardHeight !== undefined) {
            appConfig.notesCardHeight = notesCardHeight;
            saveConfigField('notesCardHeight', notesCardHeight, configPath);
        }

        if (notesColumns !== undefined) {
            appConfig.notesColumns = notesColumns;
            saveConfigField('notesColumns', notesColumns, configPath);
        }

        sendJson(res, 200, {
            notesCardHeight: appConfig.notesCardHeight,
            notesColumns: appConfig.notesColumns,
        });
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
// Module-scope constants
// ---------------------------------------------------------------------------

/** All accepted values for the `severity` query parameter. */
const VALID_SEVERITIES = new Set<ErrorSeverity>(['error', 'warning', 'audit', 'info']);

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
    //   severity  "error" | "warning" | "audit" | "info"
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
    //         "Severity": "error" | "warning" | "audit" | "info",
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
        const severity: ErrorSeverity | undefined =
            severityRaw !== undefined && VALID_SEVERITIES.has(severityRaw as ErrorSeverity)
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
###  Path: `/src/server/routes/notes.ts`

```ts
import type { Router } from '../router.js';
import type { ProjectManager } from '../../models/project/project.manager.js';
import type { WorkspaceManager } from '../../models/workspace/workspace.manager.js';
import { sendJson, sendError } from '../requestUtils.js';

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers the notes aggregate endpoint on the provided `Router` instance.
 *
 * | Method | Path        | Success | Failure |
 * |--------|-------------|---------|---------|
 * | GET    | /api/notes  | 200     | 500     |
 *
 * Response shape:
 * ```json
 * {
 *   "Projects": [
 *     {
 *       "ProjectId": "my-project",
 *       "ProjectName": "My Project",
 *       "Workspaces": [
 *         { "WorkspaceId": "STABLE", "Notes": "" },
 *         { "WorkspaceId": "DEV",    "Notes": "some notes" }
 *       ]
 *     }
 *   ]
 * }
 * ```
 *
 * All projects and all their workspaces are always included.  Workspaces
 * without stored notes have `Notes: ""`.
 */
export function registerNotesRoutes(
    router: Router,
    projectManager: ProjectManager,
    workspaceManager: WorkspaceManager,
): void {
    router.get('/api/notes', (_req, res) => {
        try {
            const projects = projectManager.list();
            const result = projects.map((p) => {
                const workspaces = workspaceManager.list(p.Id);
                return {
                    ProjectId: p.Id,
                    ProjectName: p.Name,
                    Workspaces: workspaces.map((ws) => ({
                        WorkspaceId: ws.WorkspaceID,
                        Notes: ws.Notes,
                    })),
                };
            });
            sendJson(res, 200, { Projects: result });
        } catch {
            sendError(res, 500, 'Internal server error.');
        }
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
import type { AppConfig, GitCredentialEntry } from '../../config/config.types.js';
import type { ErrorLogManager } from '../../error-log/error-log.manager.js';
import { extractHost, hostsEqual } from '../../git/git-credentials.js';

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers all routes for the `/api/repositories` resource group on the
 * provided `Router` instance. This includes the standard CRUD routes and the
 * credential-management routes that require access to the application
 * configuration.
 *
 * All handlers delegate to the supplied `RepositoryManager` and map results
 * or errors to the appropriate HTTP status codes:
 *
 * | Method | Path                                        | Success | Failure |
 * |--------|---------------------------------------------|---------|---------|
 * | GET    | /api/repositories                           | 200     | —       |
 * | GET    | /api/repositories/:id                       | 200     | 404     |
 * | POST   | /api/repositories                           | 201     | 400     |
 * | PUT    | /api/repositories/:id                       | 200     | 400/404 |
 * | DELETE | /api/repositories/:id                       | 204     | 404     |
 * | POST   | /api/repositories/:id/refresh-timestamp     | 200     | 404     |
 * | PUT    | /api/repositories/:id/credential            | 200     | 400/404 |
 * | GET    | /api/repositories/:id/credential-options    | 200     | 404     |
 * | GET    | /api/repositories/credential-options        | 200     | 400     |
 */
export function registerRepositoryRoutes(
    router: Router,
    repoManager: RepositoryManager,
    appConfig: AppConfig,
    errorLogManager?: ErrorLogManager,
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

    /**
     * Filters `credentials` down to those whose `host` matches `host`, masks
     * their tokens, and computes `autoSelected` when exactly one credential
     * matches. Shared by the by-ID and by-URL credential-options handlers so
     * the filter/mask/`autoSelected` computation cannot drift between them.
     *
     * @param host        - The hostname to match against, or `null` when the
     *                      source URL has no extractable host (e.g. SSH URLs),
     *                      in which case no credentials match.
     * @param credentials - The full set of configured Git credential entries.
     */
    function buildCredentialOptionsResponse(
        host: string | null,
        credentials: GitCredentialEntry[],
    ): { credentials: GitCredentialEntry[]; autoSelected?: string } {
        const matching = host !== null
            ? credentials.filter((c) => hostsEqual(c.host, host))
            : [];

        // Mask tokens before sending — never expose raw tokens over the API.
        const maskedCredentials: GitCredentialEntry[] = matching.map((c) => ({
            ...c,
            token: '***',
        }));

        const responseBody: { credentials: GitCredentialEntry[]; autoSelected?: string } = {
            credentials: maskedCredentials,
        };

        if (matching.length === 1) {
            responseBody.autoSelected = matching[0].id;
        }

        return responseBody;
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
    // GET /api/repositories/credential-options?url= — list matching credentials
    //   for an arbitrary URL, without requiring an existing repository record.
    //
    //   Registered before GET /api/repositories/:id — both patterns have the
    //   same path-segment count, so registration order decides which one
    //   matches first (mirrors the /sources-before-/:id precedent in
    //   error-log.ts's route registration).
    //
    //   Used by the create/edit repository modal to match credentials as the
    //   user types a URL, before the repository is saved (create mode) or as
    //   the URL field is edited in-place (edit mode).
    //
    //   Query parameter:
    //     url — required, non-empty string. 400 when missing or empty.
    //
    //   Response shape mirrors GET /:id/credential-options:
    //     {
    //       credentials: GitCredentialEntry[],  // token masked
    //       autoSelected?: string               // id of the sole matching credential
    //     }
    // ------------------------------------------------------------------
    router.get('/api/repositories/credential-options', (
        req: IncomingMessage,
        res: ServerResponse,
        _params: Record<string, string>,
    ): void => {
        const rawUrl = req.url ?? '';
        const queryString = rawUrl.includes('?') ? rawUrl.split('?')[1] : '';
        const qs = new URLSearchParams(queryString);
        const url = qs.get('url');

        if (url === null || url.trim() === '') {
            sendError(res, 400, 'Missing required query parameter: url (non-empty string).');
            return;
        }

        const credentials: GitCredentialEntry[] = appConfig.gitCredentials ?? [];
        const host = extractHost(url.trim());

        const responseBody = buildCredentialOptionsResponse(host, credentials);
        sendJson(res, 200, responseBody);
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

        // Captured pre-update so a subsequent URL-driven host change can be
        // compared against the credential association that existed before this
        // request (see host-incoherence auto-clear below).
        const preUpdateRepo = resolveRepository(res, id);
        if (preUpdateRepo === undefined) return;

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

        const { name, url } = body as { name?: unknown; url?: unknown };

        if (typeof name !== 'string' || name.trim() === '') {
            sendError(res, 400, 'Missing required field: name (non-empty string).');
            return;
        }

        if (url !== undefined && (typeof url !== 'string' || url.trim() === '')) {
            sendError(res, 400, 'Field url, when provided, must be a non-empty string.');
            return;
        }

        const updateParams: { name: string; url?: string } = { name: name.trim() };
        if (typeof url === 'string') updateParams.url = url;

        try {
            let updated = repoManager.update(id, updateParams);

            // Host-incoherence auto-clear: a URL edit that moves the repository
            // to a different host can strand a pinned CredentialId pointing at
            // the old host. Mirrors PUT /:id/credential's host-coherence guard,
            // but clears rather than rejects since this is an incidental side
            // effect of an otherwise-valid name/URL edit.
            if (typeof url === 'string' && preUpdateRepo.CredentialId !== undefined) {
                const credentials: GitCredentialEntry[] = appConfig.gitCredentials ?? [];
                const credential = credentials.find((c) => c.id === preUpdateRepo.CredentialId);
                const newHost = extractHost(updated.Url);

                if (credential !== undefined && newHost !== null && !hostsEqual(credential.host, newHost)) {
                    updated = repoManager.updateCredential(id, null);
                    errorLogManager?.append({
                        Severity: 'audit',
                        Source: 'credential-audit',
                        Operation: 'clear-credential',
                        Context: { RepositoryId: id },
                        Message: `Credential association cleared for repository "${id}" after a URL edit changed its host.`,
                    });
                }
            }

            sendJson(res, 200, updated);
        } catch (err) {
            // update() throws NotFoundError if the ID was removed
            // between the resolveRepository() check and the update() call
            // (race condition). Any other Error (e.g. duplicate URL) is
            // surfaced as a 400, mirroring POST /api/repositories.
            if (err instanceof NotFoundError) {
                sendError(res, 404, err.message);
            } else {
                sendError(res, 400, err instanceof Error ? err.message : 'Could not update repository.');
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

    // ------------------------------------------------------------------
    // POST /api/repositories/:id/refresh-timestamp — record manual refresh
    //   Writes the current timestamp to LastRefreshedAt for the repository.
    //   Called by the GUI whenever the user triggers a manual refresh on
    //   the repository detail screen.
    // ------------------------------------------------------------------
    router.post('/api/repositories/:id/refresh-timestamp', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        const id = params['id'];
        try {
            const updated = repoManager.touchRefreshTimestamp(id);
            sendJson(res, 200, updated);
        } catch (err) {
            if (err instanceof NotFoundError) {
                sendError(res, 404, err.message);
            } else {
                sendError(res, 500, 'Internal server error.');
            }
        }
    });

    // ------------------------------------------------------------------
    // PUT /api/repositories/:id/credential — set or clear credential
    //
    //   Accepts `{ credentialId: string | null }`.
    //   - When `credentialId` is a non-empty string, validates that it
    //     references an existing entry in `appConfig.gitCredentials`, then
    //     calls `RepositoryManager.updateCredential()` to persist the
    //     association.
    //   - When `credentialId` is `null`, clears the association.
    //   Returns the updated `Repository` on success (200).
    // ------------------------------------------------------------------
    router.put('/api/repositories/:id/credential', async (
        req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const id = params['id'];

        const repo = resolveRepository(res, id);
        if (repo === undefined) return;

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

        const { credentialId } = body as { credentialId?: unknown };

        if (credentialId !== null && typeof credentialId !== 'string') {
            sendError(res, 400, 'Missing required field: credentialId (string or null).');
            return;
        }

        if (typeof credentialId === 'string') {
            // Validate that the referenced credential exists in the config.
            const credentials: GitCredentialEntry[] = appConfig.gitCredentials ?? [];
            const credential = credentials.find((c) => c.id === credentialId);
            if (!credential) {
                sendError(
                    res,
                    400,
                    `Credential with ID "${credentialId}" does not exist in the application configuration.`,
                );
                return;
            }

            // Host-coherence guard: reject when the credential's host does not
            // match the repository URL's hostname. SSH URLs (null repoHost) are
            // exempt — SSH auth is not handled by credential tokens.
            const repoHost = extractHost(repo.Url);
            if (repoHost !== null && !hostsEqual(credential.host, repoHost)) {
                sendError(
                    res,
                    400,
                    `Credential "${credentialId}" is configured for host "${credential.host}" but repository URL resolves to "${repoHost}".`,
                );
                return;
            }
        }

        try {
            const updated = repoManager.updateCredential(id, credentialId as string | null);

            // Audit log — emit assign or clear event.
            const auditOperation = credentialId === null ? 'clear-credential' : 'assign-credential';
            errorLogManager?.append({
                Severity: 'audit',
                Source: 'credential-audit',
                Operation: auditOperation,
                Context: { RepositoryId: id },
                Message: credentialId === null
                    ? `Credential association cleared for repository "${id}".`
                    : `Credential "${credentialId}" assigned to repository "${id}".`,
            });

            sendJson(res, 200, updated);
        } catch (err) {
            if (err instanceof NotFoundError) {
                sendError(res, 404, err.message);
            } else {
                sendError(res, 500, 'Internal server error.');
            }
        }
    });

    // ------------------------------------------------------------------
    // GET /api/repositories/:id/credential-options — list matching credentials
    //
    //   Returns the subset of `appConfig.gitCredentials` whose `host` matches
    //   the hostname of the repository's remote URL.  Tokens are masked (replaced
    //   with `"***"`) before being sent to the client.
    //
    //   Response shape:
    //     {
    //       credentials: GitCredentialEntry[],  // token masked
    //       autoSelected?: string               // id of the sole matching credential
    //     }
    //
    //   `autoSelected` is included only when exactly one credential matches the
    //   repository's host.
    // ------------------------------------------------------------------
    router.get('/api/repositories/:id/credential-options', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        const id = params['id'];

        const repo = resolveRepository(res, id);
        if (repo === undefined) return;

        const credentials: GitCredentialEntry[] = appConfig.gitCredentials ?? [];
        const repoHost = extractHost(repo.Url);

        const responseBody = buildCredentialOptionsResponse(repoHost, credentials);
        sendJson(res, 200, responseBody);
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
###  Path: `/src/server/routes/version.ts`

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Router } from '../router.js';
import { sendJson } from '../requestUtils.js';
import { getToolRoot } from '../../utils/paths.js';

// ---------------------------------------------------------------------------
// Version resolution — read both package.json files once at module load time.
// ---------------------------------------------------------------------------

function readVersion(pkgPath: string): string {
    try {
        const raw = fs.readFileSync(pkgPath, 'utf8');
        const pkg = JSON.parse(raw) as { version?: unknown };
        return typeof pkg.version === 'string' && pkg.version.length > 0
            ? pkg.version
            : 'unknown';
    } catch {
        return 'unknown';
    }
}

const toolRoot = getToolRoot();
const appVersion  = readVersion(path.join(toolRoot, 'package.json'));
const guiVersion  = readVersion(path.join(toolRoot, 'gui', 'package.json'));

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers the version endpoint.
 *
 * | Method | Path          | Description                                      |
 * |--------|---------------|--------------------------------------------------|
 * | GET    | /api/version  | Return app and GUI version strings from package.json. |
 *
 * Response shape: `{ appVersion: string, guiVersion: string }`
 */
export function registerVersionRoute(router: Router): void {
    router.get('/api/version', (_req, res) => {
        sendJson(res, 200, { appVersion, guiVersion });
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
    // PUT /api/projects/:id/workspaces/:wid — update workspace description and/or notes
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

        const { description, notes } = body as { description?: unknown; notes?: unknown };

        const hasDescription = typeof description === 'string';
        const hasNotes = typeof notes === 'string';

        if (!hasDescription && !hasNotes) {
            sendError(res, 400, 'Request body must include at least one updatable field: description or notes.');
            return;
        }

        const changes: { Description?: string; Notes?: string } = {};
        if (hasDescription) changes.Description = description as string;
        if (hasNotes) changes.Notes = notes as string;

        try {
            const updated = workspaceManager.update(params['id'], params['wid'], changes);
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
            errorLogManager,
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
- **Size**: 83.97 KB
- **Lines**: 2178
File: `modules/server/architecture-routes.md`
