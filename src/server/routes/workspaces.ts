import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Router } from '../router.js';
import type { WorkspaceManager } from '../../models/workspace/workspace.manager.js';
import { NotFoundError } from '../../errors.js';
import { parseJsonBody, sendJson, sendError, isPlainObject } from '../requestUtils.js';

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers the six CRUD routes for the `/api/projects/:id/workspaces` resource
 * group on the provided `Router` instance.
 *
 * All handlers delegate to the supplied `WorkspaceManager` and map results
 * or errors to the appropriate HTTP status codes:
 *
 * | Method | Path                                             | Success | Failure |
 * |--------|--------------------------------------------------|---------|---------|
 * | GET    | /api/projects/:id/workspaces                    | 200     | 404     |
 * | POST   | /api/projects/:id/workspaces                    | 201     | 400/404 |
 * | GET    | /api/projects/:id/workspaces/:wid               | 200     | 404     |
 * | PUT    | /api/projects/:id/workspaces/:wid/rename        | 200     | 404/400 |
 * | DELETE | /api/projects/:id/workspaces/:wid               | 204     | 404     |
 *
 * Note: the spec lists 6 handlers; the 6th is the implicit update (description)
 * for a workspace via PUT /api/projects/:id/workspaces/:wid.
 */
export function registerWorkspaceRoutes(
    router: Router,
    workspaceManager: WorkspaceManager,
): void {
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
            sendJson(res, 200, workspaces);
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
        try {
            const workspace = workspaceManager.getById(params['id'], params['wid']);
            if (workspace === undefined) {
                sendError(res, 404, `Workspace "${params['wid']}" not found in project "${params['id']}".`);
                return;
            }
            sendJson(res, 200, workspace);
        } catch (err) {
            // getById throws when the project does not exist
            sendError(res, 404, err instanceof Error ? err.message : 'Not found.');
        }
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
}
