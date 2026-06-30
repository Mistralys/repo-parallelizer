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
 * `PUT` request body: `{ id?: string, label: string, host: string, token: string }`.
 * When `id` is omitted, an ID is auto-generated from `label` as a kebab-case string
 * with a numeric suffix (-2, -3, …) appended on collision.
 * When `id` matches an existing entry, that entry is updated in-place (upsert).
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
    // Request body: { id?: string, label: string, host: string, token: string }
    //
    // - When `id` is omitted: auto-generates a kebab-case ID from `label`,
    //   appending a numeric suffix (-2, -3, …) if needed to avoid collisions.
    //   Always creates a new entry.
    // - When `id` is provided and matches an existing entry: upserts (replaces)
    //   the existing entry in-place.
    // - When `id` is provided and does NOT match any existing entry: creates a
    //   new entry with the given ID (after checking the ID is not already taken).
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

        // Validate required string fields.
        if (typeof label !== 'string' || label.trim() === '') {
            sendError(res, 400, 'Missing or invalid field "label": must be a non-empty string.');
            return;
        }
        if (typeof host !== 'string' || host.trim() === '') {
            sendError(res, 400, 'Missing or invalid field "host": must be a non-empty string.');
            return;
        }
        // Reject host values containing path separators, null bytes, or whitespace —
        // a hostname should contain none of these characters.
        if (/[/\\\0\s]/.test(host)) {
            sendError(res, 400, 'Invalid field "host": must not contain /, \\, null bytes, or whitespace.');
            return;
        }
        if (typeof token !== 'string' || token.trim() === '') {
            sendError(res, 400, 'Missing or invalid field "token": must be a non-empty string.');
            return;
        }

        // Validate optional `id` field when provided.
        if (id !== undefined && (typeof id !== 'string' || id.trim() === '')) {
            sendError(res, 400, 'Field "id", when provided, must be a non-empty string.');
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
        if (host.trim().length > MAX_CREDENTIAL_HOST_LENGTH) {
            sendError(res, 400, `"host" exceeds maximum length of ${MAX_CREDENTIAL_HOST_LENGTH} characters.`);
            return;
        }
        if (token.trim().length > MAX_CREDENTIAL_TOKEN_LENGTH) {
            sendError(res, 400, `"token" exceeds maximum length of ${MAX_CREDENTIAL_TOKEN_LENGTH} characters.`);
            return;
        }

        const cleanLabel = label.trim();
        const cleanHost = host.trim();
        const cleanToken = token.trim();

        const existingCredentials: GitCredentialEntry[] = appConfig.gitCredentials ?? [];

        let savedEntry: GitCredentialEntry;
        let auditOperation: string;

        if (id !== undefined) {
            // --- Upsert path: id is explicitly provided ---
            const cleanId = (id as string).trim();
            const existingIndex = existingCredentials.findIndex((e) => e.id === cleanId);

            if (existingIndex === -1) {
                // New entry with an explicit ID — no existing entry matches, so create.
                savedEntry = { id: cleanId, label: cleanLabel, host: cleanHost, token: cleanToken };
                appConfig.gitCredentials = [...existingCredentials, savedEntry];
                auditOperation = 'create-credential';
            } else {
                // Replace the existing entry at the same position.
                savedEntry = { id: cleanId, label: cleanLabel, host: cleanHost, token: cleanToken };
                const updated = [...existingCredentials];
                updated[existingIndex] = savedEntry;
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
