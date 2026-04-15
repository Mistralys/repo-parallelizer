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
