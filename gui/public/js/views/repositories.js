/**
 * Repositories View — Repo Parallelizer GUI.
 *
 * Renders a full CRUD management page for all registered repositories:
 *   - Table listing all repositories (ID, Name, URL).
 *   - "Add Repository" inline form (URL required, Name optional, ID optional).
 *   - Inline edit for repository Name per row.
 *   - Delete per row with a confirmation dialog.
 *
 * @param {HTMLElement} container - The `#app` root element supplied by the router.
 * @param {Object}      _params   - Route params (none for this route).
 */

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { showConfirm } from '../components/confirm-dialog.js';
import { createFormField, validateRequired } from '../components/form-helpers.js';
import { normaliseRepo } from '../utils/normalise.js';
import { clearElement } from '../utils/dom.js';

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

/**
 * Build the `<thead>` element for the repository table.
 *
 * @returns {HTMLElement}
 */
function buildTableHead() {
    const thead = document.createElement('thead');
    const tr    = document.createElement('tr');

    ['ID', 'Name', 'URL', 'Actions'].forEach((label) => {
        const th = document.createElement('th');
        th.textContent = label;
        tr.appendChild(th);
    });

    thead.appendChild(tr);
    return thead;
}

/**
 * Build a single `<tr>` for one repository.
 *
 * The row starts in read mode.  The Name cell renders as a clickable `<a>`
 * link navigating to `#/repositories/:id`.  Clicking Edit switches the Name
 * cell to an inline `<input>` and replaces the action buttons with Save / Cancel.
 * Clicking Delete shows a confirmation dialog and calls the API on confirm.
 *
 * @param {{ id: string, name: string, url: string }} repo
 * @param {function(): void} onDeleted - Callback to refresh the table after deletion.
 * @returns {HTMLTableRowElement}
 */
function buildRepoRow(repo, onDeleted) {
    const tr = document.createElement('tr');
    tr.dataset.repoId = repo.id;

    // ---- ID cell (read-only) ----
    const idCell = document.createElement('td');
    idCell.className = 'repo-id-cell text-muted';
    idCell.textContent = repo.id;
    tr.appendChild(idCell);

    // ---- Name cell (editable) ----
    const nameCell = document.createElement('td');
    nameCell.className = 'repo-name-cell';

    const nameLink = document.createElement('a');
    nameLink.className = 'repo-name-display repo-name-link';
    nameLink.href      = `#/repositories/${encodeURIComponent(repo.id)}`;
    nameLink.textContent = repo.name || '—';
    nameCell.appendChild(nameLink);

    // Inline edit input (hidden initially)
    const nameInput = document.createElement('input');
    nameInput.type       = 'text';
    nameInput.className  = 'form-input repo-name-input';
    nameInput.value      = repo.name;
    nameInput.hidden     = true;
    nameInput.setAttribute('aria-label', `Name for repository ${repo.id}`);
    nameCell.appendChild(nameInput);

    tr.appendChild(nameCell);

    // ---- URL cell (read-only) ----
    const urlCell = document.createElement('td');
    urlCell.className = 'repo-url-cell';
    const urlLink = document.createElement('a');
    urlLink.href      = repo.url;
    urlLink.textContent = repo.url;
    urlLink.target    = '_blank';
    urlLink.rel       = 'noopener noreferrer';
    urlLink.className = 'repo-url-link';
    urlCell.appendChild(urlLink);
    tr.appendChild(urlCell);

    // ---- Actions cell ----
    const actionsCell = document.createElement('td');
    actionsCell.className = 'repo-actions-cell';

    // Read-mode buttons
    const editBtn = document.createElement('button');
    editBtn.type      = 'button';
    editBtn.className = 'btn btn-secondary btn-sm';
    editBtn.textContent = 'Edit';

    const deleteBtn = document.createElement('button');
    deleteBtn.type      = 'button';
    deleteBtn.className = 'btn btn-danger btn-sm';
    deleteBtn.textContent = 'Delete';

    // Edit-mode buttons (hidden initially)
    const saveBtn = document.createElement('button');
    saveBtn.type      = 'button';
    saveBtn.className = 'btn btn-primary btn-sm';
    saveBtn.textContent = 'Save';
    saveBtn.hidden    = true;

    const cancelEditBtn = document.createElement('button');
    cancelEditBtn.type      = 'button';
    cancelEditBtn.className = 'btn btn-secondary btn-sm';
    cancelEditBtn.textContent = 'Cancel';
    cancelEditBtn.hidden    = true;

    actionsCell.appendChild(editBtn);
    actionsCell.appendChild(deleteBtn);
    actionsCell.appendChild(saveBtn);
    actionsCell.appendChild(cancelEditBtn);
    tr.appendChild(actionsCell);

    // -------------------------------------------------------------------------
    // Behaviour
    // -------------------------------------------------------------------------

    // Enter edit mode
    editBtn.addEventListener('click', () => {
        nameLink.hidden  = true;
        nameInput.hidden = false;
        nameInput.value  = repo.name;
        nameInput.focus();
        nameInput.select();

        editBtn.hidden   = true;
        deleteBtn.hidden = true;
        saveBtn.hidden   = false;
        cancelEditBtn.hidden = false;
    });

    // Cancel edit mode
    cancelEditBtn.addEventListener('click', () => {
        nameInput.hidden = true;
        nameLink.hidden  = false;

        editBtn.hidden   = false;
        deleteBtn.hidden = false;
        saveBtn.hidden   = true;
        cancelEditBtn.hidden = true;
    });

    // Save name change
    saveBtn.addEventListener('click', async () => {
        const newName = nameInput.value.trim();
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';

        try {
            await api.repositories.update(repo.id, { name: newName });
            repo.name = newName;
            nameLink.textContent = newName || '—';
            showToast(`Repository "${repo.id}" updated.`, 'success');

            // Return to read mode
            nameInput.hidden = true;
            nameLink.hidden  = false;
            editBtn.hidden   = false;
            deleteBtn.hidden = false;
            saveBtn.hidden   = true;
            cancelEditBtn.hidden = true;
        } catch (err) {
            showToast(err.message || 'Failed to update repository.', 'error');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save';
        }
    });

    // Allow pressing Enter in the name input to save
    nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveBtn.click();
        } else if (e.key === 'Escape') {
            cancelEditBtn.click();
        }
    });

    // Delete with confirmation
    deleteBtn.addEventListener('click', async () => {
        try {
            await showConfirm(
                'Delete Repository',
                `Delete "${repo.name || repo.id}"? This repository will be removed from all projects. This action cannot be undone.`,
            );
        } catch {
            // User cancelled — do nothing.
            return;
        }

        deleteBtn.disabled = true;
        deleteBtn.textContent = 'Deleting…';

        try {
            await api.repositories.delete(repo.id);
            showToast(`Repository "${repo.name || repo.id}" deleted.`, 'success');
            onDeleted();
        } catch (err) {
            showToast(err.message || 'Failed to delete repository.', 'error');
            deleteBtn.disabled = false;
            deleteBtn.textContent = 'Delete';
        }
    });

    return tr;
}

// ---------------------------------------------------------------------------
// Repository list rendering
// ---------------------------------------------------------------------------

/**
 * Render a loading indicator into `tableContainer`.
 *
 * @param {HTMLElement} tableContainer
 */
function showLoading(tableContainer) {
    tableContainer.innerHTML = `
        <div class="loading-indicator" aria-live="polite" aria-label="Loading repositories…">
            <span class="spinner" aria-hidden="true"></span>
            <span>Loading repositories…</span>
        </div>
    `;
}

/**
 * Fetch all repositories and render them into `tableContainer`.
 * On success renders a `<table>`; on failure shows an error state.
 *
 * @param {HTMLElement} tableContainer - Element to render the table into.
 */
async function renderRepoTable(tableContainer) {
    showLoading(tableContainer);

    let repos;
    try {
        repos = await api.repositories.list();
    } catch (err) {
        clearElement(tableContainer);
        const errMsg = document.createElement('div');
        errMsg.className = 'empty-state error-state';
        errMsg.textContent = `Failed to load repositories: ${err.message}`;
        tableContainer.appendChild(errMsg);
        showToast(err.message || 'Failed to load repositories.', 'error');
        return;
    }

    clearElement(tableContainer);

    if (!Array.isArray(repos) || repos.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No repositories registered. Use the "Add Repository" button to add one.';
        tableContainer.appendChild(empty);
        return;
    }

    const table = document.createElement('table');
    table.className = 'data-table repositories-table';
    table.appendChild(buildTableHead());

    const tbody = document.createElement('tbody');
    repos.forEach((raw) => {
        const repo = normaliseRepo(raw);
        tbody.appendChild(buildRepoRow(repo, () => renderRepoTable(tableContainer)));
    });

    table.appendChild(tbody);
    tableContainer.appendChild(table);
}

// ---------------------------------------------------------------------------
// Add Repository form
// ---------------------------------------------------------------------------

/**
 * Build and return the "Add Repository" inline form section.
 * On success, `onSuccess` is called so the caller can re-render the table.
 *
 * @param {function(): void} onSuccess
 * @returns {HTMLElement}
 */
function buildAddRepoSection(onSuccess) {
    const section = document.createElement('section');
    section.className = 'add-repo-section';

    // Toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn btn-primary';
    toggleBtn.textContent = '+ Add Repository';
    section.appendChild(toggleBtn);

    // Collapsible form wrapper (hidden by default)
    const formWrapper = document.createElement('div');
    formWrapper.className = 'add-repo-form-wrapper';
    formWrapper.hidden = true;
    section.appendChild(formWrapper);

    // Form
    const form = document.createElement('form');
    form.className = 'add-repo-form card';
    form.noValidate = true;

    const formTitle = document.createElement('h3');
    formTitle.className = 'form-section-title';
    formTitle.textContent = 'New Repository';
    form.appendChild(formTitle);

    const urlField = createFormField('URL', 'url', 'url', {
        required: true,
        placeholder: 'https://github.com/org/repo.git',
    });
    form.appendChild(urlField);

    const nameField = createFormField('Name', 'text', 'name', {
        placeholder: 'Optional — human-readable name.',
    });
    form.appendChild(nameField);

    const idField = createFormField('ID', 'text', 'id', {
        placeholder: 'Optional — auto-inferred from URL when left blank.',
        hint: 'Leave blank to auto-infer from the repository URL.',
    });
    form.appendChild(idField);

    // Action row
    const actions = document.createElement('div');
    actions.className = 'form-actions';

    const submitBtn = document.createElement('button');
    submitBtn.type      = 'submit';
    submitBtn.className = 'btn btn-primary';
    submitBtn.textContent = 'Add';

    const cancelBtn = document.createElement('button');
    cancelBtn.type      = 'button';
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = 'Cancel';

    actions.appendChild(submitBtn);
    actions.appendChild(cancelBtn);
    form.appendChild(actions);

    formWrapper.appendChild(form);

    // -------------------------------------------------------------------------
    // Behaviour
    // -------------------------------------------------------------------------

    toggleBtn.addEventListener('click', () => {
        formWrapper.hidden = !formWrapper.hidden;
        if (!formWrapper.hidden) {
            const urlInput = form.querySelector('[name="url"]');
            if (urlInput) urlInput.focus();
        }
    });

    cancelBtn.addEventListener('click', () => {
        form.reset();
        formWrapper.hidden = true;
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!validateRequired(form, ['url'])) return;

        const url  = form.querySelector('[name="url"]').value.trim();
        const name = form.querySelector('[name="name"]').value.trim();
        const id   = form.querySelector('[name="id"]').value.trim();

        submitBtn.disabled = true;
        submitBtn.textContent = 'Adding…';

        try {
            await api.repositories.create({
                url,
                name: name || undefined,
                id:   id   || undefined,
            });
            showToast('Repository added successfully.', 'success');
            form.reset();
            formWrapper.hidden = true;
            onSuccess();
        } catch (err) {
            showToast(err.message || 'Failed to add repository.', 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Add';
        }
    });

    return section;
}

// ---------------------------------------------------------------------------
// Public export — view function
// ---------------------------------------------------------------------------

/**
 * Render the Repositories view.
 *
 * @param {HTMLElement} container - The `#app` root element.
 * @param {Object}      _params   - Route params (unused).
 */
export async function renderRepositories(container, _params) {
    // -----------------------------------------------------------------------
    // Page header
    // -----------------------------------------------------------------------
    const header = document.createElement('div');
    header.className = 'page-header';

    const title = document.createElement('h1');
    title.textContent = 'Repositories';
    header.appendChild(title);

    container.appendChild(header);

    // -----------------------------------------------------------------------
    // Table container
    // -----------------------------------------------------------------------
    const tableContainer = document.createElement('div');
    tableContainer.className = 'repositories-table-container';
    container.appendChild(tableContainer);

    // -----------------------------------------------------------------------
    // Add Repository section
    // -----------------------------------------------------------------------
    const addSection = buildAddRepoSection(() => {
        renderRepoTable(tableContainer);
    });
    container.appendChild(addSection);

    // -----------------------------------------------------------------------
    // Initial load
    // -----------------------------------------------------------------------
    await renderRepoTable(tableContainer);
}
