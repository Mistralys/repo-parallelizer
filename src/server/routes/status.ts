import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Router } from '../router.js';
import type { PollingManager } from '../pollingManager.js';
import type { ProjectManager } from '../../models/project/project.manager.js';
import type { WorkspaceManager } from '../../models/workspace/workspace.manager.js';
import type { AppConfig } from '../../config/config.types.js';
import type { GitStatusInfo } from '../../git/git.types.js';
import type { ProjectData } from '../../models/project/project.types.js';
import type { WorkspaceInfo } from '../../models/workspace/workspace.types.js';
import { NotFoundError } from '../../errors.js';
import { sendJson, sendError } from '../requestUtils.js';

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

/**
 * Keyed by repository ID; values are the cached status snapshot (or null if
 * the repository has not been polled yet).
 */
export type WorkspaceStatusResponse = Record<string, GitStatusInfo | null>;

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers the two git-status routes nested under a workspace on the
 * provided `Router` instance.
 *
 * | Method | Path                                                 | Success | Failure |
 * |--------|------------------------------------------------------|---------|---------|
 * | GET    | /api/projects/:id/workspaces/:wid/status            | 200     | 404     |
 * | POST   | /api/projects/:id/workspaces/:wid/status/refresh    | 200     | 404     |
 *
 * @param router           - The Router to register routes on.
 * @param pollingManager   - Provides `getStatus(repoPath)` and `refreshWorkspace()`.
 * @param projectManager   - Used to resolve repository IDs for a project so that
 *                           repo paths can be computed for cache lookups.
 * @param workspaceManager - Used to verify that the requested workspace exists.
 * @param config           - Application configuration (provides `projectsFolder`).
 */
export function registerStatusRoutes(
    router: Router,
    pollingManager: PollingManager,
    projectManager: ProjectManager,
    workspaceManager: WorkspaceManager,
    config: AppConfig,
): void {
    /**
     * Look up a project by ID.
     *
     * Sends a `404` response and returns `undefined` when the project
     * cannot be found.
     *
     * @param res       - The outgoing HTTP response (used to send the 404 error).
     * @param projectId - The ID of the project to look up.
     * @returns The matching `ProjectData` on success, or `undefined` when a 404
     *          has already been written to `res`.
     */
    function resolveProject(
        res: ServerResponse,
        projectId: string,
    ): ProjectData | undefined {
        const project = projectManager.getById(projectId);
        if (!project) {
            sendError(res, 404, `Project with ID "${projectId}" not found.`);
            return undefined;
        }
        return project;
    }

    /**
     * Look up a workspace by project and workspace ID.
     *
     * Sends a `404` response and returns `undefined` when the workspace
     * (or its parent project) cannot be found.
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
    // GET /api/projects/:id/workspaces/:wid/status
    //   Returns the cached GitStatusInfo for all repos in the workspace.
    //   No git subprocess is spawned — reads in-memory cache only.
    // ------------------------------------------------------------------
    router.get('/api/projects/:id/workspaces/:wid/status', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        const { id: projectId, wid: workspaceId } = params;

        // Validate project exists
        const project = resolveProject(res, projectId);
        if (project === undefined) return;

        // Validate workspace exists
        if (resolveWorkspace(res, projectId, workspaceId) === undefined) return;

        // Build per-repo status map from cache — no git I/O.
        const statusMap: WorkspaceStatusResponse = {};
        for (const repoId of project.Repositories) {
            const repoPath = path.join(config.projectsFolder, projectId, workspaceId, repoId);
            statusMap[repoId] = pollingManager.getStatus(repoPath);
        }

        sendJson(res, 200, statusMap);
    });

    // ------------------------------------------------------------------
    // POST /api/projects/:id/workspaces/:wid/status/refresh
    //   Triggers an on-demand PollingManager.refreshWorkspace() call and
    //   returns 200 with the freshly updated cache snapshot.
    // ------------------------------------------------------------------
    router.post('/api/projects/:id/workspaces/:wid/status/refresh', async (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const { id: projectId, wid: workspaceId } = params;

        // Validate project exists before doing any I/O.
        const project = resolveProject(res, projectId);
        if (project === undefined) return;

        // Validate workspace exists.
        if (resolveWorkspace(res, projectId, workspaceId) === undefined) return;

        // Refresh: pollingManager updates its cache with fresh git status.
        try {
            await pollingManager.refreshWorkspace(projectId, workspaceId);
        } catch (err) {
            if (err instanceof NotFoundError) {
                sendError(res, 404, err.message);
            } else {
                sendError(res, 500, 'Internal server error.');
            }
            return;
        }

        // Return the freshly cached status for all repos in the workspace.
        const statusMap: WorkspaceStatusResponse = {};
        for (const repoId of project.Repositories) {
            const repoPath = path.join(config.projectsFolder, projectId, workspaceId, repoId);
            statusMap[repoId] = pollingManager.getStatus(repoPath);
        }

        sendJson(res, 200, statusMap);
    });
}
