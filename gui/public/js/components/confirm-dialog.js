/**
 * Confirmation Dialog Component.
 *
 * Renders a modal overlay asking the user to confirm or cancel an action.
 * The overlay uses CSS classes defined in styles.css (`.modal-overlay`,
 * `.modal`, `.modal-title`, `.modal-body`, `.modal-actions`).
 *
 * Usage:
 *   import { showConfirm } from './components/confirm-dialog.js';
 *
 *   try {
 *     await showConfirm('Delete project', 'This action cannot be undone.');
 *     // User clicked Confirm → proceed
 *   } catch {
 *     // User clicked Cancel or pressed Escape → abort
 *   }
 */

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Show a confirmation modal dialog.
 *
 * The dialog is appended to `document.body` and removed from the DOM when
 * the user dismisses it (via Confirm, Cancel, or Escape key).
 *
 * @param {string} title   - Short title shown at the top of the dialog.
 * @param {string} message - Explanatory message shown in the dialog body.
 * @returns {Promise<void>} Resolves when the user clicks Confirm; rejects
 *   when the user clicks Cancel or presses Escape.
 */
export function showConfirm(title, message) {
    return new Promise((resolve, reject) => {
        // ------------------------------------------------------------------
        // Build DOM
        // ------------------------------------------------------------------
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'confirm-dialog-title');
        overlay.setAttribute('aria-describedby', 'confirm-dialog-body');

        const modal = document.createElement('div');
        modal.className = 'modal';

        const titleEl = document.createElement('h2');
        titleEl.className = 'modal-title';
        titleEl.id = 'confirm-dialog-title';
        titleEl.textContent = title;

        const bodyEl = document.createElement('p');
        bodyEl.className = 'modal-body';
        bodyEl.id = 'confirm-dialog-body';
        bodyEl.textContent = message;

        const actionsEl = document.createElement('div');
        actionsEl.className = 'modal-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.textContent = 'Cancel';

        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'btn btn-primary';
        confirmBtn.textContent = 'Confirm';

        actionsEl.appendChild(cancelBtn);
        actionsEl.appendChild(confirmBtn);

        modal.appendChild(titleEl);
        modal.appendChild(bodyEl);
        modal.appendChild(actionsEl);
        overlay.appendChild(modal);

        // ------------------------------------------------------------------
        // Helpers
        // ------------------------------------------------------------------

        /** Remove the overlay from the DOM and detach keyboard listener. */
        function cleanup() {
            document.removeEventListener('keydown', onKeydown);
            if (overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
        }

        function onConfirm() {
            cleanup();
            resolve();
        }

        function onCancel() {
            cleanup();
            reject(new Error('User cancelled'));
        }

        /** Close on Escape key. */
        function onKeydown(event) {
            if (event.key === 'Escape') {
                onCancel();
            }
        }

        // ------------------------------------------------------------------
        // Event listeners
        // ------------------------------------------------------------------
        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);

        // Click on the backdrop (overlay itself, not the modal) cancels.
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                onCancel();
            }
        });

        document.addEventListener('keydown', onKeydown);

        // ------------------------------------------------------------------
        // Mount & focus
        // ------------------------------------------------------------------
        document.body.appendChild(overlay);

        // Move focus into the dialog for accessibility.
        confirmBtn.focus();
    });
}
