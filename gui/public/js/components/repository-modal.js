/**
 * Repository Create/Edit Modal Component.
 *
 * Renders a modal form for either registering a new repository or editing an
 * existing one, sharing a single implementation between both modes since
 * they share every field — differing only in which fields are pre-filled and
 * which are disabled.
 *
 * Built on the shared `modal-shell.js` primitive, which supplies the
 * overlay/modal/ARIA DOM, focus trap, focus restoration, and
 * Escape/backdrop-cancel wiring — see `confirm-dialog.js` for the other
 * consumer of the same shell.
 *
 * Usage:
 *   import { showRepositoryModal } from './components/repository-modal.js';
 *
 *   // Create mode
 *   const repo = await showRepositoryModal({ mode: 'create' });
 *
 *   // Edit mode
 *   const repo = await showRepositoryModal({ mode: 'edit', repo: existingRepo });
 */

import { createModalShell } from './modal-shell.js';
import { createFormField, validateRequired } from './form-helpers.js';
import { api } from '../api.js';
import { showToast } from './toast.js';
import { normaliseRepo } from '../utils/normalise.js';
import { clearElement } from '../utils/dom.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Debounce delay (ms) applied to the URL field's credential re-fetch. */
const URL_CHANGE_DEBOUNCE_MS = 400;

// ---------------------------------------------------------------------------
// Credential select helpers
// ---------------------------------------------------------------------------

/**
 * Decide which credential option should be selected after a
 * `credentialOptionsForUrl()` fetch: the stored credential ID, when it is
 * still present among `options`; `''` (None) otherwise.
 *
 * Deliberately does *not* fall back to the single `auto: true` match — a
 * repository with no stored credential must keep showing "None" selected,
 * consistent with the "No credential configured" state shown in the
 * repositories list. The auto-detected match is still visually flagged in
 * its option label (see `rebuildCredentialSelect`) so the user can pick it
 * deliberately.
 *
 * @param {Array<{ credentialId: string }>} options
 * @param {string} storedCredentialId
 * @returns {string}
 */
function computeSelectedCredentialId(options, storedCredentialId) {
    if (storedCredentialId && options.some((o) => o.credentialId === storedCredentialId)) {
        return storedCredentialId;
    }
    return '';
}

/**
 * Clear and repopulate a credential `<select>` element with a "None" option
 * plus one option per entry in `options`, then apply the stored-ID/None
 * selection priority. The sole `auto: true` entry (when present) is labeled
 * as the recommended match, without being auto-selected.
 *
 * @param {HTMLSelectElement} selectEl
 * @param {Array<{ credentialId: string, label: string, auto: boolean }>} options
 * @param {string} storedCredentialId
 */
function rebuildCredentialSelect(selectEl, options, storedCredentialId) {
    clearElement(selectEl);

    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'None';
    selectEl.appendChild(noneOpt);

    options.forEach((opt) => {
        const optionEl = document.createElement('option');
        optionEl.value = opt.credentialId;
        optionEl.textContent = opt.auto ? `${opt.label} (recommended match)` : opt.label;
        selectEl.appendChild(optionEl);
    });

    selectEl.value = computeSelectedCredentialId(options, storedCredentialId);
}

/**
 * Whether `url` is an HTTPS URL, mirroring the server's `extractHost()` check
 * (only `https:` URLs carry a matchable host — SSH and plain HTTP URLs never do).
 *
 * @param {string} url
 * @returns {boolean}
 */
function isHttpsUrl(url) {
    try {
        return new URL(url).protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * Explains why the credential select has no matching option(s) for `url`,
 * so an empty ("None"-only) select reads as expected behaviour rather than
 * a bug. Returns `''` when `options` is non-empty (no explanation needed).
 *
 * @param {string} url
 * @param {Array} options
 * @returns {string}
 */
function describeEmptyCredentialOptions(url, options) {
    if (options.length > 0) return '';
    return isHttpsUrl(url)
        ? 'No saved credential is configured for this URL\'s host.'
        : 'Credentials can only be matched to HTTPS URLs — this URL\'s scheme (e.g. SSH or HTTP) is not supported.';
}

// ---------------------------------------------------------------------------
// showRepositoryModal
// ---------------------------------------------------------------------------

/**
 * Show the repository create/edit modal.
 *
 * @param {Object} config
 * @param {'create'|'edit'} config.mode - Which mode to render.
 * @param {{ id: string, name: string, url: string, credentialId?: string }} [config.repo]
 *   The repository being edited. Required (and only used) when `mode === 'edit'`.
 * @returns {Promise<Object>} Resolves with the normalised, saved repository;
 *   rejects with `Error('User cancelled')` on Cancel/Escape/backdrop-click.
 */
export function showRepositoryModal({ mode, repo }) {
    return new Promise((resolve, reject) => {
        const isEdit = mode === 'edit';
        const storedCredentialId = isEdit ? (repo.credentialId ?? '') : '';

        // ------------------------------------------------------------------
        // Fields
        // ------------------------------------------------------------------
        const urlField = createFormField('URL', 'url', 'url', {
            required: true,
            placeholder: 'https://github.com/org/repo.git',
            value: isEdit ? repo.url : '',
        });
        const urlInput = urlField.querySelector('input');

        const nameField = createFormField('Name', 'text', 'name', {
            placeholder: 'Optional — human-readable name.',
            value: isEdit ? repo.name : '',
        });

        const idField = createFormField('ID', 'text', 'id', {
            placeholder: 'Optional — auto-inferred from URL when left blank.',
            hint: isEdit
                ? 'Repository ID cannot be changed after creation.'
                : 'Leave blank to auto-infer from the repository URL.',
            value: isEdit ? repo.id : '',
        });
        if (isEdit) {
            idField.querySelector('input').disabled = true;
        }

        const credentialField = createFormField('Credential', 'select', 'credentialId', {
            choices: [{ value: '', label: 'None' }],
        });
        const credentialSelect = credentialField.querySelector('select');

        const credentialHint = document.createElement('span');
        credentialHint.className = 'hint';
        credentialHint.id = `${credentialSelect.id}-hint`;
        credentialHint.hidden = true;
        credentialField.appendChild(credentialHint);
        credentialSelect.setAttribute('aria-describedby', credentialHint.id);

        const form = document.createElement('form');
        form.noValidate = true;
        form.appendChild(urlField);
        form.appendChild(nameField);
        form.appendChild(idField);
        form.appendChild(credentialField);

        const actions = document.createElement('div');
        actions.className = 'modal-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.textContent = 'Cancel';

        const submitBtn = document.createElement('button');
        submitBtn.type = 'submit';
        submitBtn.className = 'btn btn-primary';
        submitBtn.textContent = isEdit ? 'Save' : 'Add';

        actions.appendChild(cancelBtn);
        actions.appendChild(submitBtn);
        form.appendChild(actions);

        // ------------------------------------------------------------------
        // Debounced credential re-fetch on URL edits (both modes)
        // ------------------------------------------------------------------
        let debounceTimer = null;

        function clearScheduledRefresh() {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
                debounceTimer = null;
            }
        }

        // Monotonically-incrementing token guarding against out-of-order
        // responses: a URL edit that resolves after a *later* edit's fetch
        // must not overwrite the select with its now-stale options.
        let credentialRequestId = 0;

        function setCredentialHint(text) {
            credentialHint.textContent = text;
            credentialHint.hidden = !text;
        }

        async function refreshCredentialOptions(url) {
            const requestId = ++credentialRequestId;
            const trimmedUrl = url.trim();
            if (!trimmedUrl) {
                rebuildCredentialSelect(credentialSelect, [], storedCredentialId);
                setCredentialHint('');
                return;
            }
            let options;
            try {
                options = await api.repositories.credentialOptionsForUrl(trimmedUrl);
            } catch {
                // Background refresh — a failure here should not disrupt the form.
                return;
            }
            if (requestId !== credentialRequestId) {
                // A newer request has since started; discard this stale response.
                return;
            }
            rebuildCredentialSelect(credentialSelect, options, storedCredentialId);
            setCredentialHint(describeEmptyCredentialOptions(trimmedUrl, options));
        }

        urlInput.addEventListener('input', () => {
            clearScheduledRefresh();
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                refreshCredentialOptions(urlInput.value);
            }, URL_CHANGE_DEBOUNCE_MS);
        });

        // ------------------------------------------------------------------
        // Shell — Escape/backdrop-cancel, focus trap, focus restoration
        // ------------------------------------------------------------------
        function cancel() {
            clearScheduledRefresh();
            shell.close();
            reject(new Error('User cancelled'));
        }

        const shell = createModalShell({
            titleText: isEdit ? 'Edit Repository' : 'Add Repository',
            ariaLabelledbyId: 'repository-modal-title',
            className: 'modal--form',
            onCancel: cancel,
        });

        shell.modal.appendChild(form);

        cancelBtn.addEventListener('click', cancel);

        function setBusy(busy) {
            shell.setBusy(busy);
            submitBtn.disabled = busy;
            cancelBtn.disabled = busy;
        }

        // ------------------------------------------------------------------
        // Submit
        // ------------------------------------------------------------------
        form.addEventListener('submit', async (event) => {
            event.preventDefault();

            if (!validateRequired(form, ['url'])) return;

            const urlValue  = urlInput.value.trim();
            const nameValue = form.querySelector('[name="name"]').value.trim();
            const selectedCredentialId = credentialSelect.value;

            setBusy(true);

            try {
                let resolvedRepo;

                if (isEdit) {
                    const updated = await api.repositories.update(repo.id, { name: nameValue, url: urlValue });
                    resolvedRepo = normaliseRepo(updated);

                    if (selectedCredentialId !== storedCredentialId) {
                        try {
                            const withCredential = await api.repositories.updateCredential(repo.id, selectedCredentialId);
                            resolvedRepo = normaliseRepo(withCredential);
                        } catch (credErr) {
                            showToast(credErr.message || 'Failed to update credential.', 'error');
                        }
                    }
                } else {
                    const idValue = form.querySelector('[name="id"]').value.trim();
                    const created = await api.repositories.create({
                        url: urlValue,
                        ...(nameValue ? { name: nameValue } : {}),
                        ...(idValue ? { id: idValue } : {}),
                    });
                    resolvedRepo = normaliseRepo(created);

                    if (selectedCredentialId) {
                        try {
                            const withCredential = await api.repositories.updateCredential(resolvedRepo.id, selectedCredentialId);
                            resolvedRepo = normaliseRepo(withCredential);
                        } catch (credErr) {
                            showToast(credErr.message || 'Failed to set credential.', 'error');
                        }
                    }
                }

                clearScheduledRefresh();
                shell.close();
                resolve(resolvedRepo);
            } catch (err) {
                showToast(err.message || 'Failed to save repository.', 'error');
                setBusy(false);
            }
        });

        // ------------------------------------------------------------------
        // Mount & focus
        // ------------------------------------------------------------------
        shell.mount(urlInput);

        if (isEdit) {
            refreshCredentialOptions(repo.url);
        }
    });
}
