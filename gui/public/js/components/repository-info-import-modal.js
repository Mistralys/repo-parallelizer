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
 * Milestone 2 widens the same dialog with a Files table: one row per
 * `RepositoryFileDiff` (`src/orchestration/repository-info.ts`), offering the
 * two actions allowed for that diff's `kind` (`add`/`discard` for
 * `incoming-only`, `keep`/`delete` for `local-only`, `overwrite`/`keep` for
 * `changed`), mirroring WP-006's server-side action table
 * (`ALLOWED_FILE_IMPORT_ACTIONS`). A `problem` file (binary, oversized,
 * unreadable, or an invalid path — never set for `local-only`) can only
 * resolve to the one safe, non-destructive action for its kind (`discard` for
 * `incoming-only`, `keep` for `changed`, matching `resolveFileImportAction()`
 * server-side) — its other radio is rendered but disabled so a selection the
 * server would reject can never be submitted.
 *
 * Default selections follow the same per-state pattern as the field rows:
 * state `incoming` defaults to the action that takes the incoming side
 * (`add`/`delete`/`overwrite`); state `conflict` defaults to the action that
 * keeps Paralizer's own data (`discard`/`keep`/`keep` — Open Question 7's
 * resolution), regardless of individual diff kind. A `problem` file always
 * defaults to (and is locked onto) the safe action, irrespective of state.
 *
 * `discard` is the one destructive action in the table — it removes an
 * incoming-only file from the managed clone, and the next Commit & Push
 * removes it from the repository. Whenever the current selection contains at
 * least one `discard`, clicking Apply first opens a `showConfirm()` dialog
 * listing the affected paths; cancelling leaves the modal open with the
 * selection untouched and sends nothing.
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
import { showConfirm } from './confirm-dialog.js';
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

/**
 * Per-`RepositoryFileDiff.kind` action table — mirrors the server's
 * `ALLOWED_FILE_IMPORT_ACTIONS` (`src/orchestration/repository-info.ts`)
 * exactly, including display order (`add`/`discard`, `keep`/`delete`,
 * `overwrite`/`keep`).
 *
 * @type {Record<'incoming-only'|'local-only'|'changed', { actions: [string, string], labels: Record<string, string>, kindLabel: string }>}
 */
const FILE_ACTION_CONFIG = {
    'incoming-only': {
        actions: ['add', 'discard'],
        labels: { add: 'Add', discard: 'Discard' },
        kindLabel: 'Added in repository',
    },
    'local-only': {
        actions: ['keep', 'delete'],
        labels: { keep: 'Keep', delete: 'Delete' },
        kindLabel: 'Removed in repository',
    },
    changed: {
        actions: ['overwrite', 'keep'],
        labels: { overwrite: 'Overwrite with incoming', keep: 'Keep current' },
        kindLabel: 'Changed',
    },
};

/**
 * The action, per diff kind, that keeps Paralizer's own data — mirrors the
 * server's `defaultFileImportAction()`. Always the one safe action for a
 * `problem` diff.
 *
 * @param {'incoming-only'|'local-only'|'changed'} kind
 * @returns {string}
 */
function keepLocalAction(kind) {
    return kind === 'incoming-only' ? 'discard' : 'keep';
}

/**
 * The action, per diff kind, that takes the incoming (repository) side.
 *
 * @param {'incoming-only'|'local-only'|'changed'} kind
 * @returns {string}
 */
function takeIncomingAction(kind) {
    if (kind === 'incoming-only') return 'add';
    if (kind === 'local-only') return 'delete';
    return 'overwrite';
}

/**
 * Formats a `RepositoryFileFieldChange[]` (`diff.changes`, `kind === 'changed'`
 * only) into a short, human-readable summary of which fields differ.
 *
 * @param {Array<{ field: string }>|undefined} changes
 * @returns {string}
 */
function formatFileChanges(changes) {
    if (!Array.isArray(changes) || changes.length === 0) return '';
    return changes.map((c) => c.field).join(', ');
}

// ---------------------------------------------------------------------------
// DOM builders — field rows
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
 * @returns {{ fieldset: HTMLFieldSetElement, field: string, importRadio: HTMLInputElement, keepRadio: HTMLInputElement, focusRadio: HTMLInputElement }}
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

    return {
        fieldset,
        field: diff.field,
        importRadio,
        keepRadio,
        focusRadio: importRadio.checked ? importRadio : keepRadio,
    };
}

// ---------------------------------------------------------------------------
// DOM builders — file rows (Milestone 2)
// ---------------------------------------------------------------------------

/**
 * Build one file row: a `<fieldset>`/`<legend>` naming the path, the kind and
 * (for `changed`) the differing-field summary, optional problem text, and
 * the two radios allowed for the diff's `kind`.
 *
 * @param {{ path: string, kind: 'incoming-only'|'local-only'|'changed', changes?: Array<{field:string}>, problem?: string }} diff
 * @param {'incoming'|'conflict'} state
 * @param {number} index - Unique index, used to build a collision-free radio `name`.
 * @returns {{ fieldset: HTMLFieldSetElement, path: string, getSelectedAction: () => string, focusRadio: HTMLInputElement }}
 */
function buildFileRow(diff, state, index) {
    const config = FILE_ACTION_CONFIG[diff.kind];

    const fieldset = document.createElement('fieldset');
    fieldset.className = 'info-import-field info-import-file';

    const legend = document.createElement('legend');
    legend.textContent = diff.path;
    fieldset.appendChild(legend);

    const kindEl = document.createElement('div');
    kindEl.className = 'info-import-file__kind';
    kindEl.textContent = config.kindLabel;
    fieldset.appendChild(kindEl);

    if (diff.kind === 'changed') {
        const changesEl = document.createElement('div');
        changesEl.className = 'info-import-file__changes';
        changesEl.textContent = formatFileChanges(diff.changes);
        fieldset.appendChild(changesEl);
    }

    const hasProblem = typeof diff.problem === 'string' && diff.problem !== '';
    if (hasProblem) {
        const problemEl = document.createElement('p');
        problemEl.className = 'info-import-file__problem';
        problemEl.textContent = diff.problem;
        fieldset.appendChild(problemEl);
    }

    // A problem file always defaults to (and is locked onto) the safe
    // action, regardless of state — mirrors `resolveFileImportAction()`.
    const safeAction = keepLocalAction(diff.kind);
    const defaultAction = hasProblem
        ? safeAction
        : (state === 'incoming' ? takeIncomingAction(diff.kind) : safeAction);

    const radioGroup = document.createElement('div');
    radioGroup.className = 'info-import-field__choice';
    const radioName = `info-import-file-${index}`;

    /** @type {Record<string, HTMLInputElement>} */
    const radiosByAction = {};

    config.actions.forEach((action) => {
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = radioName;
        radio.id = `${radioName}-${action}`;
        radio.value = action;
        radio.checked = defaultAction === action;
        // The destructive (take-incoming) action is disabled on a problem
        // file — only the safe action can ever be submitted for it.
        radio.disabled = hasProblem && action !== safeAction;

        const label = document.createElement('label');
        label.htmlFor = radio.id;
        label.textContent = config.labels[action];

        radioGroup.appendChild(radio);
        radioGroup.appendChild(label);
        radiosByAction[action] = radio;
    });
    fieldset.appendChild(radioGroup);

    const checkedRadio = config.actions
        .map((action) => radiosByAction[action])
        .find((radio) => radio.checked);

    return {
        fieldset,
        path: diff.path,
        getSelectedAction() {
            return config.actions.find((action) => radiosByAction[action].checked);
        },
        focusRadio: checkedRadio,
    };
}

// ---------------------------------------------------------------------------
// showRepositoryInfoImportModal
// ---------------------------------------------------------------------------

/**
 * Show the per-field (and, as of Milestone 2, per-file) import diff modal.
 *
 * @param {Object} config
 * @param {string} config.repoId - Repository ID; forwarded to `applyImport()`.
 * @param {string} [config.repoName] - Human-readable repository name, shown
 *   in the modal title when present.
 * @param {{ state: 'incoming'|'conflict', fields: Array<{ field: string, current: string, incoming: string }>, files?: Array<{ path: string, kind: 'incoming-only'|'local-only'|'changed', changes?: Array<{field:string}>, problem?: string }> }} config.preview
 *   The diff preview, as returned by `api.repositories.infoSync.importPreview()`.
 *   `files` is optional for backward compatibility with a pre-Milestone-2
 *   preview payload; a missing or non-array value renders no file rows.
 * @returns {Promise<{ applied: boolean }>} Always resolves — `{ applied: true }`
 *   after a successful Apply, `{ applied: false }` on Cancel/Escape/backdrop-click.
 *   Never rejects, unlike `confirm-dialog.js`'s `showConfirm()`.
 */
export function showRepositoryInfoImportModal({ repoId, repoName, preview }) {
    return new Promise((resolve) => {
        const state = preview?.state;
        const fieldDiffs = (Array.isArray(preview?.fields) ? preview.fields : [])
            .filter((diff) => IMPORTABLE_FIELDS.has(diff.field));
        const fileDiffs = Array.isArray(preview?.files) ? preview.files : [];

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

        const fieldRows = fieldDiffs.map((diff) => buildFieldRow(diff, state));
        fieldRows.forEach((row) => bodyEl.appendChild(row.fieldset));

        const fileRows = fileDiffs.map((diff, index) => buildFileRow(diff, state, index));
        if (fileRows.length > 0) {
            const filesHeading = document.createElement('h3');
            filesHeading.className = 'info-import-files-heading';
            filesHeading.textContent = 'Files';
            bodyEl.appendChild(filesHeading);
            fileRows.forEach((row) => bodyEl.appendChild(row.fieldset));
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
            // Guard against a rapid double-click firing two requests: disable
            // immediately, before the (possibly awaited) discard confirmation.
            if (applyBtn.disabled) return;

            errorEl.hidden = true;
            errorEl.textContent = '';
            setBusy(true);

            const selectedFields = fieldRows
                .filter((row) => row.importRadio.checked)
                .map((row) => row.field);
            const selectedFiles = fileRows.map((row) => ({ path: row.path, action: row.getSelectedAction() }));

            const discardPaths = selectedFiles
                .filter((f) => f.action === 'discard')
                .map((f) => f.path);

            if (discardPaths.length > 0) {
                try {
                    await showConfirm(
                        'Discard incoming files?',
                        'The following file(s) will be discarded and removed from the repository ' +
                        `on the next Commit & Push: ${discardPaths.join(', ')}`,
                    );
                } catch {
                    // Cancelled — leave the modal open with the selection intact, send nothing.
                    setBusy(false);
                    return;
                }
            }

            try {
                await api.repositories.infoSync.applyImport(repoId, { fields: selectedFields, files: selectedFiles });
                shell.close();
                resolve({ applied: true });
            } catch (err) {
                errorEl.textContent = err.message || 'Failed to apply import.';
                errorEl.hidden = false;
                setBusy(false);
            }
        });

        // ------------------------------------------------------------------
        // Mount & focus — the first row's currently-selected radio.
        // ------------------------------------------------------------------
        const firstRow = fieldRows[0] || fileRows[0];
        shell.mount(firstRow ? firstRow.focusRadio : undefined);
    });
}
