/**
 * Dashboard View — Repo Parallelizer GUI.
 *
 * Renders the application's landing page: a list of all projects (with repo
 * and workspace counts) and a "Create Project" quick-action form.
 *
 * @param {HTMLElement} container - The `#app` root element supplied by the router.
 * @param {Object}      _params   - Route params (none for this route).
 */

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { createFormField, validateRequired } from '../components/form-helpers.js';

// ---------------------------------------------------------------------------
// Router instance — imported lazily to avoid circular-dependency issues.
// app.js sets this via setRouter() immediately after instantiation.
// ---------------------------------------------------------------------------

/** @type {import('../router.js').Router|null} */
let _router = null;

/**
 * Inject the router instance so the dashboard can call `router.navigate()`.
 * Called from app.js before the router starts.
 *
 * @param {import('../router.js').Router} router
 */
export function setRouter(router) {
    _router = router;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a single project card DOM element.
 *
 * @param {{ id?: string, Id?: string, Name?: string, name?: string,
 *           Description?: string, description?: string,
 *           Repositories?: Array }} project
 * @param {number} workspaceCount
 * @returns {HTMLElement}
 */
function buildProjectCard(project, workspaceCount) {
    // The backend may use either capitalised or lowercase keys — normalise.
    const id          = project.Id          || project.id          || '';
    const name        = project.Name        || project.name        || id;
    const description = project.Description || project.description || '';
    const repoCount   = Array.isArray(project.Repositories)
        ? project.Repositories.length
        : (Array.isArray(project.repositories) ? project.repositories.length : 0);

    const card = document.createElement('div');
    card.className = 'card project-card';

    // Header row: name + navigate link
    const header = document.createElement('div');
    header.className = 'card-header';

    const titleLink = document.createElement('a');
    titleLink.className = 'project-card-title';
    titleLink.href = `#/projects/${encodeURIComponent(id)}`;
    titleLink.textContent = name;
    titleLink.addEventListener('click', (e) => {
        e.preventDefault();
        if (_router) {
            _router.navigate(`#/projects/${encodeURIComponent(id)}`);
        }
    });

    const projectId = document.createElement('span');
    projectId.className = 'project-card-id text-muted';
    projectId.textContent = id;

    header.appendChild(titleLink);
    header.appendChild(projectId);
    card.appendChild(header);

    // Optional description
    if (description) {
        const desc = document.createElement('p');
        desc.className = 'project-card-description text-secondary';
        desc.textContent = description;
        card.appendChild(desc);
    }

    // Stats row
    const stats = document.createElement('div');
    stats.className = 'project-card-stats';

    const repoStat = document.createElement('span');
    repoStat.className = 'stat-chip';
    repoStat.textContent = `${repoCount} ${repoCount === 1 ? 'repository' : 'repositories'}`;

    const wsStat = document.createElement('span');
    wsStat.className = 'stat-chip';
    wsStat.textContent = `${workspaceCount} ${workspaceCount === 1 ? 'workspace' : 'workspaces'}`;

    stats.appendChild(repoStat);
    stats.appendChild(wsStat);
    card.appendChild(stats);

    return card;
}

/**
 * Render a loading skeleton inside a container element.
 *
 * @param {HTMLElement} el
 */
function showLoading(el) {
    el.innerHTML = `
        <div class="loading-indicator" aria-live="polite" aria-label="Loading projects…">
            <span class="spinner" aria-hidden="true"></span>
            <span>Loading projects…</span>
        </div>
    `;
}

// ---------------------------------------------------------------------------
// Create Project form
// ---------------------------------------------------------------------------

/**
 * Build and return the "Create Project" inline form section.
 * When submitted successfully, `onSuccess` is called so the caller can
 * re-render the project list.
 *
 * @param {function(): void} onSuccess
 * @returns {HTMLElement}
 */
function buildCreateProjectSection(onSuccess) {
    const section = document.createElement('section');
    section.className = 'create-project-section';

    // Toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn btn-primary';
    toggleBtn.textContent = '+ Create Project';
    section.appendChild(toggleBtn);

    // Collapsible form wrapper (hidden by default)
    const formWrapper = document.createElement('div');
    formWrapper.className = 'create-project-form-wrapper';
    formWrapper.hidden = true;
    section.appendChild(formWrapper);

    // Form
    const form = document.createElement('form');
    form.className = 'create-project-form card';
    form.noValidate = true;

    const formTitle = document.createElement('h3');
    formTitle.className = 'form-section-title';
    formTitle.textContent = 'New Project';
    form.appendChild(formTitle);

    const nameField = createFormField('Name', 'text', 'name', {
        required: true,
        placeholder: 'e.g. my-project',
    });
    form.appendChild(nameField);

    const descField = createFormField('Description', 'textarea', 'description', {
        placeholder: 'Optional — short description of the project.',
        rows: 2,
    });
    form.appendChild(descField);

    // Action row
    const actions = document.createElement('div');
    actions.className = 'form-actions';

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'btn btn-primary';
    submitBtn.textContent = 'Create';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = 'Cancel';

    actions.appendChild(submitBtn);
    actions.appendChild(cancelBtn);
    form.appendChild(actions);

    formWrapper.appendChild(form);

    // ---------------------------------------------------------------------------
    // Behaviour
    // ---------------------------------------------------------------------------

    // Toggle form visibility
    toggleBtn.addEventListener('click', () => {
        formWrapper.hidden = !formWrapper.hidden;
        if (!formWrapper.hidden) {
            const nameInput = form.querySelector('[name="name"]');
            if (nameInput) nameInput.focus();
        }
    });

    cancelBtn.addEventListener('click', () => {
        form.reset();
        formWrapper.hidden = true;
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!validateRequired(form, ['name'])) return;

        const name        = form.querySelector('[name="name"]').value.trim();
        const description = form.querySelector('[name="description"]').value.trim();

        submitBtn.disabled = true;
        submitBtn.textContent = 'Creating…';

        try {
            await api.projects.create({ name, description: description || undefined });
            showToast(`Project "${name}" created successfully.`, 'success');
            form.reset();
            formWrapper.hidden = true;
            onSuccess();
        } catch (err) {
            showToast(err.message || 'Failed to create project.', 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create';
        }
    });

    return section;
}

// ---------------------------------------------------------------------------
// Project list
// ---------------------------------------------------------------------------

/**
 * Fetch and render the project list into `listContainer`.
 *
 * Workspace counts are fetched in parallel for each project.  If a workspace
 * fetch fails the count is shown as "0 workspaces" rather than breaking the whole list.
 *
 * @param {HTMLElement} listContainer - Element to render the list into.
 */
async function renderProjectList(listContainer) {
    showLoading(listContainer);

    let projects;
    try {
        projects = await api.projects.list();
    } catch (err) {
        listContainer.innerHTML = '';
        const errMsg = document.createElement('div');
        errMsg.className = 'empty-state error-state';
        errMsg.textContent = `Failed to load projects: ${err.message}`;
        listContainer.appendChild(errMsg);
        showToast(err.message || 'Failed to load projects.', 'error');
        return;
    }

    listContainer.innerHTML = '';

    if (!Array.isArray(projects) || projects.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No projects yet. Use the "Create Project" button to add one.';
        listContainer.appendChild(empty);
        return;
    }

    // Fetch workspace counts in parallel; failures degrade gracefully.
    const workspaceCounts = await Promise.all(
        projects.map(async (project) => {
            const id = project.Id || project.id || '';
            try {
                const workspaces = await api.workspaces.list(id);
                return Array.isArray(workspaces) ? workspaces.length : 0;
            } catch (_err) {
                return 0;
            }
        }),
    );

    const grid = document.createElement('div');
    grid.className = 'project-grid';

    projects.forEach((project, index) => {
        grid.appendChild(buildProjectCard(project, workspaceCounts[index]));
    });

    listContainer.appendChild(grid);
}

// ---------------------------------------------------------------------------
// Public export — view function
// ---------------------------------------------------------------------------

/**
 * Render the dashboard view.
 *
 * @param {HTMLElement} container - The `#app` root element.
 * @param {Object}      _params   - Route params (unused).
 */
export async function renderDashboard(container, _params) {
    // -----------------------------------------------------------------------
    // Page header
    // -----------------------------------------------------------------------
    const header = document.createElement('div');
    header.className = 'page-header';

    const title = document.createElement('h1');
    title.textContent = 'Projects';
    header.appendChild(title);

    container.appendChild(header);

    // -----------------------------------------------------------------------
    // Project list section
    // -----------------------------------------------------------------------
    const listContainer = document.createElement('div');
    listContainer.className = 'project-list-container';
    container.appendChild(listContainer);

    // -----------------------------------------------------------------------
    // Create Project section
    // -----------------------------------------------------------------------
    const createSection = buildCreateProjectSection(() => {
        // Re-render the project list after a successful creation.
        renderProjectList(listContainer);
    });
    container.appendChild(createSection);

    // -----------------------------------------------------------------------
    // Initial load
    // -----------------------------------------------------------------------
    await renderProjectList(listContainer);
}
