/**
 * Shared DOM utilities — Repo Parallelizer GUI.
 *
 * @module utils/dom
 */

/**
 * Remove all child nodes from a DOM element without using `innerHTML`.
 *
 * Preferred over `el.innerHTML = ''` because it avoids invoking the HTML
 * parser and is safe even when the element's children hold event listeners
 * that should be GC'd cleanly.
 *
 * @param {Element} el - The element to empty.
 */
export function clearElement(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
}

/**
 * Build a CSS-styled credential badge `<span>` for a repository.
 *
 * Replaces the previous emoji-based approach (`🔑` / `—`) with a CSS-styled
 * element that renders consistently across platforms and is accessible via
 * `aria-label`.
 *
 * The returned element always carries the base `.credential-badge` class plus
 * one of:
 *   - `.credential-badge--set`  — a credential is configured.
 *   - `.credential-badge--none` — no credential is configured.
 *
 * @param {string|null|undefined} credentialId - The credential ID, or null/undefined when absent.
 * @returns {HTMLSpanElement}
 *
 * @example
 * // Credential set
 * const badge = buildCredentialBadge('my-cred-id');
 * // badge.classList → ['credential-badge', 'credential-badge--set']
 *
 * @example
 * // No credential
 * const badge = buildCredentialBadge(null);
 * // badge.classList → ['credential-badge', 'credential-badge--none']
 */
export function buildCredentialBadge(credentialId) {
    const span = document.createElement('span');
    if (credentialId) {
        span.className   = 'credential-badge credential-badge--set';
        span.title       = `Credential: ${credentialId}`;
        span.textContent = '✓';
        span.setAttribute('aria-label', 'Credential configured');
    } else {
        span.className   = 'credential-badge credential-badge--none';
        span.title       = 'No credential configured';
        span.textContent = '—';
        span.setAttribute('aria-label', 'No credential configured');
    }
    return span;
}
