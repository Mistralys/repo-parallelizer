/**
 * Repositories View — Repo Parallelizer GUI.
 *
 * Renders a full CRUD management page for all registered repositories:
 *   - Table listing all repositories (ID, Name, URL).
 *   - "+ Add Repository" button opening the create/edit modal in create mode.
 *   - Edit button per row opening the same modal in edit mode.
 *   - Delete per row with a confirmation dialog.
 *
 * @param {HTMLElement} container - The `#app` root element supplied by the router.
 * @param {Object}      _params   - Route params (none for this route).
 */

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { showConfirm } from '../components/confirm-dialog.js';
import { showRepositoryModal } from '../components/repository-modal.js';
import { normaliseRepo } from '../utils/normalise.js';
import { clearElement, buildCredentialBadge } from '../utils/dom.js';
import { APP_NAME_SHORT } from '../utils/constants.js';

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

    ['ID', 'Name', 'URL', 'Credential', 'Actions'].forEach((label) => {
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
 * link navigating to `#/repositories/:id`.  Clicking Edit opens the
 * create/edit modal in edit mode, pre-filled with the row's current data.
 * Clicking Delete shows a confirmation dialog and calls the API on confirm.
 *
 * @param {{ id: string, name: string, url: string }} repo
 * @param {function(): void} onChanged - Callback to refresh the table after a change (edit save or delete).
 * @returns {HTMLTableRowElement}
 */
function buildRepoRow(repo, onChanged) {
    const tr = document.createElement('tr');
    tr.dataset.repoId = repo.id;

    // ---- ID cell (read-only) ----
    const idCell = document.createElement('td');
    idCell.className = 'repo-id-cell text-muted';
    idCell.textContent = repo.id;
    tr.appendChild(idCell);

    // ---- Name cell ----
    const nameCell = document.createElement('td');
    nameCell.className = 'repo-name-cell';

    const nameLink = document.createElement('a');
    nameLink.className = 'repo-name-display repo-name-link';
    nameLink.href      = `#/repositories/${encodeURIComponent(repo.id)}`;
    nameLink.textContent = repo.name || '—';
    nameCell.appendChild(nameLink);

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

    // ---- Credential status cell ----
    const credentialCell = document.createElement('td');
    credentialCell.className = 'repo-credential-cell';
    credentialCell.appendChild(buildCredentialBadge(repo.credentialId));
    tr.appendChild(credentialCell);

    // ---- Actions cell ----
    const actionsCell = document.createElement('td');
    actionsCell.className = 'repo-actions-cell';

    const editBtn = document.createElement('button');
    editBtn.type      = 'button';
    editBtn.className = 'btn btn-secondary btn-sm';
    editBtn.textContent = 'Edit';

    const deleteBtn = document.createElement('button');
    deleteBtn.type      = 'button';
    deleteBtn.className = 'btn btn-danger btn-sm';
    deleteBtn.textContent = 'Delete';

    actionsCell.appendChild(editBtn);
    actionsCell.appendChild(deleteBtn);
    tr.appendChild(actionsCell);

    // -------------------------------------------------------------------------
    // Behaviour
    // -------------------------------------------------------------------------

    // Edit via modal
    editBtn.addEventListener('click', async () => {
        try {
            await showRepositoryModal({ mode: 'edit', repo });
        } catch {
            // User cancelled — do nothing.
            return;
        }
        onChanged();
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
            onChanged();
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
// Add Repository button
// ---------------------------------------------------------------------------

/**
 * Build the "+ Add Repository" button, opening the create/edit modal in
 * create mode. On success, `onSuccess` is called so the caller can
 * re-render the table.
 *
 * @param {function(): void} onSuccess
 * @returns {HTMLElement}
 */
function buildAddRepoButton(onSuccess) {
    const addBtn = document.createElement('button');
    addBtn.type      = 'button';
    addBtn.className = 'btn btn-primary';
    addBtn.textContent = '+ Add Repository';

    addBtn.addEventListener('click', async () => {
        try {
            await showRepositoryModal({ mode: 'create' });
        } catch {
            // User cancelled — do nothing.
            return;
        }
        onSuccess();
    });

    return addBtn;
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
    document.title = 'Repositories - ' + APP_NAME_SHORT;

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
    // Add Repository button
    // -----------------------------------------------------------------------
    const addBtn = buildAddRepoButton(() => {
        renderRepoTable(tableContainer);
    });
    container.appendChild(addBtn);

    // -----------------------------------------------------------------------
    // Initial load
    // -----------------------------------------------------------------------
    await renderRepoTable(tableContainer);
}
