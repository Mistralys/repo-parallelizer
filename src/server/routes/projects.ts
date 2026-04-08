import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Router } from '../router.js';
import type { ProjectManager } from '../../models/project/project.manager.js';
import { NotFoundError } from '../../errors.js';
import { parseJsonBody, sendJson, sendError, isPlainObject } from '../requestUtils.js';

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
        const project = projectManager.getById(params['id']);
        if (project === undefined) {
            sendError(res, 404, `Project with ID "${params['id']}" not found.`);
            return;
        }
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
