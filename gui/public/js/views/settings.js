/**
 * Settings View — Repo Parallelizer GUI.
 *
 * Renders the credentials management page:
 *   - Table listing all configured per-host git credentials (host + masked token).
 *   - Delete per row with a confirmation dialog.
 *   - "Add / Update Credential" inline form (host + token).
 *
 * This view has no side-effects (no polling), so it returns no cleanup function.
 *
 * @param {HTMLElement} container - The `#app` root element supplied by the router.
 * @param {Object}      _params   - Route params (none for this route).
 */

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { showConfirm } from '../components/confirm-dialog.js';
import { createFormField, validateRequired } from '../components/form-helpers.js';

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

/**
 * Build the `<thead>` for the credentials table.
 *
 * @returns {HTMLElement}
 */
function buildTableHead() {
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');

    ['Host', 'Token', 'Actions'].forEach((label) => {
        const th = document.createElement('th');
        th.textContent = label;
        tr.appendChild(th);
    });

    thead.appendChild(tr);
    return thead;
}

/**
 * Build a single `<tr>` for one credential entry.
 *
 * @param {string}            host       - The hostname key.
 * @param {string}            maskedToken - The masked token string (e.g. `****abc1`).
 * @param {function(): void}  onDeleted  - Callback to refresh the table after deletion.
 * @returns {HTMLTableRowElement}
 */
function buildCredentialRow(host, maskedToken, onDeleted) {
    const tr = document.createElement('tr');
    tr.dataset.credHost = host;

    // ---- Host cell (read-only) ----
    const hostCell = document.createElement('td');
    hostCell.className = 'cred-host-cell';
    hostCell.textContent = host;
    tr.appendChild(hostCell);

    // ---- Masked token cell (read-only) ----
    const tokenCell = document.createElement('td');
    tokenCell.className = 'cred-token-cell text-muted';
    tokenCell.textContent = maskedToken;
    tr.appendChild(tokenCell);

    // ---- Actions cell ----
    const actionsCell = document.createElement('td');
    actionsCell.className = 'cred-actions-cell';

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-danger btn-sm';
    deleteBtn.textContent = 'Delete';

    actionsCell.appendChild(deleteBtn);
    tr.appendChild(actionsCell);

    // ---- Behaviour ----

    deleteBtn.addEventListener('click', async () => {
        try {
            await showConfirm(
                'Delete Credential',
                `Remove the credential for "${host}"? This action cannot be undone.`,
            );
        } catch {
            // User cancelled — do nothing.
            return;
        }

        deleteBtn.disabled = true;
        deleteBtn.textContent = 'Deleting…';

        try {
            await api.config.credentials.delete(host);
            showToast(`Credential for "${host}" deleted.`, 'success');
            onDeleted();
        } catch (err) {
            showToast(err.message || 'Failed to delete credential.', 'error');
            deleteBtn.disabled = false;
            deleteBtn.textContent = 'Delete';
        }
    });

    return tr;
}

// ---------------------------------------------------------------------------
// Credentials table rendering
// ---------------------------------------------------------------------------

/**
 * Render a loading indicator into `tableContainer`.
 *
 * @param {HTMLElement} tableContainer
 */
function showLoading(tableContainer) {
    tableContainer.innerHTML = `
        <div class="loading-indicator" aria-live="polite" aria-label="Loading credentials…">
            <span class="spinner" aria-hidden="true"></span>
            <span>Loading credentials…</span>
        </div>
    `;
}

/**
 * Fetch all credentials and render them into `tableContainer`.
 *
 * @param {HTMLElement} tableContainer
 */
async function renderCredentialsTable(tableContainer) {
    showLoading(tableContainer);

    let credentials;
    try {
        credentials = await api.config.credentials.list();
    } catch (err) {
        tableContainer.innerHTML = '';
        const errorP = document.createElement('p');
        errorP.className = 'error-message';
        errorP.setAttribute('role', 'alert');
        errorP.textContent = `Failed to load credentials: ${err.message || 'Unknown error'}`;
        tableContainer.appendChild(errorP);
        return;
    }

    const entries = Object.entries(credentials || {});

    if (entries.length === 0) {
        tableContainer.innerHTML = `
            <p class="empty-state">No credentials configured. Use the form below to add one.</p>
        `;
        return;
    }

    const table = document.createElement('table');
    table.className = 'credentials-table';
    table.setAttribute('role', 'table');
    table.setAttribute('aria-label', 'Git credentials');

    table.appendChild(buildTableHead());

    const tbody = document.createElement('tbody');

    for (const [host, maskedToken] of entries) {
        tbody.appendChild(buildCredentialRow(host, maskedToken, () => {
            renderCredentialsTable(tableContainer);
        }));
    }

    table.appendChild(tbody);
    tableContainer.innerHTML = '';
    tableContainer.appendChild(table);
}

// ---------------------------------------------------------------------------
// Add / Update credential form
// ---------------------------------------------------------------------------

/**
 * Build the "Add / Update Credential" section with a toggle button and inline form.
 *
 * @param {HTMLElement} tableContainer - Used to trigger a refresh after a successful save.
 * @returns {HTMLElement} The wrapper element containing the toggle button and form.
 */
function buildAddCredentialForm(tableContainer) {
    const section = document.createElement('div');
    section.className = 'add-credential-section';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn btn-primary';
    toggleBtn.textContent = 'Add / Update Credential';

    const formWrapper = document.createElement('div');
    formWrapper.className = 'form-wrapper';
    formWrapper.hidden = true;

    const form = document.createElement('form');
    form.noValidate = true;

    form.appendChild(createFormField('Host', 'text', 'host', {
        placeholder: 'e.g. github.com',
        required: true,
    }));

    form.appendChild(createFormField('Token', 'password', 'token', {
        placeholder: 'Personal access token',
        required: true,
    }));

    const actions = document.createElement('div');
    actions.className = 'form-actions';

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'btn btn-primary';
    submitBtn.textContent = 'Save';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = 'Cancel';

    actions.appendChild(submitBtn);
    actions.appendChild(cancelBtn);
    form.appendChild(actions);
    formWrapper.appendChild(form);

    section.appendChild(toggleBtn);
    section.appendChild(formWrapper);

    // ---- Behaviour ----

    toggleBtn.addEventListener('click', () => {
        formWrapper.hidden = !formWrapper.hidden;
        if (!formWrapper.hidden) {
            const hostInput = form.querySelector('[name="host"]');
            if (hostInput) hostInput.focus();
        }
    });

    cancelBtn.addEventListener('click', () => {
        form.reset();
        formWrapper.hidden = true;
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!validateRequired(form, ['host', 'token'])) return;

        const host  = form.querySelector('[name="host"]').value.trim();
        const token = form.querySelector('[name="token"]').value.trim();

        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving…';

        try {
            await api.config.credentials.set({ host, token });
            showToast(`Credential for "${host}" saved.`, 'success');
            form.reset();
            formWrapper.hidden = true;
            renderCredentialsTable(tableContainer);
        } catch (err) {
            showToast(err.message || 'Failed to save credential.', 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save';
        }
    });

    return section;
}

// ---------------------------------------------------------------------------
// View entry point
// ---------------------------------------------------------------------------

/**
 * Render the Settings view into `container`.
 *
 * No cleanup function is returned because this view has no side-effects:
 * it does not start polling, install global event listeners, or hold any
 * external resources. The router does not need to call a teardown. This
 * is consistent with the `repositories` view, which follows the same pattern.
 *
 * @param {HTMLElement} container - The `#app` root element supplied by the router.
 * @param {Object}      _params   - Route params (none for this route).
 * @returns {void}
 */
export function renderSettings(container, _params) {
    container.innerHTML = '';

    // Page heading
    const heading = document.createElement('h1');
    heading.textContent = 'Settings';
    container.appendChild(heading);

    // Credentials section
    const credHeading = document.createElement('h2');
    credHeading.textContent = 'Git Credentials';
    container.appendChild(credHeading);

    const credDescription = document.createElement('p');
    credDescription.textContent =
        'Manage per-host personal access tokens used for authenticating with private repositories. Tokens are stored masked — only the last 4 characters are visible.';
    container.appendChild(credDescription);

    const tableContainer = document.createElement('div');
    tableContainer.className = 'credentials-table-container';
    container.appendChild(tableContainer);

    container.appendChild(buildAddCredentialForm(tableContainer));

    // Initial data load
    renderCredentialsTable(tableContainer);
}
