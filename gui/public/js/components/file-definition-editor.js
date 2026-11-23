/**
 * File-Definition Table & Editor — shared GUI building blocks.
 *
 * Extracted from the project-level "Custom Files" tab (`views/project-custom-files.js`)
 * so a second consumer — the repository-level custom files section — can reuse
 * the same table/form without duplicating the markup, Tab-key handling,
 * dirty-change tracking, or accessibility wiring.
 *
 * Both exports are callback-driven and own no API binding of their own: the
 * calling view decides what "edit", "delete", and "save" mean (which
 * endpoint to call, what confirmation text to show, how to refresh). This
 * keeps the view's own section shell — busy/error state, delete
 * confirmation wording, and reload — with the view, where it differs
 * meaningfully between a project and a repository, while the form itself
 * (which is where most of the complexity lives) is written once.
 *
 * Both functions operate on the *normalised* (camelCase) file shape used by
 * the views — see `normaliseCustomFile()` in `views/project-custom-files.js`
 * for the PascalCase/camelCase bridge from the API.
 *
 * @module file-definition-editor
 */

import { showConfirm } from './confirm-dialog.js';
import { createFormField, validateRequired } from './form-helpers.js';

// ---------------------------------------------------------------------------
// buildFileDefinitionTable
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} FileDefinitionTableStatusColumn
 * @property {string} header - Column header text (e.g. `"In AGENTS.md"`).
 * @property {function(Object): string} render - Returns the cell's text for one file.
 * @property {function(Object): string} [ariaLabel] - Optional `aria-label` for the cell, when its
 *   rendered text alone would not be descriptive enough (e.g. an em dash for "not listed").
 */

/**
 * @typedef {Object} BuildFileDefinitionTableOptions
 * @property {Array<Object>} files - Normalised file objects (`{ id, label, description, directory, fileName, ... }`).
 * @property {function(Object): string} formatPath - Formats a file's workspace-relative display path.
 * @property {string} [caption] - Screen-reader-only table caption. Defaults to `"Files"`.
 * @property {string} [pathColumnHeader] - Header text for the path column. Defaults to `"Path"`.
 * @property {FileDefinitionTableStatusColumn} [statusColumn] - An optional extra status column
 *   rendered between the path and actions columns (e.g. the project view's "In AGENTS.md" state).
 *   Omit it for a table that has no such per-file status concept.
 * @property {function(Object): void} onEdit - Called with the file when its Edit button is clicked.
 * @property {function(Object): (void|Promise<void>)} onDelete - Called with the file when its Delete
 *   button is clicked. The row's Delete button is disabled for the duration of the returned promise
 *   and re-enabled only if it rejects — a resolution is assumed to be followed by the caller removing
 *   or re-rendering the row (e.g. via its own refresh), so the table never second-guesses the outcome.
 *   Any confirmation dialog belongs in this callback, not in the table.
 */

/**
 * Build a scrollable table listing `files`, with Edit/Delete actions per row.
 *
 * @param {BuildFileDefinitionTableOptions} options
 * @returns {HTMLElement} A scroll wrapper (`.custom-files-table-wrap`) containing the table.
 */
export function buildFileDefinitionTable({
    files,
    formatPath,
    caption = 'Files',
    pathColumnHeader = 'Path',
    statusColumn,
    onEdit,
    onDelete,
}) {
    const table = document.createElement('table');
    table.className = 'data-table custom-files-table';

    const captionEl = document.createElement('caption');
    captionEl.className = 'sr-only';
    captionEl.textContent = caption;
    table.appendChild(captionEl);

    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    const headers = ['Label', pathColumnHeader];
    if (statusColumn) headers.push(statusColumn.header);
    headers.push('Actions');
    headers.forEach((label) => {
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = label;
        htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    files.forEach((file) => {
        const tr = document.createElement('tr');
        tr.dataset.fileId = file.id;

        const labelCell = document.createElement('td');
        const labelEl = document.createElement('strong');
        labelEl.textContent = file.label;
        labelCell.appendChild(labelEl);
        if (file.description) {
            const desc = document.createElement('div');
            desc.className = 'text-secondary custom-file-desc';
            desc.textContent = file.description;
            labelCell.appendChild(desc);
        }
        tr.appendChild(labelCell);

        const pathCell = document.createElement('td');
        pathCell.className = 'font-mono';
        pathCell.textContent = formatPath(file);
        tr.appendChild(pathCell);

        if (statusColumn) {
            const statusCell = document.createElement('td');
            statusCell.textContent = statusColumn.render(file);
            if (statusColumn.ariaLabel) {
                const label = statusColumn.ariaLabel(file);
                if (label) statusCell.setAttribute('aria-label', label);
            }
            tr.appendChild(statusCell);
        }

        const actionsCell = document.createElement('td');
        actionsCell.className = 'table-actions';

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn btn-secondary btn-sm';
        editBtn.textContent = 'Edit';
        editBtn.setAttribute('aria-label', `Edit ${file.label}`);
        editBtn.addEventListener('click', () => onEdit(file));

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn btn-danger btn-sm';
        delBtn.textContent = 'Delete';
        delBtn.setAttribute('aria-label', `Delete ${file.label}`);
        delBtn.addEventListener('click', async () => {
            delBtn.disabled = true;
            try {
                await onDelete(file);
            } catch {
                delBtn.disabled = false;
            }
        });

        actionsCell.appendChild(editBtn);
        actionsCell.appendChild(delBtn);
        tr.appendChild(actionsCell);
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    // Scroll the table itself (not the page) when the viewport is narrower than its columns.
    const wrap = document.createElement('div');
    wrap.className = 'custom-files-table-wrap';
    wrap.appendChild(table);
    return wrap;
}

// ---------------------------------------------------------------------------
// buildFileDefinitionEditor
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} BuildFileDefinitionEditorOptions
 * @property {Object|null} file - The normalised file being edited, or `null` for a new one.
 * @property {boolean} [showExecutable] - Whether to render a manual "Executable" checkbox.
 *   Omit (or pass `false`) for a form where the executable bit is decided purely by the
 *   content/extension heuristic, with no user override — the project view's current behaviour.
 * @property {string} [pathPrefixLabel] - Prefix shown before the resulting path in the live
 *   summary line (e.g. `'<workspace>/'`). Defaults to `''`.
 * @property {function(string, string): boolean} [computeExecutableHint] - Optional
 *   `(fileName, content) => boolean` heuristic used to append the "and marked executable." hint
 *   to the live summary. Omit it to leave that hint out of the summary entirely (e.g. when
 *   `showExecutable` lets the user decide explicitly instead).
 * @property {function(string, string): string} [formatPathPreview] - Formats the live
 *   "will be written to" path preview from the raw, not-yet-validated directory and file name
 *   field values. Defaults to a plain `directory/fileName` join with no tidying. Pass the view's
 *   own path-formatting helper (e.g. `formatCustomFilePath`) to match its exact tidying rules.
 * @property {function(Object): Promise<void>} onSave - Called with the save payload
 *   (`{ label, directory, fileName, description, content, listInAgents[, executable] }` —
 *   the `executable` key is present only when `showExecutable` is `true`). Must reject with
 *   an `Error` whose `message` is shown inline when the save is rejected by the server.
 * @property {function(Object): Promise<void>} [onDelete] - When provided, renders a Delete
 *   button in the form itself (in addition to any Delete action a table row may offer) and
 *   calls it with the file being edited. Omit it when the form should not offer a delete
 *   action of its own (the project view's current behaviour, where deletion is table-only).
 * @property {function(): void} onClose - Called after Cancel (confirmed if the form is dirty)
 *   or after a successful `onDelete`.
 */

/**
 * Build the add/edit form for a file definition.
 *
 * @param {BuildFileDefinitionEditorOptions} options
 * @returns {HTMLFormElement}
 */
export function buildFileDefinitionEditor({
    file,
    showExecutable = false,
    pathPrefixLabel = '',
    computeExecutableHint,
    formatPathPreview = defaultFormatPathPreview,
    onSave,
    onDelete,
    onClose,
}) {
    const isEdit = file !== null;
    const initial = file || {
        id: '', directory: '', fileName: '', label: '', description: '', content: '', listInAgents: false, executable: false,
    };

    const form = document.createElement('form');
    form.className = 'custom-file-form card';
    form.noValidate = true;

    const title = document.createElement('h4');
    title.className = 'form-section-title';
    title.textContent = isEdit ? `Edit "${initial.label}"` : 'New Custom File';
    form.appendChild(title);

    const labelField = createFormField('Label', 'text', 'label', {
        required: true, value: initial.label, placeholder: 'e.g. Start dev servers',
    });
    const dirField = createFormField('Directory', 'text', 'directory', {
        value: initial.directory, placeholder: 'e.g. scripts (empty = workspace root)',
        hint: 'Relative to the workspace root. Must stay inside the workspace.',
    });
    const nameField = createFormField('File name', 'text', 'fileName', {
        required: true, value: initial.fileName, placeholder: 'e.g. start.sh',
        hint: 'Including the extension.',
    });
    const descField = createFormField('Description', 'textarea', 'description', {
        value: initial.description, rows: 2, placeholder: 'What is this file for?',
    });
    const contentField = createFormField('Content', 'textarea', 'content', {
        value: initial.content, rows: 14,
        hint: 'Plain text (UTF-8). Tab inserts a tab character; press Esc, then Tab, to move to the next field.',
    });

    [labelField, dirField, nameField, descField, contentField].forEach((f) => form.appendChild(f));

    const inp = (name) => form.querySelector(`[name="${name}"]`);
    const content = inp('content');
    content.classList.add('custom-file-content');
    content.wrap = 'off';
    content.spellcheck = false;
    content.setAttribute('autocapitalize', 'off');
    content.setAttribute('autocomplete', 'off');

    // ---- Tab-key handling with an Escape escape hatch (no keyboard trap) ----
    let tabEscapes = false;
    content.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            tabEscapes = true;
            return;
        }
        if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !tabEscapes) {
            e.preventDefault();
            const { selectionStart: s, selectionEnd: en, value } = content;
            content.value = `${value.slice(0, s)}\t${value.slice(en)}`;
            content.selectionStart = content.selectionEnd = s + 1;
            content.dispatchEvent(new Event('input', { bubbles: true }));
            return;
        }
        if (e.key !== 'Shift') tabEscapes = false;
    });

    // ---- "List in AGENTS.md" switch ----
    const switchGroup = document.createElement('div');
    switchGroup.className = 'form-group custom-file-switch';
    const switchLabel = document.createElement('label');
    switchLabel.className = 'switch-label';
    const switchInput = document.createElement('input');
    switchInput.type = 'checkbox';
    switchInput.name = 'listInAgents';
    switchInput.setAttribute('role', 'switch');
    switchInput.checked = initial.listInAgents;
    const switchText = document.createElement('span');
    switchText.textContent = 'List in the workspace AGENTS.md';
    switchLabel.appendChild(switchInput);
    switchLabel.appendChild(switchText);
    const switchHint = document.createElement('span');
    switchHint.className = 'hint';
    switchHint.textContent =
        'Adds the path, label and description to a "Custom Files" section so agents can discover the file.';
    switchGroup.appendChild(switchLabel);
    switchGroup.appendChild(switchHint);
    form.appendChild(switchGroup);

    // ---- Optional "Executable" override switch ----
    let executableInput = null;
    if (showExecutable) {
        const execGroup = document.createElement('div');
        execGroup.className = 'form-group custom-file-switch';
        const execLabel = document.createElement('label');
        execLabel.className = 'switch-label';
        executableInput = document.createElement('input');
        executableInput.type = 'checkbox';
        executableInput.name = 'executable';
        executableInput.setAttribute('role', 'switch');
        executableInput.checked = initial.executable === true;
        const execText = document.createElement('span');
        execText.textContent = 'Executable';
        execLabel.appendChild(executableInput);
        execLabel.appendChild(execText);
        const execHint = document.createElement('span');
        execHint.className = 'hint';
        execHint.textContent = 'Marks the file with the executable permission bit on POSIX systems.';
        execGroup.appendChild(execLabel);
        execGroup.appendChild(execHint);
        form.appendChild(execGroup);
    }

    // ---- Live summary: resulting path + executable hint ----
    const summary = document.createElement('p');
    summary.className = 'custom-file-summary text-secondary';
    summary.setAttribute('aria-live', 'polite');
    form.appendChild(summary);

    function updateSummary() {
        const p = formatPathPreview(inp('directory').value, inp('fileName').value);
        if (p === '') {
            summary.textContent = '';
            return;
        }
        const exec = typeof computeExecutableHint === 'function'
            && computeExecutableHint(inp('fileName').value, content.value);
        summary.textContent = `Will be written to ${pathPrefixLabel}${p}` +
            (exec ? ' and marked executable.' : '.');
    }
    ['directory', 'fileName', 'content'].forEach((n) => inp(n).addEventListener('input', updateSummary));
    updateSummary();

    // ---- Form-level error (server rejections) ----
    const formError = document.createElement('p');
    formError.className = 'form-error custom-file-form-error';
    formError.setAttribute('role', 'alert');
    formError.hidden = true;
    form.appendChild(formError);

    // ---- Actions ----
    const actions = document.createElement('div');
    actions.className = 'form-actions';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.className = 'btn btn-primary btn-sm';
    saveBtn.textContent = isEdit ? 'Save' : 'Create';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-secondary btn-sm';
    cancelBtn.textContent = 'Cancel';

    const dirtyMark = document.createElement('span');
    dirtyMark.className = 'unsaved-indicator text-secondary';
    dirtyMark.textContent = 'Unsaved changes';
    dirtyMark.hidden = true;

    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);

    let deleteBtn = null;
    if (isEdit && typeof onDelete === 'function') {
        deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn btn-danger btn-sm';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', async () => {
            deleteBtn.disabled = true;
            try {
                await onDelete(initial);
                onClose();
            } catch (err) {
                formError.textContent = err?.message || 'Failed to delete.';
                formError.hidden = false;
                deleteBtn.disabled = false;
            }
        });
        actions.appendChild(deleteBtn);
    }

    actions.appendChild(dirtyMark);
    form.appendChild(actions);

    // ---- Dirty tracking ----
    function snapshot() {
        return JSON.stringify([
            inp('label').value, inp('directory').value, inp('fileName').value,
            inp('description').value, content.value, switchInput.checked,
            executableInput ? executableInput.checked : null,
        ]);
    }
    const initialSnapshot = snapshot();
    const isDirty = () => snapshot() !== initialSnapshot;
    const refreshDirty = () => { dirtyMark.hidden = !isDirty(); };
    form.addEventListener('input', refreshDirty);
    form.addEventListener('change', refreshDirty);

    cancelBtn.addEventListener('click', async () => {
        if (isDirty()) {
            try {
                await showConfirm('Discard Changes', 'Discard your unsaved changes to this custom file?');
            } catch {
                return;
            }
        }
        onClose();
    });

    // ---- Submit ----
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        formError.hidden = true;

        if (!validateRequired(form, ['label', 'fileName'])) return;

        const fileName = inp('fileName').value.trim();
        if (/[\\/]/.test(fileName)) {
            formError.textContent = 'File name must not contain path separators — use the directory field.';
            formError.hidden = false;
            inp('fileName').focus();
            return;
        }

        const payload = {
            label:        inp('label').value.trim(),
            directory:    inp('directory').value.trim(),
            fileName,
            description:  inp('description').value.trim(),
            content:      content.value,
            listInAgents: switchInput.checked,
        };
        if (showExecutable) payload.executable = executableInput.checked;

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        try {
            await onSave(payload);
        } catch (err) {
            formError.textContent = err?.message || 'Failed to save custom file.';
            formError.hidden = false;
            saveBtn.disabled = false;
            saveBtn.textContent = isEdit ? 'Save' : 'Create';
        }
    });

    return form;
}

/**
 * Default `formatPathPreview`: a plain, untidied `directory/fileName` join.
 * Callers that want the same separator/`./`-tidying rules their view applies
 * to the final validated path should pass their own formatter instead (see
 * `formatPathPreview` in {@link buildFileDefinitionEditor}'s options).
 */
function defaultFormatPathPreview(directory, fileName) {
    const dir = (directory || '').trim();
    const name = (fileName || '').trim();
    return dir === '' ? name : `${dir}/${name}`;
}
