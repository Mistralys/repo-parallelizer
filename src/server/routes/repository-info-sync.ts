import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Router } from '../router.js';
import type { RepositoryManager } from '../../models/repository/repository.manager.js';
import type { WorkspaceArtifactsOrchestrator } from '../../orchestration/workspace-artifacts.js';
import type { ErrorLogManager } from '../../error-log/error-log.manager.js';
import {
    RepositoryInfoSyncOrchestrator,
    PendingChangesError,
    SyncPreconditionError,
    RemoteOperationError,
} from '../../orchestration/repository-info-sync.js';
import { MainFolderPreconditionError, MainFolderGitError } from '../../orchestration/repository-main-folder.js';
import type { RepositoryInfoImportField } from '../../orchestration/repository-info.js';
import { NotFoundError } from '../../errors.js';
import { parseJsonBody, sendJson, sendError, isPlainObject } from '../requestUtils.js';
import { MAX_INFO_COMMIT_MESSAGE_LENGTH } from '../../config/config.constants.js';

const IMPORTABLE_FIELDS: readonly RepositoryInfoImportField[] = ['Name', 'Description'];

/**
 * Registers the `/api/repositories/:id/info-sync*` routes on the provided
 * `Router` instance. Every handler delegates to `infoSync`
 * (`RepositoryInfoSyncOrchestrator`) and maps its thrown errors onto HTTP
 * status codes:
 *
 * | Error type                                                              | Status |
 * |--------------------------------------------------------------------------|--------|
 * | `NotFoundError`                                                          | 404    |
 * | Body validation failure (checked before calling the orchestrator)        | 400    |
 * | `PendingChangesError` / `SyncPreconditionError` / `MainFolderPreconditionError` | 409 |
 * | `RemoteOperationError` / `MainFolderGitError`                            | 502    |
 * | anything else                                                            | 500    |
 *
 * | Method | Path                                                | Success |
 * |--------|-----------------------------------------------------|---------|
 * | GET    | /api/repositories/:id/info-sync                     | 200     |
 * | PUT    | /api/repositories/:id/info-sync                     | 200     |
 * | POST   | /api/repositories/:id/info-sync/refresh             | 200     |
 * | POST   | /api/repositories/:id/info-sync/recreate-main-folder| 200     |
 * | GET    | /api/repositories/:id/info-sync/import              | 200     |
 * | POST   | /api/repositories/:id/info-sync/import              | 200     |
 * | POST   | /api/repositories/:id/info-sync/commit-push         | 200     |
 *
 * A successful `POST /import` also triggers
 * `workspaceArtifacts.regenerateForRepository()` best-effort — a failure
 * there is logged as a warning and does not affect the handler's own
 * response (mirrors `logArtifactWarning()` in `routes/repositories.ts`).
 */
export function registerRepositoryInfoSyncRoutes(
    router: Router,
    /**
     * Not read directly by any handler below — every repository lookup goes
     * through `infoSync`, which already holds its own `RepositoryManager`
     * reference and is the sole source of the `NotFoundError` that maps to
     * 404. Kept as a parameter for signature symmetry with the other route
     * registrars (`registerRepositoryRoutes`, `registerProjectRoutes`, ...)
     * and in case a future endpoint on this module needs direct manager
     * access.
     */
    _repoManager: RepositoryManager,
    infoSync: RepositoryInfoSyncOrchestrator,
    workspaceArtifacts: WorkspaceArtifactsOrchestrator,
    errorLogManager?: ErrorLogManager,
): void {
    /**
     * Records a `Severity: 'warning'` entry when the artefact choke-point call
     * fails after a successful import. The handler's own response is
     * unaffected. Mirrors `logArtifactWarning()` in `routes/repositories.ts`.
     */
    function logArtifactWarning(repositoryId: string, err: unknown): void {
        const message = err instanceof Error ? err.message : String(err);
        errorLogManager?.append({
            Severity: 'warning',
            Source: 'workspace-index',
            Operation: 'info-sync-import',
            Context: { RepositoryId: repositoryId },
            Message: `Failed to update workspace artefacts after "info-sync-import": ${message}`,
        });
    }

    /**
     * Maps an error thrown by any `infoSync` call onto the appropriate HTTP
     * status code and writes the response. Shared by every handler below so
     * the mapping cannot drift between routes.
     */
    function sendMappedError(res: ServerResponse, err: unknown): void {
        if (err instanceof NotFoundError) {
            sendError(res, 404, err.message);
            return;
        }

        if (
            err instanceof PendingChangesError ||
            err instanceof SyncPreconditionError ||
            err instanceof MainFolderPreconditionError
        ) {
            sendError(res, 409, err.message);
            return;
        }

        if (err instanceof RemoteOperationError || err instanceof MainFolderGitError) {
            sendError(res, 502, err.message);
            return;
        }

        sendError(res, 500, err instanceof Error ? err.message : 'Internal server error.');
    }

    /**
     * Reads and parses the JSON request body, sending a `400` and returning
     * `undefined` when the body is missing/malformed or is not a JSON object.
     */
    async function readObjectBody(
        req: IncomingMessage,
        res: ServerResponse,
    ): Promise<Record<string, unknown> | undefined> {
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

        return body;
    }

    /**
     * Validates the `PUT /info-sync` body: `enabled` is required and must be
     * a boolean; `discardPendingChanges`, when present, must be a boolean.
     */
    function validateSettingsInput(
        res: ServerResponse,
        body: Record<string, unknown>,
    ): { enabled: boolean; discardPendingChanges?: boolean } | undefined {
        const { enabled, discardPendingChanges } = body;

        if (typeof enabled !== 'boolean') {
            sendError(res, 400, 'Field enabled is required and must be a boolean.');
            return undefined;
        }

        if (discardPendingChanges !== undefined && typeof discardPendingChanges !== 'boolean') {
            sendError(res, 400, 'Field discardPendingChanges, when provided, must be a boolean.');
            return undefined;
        }

        return discardPendingChanges === undefined
            ? { enabled }
            : { enabled, discardPendingChanges };
    }

    /**
     * Validates the `POST /recreate-main-folder` body: `discardPendingChanges`,
     * when present, must be a boolean. The whole body is optional.
     */
    function validateDiscardInput(
        res: ServerResponse,
        body: Record<string, unknown>,
    ): { discardPendingChanges?: boolean } | undefined {
        const { discardPendingChanges } = body;

        if (discardPendingChanges !== undefined && typeof discardPendingChanges !== 'boolean') {
            sendError(res, 400, 'Field discardPendingChanges, when provided, must be a boolean.');
            return undefined;
        }

        return discardPendingChanges === undefined ? {} : { discardPendingChanges };
    }

    /**
     * Validates the `POST /import` body: `fields` is required and must be an
     * array containing only `'Name'` and/or `'Description'` (an empty array
     * is valid and means "keep all local values"; any other value, including
     * `'Url'`, is rejected).
     */
    function validateFieldsInput(
        res: ServerResponse,
        body: Record<string, unknown>,
    ): RepositoryInfoImportField[] | undefined {
        const { fields } = body;

        if (!Array.isArray(fields)) {
            sendError(res, 400, 'Field fields is required and must be an array.');
            return undefined;
        }

        for (const field of fields) {
            if (!IMPORTABLE_FIELDS.includes(field as RepositoryInfoImportField)) {
                sendError(
                    res,
                    400,
                    `Field fields contains an unsupported value "${String(field)}". ` +
                    `Only ${IMPORTABLE_FIELDS.map((f) => `"${f}"`).join(', ')} are importable.`,
                );
                return undefined;
            }
        }

        return fields as RepositoryInfoImportField[];
    }

    /**
     * Validates the `POST /commit-push` body: `message`, when present, must
     * be a string whose trimmed length is between 1 and
     * `MAX_INFO_COMMIT_MESSAGE_LENGTH`.
     */
    function validateMessageInput(
        res: ServerResponse,
        body: Record<string, unknown>,
    ): { message?: string } | undefined {
        const { message } = body;

        if (message === undefined) {
            return {};
        }

        if (typeof message !== 'string') {
            sendError(res, 400, 'Field message, when provided, must be a string.');
            return undefined;
        }

        const trimmed = message.trim();
        if (trimmed.length < 1 || trimmed.length > MAX_INFO_COMMIT_MESSAGE_LENGTH) {
            sendError(
                res,
                400,
                `Field message, when provided, must have a trimmed length between 1 and ` +
                `${MAX_INFO_COMMIT_MESSAGE_LENGTH} characters.`,
            );
            return undefined;
        }

        return { message: trimmed };
    }

    // ------------------------------------------------------------------
    // GET /api/repositories/:id/info-sync — status + health
    // ------------------------------------------------------------------
    router.get('/api/repositories/:id/info-sync', async (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        try {
            const status = await infoSync.getStatus(params['id']);
            sendJson(res, 200, status);
        } catch (err) {
            sendMappedError(res, err);
        }
    });

    // ------------------------------------------------------------------
    // PUT /api/repositories/:id/info-sync — save settings (enable/disable)
    // ------------------------------------------------------------------
    router.put('/api/repositories/:id/info-sync', async (
        req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const body = await readObjectBody(req, res);
        if (body === undefined) return;

        const input = validateSettingsInput(res, body);
        if (input === undefined) return;

        try {
            const status = await infoSync.saveSettings(params['id'], input);
            sendJson(res, 200, status);
        } catch (err) {
            sendMappedError(res, err);
        }
    });

    // ------------------------------------------------------------------
    // POST /api/repositories/:id/info-sync/refresh
    // ------------------------------------------------------------------
    router.post('/api/repositories/:id/info-sync/refresh', async (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        try {
            const status = await infoSync.refresh(params['id']);
            sendJson(res, 200, status);
        } catch (err) {
            sendMappedError(res, err);
        }
    });

    // ------------------------------------------------------------------
    // POST /api/repositories/:id/info-sync/recreate-main-folder
    // ------------------------------------------------------------------
    router.post('/api/repositories/:id/info-sync/recreate-main-folder', async (
        req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const body = await readObjectBody(req, res);
        if (body === undefined) return;

        const input = validateDiscardInput(res, body);
        if (input === undefined) return;

        try {
            const status = await infoSync.recreateManagedClone(params['id'], input);
            sendJson(res, 200, status);
        } catch (err) {
            sendMappedError(res, err);
        }
    });

    // ------------------------------------------------------------------
    // GET /api/repositories/:id/info-sync/import — preview
    // ------------------------------------------------------------------
    router.get('/api/repositories/:id/info-sync/import', async (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        try {
            const preview = await infoSync.getImportPreview(params['id']);
            sendJson(res, 200, preview);
        } catch (err) {
            sendMappedError(res, err);
        }
    });

    // ------------------------------------------------------------------
    // POST /api/repositories/:id/info-sync/import — apply
    // ------------------------------------------------------------------
    router.post('/api/repositories/:id/info-sync/import', async (
        req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const body = await readObjectBody(req, res);
        if (body === undefined) return;

        const fields = validateFieldsInput(res, body);
        if (fields === undefined) return;

        const repositoryId = params['id'];

        try {
            const status = await infoSync.applyImport(repositoryId, fields);

            // Best-effort: the import itself already succeeded; a failure
            // here is logged, not surfaced to the caller.
            try {
                workspaceArtifacts.regenerateForRepository(repositoryId);
            } catch (err) {
                logArtifactWarning(repositoryId, err);
            }

            sendJson(res, 200, status);
        } catch (err) {
            sendMappedError(res, err);
        }
    });

    // ------------------------------------------------------------------
    // POST /api/repositories/:id/info-sync/commit-push
    // ------------------------------------------------------------------
    router.post('/api/repositories/:id/info-sync/commit-push', async (
        req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const body = await readObjectBody(req, res);
        if (body === undefined) return;

        const input = validateMessageInput(res, body);
        if (input === undefined) return;

        try {
            const result = await infoSync.commitAndPush(params['id'], input);
            sendJson(res, 200, result);
        } catch (err) {
            sendMappedError(res, err);
        }
    });
}
