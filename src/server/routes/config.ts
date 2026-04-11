import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Router } from '../router.js';
import type { AppConfig } from '../../config/config.types.js';
import { saveConfigField } from '../../config/config.js';
import { parseJsonBody, sendJson, sendError, isPlainObject } from '../requestUtils.js';

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

/**
 * Registers REST endpoints for managing `gitCredentials` in `config.json`.
 *
 * | Method | Path                              | Description               |
 * |--------|-----------------------------------|---------------------------|
 * | GET    | /api/config/credentials           | List credentials (masked) |
 * | PUT    | /api/config/credentials           | Add / update an entry     |
 * | DELETE | /api/config/credentials/:host     | Remove an entry           |
 *
 * Changes take effect immediately (the in-memory `appConfig` is mutated) and
 * are persisted to `config.json` via `saveConfigField()`.
 *
 * **Security:** tokens are never returned in full — only the last 4 characters
 * are exposed. The `host` field is validated against an injection-safe pattern.
 *
 * @param configPath - Optional absolute path to `config.json`. Defaults to the
 *   tool-root `config.json`. Pass a custom path in tests to avoid touching the
 *   real config file.
 */
export function registerConfigRoutes(
    router: Router,
    appConfig: AppConfig,
    configPath?: string,
): void {
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
}
