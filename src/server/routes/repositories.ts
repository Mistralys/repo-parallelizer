import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Router } from '../router.js';
import type { RepositoryManager } from '../../models/repository/repository.manager.js';
import { NotFoundError } from '../../errors.js';
import { parseJsonBody, sendJson, sendError, isPlainObject } from '../requestUtils.js';
import type { Repository } from '../../models/repository/repository.types.js';
import type { AppConfig, GitCredentialEntry } from '../../config/config.types.js';
import type { ErrorLogManager } from '../../error-log/error-log.manager.js';
import { extractHost } from '../../git/git-credentials.js';

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers all routes for the `/api/repositories` resource group on the
 * provided `Router` instance. This includes five standard CRUD routes and two
 * credential-management routes that require access to the application
 * configuration.
 *
 * All handlers delegate to the supplied `RepositoryManager` and map results
 * or errors to the appropriate HTTP status codes:
 *
 * | Method | Path                                        | Success | Failure |
 * |--------|---------------------------------------------|---------|---------|
 * | GET    | /api/repositories                           | 200     | —       |
 * | GET    | /api/repositories/:id                       | 200     | 404     |
 * | POST   | /api/repositories                           | 201     | 400     |
 * | PUT    | /api/repositories/:id                       | 200     | 404     |
 * | DELETE | /api/repositories/:id                       | 204     | 404     |
 * | POST   | /api/repositories/:id/refresh-timestamp     | 200     | 404     |
 * | PUT    | /api/repositories/:id/credential            | 200     | 400/404 |
 * | GET    | /api/repositories/:id/credential-options    | 200     | 404     |
 */
export function registerRepositoryRoutes(
    router: Router,
    repoManager: RepositoryManager,
    appConfig: AppConfig,
    errorLogManager?: ErrorLogManager,
): void {
    /**
     * Look up a repository by ID.
     *
     * Sends a `404` response and returns `undefined` when the repository
     * cannot be found.
     *
     * @param res          - The outgoing HTTP response (used to send the 404 error).
     * @param repositoryId - The ID of the repository to look up.
     * @returns The matching `Repository` on success, or `undefined` when a 404
     *          has already been written to `res`.
     */
    function resolveRepository(
        res: ServerResponse,
        repositoryId: string,
    ): Repository | undefined {
        const repo = repoManager.getById(repositoryId);
        if (repo === undefined) {
            sendError(res, 404, `Repository with ID "${repositoryId}" not found.`);
            return undefined;
        }
        return repo;
    }

    // ------------------------------------------------------------------
    // GET /api/repositories — list all
    // ------------------------------------------------------------------
    router.get('/api/repositories', (
        _req: IncomingMessage,
        res: ServerResponse,
        _params: Record<string, string>,
    ): void => {
        const repos = repoManager.list();
        sendJson(res, 200, repos);
    });

    // ------------------------------------------------------------------
    // GET /api/repositories/:id — get one
    // ------------------------------------------------------------------
    router.get('/api/repositories/:id', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        const repo = resolveRepository(res, params['id']);
        if (repo === undefined) return;
        sendJson(res, 200, repo);
    });

    // ------------------------------------------------------------------
    // POST /api/repositories — create
    // ------------------------------------------------------------------
    router.post('/api/repositories', async (
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

        const { url, name, id } = body as {
            url?: unknown;
            name?: unknown;
            id?: unknown;
        };

        if (typeof url !== 'string' || url.trim() === '') {
            sendError(res, 400, 'Missing required field: url (non-empty string).');
            return;
        }

        const params: { url: string; name?: string; id?: string } = { url: url.trim() };
        if (typeof name === 'string') params.name = name;
        if (typeof id === 'string') params.id = id;

        try {
            const repo = repoManager.add(params);
            sendJson(res, 201, repo);
        } catch (err) {
            sendError(res, 400, err instanceof Error ? err.message : 'Could not create repository.');
        }
    });

    // ------------------------------------------------------------------
    // PUT /api/repositories/:id — update
    // ------------------------------------------------------------------
    router.put('/api/repositories/:id', async (
        req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const id = params['id'];

        if (!repoManager.exists(id)) {
            sendError(res, 404, `Repository with ID "${id}" not found.`);
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

        const { name } = body as { name?: unknown };

        if (typeof name !== 'string' || name.trim() === '') {
            sendError(res, 400, 'Missing required field: name (non-empty string).');
            return;
        }

        try {
            const updated = repoManager.update(id, { name: name.trim() });
            sendJson(res, 200, updated);
        } catch (err) {
            // update() throws NotFoundError if the ID was removed
            // between the exists() check and the update() call (race condition).
            if (err instanceof NotFoundError) {
                sendError(res, 404, err.message);
            } else {
                sendError(res, 500, 'Internal server error.');
            }
        }
    });

    // ------------------------------------------------------------------
    // DELETE /api/repositories/:id — delete
    // ------------------------------------------------------------------
    router.delete('/api/repositories/:id', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        const id = params['id'];

        try {
            repoManager.remove(id);
        } catch (err) {
            if (err instanceof NotFoundError) {
                sendError(res, 404, `Repository with ID "${id}" not found.`);
            } else {
                sendError(res, 500, 'Internal server error.');
            }
            return;
        }

        // 204 No Content — no body
        res.writeHead(204, {});
        res.end('');
    });

    // ------------------------------------------------------------------
    // POST /api/repositories/:id/refresh-timestamp — record manual refresh
    //   Writes the current timestamp to LastRefreshedAt for the repository.
    //   Called by the GUI whenever the user triggers a manual refresh on
    //   the repository detail screen.
    // ------------------------------------------------------------------
    router.post('/api/repositories/:id/refresh-timestamp', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        const id = params['id'];
        try {
            const updated = repoManager.touchRefreshTimestamp(id);
            sendJson(res, 200, updated);
        } catch (err) {
            if (err instanceof NotFoundError) {
                sendError(res, 404, err.message);
            } else {
                sendError(res, 500, 'Internal server error.');
            }
        }
    });

    // ------------------------------------------------------------------
    // PUT /api/repositories/:id/credential — set or clear credential
    //
    //   Accepts `{ credentialId: string | null }`.
    //   - When `credentialId` is a non-empty string, validates that it
    //     references an existing entry in `appConfig.gitCredentials`, then
    //     calls `RepositoryManager.updateCredential()` to persist the
    //     association.
    //   - When `credentialId` is `null`, clears the association.
    //   Returns the updated `Repository` on success (200).
    // ------------------------------------------------------------------
    router.put('/api/repositories/:id/credential', async (
        req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): Promise<void> => {
        const id = params['id'];

        const repo = resolveRepository(res, id);
        if (repo === undefined) return;

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

        const { credentialId } = body as { credentialId?: unknown };

        if (credentialId !== null && typeof credentialId !== 'string') {
            sendError(res, 400, 'Missing required field: credentialId (string or null).');
            return;
        }

        if (typeof credentialId === 'string') {
            // Validate that the referenced credential exists in the config.
            const credentials: GitCredentialEntry[] = appConfig.gitCredentials ?? [];
            const credential = credentials.find((c) => c.id === credentialId);
            if (!credential) {
                sendError(
                    res,
                    400,
                    `Credential with ID "${credentialId}" does not exist in the application configuration.`,
                );
                return;
            }

            // Host-coherence guard: reject when the credential's host does not
            // match the repository URL's hostname. SSH URLs (null repoHost) are
            // exempt — SSH auth is not handled by credential tokens.
            const repoHost = extractHost(repo.Url);
            if (repoHost !== null && credential.host !== repoHost) {
                sendError(
                    res,
                    400,
                    `Credential "${credentialId}" is configured for host "${credential.host}" but repository URL resolves to "${repoHost}".`,
                );
                return;
            }
        }

        try {
            const updated = repoManager.updateCredential(id, credentialId as string | null);

            // Audit log — emit assign or clear event.
            const auditOperation = credentialId === null ? 'clear-credential' : 'assign-credential';
            errorLogManager?.append({
                Severity: 'audit',
                Source: 'credential-audit',
                Operation: auditOperation,
                Context: { RepositoryId: id },
                Message: credentialId === null
                    ? `Credential association cleared for repository "${id}".`
                    : `Credential "${credentialId}" assigned to repository "${id}".`,
            });

            sendJson(res, 200, updated);
        } catch (err) {
            if (err instanceof NotFoundError) {
                sendError(res, 404, err.message);
            } else {
                sendError(res, 500, 'Internal server error.');
            }
        }
    });

    // ------------------------------------------------------------------
    // GET /api/repositories/:id/credential-options — list matching credentials
    //
    //   Returns the subset of `appConfig.gitCredentials` whose `host` matches
    //   the hostname of the repository's remote URL.  Tokens are masked (replaced
    //   with `"***"`) before being sent to the client.
    //
    //   Response shape:
    //     {
    //       credentials: GitCredentialEntry[],  // token masked
    //       autoSelected?: string               // id of the sole matching credential
    //     }
    //
    //   `autoSelected` is included only when exactly one credential matches the
    //   repository's host.
    // ------------------------------------------------------------------
    router.get('/api/repositories/:id/credential-options', (
        _req: IncomingMessage,
        res: ServerResponse,
        params: Record<string, string>,
    ): void => {
        const id = params['id'];

        const repo = resolveRepository(res, id);
        if (repo === undefined) return;

        const credentials: GitCredentialEntry[] = appConfig.gitCredentials ?? [];
        const repoHost = extractHost(repo.Url);

        // Filter to credentials whose host matches the repository's URL host.
        // For non-HTTPS URLs (e.g. SSH), repoHost is null and no credentials match.
        const matching = repoHost !== null
            ? credentials.filter((c) => c.host === repoHost)
            : [];

        // Mask tokens before sending — never expose raw tokens over the API.
        const maskedCredentials: GitCredentialEntry[] = matching.map((c) => ({
            ...c,
            token: '***',
        }));

        const responseBody: { credentials: GitCredentialEntry[]; autoSelected?: string } = {
            credentials: maskedCredentials,
        };

        if (matching.length === 1) {
            responseBody.autoSelected = matching[0].id;
        }

        sendJson(res, 200, responseBody);
    });
}
