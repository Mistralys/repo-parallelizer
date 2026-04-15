/**
 * Project Detail View — Repo Parallelizer GUI.
 *
 * Renders the full detail page for a single project:
 *   - Project metadata (ID, name/description with inline description edit).
 *   - Repositories section: list with per-repo Remove, plus "Add Repository" picker.
 *   - Workspaces section: list with links, per-workspace Delete (STABLE disabled),
 *     and "Add Workspace" form.
 *   - Rename Project action (changes project ID).
 *   - Delete Project action.
 *
 * ## Data fetching
 *
 * On render, `GET /api/projects/:id`, `GET /api/projects/:id/workspaces`, and
 * `GET /api/repositories` are issued in parallel via `Promise.all`. A loading
 * spinner is shown until all three resolve.
 *
 * ## Refresh strategy (full-refresh-on-mutation)
 *
 * After any successful mutation (add/remove repository, add/delete workspace),
 * the view re-renders itself completely by calling `renderProjectDetail`
 * recursively via the internal `refresh()` helper. This triggers three new
 * parallel API calls and rebuilds the full DOM from scratch.
 *
 * Trade-off: simplicity and guaranteed consistency over efficiency. For the
 * current usage scale this is the right default. A targeted section re-render
 * (e.g. refreshing only the repository list) is a deferred optimisation —
 * it would save two redundant requests per mutation but adds stateful diffing
 * complexity.
 *
 * ## Router injection
 *
 * This module exports `setRouter(router)` so that `renderProjectDetail` can
 * call `router.navigate()` on rename and delete without creating a circular
 * import with `app.js`. `app.js` calls `setProjectDetailRouter(router)` (the
 * aliased import) before `router.start()`. The `_router` variable is
 * null-guarded in all three navigation sites so the view remains functional
 * in test contexts where no router is injected.
 *
 * @module project-detail
 */

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { showConfirm } from '../components/confirm-dialog.js';
import { createFormField, validateRequired, WORKSPACE_ID_PATTERN } from '../components/form-helpers.js';
import { normaliseProject, normaliseRepo, normaliseWorkspace } from '../utils/normalise.js';

// ---------------------------------------------------------------------------
// Router reference — injected from app.js via setRouter()
// app.js calls setRouter(router) before router.start() to avoid circular deps.
// ---------------------------------------------------------------------------

/** @type {import('../router.js').Router|null} */
let _router = null;

/**
 * Inject the router instance so project-detail can navigate on rename/delete.
 * Called from app.js before the router starts.
 *
 * @param {import('../router.js').Router} router
 */
export function setRouter(router) {
    _router = router;
}

// ---------------------------------------------------------------------------
// Normalisation helpers — imported from utils/normalise.js
// ---------------------------------------------------------------------------

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
// Section builders
// ---------------------------------------------------------------------------

/**
 * Build the project metadata header section.
 * Description is editable inline: clicking the edit icon shows a textarea;
 * Save calls `api.projects.update()`.
 *
 * @param {{ id: string, name: string, description: string }} project
 * @returns {HTMLElement}
 */
function buildMetaSection(project) {
    const section = document.createElement('section');
    section.className = 'project-meta-section';

    // Top row: name + ID + edit icon
    const topRow = document.createElement('div');
    topRow.className = 'project-meta-top-row';

    const nameEl = document.createElement('h1');
    nameEl.className = 'project-meta-name';
    nameEl.textContent = project.name || project.id;

    const idLabel = document.createElement('span');
    idLabel.className = 'project-meta-id text-muted';
    idLabel.textContent = project.id;

    const editIconBtn = document.createElement('button');
    editIconBtn.type      = 'button';
    editIconBtn.className = 'btn-icon project-meta-edit-icon';
    editIconBtn.title     = 'Edit project description';
    editIconBtn.setAttribute('aria-label', 'Edit project description');
    editIconBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"/></svg>';

    topRow.appendChild(nameEl);
    topRow.appendChild(idLabel);
    topRow.appendChild(editIconBtn);
    section.appendChild(topRow);

    // Description — read-mode
    const descRow = document.createElement('div');
    descRow.className = 'project-meta-desc-row';

    const descDisplay = document.createElement('p');
    descDisplay.className = 'project-meta-description text-secondary';
    descDisplay.textContent = project.description || 'No description.';

    descRow.appendChild(descDisplay);
    section.appendChild(descRow);

    // Description — edit-mode (hidden initially)
    const editRow = document.createElement('div');
    editRow.className = 'project-meta-edit-row';
    editRow.hidden = true;

    const descTextarea = document.createElement('textarea');
    descTextarea.className = 'form-textarea';
    descTextarea.rows  = 2;
    descTextarea.value = project.description;
    descTextarea.setAttribute('aria-label', 'Project description');
    editRow.appendChild(descTextarea);

    const editActions = document.createElement('div');
    editActions.className = 'form-actions';

    const saveDescBtn = document.createElement('button');
    saveDescBtn.type      = 'button';
    saveDescBtn.className = 'btn btn-primary btn-sm';
    saveDescBtn.textContent = 'Save';

    const cancelDescBtn = document.createElement('button');
    cancelDescBtn.type      = 'button';
    cancelDescBtn.className = 'btn btn-secondary btn-sm';
    cancelDescBtn.textContent = 'Cancel';

    editActions.appendChild(saveDescBtn);
    editActions.appendChild(cancelDescBtn);
    editRow.appendChild(editActions);
    section.appendChild(editRow);

    // ---- Behaviour ----

    editIconBtn.addEventListener('click', () => {
        descRow.hidden   = true;
        editRow.hidden   = false;
        descTextarea.value = project.description;
        descTextarea.focus();
    });

    cancelDescBtn.addEventListener('click', () => {
        descRow.hidden = false;
        editRow.hidden = true;
    });

    saveDescBtn.addEventListener('click', async () => {
        const newDesc = descTextarea.value.trim();
        saveDescBtn.disabled = true;
        saveDescBtn.textContent = 'Saving…';

        try {
            await api.projects.update(project.id, { description: newDesc });
            project.description = newDesc;
            descDisplay.textContent = newDesc || 'No description.';
            showToast('Description updated.', 'success');
            editRow.hidden = true;
            descRow.hidden = false;
        } catch (err) {
            showToast(err.message || 'Failed to update description.', 'error');
        } finally {
            saveDescBtn.disabled = false;
            saveDescBtn.textContent = 'Save';
        }
    });

    return section;
}

/**
 * Build the Repositories section for a project.
 *
 * Lists repos currently in the project (cross-referenced with global repo list
 * for name/URL). Provides a Remove button per repo and an "Add Repository"
 * picker that excludes already-added repos.
 *
 * @param {string}   projectId       - Current project ID.
 * @param {string[]} projectRepoIds  - Repo IDs currently in the project.
 * @param {Array<{ id: string, name: string, url: string }>} allRepos
 *   Full global repository list.
 * @param {function(): Promise<void>} onRefresh - Re-renders the entire view.
 * @returns {HTMLElement}
 */
function buildRepositoriesSection(projectId, projectRepoIds, allRepos, onRefresh) {
    const section = document.createElement('section');
    section.className = 'project-repos-section';

    // Build a map for quick lookup: repoId → { id, name, url }
    const repoMap = new Map(allRepos.map((r) => [r.id, r]));

    // ---- Repo table ----
    if (projectRepoIds.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty-state-inline text-secondary';
        empty.textContent = 'No repositories in this project yet.';
        section.appendChild(empty);
    } else {
        const table = document.createElement('table');
        table.className = 'data-table repos-table';

        const thead = document.createElement('thead');
        const htr   = document.createElement('tr');
        ['Name', 'ID', 'Actions'].forEach((label) => {
            const th = document.createElement('th');
            th.textContent = label;
            htr.appendChild(th);
        });
        thead.appendChild(htr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');

        projectRepoIds.forEach((repoId) => {
            const repo = repoMap.get(repoId);
            const tr = document.createElement('tr');

            // Name cell
            const nameCell = document.createElement('td');
            nameCell.textContent = repo ? (repo.name || repo.id) : repoId;
            tr.appendChild(nameCell);

            // ID cell
            const idCell = document.createElement('td');
            idCell.className = 'text-muted font-mono';
            idCell.textContent = repoId;
            tr.appendChild(idCell);

            // Actions cell
            const actCell = document.createElement('td');
            actCell.className = 'actions';

            const removeBtn = document.createElement('button');
            removeBtn.type      = 'button';
            removeBtn.className = 'btn btn-danger btn-sm';
            removeBtn.textContent = 'Remove';

            removeBtn.addEventListener('click', async () => {
                const label = repo ? (repo.name || repo.id) : repoId;
                try {
                    await showConfirm(
                        'Remove Repository',
                        `Remove "${label}" from this project? The repository itself is not deleted.`,
                    );
                } catch {
                    return;
                }

                removeBtn.disabled = true;
                removeBtn.textContent = 'Removing…';

                try {
                    await api.projects.removeRepository(projectId, repoId);
                    showToast(`Repository "${label}" removed from project.`, 'success');
                    await onRefresh();
                } catch (err) {
                    showToast(err.message || 'Failed to remove repository.', 'error');
                    removeBtn.disabled = false;
                    removeBtn.textContent = 'Remove';
                }
            });

            actCell.appendChild(removeBtn);
            tr.appendChild(actCell);
            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        section.appendChild(table);
    }

    // ---- Add Repository picker ----
    const availableRepos = allRepos.filter((r) => !projectRepoIds.includes(r.id));

    if (availableRepos.length > 0) {
        const addRow = document.createElement('div');
        addRow.className = 'add-repo-picker-row';

        const selectEl = document.createElement('select');
        selectEl.className = 'form-select repo-picker-select';

        const defaultOpt = document.createElement('option');
        defaultOpt.value       = '';
        defaultOpt.textContent = '— Select a repository to add —';
        selectEl.appendChild(defaultOpt);

        availableRepos.forEach((r) => {
            const opt = document.createElement('option');
            opt.value       = r.id;
            opt.textContent = r.name ? `${r.name} (${r.id})` : r.id;
            selectEl.appendChild(opt);
        });

        const addBtn = document.createElement('button');
        addBtn.type      = 'button';
        addBtn.className = 'btn btn-primary btn-sm';
        addBtn.textContent = 'Add';

        addRow.appendChild(selectEl);
        addRow.appendChild(addBtn);
        section.appendChild(addRow);

        addBtn.addEventListener('click', async () => {
            const selectedId = selectEl.value;
            if (!selectedId) {
                showToast('Please select a repository to add.', 'error');
                return;
            }

            addBtn.disabled = true;
            addBtn.textContent = 'Adding…';

            try {
                await api.projects.addRepository(projectId, selectedId);
                const label = repoMap.get(selectedId);
                showToast(
                    `Repository "${label ? (label.name || label.id) : selectedId}" added to project.`,
                    'success',
                );
                await onRefresh();
            } catch (err) {
                showToast(err.message || 'Failed to add repository.', 'error');
                addBtn.disabled = false;
                addBtn.textContent = 'Add';
            }
        });
    } else if (allRepos.length > 0) {
        const allAdded = document.createElement('p');
        allAdded.className = 'empty-state-inline text-secondary';
        allAdded.textContent = 'All registered repositories are already in this project.';
        section.appendChild(allAdded);
    }

    return section;
}

/**
 * Build the Workspaces section for a project.
 *
 * Lists workspaces with ID, description, creation date, current branches,
 * a link to the workspace detail view, and a Delete button (disabled for STABLE).
 * Includes an "Add Workspace" form.
 *
 * @param {string}   projectId  - Current project ID.
 * @param {Array<{ id: string, description: string, createdAt: string, initialized: boolean }>} workspaces
 * @param {Record<string, Record<string, Object>|null>} wsStatusMap - Keyed by workspace ID; values are status maps (repoId → GitStatusInfo) or null.
 * @param {Record<string, { healthy: boolean, issues: Array<{ type: string, severity: string, message: string, fixAction: string, repositoryId?: string }> }|null>} wsHealthMap - Keyed by workspace ID; null when health fetch failed or workspace is uninitialized.
 * @param {function(): Promise<void>} onRefresh - Re-renders the entire view.
 * @returns {HTMLElement}
 */
function buildWorkspacesSection(projectId, workspaces, wsStatusMap, wsHealthMap, onRefresh) {
    const section = document.createElement('section');
    section.className = 'project-workspaces-section';

    // ---- Workspace list ----
    if (workspaces.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty-state-inline text-secondary';
        empty.textContent = 'No workspaces yet.';
        section.appendChild(empty);
    } else {
        const table = document.createElement('table');
        table.className = 'data-table workspaces-table';

        const thead = document.createElement('thead');
        const htr   = document.createElement('tr');
        ['ID', 'Description', 'Created', 'Branches', 'Health', 'Actions'].forEach((label) => {
            const th = document.createElement('th');
            th.textContent = label;
            htr.appendChild(th);
        });
        thead.appendChild(htr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');

        workspaces.forEach((ws) => {
            const tr = document.createElement('tr');
            tr.dataset.workspaceId = ws.id;

            // ID + link cell
            const idCell = document.createElement('td');
            const wsLink = document.createElement('a');
            wsLink.href      = `#/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(ws.id)}`;
            wsLink.textContent = ws.id;
            wsLink.className = 'workspace-link';
            if (_router) {
                wsLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    _router.navigate(
                        `#/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(ws.id)}`,
                    );
                });
            }
            idCell.appendChild(wsLink);
            tr.appendChild(idCell);

            // Description cell
            const descCell = document.createElement('td');
            descCell.textContent = ws.description || '—';
            tr.appendChild(descCell);

            // Created-at cell
            const createdCell = document.createElement('td');
            createdCell.className = 'text-muted';
            if (ws.createdAt) {
                try {
                    createdCell.textContent = new Date(ws.createdAt).toLocaleDateString();
                } catch {
                    createdCell.textContent = ws.createdAt;
                }
            } else {
                createdCell.textContent = '—';
            }
            tr.appendChild(createdCell);

            // Branches cell — aggregated current branches across all repos in this workspace
            const branchesCell = document.createElement('td');
            branchesCell.className = 'workspace-branches-cell font-mono text-muted';
            const repoStatuses = wsStatusMap[ws.id];
            if (repoStatuses && typeof repoStatuses === 'object') {
                const branches = Object.values(repoStatuses)
                    .map((s) => s && s.currentBranch)
                    .filter(Boolean);
                const unique = [...new Set(branches)];
                branchesCell.textContent = unique.length > 0 ? unique.join(', ') : '—';
            } else {
                branchesCell.textContent = '—';
            }
            tr.appendChild(branchesCell);

            // Health cell — badge shown only for initialized workspaces with issues.
            // Uninitialized workspaces and healthy workspaces render an empty cell.
            const healthCell = document.createElement('td');
            healthCell.className = 'workspace-health-cell';
            if (ws.initialized) {
                const healthReport = wsHealthMap[ws.id];
                if (
                    healthReport &&
                    !healthReport.healthy &&
                    Array.isArray(healthReport.issues) &&
                    healthReport.issues.length > 0
                ) {
                    const badge = document.createElement('span');
                    badge.className = 'health-badge';

                    const icon = document.createElement('span');
                    icon.setAttribute('aria-hidden', 'true');
                    icon.textContent = '\u26a0';
                    badge.appendChild(icon);

                    const label = document.createElement('span');
                    const n = healthReport.issues.length;
                    label.textContent = `${n} ${n === 1 ? 'issue' : 'issues'}`;
                    badge.appendChild(label);

                    healthCell.appendChild(badge);
                }
            }
            tr.appendChild(healthCell);

            // Actions cell
            const actCell = document.createElement('td');
            actCell.className = 'workspace-actions-cell';

            const isStable = ws.id === 'STABLE';

            if (!isStable) {
                const deleteBtn = document.createElement('button');
                deleteBtn.type      = 'button';
                deleteBtn.className = 'btn btn-danger btn-sm';
                deleteBtn.textContent = 'Delete';

                deleteBtn.addEventListener('click', async () => {
                    try {
                        await showConfirm(
                            'Delete Workspace',
                            `Delete workspace "${ws.id}"? All cloned repositories in this workspace will be permanently removed. This action cannot be undone.`,
                        );
                    } catch {
                        return;
                    }

                    deleteBtn.disabled    = true;
                    deleteBtn.textContent = 'Deleting…';

                    try {
                        await api.workspaces.delete(projectId, ws.id);
                        showToast(`Workspace "${ws.id}" deleted.`, 'success');
                        await onRefresh();
                    } catch (err) {
                        showToast(err.message || 'Failed to delete workspace.', 'error');
                        deleteBtn.disabled    = false;
                        deleteBtn.textContent = 'Delete';
                    }
                });

                actCell.appendChild(deleteBtn);
            }
            tr.appendChild(actCell);

            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        section.appendChild(table);
    }

    // ---- Add Workspace form ----
    const addSection = buildAddWorkspaceForm(projectId, onRefresh);
    section.appendChild(addSection);

    return section;
}

/**
 * Build the "Add Workspace" collapsible form.
 *
 * Workspace ID must match /^[A-Z]{2,10}$/ (2-10 uppercase letters).
 *
 * @param {string}   projectId
 * @param {function(): Promise<void>} onSuccess
 * @returns {HTMLElement}
 */
function buildAddWorkspaceForm(projectId, onSuccess) {
    const wrapper = document.createElement('div');
    wrapper.className = 'add-workspace-wrapper';

    const toggleBtn = document.createElement('button');
    toggleBtn.type      = 'button';
    toggleBtn.className = 'btn btn-secondary btn-sm';
    toggleBtn.textContent = '+ Add Workspace';
    wrapper.appendChild(toggleBtn);

    const formWrapper = document.createElement('div');
    formWrapper.className = 'add-workspace-form-wrapper';
    formWrapper.hidden = true;
    wrapper.appendChild(formWrapper);

    const form = document.createElement('form');
    form.className = 'add-workspace-form card';
    form.noValidate = true;

    const formTitle = document.createElement('h4');
    formTitle.className = 'form-section-title';
    formTitle.textContent = 'New Workspace';
    form.appendChild(formTitle);

    const wsIdField = createFormField('Workspace ID', 'text', 'workspaceId', {
        required: true,
        placeholder: 'e.g. DEV or FEATURE',
        hint: 'Must be 2–10 uppercase letters (A-Z only).',
    });
    form.appendChild(wsIdField);

    const descField = createFormField('Description', 'textarea', 'description', {
        placeholder: 'Optional — short description.',
        rows: 2,
    });
    form.appendChild(descField);

    // Inline validation error area for workspaceId format
    const wsIdInput = wsIdField.querySelector('[name="workspaceId"]');
    const wsIdErrorEl = wsIdField.querySelector('.field-error');

    const actions = document.createElement('div');
    actions.className = 'form-actions';

    const submitBtn = document.createElement('button');
    submitBtn.type      = 'submit';
    submitBtn.className = 'btn btn-primary btn-sm';
    submitBtn.textContent = 'Create';

    const cancelBtn = document.createElement('button');
    cancelBtn.type      = 'button';
    cancelBtn.className = 'btn btn-secondary btn-sm';
    cancelBtn.textContent = 'Cancel';

    actions.appendChild(submitBtn);
    actions.appendChild(cancelBtn);
    form.appendChild(actions);
    formWrapper.appendChild(form);

    // ---- Behaviour ----

    toggleBtn.addEventListener('click', () => {
        formWrapper.hidden = !formWrapper.hidden;
        if (!formWrapper.hidden && wsIdInput) wsIdInput.focus();
    });

    cancelBtn.addEventListener('click', () => {
        form.reset();
        formWrapper.hidden = true;
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!validateRequired(form, ['workspaceId'])) return;

        const workspaceId = wsIdInput ? wsIdInput.value.trim() : '';

        // Validate format: 2-10 uppercase A-Z only
        if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
            if (wsIdErrorEl) {
                wsIdErrorEl.textContent = 'Must be 2–10 uppercase letters (A-Z only).';
                wsIdErrorEl.hidden = false;
            }
            if (wsIdInput) {
                wsIdInput.classList.add('error');
                wsIdInput.setAttribute('aria-invalid', 'true');
                wsIdInput.focus();
            }
            return;
        }

        const description = form.querySelector('[name="description"]').value.trim();

        submitBtn.disabled = true;
        submitBtn.textContent = 'Creating…';

        try {
            await api.workspaces.create(projectId, {
                workspaceId,
                description: description || undefined,
            });
            showToast(`Workspace "${workspaceId}" created.`, 'success');
            form.reset();
            formWrapper.hidden = true;
            await onSuccess();
        } catch (err) {
            showToast(err.message || 'Failed to create workspace.', 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create';
        }
    });

    return wrapper;
}

/**
 * Build the "Rename Project" action section.
 *
 * Shows a text input for the new ID plus a confirmation dialog explaining
 * the consequences (filesystem rename).  On success, navigates to the new URL.
 *
 * @param {{ id: string, name: string }} project
 * @returns {HTMLElement}
 */
function buildRenameSection(project) {
    const section = document.createElement('section');
    section.className = 'project-rename-section card danger-zone-section';

    const heading = document.createElement('h3');
    heading.className = 'section-title danger-title';
    heading.textContent = 'Rename Project';
    section.appendChild(heading);

    const desc = document.createElement('p');
    desc.className = 'text-secondary';
    desc.textContent =
        'Changing the project ID renames the underlying directory on the filesystem and updates all references. ' +
        'Existing workspace links will stop working until updated.';
    section.appendChild(desc);

    const row = document.createElement('div');
    row.className = 'rename-row';

    const newIdInput = document.createElement('input');
    newIdInput.type        = 'text';
    newIdInput.className   = 'form-input rename-input';
    newIdInput.placeholder = 'New project ID';
    newIdInput.setAttribute('aria-label', 'New project ID');
    row.appendChild(newIdInput);

    const renameBtn = document.createElement('button');
    renameBtn.type      = 'button';
    renameBtn.className = 'btn btn-warning';
    renameBtn.textContent = 'Rename…';
    row.appendChild(renameBtn);

    section.appendChild(row);

    renameBtn.addEventListener('click', async () => {
        const newId = newIdInput.value.trim();
        if (!newId) {
            newIdInput.focus();
            showToast('Please enter a new project ID.', 'error');
            return;
        }

        if (newId === project.id) {
            showToast('The new ID is the same as the current ID.', 'error');
            return;
        }

        try {
            await showConfirm(
                'Rename Project',
                `Rename project "${project.id}" to "${newId}"? ` +
                `This renames the directory on disk and changes the URL. ` +
                `All existing workspace links will use the new project ID.`,
            );
        } catch {
            return;
        }

        renameBtn.disabled = true;
        renameBtn.textContent = 'Renaming…';

        try {
            await api.projects.rename(project.id, newId);
            showToast(`Project renamed to "${newId}".`, 'success');
            if (_router) {
                _router.navigate(`#/projects/${encodeURIComponent(newId)}`);
            }
        } catch (err) {
            showToast(err.message || 'Failed to rename project.', 'error');
            renameBtn.disabled = false;
            renameBtn.textContent = 'Rename…';
        }
    });

    return section;
}

/**
 * Build the "Delete Project" action section.
 *
 * Shows a strong warning and confirmation dialog before deletion.
 * On success, navigates back to the dashboard (#/).
 *
 * @param {{ id: string, name: string }} project
 * @returns {HTMLElement}
 */
function buildDeleteSection(project) {
    const section = document.createElement('section');
    section.className = 'project-delete-section card danger-zone-section';

    const heading = document.createElement('h3');
    heading.className = 'section-title danger-title';
    heading.textContent = 'Delete Project';
    section.appendChild(heading);

    const desc = document.createElement('p');
    desc.className = 'text-secondary';
    desc.textContent =
        'Permanently deletes this project and all its workspaces from the filesystem. ' +
        'This action cannot be undone.';
    section.appendChild(desc);

    const deleteBtn = document.createElement('button');
    deleteBtn.type      = 'button';
    deleteBtn.className = 'btn btn-danger';
    deleteBtn.textContent = 'Delete Project…';
    section.appendChild(deleteBtn);

    deleteBtn.addEventListener('click', async () => {
        try {
            await showConfirm(
                'Delete Project',
                `Permanently delete project "${project.name || project.id}"? ` +
                `All workspaces and cloned repositories will be removed from disk. ` +
                `This action cannot be undone.`,
            );
        } catch {
            return;
        }

        deleteBtn.disabled = true;
        deleteBtn.textContent = 'Deleting…';

        try {
            await api.projects.delete(project.id);
            showToast(`Project "${project.name || project.id}" deleted.`, 'success');
            if (_router) {
                _router.navigate('#/');
            }
        } catch (err) {
            showToast(err.message || 'Failed to delete project.', 'error');
            deleteBtn.disabled = false;
            deleteBtn.textContent = 'Delete Project…';
        }
    });

    return section;
}

// ---------------------------------------------------------------------------
// Public export — view function
// ---------------------------------------------------------------------------

/**
 * Render the Project Detail view.
 *
 * @param {HTMLElement} container - The `#app` root element.
 * @param {Object}      params    - Route params — expects `params.id`.
 */
export async function renderProjectDetail(container, params) {
    const projectId = decodeURIComponent(params.id || '');

    // -----------------------------------------------------------------------
    // Show loading state while fetching data
    // -----------------------------------------------------------------------
    showLoading(container, 'Loading project…');

    // -----------------------------------------------------------------------
    // Data fetching — all three in parallel
    // -----------------------------------------------------------------------
    let project, workspaces, allRepos;
    try {
        [project, workspaces, allRepos] = await Promise.all([
            api.projects.get(projectId),
            api.workspaces.list(projectId),
            api.repositories.list(),
        ]);
    } catch (err) {
        container.innerHTML = '';
        const errMsg = document.createElement('div');
        errMsg.className = 'empty-state error-state';
        errMsg.textContent = `Failed to load project: ${err.message}`;
        container.appendChild(errMsg);
        showToast(err.message || 'Failed to load project.', 'error');
        return;
    }

    const normProject    = normaliseProject(project);
    const normWorkspaces = Array.isArray(workspaces)
        ? workspaces.map(normaliseWorkspace)
        : [];
    const normAllRepos   = Array.isArray(allRepos)
        ? allRepos.map(normaliseRepo)
        : [];

    // -----------------------------------------------------------------------
    // Fetch workspace statuses for the branches column (best-effort)
    // -----------------------------------------------------------------------
    /** @type {Record<string, Record<string, Object>|null>} */
    const wsStatusMap = {};
    /** @type {Record<string, { healthy: boolean, issues: Array }|null>} */
    const wsHealthMap = {};
    const initializedWs = normWorkspaces.filter((ws) => ws.initialized);
    if (initializedWs.length > 0) {
        const [statusResults, healthResults] = await Promise.all([
            Promise.allSettled(
                initializedWs.map((ws) => api.status.get(projectId, ws.id)),
            ),
            Promise.allSettled(
                initializedWs.map((ws) => api.workspaces.health(projectId, ws.id)),
            ),
        ]);
        initializedWs.forEach((ws, i) => {
            wsStatusMap[ws.id] = statusResults[i].status === 'fulfilled'
                ? statusResults[i].value
                : null;
            wsHealthMap[ws.id] = healthResults[i].status === 'fulfilled'
                ? healthResults[i].value
                : null;
        });
    }

    // -----------------------------------------------------------------------
    // Re-render helper — re-fetches all data and re-renders the view
    // -----------------------------------------------------------------------
    async function refresh() {
        container.innerHTML = '';
        await renderProjectDetail(container, params);
    }

    // -----------------------------------------------------------------------
    // Clear loading state; build the real UI
    // -----------------------------------------------------------------------
    container.innerHTML = '';

    // ---- Page header (back link only — name is in the meta section) ----
    const backLink = document.createElement('a');
    backLink.href      = '#/';
    backLink.className = 'back-link text-muted';
    backLink.textContent = '← Projects';
    if (_router) {
        backLink.addEventListener('click', (e) => {
            e.preventDefault();
            _router.navigate('#/');
        });
    }
    container.appendChild(backLink);

    // ---- Metadata section ----
    container.appendChild(buildMetaSection(normProject));

    // ---- Tab navigation ----
    const tabNav = document.createElement('nav');
    tabNav.className = 'tab-nav';
    tabNav.setAttribute('role', 'tablist');

    const tabs = [
        { id: 'workspaces', label: 'Workspaces' },
        { id: 'repositories', label: 'Repositories' },
        { id: 'danger', label: 'Danger Zone' },
    ];

    const panels = {};

    tabs.forEach((tab, index) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tab-btn' + (index === 0 ? ' active' : '');
        btn.textContent = tab.label;
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
        btn.setAttribute('aria-controls', `tab-panel-${tab.id}`);
        btn.dataset.tab = tab.id;
        tabNav.appendChild(btn);

        const panel = document.createElement('div');
        panel.id = `tab-panel-${tab.id}`;
        panel.className = 'tab-panel' + (index === 0 ? ' active' : '');
        panel.setAttribute('role', 'tabpanel');
        panels[tab.id] = panel;
    });

    tabNav.addEventListener('click', (e) => {
        const btn = e.target.closest('.tab-btn');
        if (!btn) return;
        const tabId = btn.dataset.tab;

        tabNav.querySelectorAll('.tab-btn').forEach((b) => {
            b.classList.remove('active');
            b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');

        Object.values(panels).forEach((p) => p.classList.remove('active'));
        panels[tabId].classList.add('active');
    });

    container.appendChild(tabNav);

    // ---- Repositories panel ----
    panels.repositories.appendChild(
        buildRepositoriesSection(
            normProject.id,
            normProject.repositories,
            normAllRepos,
            refresh,
        ),
    );
    container.appendChild(panels.repositories);

    // ---- Workspaces panel ----
    panels.workspaces.appendChild(
        buildWorkspacesSection(normProject.id, normWorkspaces, wsStatusMap, wsHealthMap, refresh),
    );
    container.appendChild(panels.workspaces);

    // ---- Danger zone panel ----
    const dangerZone = document.createElement('div');
    dangerZone.className = 'danger-zone';

    dangerZone.appendChild(buildRenameSection(normProject));
    dangerZone.appendChild(buildDeleteSection(normProject));

    panels.danger.appendChild(dangerZone);
    container.appendChild(panels.danger);
}
