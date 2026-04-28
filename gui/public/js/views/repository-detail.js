/**
 * Repository Detail View — Repo Parallelizer GUI.
 *
 * Renders the Repository Overview page at `#/repositories/:id`, showing a
 * table of every workspace across every project that contains the given
 * repository. Each row displays contextual Project and Workspace columns
 * alongside the shared Branch, Status, and Actions cells.
 *
 * ## Data loading flow
 *
 * 1. `api.repositories.get(id)`  — fetch repository metadata (name, URL).
 * 2. `api.projects.list()`       — fetch all projects.
 * 3. Per project: `api.projects.get(pid)` — filter to those containing repoId.
 * 4. Per matching project: `api.workspaces.list(pid)` — list workspaces.
 * 5. Per workspace: `api.status.get(pid, wid)` — extract the single repo's status.
 * 6. `api.config.webserverUrl.get()` — fetch webserver URL once.
 *
 * Steps 2–5 use `Promise.allSettled` so individual project/workspace fetch
 * failures do not abort the entire load. Failed fetches are silently skipped;
 * when at least one fetch failed but others succeeded a warning toast is shown.
 *
 * ## Router injection
 *
 * Exports `setRouter(router)` so that `app.js` can inject the router for
 * programmatic navigation. The `_router` variable is null-guarded everywhere.
 *
 * ## No polling
 *
 * This view does not auto-poll (refreshing all workspaces across all projects
 * on a timer would be too expensive). A manual "Refresh" button force-fetches
 * all status data and updates rows in-place.
 *
 * @module repository-detail
 */

import { api }               from '../api.js';
import { showToast }         from '../components/toast.js';
import { buildRepoStatusCells, updateRepoStatusCells } from '../components/repo-status-cells.js';
import { normaliseRepo, normaliseProject, normaliseWorkspace } from '../utils/normalise.js';
import { STABLE_WS_ID, APP_NAME_SHORT } from '../utils/constants.js';
import { clearElement } from '../utils/dom.js';

// ---------------------------------------------------------------------------
// Router reference — injected from app.js via setRouter()
// ---------------------------------------------------------------------------

/** @type {import('../router.js').Router|null} */
let _router = null;

/**
 * Inject the router instance so repository-detail can navigate programmatically.
 * Called from `app.js` before the router starts.
 *
 * @param {import('../router.js').Router} router
 */
export function setRouter(router) {
    _router = router;
}

// ---------------------------------------------------------------------------
// Constants
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
    clearElement(el);
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
// Row descriptor type
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} WorkspaceRowDescriptor
 * @property {string}      pid           - Project ID.
 * @property {string}      projectName   - Human-readable project name.
 * @property {string}      wid           - Workspace ID.
 * @property {boolean}     isStable      - Whether this is the STABLE workspace.
 * @property {boolean}     initialized   - Whether the workspace has been set up.
 * @property {Object|null} statusInfo    - Git status for this repo in this workspace.
 */

// ---------------------------------------------------------------------------
// Data loading helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all workspaces for matching projects and collect status data for the
 * given repository. Uses `Promise.allSettled` at each fan-out level so that
 * individual fetch failures do not abort the entire load.
 *
 * @param {string}   repoId       - The repository ID to look for.
 * @param {Object[]} allProjects  - Raw project list from `api.projects.list()`.
 * @returns {Promise<{ rows: WorkspaceRowDescriptor[], anyFailed: boolean }>}
 */
async function loadWorkspaceRows(repoId, allProjects) {
    let anyFailed = false;

    // Step 1: Fetch full project data for all projects in parallel.
    const projectResults = await Promise.allSettled(
        allProjects.map((p) => {
            const pid = p.Id || p.id || '';
            return api.projects.get(pid).then((full) => ({ pid, full }));
        }),
    );

    // Step 2: Filter projects that contain this repo.
    const matchingProjects = [];
    for (const result of projectResults) {
        if (result.status === 'rejected') {
            anyFailed = true;
            continue;
        }
        const { pid, full } = result.value;
        const project = normaliseProject(full);
        const contains = project.repositories.some((r) => {
            const rid = (typeof r === 'string') ? r : (r.Id || r.id || r.RepositoryId || r.repositoryId || '');
            return rid === repoId;
        });
        if (contains) {
            matchingProjects.push({ pid, project });
        }
    }

    // Step 3: Fetch workspaces for each matching project in parallel.
    const workspaceResults = await Promise.allSettled(
        matchingProjects.map(({ pid }) =>
            api.workspaces.list(pid).then((wsList) => ({ pid, wsList })),
        ),
    );

    // Step 4: Fetch status per workspace in parallel.
    const statusFetchTasks = [];
    for (const result of workspaceResults) {
        if (result.status === 'rejected') {
            anyFailed = true;
            continue;
        }
        const { pid, wsList } = result.value;
        const projectName = matchingProjects.find((mp) => mp.pid === pid)?.project.name || pid;

        for (const rawWs of (wsList || [])) {
            const ws = normaliseWorkspace(rawWs);
            const wid = ws.id;
            if (!wid) continue;

            statusFetchTasks.push(
                api.status.get(pid, wid)
                    .then((statusMap) => ({
                        pid,
                        projectName,
                        wid,
                        isStable:    wid === STABLE_WS_ID,
                        initialized: ws.initialized,
                        statusInfo:  (statusMap && statusMap[repoId]) ? statusMap[repoId] : null,
                    }))
                    .catch(() => {
                        // Status fetch failed — include the row but without status data.
                        return {
                            pid,
                            projectName,
                            wid,
                            isStable:    wid === STABLE_WS_ID,
                            initialized: ws.initialized,
                            statusInfo:  null,
                        };
                    }),
            );
        }
    }

    const statusResults = await Promise.allSettled(statusFetchTasks);

    const rows = [];
    for (const result of statusResults) {
        if (result.status === 'rejected') {
            anyFailed = true;
            continue;
        }
        rows.push(result.value);
    }

    return { rows, anyFailed };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a Date as a human-readable relative string.
 * e.g. "just now", "3 minutes ago", "2 hours ago", "1 day ago".
 *
 * @param {Date} date
 * @returns {string}
 */
function formatRelativeTime(date) {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
}

// ---------------------------------------------------------------------------
// DOM builders
// ---------------------------------------------------------------------------

/**
 * Build the page header section.
 *
 * Contains:
 *   - A back link to `#/repositories`.
 *   - The repository name as the page title.
 *   - Repository ID and URL (URL as an external `<a>`).
 *   - A "Refresh" button (wired by the caller after construction).
 *
 * @param {{ id: string, name: string, url: string }} repo
 * @returns {{ header: HTMLElement, refreshBtn: HTMLButtonElement }}
 */
function buildHeader(repo) {
    const header = document.createElement('div');
    header.className = 'repository-detail-header';

    // Back link
    const backNav = document.createElement('nav');
    backNav.className = 'breadcrumb back-link text-muted';
    backNav.setAttribute('aria-label', 'Breadcrumb');

    const backLink = document.createElement('a');
    backLink.href      = '#/repositories';
    backLink.className = 'breadcrumb-link';
    backLink.textContent = '← Repositories';
    if (_router) {
        backLink.addEventListener('click', (e) => {
            e.preventDefault();
            _router.navigate('#/repositories');
        });
    }
    backNav.appendChild(backLink);
    header.appendChild(backNav);

    // Title row
    const titleRow = document.createElement('div');
    titleRow.className = 'repository-meta-top-row';

    const titleEl = document.createElement('h1');
    titleEl.className   = 'project-meta-name';
    titleEl.textContent = repo.name || repo.id;
    titleRow.appendChild(titleEl);

    // ID hint (only when name differs from id)
    if (repo.name && repo.name !== repo.id) {
        const idHint = document.createElement('span');
        idHint.className   = 'project-meta-id text-muted';
        idHint.textContent = repo.id;
        titleRow.appendChild(idHint);
    }

    header.appendChild(titleRow);

    // URL row
    if (repo.url) {
        const urlRow = document.createElement('div');
        urlRow.className = 'repository-url-row';

        const urlLabel = document.createElement('span');
        urlLabel.className   = 'text-muted';
        urlLabel.textContent = 'URL: ';

        const urlLink = document.createElement('a');
        urlLink.href      = repo.url;
        urlLink.textContent = repo.url;
        urlLink.target    = '_blank';
        urlLink.rel       = 'noopener noreferrer';
        urlLink.className = 'repo-url-link';

        urlRow.appendChild(urlLabel);
        urlRow.appendChild(urlLink);
        header.appendChild(urlRow);
    }

    // Refresh button + last-refreshed label
    const refreshBtn = document.createElement('button');
    refreshBtn.type      = 'button';
    refreshBtn.className = 'btn btn-primary';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.title = 'Re-fetch status for all workspaces containing this repository.';

    const lastRefreshedEl = document.createElement('span');
    lastRefreshedEl.className = 'repository-last-refreshed text-muted';

    const actionsRow = document.createElement('div');
    actionsRow.className = 'repository-detail-actions';
    actionsRow.style.marginTop = '1rem';
    actionsRow.style.marginBottom = '1rem';
    actionsRow.appendChild(refreshBtn);
    actionsRow.appendChild(lastRefreshedEl);
    header.appendChild(actionsRow);

    return { header, refreshBtn, lastRefreshedEl };
}

/**
 * Build a single `<tr>` for one workspace row.
 *
 * @param {WorkspaceRowDescriptor} rowDesc
 * @param {string}      repoId       - Repository ID (for `buildRepoStatusCells`).
 * @param {string}      repoName     - Human-readable repository name.
 * @param {string|null} webserverUrl - Webserver base URL for the Browse button.
 * @param {function(HTMLElement, string, string): void} onBranchCellClick
 * @returns {HTMLTableRowElement}
 */
function buildWorkspaceRow(rowDesc, repoId, repoName, webserverUrl, onBranchCellClick) {
    const { pid, projectName, wid, isStable, initialized, statusInfo } = rowDesc;

    const tr = document.createElement('tr');
    tr.dataset.repoId = repoId;
    tr.dataset.pid    = pid;
    tr.dataset.wid    = wid;

    // Project cell — link to #/projects/:pid
    const projectCell = document.createElement('td');
    projectCell.className = 'repo-detail-project-cell';

    const projectLink = document.createElement('a');
    projectLink.href      = `#/projects/${encodeURIComponent(pid)}`;
    projectLink.textContent = projectName || pid;
    projectLink.className = 'project-link';
    if (_router) {
        projectLink.addEventListener('click', (e) => {
            e.preventDefault();
            _router.navigate(`#/projects/${encodeURIComponent(pid)}`);
        });
    }
    projectCell.appendChild(projectLink);
    tr.appendChild(projectCell);

    // Workspace cell — link to #/projects/:pid/workspaces/:wid
    const wsCell = document.createElement('td');
    wsCell.className = 'repo-detail-workspace-cell';

    const wsLink = document.createElement('a');
    wsLink.href      = `#/projects/${encodeURIComponent(pid)}/workspaces/${encodeURIComponent(wid)}`;
    wsLink.textContent = wid;
    wsLink.className = 'workspace-link';
    if (_router) {
        wsLink.addEventListener('click', (e) => {
            e.preventDefault();
            _router.navigate(`#/projects/${encodeURIComponent(pid)}/workspaces/${encodeURIComponent(wid)}`);
        });
    }
    wsCell.appendChild(wsLink);

    // Uninitialized badge
    if (!initialized) {
        const badge = document.createElement('span');
        badge.className   = 'badge badge-muted ws-not-initialized-badge';
        badge.textContent = 'not initialized';
        wsCell.appendChild(badge);
    }

    tr.appendChild(wsCell);

    // Branch, Status, Actions cells — delegated to shared component.
    // For uninitialized workspaces, render empty placeholder cells.
    if (!initialized) {
        ['repo-branch-cell', 'repo-badge-cell', 'repo-actions-cell'].forEach((cls) => {
            const td = document.createElement('td');
            td.className = cls;
            tr.appendChild(td);
        });
    } else {
        const { branchCell, badgeCell, actionsCell } = buildRepoStatusCells({
            repoId,
            repoName,
            statusInfo,
            projectId:      pid,
            wid,
            isStable,
            onBranchCellClick: isStable ? undefined : onBranchCellClick,
            webserverUrl,
            onError: (msg) => showToast(msg, 'error'),
        });
        tr.appendChild(branchCell);
        tr.appendChild(badgeCell);
        tr.appendChild(actionsCell);
    }

    return tr;
}

/**
 * Build the status table section from a list of workspace rows.
 *
 * @param {WorkspaceRowDescriptor[]} rows
 * @param {string}      repoId
 * @param {string}      repoName
 * @param {string|null} webserverUrl
 * @param {function(HTMLElement, string, string): void} onBranchCellClick
 * @returns {{ section: HTMLElement, tbody: HTMLTableSectionElement|null }}
 */
function buildStatusSection(rows, repoId, repoName, webserverUrl, onBranchCellClick) {
    const section = document.createElement('section');
    section.className = 'repository-detail-status-section';

    if (rows.length === 0) {
        const empty = document.createElement('p');
        empty.className   = 'empty-state-inline text-secondary';
        empty.textContent = 'No projects contain this repository.';
        section.appendChild(empty);
        return { section, tbody: null };
    }

    const table = document.createElement('table');
    table.className = 'data-table repository-detail-table';

    const thead = document.createElement('thead');
    const htr   = document.createElement('tr');
    ['Project', 'Workspace', 'Branch', 'Status', 'Actions'].forEach((label) => {
        const th = document.createElement('th');
        th.textContent = label;
        htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach((rowDesc) => {
        tbody.appendChild(buildWorkspaceRow(rowDesc, repoId, repoName, webserverUrl, onBranchCellClick));
    });

    table.appendChild(tbody);
    section.appendChild(table);

    return { section, tbody };
}

/**
 * Update existing rows in-place after a refresh.
 *
 * Locates each `<tr>` by `data-pid` + `data-wid` and calls
 * `updateRepoStatusCells` on initialized workspace rows.
 *
 * @param {HTMLTableSectionElement}      tbody
 * @param {string}                       repoId       - The repository ID being viewed.
 * @param {WorkspaceRowDescriptor[]}     freshRows
 * @param {function(HTMLElement, string, string): void} onBranchCellClick
 */
function updateStatusTable(tbody, repoId, freshRows, onBranchCellClick) {
    for (const rowDesc of freshRows) {
        const { pid, wid, isStable, initialized, statusInfo } = rowDesc;
        const tr = tbody.querySelector(`tr[data-pid="${CSS.escape(pid)}"][data-wid="${CSS.escape(wid)}"]`);
        if (!tr) continue;
        if (!initialized) continue;
        updateRepoStatusCells(tr, repoId, statusInfo, isStable, isStable ? undefined : onBranchCellClick);
    }
}

// ---------------------------------------------------------------------------
// Public view entry point
// ---------------------------------------------------------------------------

/**
 * Render the Repository Detail view.
 *
 * Fetches repository metadata, all projects, workspaces, and Git status in
 * parallel. Then renders the header and status table. The Refresh button
 * re-fetches all status data and updates existing rows in-place.
 *
 * @param {HTMLElement}     container - The `#app` DOM element provided by the router.
 * @param {{ id: string }}  params    - Route parameters.
 */
export function renderRepositoryDetail(container, params) {
    const repoId = params.id;

    // Show loading state immediately.
    showLoading(container, 'Loading repository overview…');

    // Fetch repository metadata, all projects, and webserver URL in parallel.
    Promise.all([
        api.repositories.get(repoId),
        api.projects.list(),
        api.config.webserverUrl.get().catch(() => null),
    ]).then(async ([rawRepo, allProjects, webserverUrlConfig]) => {
        if (!container.isConnected) return;

        const repo = normaliseRepo(rawRepo);
        document.title = `${repo.name || repoId} - ${APP_NAME_SHORT}`;

        // Resolve webserver URL (null when not configured or fetch failed).
        const webserverUrl = (
            webserverUrlConfig &&
            typeof webserverUrlConfig.webserverUrl === 'string' &&
            webserverUrlConfig.webserverUrl !== ''
        )
            ? webserverUrlConfig.webserverUrl
            : null;

        // Load workspace rows (fan-out across projects and workspaces).
        const { rows, anyFailed } = await loadWorkspaceRows(repoId, allProjects || []);

        if (!container.isConnected) return;

        // Wire branch-click handler — dynamically imports the branch quick-switch
        // component to avoid loading it when all workspaces are STABLE.
        /**
         * Handle a click on a branch-switch trigger cell.
         *
         * Reads `tr.dataset.pid` and `tr.dataset.wid` from the nearest ancestor `<tr>`
         * to determine which project and workspace the clicked branch cell belongs to.
         * These attributes are guaranteed to be set on every row built by
         * `buildWorkspaceRow()`, so the lookup is always safe for initialized rows.
         *
         * @param {HTMLElement} anchorEl      - The branch trigger element that was clicked.
         * @param {string}      clickedRepoId - The repository ID for this row.
         * @param {string}      currentBranch - The currently checked-out branch name.
         */
        function onBranchCellClick(anchorEl, clickedRepoId, currentBranch) {
            // Find the row context to extract pid and wid.
            const tr = anchorEl.closest('tr');
            const pid = tr ? tr.dataset.pid : '';
            const wid = tr ? tr.dataset.wid : '';
            import('../components/branch-quick-switch.js')
                .then(({ showBranchQuickSwitch }) =>
                    showBranchQuickSwitch({ anchorEl, projectId: pid, wid, repoId: clickedRepoId, currentBranch }),
                )
                .then((result) => {
                    if (result.switched) doRefresh();
                })
                .catch(() => { showToast('Failed to load branch switcher.', 'error'); });
        }

        // Keep a local copy of rows so the refresh handler can re-use row metadata.
        let currentRows = rows;

        // Build DOM.
        clearElement(container);

        const { header, refreshBtn, lastRefreshedEl } = buildHeader(repo);
        let { section: statusSection, tbody } = buildStatusSection(
            currentRows, repoId, repo.name || repoId, webserverUrl, onBranchCellClick,
        );

        // Refresh handler — re-discovers projects/workspaces and updates the table.
        // Uses force-refresh for status on existing rows; newly discovered rows are
        // added to the table and removed rows are dropped. Protected by a mutex.
        let refreshInProgress = false;

        async function doRefresh() {
            if (refreshInProgress) return;
            refreshInProgress   = true;
            refreshBtn.disabled = true;
            refreshBtn.textContent = 'Refreshing…';

            try {
                // Re-discover the full project/workspace set so that workspaces added
                // since the initial load become visible without a page reload.
                const freshProjects = await api.projects.list().catch(() => null);
                if (!container.isConnected) return;

                const { rows: discoveredRows, anyFailed } = await loadWorkspaceRows(
                    repoId, freshProjects || [],
                );
                if (!container.isConnected) return;

                // Force-refresh status for existing initialized rows.
                const existingKeySet = new Set(currentRows.map((r) => `${r.pid}::${r.wid}`));
                const statusRefreshTasks = discoveredRows
                    .filter((r) => r.initialized && existingKeySet.has(`${r.pid}::${r.wid}`))
                    .map((r) =>
                        api.status.refresh(r.pid, r.wid)
                            .then((statusMap) => ({
                                ...r,
                                statusInfo: (statusMap && statusMap[repoId]) ? statusMap[repoId] : null,
                            }))
                            .catch(() => ({ ...r })),
                    );

                const refreshed = await Promise.allSettled(statusRefreshTasks);
                if (!container.isConnected) return;

                // Merge refreshed statuses into the discovered row set.
                const refreshedMap = new Map();
                for (const res of refreshed) {
                    if (res.status === 'fulfilled') {
                        const r = res.value;
                        refreshedMap.set(`${r.pid}::${r.wid}`, r);
                    }
                }
                const finalRows = discoveredRows.map((r) => {
                    const key = `${r.pid}::${r.wid}`;
                    return refreshedMap.has(key) ? refreshedMap.get(key) : r;
                });

                if (!tbody && finalRows.length > 0) {
                    // Table did not exist before (was empty); rebuild the section.
                    const { section: newSection, tbody: newTbody } = buildStatusSection(
                        finalRows, repoId, repo.name || repoId, webserverUrl, onBranchCellClick,
                    );
                    container.replaceChild(newSection, statusSection);
                    statusSection = newSection;
                    tbody = newTbody;
                } else if (tbody) {
                    const newKeySet = new Set(finalRows.map((r) => `${r.pid}::${r.wid}`));

                    // Remove rows that no longer exist.
                    for (const r of currentRows) {
                        const key = `${r.pid}::${r.wid}`;
                        if (!newKeySet.has(key)) {
                            const tr = tbody.querySelector(`tr[data-pid="${CSS.escape(r.pid)}"][data-wid="${CSS.escape(r.wid)}"]`);
                            if (tr) tr.remove();
                        }
                    }

                    // Append newly discovered rows.
                    for (const r of finalRows) {
                        const key = `${r.pid}::${r.wid}`;
                        if (!existingKeySet.has(key)) {
                            tbody.appendChild(buildWorkspaceRow(
                                r, repoId, repo.name || repoId, webserverUrl, onBranchCellClick,
                            ));
                        }
                    }

                    // Update status for rows present in both old and new sets.
                    updateStatusTable(
                        tbody, repoId,
                        finalRows.filter((r) => existingKeySet.has(`${r.pid}::${r.wid}`)),
                        onBranchCellClick,
                    );
                }

                currentRows = finalRows;

                if (anyFailed && finalRows.length > 0) {
                    showToast('Some workspace data could not be loaded. Results may be incomplete.', 'warning');
                }

                // Persist the refresh timestamp to the server and update the label.
                const updated = await api.repositories.touchRefreshTimestamp(repoId).catch(() => null);
                if (!container.isConnected) return;
                const ts = updated && updated.LastRefreshedAt ? new Date(updated.LastRefreshedAt) : new Date();
                lastRefreshedEl.textContent = `Last refreshed: ${formatRelativeTime(ts)}`;
            } finally {
                refreshInProgress      = false;
                refreshBtn.disabled    = false;
                refreshBtn.textContent = 'Refresh';
            }
        }

        refreshBtn.addEventListener('click', doRefresh);

        // Set initial timestamp from persisted value if available, otherwise show "Never".
        lastRefreshedEl.textContent = repo.LastRefreshedAt
            ? `Last refreshed: ${formatRelativeTime(new Date(repo.LastRefreshedAt))}`
            : 'Last refreshed: Never';

        container.appendChild(header);
        container.appendChild(statusSection);

        // Show a warning toast if some fetches failed (partial data).
        if (anyFailed && rows.length > 0) {
            showToast('Some workspace data could not be loaded. Results may be incomplete.', 'warning');
        }
    }).catch((err) => {
        if (!container.isConnected) return;
        clearElement(container);

        if (err.status === 404) {
            const notFoundEl = document.createElement('div');
            notFoundEl.className = 'empty-state';

            const msgEl = document.createElement('p');
            msgEl.className   = 'empty-state-inline text-secondary';
            msgEl.textContent = `Repository '${repoId}' was not found. It may have been deleted.`;
            notFoundEl.appendChild(msgEl);

            const backLink = document.createElement('a');
            backLink.href      = '#/repositories';
            backLink.className = 'btn btn-secondary';
            backLink.textContent = '← Back to Repositories';
            if (_router) {
                backLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    _router.navigate('#/repositories');
                });
            }
            notFoundEl.appendChild(backLink);

            container.appendChild(notFoundEl);
        } else {
            const errorEl = document.createElement('p');
            errorEl.className   = 'empty-state-inline text-secondary';
            errorEl.textContent = err.message || 'Failed to load repository overview.';
            container.appendChild(errorEl);
        }
    });
}
