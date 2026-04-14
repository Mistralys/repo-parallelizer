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
