/**
 * Repo Status Cells Component — Repo Parallelizer GUI.
 *
 * Encapsulates the reusable Branch, Status badge, and Actions `<td>` cell-building
 * logic shared between the workspace-detail and repository-detail views.
 *
 * ## Exported functions
 *
 * - `buildRepoStatusCells`   — Build the three `<td>` elements for a single
 *   repository row (branch, badge, actions). Callers assemble the full `<tr>`.
 * - `makeBranchTrigger`      — Build a `<button class="branch-switch-trigger">`.
 * - `updateRepoStatusCells`  — Update branch and badge cells in-place within a
 *   `<tr>`, locating them by CSS class (`.repo-branch-cell`,
 *   `div[data-repo-id]`) rather than by hardcoded cell indices. The
 *   branch-trigger aria-label is sourced from `row.dataset.repoName`
 *   when present, falling back to `repoId` when the attribute is absent.
 *
 * @module repo-status-cells
 */

import { api }               from '../api.js';
import { createStatusBadge } from './status-badge.js';
import { clearElement }      from '../utils/dom.js';

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/**
 * Build a branch-switch trigger `<button>` styled as inline text.
 *
 * Extracted to avoid duplicating the element setup in both `buildRepoStatusCells`
 * (initial render) and `updateRepoStatusCells` (polling updates). The click
 * handler is wired by the caller so it can close over a fresh `trigger`
 * reference.
 *
 * @param {string} branchName - Branch name shown as the button label.
 * @param {string} ariaLabel  - Accessible label for screen-readers.
 * @returns {HTMLButtonElement}
 */
export function makeBranchTrigger(branchName, ariaLabel) {
    const btn = document.createElement('button');
    btn.type        = 'button';
    btn.className   = 'branch-switch-trigger';
    btn.textContent = branchName;
    btn.setAttribute('aria-label', ariaLabel);
    return btn;
}

/**
 * Build the three shared status `<td>` cells for a single repository row.
 *
 * Returns a plain object with `branchCell`, `badgeCell`, and `actionsCell`
 * so the caller can insert them into whatever `<tr>` it is constructing,
 * interleaving its own cells (e.g. a repository name cell) as needed.
 *
 * @param {Object} opts
 * @param {string}      opts.repoId      - Unique repository identifier.
 * @param {string}      opts.repoName    - Human-readable display name; used in
 *                                         aria-labels. Falls back to `repoId` when
 *                                         the caller has no richer name.
 * @param {Object|null} opts.statusInfo  - GitStatusInfo object from the API, or
 *                                         `null` when no status data is yet available.
 * @param {string}      opts.projectId   - ID of the parent project.
 * @param {string}      opts.wid         - ID of the parent workspace.
 * @param {boolean}    [opts.isStable]   - When `true`, the branch cell is rendered
 *                                         as plain text (no clickable trigger).
 * @param {function(HTMLElement, string, string): void} [opts.onBranchCellClick]
 *                                         Callback invoked with `(anchorEl, repoId,
 *                                         currentBranch)` when the branch trigger is
 *                                         clicked. Only wired when `isStable` is falsy.
 * @param {string|null} [opts.webserverUrl] - Base URL of the local webserver. When
 *                                         truthy, a "Browse" button is inserted
 *                                         before the "Git GUI" button inside
 *                                         `actionsCell`.
 * @param {function(string): void} [opts.onError] - Optional callback invoked with
 *                                         an error message string when the Git GUI
 *                                         button click handler fails. When omitted
 *                                         the error is silently swallowed.
 * @returns {{ branchCell: HTMLTableCellElement, badgeCell: HTMLTableCellElement, actionsCell: HTMLTableCellElement }}
 */
export function buildRepoStatusCells({ repoId, repoName, statusInfo, projectId, wid, isStable, onBranchCellClick, webserverUrl, onError }) {
    // ------------------------------------------------------------------
    // Branch cell
    // ------------------------------------------------------------------
    const branchCell = document.createElement('td');
    branchCell.className = 'repo-branch-cell';

    const currentBranch = (statusInfo && statusInfo.currentBranch) ? statusInfo.currentBranch : null;

    if (!isStable && currentBranch && onBranchCellClick) {
        const trigger = makeBranchTrigger(currentBranch, `Switch branch for ${repoName}`);
        trigger.addEventListener('click', () => onBranchCellClick(trigger, repoId, currentBranch));
        branchCell.appendChild(trigger);
    } else {
        branchCell.textContent = currentBranch || '—';
    }

    // ------------------------------------------------------------------
    // Badge cell — wrapper <div> keeps data-repo-id so polling updates can
    // locate and replace badge contents without touching the rest of the row.
    // ------------------------------------------------------------------
    const badgeCell = document.createElement('td');
    badgeCell.className = 'repo-badge-cell';

    const badgeWrapper = document.createElement('div');
    badgeWrapper.dataset.repoId = repoId;
    badgeWrapper.appendChild(createStatusBadge(statusInfo || null));
    badgeCell.appendChild(badgeWrapper);

    // ------------------------------------------------------------------
    // Actions cell — "Git GUI" button (always present) + optional "Browse"
    // ------------------------------------------------------------------
    const actionsCell = document.createElement('td');
    actionsCell.className = 'repo-actions-cell';

    const openBtn = document.createElement('button');
    openBtn.type        = 'button';
    openBtn.className   = 'btn btn-secondary btn-sm';
    openBtn.textContent = 'Git GUI';
    openBtn.title       = 'Open this repository in GitHub Desktop.';

    openBtn.addEventListener('click', async () => {
        openBtn.disabled    = true;
        openBtn.textContent = 'Opening…';
        try {
            await api.workspaces.launch.githubDesktop(projectId, wid, repoId);
        } catch (err) {
            if (onError) {
                onError(err.message || 'Failed to open GitHub Desktop.');
            }
        } finally {
            openBtn.disabled    = false;
            openBtn.textContent = 'Git GUI';
        }
    });

    actionsCell.appendChild(openBtn);

    // Browse button — shown only when webserverUrl is configured.
    if (webserverUrl) {
        const browseBtn = document.createElement('button');
        browseBtn.type        = 'button';
        browseBtn.className   = 'btn btn-secondary btn-sm';
        browseBtn.textContent = 'Browse';
        browseBtn.title       = 'Open this repository in the browser via the configured webserver URL.';

        browseBtn.addEventListener('click', () => {
            const url = `${webserverUrl}/${encodeURIComponent(projectId)}/${encodeURIComponent(wid)}/${encodeURIComponent(repoId)}/`;
            window.open(url, '_blank');
        });

        // Insert Browse before Git GUI so the visual order is: Browse → Git GUI.
        actionsCell.insertBefore(browseBtn, openBtn);
    }

    return { branchCell, badgeCell, actionsCell };
}

/**
 * Update an existing repository row's branch and badge cells in-place.
 *
 * Cells are located by CSS class (`.repo-branch-cell`) and by the badge
 * wrapper's `data-repo-id` attribute — **not** by hardcoded cell indices —
 * so callers are free to add additional cells before or between the shared
 * cells without breaking this function.
 *
 * @param {HTMLTableRowElement} row          - The `<tr>` to update.
 * @param {string}              repoId       - Repository identifier (used to
 *                                             find the badge wrapper div).
 * @param {Object|null}         statusInfo   - New GitStatusInfo from the API,
 *                                             or `null` when no data is available.
 * @param {boolean}            [isStable]    - When `true`, the branch cell is
 *                                             rebuilt as plain text.
 * @param {function(HTMLElement, string, string): void} [onBranchCellClick]
 *                                             Wired to the branch trigger button
 *                                             in non-STABLE workspaces.
 *
 * @remarks
 * The aria-label for the branch trigger button is constructed as
 * `"Switch branch for <name>"` where `<name>` is `row.dataset.repoName`
 * when that attribute is present on the `<tr>`, falling back to `repoId`
 * when the attribute is absent or empty.
 */
export function updateRepoStatusCells(row, repoId, statusInfo, isStable, onBranchCellClick) {
    // Update branch cell — locate by class, not by index.
    const branchCell = row.querySelector('.repo-branch-cell');
    if (branchCell) {
        const currentBranch = (statusInfo && statusInfo.currentBranch) ? statusInfo.currentBranch : null;
        // Clear existing content before rebuilding.
        clearElement(branchCell);
        if (!isStable && currentBranch && onBranchCellClick) {
            const repoName = row.dataset.repoName || repoId;
            const trigger  = makeBranchTrigger(currentBranch, `Switch branch for ${repoName}`);
            trigger.addEventListener('click', () => onBranchCellClick(trigger, repoId, currentBranch));
            branchCell.appendChild(trigger);
        } else {
            branchCell.textContent = currentBranch || '—';
        }
    }

    // Update badge wrapper — locate the <div data-repo-id="..."> inside the row.
    const badgeWrapper = row.querySelector(`div[data-repo-id="${CSS.escape(repoId)}"]`);
    if (badgeWrapper) {
        // Clear existing badge before replacing.
        clearElement(badgeWrapper);
        badgeWrapper.appendChild(createStatusBadge(statusInfo || null));
    }
}
