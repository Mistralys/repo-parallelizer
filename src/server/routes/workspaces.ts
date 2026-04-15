import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Router } from '../router.js';
import type { WorkspaceManager } from '../../models/workspace/workspace.manager.js';
import type { WorkspaceOrchestrator } from '../../orchestration/workspace-orchestrator.js';
import type { ProjectManager } from '../../models/project/project.manager.js';
import type { AppConfig } from '../../config/config.types.js';
import { NotFoundError } from '../../errors.js';
import { parseJsonBody, sendJson, sendError, isPlainObject } from '../requestUtils.js';
import { generateWorkspaceFile, getWorkspaceFilePath } from '../../orchestration/vscode-workspace.js';
import { checkWorkspaceHealth } from '../../orchestration/workspace-health.js';

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers workspace routes for the `/api/projects/:id/workspaces` resource
 * group on the provided `Router` instance.
 *
 * All handlers delegate to the supplied `WorkspaceManager` and map results
 * or errors to the appropriate HTTP status codes:
 *
 * | Method | Path                                                         | Success | Failure     |
 * |--------|--------------------------------------------------------------|---------|-------------|
 * | GET    | /api/projects/:id/workspaces                                | 200     | 404         |
 * | POST   | /api/projects/:id/workspaces                                | 201     | 400/404     |
 * | GET    | /api/projects/:id/workspaces/:wid                           | 200     | 404         |
 * | PUT    | /api/projects/:id/workspaces/:wid                           | 200     | 400/404     |
 * | PUT    | /api/projects/:id/workspaces/:wid/rename                    | 200     | 400/404     |
 * | DELETE | /api/projects/:id/workspaces/:wid                           | 204     | 404         |
 * | POST   | /api/projects/:id/workspaces/:wid/setup                     | 200     | 400/404/500 |
 * | GET    | /api/projects/:id/workspaces/:wid/health                    | 200     | 404         |
 * | POST   | /api/projects/:id/workspaces/:wid/regenerate-workspace-file | 200     | 400/404/500 |
 */
export function registerWorkspaceRoutes(
    router: Router,
    workspaceManager: WorkspaceManager,
    workspaceOrchestrator: WorkspaceOrchestrator,
    appConfig: AppConfig,
    projectManager: ProjectManager,
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
        try {
            const workspace = workspaceManager.getById(params['id'], params['wid']);
            if (workspace === undefined) {
                sendError(res, 404, `Workspace "${params['wid']}" not found in project "${params['id']}".`);
                return;
            }
            sendJson(res, 200, withInitialized(workspace));
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
        try {
            const ws = workspaceManager.getById(projectId, workspaceId);
            if (ws === undefined) {
                sendError(res, 404, `Workspace "${workspaceId}" not found in project "${projectId}".`);
                return;
            }
        } catch (err) {
            sendError(res, 404, err instanceof Error ? err.message : 'Not found.');
            return;
        }

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
        try {
            const ws = workspaceManager.getById(projectId, workspaceId);
            if (ws === undefined) {
                sendError(res, 404, `Workspace "${workspaceId}" not found in project "${projectId}".`);
                return;
            }
        } catch (err) {
            sendError(res, 404, err instanceof Error ? err.message : 'Not found.');
            return;
        }

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
        try {
            const ws = workspaceManager.getById(projectId, workspaceId);
            if (ws === undefined) {
                sendError(res, 404, `Workspace "${workspaceId}" not found in project "${projectId}".`);
                return;
            }
        } catch (err) {
            sendError(res, 404, err instanceof Error ? err.message : 'Not found.');
            return;
        }

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
}
