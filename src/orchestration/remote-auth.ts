import { resolveCredential, injectCredentialToken, extractHost } from '../git/git-credentials.js';
import type { GitCredentialEntry } from '../config/config.types.js';
import type { Repository } from '../models/repository/repository.types.js';

/**
 * Result of {@link resolveRemoteAuth}.
 *
 * - `ok: true`  — a git-ready `url` was produced (an authenticated HTTPS URL when
 *   a credential was resolved, the plain repository URL for SSH or an
 *   unauthenticated HTTPS host).
 * - `ok: false` — an HTTPS URL requires a credential and none resolved; `host`
 *   and `message` describe the failure for logging/display.
 *
 * **SECURITY — do not persist or propagate `url`:** The `url` field on the
 * success variant may contain an embedded credential token (see
 * {@link injectCredentialToken}). It must be consumed immediately by the git
 * call that needs it (e.g. `git clone`, `git remote set-url`) and must never be
 * stored on disk, logged, returned across an API/HTTP boundary, or otherwise
 * retained beyond the single git invocation it was resolved for.
 */
export type RemoteAuthResolution =
    | { ok: true; url: string; credential: GitCredentialEntry | null }
    | { ok: false; host: string; message: string };

/**
 * Resolves the git-ready remote URL (with credential injected, when required)
 * for a repository, following the same resolve/inject/explain sequence
 * previously duplicated in `WorkspaceOrchestrator.createWorkspace()` and
 * `RepositoryOrchestrator.addRepositoryToProject()`.
 *
 * Behavior (identical to the former inline block):
 * 1. Resolve a matching credential via {@link resolveCredential}.
 * 2. SSH URLs (and other non-HTTPS URLs) never require a credential —
 *    `extractHost()` returns `null` for them, so they resolve successfully
 *    with `credential: null` and the original URL unchanged.
 * 3. An HTTPS URL with no resolvable credential fails with a descriptive
 *    message identifying the required host, rather than letting an
 *    unauthenticated clone fail with an unhelpful git error.
 * 4. An HTTPS URL with a resolved credential has the token injected via
 *    {@link injectCredentialToken}.
 *
 * @param repo        The repository whose remote URL should be resolved.
 * @param credentials The full array of configured credential entries.
 * @returns A {@link RemoteAuthResolution} describing the git-ready URL, or the
 *   failure host/message when no credential resolves for an HTTPS host.
 */
export function resolveRemoteAuth(
    repo: Repository,
    credentials: GitCredentialEntry[],
): RemoteAuthResolution {
    const credential = resolveCredential(repo.Url, credentials, repo.CredentialId);
    const host = extractHost(repo.Url);

    // When no credential resolves for an HTTPS URL, report a descriptive
    // error rather than attempting an unauthenticated clone that would
    // likely fail with an unhelpful git error message.
    if (credential === null && host !== null) {
        return {
            ok: false,
            host,
            message:
                `Repository '${repo.Name}' requires a credential for host '${host}'. ` +
                `Please select a credential in the repository settings.`,
        };
    }

    const url = credential !== null
        ? injectCredentialToken(repo.Url, credential.token)
        : repo.Url;

    return { ok: true, url, credential };
}
