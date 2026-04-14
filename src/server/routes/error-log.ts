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
