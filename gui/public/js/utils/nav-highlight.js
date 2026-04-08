/**
 * Active nav-link highlighting utility.
 *
 * Listens for hash changes and toggles the `.active` class on `.nav-link`
 * elements whose `href` matches the current location hash.
 *
 * @module utils/nav-highlight
 */

/**
 * Update the `active` class on all `.nav-link` elements to reflect the
 * current `location.hash`.
 */
function updateActiveNavLink() {
    const hash = location.hash || '#/';
    document.querySelectorAll('.nav-link').forEach((link) => {
        const linkHash = link.getAttribute('href');
        const isActive = hash === linkHash || (linkHash !== '#/' && hash.startsWith(linkHash));
        link.classList.toggle('active', isActive);
    });
}

/**
 * Initialise nav-link highlighting.
 *
 * Performs an immediate highlight pass and registers a `hashchange` listener
 * so the active state stays in sync with navigation.
 */
export function initNavHighlight() {
    window.addEventListener('hashchange', updateActiveNavLink);
    updateActiveNavLink();
}
