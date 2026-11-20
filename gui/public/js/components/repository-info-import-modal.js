/**
 * Repository Info Import Modal Component.
 *
 * Renders the per-field diff dialog offered when a repository's managed
 * `.workspace/info.json` file carries values that differ from Paralizer's
 * own data (info-sync states `incoming` and `conflict`). One row per
 * differing field lets the user choose to keep the local value or import
 * the incoming one; `Url` is never shown because it is informational only
 * and is not an importable field (see `repository-info.ts`
 * `diffRepositoryInfo()`, which already excludes it upstream — this module
 * filters defensively in case that invariant ever regresses).
 *
 * Built on the shared `modal-shell.js` primitive, which supplies the
 * overlay/modal/ARIA DOM, focus trap, focus restoration, and
 * Escape/backdrop-cancel wiring — see `confirm-dialog.js` and
 * `repository-modal.js` for the other consumers of the same shell.
 *
 * Usage:
 *   import { showRepositoryInfoImportModal } from './components/repository-info-import-modal.js';
 *
 *   const { applied } = await showRepositoryInfoImportModal({
 *     repoId: 'my-repo',
 *     repoName: 'My Repository',
 *     preview: await api.repositories.infoSync.importPreview('my-repo'),
 *   });
 */

import { createModalShell } from './modal-shell.js';
import { api } from '../api.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Importable fields, in display order. Mirrors the server-side
 * `RepositoryInfoImportField` union (`src/orchestration/repository-info.ts`)
 * — kept as a literal list here (rather than importing across the
 * GUI/server boundary, which this project does not do) so a field never
 * accidentally slips past the modal's own filter even if the preview
 * payload ever carries something else.
 *
 * @type {ReadonlySet<string>}
 */
const IMPORTABLE_FIELDS = new Set(['Name', 'Description']);

/** Human-readable placeholder shown for an empty current/incoming value. */
const EMPTY_VALUE_PLACEHOLDER = '(empty)';

// ---------------------------------------------------------------------------
// DOM builders
// ---------------------------------------------------------------------------

/**
 * Build a single labelled, wrapping value block ("Current" or "Incoming").
 *
 * @param {string} labelText
 * @param {string} value
 * @returns {HTMLDivElement}
 */
function buildValueBlock(labelText, value) {
    const wrap = document.createElement('div');
    wrap.className = 'info-import-value';

    const label = document.createElement('span');
    label.className = 'info-import-value__label';
    label.textContent = labelText;
    wrap.appendChild(label);

    const text = document.createElement('div');
    text.className = 'info-import-value__text';
    text.textContent = value === '' ? EMPTY_VALUE_PLACEHOLDER : value;
    wrap.appendChild(text);

    return wrap;
}

/**
 * Build one field row: a `<fieldset>`/`<legend>` naming the field, the
 * current/incoming value blocks, and a Keep/Import radio pair.
 *
 * @param {{ field: string, current: string, incoming: string }} diff
 * @param {'incoming'|'conflict'} state
 * @returns {{ fieldset: HTMLFieldSetElement, field: string, importRadio: HTMLInputElement }}
 */
function buildFieldRow(diff, state) {
    const fieldset = document.createElement('fieldset');
    fieldset.className = 'info-import-field';

    const legend = document.createElement('legend');
    legend.textContent = diff.field;
    fieldset.appendChild(legend);

    fieldset.appendChild(buildValueBlock('Current', diff.current));
    fieldset.appendChild(buildValueBlock('Incoming', diff.incoming));

    const radioGroup = document.createElement('div');
    radioGroup.className = 'info-import-field__choice';
    const radioName = `info-import-${diff.field}`;

    // Default: "import" for `incoming`, "keep" for `conflict` (plan step 15).
    const defaultChoice = state === 'incoming' ? 'import' : 'keep';

    const keepId = `${radioName}-keep`;
    const importId = `${radioName}-import`;

    const keepRadio = document.createElement('input');
    keepRadio.type = 'radio';
    keepRadio.name = radioName;
    keepRadio.id = keepId;
    keepRadio.value = 'keep';
    keepRadio.checked = defaultChoice === 'keep';

    const keepLabel = document.createElement('label');
    keepLabel.htmlFor = keepId;
    keepLabel.textContent = 'Keep current';

    const importRadio = document.createElement('input');
    importRadio.type = 'radio';
    importRadio.name = radioName;
    importRadio.id = importId;
    importRadio.value = 'import';
    importRadio.checked = defaultChoice === 'import';

    const importLabel = document.createElement('label');
    importLabel.htmlFor = importId;
    importLabel.textContent = 'Import incoming';

    radioGroup.appendChild(keepRadio);
    radioGroup.appendChild(keepLabel);
    radioGroup.appendChild(importRadio);
    radioGroup.appendChild(importLabel);
    fieldset.appendChild(radioGroup);

    return { fieldset, field: diff.field, importRadio, keepRadio };
}

// ---------------------------------------------------------------------------
// showRepositoryInfoImportModal
// ---------------------------------------------------------------------------

/**
 * Show the per-field import diff modal.
 *
 * @param {Object} config
 * @param {string} config.repoId - Repository ID; forwarded to `applyImport()`.
 * @param {string} [config.repoName] - Human-readable repository name, shown
 *   in the modal title when present.
 * @param {{ state: 'incoming'|'conflict', fields: Array<{ field: string, current: string, incoming: string }> }} config.preview
 *   The diff preview, as returned by `api.repositories.infoSync.importPreview()`.
 * @returns {Promise<{ applied: boolean }>} Always resolves — `{ applied: true }`
 *   after a successful Apply, `{ applied: false }` on Cancel/Escape/backdrop-click.
 *   Never rejects, unlike `confirm-dialog.js`'s `showConfirm()`.
 */
export function showRepositoryInfoImportModal({ repoId, repoName, preview }) {
    return new Promise((resolve) => {
        const state = preview?.state;
        const diffs = (Array.isArray(preview?.fields) ? preview.fields : [])
            .filter((diff) => IMPORTABLE_FIELDS.has(diff.field));

        // ------------------------------------------------------------------
        // Body
        // ------------------------------------------------------------------
        const bodyEl = document.createElement('div');
        bodyEl.className = 'modal-body';

        if (state === 'conflict') {
            const explain = document.createElement('p');
            explain.textContent =
                'Both Paralizer and the repository have changed since the last sync. ' +
                'Choose which value to keep for each field below.';
            bodyEl.appendChild(explain);
        }

        const rows = diffs.map((diff) => buildFieldRow(diff, state));
        rows.forEach((row) => bodyEl.appendChild(row.fieldset));

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

        const applyBtn = document.createElement('button');
        applyBtn.type = 'button';
        applyBtn.className = 'btn btn-primary';
        applyBtn.textContent = 'Apply';

        actionsEl.appendChild(cancelBtn);
        actionsEl.appendChild(applyBtn);

        // ------------------------------------------------------------------
        // Shell — Escape/backdrop-cancel, focus trap, focus restoration
        // ------------------------------------------------------------------
        function onCancel() {
            shell.close();
            resolve({ applied: false });
        }

        const shell = createModalShell({
            titleText: repoName ? `Import workspace info — ${repoName}` : 'Import workspace info',
            ariaLabelledbyId: 'repository-info-import-modal-title',
            className: 'modal--form',
            onCancel,
        });

        shell.modal.appendChild(bodyEl);
        shell.modal.appendChild(actionsEl);

        cancelBtn.addEventListener('click', onCancel);

        function setBusy(busy) {
            shell.setBusy(busy);
            applyBtn.disabled = busy;
            cancelBtn.disabled = busy;
        }

        applyBtn.addEventListener('click', async () => {
            errorEl.hidden = true;
            errorEl.textContent = '';

            const selectedFields = rows
                .filter((row) => row.importRadio.checked)
                .map((row) => row.field);

            setBusy(true);
            try {
                await api.repositories.infoSync.applyImport(repoId, selectedFields);
                shell.close();
                resolve({ applied: true });
            } catch (err) {
                errorEl.textContent = err.message || 'Failed to apply import.';
                errorEl.hidden = false;
                setBusy(false);
            }
        });

        // ------------------------------------------------------------------
        // Mount & focus — the first field's currently-selected radio.
        // ------------------------------------------------------------------
        const firstRow = rows[0];
        const initialFocusEl = firstRow
            ? (firstRow.importRadio.checked ? firstRow.importRadio : firstRow.keepRadio)
            : undefined;

        shell.mount(initialFocusEl);
    });
}
