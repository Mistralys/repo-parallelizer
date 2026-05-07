/**
 * Settings View — Repo Parallelizer GUI.
 *
 * Renders four settings sections:
 *   1. **Git Credentials** — table of per-host PATs with add/delete controls.
 *   2. **Repositories Refresh Delay** — number input for `gitPollingIntervalSeconds`
 *      with client-side validation (min 10) and save/feedback.
 *   3. **Webserver URL** — text input for the base URL of the local webserver
 *      that serves the workspace repositories, enabling the "Browse" button in
 *      the workspace-detail view.
 *   4. **Notes Display** — number inputs for card height (px) and column count
 *      with client-side range validation and save/feedback.
 *
 * This view has no side-effects (no polling), so it returns no cleanup function.
 *
 * @param {HTMLElement} container - The `#app` root element supplied by the router.
 * @param {Object}      _params   - Route params (none for this route).
 */

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { showConfirm } from '../components/confirm-dialog.js';
import { APP_NAME_SHORT } from '../utils/constants.js';
import { createFormField, validateRequired } from '../components/form-helpers.js';
import { clearElement } from '../utils/dom.js';

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
        clearElement(tableContainer);
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
    clearElement(tableContainer);
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
// Repositories Refresh Delay section
// ---------------------------------------------------------------------------

/**
 * Build the "Repositories Refresh Delay" section.
 *
 * Fetches the current server-side `gitPollingIntervalSeconds` value on mount,
 * populates a number input, and exposes a `save()` function for the shared
 * settings footer button.
 *
 * @returns {{ element: HTMLElement, save: () => Promise<boolean> }}
 */
function buildRefreshDelaySection() {
    const section = document.createElement('section');
    section.className = 'settings-section refresh-delay-section';

    const heading = document.createElement('h2');
    heading.textContent = 'Repositories Refresh Delay';
    section.appendChild(heading);

    const description = document.createElement('p');
    description.textContent =
        'How often (in seconds) the server polls remote repositories for new commits. ' +
        'Changes take effect immediately — the current polling cycle is restarted with the new interval. ' +
        'Minimum value is 10 seconds.';
    section.appendChild(description);

    // ---- Input row ----
    const inputRow = document.createElement('div');
    inputRow.className = 'refresh-delay-input-row';

    const label = document.createElement('label');
    label.htmlFor = 'refresh-delay-input';
    label.textContent = 'Interval';
    label.className = 'refresh-delay-label';

    const input = document.createElement('input');
    input.type = 'number';
    input.id = 'refresh-delay-input';
    input.name = 'refreshDelay';
    input.className = 'form-input refresh-delay-input';
    input.min = '10';
    // Maximum matches server-side MAX_POLLING_INTERVAL_SECONDS in src/config/config.constants.ts
    input.max = '86400';
    input.step = '1';
    input.placeholder = '30';
    input.setAttribute('aria-label', 'Polling interval in seconds');

    const unitLabel = document.createElement('span');
    unitLabel.className = 'refresh-delay-unit';
    unitLabel.textContent = 'seconds';

    inputRow.appendChild(label);
    inputRow.appendChild(input);
    inputRow.appendChild(unitLabel);
    section.appendChild(inputRow);

    // ---- Inline error message ----
    const errorMsg = document.createElement('p');
    errorMsg.className = 'error-message';
    errorMsg.setAttribute('role', 'alert');
    errorMsg.hidden = true;
    section.appendChild(errorMsg);

    // ---- Populate current value on mount ----
    (async () => {
        try {
            const cfg = await api.config.polling.get();
            if (cfg && typeof cfg.gitPollingIntervalSeconds === 'number') {
                input.value = String(cfg.gitPollingIntervalSeconds);
            }
        } catch {
            // Non-fatal — leave the placeholder in place.
        }
    })();

    // ---- Save function (called by the shared footer button) ----
    async function save() {
        const raw   = input.value.trim();
        const value = Number(raw);

        if (!raw || !Number.isFinite(value) || !Number.isInteger(value) || value < 10) {
            errorMsg.textContent = 'Please enter a whole number of 10 or more.';
            errorMsg.hidden = false;
            input.focus();
            return false;
        }

        if (value > 86400) {
            errorMsg.textContent = 'Please enter a value of 86400 or less (24 hours maximum).';
            errorMsg.hidden = false;
            input.focus();
            return false;
        }

        errorMsg.hidden = true;

        try {
            await api.config.polling.set(value);
            return true;
        } catch (err) {
            showToast(err.message || 'Failed to save refresh delay.', 'error');
            return false;
        }
    }

    return { element: section, save };
}

// ---------------------------------------------------------------------------
// Webserver URL section
// ---------------------------------------------------------------------------

/**
 * Build the "Webserver URL" section.
 *
 * Fetches the current server-side `webserverUrl` value on mount, populates a
 * text input, and exposes a `save()` function for the shared settings footer
 * button.
 *
 * @returns {{ element: HTMLElement, save: () => Promise<boolean> }}
 */
function buildWebserverUrlSection() {
    const section = document.createElement('section');
    section.className = 'settings-section webserver-url-section';

    const heading = document.createElement('h2');
    heading.textContent = 'Webserver URL';
    section.appendChild(heading);

    const description = document.createElement('p');
    description.textContent =
        'Base URL of the local webserver serving your workspace repositories. ' +
        'When set, a "Browse" button appears in the workspace-detail view for each ' +
        'repository. The URL should point to the root of your projects folder ' +
        '(e.g. http://localhost:8080). Leave empty to hide the Browse button.';
    section.appendChild(description);

    // ---- Input row ----
    const inputRow = document.createElement('div');
    inputRow.className = 'webserver-url-input-row';

    const label = document.createElement('label');
    label.htmlFor = 'webserver-url-input';
    label.textContent = 'URL';
    label.className = 'webserver-url-label';

    const input = document.createElement('input');
    input.type = 'url';
    input.id = 'webserver-url-input';
    input.name = 'webserverUrl';
    input.className = 'form-input webserver-url-input';
    input.placeholder = 'http://localhost:8080';
    input.setAttribute('aria-label', 'Webserver base URL');

    inputRow.appendChild(label);
    inputRow.appendChild(input);
    section.appendChild(inputRow);

    // ---- Inline error message ----
    const errorMsg = document.createElement('p');
    errorMsg.className = 'error-message';
    errorMsg.setAttribute('role', 'alert');
    errorMsg.hidden = true;
    section.appendChild(errorMsg);

    // ---- Populate current value on mount ----
    (async () => {
        try {
            const cfg = await api.config.webserverUrl.get();
            if (cfg && typeof cfg.webserverUrl === 'string') {
                input.value = cfg.webserverUrl;
            }
        } catch {
            // Non-fatal — leave the placeholder in place.
        }
    })();

    // ---- Save function (called by the shared footer button) ----
    async function save() {
        errorMsg.hidden = true;

        try {
            await api.config.webserverUrl.set(input.value.trim());
            return true;
        } catch (err) {
            showToast(err.message || 'Failed to save webserver URL.', 'error');
            return false;
        }
    }

    return { element: section, save };
}

// ---------------------------------------------------------------------------
// Notes Display section
// ---------------------------------------------------------------------------

/**
 * Build the "Notes Display" section.
 *
 * Fetches the current `notesCardHeight` and `notesColumns` values from
 * GET /api/config/notes-display on mount, populates number inputs, and
 * exposes a `save()` function for the shared settings footer button.
 *
 * Card height range : 120–800 px (step 10, default 220).
 * Columns range     : 1–6 (step 1, default 2).
 *
 * @returns {{ element: HTMLElement, save: () => Promise<boolean> }}
 */
function buildNotesDisplaySection() {
    const section = document.createElement('section');
    section.className = 'settings-section notes-display-section';

    const heading = document.createElement('h2');
    heading.textContent = 'Notes Display';
    section.appendChild(heading);

    const description = document.createElement('p');
    description.textContent =
        'Control how notes are presented in the Notes view. ' +
        'Card Height sets the pixel height of each note card; ' +
        'Columns sets how many cards appear side-by-side in the grid.';
    section.appendChild(description);

    // ---- Card Height input row ----
    const cardHeightRow = document.createElement('div');
    cardHeightRow.className = 'notes-display-input-row';

    const cardHeightLabel = document.createElement('label');
    cardHeightLabel.htmlFor = 'notes-card-height-input';
    cardHeightLabel.textContent = 'Card Height';
    cardHeightLabel.className = 'notes-display-label';

    const cardHeightInput = document.createElement('input');
    cardHeightInput.type = 'number';
    cardHeightInput.id = 'notes-card-height-input';
    cardHeightInput.name = 'notesCardHeight';
    cardHeightInput.className = 'form-input notes-display-input';
    cardHeightInput.min = '120';
    cardHeightInput.max = '800';
    cardHeightInput.step = '10';
    cardHeightInput.placeholder = '220';
    cardHeightInput.setAttribute('aria-label', 'Note card height in pixels');

    const cardHeightUnit = document.createElement('span');
    cardHeightUnit.className = 'notes-display-unit';
    cardHeightUnit.textContent = 'px';

    cardHeightRow.appendChild(cardHeightLabel);
    cardHeightRow.appendChild(cardHeightInput);
    cardHeightRow.appendChild(cardHeightUnit);
    section.appendChild(cardHeightRow);

    // ---- Card Height inline error ----
    const cardHeightError = document.createElement('p');
    cardHeightError.className = 'error-message';
    cardHeightError.setAttribute('role', 'alert');
    cardHeightError.hidden = true;
    section.appendChild(cardHeightError);

    // ---- Columns input row ----
    const columnsRow = document.createElement('div');
    columnsRow.className = 'notes-display-input-row';

    const columnsLabel = document.createElement('label');
    columnsLabel.htmlFor = 'notes-columns-input';
    columnsLabel.textContent = 'Columns';
    columnsLabel.className = 'notes-display-label';

    const columnsInput = document.createElement('input');
    columnsInput.type = 'number';
    columnsInput.id = 'notes-columns-input';
    columnsInput.name = 'notesColumns';
    columnsInput.className = 'form-input notes-display-input';
    columnsInput.min = '1';
    columnsInput.max = '6';
    columnsInput.step = '1';
    columnsInput.placeholder = '2';
    columnsInput.setAttribute('aria-label', 'Number of columns in the notes grid');

    columnsRow.appendChild(columnsLabel);
    columnsRow.appendChild(columnsInput);
    section.appendChild(columnsRow);

    // ---- Columns inline error ----
    const columnsError = document.createElement('p');
    columnsError.className = 'error-message';
    columnsError.setAttribute('role', 'alert');
    columnsError.hidden = true;
    section.appendChild(columnsError);

    // ---- Populate current values on mount ----
    (async () => {
        try {
            const cfg = await api.config.notesDisplay.get();
            if (cfg && typeof cfg.notesCardHeight === 'number') {
                cardHeightInput.value = String(cfg.notesCardHeight);
            }
            if (cfg && typeof cfg.notesColumns === 'number') {
                columnsInput.value = String(cfg.notesColumns);
            }
        } catch {
            // Non-fatal — leave the placeholders in place.
        }
    })();

    // ---- Save function (called by the shared footer button) ----
    async function save() {
        let valid = true;

        // Validate card height
        const rawHeight  = cardHeightInput.value.trim();
        const heightVal  = Number(rawHeight);

        if (!rawHeight || !Number.isFinite(heightVal) || !Number.isInteger(heightVal) ||
            heightVal < 120 || heightVal > 800) {
            cardHeightError.textContent = 'Please enter a whole number between 120 and 800.';
            cardHeightError.hidden = false;
            valid = false;
        } else {
            cardHeightError.hidden = true;
        }

        // Validate columns
        const rawColumns = columnsInput.value.trim();
        const columnsVal = Number(rawColumns);

        if (!rawColumns || !Number.isFinite(columnsVal) || !Number.isInteger(columnsVal) ||
            columnsVal < 1 || columnsVal > 6) {
            columnsError.textContent = 'Please enter a whole number between 1 and 6.';
            columnsError.hidden = false;
            valid = false;
        } else {
            columnsError.hidden = true;
        }

        if (!valid) {
            // Focus the first invalid field
            if (!cardHeightError.hidden) {
                cardHeightInput.focus();
            } else {
                columnsInput.focus();
            }
            return false;
        }

        try {
            await api.config.notesDisplay.set({
                notesCardHeight: heightVal,
                notesColumns: columnsVal,
            });
            return true;
        } catch (err) {
            showToast(err.message || 'Failed to save notes display settings.', 'error');
            return false;
        }
    }

    return { element: section, save };
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
    document.title = 'Settings - ' + APP_NAME_SHORT;
    clearElement(container);

    // Page heading
    const heading = document.createElement('h1');
    heading.textContent = 'Settings';
    container.appendChild(heading);

    // Credentials section
    const credSection = document.createElement('section');
    credSection.className = 'settings-section';

    const credHeading = document.createElement('h2');
    credHeading.textContent = 'Git Credentials';
    credSection.appendChild(credHeading);

    const credDescription = document.createElement('p');
    credDescription.textContent =
        'Manage per-host personal access tokens used for authenticating with private repositories. Tokens are stored masked — only the last 4 characters are visible.';
    credSection.appendChild(credDescription);

    const tableContainer = document.createElement('div');
    tableContainer.className = 'credentials-table-container';
    credSection.appendChild(tableContainer);

    credSection.appendChild(buildAddCredentialForm(tableContainer));
    container.appendChild(credSection);

    // Initial data load
    renderCredentialsTable(tableContainer);

    // ---- Remaining sections ----
    const refreshDelay = buildRefreshDelaySection();
    container.appendChild(refreshDelay.element);

    const webserverUrl = buildWebserverUrlSection();
    container.appendChild(webserverUrl.element);

    const notesDisplay = buildNotesDisplaySection();
    container.appendChild(notesDisplay.element);

    // ---- Form footer ----
    const footer = document.createElement('footer');
    footer.className = 'settings-footer';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = 'Save Settings';
    footer.appendChild(saveBtn);
    container.appendChild(footer);

    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';

        try {
            const results = await Promise.all([
                refreshDelay.save(),
                webserverUrl.save(),
                notesDisplay.save(),
            ]);

            if (results.every(Boolean)) {
                showToast('Settings saved.', 'success');
            }
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Settings';
        }
    });
}
