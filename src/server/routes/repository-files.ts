import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Router } from '../router.js';
import type { RepositoryManager } from '../../models/repository/repository.manager.js';
import type { RepositoryFileManager } from '../../models/repository/repository-file.manager.js';
import type { RepositoryInfoSyncOrchestrator } from '../../orchestration/repository-info-sync.js';
import { SyncPreconditionError } from '../../orchestration/repository-info-sync.js';
import type { WorkspaceArtifactsOrchestrator } from '../../orchestration/workspace-artifacts.js';
import type { ErrorLogManager } from '../../error-log/error-log.manager.js';
import { NotFoundError } from '../../errors.js';
import { parseJsonBody, sendJson, sendError, isPlainObject } from '../requestUtils.js';
import type { RepositoryFileInput } from '../../models/repository/repository-file.js';

/**
 * Registers the `/api/repositories/:id/files*` routes on the provided
 * `Router` instance — repository-level custom files (Milestone 2), the
 * repository-scoped counterpart of `registerProjectRoutes()`'s
 * `/api/projects/:id/custom-files*` routes.
 *
 * | Method | Path                                      | Success | Errors  |
 * |--------|-------------------------------------------|---------|---------|
 * | GET    | /api/repositories/:id/files                | 200     | 404     |
 * | POST   | /api/repositories/:id/files                | 201     | 400/404/409 |
 * | PUT    | /api/repositories/:id/files/:fileId        | 200     | 400/404/409 |
 * | DELETE | /api/repositories/:id/files/:fileId        | 204     | 404/409 |
 *
 * **Enabled-only mutations:** `GET` always works (list/show), but every
 * mutation first calls `infoSync.assertSyncEnabled(id)` and maps the
 * resulting `SyncPreconditionError` to `409` — nothing is written while info
 * sync is disabled for the repository, matching the "files go through git"
 * contract (Approach §8 of the Milestone 2 plan).
 *
 * **Locking:** every mutation runs inside `infoSync.runLocked(id, fn)`
 * (the same per-repository async mutex the sync orchestrator itself uses for
 * `saveSettings`/`refresh`/`applyImport`/`commitAndPush`), so a file CRUD
 * call can never race a concurrent import/commit-and-push on the same
 * repository.
 *
 * **Artefact regeneration:** a successful mutation also calls
 * `workspaceArtifacts.regenerateForRepository(id)`, which runs
 * `RepositoryInfoSyncOrchestrator.syncRepository()` (writing/deleting the
 * file under the managed clone's `.workspace/files/`) and regenerates every
 * workspace's `AGENTS.md`. This call is best-effort: a failure is logged to
 * `errorLogManager` at `Severity: 'warning'` and does not change the
 * handler's own (already-successful) response — mirroring
 * `logArtifactWarning()` in `routes/projects.ts` and `routes/repository-info-sync.ts`.
 * Unlike the project custom-files routes, there is no separate "remove
 * copies" call on move/rename/delete — `syncRepository()`'s write-only-if-changed
 * pass already deletes any regular file under `files/` that is not in the
 * data (see the Milestone 2 plan's deletion-cascade rationale).
 */
export function registerRepositoryFileRoutes(
    router: Router,
    /**
     * Not read directly by any handler below — every repository lookup goes
     * through `fileManager` (which throws `NotFoundError` for an unknown
     * repository) and `infoSync` (whose `assertSyncEnabled()` does the same).
     * Kept as a parameter for signature symmetry with the other route
     * registrars (`registerRepositoryRoutes`, `registerRepositoryInfoSyncRoutes`, ...).
     */
    _repoManager: RepositoryManager,
    fileManager: RepositoryFileManager,
    infoSync: RepositoryInfoSyncOrchestrator,
    workspaceArtifacts: WorkspaceArtifactsOrchestrator,
    errorLogManager?: ErrorLogManager,
): void {
    /**
     * Records a `Severity: 'warning'` entry when the artefact choke-point call
     * fails after a successful mutation. The handler's own response is
     * unaffected. Mirrors `logArtifactWarning()` in `routes/repository-info-sync.ts`.
     */
    function logArtifactWarning(repositoryId: string, operation: string, err: unknown): void {
        const message = err instanceof Error ? err.message : String(err);
        errorLogManager?.append({
            Severity: 'warning',
            Source: 'workspace-index',
            Operation: operation,
            Context: { RepositoryId: repositoryId },
            Message: `Failed to update workspace artefacts after "${operation}": ${message}`,
        });
    }

    /** Best-effort `regenerateForRepository()` call shared by every mutation handler below. */
    function regenerateBestEffort(repositoryId: string, operation: string): void {
        try {
            workspaceArtifacts.regenerateForRepository(repositoryId);
        } catch (err) {
            logArtifactWarning(repositoryId, operation, err);
        }
    }

    /**
     * Maps an error thrown by `fileManager`/`infoSync.assertSyncEnabled()` onto
     * the appropriate HTTP status code and writes the response.
     *
     * @param fallbackStatus Status for anything else — `400` for the two
     *   body-mutating handlers (a validation failure from
     *   `validateRepositoryFileInput()`, e.g. an invalid path or a
     *   duplicate), `500` for `DELETE` (which has no body to get wrong).
     */
    function sendMappedError(res: ServerResponse, err: unknown, fallbackStatus: number): void {
        if (err instanceof NotFoundError) {
            sendError(res, 404, err.message);
            return;
        }

        if (err instanceof SyncPreconditionError) {
            sendError(res, 409, err.message);
            return;
        }

        sendError(res, fallbackStatus, err instanceof Error ? err.message : 'Internal server error.');
    }

    /**
     * Parses and type-checks a repository file request body. Sends a 400 and
     * returns `undefined` when the shape is wrong; content rules (paths,
     * size, collisions, the 64-file count limit) are enforced later by
     * `RepositoryFileManager` via `validateRepositoryFileInput()`.
     */
    async function readFileBody(
        req: IncomingMessage,
        res: ServerResponse,
    ): Promise<RepositoryFileInput | undefined> {
        let body: unknown;
        try {
            body = await parseJsonBody(req);
        } catch (err) {
            sendError(res, 400, err instanceof Error ? err.message : 'Invalid request body.');
            return undefined;
        }

        if (!isPlainObject(body)) {
            sendError(res, 400, 'Request body must be a JSON object.');
            return undefined;
        }

        const b = body;
        for (const key of ['fileName', 'label', 'content'] as const) {
            if (typeof b[key] !== 'string') {
                sendError(res, 400, `Missing required field: ${key} (string).`);
                return undefined;
            }
        }
        for (const key of ['directory', 'description'] as const) {
            if (b[key] !== undefined && typeof b[key] !== 'string') {
                sendError(res, 400, `Field ${key} must be a string.`);
                return undefined;
            }
        }
        if (b['listInAgents'] !== undefined && typeof b['listInAgents'] !== 'boolean') {
            sendError(res, 400, 'Field listInAgents must be a boolean.');
            return undefined;
        }
        if (b['executable'] !== undefined && typeof b['executable'] !== 'boolean') {
            sendError(res, 400, 'Field executable must be a boolean.');
            return undefined;
        }

        return {
            Directory: (b['directory'] as string | undefined) ?? '',
            FileName: b['fileName'] as string,
            Label: b['label'] as string,
            Description: (b['description'] as string | undefined) ?? '',
            Content: b['content'] as string,
            Executable: b['executable'] as boolean | undefined,
            ListInAgents: b['listInAgents'] === true,
        };
    }

    // ------------------------------------------------------------------
    // GET /api/repositories/:id/files — list
    // ------------------------------------------------------------------
    router.get('/api/repositories/:id/files', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        try {
            sendJson(res, 200, fileManager.list(params['id']));
        } catch (err) {
            sendMappedError(res, err, 500);
        }
    });

    // ------------------------------------------------------------------
    // POST /api/repositories/:id/files — add
    // ------------------------------------------------------------------
    router.post('/api/repositories/:id/files', async (
        req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const repositoryId = params['id'];

        const input = await readFileBody(req, res);
        if (input === undefined) return;

        try {
            infoSync.assertSyncEnabled(repositoryId);
            const created = await infoSync.runLocked(repositoryId, async () => fileManager.add(repositoryId, input));
            regenerateBestEffort(repositoryId, 'add-repository-file');
            sendJson(res, 201, created);
        } catch (err) {
            sendMappedError(res, err, 400);
        }
    });

    // ------------------------------------------------------------------
    // PUT /api/repositories/:id/files/:fileId — update
    // ------------------------------------------------------------------
    router.put('/api/repositories/:id/files/:fileId', async (
        req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const repositoryId = params['id'];

        const input = await readFileBody(req, res);
        if (input === undefined) return;

        try {
            infoSync.assertSyncEnabled(repositoryId);
            const { updated } = await infoSync.runLocked(
                repositoryId,
                async () => fileManager.update(repositoryId, params['fileId'], input),
            );
            regenerateBestEffort(repositoryId, 'update-repository-file');
            sendJson(res, 200, updated);
        } catch (err) {
            sendMappedError(res, err, 400);
        }
    });

    // ------------------------------------------------------------------
    // DELETE /api/repositories/:id/files/:fileId — remove
    // ------------------------------------------------------------------
    router.delete('/api/repositories/:id/files/:fileId', async (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const repositoryId = params['id'];

        try {
            infoSync.assertSyncEnabled(repositoryId);
            await infoSync.runLocked(repositoryId, async () => fileManager.remove(repositoryId, params['fileId']));
            regenerateBestEffort(repositoryId, 'delete-repository-file');
            res.writeHead(204, {});
            res.end('');
        } catch (err) {
            sendMappedError(res, err, 500);
        }
    });
}
