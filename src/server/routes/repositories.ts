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
