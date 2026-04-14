/**
 * Workspace Detail View — Repo Parallelizer GUI.
 *
 * Renders the full detail page for a single workspace inside a project:
 *   - Workspace header: ID, description, breadcrumb link back to the project.
 *   - Repository status table: one row per repository, showing current branch,
 *     a color-coded Git status badge, and an error/loading indicator for repos
 *     with no status data yet.
 *   - Live polling: status badges refresh in-place via a 1-second countdown
 *     interval that triggers a poll every 10 seconds. A visible countdown
 *     label and a "Refresh Now" button provide user control. The interval
 *     is cleared via the cleanup function returned from
 *     `renderWorkspaceDetail`, which the router calls before navigating
 *     away.
 *   - Actions: "Switch Branches" navigation button, "Rename Workspace" (disabled
 *     for STABLE), "Delete Workspace" (disabled for STABLE).
 *
 * ## Router integration
 *
 * The view uses the same router-injection pattern as `project-detail.js`:
 * `app.js` calls `setRouter(router)` before `router.start()`. The `_router`
 * variable is null-guarded at every navigation site so the view remains
 * functional in test contexts.
 *
 * ## Cleanup contract
 *
 * `renderWorkspaceDetail` returns a cleanup function. The router's `_render`
 * method already stores and calls any function returned by a view. No changes
 * to `router.js` are needed.
 *
 * @module workspace-detail
 */

import { api }               from '../api.js';
import { showToast }         from '../components/toast.js';
import { showConfirm }       from '../components/confirm-dialog.js';
import { createStatusBadge } from '../components/status-badge.js';
import { createFormField, validateRequired, WORKSPACE_ID_PATTERN } from '../components/form-helpers.js';
import { normaliseProject, normaliseWorkspace } from '../utils/normalise.js';

// ---------------------------------------------------------------------------
// Router reference — injected from app.js via setRouter()
// ---------------------------------------------------------------------------

/** @type {import('../router.js').Router|null} */
let _router = null;

/**
 * Inject the router instance so workspace-detail can navigate on rename/delete.
 * Called from app.js before the router starts.
 *
 * @param {import('../router.js').Router} router
 */
export function setRouter(router) {
    _router = router;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default polling interval in milliseconds (fallback when config fetch fails). */
const DEFAULT_POLL_INTERVAL_MS = 10_000;

/** The workspace ID that cannot be renamed or deleted. */
const STABLE_WS_ID = 'STABLE';

// ---------------------------------------------------------------------------
// Normalisation helpers — imported from utils/normalise.js
// extractRepoId and extractRepoName remain local (workspace-detail only).
// ---------------------------------------------------------------------------

/**
 * Extract a repository's ID from either a plain string or an object.
 * The backend may return Repositories as an array of strings, an array of
 * objects with `Id`/`id`, or an array of objects with `repositoryId`.
 *
 * @param {string|Object} repo
 * @returns {string}
 */
function extractRepoId(repo) {
    if (typeof repo === 'string') return repo;
    return repo.Id || repo.id || repo.RepositoryId || repo.repositoryId || '';
}

/**
 * Extract a human-readable repository name from a repository entry.
 * Falls back to the ID when no name is available.
 *
 * @param {string|Object} repo
 * @returns {string}
 */
function extractRepoName(repo) {
    if (typeof repo === 'string') return repo;
    return repo.Name || repo.name || extractRepoId(repo);
}

// ---------------------------------------------------------------------------
// Loading helper
// ---------------------------------------------------------------------------

/**
 * Render a loading spinner into `el`.
 *
 * @param {HTMLElement} el
 * @param {string} [label]
 */
function showLoading(el, label = 'Loading…') {
    el.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'loading-indicator';
    wrapper.setAttribute('aria-live', 'polite');

    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    wrapper.appendChild(spinner);

    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    wrapper.appendChild(labelEl);

    el.appendChild(wrapper);
}

// ---------------------------------------------------------------------------
// Setup helper
// ---------------------------------------------------------------------------

/**
 * Run workspace setup and show appropriate toast notification.
 *
 * @param {string} projectId
 * @param {string} workspaceId
 * @param {string} successMessage - Toast message shown when all repos succeed.
 * @returns {Promise<Object>} The setup result from the API.
 * @throws {Error} Re-throws API errors for the caller to handle.
 */
async function runSetup(projectId, workspaceId, successMessage) {
    const result = await api.workspaces.setup(projectId, workspaceId);
    const failures = (result && result.results || []).filter((r) => !r.success);
    if (failures.length > 0) {
        const names = failures.map((f) => f.repositoryId).join(', ');
        showToast(`Setup complete with errors. Failed to clone: ${names}`, 'warning', 8000);
    } else {
        showToast(successMessage, 'success');
    }
    return result;
}

// ---------------------------------------------------------------------------
// Status table helpers
// ---------------------------------------------------------------------------

/**
 * Build the status `<tbody>` row for a single repository.
 *
 * The row uses `data-repo-id` on the badge container so the polling update
 * can locate and replace badge contents in-place.
 *
 * @param {string} repoId
 * @param {string} repoName
 * @param {Object|null} statusInfo - GitStatusInfo or null.
 * @returns {HTMLTableRowElement}
 */
function buildRepoStatusRow(repoId, repoName, statusInfo) {
    const tr = document.createElement('tr');
    tr.dataset.repoId = repoId;

    // Repository name / ID
    const nameCell = document.createElement('td');
    nameCell.className = 'repo-name-cell';
    const nameEl = document.createElement('span');
    nameEl.className = 'repo-name';
    nameEl.textContent = repoName;
    if (repoName !== repoId) {
        const idHint = document.createElement('span');
        idHint.className = 'text-muted repo-id-hint';
        idHint.textContent = ` (${repoId})`;
        nameEl.appendChild(idHint);
    }
    nameCell.appendChild(nameEl);
    tr.appendChild(nameCell);

    // Branch name
    const branchCell = document.createElement('td');
    branchCell.className = 'repo-branch-cell';
    branchCell.textContent = (statusInfo && statusInfo.currentBranch)
        ? statusInfo.currentBranch
        : '—';
    tr.appendChild(branchCell);

    // Status badge cell
    const badgeCell = document.createElement('td');
    badgeCell.className = 'repo-badge-cell';

    const badgeWrapper = document.createElement('div');
    badgeWrapper.dataset.repoId = repoId;
    badgeWrapper.appendChild(createStatusBadge(statusInfo || null));
    badgeCell.appendChild(badgeWrapper);
    tr.appendChild(badgeCell);

    return tr;
}

/**
 * Update an existing status table in-place by replacing badge contents and
 * branch text for each repository whose status has changed.
 *
 * Rows are located via `[data-repo-id]` on both the `<tr>` and the badge
 * wrapper `<div>` inside it. No full re-render of the table is performed.
 *
 * @param {HTMLElement}           tableBody - The `<tbody>` to update.
 * @param {Record<string, Object|null>} statusMap - Keyed by repository ID.
 */
function updateStatusTable(tableBody, statusMap) {
    for (const [repoId, statusInfo] of Object.entries(statusMap)) {
        const row = tableBody.querySelector(`tr[data-repo-id="${CSS.escape(repoId)}"]`);
        if (!row) continue;

        // Update branch cell (second cell)
        const branchCell = row.cells[1];
        if (branchCell) {
            branchCell.textContent = (statusInfo && statusInfo.currentBranch)
                ? statusInfo.currentBranch
                : '—';
        }

        // Update badge wrapper (third cell → div[data-repo-id])
        const badgeWrapper = row.querySelector(`div[data-repo-id="${CSS.escape(repoId)}"]`);
        if (badgeWrapper) {
            badgeWrapper.innerHTML = '';
            badgeWrapper.appendChild(createStatusBadge(statusInfo || null));
        }
    }
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

/**
 * Build the rename workspace inline form and wire up its event handlers.
 *
 * @param {string} projectId
 * @param {{ id: string }} workspace
 * @param {HTMLButtonElement} renameBtn - The "Rename" button that toggles form visibility.
 * @returns {HTMLElement}
 */
function buildRenameForm(projectId, workspace, renameBtn) {
    const wrapper = document.createElement('div');
    wrapper.className = 'rename-workspace-form-wrapper card';
    wrapper.hidden = true;

    const formTitle = document.createElement('h4');
    formTitle.className   = 'form-section-title';
    formTitle.textContent = 'Rename Workspace';
    wrapper.appendChild(formTitle);

    const newIdField = createFormField('New Workspace ID', 'text', 'newWorkspaceId', {
        required:    true,
        placeholder: 'e.g. DEV or FEATURE',
        hint:        'Must be 2–6 uppercase letters (A-Z only).',
    });
    wrapper.appendChild(newIdField);

    const newIdInput   = newIdField.querySelector('[name="newWorkspaceId"]');
    const newIdErrorEl = newIdField.querySelector('.field-error');

    const formActions = document.createElement('div');
    formActions.className = 'form-actions';

    const saveBtn = document.createElement('button');
    saveBtn.type      = 'button';
    saveBtn.className = 'btn btn-primary btn-sm';
    saveBtn.textContent = 'Save';

    const cancelFormBtn = document.createElement('button');
    cancelFormBtn.type      = 'button';
    cancelFormBtn.className = 'btn btn-secondary btn-sm';
    cancelFormBtn.textContent = 'Cancel';

    formActions.appendChild(saveBtn);
    formActions.appendChild(cancelFormBtn);
    wrapper.appendChild(formActions);

    // Behaviour
    renameBtn.addEventListener('click', () => {
        wrapper.hidden = false;
        if (newIdInput) newIdInput.focus();
    });

    cancelFormBtn.addEventListener('click', () => {
        wrapper.hidden = true;
        if (newIdInput) newIdInput.value = '';
        if (newIdErrorEl) newIdErrorEl.hidden = true;
    });

    saveBtn.addEventListener('click', async () => {
        if (newIdErrorEl) newIdErrorEl.hidden = true;
        if (newIdInput) {
            newIdInput.classList.remove('error');
            newIdInput.removeAttribute('aria-invalid');
        }

        if (!validateRequired(wrapper, ['newWorkspaceId'])) return;

        const newId = newIdInput ? newIdInput.value.trim() : '';

        if (!WORKSPACE_ID_PATTERN.test(newId)) {
            if (newIdErrorEl) {
                newIdErrorEl.textContent = 'Must be 2–6 uppercase letters (A-Z only).';
                newIdErrorEl.hidden      = false;
            }
            if (newIdInput) {
                newIdInput.classList.add('error');
                newIdInput.setAttribute('aria-invalid', 'true');
                newIdInput.focus();
            }
            return;
        }

        try {
            await showConfirm(
                'Rename Workspace',
                `Rename workspace "${workspace.id}" to "${newId}"? The page will navigate to the new workspace URL.`,
            );
        } catch {
            return;
        }

        saveBtn.disabled    = true;
        saveBtn.textContent = 'Saving…';

        try {
            await api.workspaces.rename(projectId, workspace.id, newId);
            showToast(`Workspace renamed to "${newId}".`, 'success');
            const target = `#/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(newId)}`;
            if (_router) {
                _router.navigate(target);
            } else {
                location.hash = target;
            }
        } catch (err) {
            showToast(err.message || 'Failed to rename workspace.', 'error');
            saveBtn.disabled    = false;
            saveBtn.textContent = 'Save';
        }
    });

    return wrapper;
}

/**
 * Build the workspace header section — compact layout with breadcrumb,
 * workspace name, and a meta card for description + management actions.
 *
 * @param {string} projectId
 * @param {{ id: string, description: string, initialized: boolean, folderPath: string }} workspace
 * @param {boolean} isStable
 * @param {function(): void} [onSetupSuccess] - Called after a successful setup to trigger refresh.
 * @returns {HTMLElement}
 */
function buildHeaderSection(projectId, workspace, isStable, onSetupSuccess) {
    const wrapper = document.createElement('div');
    wrapper.className = 'workspace-detail-header';

    // Breadcrumb
    const breadcrumb = document.createElement('nav');
    breadcrumb.className = 'breadcrumb back-link text-muted';
    breadcrumb.setAttribute('aria-label', 'Breadcrumb');

    const projectLink = document.createElement('a');
    projectLink.href      = `#/projects/${encodeURIComponent(projectId)}`;
    projectLink.textContent = `← ${projectId}`;
    projectLink.className = 'breadcrumb-link';
    if (_router) {
        projectLink.addEventListener('click', (e) => {
            e.preventDefault();
            _router.navigate(`#/projects/${encodeURIComponent(projectId)}`);
        });
    }
    breadcrumb.appendChild(projectLink);
    wrapper.appendChild(breadcrumb);

    // Title row: workspace ID
    const titleRow = document.createElement('div');
    titleRow.className = 'workspace-meta-top-row';

    const titleEl = document.createElement('h1');
    titleEl.className   = 'project-meta-name';
    titleEl.textContent = workspace.id;
    titleRow.appendChild(titleEl);

    // Description (inline, muted)
    if (workspace.description) {
        const descEl = document.createElement('span');
        descEl.className   = 'project-meta-id text-muted';
        descEl.textContent = workspace.description;
        titleRow.appendChild(descEl);
    }

    wrapper.appendChild(titleRow);

    // Folder path row (shown when path is available)
    if (workspace.folderPath) {
        const pathRow = document.createElement('div');
        pathRow.className = 'workspace-folder-path-row';

        const pathLabel = document.createElement('span');
        pathLabel.className = 'text-muted';
        pathLabel.textContent = 'Path: ';

        const pathValue = document.createElement('code');
        pathValue.className = 'workspace-folder-path font-mono';
        pathValue.textContent = workspace.folderPath;

        pathRow.appendChild(pathLabel);
        pathRow.appendChild(pathValue);
        wrapper.appendChild(pathRow);
    }

    // Management row: rename, delete, setup
    const mgmtRow = document.createElement('div');
    mgmtRow.className = 'workspace-mgmt-row';

    // Setup button (if not initialized)
    if (!workspace.initialized) {
        const setupBtn = document.createElement('button');
        setupBtn.type      = 'button';
        setupBtn.className = 'btn btn-primary btn-sm';
        setupBtn.textContent = 'Setup Workspace';
        setupBtn.title = 'Initialize workspace on disk (create folder, clone repos).';

        setupBtn.addEventListener('click', async () => {
            setupBtn.disabled = true;
            setupBtn.textContent = 'Setting up…';

            try {
                await runSetup(projectId, workspace.id,
                    `Workspace "${workspace.id}" set up successfully.`);

                // Update DOM in-place — remove setup button and notify caller
                setupBtn.remove();
                workspace.initialized = true;
                if (onSetupSuccess) onSetupSuccess();
            } catch (err) {
                showToast(err.message || 'Failed to set up workspace.', 'error');
                setupBtn.disabled = false;
                setupBtn.textContent = 'Setup Workspace';
            }
        });
        mgmtRow.appendChild(setupBtn);
    }

    // Rename button (disabled for STABLE)
    const renameBtn = document.createElement('button');
    renameBtn.type      = 'button';
    renameBtn.className = 'btn btn-secondary btn-sm';
    renameBtn.textContent = 'Rename';

    if (isStable) {
        renameBtn.disabled = true;
        renameBtn.title    = 'The STABLE workspace cannot be renamed.';
    }
    mgmtRow.appendChild(renameBtn);

    // Delete button (disabled for STABLE)
    const deleteBtn = document.createElement('button');
    deleteBtn.type      = 'button';
    deleteBtn.className = 'btn btn-danger btn-sm';
    deleteBtn.textContent = 'Delete';

    if (isStable) {
        deleteBtn.disabled = true;
        deleteBtn.title    = 'The STABLE workspace cannot be deleted.';
    }
    mgmtRow.appendChild(deleteBtn);

    wrapper.appendChild(mgmtRow);

    // Rename inline form + delete handler (non-STABLE only)
    if (!isStable) {
        wrapper.appendChild(buildRenameForm(projectId, workspace, renameBtn));

        deleteBtn.addEventListener('click', async () => {
            try {
                await showConfirm(
                    'Delete Workspace',
                    `Delete workspace "${workspace.id}"? All cloned repositories in this workspace will be permanently removed. This action cannot be undone.`,
                );
            } catch {
                return;
            }

            deleteBtn.disabled    = true;
            deleteBtn.textContent = 'Deleting…';

            try {
                await api.workspaces.delete(projectId, workspace.id);
                showToast(`Workspace "${workspace.id}" deleted.`, 'success');
                if (_router) {
                    _router.navigate(`#/projects/${encodeURIComponent(projectId)}`);
                } else {
                    location.hash = `#/projects/${encodeURIComponent(projectId)}`;
                }
            } catch (err) {
                showToast(err.message || 'Failed to delete workspace.', 'error');
                deleteBtn.disabled    = false;
                deleteBtn.textContent = 'Delete';
            }
        });
    }

    return wrapper;
}

/**
 * Build the repository status table section.
 *
 * @param {Array<{ repoId: string, repoName: string }>} repos
 * @param {Record<string, Object|null>} statusMap
 * @returns {{ section: HTMLElement, tbody: HTMLTableSectionElement }}
 */
function buildStatusTableSection(repos, statusMap) {
    const section = document.createElement('section');
    section.className = 'workspace-status-section';

    if (repos.length === 0) {
        const empty = document.createElement('p');
        empty.className   = 'empty-state-inline text-secondary';
        empty.textContent = 'No repositories in this project.';
        section.appendChild(empty);
        return { section, tbody: null };
    }

    const table = document.createElement('table');
    table.className = 'data-table workspace-status-table';

    const thead = document.createElement('thead');
    const htr   = document.createElement('tr');
    ['Repository', 'Branch', 'Status'].forEach((label) => {
        const th = document.createElement('th');
        th.textContent = label;
        htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    repos.forEach(({ repoId, repoName }) => {
        const statusInfo = statusMap[repoId] ?? null;
        tbody.appendChild(buildRepoStatusRow(repoId, repoName, statusInfo));
    });

    table.appendChild(tbody);
    section.appendChild(table);

    return { section, tbody };
}

/**
 * Build the Switch Branches button.
 *
 * @param {string} projectId
 * @param {string} wid        - Workspace ID.
 * @returns {HTMLElement}
 */
function buildSwitchBranchesButton(projectId, wid) {
    const switchBtn = document.createElement('button');
    switchBtn.type      = 'button';
    switchBtn.className = 'btn btn-primary';
    switchBtn.textContent = 'Switch Branches';
    switchBtn.addEventListener('click', () => {
        const target = `#/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wid)}/branch-switch`;
        if (_router) {
            _router.navigate(target);
        } else {
            location.hash = target;
        }
    });
    return switchBtn;
}

/**
 * Build the refresh toolbar row with progress bar and "Refresh Now" button.
 *
 * @returns {HTMLElement}
 */
function buildRefreshToolbar() {
    const toolbar = document.createElement('div');
    toolbar.className = 'workspace-refresh-toolbar';

    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'btn btn-secondary btn-sm refresh-now-btn';
    btn.textContent = 'Refresh Now';
    toolbar.appendChild(btn);

    const track = document.createElement('div');
    track.className = 'refresh-progress-track';
    const bar = document.createElement('div');
    bar.className = 'refresh-progress-bar';
    track.appendChild(bar);
    toolbar.appendChild(track);

    return toolbar;
}

// ---------------------------------------------------------------------------
// Public view entry point
// ---------------------------------------------------------------------------

/**
 * Render the workspace detail view.
 *
 * Fetches workspace metadata, project (for the repositories list), polling
 * configuration, and initial Git status in parallel. Then starts a polling
 * interval that updates badges in-place using the server-configured interval
 * (falls back to {@link DEFAULT_POLL_INTERVAL_MS} if the config fetch fails).
 *
 * @param {HTMLElement} container - The `#app` DOM element provided by the router.
 * @param {{ id: string, wid: string }} params - Route parameters.
 * @returns {function(): void} Cleanup function — clears the polling interval.
 *   The router stores and calls this before rendering the next view.
 */
export function renderWorkspaceDetail(container, params) {
    const projectId = params.id;
    const wid       = params.wid;

    let countdownInterval = null;

    // Return the cleanup function immediately so the router can register it
    // even if the async bootstrap hasn't resolved yet.
    const cleanup = () => {
        if (countdownInterval !== null) {
            clearInterval(countdownInterval);
            countdownInterval = null;
        }
    };

    // Show loading state immediately.
    showLoading(container, 'Loading workspace…');

    // Kick off parallel data fetch.
    Promise.all([
        api.workspaces.get(projectId, wid),
        api.projects.get(projectId),
        api.status.refresh(projectId, wid),
        api.config.polling.get().catch(() => null),
    ]).then((results) => {
        const [rawWorkspace, rawProject, statusMap, pollingConfig] = results;
        // Guard: if the container was cleared by navigation before we resolved,
        // do nothing and let the cleanup function handle the interval.
        if (!container.isConnected) return;

        const workspace = normaliseWorkspace(rawWorkspace);
        const project   = normaliseProject(rawProject);

        // Build repo list: [{ repoId, repoName }, …]
        const repos = project.repositories.map((r) => ({
            repoId:   extractRepoId(r),
            repoName: extractRepoName(r),
        })).filter((r) => r.repoId !== '');

        // Render the view.
        container.innerHTML = '';

        const isStable = wid === STABLE_WS_ID;

        // Resolve the effective poll interval from server config, with fallback.
        const pollIntervalMs = (
            pollingConfig &&
            typeof pollingConfig.gitPollingIntervalSeconds === 'number' &&
            Number.isFinite(pollingConfig.gitPollingIntervalSeconds) &&
            pollingConfig.gitPollingIntervalSeconds > 0
        )
            ? pollingConfig.gitPollingIntervalSeconds * 1000
            : DEFAULT_POLL_INTERVAL_MS;

        // Build status table first to obtain tbody reference for helpers.
        const { section: statusSection, tbody } = buildStatusTableSection(repos, statusMap || {});

        // -------------------------------------------------------------------
        // Refresh helpers (referenced by toolbar, polling, and setup)
        // -------------------------------------------------------------------

        let remainingSeconds = pollIntervalMs / 1000;
        let refreshInProgress = false;

        // Retry row reference — kept so polling can update/hide it.
        let retryRow = null;
        let retryHint = null;

        // Toolbar elements — built now, wired after helpers are defined.
        const toolbar = buildRefreshToolbar();
        const progressBar = toolbar.querySelector('.refresh-progress-bar');
        const refreshNowBtn = toolbar.querySelector('.refresh-now-btn');

        /**
         * Re-evaluate missing repos after a status update and hide/update
         * the retry row accordingly.
         */
        function updateMissingReposRow(freshStatusMap) {
            const currentMissing = repos.filter((r) => !freshStatusMap[r.repoId]);
            if (currentMissing.length === 0) {
                if (retryRow) {
                    retryRow.remove();
                    retryRow = null;
                    retryHint = null;
                }
            } else if (retryHint) {
                retryHint.textContent = `${currentMissing.length} ${currentMissing.length === 1 ? 'repository has' : 'repositories have'} no data \u2014 clone may have failed.`;
            }
        }

        /**
         * Automatic poll — uses cached status endpoint.
         */
        async function doPoll() {
            if (refreshInProgress) return;
            refreshInProgress = true;
            try {
                const fresh = await api.status.get(projectId, wid);
                if (container.isConnected && fresh) {
                    updateStatusTable(tbody, fresh);
                    updateMissingReposRow(fresh);
                }
            } catch {
                // Silently ignore polling errors — stale badges remain.
            } finally {
                refreshInProgress = false;
                remainingSeconds = pollIntervalMs / 1000;
                progressBar.classList.remove('refreshing');
                progressBar.style.width = '0%';
            }
        }

        /**
         * Manual force-refresh — calls the live git-fetch endpoint.
         */
        async function doRefresh() {
            if (refreshInProgress) return;
            refreshInProgress = true;
            refreshNowBtn.disabled = true;
            progressBar.classList.add('refreshing');
            try {
                const fresh = await api.status.refresh(projectId, wid);
                if (container.isConnected && fresh) {
                    updateStatusTable(tbody, fresh);
                    updateMissingReposRow(fresh);
                }
            } catch {
                // Silently ignore — stale badges remain.
            } finally {
                refreshInProgress = false;
                refreshNowBtn.disabled = false;
                remainingSeconds = pollIntervalMs / 1000;
                progressBar.classList.remove('refreshing');
                progressBar.style.width = '0%';
            }
        }

        /**
         * Start the 1-second countdown interval.
         */
        function startCountdown() {
            if (countdownInterval) return;
            countdownInterval = setInterval(() => {
                if (!container.isConnected) {
                    cleanup();
                    return;
                }
                remainingSeconds--;
                if (remainingSeconds <= 0) {
                    progressBar.classList.add('refreshing');
                    doPoll();
                } else {
                    const totalSeconds = pollIntervalMs / 1000;
                    const pct = ((totalSeconds - remainingSeconds) / totalSeconds) * 100;
                    progressBar.style.width = `${pct}%`;
                }
            }, 1000);
        }

        refreshNowBtn.addEventListener('click', doRefresh);

        // Setup success callback — hides setup button, triggers refresh.
        const onSetupSuccess = () => {
            doRefresh();
            if (!countdownInterval && tbody && repos.length > 0) {
                startCountdown();
            }
        };

        // -------------------------------------------------------------------
        // Assemble DOM
        // -------------------------------------------------------------------

        container.appendChild(buildHeaderSection(projectId, workspace, isStable, onSetupSuccess));

        // Refresh toolbar (between header and status table)
        if (repos.length > 0) {
            container.appendChild(toolbar);
        }

        container.appendChild(statusSection);

        // Show "Retry Setup" when workspace is initialized but some repos
        // have no status data (likely failed to clone).
        const safeStatusMap = statusMap || {};
        const missingRepos = repos.filter((r) => !safeStatusMap[r.repoId]);
        if (workspace.initialized && missingRepos.length > 0) {
            retryRow = document.createElement('div');
            retryRow.className = 'workspace-mgmt-row';

            retryHint = document.createElement('span');
            retryHint.className = 'text-secondary text-sm';
            retryHint.textContent = `${missingRepos.length} ${missingRepos.length === 1 ? 'repository has' : 'repositories have'} no data \u2014 clone may have failed.`;
            retryRow.appendChild(retryHint);

            const retryBtn = document.createElement('button');
            retryBtn.type      = 'button';
            retryBtn.className = 'btn btn-secondary btn-sm';
            retryBtn.textContent = 'Retry Setup';
            retryBtn.title = 'Re-run workspace setup to clone missing repositories.';

            retryBtn.addEventListener('click', async () => {
                retryBtn.disabled = true;
                retryBtn.textContent = 'Setting up\u2026';

                try {
                    await runSetup(projectId, workspace.id,
                        'All repositories cloned successfully.');

                    // Trigger immediate refresh to update the status table.
                    doRefresh();
                } catch (err) {
                    showToast(err.message || 'Failed to set up workspace.', 'error');
                    retryBtn.disabled = false;
                    retryBtn.textContent = 'Retry Setup';
                }
            });

            retryRow.appendChild(retryBtn);
            container.appendChild(retryRow);
        }

        if (!isStable) {
            container.appendChild(buildSwitchBranchesButton(projectId, wid));
        }

        // Start polling countdown when there are repos to update.
        if (tbody && repos.length > 0) {
            startCountdown();
        }
    }).catch((err) => {
        if (!container.isConnected) return;
        container.innerHTML = '';
        const errEl = document.createElement('div');
        errEl.className = 'empty-state';

        const errTitle = document.createElement('h2');
        errTitle.textContent = 'Failed to load workspace';
        errEl.appendChild(errTitle);

        const errMsg = document.createElement('p');
        errMsg.className   = 'text-secondary';
        errMsg.textContent = err.message || 'An unexpected error occurred.';
        errEl.appendChild(errMsg);

        const backLink = document.createElement('a');
        backLink.href      = `#/projects/${encodeURIComponent(projectId)}`;
        backLink.className = 'btn btn-secondary';
        backLink.textContent = '← Back to Project';
        if (_router) {
            backLink.addEventListener('click', (e) => {
                e.preventDefault();
                _router.navigate(`#/projects/${encodeURIComponent(projectId)}`);
            });
        }
        errEl.appendChild(backLink);

        container.appendChild(errEl);
    });

    // Return cleanup so the router can call it on navigation away.
    return cleanup;
}
