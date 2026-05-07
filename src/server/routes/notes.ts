import type { Router } from '../router.js';
import type { ProjectManager } from '../../models/project/project.manager.js';
import type { WorkspaceManager } from '../../models/workspace/workspace.manager.js';
import { sendJson, sendError } from '../requestUtils.js';

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers the notes aggregate endpoint on the provided `Router` instance.
 *
 * | Method | Path        | Success | Failure |
 * |--------|-------------|---------|---------|
 * | GET    | /api/notes  | 200     | 500     |
 *
 * Response shape:
 * ```json
 * {
 *   "Projects": [
 *     {
 *       "ProjectId": "my-project",
 *       "ProjectName": "My Project",
 *       "Workspaces": [
 *         { "WorkspaceId": "STABLE", "Notes": "" },
 *         { "WorkspaceId": "DEV",    "Notes": "some notes" }
 *       ]
 *     }
 *   ]
 * }
 * ```
 *
 * All projects and all their workspaces are always included.  Workspaces
 * without stored notes have `Notes: ""`.
 */
export function registerNotesRoutes(
    router: Router,
    projectManager: ProjectManager,
    workspaceManager: WorkspaceManager,
): void {
    router.get('/api/notes', (_req, res) => {
        try {
            const projects = projectManager.list();
            const result = projects.map((p) => {
                const workspaces = workspaceManager.list(p.Id);
                return {
                    ProjectId: p.Id,
                    ProjectName: p.Name,
                    Workspaces: workspaces.map((ws) => ({
                        WorkspaceId: ws.WorkspaceID,
                        Notes: ws.Notes,
                    })),
                };
            });
            sendJson(res, 200, { Projects: result });
        } catch {
            sendError(res, 500, 'Internal server error.');
        }
    });
}
