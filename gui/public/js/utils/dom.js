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
