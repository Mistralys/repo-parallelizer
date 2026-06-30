/**
 * Utility functions for resolving and injecting credentials into git remote URLs.
 *
 * Only HTTPS URLs are supported. SSH URLs (`git@...`) are left unchanged because
 * SSH authentication is handled by the SSH agent or key — not by inline tokens.
 *
 * ## Credential resolution pipeline
 *
 * The intended call sequence for authenticated git operations is:
 *
 * 1. **{@link resolveCredential}** — given a repository URL and the configured
 *    credential array, returns the matching {@link GitCredentialEntry} (or `null`
 *    when resolution fails or is ambiguous).
 * 2. **`entry.token`** — extract the token string from the resolved entry.
 * 3. **{@link injectCredentialToken}** — embed the token into the URL as the
 *    WHATWG URL username, producing an authenticated HTTPS URL ready for git.
 *
 * ```ts
 * const entry = resolveCredential(repoUrl, config.gitCredentials, repo.CredentialId);
 * const authenticatedUrl = entry ? injectCredentialToken(repoUrl, entry.token) : repoUrl;
 * ```
 *
 */

import type { GitCredentialEntry } from '../config/config.types.js';

/**
 * Extracts the hostname from an HTTPS git URL.
 *
 * @param url - The remote URL to inspect (e.g. "https://github.com/org/repo.git").
 * @returns The hostname string (e.g. "github.com"), or `null` when the URL is
 *   not a valid HTTPS URL (SSH, malformed, or empty).
 */
export function extractHost(url: string): string | null {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return null;
        return parsed.hostname || null;
    } catch {
        return null;
    }
}

/**
 * Resolves the credential to use for a given repository URL.
 *
 * Resolution strategy:
 *
 * 1. **Explicit ID (`credentialId` provided):** Returns the entry whose `id`
 *    matches `credentialId`, or `null` if no such entry exists (stale reference).
 * 2. **Auto-selection (`credentialId` omitted):** Filters `credentials` by host
 *    match against the URL's hostname.
 *    - Exactly one match → returns that entry.
 *    - Zero matches → returns `null` (no credentials configured for this host).
 *    - Multiple matches → returns `null` (ambiguous; user must assign a
 *      `CredentialId` to the repository explicitly).
 *
 * @param url          - The repository's remote URL.
 * @param credentials  - The full array of configured credential entries.
 * @param credentialId - Optional explicit credential ID to look up.
 * @returns The matching `GitCredentialEntry`, or `null` when resolution fails.
 *
 * @remarks
 * **SECURITY — host/credential coherence (explicit `credentialId` path):**
 * When `credentialId` is supplied, resolution performs only an exact `id` match;
 * no cross-validation against the URL's hostname is performed. A caller could
 * inadvertently (or maliciously) pass a `credentialId` belonging to a different
 * host and receive a credential for that host. The caller is responsible for
 * ensuring the URL's host is consistent with the credential's configured `host`
 * before using the resolved token. This validation should occur at the call site
 * (e.g. in the orchestrators) before passing the authenticated URL to git.
 */
export function resolveCredential(
    url: string,
    credentials: GitCredentialEntry[],
    credentialId?: string,
): GitCredentialEntry | null {
    if (credentialId !== undefined) {
        return credentials.find((c) => c.id === credentialId) ?? null;
    }

    const host = extractHost(url);
    if (host === null) return null;

    const matches = credentials.filter((c) => c.host === host);
    return matches.length === 1 ? matches[0] : null;
}

/**
 * Injects a single token into an HTTPS URL as the userinfo component.
 *
 * Accepts a pre-resolved token string directly (obtained from a
 * {@link GitCredentialEntry} via {@link resolveCredential}) and embeds it as
 * the WHATWG URL username. No string concatenation is used — special characters
 * in the token are automatically percent-encoded by the URL serialiser.
 *
 * The token is written as the WHATWG URL username only (no password component)
 * since Personal Access Tokens are typically passed in the username field.
 *
 * @param url   - The remote URL to modify.
 * @param token - The credential token to inject.
 * @returns The URL with the token injected, or the original URL unchanged for
 *   non-HTTPS or malformed URLs.
 */
export function injectCredentialToken(url: string, token: string): string {
    const host = extractHost(url);
    if (host === null) return url;

    try {
        const parsed = new URL(url);
        parsed.username = token;
        parsed.password = '';
        return parsed.toString();
    } catch {
        return url;
    }
}

/**
 * Returns `true` when the URL contains an embedded username (and optional password)
 * in the userinfo section (e.g. `https://token@github.com/...`).
 *
 * Always returns `false` for non-HTTPS or malformed URLs.
 *
 * @param url - The URL to inspect.
 */
export function hasEmbeddedCredentials(url: string): boolean {
    if (!url) return false;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return false;
        return parsed.username !== '';
    } catch {
        return false;
    }
}

/**
 * Redacts embedded HTTPS credentials from a URL or arbitrary string (e.g. a
 * git error message such as `"fatal: repository 'https://token@host/...' not found"`).
 *
 * Pure HTTPS URLs are sanitised via the WHATWG URL object (clean user/password
 * removal). All other inputs — non-HTTPS URLs, prose strings, and unparseable
 * values — fall through to a regex scrub that replaces any `https?://…@` pattern
 * with `https://***@`, preserving the host and path while redacting the token.
 *
 * @param input - The URL or string to sanitise.
 * @returns The sanitised string, or the original if no embedded credentials are
 *   found.
 */
export function stripEmbeddedCredentials(input: string): string {
    if (!input) return input;
    try {
        const parsed = new URL(input);
        if (parsed.protocol === 'https:') {
            parsed.username = '';
            parsed.password = '';
            return parsed.toString();
        }
        // Non-HTTPS valid URL (e.g. git:// or a prose string the WHATWG parser
        // accepted with a non-standard scheme like "fatal:") — fall through to
        // the regex scrub below to redact any embedded https credentials.
    } catch {
        // Not parseable as a URL — fall through to regex scrub.
    }
    // Scrub any embedded https credential patterns present in prose strings
    // (e.g. git error: "fatal: repository 'https://token@host/...' not found").
    return input.replace(/(https?:\/\/)[^@\s]*@/g, '$1***@');
}
