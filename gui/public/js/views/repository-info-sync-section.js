/**
 * Repository Info-Sync Section — Repo Parallelizer GUI.
 *
 * Renders the "Workspace info sync" section on the repository detail page:
 * the enable/disable toggle (does not save until Save is pressed), a status
 * block, the pending-files list, a health alert with fix actions, and the
 * Refresh / Import… / Commit & Push buttons.
 *
 * This module owns the full interaction and accessibility contract described
 * in the plan's step 16 "GUI Interaction & Accessibility Spec":
 *   a) toggle/save behaviour (no implicit save, busy state, failure revert);
 *   b) the button-enablement matrix per state, plus a global "any request in
 *      flight" override;
 *   c) loading/error/success feedback via `toast.js` and a single
 *      `role="status"`/`aria-live="polite"` region for the state block;
 *   d) the `conflict` auto-open-once-per-page-visit rule and focus
 *      management after every modal closes;
 *   e) post-action refresh (import notifies the caller; Save/Refresh/
 *      Commit & Push only re-fetch this section's own status);
 *   f) the accessibility floor for the new controls (native elements, no
 *      colour-only state, fieldset/legend grouping is left to the modals
 *      themselves — see `repository-info-import-modal.js`).
 *
 * The whole section is rebuilt on every state change rather than patched
 * in place (the state space is small and the DOM is cheap to recreate).
 * `safeRender()` is the one entry point every handler uses for that
 * rebuild: it additionally restores focus to the section heading when the
 * element that held focus before the rebuild no longer exists afterwards —
 * this is what satisfies the "focus moves to the section heading when the
 * opener was replaced" rule in step 16(d) without needing a special case for
 * every action that can destroy the currently-focused control.
 *
 * @module views/repository-info-sync-section
 */

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { showConfirm } from '../components/confirm-dialog.js';
import { buildHealthAlert } from '../components/health-alert.js';
import { showRepositoryInfoImportModal } from '../components/repository-info-import-modal.js';
import { showInfoCommitDialog } from '../components/info-commit-dialog.js';
import { clearElement } from '../utils/dom.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** State labels (plan step 16). */
const STATE_LABELS = {
    'in-sync':                 'Up to date',
    'write-required':          'Will be written on next sync',
    'incoming':                'Import available',
    'conflict':                'Conflict',
    'disabled':                'Off',
    'main-folder-unavailable': 'Main folder unavailable',
    'invalid-file':            'Invalid info file',
    'id-mismatch':             'Id mismatch',
    'unsupported-schema':      'Unsupported file version',
};

/**
 * Repository IDs whose `conflict` state has already auto-opened the import
 * modal during this page visit. Deliberately module-level (not per-render,
 * not per-instance) so a re-render — after `onRepositoryChanged`, Refresh,
 * Save, Commit & Push, or navigating away and back without a page reload —
 * never reopens the modal a second time for the same repository, and a
 * cancelled auto-open does not reopen either (plan step 16(d)).
 *
 * @type {Set<string>}
 */
const autoOpenedConflicts = new Set();

// ---------------------------------------------------------------------------
// Button-enablement matrix (plan step 16(b))
// ---------------------------------------------------------------------------

/**
 * Base enablement entry per state, before the "a request is in flight"
 * override is applied. `hidden` buttons are never shown regardless of busy
 * state; everything else becomes disabled while busy (see
 * `computeButtonMatrix`).
 */
const BASE_BUTTON_MATRIX = {
    'disabled': {
        refresh: { hidden: true },
        import:  { hidden: true },
        commit:  { hidden: true },
    },
    'main-folder-unavailable': {
        refresh: { hidden: true },
        import:  { disabled: true, reason: 'The main folder is unavailable — recreate it first.' },
        commit:  { disabled: true, reason: 'The main folder is unavailable — recreate it first.' },
    },
    'in-sync': {
        refresh: {},
        import:  { disabled: true, reason: 'No import available.' },
        commit:  { disabled: true, reason: 'Nothing to commit.' },
    },
    'write-required': {
        refresh: {},
        import:  { disabled: true, reason: 'No import available.' },
        commit:  {},
    },
    'incoming': {
        refresh: {},
        import:  { primary: true },
        commit:  { disabled: true, reason: 'Resolve the import first.' },
    },
    'conflict': {
        refresh: {},
        import:  { primary: true },
        commit:  { disabled: true, reason: 'Resolve the import first.' },
    },
    'invalid-file': {
        refresh: {},
        import:  { disabled: true, reason: 'No import available.' },
        commit:  { disabled: true, reason: 'Resolve the info file issue first.' },
    },
    'id-mismatch': {
        refresh: {},
        import:  { disabled: true, reason: 'No import available.' },
        commit:  { disabled: true, reason: 'Resolve the info file issue first.' },
    },
    'unsupported-schema': {
        refresh: {},
        import:  { disabled: true, reason: 'No import available.' },
        commit:  { disabled: true, reason: 'Resolve the info file issue first.' },
    },
};

/** Text used for every button's disabled reason while a request is in flight. */
const BUSY_REASON = 'A request for this section is already in progress.';

/**
 * Resolve the per-button `{ hidden?, disabled?, primary?, reason? }` state
 * for the current status and busy flag.
 *
 * `in-sync` with pending changes behaves like `write-required` (Commit &
 * Push becomes available) even though the evaluator only reports
 * `write-required` when a *new* local write is pending — an already-written
 * file with uncommitted changes in the managed clone is still `in-sync` from
 * the hash's point of view.
 *
 * @param {Object} status - `InfoSyncStatus`.
 * @param {boolean} busy - Whether a request for this section is in flight.
 * @returns {{ refresh: Object, import: Object, commit: Object }}
 */
function computeButtonMatrix(status, busy) {
    const hasPending = Array.isArray(status.pendingChanges) && status.pendingChanges.length > 0;
    const effectiveState = (status.state === 'in-sync' && hasPending) ? 'write-required' : status.state;
    const base = BASE_BUTTON_MATRIX[effectiveState] || BASE_BUTTON_MATRIX['invalid-file'];

    const result = {};
    for (const key of ['refresh', 'import', 'commit']) {
        const entry = { ...base[key] };
        if (!entry.hidden && busy) {
            entry.disabled = true;
            entry.reason = BUSY_REASON;
        }
        result[key] = entry;
    }
    return result;
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

/**
 * Build a button plus its paired visually-hidden reason span, used for every
 * action-row/fix-action button that can be disabled with an explanation
 * (plan step 16(b): "title plus visually-hidden text tied via
 * aria-describedby").
 *
 * @param {string} id - Unique `id` for the button; the reason span uses `${id}-reason`.
 * @param {string} label
 * @returns {{ wrap: HTMLElement, btn: HTMLButtonElement, reasonEl: HTMLElement }}
 */
function buildReasonedButton(id, label) {
    const wrap = document.createElement('span');
    wrap.className = 'info-sync-action';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = id;
    btn.className = 'btn btn-secondary';
    btn.textContent = label;

    const reasonEl = document.createElement('span');
    reasonEl.className = 'sr-only';
    reasonEl.id = `${id}-reason`;
    reasonEl.hidden = true;

    wrap.appendChild(btn);
    wrap.appendChild(reasonEl);

    return { wrap, btn, reasonEl };
}

/**
 * Apply a resolved matrix entry (`{ hidden?, disabled?, primary?, reason? }`)
 * to a button built by {@link buildReasonedButton}.
 *
 * @param {{ btn: HTMLButtonElement, reasonEl: HTMLElement }} button
 * @param {{ hidden?: boolean, disabled?: boolean, primary?: boolean, reason?: string }} entry
 */
function applyButtonState({ btn, reasonEl }, entry) {
    btn.hidden = !!entry.hidden;
    btn.disabled = !!entry.disabled;
    btn.classList.toggle('btn-primary', !!entry.primary);
    btn.classList.toggle('btn-secondary', !entry.primary);

    if (entry.disabled && entry.reason) {
        btn.title = entry.reason;
        btn.setAttribute('aria-describedby', reasonEl.id);
        reasonEl.textContent = entry.reason;
        reasonEl.hidden = false;
    } else {
        btn.removeAttribute('title');
        btn.removeAttribute('aria-describedby');
        reasonEl.textContent = '';
        reasonEl.hidden = true;
    }
}

/**
 * Format an ISO timestamp for the status block. Falls back to the raw
 * string when it does not parse (defensive — the server always sends ISO
 * 8601 when present).
 *
 * @param {string} iso
 * @returns {string}
 */
function formatTimestamp(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

// ---------------------------------------------------------------------------
// buildRepositoryInfoSyncSection
// ---------------------------------------------------------------------------

/**
 * Build the "Workspace info sync" section for the repository detail page.
 *
 * @param {{ id: string, name?: string }} repo - Normalised repository (from `normaliseRepo()`).
 * @param {Object} [options]
 * @param {function(Object): void} [options.onRepositoryChanged] - Called with
 *   the freshly fetched repository object after a successful import (the
 *   only action that can change `Name`/`Description`). Not called after
 *   Save, Refresh, Commit & Push or a health-alert fix action — those only
 *   re-fetch this section's own status (plan step 16(e)).
 * @param {function(): void} [options.onConfigureCredential] - Invoked by the
 *   `configure-credential` fix action; the caller scrolls to and focuses the
 *   Credential section of the same page.
 * @returns {{ element: HTMLElement, cleanup: function(): void }}
 */
export function buildRepositoryInfoSyncSection(repo, options = {}) {
    const { onRepositoryChanged, onConfigureCredential } = options;
    const repoId = repo.id;
    const repoName = repo.name || repoId;

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------
    let destroyed = false;
    /** @type {Object|null} Latest `InfoSyncStatus`, `null` until the first load resolves. */
    let status = null;
    /** @type {boolean|null} Pending (unsaved) toggle value; `null` before the first load. */
    let pendingEnabled = null;
    /** Whether a request specific to this section (not a modal's own request) is in flight. */
    let busy = false;
    /** Which busy operation is running, for toggle/Save busy labels — `'enabling' | 'disabling' | null`. */
    let busyKind = null;
    /** Whether a modal opened by this section (import or commit) is currently open. */
    let modalOpen = false;
    /** Inline `role="alert"` message shown for Save/Refresh/recreate-main-folder failures. */
    let inlineError = null;
    /** Message shown instead of the whole section body when the initial load fails. */
    let loadError = null;

    // ------------------------------------------------------------------
    // Skeleton
    // ------------------------------------------------------------------
    const section = document.createElement('section');
    section.className = 'repository-info-sync-section';

    const heading = document.createElement('h2');
    heading.className = 'section-title';
    heading.tabIndex = -1;
    heading.textContent = 'Workspace info sync';
    section.appendChild(heading);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'repository-info-sync-body';
    section.appendChild(bodyEl);

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    /**
     * Re-render `bodyEl` from the current state, then restore focus to the
     * section heading when the previously-focused control no longer exists
     * afterwards (plan step 16(d): "focus moves to the section heading when
     * the opener was replaced").
     */
    function safeRender() {
        if (destroyed) return;
        const hadFocusInSection = section.contains(document.activeElement);
        renderBody();
        if (hadFocusInSection && !section.contains(document.activeElement)) {
            heading.focus();
        }
    }

    function renderBody() {
        clearElement(bodyEl);

        if (loadError) {
            renderLoadError();
            return;
        }
        if (!status) {
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
        p.textContent = 'Loading sync status…';
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
        retryBtn.addEventListener('click', () => {
            loadError = null;
            load();
        });
        wrap.appendChild(retryBtn);

        bodyEl.appendChild(wrap);
    }

    function renderLoaded() {
        if (busy) {
            section.setAttribute('aria-busy', 'true');
        } else {
            section.removeAttribute('aria-busy');
        }

        if (inlineError) {
            const err = document.createElement('p');
            err.className = 'form-error';
            err.setAttribute('role', 'alert');
            err.textContent = inlineError;
            bodyEl.appendChild(err);
        }

        bodyEl.appendChild(buildToggleRow());
        bodyEl.appendChild(buildStatusBlock());

        if (status.pendingChanges && status.pendingChanges.length > 0) {
            bodyEl.appendChild(buildPendingFilesList());
        }

        const healthEl = buildHealthAlert(status.health, {
            title: 'Workspace info sync issues',
            actions: buildHealthActions(),
        });
        if (healthEl) bodyEl.appendChild(healthEl);

        bodyEl.appendChild(buildActionRow());
    }

    // ------------------------------------------------------------------
    // Toggle + Save row (plan step 16(a))
    // ------------------------------------------------------------------

    function buildToggleRow() {
        const row = document.createElement('div');
        row.className = 'info-sync-toggle-row';

        const label = document.createElement('label');
        label.className = 'switch-label';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.setAttribute('role', 'switch');
        checkbox.id = `info-sync-toggle-${repoId}`;
        checkbox.checked = !!pendingEnabled;
        checkbox.disabled = busy;
        checkbox.setAttribute('aria-describedby', `info-sync-help-${repoId}`);
        checkbox.addEventListener('change', () => {
            pendingEnabled = checkbox.checked;
            inlineError = null;
            safeRender();
        });
        label.appendChild(checkbox);

        const text = document.createElement('span');
        text.textContent = 'Sync workspace info';
        label.appendChild(text);

        row.appendChild(label);

        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'btn btn-primary btn-sm';
        const dirty = pendingEnabled !== status.enabled;
        saveBtn.disabled = busy || !dirty;
        saveBtn.textContent = (busy && busyKind === 'enabling')
            ? 'Cloning repository…'
            : (busy && busyKind === 'disabling')
                ? 'Removing clone…'
                : 'Save';
        saveBtn.addEventListener('click', () => { handleSave(); });
        row.appendChild(saveBtn);

        const help = document.createElement('p');
        help.className = 'hint';
        help.id = `info-sync-help-${repoId}`;
        help.textContent =
            'Enabling creates a Paralizer-managed clone of this repository and writes ' +
            '.workspace/info.json in it with the name, description (and URL, for information), ' +
            'keeping the file in sync afterwards and recreating it if it is ever deleted. ' +
            'If the repository already carries workspace info that differs from this data, ' +
            'it is offered for import. Committing those changes is a separate step (Commit & Push). ' +
            'Credentials are never written to the file.';
        row.appendChild(help);

        if (busy && (busyKind === 'enabling' || busyKind === 'disabling')) {
            const note = document.createElement('p');
            note.className = 'hint';
            note.textContent = 'This can take a while — cloning the repository runs in the background.';
            row.appendChild(note);
        }

        return row;
    }

    // ------------------------------------------------------------------
    // Status block (plan step 18: state pill, main folder path, branch,
    // ahead/behind, last synced — a single live region).
    // ------------------------------------------------------------------

    function buildStatusBlock() {
        const dl = document.createElement('dl');
        dl.className = 'info-sync-status-block';
        dl.setAttribute('role', 'status');
        dl.setAttribute('aria-live', 'polite');

        function addRow(labelText, valueOrNode) {
            const dt = document.createElement('dt');
            dt.textContent = labelText;
            const dd = document.createElement('dd');
            if (valueOrNode instanceof HTMLElement) {
                dd.appendChild(valueOrNode);
            } else {
                dd.textContent = valueOrNode;
            }
            dl.appendChild(dt);
            dl.appendChild(dd);
        }

        const pill = document.createElement('span');
        pill.className = `status-pill info-sync-state info-sync-state--${status.state}`;
        pill.textContent = STATE_LABELS[status.state] || status.state;
        addRow('State', pill);

        const pathEl = document.createElement('span');
        pathEl.className = 'font-mono info-sync-main-folder-path';
        pathEl.textContent = status.mainFolder ? status.mainFolder.path : '—';
        addRow('Main folder', pathEl);

        if (status.mainFolder && status.mainFolder.isGitRepository) {
            addRow('Branch', status.mainFolder.currentBranch || '—');
            addRow('Ahead / behind', `${status.mainFolder.ahead} / ${status.mainFolder.behind}`);
        }

        addRow('Last synced', status.lastSyncedAt ? formatTimestamp(status.lastSyncedAt) : 'Never');

        return dl;
    }

    function buildPendingFilesList() {
        const wrap = document.createElement('div');
        wrap.className = 'info-sync-pending-files';

        const label = document.createElement('p');
        label.className = 'hint';
        label.textContent = 'Pending changes:';
        wrap.appendChild(label);

        const ul = document.createElement('ul');
        status.pendingChanges.forEach((path) => {
            const li = document.createElement('li');
            li.textContent = path;
            ul.appendChild(li);
        });
        wrap.appendChild(ul);

        return wrap;
    }

    // ------------------------------------------------------------------
    // Health alert — fix-action registry (plan step 8's issue types)
    // ------------------------------------------------------------------

    function buildHealthActions() {
        return {
            'recreate-main-folder': {
                label: 'Recreate main folder',
                loadingLabel: 'Recreating…',
                onClick: () => doRecreateMainFolder(),
            },
            'refresh': {
                label: 'Refresh',
                loadingLabel: 'Refreshing…',
                onClick: () => doRefresh(),
            },
            'commit-push': {
                label: 'Commit & Push',
                onClick: () => doCommitPush(),
            },
            'import': {
                label: 'Import…',
                onClick: () => doImport(),
            },
            'configure-credential': {
                label: 'Configure',
                onClick: () => doConfigureCredential(),
            },
        };
    }

    // ------------------------------------------------------------------
    // Action row (Refresh / Import… / Commit & Push)
    // ------------------------------------------------------------------

    function buildActionRow() {
        const row = document.createElement('div');
        row.className = 'info-sync-action-row';

        const matrix = computeButtonMatrix(status, busy);

        const refreshBtn = buildReasonedButton(`info-sync-refresh-${repoId}`, 'Refresh');
        applyButtonState(refreshBtn, matrix.refresh);
        refreshBtn.btn.addEventListener('click', () => doRefresh());

        const importBtn = buildReasonedButton(`info-sync-import-${repoId}`, 'Import…');
        applyButtonState(importBtn, matrix.import);
        importBtn.btn.addEventListener('click', () => doImport());

        const commitBtn = buildReasonedButton(`info-sync-commit-${repoId}`, 'Commit & Push');
        applyButtonState(commitBtn, matrix.commit);
        commitBtn.btn.addEventListener('click', () => doCommitPush());

        [refreshBtn, importBtn, commitBtn].forEach((b) => row.appendChild(b.wrap));

        return row;
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------

    /** Re-fetches status without throwing; keeps the previous status on failure. */
    async function reloadStatusSilently() {
        try {
            status = await api.repositories.infoSync.status(repoId);
        } catch {
            // Keep the previous status — any caller that needs to surface this
            // failure has already shown its own error.
        }
    }

    /**
     * Opens the confirmation for a destructive action that would discard
     * pending changes. Resolves `true` when the user confirmed, `false`
     * when they cancelled.
     *
     * @param {string} title
     * @param {string} verb - e.g. "Disabling sync" / "Recreating the main folder".
     * @returns {Promise<boolean>}
     */
    async function confirmDiscard(title, verb) {
        try {
            await showConfirm(
                title,
                `${verb} will discard the pending changes in the managed clone: ` +
                `${status.pendingChanges.join(', ')}. Continue?`,
            );
            return true;
        } catch {
            return false;
        }
    }

    async function handleSave() {
        if (busy) return;
        const nextEnabled = pendingEnabled;
        let discard = false;

        if (!nextEnabled && status.pendingChanges && status.pendingChanges.length > 0) {
            const confirmed = await confirmDiscard('Disable workspace info sync', 'Disabling sync');
            if (!confirmed) return;
            discard = true;
        }

        busy = true;
        busyKind = nextEnabled ? 'enabling' : 'disabling';
        inlineError = null;
        safeRender();

        try {
            const input = discard ? { enabled: nextEnabled, discardPendingChanges: true } : { enabled: nextEnabled };
            status = await api.repositories.infoSync.saveSettings(repoId, input);
            pendingEnabled = status.enabled;
            busy = false;
            busyKind = null;
            showToast(nextEnabled ? 'Sync enabled' : 'Sync disabled', 'success');
            safeRender();
            maybeAutoOpenConflict();
        } catch (err) {
            busy = false;
            busyKind = null;
            // "Failed enable attempts leave no half-state in the UI ... the
            // status is re-fetched after any failure" (plan step 16(a)).
            await reloadStatusSilently();
            pendingEnabled = status ? status.enabled : nextEnabled;
            inlineError = err.message || 'Failed to save sync settings.';
            safeRender();
        }
    }

    async function doRefresh() {
        if (busy) return;
        busy = true;
        busyKind = 'refresh';
        inlineError = null;
        safeRender();

        const before = status;
        try {
            status = await api.repositories.infoSync.refresh(repoId);
            busy = false;
            busyKind = null;
            showToast(describeRefreshOutcome(before, status), 'success');
            safeRender();
            maybeAutoOpenConflict();
        } catch (err) {
            busy = false;
            busyKind = null;
            inlineError = err.message || 'Failed to refresh sync status.';
            safeRender();
        }
    }

    /**
     * Picks one of the three refresh toasts from the plan (step 16(c)) based
     * on the before/after status. `RepositoryInfoSyncStatus` carries no
     * explicit "did we fast-forward" flag, so this is a best-effort read of
     * the available fields, not a literal mirror of server-side bookkeeping.
     *
     * @param {Object|null} before
     * @param {Object} after
     * @returns {string}
     */
    function describeRefreshOutcome(before, after) {
        if (after.state === 'incoming') return 'Incoming changes found — import available.';
        const wasBehind = !!(before && before.mainFolder && before.mainFolder.behind > 0);
        const nowBehind = !!(after.mainFolder && after.mainFolder.behind > 0);
        if (wasBehind && !nowBehind) return 'Fetched and fast-forwarded.';
        return 'Already up to date.';
    }

    async function doRecreateMainFolder() {
        if (busy) return;
        let discard = false;

        if (status.pendingChanges && status.pendingChanges.length > 0) {
            const confirmed = await confirmDiscard('Recreate main folder', 'Recreating the main folder');
            if (!confirmed) return;
            discard = true;
        }

        busy = true;
        busyKind = 'recreate';
        inlineError = null;
        safeRender();

        try {
            status = await api.repositories.infoSync.recreateMainFolder(repoId, discard || undefined);
            busy = false;
            busyKind = null;
            showToast('Main folder recreated.', 'success');
            safeRender();
            maybeAutoOpenConflict();
        } catch (err) {
            busy = false;
            busyKind = null;
            inlineError = err.message || 'Failed to recreate the main folder.';
            safeRender();
        }
    }

    async function doImport() {
        if (busy || modalOpen) return;
        busy = true;
        busyKind = 'import';
        inlineError = null;
        safeRender();

        let preview;
        try {
            preview = await api.repositories.infoSync.importPreview(repoId);
        } catch (err) {
            busy = false;
            busyKind = null;
            inlineError = err.message || 'Failed to load the import preview.';
            safeRender();
            return;
        }

        busy = false;
        busyKind = null;
        modalOpen = true;
        safeRender();

        const { applied } = await showRepositoryInfoImportModal({ repoId, repoName, preview });
        if (destroyed) return;
        modalOpen = false;

        if (applied) {
            showToast('Import applied.', 'success');

            // Import is the only action that can change Name/Description, so
            // it is the only one that notifies the caller (step 16(e)).
            try {
                const updatedRepo = await api.repositories.get(repoId);
                if (!destroyed && typeof onRepositoryChanged === 'function') {
                    onRepositoryChanged(updatedRepo);
                }
            } catch {
                // Best-effort — the header/table refresh is secondary to this
                // section's own status, which is re-fetched below regardless.
            }

            await reloadStatusSilently();
        }

        if (destroyed) return;
        safeRender();
    }

    /**
     * Builds the success toast text for a Commit & Push outcome.
     *
     * Names the pushed commit when both a `commitSha` and the main folder's
     * `defaultBranch` are known (`Pushed {sha7} to {branch}.`); falls back to
     * the generic `Committed and pushed.` otherwise — e.g. an older server
     * response shape, or a repository whose main folder was recreated
     * between the dialog opening and the commit landing.
     *
     * @param {{ commitSha?: string }} result - `CommitPushResult` from `commitPush()`.
     * @returns {string}
     */
    function describeCommitOutcome(result) {
        const branch = status.mainFolder ? status.mainFolder.defaultBranch : undefined;
        if (result && result.commitSha && branch) {
            return `Pushed ${result.commitSha.slice(0, 7)} to ${branch}.`;
        }
        return 'Committed and pushed.';
    }

    async function doCommitPush() {
        if (busy || modalOpen) return;
        modalOpen = true;
        safeRender();

        // The dialog performs the commit itself (see info-commit-dialog.js);
        // it already surfaces its own errors inline in its modal, so errors
        // from Commit & Push never reach this section's inline alert.
        const outcome = await showInfoCommitDialog({
            repoId,
            pendingFiles: status.pendingChanges,
            defaultMessage: status.defaultCommitMessage,
        });
        if (destroyed) return;
        modalOpen = false;

        if (outcome !== null) {
            showToast(describeCommitOutcome(outcome.result), 'success');
            if (outcome.result && outcome.result.filterFallback) {
                showToast('The remote does not support partial-clone filtering — a full fetch was used.', 'info');
            }
            await reloadStatusSilently();
        }

        if (destroyed) return;
        safeRender();
        maybeAutoOpenConflict();
    }

    function doConfigureCredential() {
        if (typeof onConfigureCredential === 'function') onConfigureCredential();
    }

    /**
     * Auto-opens the import modal for a `conflict` state, at most once per
     * repository per page visit (plan step 16(d)).
     *
     * There is no human "opener" for an auto-open, so the section heading
     * is focused first — this gives `modal-shell.js`'s own focus-restoration
     * a sane target to return to once the modal closes (Cancel or Apply),
     * instead of leaving focus on `<body>`.
     */
    function maybeAutoOpenConflict() {
        if (destroyed || !status || status.state !== 'conflict') return;
        if (modalOpen || busy) return;
        if (autoOpenedConflicts.has(repoId)) return;
        autoOpenedConflicts.add(repoId);
        heading.focus();
        doImport();
    }

    // ------------------------------------------------------------------
    // Initial load
    // ------------------------------------------------------------------

    async function load() {
        loadError = null;
        status = null;
        safeRender();

        try {
            status = await api.repositories.infoSync.status(repoId);
            if (destroyed) return;
            pendingEnabled = status.enabled;
            safeRender();
            maybeAutoOpenConflict();
        } catch (err) {
            if (destroyed) return;
            loadError = err.message || 'Failed to load sync status.';
            safeRender();
        }
    }

    load();

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    function cleanup() {
        destroyed = true;
    }

    return { element: section, cleanup };
}
