import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Router } from '../router.js';
import type { ProjectManager } from '../../models/project/project.manager.js';
import type { WorkspaceArtifactsOrchestrator } from '../../orchestration/workspace-artifacts.js';
import type { RepositoryOrchestrator } from '../../orchestration/repository-orchestrator.js';
import type { ErrorLogManager } from '../../error-log/error-log.manager.js';
import { NotFoundError } from '../../errors.js';
import { parseJsonBody, sendJson, sendError, isPlainObject } from '../requestUtils.js';
import type { ProjectData } from '../../models/project/project.types.js';

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
 * | DELETE | /api/projects/:id/repositories/:repoId   | 204     | 404, 500 |
 *
 * The four lifecycle handlers that mutate a project's metadata or
 * workspace/repository set — `PUT /:id`, `DELETE /:id`, `PUT /:id/rename`,
 * and `POST /:id/repositories` —
 * additionally call
 * `workspaceArtifacts` (the per-workspace artefact choke-point) after their
 * `ProjectManager` call succeeds, so the generated `.code-workspace` and
 * index files never go stale. A failure inside one of those calls is logged
 * to `errorLogManager` at `Severity: 'warning'` and does not affect the
 * handler's own response — see `logArtifactWarning()` below.
 *
 * `DELETE /:id/repositories/:repoId` reaches the same artefact choke-point
 * indirectly through `repositoryOrchestrator.removeRepositoryFromProject()`
 * instead, which also deletes the repository's clone folders from every
 * workspace of the project (under a path-traversal guard) and emits an
 * `unlink-repository` audit entry — mirroring how
 * `DELETE /api/repositories/:id` delegates to
 * `repositoryOrchestrator.deleteRepositoryGlobally()` in `routes/repositories.ts`.
 */
export function registerProjectRoutes(
    router: Router,
    projectManager: ProjectManager,
    /**
     * Choke-point orchestrator for the per-workspace artefact set
     * (`.code-workspace` + generated index files). Consulted by the four
     * lifecycle handlers listed above.
     */
    workspaceArtifacts: WorkspaceArtifactsOrchestrator,
    /**
     * Orchestrator for repository lifecycle operations across projects.
     * `DELETE /:id/repositories/:repoId` calls
     * `removeRepositoryFromProject()` on it so unlinking a repository also
     * removes its clone folders from every workspace of the project and
     * emits the audit trail entry, rather than only updating the project's
     * data record.
     */
    repositoryOrchestrator: RepositoryOrchestrator,
    errorLogManager: ErrorLogManager,
): void {
    /**
     * Records a `Severity: 'warning'` entry when an artefact-choke-point call
     * fails after its triggering `ProjectManager` operation has already
     * succeeded. The triggering handler's own response is unaffected — the
     * artefact set going briefly stale is preferable to surfacing a 5xx for a
     * mutation that otherwise completed correctly.
     *
     * @param operation - Short identifier for the lifecycle action in progress
     *                    (e.g. `'delete-project'`, `'rename-project'`).
     * @param projectId - The project ID involved in the operation.
     * @param workspaceId - The workspace ID involved, when applicable.
     * @param err       - The error thrown by the artefact-choke-point call.
     */
    function logArtifactWarning(
        operation: string,
        projectId: string,
        workspaceId: string | undefined,
        err: unknown,
    ): void {
        const message = err instanceof Error ? err.message : String(err);
        errorLogManager.append({
            Severity: 'warning',
            Source: 'workspace-index',
            Operation: operation,
            Context: workspaceId !== undefined
                ? { ProjectId: projectId, WorkspaceId: workspaceId }
                : { ProjectId: projectId },
            Message: `Failed to update workspace artefacts after "${operation}": ${message}`,
        });
    }

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
        if (project === undefined) {
            sendError(res, 404, `Project with ID "${projectId}" not found.`);
            return undefined;
        }
        return project;
    }

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
        const project = resolveProject(res, params['id']);
        if (project === undefined) return;
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

            // Regenerate the artefact set for every workspace so an edited
            // description is reflected without a manual regenerate step.
            try {
                workspaceArtifacts.regenerateProject(id);
            } catch (err) {
                logArtifactWarning('update-project', id, undefined, err);
            }

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

            // Regenerate the artefact set for every workspace under the new
            // project ID, then remove the stale set left behind under the old
            // ID. `renamed.Workspaces` reflects the post-rename data, so the
            // regenerate side already has everything it needs — unlike
            // `WorkspaceOrchestrator.renameWorkspace()`'s on-disk folder move,
            // no `workspaceMeta` override is required here (see
            // `RegenerateWorkspaceOverrides`).
            for (const workspaceId of Object.keys(renamed.Workspaces)) {
                try {
                    workspaceArtifacts.regenerateWorkspace(renamed.Id, workspaceId);
                    workspaceArtifacts.removeWorkspace(oldId, workspaceId);
                } catch (err) {
                    logArtifactWarning('rename-project', renamed.Id, workspaceId, err);
                }
            }

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
        const projectId = params['id'];

        // Captured before removal — the workspace list is unavailable once the
        // project's data file is gone, and it's needed to remove every
        // workspace's artefact set below.
        const project = projectManager.getById(projectId);

        try {
            projectManager.remove(projectId);
        } catch {
            sendError(res, 404, `Project with ID "${projectId}" not found.`);
            return;
        }

        if (project !== undefined) {
            for (const workspaceId of Object.keys(project.Workspaces)) {
                try {
                    workspaceArtifacts.removeWorkspace(projectId, workspaceId);
                } catch (err) {
                    logArtifactWarning('delete-project', projectId, workspaceId, err);
                }
            }
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

            try {
                workspaceArtifacts.regenerateProject(projectId);
            } catch (err) {
                logArtifactWarning('link-repository', projectId, undefined, err);
            }

            sendJson(res, 200, updated);
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Could not link repository.';
            const is404 = err instanceof NotFoundError;
            sendError(res, is404 ? 404 : 400, msg);
        }
    });

    // ------------------------------------------------------------------
    // DELETE /api/projects/:id/repositories/:repoId — unlink a repo
    //
    //   Routes through `RepositoryOrchestrator.removeRepositoryFromProject()`
    //   rather than `projectManager.removeRepository()` directly, so the
    //   unlink also deletes the repository's clone folders from every
    //   workspace of the project (under a path-traversal guard) and emits an
    //   `unlink-repository` audit entry. Both the project-existence and
    //   repository-association checks are performed here rather than relying
    //   on `removeRepositoryFromProject()`'s own not-found throws, because
    //   those throws are plain `Error`s (not `NotFoundError`) and would
    //   otherwise be misclassified as a 500 below — mirrors the precondition
    //   precedent in `routes/repositories.ts`'s `DELETE /:id` handler.
    // ------------------------------------------------------------------
    router.delete('/api/projects/:id/repositories/:repoId', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        const projectId = params['id'];
        const repoId = params['repoId'];

        const project = resolveProject(res, projectId);
        if (project === undefined) return;

        if (!project.Repositories.includes(repoId)) {
            sendError(res, 404, `Repository "${repoId}" is not listed in project "${projectId}".`);
            return;
        }

        try {
            repositoryOrchestrator.removeRepositoryFromProject(projectId, repoId);
        } catch {
            sendError(res, 500, 'Internal server error.');
            return;
        }

        res.writeHead(204, {});
        res.end('');
    });
}
