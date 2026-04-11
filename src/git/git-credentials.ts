/**
 * Utility functions for resolving and injecting credentials into git remote URLs.
 *
 * Only HTTPS URLs are supported. SSH URLs (`git@...`) are left unchanged because
 * SSH authentication is handled by the SSH agent or key — not by inline tokens.
 */

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
 * Injects a token credential into an HTTPS URL as the userinfo component.
 *
 * If the credentials map contains an entry whose key matches the URL's hostname,
 * the token is inserted as `https://<token>@<host>/...`. If no matching entry
 * exists, or the URL is not HTTPS, the original URL is returned unchanged.
 *
 * The token is written as the username only (no password component) since
 * Personal Access Tokens are typically passed in the username field.
 *
 * **Security note:** Token injection is performed via WHATWG URL object property
 * assignment (`parsed.username = token`), NOT string concatenation. The URL
 * serialiser automatically percent-encodes special characters in the token (e.g.
 * `@`, `/`, `#`), preventing URL injection even with adversarially-crafted values.
 *
 * @param url         - The remote URL to modify.
 * @param credentials - Map of hostname → token (e.g. `{ "github.com": "ghp_abc" }`).
 * @returns The URL with credentials injected, or the original URL if no match.
 */
export function injectCredentials(url: string, credentials: Record<string, string>): string {
    const host = extractHost(url);
    if (host === null) return url;

    const token = credentials[host];
    if (!token) return url;

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
