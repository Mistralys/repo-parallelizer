/**
 * Confirmation Dialog Component.
 *
 * Renders a modal overlay asking the user to confirm or cancel an action.
 * The overlay uses CSS classes defined in styles.css (`.modal-overlay`,
 * `.modal`, `.modal-title`, `.modal-body`, `.modal-actions`).
 *
 * Built on the shared `modal-shell.js` primitive, which supplies the
 * overlay/modal/ARIA DOM, focus trap, focus restoration, and
 * Escape/backdrop-cancel wiring — see `repository-modal.js` for the other
 * consumer of the same shell.
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

import { createModalShell } from './modal-shell.js';

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
        // Build body/actions content (the shell builds overlay/modal/title)
        // ------------------------------------------------------------------
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

        // ------------------------------------------------------------------
        // Shell — Escape/backdrop-cancel, focus trap, focus restoration
        // ------------------------------------------------------------------
        function onCancel() {
            shell.close();
            reject(new Error('User cancelled'));
        }

        const shell = createModalShell({
            titleText: title,
            ariaLabelledbyId: 'confirm-dialog-title',
            ariaDescribedbyId: 'confirm-dialog-body',
            onCancel,
        });

        shell.modal.appendChild(bodyEl);
        shell.modal.appendChild(actionsEl);

        function onConfirm() {
            shell.close();
            resolve();
        }

        // ------------------------------------------------------------------
        // Event listeners
        // ------------------------------------------------------------------
        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);

        // ------------------------------------------------------------------
        // Mount & focus
        // ------------------------------------------------------------------
        // Confirm button (not Cancel or the dialog itself) receives initial
        // focus, matching pre-refactor behavior.
        shell.mount(confirmBtn);
    });
}

