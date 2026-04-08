/**
 * Toast Notification Component.
 *
 * Appends transient notification banners to the `#toast-container` element
 * that already exists in index.html.  Each toast auto-dismisses after a
 * configurable timeout with a CSS slide-out transition.  Multiple toasts
 * stack vertically inside the container.
 *
 * CSS classes used: `toast`, `toast-success`, `toast-error`, `toast-info`,
 * `toast-warning`, `toast.removing` — all defined in styles.css.
 *
 * Usage:
 *   import { showToast } from './components/toast.js';
 *
 *   showToast('Repository saved.', 'success');
 *   showToast('Something went wrong.', 'error');
 *   showToast('Branch list refreshed.', 'info');
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** How long (ms) a toast stays visible before the slide-out animation runs. */
const TOAST_DISPLAY_MS = 4_000;

/** Duration (ms) of the CSS slide-out animation — must match styles.css. */
const TOAST_ANIMATION_MS = 200;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Lazily retrieve (or create) the toast container element.
 * Logs a warning if `#toast-container` is absent from the DOM.
 *
 * @returns {HTMLElement|null}
 */
function getContainer() {
    const el = document.getElementById('toast-container');
    if (!el) {
        console.warn('[toast] #toast-container not found in the DOM. Toasts will not be displayed.');
    }
    return el;
}

/**
 * Remove a toast element with a CSS slide-out transition, then detach it
 * from the DOM.
 *
 * @param {HTMLElement} toastEl
 */
function dismissToast(toastEl) {
    // Guard against double-dismiss (e.g., user click + auto-timer firing).
    if (toastEl.dataset.dismissing === 'true') return;
    toastEl.dataset.dismissing = 'true';

    toastEl.classList.add('removing');

    setTimeout(() => {
        if (toastEl.parentNode) {
            toastEl.parentNode.removeChild(toastEl);
        }
    }, TOAST_ANIMATION_MS);
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

/**
 * Display a toast notification.
 *
 * @param {string} message            - Text to display inside the toast.
 * @param {'success'|'error'|'info'|'warning'} type - Visual variant.
 * @param {number} [duration]         - Override the auto-dismiss delay in ms.
 * @returns {HTMLElement|null}        - The created toast element, or null if
 *   the container is unavailable.
 */
export function showToast(message, type, duration = TOAST_DISPLAY_MS) {
    const VALID_TYPES = new Set(['success', 'error', 'info', 'warning']);
    const safeType = VALID_TYPES.has(type) ? type : 'info';

    const container = getContainer();
    if (!container) return null;

    // ------------------------------------------------------------------
    // Build element
    // ------------------------------------------------------------------
    const toast = document.createElement('div');
    toast.className = `toast toast-${safeType}`;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    const text = document.createElement('span');
    text.className = 'toast-message';
    text.textContent = message;

    // Close button for manual dismissal.
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn-icon toast-close';
    closeBtn.setAttribute('aria-label', 'Dismiss notification');
    closeBtn.textContent = '×';

    toast.appendChild(text);
    toast.appendChild(closeBtn);

    // ------------------------------------------------------------------
    // Mount
    // ------------------------------------------------------------------
    container.appendChild(toast);

    // ------------------------------------------------------------------
    // Auto-dismiss
    // ------------------------------------------------------------------
    const timer = setTimeout(() => dismissToast(toast), duration);

    closeBtn.addEventListener('click', () => {
        clearTimeout(timer);
        dismissToast(toast);
    });

    return toast;
}
