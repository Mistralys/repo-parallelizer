/**
 * Workspace Detail View — Repo Parallelizer GUI.
 *
 * Renders the full detail page for a single workspace inside a project:
 *   - Workspace header: ID, description, breadcrumb link back to the project.
 *   - Repository status table: one row per repository, showing current branch,
 *     a color-coded Git status badge, and an error/loading indicator for repos
 *     with no status data yet.
 *   - Live polling: status badges refresh in-place every 10 seconds via
 *     `setInterval`. The interval is cleared via the cleanup function returned
 *     from `renderWorkspaceDetail`, which the router calls before navigating
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

/** Polling interval in milliseconds. */
const POLL_INTERVAL_MS = 10_000;

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
    el.innerHTML = `
        <div class="loading-indicator" aria-live="polite">
            <span class="spinner" aria-hidden="true"></span>
            <span>${label}</span>
        </div>
    `;
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
 * Build the workspace header section — compact layout with breadcrumb,
 * workspace name, and a meta card for description + management actions.
 *
 * @param {string} projectId
 * @param {{ id: string, description: string, initialized: boolean }} workspace
 * @param {boolean} isStable
 * @returns {HTMLElement}
 */
function buildHeaderSection(projectId, workspace, isStable) {
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
                const result = await api.workspaces.setup(projectId, workspace.id);

                // Report per-repo clone results
                const failures = (result && result.results || []).filter((r) => !r.success);
                if (failures.length > 0) {
                    const names = failures.map((f) => f.repositoryId).join(', ');
                    showToast(`Setup complete with errors. Failed to clone: ${names}`, 'warning', 8000);
                } else {
                    showToast(`Workspace "${workspace.id}" set up successfully.`, 'success');
                }

                // Re-render by navigating to the same page
                const target = `#/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspace.id)}`;
                if (_router) {
                    _router.navigate(target);
                } else {
                    location.hash = target;
                }
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

    // Rename inline form (hidden initially)
    const renameFormWrapper = document.createElement('div');
    renameFormWrapper.className = 'rename-workspace-form-wrapper card';
    renameFormWrapper.hidden = true;
    wrapper.appendChild(renameFormWrapper);

    if (!isStable) {
        const formTitle = document.createElement('h4');
        formTitle.className   = 'form-section-title';
        formTitle.textContent = 'Rename Workspace';
        renameFormWrapper.appendChild(formTitle);

        const newIdField = createFormField('New Workspace ID', 'text', 'newWorkspaceId', {
            required:    true,
            placeholder: 'e.g. DEV or FEATURE',
            hint:        'Must be 2–6 uppercase letters (A-Z only).',
        });
        renameFormWrapper.appendChild(newIdField);

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
        renameFormWrapper.appendChild(formActions);

        // Behaviour
        renameBtn.addEventListener('click', () => {
            renameFormWrapper.hidden = false;
            if (newIdInput) newIdInput.focus();
        });

        cancelFormBtn.addEventListener('click', () => {
            renameFormWrapper.hidden = true;
            if (newIdInput) newIdInput.value = '';
            if (newIdErrorEl) newIdErrorEl.hidden = true;
        });

        saveBtn.addEventListener('click', async () => {
            if (newIdErrorEl) newIdErrorEl.hidden = true;
            if (newIdInput) {
                newIdInput.classList.remove('error');
                newIdInput.removeAttribute('aria-invalid');
            }

            if (!validateRequired(renameFormWrapper, ['newWorkspaceId'])) return;

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

// ---------------------------------------------------------------------------
// Public view entry point
// ---------------------------------------------------------------------------

/**
 * Render the workspace detail view.
 *
 * Fetches workspace metadata, project (for the repositories list), and
 * initial Git status in parallel. Then starts a polling interval that
 * updates badges in-place every {@link POLL_INTERVAL_MS} milliseconds.
 *
 * @param {HTMLElement} container - The `#app` DOM element provided by the router.
 * @param {{ id: string, wid: string }} params - Route parameters.
 * @returns {function(): void} Cleanup function — clears the polling interval.
 *   The router stores and calls this before rendering the next view.
 */
export function renderWorkspaceDetail(container, params) {
    const projectId = params.id;
    const wid       = params.wid;

    let pollingInterval = null;

    // Return the cleanup function immediately so the router can register it
    // even if the async bootstrap hasn't resolved yet.
    const cleanup = () => {
        if (pollingInterval !== null) {
            clearInterval(pollingInterval);
            pollingInterval = null;
        }
    };

    // Show loading state immediately.
    showLoading(container, 'Loading workspace…');

    // Kick off parallel data fetch.
    Promise.all([
        api.workspaces.get(projectId, wid),
        api.projects.get(projectId),
        api.status.get(projectId, wid),
    ]).then(([rawWorkspace, rawProject, statusMap]) => {
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

        container.appendChild(buildHeaderSection(projectId, workspace, isStable));
        const { section: statusSection, tbody } = buildStatusTableSection(repos, statusMap || {});
        container.appendChild(statusSection);

        // Show "Retry Setup" when workspace is initialized but some repos
        // have no status data (likely failed to clone).
        const safeStatusMap = statusMap || {};
        const missingRepos = repos.filter((r) => !safeStatusMap[r.repoId]);
        if (workspace.initialized && missingRepos.length > 0) {
            const retryRow = document.createElement('div');
            retryRow.className = 'workspace-mgmt-row';

            const retryHint = document.createElement('span');
            retryHint.className = 'text-secondary text-sm';
            retryHint.textContent = `${missingRepos.length} ${missingRepos.length === 1 ? 'repository has' : 'repositories have'} no data — clone may have failed.`;
            retryRow.appendChild(retryHint);

            const retryBtn = document.createElement('button');
            retryBtn.type      = 'button';
            retryBtn.className = 'btn btn-secondary btn-sm';
            retryBtn.textContent = 'Retry Setup';
            retryBtn.title = 'Re-run workspace setup to clone missing repositories.';

            retryBtn.addEventListener('click', async () => {
                retryBtn.disabled = true;
                retryBtn.textContent = 'Setting up…';

                try {
                    const result = await api.workspaces.setup(projectId, workspace.id);

                    const failures = (result && result.results || []).filter((r) => !r.success);
                    if (failures.length > 0) {
                        const names = failures.map((f) => f.repositoryId).join(', ');
                        showToast(`Setup complete with errors. Failed to clone: ${names}`, 'warning', 8000);
                    } else {
                        showToast('All repositories cloned successfully.', 'success');
                    }

                    // Re-render
                    const target = `#/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspace.id)}`;
                    if (_router) {
                        _router.navigate(target);
                    } else {
                        location.hash = target;
                    }
                } catch (err) {
                    showToast(err.message || 'Failed to set up workspace.', 'error');
                    retryBtn.disabled = false;
                    retryBtn.textContent = 'Retry Setup';
                }
            });

            retryRow.appendChild(retryBtn);
            container.appendChild(retryRow);
        }

        container.appendChild(buildSwitchBranchesButton(projectId, wid));

        // Start polling only when there are repos to update.
        if (tbody && repos.length > 0) {
            pollingInterval = setInterval(async () => {
                // Stop polling if the container is no longer in the DOM.
                if (!container.isConnected) {
                    cleanup();
                    return;
                }
                try {
                    const fresh = await api.status.get(projectId, wid);
                    if (container.isConnected && fresh) {
                        updateStatusTable(tbody, fresh);
                    }
                } catch {
                    // Silently ignore polling errors — the stale badges remain.
                }
            }, POLL_INTERVAL_MS);
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
