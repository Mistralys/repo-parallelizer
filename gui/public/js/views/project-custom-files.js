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
import { buildFileDefinitionTable, buildFileDefinitionEditor } from '../components/file-definition-editor.js';

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
    return buildFileDefinitionTable({
        files,
        caption: 'Custom files of this project',
        pathColumnHeader: 'Path in workspace',
        formatPath: (file) => formatCustomFilePath(file.directory, file.fileName),
        statusColumn: {
            header: 'In AGENTS.md',
            render: (file) => (file.listInAgents ? 'Listed' : '—'),
            ariaLabel: (file) => (file.listInAgents ? '' : 'Not listed'),
        },
        onEdit: openEditor,
        onDelete: async (file) => {
            // Lets a cancel/Escape rejection from showConfirm propagate unchanged — the
            // table's own catch just re-enables the Delete button, with no toast, matching
            // the pre-extraction behaviour of never disabling it for a cancelled confirm.
            await showConfirm(
                'Delete Custom File',
                `Delete "${file.label}" (${formatCustomFilePath(file.directory, file.fileName)})? ` +
                'The copies in all workspaces of this project are removed from disk. ' +
                'This cannot be undone.',
            );
            try {
                await api.projects.customFiles.delete(projectId, file.id);
            } catch (err) {
                showToast(err.message || 'Failed to delete custom file.', 'error');
                throw err;
            }
            showToast(`Custom file "${file.label}" deleted.`, 'success');
            await onRefresh();
        },
    });
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

    return buildFileDefinitionEditor({
        file,
        pathPrefixLabel: '<workspace>/',
        computeExecutableHint: isExecutableHint,
        formatPathPreview: formatCustomFilePath,
        onSave: async (payload) => {
            if (isEdit) {
                await api.projects.customFiles.update(projectId, file.id, payload);
            } else {
                await api.projects.customFiles.create(projectId, payload);
            }
            showToast(`Custom file "${payload.label}" ${isEdit ? 'saved' : 'created'}.`, 'success');
            await cb.onSaved();
        },
        onClose: cb.onClose,
    });
}
