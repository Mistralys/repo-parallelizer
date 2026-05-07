/**
 * Notes Collected View — Repo Parallelizer GUI.
 *
 * Two-panel layout:
 *   - Left sidebar: all workspaces grouped by project (collapsible groups).
 *     Workspaces with existing notes are visually distinguished with a
 *     `.has-notes` class on the sidebar item.
 *   - Right main panel: editable note cards for workspaces with non-empty notes.
 *     On initial load only non-empty note cards are rendered.
 *     Clicking a sidebar item for a workspace with a card scrolls to it.
 *     Clicking a sidebar item for a workspace without a card creates a new
 *     empty card and focuses the textarea.
 *     Each card auto-saves after 1000 ms of inactivity (debounce).
 *     Saving an empty note removes the card and clears the sidebar indicator.
 *
 * Data flow:
 *   1. `api.notes.list()` fetches the raw PascalCase `GET /api/notes` response.
 *   2. `normaliseNotesResponse()` converts it to a camelCase
 *      `{ projects: [{ projectId, projectName, workspaces: [{ workspaceId, notes }] }] }`
 *      structure used throughout the view.
 *   3. A `notesMap` (`Map<"${projectId}|${workspaceId}", string>`) mirrors the
 *      current note text in memory, keeping sidebar indicators and newly-created
 *      cards in sync with saves without re-fetching from the server.
 *
 * All dynamic text is set via `textContent` (never `innerHTML`) for XSS safety.
 *
 * @param {HTMLElement} container - The `#app` DOM element provided by the router.
 * @param {Object}      _params   - Route params (none for this route).
 */

import { api }                    from '../api.js';
import { showToast }              from '../components/toast.js';
import { normaliseNotesResponse } from '../utils/normalise.js';

// ---------------------------------------------------------------------------
// Internal DOM helpers
// ---------------------------------------------------------------------------

/**
 * Find a note card in the main panel by project + workspace ID using dataset
 * attributes (avoids CSS-escaping concerns with arbitrary ID strings).
 *
 * @param {HTMLElement} mainPanel
 * @param {string}      projectId
 * @param {string}      workspaceId
 * @returns {HTMLElement|null}
 */
function findCard(mainPanel, projectId, workspaceId) {
    for (const card of mainPanel.querySelectorAll('.notes-card')) {
        if (card.dataset.projectId === projectId && card.dataset.workspaceId === workspaceId) {
            return card;
        }
    }
    return null;
}

/**
 * Find a sidebar list item by project + workspace ID.
 *
 * @param {HTMLElement} sidebar
 * @param {string}      projectId
 * @param {string}      workspaceId
 * @returns {HTMLElement|null}
 */
function findSidebarItem(sidebar, projectId, workspaceId) {
    for (const item of sidebar.querySelectorAll('.notes-sidebar-item')) {
        if (item.dataset.projectId === projectId && item.dataset.workspaceId === workspaceId) {
            return item;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Empty-state management
// ---------------------------------------------------------------------------

/**
 * Show or hide the "no notes" empty-state message based on whether the main
 * panel contains any note cards.
 *
 * @param {HTMLElement} mainPanel
 */
function refreshEmptyState(mainPanel) {
    const existing = mainPanel.querySelector('.notes-empty-state');
    const hasCards = mainPanel.querySelector('.notes-card') !== null;
    if (hasCards && existing) {
        existing.remove();
    } else if (!hasCards && !existing) {
        const p = document.createElement('p');
        p.className = 'notes-empty-state';
        p.textContent = 'No workspace notes yet. Click a workspace in the sidebar to add one.';
        mainPanel.appendChild(p);
    }
}

// ---------------------------------------------------------------------------
// Sidebar builder
// ---------------------------------------------------------------------------

/**
 * Build the left sidebar listing all workspaces grouped by project.
 *
 * Each project is rendered as a `<details>` element (open by default) so
 * groups are collapsible. Sidebar items with existing notes carry the
 * `.has-notes` modifier class.
 *
 * @param {Array<{ projectId: string, projectName: string,
 *   workspaces: Array<{ workspaceId: string, notes: string }> }>} projects
 * @param {function(string, string): void} onItemClick
 *   Called with (projectId, workspaceId) when a sidebar button is clicked.
 * @returns {HTMLElement}
 */
function buildSidebar(projects, onItemClick) {
    const aside = document.createElement('aside');
    aside.className = 'notes-sidebar';

    const heading = document.createElement('h2');
    heading.className = 'notes-sidebar-heading';
    heading.textContent = 'Workspaces';
    aside.appendChild(heading);

    for (const project of projects) {
        const details = document.createElement('details');
        details.className = 'notes-sidebar-group';

        const summary = document.createElement('summary');
        summary.className = 'notes-sidebar-group-title';
        summary.textContent = project.projectName || project.projectId;
        details.appendChild(summary);

        const ul = document.createElement('ul');
        ul.className = 'notes-sidebar-list';

        for (const ws of project.workspaces) {
            const li = document.createElement('li');
            li.className = 'notes-sidebar-item';
            li.dataset.projectId   = project.projectId;
            li.dataset.workspaceId = ws.workspaceId;
            if (ws.notes) {
                li.classList.add('has-notes');
            }

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'notes-sidebar-btn';
            btn.textContent = ws.workspaceId;
            btn.addEventListener('click', () => onItemClick(project.projectId, ws.workspaceId));

            li.appendChild(btn);
            ul.appendChild(li);
        }

        details.appendChild(ul);
        aside.appendChild(details);
    }

    return aside;
}

// ---------------------------------------------------------------------------
// Note card builder
// ---------------------------------------------------------------------------

/**
 * Build a single editable note card for a workspace.
 *
 * The card header contains a clickable link to the workspace detail view.
 * The textarea fires a 1000 ms debounced save on `input` events.
 * A status span (aria-live="polite") shows Saving… / Saved / Save failed.
 *
 * @param {string}   projectId
 * @param {string}   projectName
 * @param {string}   workspaceId
 * @param {string}   initialNotes
 * @param {function(string, string, string): Promise<void>} onSave
 *   Called with (projectId, workspaceId, notes). Rejects on save failure.
 * @param {function(): void} onEmpty
 *   Called (after a successful save) when the note text is empty.
 * @returns {HTMLElement}
 */
function buildNoteCard(projectId, projectName, workspaceId, initialNotes, onSave, onEmpty) {
    const article = document.createElement('article');
    article.className = 'notes-card';
    article.dataset.projectId   = projectId;
    article.dataset.workspaceId = workspaceId;

    // ---- Card header ----
    const header = document.createElement('header');
    header.className = 'notes-card-header';

    const link = document.createElement('a');
    link.href = `#/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}`;
    link.className = 'notes-card-ws-link';
    // textContent used intentionally: projectName/workspaceId come from the
    // server response and must not be treated as markup.
    link.textContent = `${projectName || projectId} \u203a ${workspaceId}`;
    header.appendChild(link);

    const statusEl = document.createElement('span');
    statusEl.className = 'notes-card-status';
    statusEl.setAttribute('aria-live', 'polite');
    statusEl.hidden = true;
    header.appendChild(statusEl);

    article.appendChild(header);

    // ---- Textarea ----
    const textarea = document.createElement('textarea');
    textarea.className = 'notes-card-textarea';
    textarea.value = initialNotes;
    textarea.rows = 6;
    article.appendChild(textarea);

    // ---- Debounced auto-save ----
    let debounceTimer = null;

    textarea.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
            statusEl.textContent = 'Saving\u2026';
            statusEl.hidden = false;
            try {
                await onSave(projectId, workspaceId, textarea.value);
                if (textarea.value === '') {
                    onEmpty();
                    return;
                }
                statusEl.textContent = 'Saved';
                setTimeout(() => { statusEl.hidden = true; }, 3000);
            } catch {
                statusEl.textContent = 'Save failed.';
            }
        }, 1000);
    });

    return article;
}

// ---------------------------------------------------------------------------
// Public view entry point
// ---------------------------------------------------------------------------

/**
 * Render the Notes Collected view.
 *
 * Fetches all workspace notes via `api.notes.list()`, normalises the response,
 * then builds a two-panel layout: sidebar on the left, scrollable main panel
 * on the right.
 *
 * @param {HTMLElement} container - The `#app` DOM element provided by the router.
 * @param {Object}      _params   - Route params (none for this route).
 */
export async function renderNotesCollected(container, _params) {
    // Show loading state immediately.
    const loadingEl = document.createElement('p');
    loadingEl.className = 'notes-loading';
    loadingEl.textContent = 'Loading notes\u2026';
    container.appendChild(loadingEl);

    let rawResponse;
    /** @type {{ notesColumns?: number, notesCardHeight?: number }} */
    let displaySettings;
    try {
        [rawResponse, displaySettings] = await Promise.all([
            api.notes.list(),
            api.config.notesDisplay.get().catch(() => ({})),
        ]);
    } catch (err) {
        container.removeChild(loadingEl);
        showToast(`Failed to load notes: ${err.message}`, 'error');
        const errEl = document.createElement('p');
        errEl.className = 'notes-error';
        errEl.textContent = 'Could not load workspace notes. Please try again.';
        container.appendChild(errEl);
        return;
    }

    container.removeChild(loadingEl);

    const { projects } = normaliseNotesResponse(rawResponse);

    // ---- In-memory notes map — keeps local state in sync with saves ----
    /** @type {Map<string, string>} Key: `${projectId}|${workspaceId}` */
    const notesMap = new Map();
    for (const project of projects) {
        for (const ws of project.workspaces) {
            notesMap.set(`${project.projectId}|${ws.workspaceId}`, ws.notes);
        }
    }

    // ---- Layout container ----
    const layout = document.createElement('div');
    layout.className = 'notes-view';

    // ---- Main panel ----
    const mainPanel = document.createElement('div');
    mainPanel.className = 'notes-main';

    // Apply display settings from API (gracefully degrade if fetch failed).
    if (displaySettings.notesColumns) {
        mainPanel.style.gridTemplateColumns = `repeat(${displaySettings.notesColumns}, 1fr)`;
    }
    if (displaySettings.notesCardHeight) {
        // notesCardHeight is always an integer (pixels) per the NotesDisplayConfig typedef
        // (see api.js — @property {number} notesCardHeight, range 120–800), so appending
        // 'px' unconditionally is safe. If the API contract changes to include units, remove the suffix.
        mainPanel.style.setProperty('--notes-card-height', `${displaySettings.notesCardHeight}px`);
    }

    // Forward-declare sidebar so handlers can reference it after assignment.
    /** @type {HTMLElement} */
    let sidebar; // assigned below after handlers are defined

    // ---- Shared save handler ----
    async function handleSave(projectId, workspaceId, notes) {
        await api.workspaces.update(projectId, workspaceId, { notes });
        notesMap.set(`${projectId}|${workspaceId}`, notes);
        // Update sidebar indicator for non-empty saves.
        if (notes) {
            findSidebarItem(sidebar, projectId, workspaceId)?.classList.add('has-notes');
        }
    }

    // ---- Handler: note saved as empty → remove card + clear sidebar indicator ----
    function handleCardEmpty(projectId, workspaceId) {
        const card = findCard(mainPanel, projectId, workspaceId);
        if (card) card.remove();

        findSidebarItem(sidebar, projectId, workspaceId)?.classList.remove('has-notes');
        notesMap.set(`${projectId}|${workspaceId}`, '');
        refreshEmptyState(mainPanel);
    }

    // ---- Sidebar click handler ----
    function handleSidebarClick(projectId, workspaceId) {
        const existingCard = findCard(mainPanel, projectId, workspaceId);
        if (existingCard) {
            // Card already exists — scroll to it and focus.
            existingCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
            existingCard.querySelector('.notes-card-textarea')?.focus();
            return;
        }

        // No card yet — create a new empty one.
        const project = projects.find((p) => p.projectId === projectId);
        const projectName   = project ? project.projectName : projectId;
        const currentNotes  = notesMap.get(`${projectId}|${workspaceId}`) ?? '';

        const card = buildNoteCard(
            projectId,
            projectName,
            workspaceId,
            currentNotes,
            handleSave,
            () => handleCardEmpty(projectId, workspaceId),
        );

        mainPanel.appendChild(card);
        refreshEmptyState(mainPanel);
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        card.querySelector('.notes-card-textarea')?.focus();
    }

    // ---- Build sidebar (uses handleSidebarClick defined above) ----
    sidebar = buildSidebar(projects, handleSidebarClick);
    layout.appendChild(sidebar);

    // ---- Populate main panel with cards for non-empty notes ----
    for (const project of projects) {
        for (const ws of project.workspaces) {
            if (ws.notes) {
                const card = buildNoteCard(
                    project.projectId,
                    project.projectName,
                    ws.workspaceId,
                    ws.notes,
                    handleSave,
                    () => handleCardEmpty(project.projectId, ws.workspaceId),
                );
                mainPanel.appendChild(card);
            }
        }
    }

    refreshEmptyState(mainPanel);
    layout.appendChild(mainPanel);
    container.appendChild(layout);
}
