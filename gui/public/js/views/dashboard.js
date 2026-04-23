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
import { clearElement } from '../utils/dom.js';

// ---------------------------------------------------------------------------
// Debounce helper
// ---------------------------------------------------------------------------

/**
 * Return a debounced version of `fn` that delays invocation by `wait` ms.
 *
 * @template {(...args: unknown[]) => void} T
 * @param {T} fn
 * @param {number} wait - Delay in milliseconds.
 * @returns {T}
 */
function debounce(fn, wait) {
    let timer;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), wait);
    };
}

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

    const separator = document.createElement('span');
    separator.className = 'stat-separator';
    separator.textContent = '·';

    stats.appendChild(repoStat);
    stats.appendChild(separator);
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
    clearElement(el);
    const wrapper = document.createElement('div');
    wrapper.className = 'loading-indicator';
    wrapper.setAttribute('aria-live', 'polite');
    wrapper.setAttribute('aria-label', 'Loading projects\u2026');

    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.textContent = 'Loading projects\u2026';

    wrapper.appendChild(spinner);
    wrapper.appendChild(label);
    el.appendChild(wrapper);
}

// ---------------------------------------------------------------------------
// Filter / Sort toolbar
// ---------------------------------------------------------------------------

/**
 * Represents the current filter and sort state for the project list toolbar.
 *
 * This object flows between {@link renderDashboard}, {@link buildFilterToolbar},
 * {@link applyFiltersAndSort}, and {@link renderProjectGrid} — covering both
 * toolbar control rendering and the filter/sort logic applied to the project list.
 *
 * @typedef {Object} FilterState
 * @property {string} search - Free-text search query matched against project names
 *   and descriptions. Empty string means "no search filter applied".
 * @property {string} repoId - ID of the repository to filter by, or `''` to show
 *   projects from all repositories ("All repositories" option). Matches `repo.id`
 *   / `repo.Id` values returned by `api.repositories.list()`.
 * @property {'alpha'|'activity'} sort - Sort order for the project list.
 *   - `'alpha'`    — alphabetical by project name (A → Z). This is the default.
 *   - `'activity'` — most recently active project first (Last Activity order).
 *
 * @example
 * // Default state — no filter, alphabetical sort
 * const filterState = { search: '', repoId: '', sort: 'alpha' };
 *
 * @example
 * // Filter to a specific repo, sorted by last activity
 * const filterState = { search: 'api', repoId: 'backend-repo', sort: 'activity' };
 */

/**
 * Build the filter/sort toolbar for the project list.
 *
 * Fetches `api.repositories.list()` to populate the repository dropdown.
 * If the fetch fails the toolbar renders without the repository dropdown and
 * shows a toast error.
 *
 * @param {FilterState} initialState      - The current filter/sort values.
 * @param {function(FilterState): void} onFilterChange - Callback fired when any
 *   control value changes.
 * @returns {Promise<HTMLElement>}
 */
async function buildFilterToolbar(initialState, onFilterChange) {
    const bar = document.createElement('div');
    bar.className = 'project-filter-toolbar';

    // ---- Current state (mutated as controls change) ----
    const state = { ...initialState };

    // ---- Helper: notify caller ----
    const notify = () => onFilterChange({ ...state });

    // ---- Search label + input ----
    const searchLabel = document.createElement('label');
    searchLabel.className = 'filter-label';
    searchLabel.textContent = 'Search:';
    searchLabel.setAttribute('for', 'project-filter-search');

    const searchInput = document.createElement('input');
    searchInput.type        = 'search';
    searchInput.id          = 'project-filter-search';
    searchInput.className   = 'form-input project-filter-search';
    searchInput.placeholder = 'Search projects\u2026';
    searchInput.value       = state.search;
    searchInput.setAttribute('aria-label', 'Search projects');

    const debouncedSearch = debounce(() => {
        state.search = searchInput.value;
        notify();
    }, 250);
    searchInput.addEventListener('input', debouncedSearch);

    bar.appendChild(searchLabel);
    bar.appendChild(searchInput);

    // ---- Repository filter label + dropdown ----
    let repos = [];
    try {
        repos = await api.repositories.list();
    } catch (err) {
        showToast(err.message || 'Failed to load repositories for filter.', 'error');
    }

    const repoLabel = document.createElement('label');
    repoLabel.className = 'filter-label';
    repoLabel.textContent = 'Repository:';
    repoLabel.setAttribute('for', 'project-filter-repo');

    const repoSelect = document.createElement('select');
    repoSelect.id = 'project-filter-repo';
    repoSelect.className = 'form-select project-filter-repo';
    repoSelect.setAttribute('aria-label', 'Filter by repository');

    if (Array.isArray(repos) && repos.length > 0) {
        const allOpt = document.createElement('option');
        allOpt.value       = '';
        allOpt.textContent = 'All repositories';
        repoSelect.appendChild(allOpt);

        repos.forEach((repo) => {
            const opt = document.createElement('option');
            opt.value       = repo.id || repo.Id || '';
            opt.textContent = repo.name || repo.Name || opt.value;
            if (opt.value === state.repoId) opt.selected = true;
            repoSelect.appendChild(opt);
        });

        repoSelect.addEventListener('change', () => {
            state.repoId = repoSelect.value;
            notify();
        });
    } else {
        const noReposOpt = document.createElement('option');
        noReposOpt.textContent = 'No repositories';
        repoSelect.appendChild(noReposOpt);
        repoSelect.disabled = true;
    }

    bar.appendChild(repoLabel);
    bar.appendChild(repoSelect);

    // ---- Sort label + selector ----
    const sortLabel = document.createElement('label');
    sortLabel.className = 'filter-label';
    sortLabel.textContent = 'Sort:';
    sortLabel.setAttribute('for', 'project-filter-sort');

    const sortSelect = document.createElement('select');
    sortSelect.id = 'project-filter-sort';
    sortSelect.className = 'form-select project-filter-sort';
    sortSelect.setAttribute('aria-label', 'Sort projects');

    const sortOptions = [
        { value: 'alpha',    label: 'Alphabetical' },
        { value: 'activity', label: 'Last Activity' },
    ];

    sortOptions.forEach(({ value, label }) => {
        const opt = document.createElement('option');
        opt.value       = value;
        opt.textContent = label;
        if (value === state.sort) opt.selected = true;
        sortSelect.appendChild(opt);
    });

    sortSelect.addEventListener('change', () => {
        state.sort = sortSelect.value;
        notify();
    });

    bar.appendChild(sortLabel);
    bar.appendChild(sortSelect);

    return bar;
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
// Project list — data cache
// ---------------------------------------------------------------------------

/**
 * Module-level cache of fully-enriched project detail objects.
 * Each entry is `{ fullProject, wsCount }` as returned by the API fetch.
 * Populated by `renderProjectList()` and consumed by `applyFiltersAndSort()`.
 *
 * @type {Array<{ fullProject: Object, wsCount: number }>}
 */
let _allProjects = [];

// ---------------------------------------------------------------------------
// Filter / sort logic
// ---------------------------------------------------------------------------

/**
 * Apply the current filter/sort state to `_allProjects` and return the
 * matching subset in the requested order.
 *
 * Filter rules (all applied together — AND semantics):
 *   - `search`  — case-insensitive substring match against name, ID, and
 *                 description. Empty string means no filter.
 *   - `repoId`  — project must contain a repository whose `id`/`Id` equals
 *                 `repoId`. Empty string means no filter.
 *
 * Sort rules:
 *   - `'alpha'`    — ascending by name (case-insensitive); tiebreaker: project
 *                    ID ascending.
 *   - `'activity'` — descending by `LastActivity` / `lastActivity`; entries
 *                    with `null`/`undefined` activity sort last; tiebreaker:
 *                    name ascending (case-insensitive).
 *
 * @param {FilterState} filterState
 * @returns {Array<{ fullProject: Object, wsCount: number }>}
 */
export function applyFiltersAndSort(filterState, allProjects) {
    const { search, repoId, sort } = filterState;
    const needle = search.trim().toLowerCase();

    let result = allProjects.filter(({ fullProject }) => {
        const id   = (fullProject.Id   || fullProject.id          || '').toLowerCase();
        const name = (fullProject.Name || fullProject.name        || '').toLowerCase();
        const desc = (fullProject.Description || fullProject.description || '').toLowerCase();

        // Search filter — substring match across name, ID, description.
        if (needle && !name.includes(needle) && !id.includes(needle) && !desc.includes(needle)) {
            return false;
        }

        // Repository filter — project must contain the selected repo.
        if (repoId) {
            const repos = Array.isArray(fullProject.Repositories)
                ? fullProject.Repositories
                : (Array.isArray(fullProject.repositories) ? fullProject.repositories : []);
            const hasRepo = repos.some((r) => (r.id || r.Id || '') === repoId);
            if (!hasRepo) return false;
        }

        return true;
    });

    // Sort
    if (sort === 'activity') {
        result = result.slice().sort((a, b) => {
            const aTime = a.fullProject.LastActivity || a.fullProject.lastActivity || null;
            const bTime = b.fullProject.LastActivity || b.fullProject.lastActivity || null;

            // null/undefined sorts last
            if (aTime === null && bTime === null) {
                // tiebreaker: name ascending
                return (a.fullProject.Name || a.fullProject.name || '')
                    .toLowerCase()
                    .localeCompare((b.fullProject.Name || b.fullProject.name || '').toLowerCase());
            }
            if (aTime === null) return 1;
            if (bTime === null) return -1;

            // Descending by activity timestamp
            if (aTime > bTime) return -1;
            if (aTime < bTime) return 1;

            // tiebreaker: name ascending
            return (a.fullProject.Name || a.fullProject.name || '')
                .toLowerCase()
                .localeCompare((b.fullProject.Name || b.fullProject.name || '').toLowerCase());
        });
    } else {
        // 'alpha' — ascending by name (case-insensitive); tiebreaker: project ID ascending.
        // Uses localeCompare() for consistency with the activity-sort tiebreaker above.
        result = result.slice().sort((a, b) => {
            const aName = (a.fullProject.Name || a.fullProject.name || '').toLowerCase();
            const bName = (b.fullProject.Name || b.fullProject.name || '').toLowerCase();
            const nameCmp = aName.localeCompare(bName);
            if (nameCmp !== 0) return nameCmp;
            // tiebreaker: ID ascending
            const aId = (a.fullProject.Id || a.fullProject.id || '').toLowerCase();
            const bId = (b.fullProject.Id || b.fullProject.id || '').toLowerCase();
            return aId.localeCompare(bId);
        });
    }

    return result;
}

// ---------------------------------------------------------------------------
// Project grid renderer
// ---------------------------------------------------------------------------

/**
 * Render a (possibly empty) array of project detail objects into
 * `listContainer`.
 *
 * Shows "No projects match the current filters." when `filtered` is empty but
 * `hasAnyProjects` is `true` (i.e. filters excluded everything).
 * Shows the original "No projects yet." message when there are no projects at all.
 * Otherwise renders the project cards inside a `.project-grid` wrapper.
 *
 * @param {HTMLElement}                                  listContainer
 * @param {Array<{ fullProject: Object, wsCount: number }>} filtered
 * @param {boolean} hasAnyProjects - Whether the unfiltered project list is
 *   non-empty. Used to choose the correct empty-state message.
 */
function renderProjectGrid(listContainer, filtered, hasAnyProjects) {
    clearElement(listContainer);

    if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        if (!hasAnyProjects) {
            empty.textContent = 'No projects yet. Use the "Create Project" button to add one.';
        } else {
            empty.textContent = 'No projects match the current filters.';
        }
        listContainer.appendChild(empty);
        return;
    }

    const grid = document.createElement('div');
    grid.className = 'project-grid';

    filtered.forEach(({ fullProject, wsCount }) => {
        grid.appendChild(buildProjectCard(fullProject, wsCount));
    });

    listContainer.appendChild(grid);
}

// ---------------------------------------------------------------------------
// Project list — fetch + render
// ---------------------------------------------------------------------------

/**
 * Fetch all project data from the API, update `_allProjects`, then apply
 * the current `filterState` and render the result into `listContainer`.
 *
 * Workspace counts are fetched in parallel for each project.  If a workspace
 * fetch fails the count is shown as "0 workspaces" rather than breaking the
 * whole list.
 *
 * @param {HTMLElement} listContainer - Element to render the list into.
 * @param {FilterState} filterState   - Current filter/sort state to apply
 *   after the data is loaded.
 */
async function renderProjectList(listContainer, filterState) {
    showLoading(listContainer);

    let projects;
    try {
        projects = await api.projects.list();
    } catch (err) {
        clearElement(listContainer);
        const errMsg = document.createElement('div');
        errMsg.className = 'empty-state error-state';
        errMsg.textContent = `Failed to load projects: ${err.message}`;
        listContainer.appendChild(errMsg);
        showToast(err.message || 'Failed to load projects.', 'error');
        return;
    }

    if (!Array.isArray(projects) || projects.length === 0) {
        _allProjects = [];
        renderProjectGrid(listContainer, [], false);
        return;
    }

    // Fetch full project data + workspace counts in parallel per project.
    const projectDetails = await Promise.all(
        projects.map(async (project) => {
            const id = project.Id || project.id || '';
            let fullProject = project;
            let wsCount = 0;
            try {
                const [full, workspaces] = await Promise.all([
                    api.projects.get(id),
                    api.workspaces.list(id),
                ]);
                fullProject = full;
                wsCount = Array.isArray(workspaces) ? workspaces.length : 0;
            } catch (_err) {
                // Degrade gracefully — show index data with 0 counts.
            }
            return { fullProject, wsCount };
        }),
    );

    _allProjects = projectDetails;

    const filtered = applyFiltersAndSort(filterState, _allProjects);
    renderProjectGrid(listContainer, filtered, _allProjects.length > 0);
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
    // Project list section (declared early so onFilterChange can reference it)
    // -----------------------------------------------------------------------
    const listContainer = document.createElement('div');
    listContainer.className = 'project-list-container';

    // -----------------------------------------------------------------------
    // Filter / sort toolbar (inserted between header and project list)
    // -----------------------------------------------------------------------

    /** @type {FilterState} */
    const filterState = { search: '', repoId: '', sort: 'alpha' };

    /**
     * Called whenever a toolbar control changes.  Applies the updated
     * filter/sort state to the cached project data without re-fetching.
     *
     * @param {FilterState} newState
     */
    const onFilterChange = (newState) => {
        Object.assign(filterState, newState);
        const filtered = applyFiltersAndSort(filterState, _allProjects);
        renderProjectGrid(listContainer, filtered, _allProjects.length > 0);
    };

    const toolbar = await buildFilterToolbar(filterState, onFilterChange);
    container.appendChild(toolbar);

    // Insert list container after toolbar
    container.appendChild(listContainer);

    // -----------------------------------------------------------------------
    // Create Project section
    // -----------------------------------------------------------------------
    const createSection = buildCreateProjectSection(() => {
        // Re-fetch all project data from the API and re-apply the current
        // filter/sort state so newly created projects appear immediately.
        renderProjectList(listContainer, filterState);
    });
    container.appendChild(createSection);

    // -----------------------------------------------------------------------
    // Initial load
    // -----------------------------------------------------------------------
    await renderProjectList(listContainer, filterState);
}
