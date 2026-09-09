/**
 * Modal Shell Primitive.
 *
 * Extracts the overlay/modal/ARIA DOM construction, Escape/backdrop-cancel
 * wiring, focus trap, focus restoration, and busy-gating logic shared by
 * every modal dialog in the application (`confirm-dialog.js`,
 * `repository-modal.js`). Centralizing this here means both dialogs get
 * identical accessibility behavior by construction and cannot silently
 * drift apart.
 *
 * Usage:
 *   import { createModalShell } from './components/modal-shell.js';
 *
 *   const shell = createModalShell({
 *     titleText: 'Add Repository',
 *     ariaLabelledbyId: 'repository-modal-title',
 *     className: 'modal--form',
 *     onCancel: () => { shell.close(); reject(new Error('User cancelled')); },
 *   });
 *   shell.modal.appendChild(bodyEl);
 *   shell.mount(initialFocusEl);
 *   // … later, on submit:
 *   shell.close();
 */

// ---------------------------------------------------------------------------
// Focusable-element query
// ---------------------------------------------------------------------------

/**
 * Selector matching elements considered part of the focus trap's tab order.
 * Excludes disabled controls, which are not focusable.
 */
const FOCUSABLE_SELECTOR =
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Returns all focusable elements inside `container`, in DOM order, excluding
 * `:disabled` controls.
 *
 * @param {HTMLElement} container
 * @returns {HTMLElement[]}
 */
function queryFocusable(container) {
    return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
        (el) => !el.disabled,
    );
}

// ---------------------------------------------------------------------------
// createModalShell
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ModalShellOptions
 * @property {string}   titleText          - Text shown in the modal's title heading.
 * @property {string}   ariaLabelledbyId   - ID applied to the title heading and referenced by `aria-labelledby`.
 * @property {string}   [ariaDescribedbyId] - ID referenced by `aria-describedby`, when the caller has a description element.
 * @property {string}   [className]        - Additional class applied to the `.modal` element alongside the base `modal` class.
 * @property {() => void} onCancel         - Invoked when the user presses Escape or clicks the backdrop (while not busy).
 */

/**
 * @typedef {Object} ModalShell
 * @property {HTMLDivElement} overlay - The `.modal-overlay` element (not yet attached to the DOM).
 * @property {HTMLDivElement} modal   - The `.modal` element, already appended to `overlay`. Callers append their own body/actions content to this.
 * @property {(initialFocusEl?: HTMLElement) => void} mount - Attaches the overlay to `document.body` and wires all event listeners.
 * @property {() => void} close - Detaches the overlay, removes listeners, and restores focus.
 * @property {(busy: boolean) => void} setBusy - Toggles whether Escape/backdrop-cancel are currently no-ops.
 */

/**
 * Builds a modal overlay/dialog shell with focus trap, focus restoration,
 * Escape/backdrop-cancel wiring, and a busy gate — but does not itself
 * populate the modal body. Callers append their own content to `modal`.
 *
 * @param {ModalShellOptions} options
 * @returns {ModalShell}
 */
export function createModalShell({
    titleText,
    ariaLabelledbyId,
    ariaDescribedbyId,
    className,
    onCancel,
}) {
    // ------------------------------------------------------------------
    // Build DOM
    // ------------------------------------------------------------------
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', ariaLabelledbyId);
    if (ariaDescribedbyId) {
        overlay.setAttribute('aria-describedby', ariaDescribedbyId);
    }

    const modal = document.createElement('div');
    modal.className = className ? `modal ${className}` : 'modal';

    const titleEl = document.createElement('h2');
    titleEl.className = 'modal-title';
    titleEl.id = ariaLabelledbyId;
    titleEl.textContent = titleText;

    modal.appendChild(titleEl);
    overlay.appendChild(modal);

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------
    let previouslyFocusedEl = null;
    let busy = false;

    // ------------------------------------------------------------------
    // Focus trap / Escape / backdrop-cancel
    // ------------------------------------------------------------------

    function onKeydown(event) {
        if (event.key === 'Escape') {
            if (busy) return;
            onCancel();
            return;
        }

        if (event.key === 'Tab') {
            const focusable = queryFocusable(modal);
            if (focusable.length === 0) return;

            const first = focusable[0];
            const last = focusable[focusable.length - 1];

            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    }

    function onOverlayClick(event) {
        if (event.target === overlay && !busy) {
            onCancel();
        }
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    function mount(initialFocusEl) {
        previouslyFocusedEl = document.activeElement;

        document.body.appendChild(overlay);

        document.addEventListener('keydown', onKeydown);
        overlay.addEventListener('click', onOverlayClick);

        const focusTarget = initialFocusEl ?? queryFocusable(modal)[0];
        if (focusTarget) {
            focusTarget.focus();
        }
    }

    function close() {
        document.removeEventListener('keydown', onKeydown);
        overlay.removeEventListener('click', onOverlayClick);

        if (overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        }

        if (previouslyFocusedEl && document.contains(previouslyFocusedEl)) {
            previouslyFocusedEl.focus();
        }
    }

    function setBusy(nextBusy) {
        busy = nextBusy;
    }

    return { overlay, modal, mount, close, setBusy };
}
