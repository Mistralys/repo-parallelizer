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
