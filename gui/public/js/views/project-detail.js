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
// Normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Normalise a project object from the backend (Go-style capitalised keys or
 * lowercase — both are supported).
 *
 * @param {Object} project
 * @returns {{ id: string, name: string, description: string, repositories: string[] }}
 */
function normaliseProject(project) {
    return {
        id:           project.Id          || project.id          || '',
        name:         project.Name        || project.name        || '',
        description:  project.Description || project.description || '',
        repositories: Array.isArray(project.Repositories)
            ? project.Repositories
            : (Array.isArray(project.repositories) ? project.repositories : []),
    };
}

/**
 * Normalise a repository object from the backend.
 *
 * @param {Object} repo
 * @returns {{ id: string, name: string, url: string }}
 */
function normaliseRepo(repo) {
    return {
        id:   repo.Id   || repo.id   || '',
        name: repo.Name || repo.name || '',
        url:  repo.Url  || repo.url  || repo.URL || '',
    };
}

/**
 * Normalise a workspace object from the backend.
 *
 * @param {Object} ws
 * @returns {{ id: string, description: string, createdAt: string }}
 */
function normaliseWorkspace(ws) {
    return {
        id:          ws.Id          || ws.id          || '',
        description: ws.Description || ws.description || '',
        createdAt:   ws.CreatedAt   || ws.createdAt   || ws.created_at || '',
    };
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
// Section builders
// ---------------------------------------------------------------------------

/**
 * Build the project metadata header section.
 * Description is editable inline: clicking Edit shows a textarea; Save calls
 * `api.projects.update()`.
 *
 * @param {{ id: string, name: string, description: string }} project
 * @returns {HTMLElement}
 */
function buildMetaSection(project) {
    const section = document.createElement('section');
    section.className = 'project-meta-section card';

    // Project ID + Name
    const idRow = document.createElement('div');
    idRow.className = 'project-meta-id-row';

    const idLabel = document.createElement('span');
    idLabel.className = 'project-meta-id text-muted';
    idLabel.textContent = `ID: ${project.id}`;

    const nameEl = document.createElement('h2');
    nameEl.className = 'project-meta-name';
    nameEl.textContent = project.name || project.id;

    idRow.appendChild(nameEl);
    idRow.appendChild(idLabel);
    section.appendChild(idRow);

    // Description — read-mode
    const descRow = document.createElement('div');
    descRow.className = 'project-meta-desc-row';

    const descDisplay = document.createElement('p');
    descDisplay.className = 'project-meta-description text-secondary';
    descDisplay.textContent = project.description || 'No description.';

    const editDescBtn = document.createElement('button');
    editDescBtn.type      = 'button';
    editDescBtn.className = 'btn btn-secondary btn-sm';
    editDescBtn.textContent = 'Edit Description';

    descRow.appendChild(descDisplay);
    descRow.appendChild(editDescBtn);
    section.appendChild(descRow);

    // Description — edit-mode (hidden initially)
    const editRow = document.createElement('div');
    editRow.className = 'project-meta-edit-row';
    editRow.hidden = true;

    const descTextarea = document.createElement('textarea');
    descTextarea.className = 'form-textarea';
    descTextarea.rows  = 3;
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

    editDescBtn.addEventListener('click', () => {
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

    const heading = document.createElement('h3');
    heading.className = 'section-title';
    heading.textContent = 'Repositories';
    section.appendChild(heading);

    // Build a map for quick lookup: repoId → { id, name, url }
    const repoMap = new Map(allRepos.map((r) => [r.id, r]));

    // ---- Repo list ----
    if (projectRepoIds.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty-state-inline text-secondary';
        empty.textContent = 'No repositories in this project yet.';
        section.appendChild(empty);
    } else {
        const list = document.createElement('ul');
        list.className = 'repo-list';

        projectRepoIds.forEach((repoId) => {
            const repo = repoMap.get(repoId);
            const li   = document.createElement('li');
            li.className = 'repo-list-item';

            const repoInfo = document.createElement('span');
            repoInfo.className = 'repo-list-info';
            repoInfo.textContent = repo ? `${repo.name || repo.id} (${repo.id})` : repoId;

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

            li.appendChild(repoInfo);
            li.appendChild(removeBtn);
            list.appendChild(li);
        });

        section.appendChild(list);
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
 * Lists workspaces with ID, description, creation date, a link to the
 * workspace detail view, and a Delete button (disabled for STABLE).
 * Includes an "Add Workspace" form.
 *
 * @param {string}   projectId  - Current project ID.
 * @param {Array<{ id: string, description: string, createdAt: string }>} workspaces
 * @param {function(): Promise<void>} onRefresh - Re-renders the entire view.
 * @returns {HTMLElement}
 */
function buildWorkspacesSection(projectId, workspaces, onRefresh) {
    const section = document.createElement('section');
    section.className = 'project-workspaces-section';

    const heading = document.createElement('h3');
    heading.className = 'section-title';
    heading.textContent = 'Workspaces';
    section.appendChild(heading);

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
        ['ID', 'Description', 'Created', 'Actions'].forEach((label) => {
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

            // Actions cell
            const actCell = document.createElement('td');
            actCell.className = 'workspace-actions-cell';

            const isStable = ws.id === 'STABLE';

            const deleteBtn = document.createElement('button');
            deleteBtn.type      = 'button';
            deleteBtn.className = 'btn btn-danger btn-sm';
            deleteBtn.textContent = 'Delete';

            if (isStable) {
                deleteBtn.disabled = true;
                deleteBtn.title    = 'The STABLE workspace cannot be deleted.';
                deleteBtn.classList.add('btn-disabled');
            } else {
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
            }

            actCell.appendChild(deleteBtn);
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
 * Workspace ID must match /^[A-Z]{2,6}$/ (2-6 uppercase letters).
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
        hint: 'Must be 2–6 uppercase letters (A-Z only).',
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

        // Validate format: 2-6 uppercase A-Z only
        if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
            if (wsIdErrorEl) {
                wsIdErrorEl.textContent = 'Must be 2–6 uppercase letters (A-Z only).';
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

    // ---- Page header ----
    const header = document.createElement('div');
    header.className = 'page-header';

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
    header.appendChild(backLink);

    const title = document.createElement('h1');
    title.className = 'page-title';
    title.textContent = normProject.name || normProject.id;
    header.appendChild(title);

    container.appendChild(header);

    // ---- Metadata section ----
    container.appendChild(buildMetaSection(normProject));

    // ---- Repositories section ----
    container.appendChild(
        buildRepositoriesSection(
            normProject.id,
            normProject.repositories,
            normAllRepos,
            refresh,
        ),
    );

    // ---- Workspaces section ----
    container.appendChild(
        buildWorkspacesSection(normProject.id, normWorkspaces, refresh),
    );

    // ---- Danger zone ----
    const dangerZone = document.createElement('div');
    dangerZone.className = 'danger-zone';

    const dangerHeading = document.createElement('h3');
    dangerHeading.className = 'section-title';
    dangerHeading.textContent = 'Danger Zone';
    dangerZone.appendChild(dangerHeading);

    dangerZone.appendChild(buildRenameSection(normProject));
    dangerZone.appendChild(buildDeleteSection(normProject));

    container.appendChild(dangerZone);
}
