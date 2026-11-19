/**
 * Project Custom Files tab — Repo Parallelizer GUI.
 *
 * CRUD for the files a project copies into every workspace. Rendered inside
 * the "Custom Files" tab panel of `project-detail.js`.
 *
 *   - List: label, workspace-relative path, "listed in AGENTS.md" state,
 *     Edit / Delete per row.
 *   - Editor form (add + edit share one form): label, directory, file name,
 *     description, plain-text content (monospace textarea, no highlighting),
 *     and a "List in AGENTS.md" switch (default off).
 *
 * The server is authoritative for validation (path containment, collisions,
 * size); the form only does cheap required-field/format checks and shows the
 * server's message inline when a save is rejected.
 *
 * ## Keyboard
 *
 * Inside the content textarea, Tab inserts a tab character (scripts and
 * Makefiles need them). To avoid a keyboard trap, pressing Escape first makes
 * the next Tab/Shift+Tab move focus as normal; the hint under the field says so.
 *
 * @module project-custom-files
 */

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { showConfirm } from '../components/confirm-dialog.js';
import { createFormField, validateRequired } from '../components/form-helpers.js';

/** Extensions that the server marks executable (mirror of `isExecutableFile`). */
const EXECUTABLE_EXTENSIONS = ['.sh', '.bash', '.zsh', '.ksh', '.command'];

/**
 * Normalise a custom file object from the backend (PascalCase or camelCase).
 *
 * @param {Object} f
 * @returns {{ id: string, directory: string, fileName: string, label: string, description: string, content: string, listInAgents: boolean }}
 */
export function normaliseCustomFile(f) {
    return {
        id:           f.Id           || f.id           || '',
        directory:    f.Directory    ?? f.directory    ?? '',
        fileName:     f.FileName     ?? f.fileName     ?? '',
        label:        f.Label        ?? f.label        ?? '',
        description:  f.Description  ?? f.description  ?? '',
        content:      f.Content      ?? f.content      ?? '',
        listInAgents: (f.ListInAgents ?? f.listInAgents) === true,
    };
}

/**
 * Join a directory and file name into the workspace-relative display path.
 *
 * @param {string} directory
 * @param {string} fileName
 * @returns {string}
 */
export function formatCustomFilePath(directory, fileName) {
    const dir = (directory || '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    const name = (fileName || '').trim();
    return dir === '' || dir === '.' ? name : `${dir}/${name}`;
}

/**
 * Client-side mirror of the server's executable heuristic, used only for the
 * live hint in the form. The server decides what is actually written.
 *
 * @param {string} fileName
 * @param {string} content
 * @returns {boolean}
 */
export function isExecutableHint(fileName, content) {
    const lower = (fileName || '').trim().toLowerCase();
    return EXECUTABLE_EXTENSIONS.some((ext) => lower.endsWith(ext)) || (content || '').startsWith('#!');
}

/**
 * Build the Custom Files section.
 *
 * @param {string} projectId
 * @param {Array<Object>} rawFiles - `project.CustomFiles` from the API (may be undefined).
 * @param {function(): Promise<void>} onRefresh - Re-renders the whole project view.
 * @returns {HTMLElement}
 */
export function buildCustomFilesSection(projectId, rawFiles, onRefresh) {
    const files = Array.isArray(rawFiles) ? rawFiles.map(normaliseCustomFile) : [];

    const section = document.createElement('section');
    section.className = 'project-custom-files-section';

    const intro = document.createElement('p');
    intro.className = 'text-secondary custom-files-intro';
    intro.textContent =
        'Files listed here are copied into every workspace of this project and kept in sync. ' +
        'Edits made to a copy inside a workspace are overwritten on the next sync, and deleting ' +
        'an entry (or changing its path or name) removes the old copies from all workspaces.';
    section.appendChild(intro);

    const editorSlot = document.createElement('div');
    editorSlot.className = 'custom-file-editor-slot';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-secondary btn-sm';
    addBtn.textContent = '+ Add Custom File';

    /** Opens the editor for `file` (or a blank one) and hides the add button. */
    function openEditor(file) {
        editorSlot.replaceChildren(
            buildEditorForm(projectId, file, {
                onSaved: onRefresh,
                onClose: () => {
                    editorSlot.replaceChildren();
                    addBtn.hidden = false;
                    addBtn.focus();
                },
            }),
        );
        addBtn.hidden = true;
        const first = editorSlot.querySelector('input, textarea');
        if (first) first.focus();
    }

    addBtn.addEventListener('click', () => openEditor(null));

    if (files.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty-state-inline text-secondary';
        empty.textContent = 'No custom files yet.';
        section.appendChild(empty);
    } else {
        section.appendChild(buildFileTable(projectId, files, openEditor, onRefresh));
    }

    const toolbar = document.createElement('div');
    toolbar.className = 'custom-files-toolbar';
    toolbar.appendChild(addBtn);
    section.appendChild(toolbar);
    section.appendChild(editorSlot);

    return section;
}

/**
 * @param {string} projectId
 * @param {ReturnType<typeof normaliseCustomFile>[]} files
 * @param {function(Object): void} openEditor
 * @param {function(): Promise<void>} onRefresh
 * @returns {HTMLElement} A scroll wrapper containing the table.
 */
function buildFileTable(projectId, files, openEditor, onRefresh) {
    const table = document.createElement('table');
    table.className = 'data-table custom-files-table';

    const caption = document.createElement('caption');
    caption.className = 'sr-only';
    caption.textContent = 'Custom files of this project';
    table.appendChild(caption);

    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    ['Label', 'Path in workspace', 'In AGENTS.md', 'Actions'].forEach((label) => {
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
        pathCell.textContent = formatCustomFilePath(file.directory, file.fileName);
        tr.appendChild(pathCell);

        const agentsCell = document.createElement('td');
        agentsCell.textContent = file.listInAgents ? 'Listed' : '—';
        if (!file.listInAgents) agentsCell.setAttribute('aria-label', 'Not listed');
        tr.appendChild(agentsCell);

        const actionsCell = document.createElement('td');
        actionsCell.className = 'table-actions';

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn btn-secondary btn-sm';
        editBtn.textContent = 'Edit';
        editBtn.setAttribute('aria-label', `Edit ${file.label}`);
        editBtn.addEventListener('click', () => openEditor(file));

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn btn-danger btn-sm';
        delBtn.textContent = 'Delete';
        delBtn.setAttribute('aria-label', `Delete ${file.label}`);
        delBtn.addEventListener('click', async () => {
            try {
                await showConfirm(
                    'Delete Custom File',
                    `Delete "${file.label}" (${formatCustomFilePath(file.directory, file.fileName)})? ` +
                    'The copies in all workspaces of this project are removed from disk. ' +
                    'This cannot be undone.',
                );
            } catch {
                return;
            }
            delBtn.disabled = true;
            try {
                await api.projects.customFiles.delete(projectId, file.id);
                showToast(`Custom file "${file.label}" deleted.`, 'success');
                await onRefresh();
            } catch (err) {
                showToast(err.message || 'Failed to delete custom file.', 'error');
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

/**
 * Build the add/edit form.
 *
 * @param {string} projectId
 * @param {ReturnType<typeof normaliseCustomFile>|null} file - `null` for a new file.
 * @param {{ onSaved: function(): Promise<void>, onClose: function(): void }} cb
 * @returns {HTMLElement}
 */
function buildEditorForm(projectId, file, cb) {
    const isEdit = file !== null;
    const initial = file || {
        id: '', directory: '', fileName: '', label: '', description: '', content: '', listInAgents: false,
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

    // ---- Live summary: resulting path + executable hint ----
    const summary = document.createElement('p');
    summary.className = 'custom-file-summary text-secondary';
    summary.setAttribute('aria-live', 'polite');
    form.appendChild(summary);

    function updateSummary() {
        const p = formatCustomFilePath(inp('directory').value, inp('fileName').value);
        if (p === '') {
            summary.textContent = '';
            return;
        }
        const exec = isExecutableHint(inp('fileName').value, content.value);
        summary.textContent = `Will be written to <workspace>/${p}` +
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
    actions.appendChild(dirtyMark);
    form.appendChild(actions);

    // ---- Dirty tracking ----
    function snapshot() {
        return JSON.stringify([
            inp('label').value, inp('directory').value, inp('fileName').value,
            inp('description').value, content.value, switchInput.checked,
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
        cb.onClose();
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

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        try {
            if (isEdit) {
                await api.projects.customFiles.update(projectId, initial.id, payload);
            } else {
                await api.projects.customFiles.create(projectId, payload);
            }
            showToast(`Custom file "${payload.label}" ${isEdit ? 'saved' : 'created'}.`, 'success');
            await cb.onSaved();
        } catch (err) {
            formError.textContent = err.message || 'Failed to save custom file.';
            formError.hidden = false;
            saveBtn.disabled = false;
            saveBtn.textContent = isEdit ? 'Save' : 'Create';
        }
    });

    return form;
}
