/**
 * Repository Files Section — Repo Parallelizer GUI (Milestone 2).
 *
 * Renders the "Files" section on the repository detail page: small
 * per-repository files (mainly wrapper scripts) that Paralizer writes into
 * the repository's managed main folder (`.workspace/files/`) while info sync
 * is enabled, and that reach workspace clones only through git — Commit &
 * Push from the managed clone, then a pull in each workspace. Paralizer
 * never copies these files directly into workspaces.
 *
 * The section wraps the shared table/editor extracted in
 * `components/file-definition-editor.js` (WP-013) the same way
 * `views/project-custom-files.js` does, with its own section shell: intro
 * text, busy/error state, delete confirmation through
 * `components/confirm-dialog.js`'s `showConfirm()`, and a read-only state
 * (list visible, no mutation controls actionable) while info sync is
 * disabled for the repository — files only ever reach git through the
 * managed clone, so mutating them makes no sense without it.
 *
 * `formatCustomFilePath()` and `isExecutableHint()` are reused from
 * `views/project-custom-files.js` rather than duplicated — both are pure,
 * scope-neutral helpers (no project binding), matching this plan's
 * "promote shared logic once a second consumer arrives" rationale.
 *
 * @module views/repository-files-section
 */

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { showConfirm } from '../components/confirm-dialog.js';
import { buildFileDefinitionTable, buildFileDefinitionEditor } from '../components/file-definition-editor.js';
import { formatCustomFilePath, isExecutableHint } from './project-custom-files.js';
import { clearElement } from '../utils/dom.js';

/** Text shown while info sync is disabled — no mutation control is actionable. */
const ENABLE_HINT = 'Enable workspace info sync above to add, edit, or delete repository files.';

/** Shared title attribute for every disabled mutation control while sync is off. */
const DISABLED_REASON = 'Enable workspace info sync above to manage repository files.';

/**
 * Normalise a repository file object from the backend (PascalCase or
 * camelCase) into the shape `file-definition-editor.js` expects.
 *
 * Mirrors `normaliseCustomFile()` in `project-custom-files.js`, widened with
 * the explicit `executable` flag repository files carry (Decision 7 of the
 * Milestone 2 plan — project custom files have no such field, only the
 * client-side heuristic hint).
 *
 * @param {Object} f
 * @returns {{ id: string, directory: string, fileName: string, label: string, description: string, content: string, listInAgents: boolean, executable: boolean }}
 */
export function normaliseRepositoryFile(f) {
    return {
        id:           f.Id           || f.id           || '',
        directory:    f.Directory    ?? f.directory    ?? '',
        fileName:     f.FileName     ?? f.fileName     ?? '',
        label:        f.Label        ?? f.label        ?? '',
        description:  f.Description  ?? f.description  ?? '',
        content:      f.Content      ?? f.content      ?? '',
        listInAgents: (f.ListInAgents ?? f.listInAgents) === true,
        executable:   (f.Executable   ?? f.executable)   === true,
    };
}

/**
 * Format the `sh`-invocation hint for an executable repository file, or an
 * em dash for one that is not — rendered as the table's "Run with" column.
 *
 * @param {ReturnType<typeof normaliseRepositoryFile>} file
 * @returns {string}
 */
function formatRunHint(file) {
    if (!file.executable) return '—';
    return `sh .workspace/files/${formatCustomFilePath(file.directory, file.fileName)}`;
}

/**
 * Wire a newly-created (non-edit) editor form so its Executable checkbox
 * tracks the heuristic default live as the file name/content change, until
 * the user manually toggles it — after which the manual choice sticks and
 * the heuristic no longer overrides it.
 *
 * Deliberately implemented here rather than in `file-definition-editor.js`:
 * that shared module is owned by WP-013 and this plan's "no observable
 * behaviour change" requirement keeps the project view's form (which never
 * passes `showExecutable`) untouched. Reaching into the returned form's own
 * inputs from the caller keeps the auto-check behaviour local to the one
 * consumer that wants it.
 *
 * @param {HTMLFormElement} form
 */
function wireExecutableAutoCheck(form) {
    const executableInput = form.querySelector('[name="executable"]');
    if (!executableInput) return;

    const fileNameInput = form.querySelector('[name="fileName"]');
    const contentInput = form.querySelector('[name="content"]');

    let userToggled = false;
    executableInput.addEventListener('change', () => { userToggled = true; });

    const syncFromHeuristic = () => {
        if (userToggled) return;
        executableInput.checked = isExecutableHint(fileNameInput.value, contentInput.value);
    };
    fileNameInput.addEventListener('input', syncFromHeuristic);
    contentInput.addEventListener('input', syncFromHeuristic);
}

/**
 * Build the "Files" section for the repository detail page.
 *
 * @param {{ id: string, name?: string }} repo - Normalised repository (from `normaliseRepo()`).
 * @param {{ enabled: boolean }|null} status - The repository's info-sync status
 *   (only `enabled` is read) at mount time — used to decide whether the
 *   section starts read-only. `null` (e.g. the caller's own status fetch
 *   failed) is treated the same as disabled, the safer default.
 * @param {Object} [options]
 * @param {function(): void} [options.onChanged] - Called after every
 *   successful add/update/delete so the caller can ask the info-sync
 *   section to refresh its own status (pending changes, Commit & Push
 *   availability). Not called for a failed mutation or a cancelled delete
 *   confirmation.
 * @returns {{ element: HTMLElement, cleanup: function(): void }}
 */
export function buildRepositoryFilesSection(repo, status, options = {}) {
    const { onChanged } = options;
    const repoId = repo.id;

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------
    let destroyed = false;
    const enabled = !!(status && status.enabled);
    /** @type {Array<ReturnType<typeof normaliseRepositoryFile>>|null} `null` until the first load resolves. */
    let files = null;
    /** Message shown instead of the list when the initial load fails. */
    let loadError = null;

    // ------------------------------------------------------------------
    // Skeleton
    // ------------------------------------------------------------------
    const section = document.createElement('section');
    section.className = 'repository-files-section';

    const heading = document.createElement('h2');
    heading.className = 'section-title';
    heading.tabIndex = -1;
    heading.textContent = 'Files';
    section.appendChild(heading);

    const intro = document.createElement('p');
    intro.className = 'text-secondary repository-files-intro';
    intro.textContent =
        'Files are written to the repository\'s .workspace/files/ folder and reach workspaces ' +
        'only after Commit & Push and a pull. Paralizer never copies them into workspaces.';
    section.appendChild(intro);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'repository-files-body';
    section.appendChild(bodyEl);

    // Toolbar + editor slot are built once and reused across renders (like
    // project-custom-files.js), so the open editor is not torn down by an
    // unrelated re-render triggered elsewhere.
    const editorSlot = document.createElement('div');
    editorSlot.className = 'custom-file-editor-slot';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-secondary btn-sm';
    addBtn.textContent = '+ Add File';
    if (!enabled) {
        addBtn.disabled = true;
        addBtn.title = DISABLED_REASON;
    }
    addBtn.addEventListener('click', () => openEditor(null));

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    function renderBody() {
        if (destroyed) return;
        clearElement(bodyEl);

        if (loadError) {
            renderLoadError();
            return;
        }
        if (files === null) {
            renderLoadingPlaceholder();
            return;
        }
        renderLoaded();
    }

    function renderLoadingPlaceholder() {
        section.setAttribute('aria-busy', 'true');
        const p = document.createElement('p');
        p.className = 'text-muted';
        p.setAttribute('role', 'status');
        p.setAttribute('aria-live', 'polite');
        p.textContent = 'Loading repository files…';
        bodyEl.appendChild(p);
    }

    function renderLoadError() {
        section.removeAttribute('aria-busy');
        const wrap = document.createElement('div');
        wrap.className = 'info-sync-load-error';

        const msg = document.createElement('p');
        msg.className = 'text-error';
        msg.setAttribute('role', 'alert');
        msg.textContent = loadError;
        wrap.appendChild(msg);

        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'btn btn-secondary btn-sm';
        retryBtn.textContent = 'Retry';
        retryBtn.addEventListener('click', () => { loadFiles(); });
        wrap.appendChild(retryBtn);

        bodyEl.appendChild(wrap);
    }

    function renderLoaded() {
        section.removeAttribute('aria-busy');

        if (!enabled) {
            const hint = document.createElement('p');
            hint.className = 'hint repository-files-enable-hint';
            hint.textContent = ENABLE_HINT;
            bodyEl.appendChild(hint);
        }

        if (files.length === 0) {
            // Not `.empty-state-inline` (generic, used elsewhere on this same
            // page by the workspace status table's own empty state) — a
            // distinct class keeps the two states independently queryable.
            const empty = document.createElement('p');
            empty.className = 'repository-files-empty text-secondary';
            empty.textContent = 'No repository files yet.';
            bodyEl.appendChild(empty);
        } else {
            bodyEl.appendChild(buildTable());
        }

        const toolbar = document.createElement('div');
        toolbar.className = 'custom-files-toolbar';
        toolbar.appendChild(addBtn);
        bodyEl.appendChild(toolbar);
        bodyEl.appendChild(editorSlot);
    }

    // ------------------------------------------------------------------
    // Table
    // ------------------------------------------------------------------

    function buildTable() {
        const wrap = buildFileDefinitionTable({
            files,
            caption: 'Files of this repository',
            formatPath: (file) => formatCustomFilePath(file.directory, file.fileName),
            statusColumn: {
                header: 'Run with',
                render: formatRunHint,
                ariaLabel: (file) => (file.executable ? '' : 'Not executable'),
            },
            onEdit: (file) => openEditor(file),
            onDelete: (file) => handleDelete(file),
        });

        if (!enabled) {
            // Read-only: the list stays visible, but no row action is
            // actionable (plan: "with sync disabled, the list is read-only
            // with an enable hint").
            wrap.querySelectorAll('button').forEach((btn) => {
                btn.disabled = true;
                btn.title = DISABLED_REASON;
            });
        }

        return wrap;
    }

    // ------------------------------------------------------------------
    // Editor
    // ------------------------------------------------------------------

    /**
     * Opens the editor for `file` (or a blank one for `null`) and hides the
     * Add button while it is open. A no-op while sync is disabled — the
     * caller-side controls that reach this are already disabled, but the
     * guard keeps the function safe to call unconditionally.
     *
     * @param {ReturnType<typeof normaliseRepositoryFile>|null} file
     */
    function openEditor(file) {
        if (!enabled) return;
        const form = buildEditorForm(file);
        editorSlot.replaceChildren(form);
        addBtn.hidden = true;
        const first = editorSlot.querySelector('input, textarea');
        if (first) first.focus();
    }

    function closeEditor() {
        editorSlot.replaceChildren();
        addBtn.hidden = false;
        addBtn.focus();
    }

    /**
     * @param {ReturnType<typeof normaliseRepositoryFile>|null} file - `null` for a new file.
     * @returns {HTMLFormElement}
     */
    function buildEditorForm(file) {
        const isEdit = file !== null;

        const form = buildFileDefinitionEditor({
            file,
            showExecutable: true,
            pathPrefixLabel: '.workspace/files/',
            computeExecutableHint: isExecutableHint,
            formatPathPreview: formatCustomFilePath,
            onSave: async (payload) => {
                if (isEdit) {
                    await api.repositories.files.update(repoId, file.id, payload);
                } else {
                    await api.repositories.files.create(repoId, payload);
                }
                showToast(`Repository file "${payload.label}" ${isEdit ? 'saved' : 'created'}.`, 'success');
                closeEditor();
                await afterChange();
            },
            onClose: closeEditor,
        });

        // Only a brand-new file's Executable checkbox auto-tracks the
        // heuristic — an existing file keeps showing (and defaults to) its
        // saved, explicit flag untouched.
        if (!isEdit) wireExecutableAutoCheck(form);

        return form;
    }

    /**
     * Table row Delete handler — confirms, then deletes. Lets a cancelled
     * confirmation's rejection propagate unchanged so the shared table's own
     * catch re-enables the Delete button without a toast (matching
     * `project-custom-files.js`'s established pattern).
     *
     * @param {ReturnType<typeof normaliseRepositoryFile>} file
     */
    async function handleDelete(file) {
        await showConfirm(
            'Delete Repository File',
            `Delete "${file.label}" (${formatCustomFilePath(file.directory, file.fileName)})? ` +
            'It is removed from the managed clone on the next sync, and from the repository itself ' +
            'once committed and pushed. This cannot be undone.',
        );
        try {
            await api.repositories.files.remove(repoId, file.id);
        } catch (err) {
            showToast(err.message || 'Failed to delete repository file.', 'error');
            throw err;
        }
        showToast(`Repository file "${file.label}" deleted.`, 'success');
        await afterChange();
    }

    /**
     * Re-fetches this section's own file list, then asks the caller to
     * refresh the info-sync section's status (plan: "after a save, the
     * section asks the info sync section to refresh its status, so pending
     * changes and the Commit & Push button update").
     */
    async function afterChange() {
        await loadFiles();
        if (!destroyed && typeof onChanged === 'function') onChanged();
    }

    // ------------------------------------------------------------------
    // Initial load
    // ------------------------------------------------------------------

    async function loadFiles() {
        loadError = null;
        files = null;
        renderBody();

        try {
            const raw = await api.repositories.files.list(repoId);
            if (destroyed) return;
            files = Array.isArray(raw) ? raw.map(normaliseRepositoryFile) : [];
            renderBody();
        } catch (err) {
            if (destroyed) return;
            loadError = err.message || 'Failed to load repository files.';
            renderBody();
        }
    }

    loadFiles();

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    function cleanup() {
        destroyed = true;
    }

    return { element: section, cleanup };
}
