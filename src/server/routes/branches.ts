import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Router } from '../router.js';
import type { BranchOrchestrator } from '../../orchestration/branch-orchestrator.js';
import type { WorkspaceManager } from '../../models/workspace/workspace.manager.js';
import { NotFoundError } from '../../errors.js';
import { parseJsonBody, sendJson, sendError, isPlainObject } from '../requestUtils.js';
import type { BranchInfo } from '../../git/git.types.js';

// ---------------------------------------------------------------------------
// Response shape for the GET branches endpoint
// ---------------------------------------------------------------------------

export interface BranchesResponse {
    /** Branches grouped by repository ID. */
    branches: Record<string, BranchInfo[]>;
    /** Compiled, sorted, deduplicated branch name suggestions for UI. */
    suggestions: string[];
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers the two branch-related routes nested under a workspace on the
 * provided `Router` instance.
 *
 * | Method | Path                                                      | Success | Failure |
 * |--------|-----------------------------------------------------------|---------|---------|
 * | GET    | /api/projects/:id/workspaces/:wid/branches               | 200     | 404     |
 * | POST   | /api/projects/:id/workspaces/:wid/branches/switch        | 200     | 400/404 |
 *
 * @param router           - The Router to register routes on.
 * @param orchestrator     - Provides `getAvailableBranches()`, `compileBranchSuggestions()`,
 *                           and `switchBranches()`.
 * @param workspaceManager - Used to verify that the requested workspace exists before
 *                           delegating to the orchestrator.
 */
export function registerBranchRoutes(
    router: Router,
    orchestrator: BranchOrchestrator,
    workspaceManager: WorkspaceManager,
): void {
    // ------------------------------------------------------------------
    // GET /api/projects/:id/workspaces/:wid/branches
    //   Returns available branches per repository + compiled suggestions.
    // ------------------------------------------------------------------
    router.get('/api/projects/:id/workspaces/:wid/branches', async (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const { id: projectId, wid: workspaceId } = params;

        // Validate workspace existence before issuing git operations.
        try {
            const ws = workspaceManager.getById(projectId, workspaceId);
            if (ws === undefined) {
                sendError(res, 404, `Workspace "${workspaceId}" not found in project "${projectId}".`);
                return;
            }
        } catch (err) {
            // getById throws when the project does not exist.
            sendError(res, 404, err instanceof Error ? err.message : 'Project not found.');
            return;
        }

        try {
            const branchMap = await orchestrator.getAvailableBranches(projectId, workspaceId);
            const suggestions = orchestrator.compileBranchSuggestions(branchMap);

            // Convert the Map to a plain object for JSON serialisation.
            const branches: Record<string, BranchInfo[]> = {};
            for (const [repoId, infos] of branchMap) {
                branches[repoId] = infos;
            }

            const payload: BranchesResponse = { branches, suggestions };
            sendJson(res, 200, payload);
        } catch (err) {
            if (err instanceof NotFoundError) {
                sendError(res, 404, err.message);
            } else {
                sendError(res, 500, 'Internal server error.');
            }
        }
    });

    // ------------------------------------------------------------------
    // POST /api/projects/:id/workspaces/:wid/branches/switch
    //   Executes branch-switch assignments, returns per-repo results.
    // ------------------------------------------------------------------
    router.post('/api/projects/:id/workspaces/:wid/branches/switch', async (
        req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const { id: projectId, wid: workspaceId } = params;

        // Validate workspace existence before touching the filesystem.
        try {
            const ws = workspaceManager.getById(projectId, workspaceId);
            if (ws === undefined) {
                sendError(res, 404, `Workspace "${workspaceId}" not found in project "${projectId}".`);
                return;
            }
        } catch (err) {
            sendError(res, 404, err instanceof Error ? err.message : 'Project not found.');
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

        const { assignments } = body as { assignments?: unknown };

        if (!isPlainObject(assignments)) {
            sendError(res, 400, 'Missing or invalid field: assignments must be a non-empty object.');
            return;
        }

        if (Object.keys(assignments).length === 0) {
            sendError(res, 400, 'Field assignments must not be empty.');
            return;
        }

        // Ensure all values are strings.
        for (const [key, value] of Object.entries(assignments)) {
            if (typeof value !== 'string') {
                sendError(res, 400, `Assignment value for repository "${key}" must be a string branch name.`);
                return;
            }
        }

        const branchAssignments = assignments as Record<string, string>;

        try {
            const result = await orchestrator.switchBranches(projectId, workspaceId, branchAssignments);
            sendJson(res, 200, result);
        } catch (err) {
            sendError(res, 500, err instanceof Error ? err.message : 'Branch switch failed.');
        }
    });
}
