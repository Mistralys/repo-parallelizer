/**
 * Info Commit Dialog Component.
 *
 * Confirms (and performs) the "Commit & Push" action for a repository's
 * managed `.workspace/info.json` clone: an editable, pre-filled commit
 * message with inline validation, and the list of pending files about to be
 * committed. The dialog itself calls `api.repositories.infoSync.commitPush()`
 * — not just the caller — because a 409 (upstream changed the info folder)
 * or 502 (push failed, possibly with the credential write-access hint) must
 * be shown inline in the dialog's own `role="alert"` region per the plan's
 * step 16(c) ("Errors from Commit & Push … surface inside their modal").
 *
 * Built on the shared `modal-shell.js` primitive, which supplies the
 * overlay/modal/ARIA DOM, focus trap, focus restoration, and
 * Escape/backdrop-cancel wiring — see `confirm-dialog.js` and
 * `repository-modal.js` for the other consumers of the same shell.
 *
 * Usage:
 *   import { showInfoCommitDialog } from './components/info-commit-dialog.js';
 *
 *   const outcome = await showInfoCommitDialog({
 *     repoId: 'my-repo',
 *     pendingFiles: status.pendingChanges,
 *     defaultMessage: status.defaultCommitMessage,
 *   });
 *   if (outcome !== null) {
 *     // Commit & Push already happened — outcome.message, outcome.result;
 *     // re-fetch the section's status.
 *   }
 */

import { createModalShell } from './modal-shell.js';
import { api } from '../api.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Maximum trimmed commit message length. Mirrors the server-side
 * `MAX_INFO_COMMIT_MESSAGE_LENGTH` constant in
 * `src/config/config.constants.ts` — duplicated here because the GUI has no
 * build step and does not import across the GUI/server boundary (see
 * `settings.js`'s `MAX_POLLING_INTERVAL_SECONDS` comment for the same
 * convention).
 *
 * @type {number}
 */
const MAX_COMMIT_MESSAGE_LENGTH = 500;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * @param {string} trimmedMessage
 * @returns {boolean} Whether the trimmed message's length is in [1, MAX_COMMIT_MESSAGE_LENGTH].
 */
function isValidMessage(trimmedMessage) {
    return trimmedMessage.length >= 1 && trimmedMessage.length <= MAX_COMMIT_MESSAGE_LENGTH;
}

// ---------------------------------------------------------------------------
// showInfoCommitDialog
// ---------------------------------------------------------------------------

/**
 * Show the Commit & Push confirmation dialog, which performs the commit
 * itself once the message validates and Commit is clicked.
 *
 * @param {Object} config
 * @param {string} config.repoId - Repository ID; forwarded to `commitPush()`.
 * @param {string[]} [config.pendingFiles] - Paths with uncommitted changes in
 *   the managed main folder, shown as a scrollable list.
 * @param {string} [config.defaultMessage] - Server-suggested commit message
 *   used to pre-fill the textarea.
 * @returns {Promise<{ message: string, result: Object }|null>} Resolves with
 *   the trimmed, committed message plus the `CommitPushResult` returned by
 *   `api.repositories.infoSync.commitPush()` (`{ committed, pushed,
 *   commitSha?, filterFallback? }`) after a successful Commit & Push;
 *   resolves with `null` on Cancel/Escape/backdrop-click. Never rejects.
 */
export function showInfoCommitDialog({ repoId, pendingFiles, defaultMessage }) {
    return new Promise((resolve) => {
        const files = Array.isArray(pendingFiles) ? pendingFiles : [];

        // ------------------------------------------------------------------
        // Body
        // ------------------------------------------------------------------
        const bodyEl = document.createElement('div');
        bodyEl.className = 'modal-body';

        const messageGroup = document.createElement('div');
        messageGroup.className = 'form-group';

        const messageLabel = document.createElement('label');
        messageLabel.htmlFor = 'info-commit-message';
        messageLabel.textContent = 'Commit message';
        messageGroup.appendChild(messageLabel);

        const messageInput = document.createElement('textarea');
        messageInput.id = 'info-commit-message';
        messageInput.className = 'form-textarea';
        messageInput.rows = 3;
        messageInput.value = defaultMessage || '';
        messageInput.setAttribute('aria-describedby', 'info-commit-message-counter info-commit-message-error');
        messageGroup.appendChild(messageInput);

        const counterEl = document.createElement('span');
        counterEl.className = 'hint';
        counterEl.id = 'info-commit-message-counter';
        messageGroup.appendChild(counterEl);

        const messageErrorEl = document.createElement('span');
        messageErrorEl.className = 'form-error field-error';
        messageErrorEl.id = 'info-commit-message-error';
        messageErrorEl.setAttribute('role', 'alert');
        messageErrorEl.hidden = true;
        messageGroup.appendChild(messageErrorEl);

        bodyEl.appendChild(messageGroup);

        const filesLabel = document.createElement('p');
        filesLabel.className = 'hint';
        filesLabel.textContent = files.length > 0 ? 'Pending files:' : 'No pending files.';
        bodyEl.appendChild(filesLabel);

        if (files.length > 0) {
            const filesList = document.createElement('ul');
            filesList.className = 'info-commit-pending-files';
            files.forEach((path) => {
                const item = document.createElement('li');
                item.textContent = path;
                filesList.appendChild(item);
            });
            bodyEl.appendChild(filesList);
        }

        const errorEl = document.createElement('p');
        errorEl.className = 'error-message';
        errorEl.setAttribute('role', 'alert');
        errorEl.hidden = true;
        bodyEl.appendChild(errorEl);

        // ------------------------------------------------------------------
        // Actions
        // ------------------------------------------------------------------
        const actionsEl = document.createElement('div');
        actionsEl.className = 'modal-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.textContent = 'Cancel';

        const commitBtn = document.createElement('button');
        commitBtn.type = 'button';
        commitBtn.className = 'btn btn-primary';
        commitBtn.textContent = 'Commit & Push';

        actionsEl.appendChild(cancelBtn);
        actionsEl.appendChild(commitBtn);

        // ------------------------------------------------------------------
        // Live validation
        // ------------------------------------------------------------------
        function refreshValidation() {
            const trimmed = messageInput.value.trim();
            const remaining = MAX_COMMIT_MESSAGE_LENGTH - trimmed.length;
            counterEl.textContent = `${trimmed.length} / ${MAX_COMMIT_MESSAGE_LENGTH} characters`;

            const valid = isValidMessage(trimmed);
            if (valid) {
                messageInput.removeAttribute('aria-invalid');
                messageErrorEl.hidden = true;
                messageErrorEl.textContent = '';
            } else {
                messageInput.setAttribute('aria-invalid', 'true');
                messageErrorEl.hidden = false;
                messageErrorEl.textContent = trimmed.length === 0
                    ? 'A commit message is required.'
                    : `Commit message is too long by ${Math.abs(remaining)} characters.`;
            }

            commitBtn.disabled = !valid;
            return { trimmed, valid };
        }

        messageInput.addEventListener('input', refreshValidation);

        // ------------------------------------------------------------------
        // Shell — Escape/backdrop-cancel, focus trap, focus restoration
        // ------------------------------------------------------------------
        function onCancel() {
            shell.close();
            resolve(null);
        }

        const shell = createModalShell({
            titleText: 'Commit & Push',
            ariaLabelledbyId: 'info-commit-dialog-title',
            className: 'modal--form',
            onCancel,
        });

        shell.modal.appendChild(bodyEl);
        shell.modal.appendChild(actionsEl);

        cancelBtn.addEventListener('click', onCancel);

        function setBusy(busy) {
            shell.setBusy(busy);
            commitBtn.disabled = busy || !isValidMessage(messageInput.value.trim());
            cancelBtn.disabled = busy;
            messageInput.disabled = busy;
        }

        commitBtn.addEventListener('click', async () => {
            const { trimmed, valid } = refreshValidation();
            if (!valid) return;

            errorEl.hidden = true;
            errorEl.textContent = '';

            setBusy(true);
            try {
                const result = await api.repositories.infoSync.commitPush(repoId, trimmed);
                shell.close();
                resolve({ message: trimmed, result });
            } catch (err) {
                errorEl.textContent = err.message || 'Failed to commit and push.';
                errorEl.hidden = false;
                setBusy(false);
            }
        });

        // ------------------------------------------------------------------
        // Mount & focus — the message field.
        // ------------------------------------------------------------------
        refreshValidation();
        shell.mount(messageInput);
    });
}
