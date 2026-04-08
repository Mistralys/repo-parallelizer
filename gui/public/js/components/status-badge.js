/**
 * Status Badge Component.
 *
 * Creates a DOM element summarising the git status of a single repository
 * inside a workspace.  CSS classes used here are all defined in styles.css.
 *
 * Usage:
 *   import { createStatusBadge } from './components/status-badge.js';
 *
 *   const badge = createStatusBadge(gitStatusInfo);
 *   container.appendChild(badge);
 *
 * @typedef {Object} GitStatusInfo
 * @property {string|null}  currentBranch     - Active branch name, or null for detached HEAD.
 * @property {number}       localCommits      - Commits ahead of remote.
 * @property {number}       unfetchedCommits  - Commits behind remote (unfetched).
 * @property {number}       modifiedFiles     - Number of modified/staged files.
 * @property {string|null}  lastActivity      - ISO timestamp of last commit, or null.
 * @property {boolean}      hasConflicts      - True when merge conflicts exist.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an ISO timestamp into a human-readable relative or absolute string.
 * Returns an empty string when the input is falsy.
 *
 * @param {string|null} isoTimestamp
 * @returns {string}
 */
function formatLastActivity(isoTimestamp) {
    if (!isoTimestamp) return '';

    const date = new Date(isoTimestamp);
    if (isNaN(date.getTime())) return isoTimestamp; // pass through if unparseable

    const now = Date.now();
    const diffMs = now - date.getTime();
    const diffMinutes = Math.floor(diffMs / 60_000);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMinutes < 1)  return 'just now';
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24)   return `${diffHours}h ago`;
    if (diffDays < 7)     return `${diffDays}d ago`;

    // Fall back to locale date string for older commits.
    return date.toLocaleDateString();
}

/**
 * Determine the primary CSS modifier class for the badge based on status
 * priority: conflicts > modified > ahead/behind > clean.
 *
 * @param {GitStatusInfo} info
 * @returns {string} One of: 'status-badge-conflict' | 'status-badge-modified' |
 *   'status-badge-ahead' | 'status-badge-behind' | 'status-badge-clean'
 */
function resolveBadgeClass(info) {
    if (info.hasConflicts)                                 return 'status-badge-conflict';
    if (info.modifiedFiles > 0)                            return 'status-badge-modified';
    if (info.localCommits > 0)                             return 'status-badge-ahead';
    if (info.unfetchedCommits > 0)                         return 'status-badge-behind';
    return 'status-badge-clean';
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

/**
 * Create a status badge DOM element for a git repository.
 *
 * The returned element is a `<div>` that contains:
 * - A coloured pill showing the branch name.
 * - Secondary detail chips: modified count, commits ahead/behind, last
 *   activity, and a conflict warning (each only shown when non-zero / present).
 *
 * When `gitStatusInfo` is `null` a compact "No data" element is returned.
 *
 * @param {GitStatusInfo|null} gitStatusInfo
 * @returns {HTMLElement}
 */
export function createStatusBadge(gitStatusInfo) {
    const wrapper = document.createElement('div');
    wrapper.className = 'status-badge-wrapper';

    // ------------------------------------------------------------------
    // Null / loading state
    // ------------------------------------------------------------------
    if (!gitStatusInfo) {
        const noData = document.createElement('span');
        noData.className = 'status-badge status-badge-error';

        const dot = document.createElement('span');
        dot.className = 'status-badge-dot';

        noData.appendChild(dot);
        noData.appendChild(document.createTextNode('No data'));
        wrapper.appendChild(noData);
        return wrapper;
    }

    // ------------------------------------------------------------------
    // Primary pill — branch name + colour coding
    // ------------------------------------------------------------------
    const pill = document.createElement('span');
    const primaryClass = resolveBadgeClass(gitStatusInfo);
    pill.className = `status-badge ${primaryClass}`;

    const dot = document.createElement('span');
    dot.className = 'status-badge-dot';

    const branchName = gitStatusInfo.currentBranch || 'detached HEAD';
    pill.appendChild(dot);
    pill.appendChild(document.createTextNode(branchName));

    wrapper.appendChild(pill);

    // ------------------------------------------------------------------
    // Detail row — secondary indicators
    // ------------------------------------------------------------------
    const detail = document.createElement('div');
    detail.className = 'status-detail';

    /** Helper: append a detail chip. */
    function addChip(text, extraClass) {
        const chip = document.createElement('span');
        chip.className = `status-detail-item${extraClass ? ` ${extraClass}` : ''}`;
        chip.textContent = text;
        detail.appendChild(chip);
    }

    // Modified files
    if (gitStatusInfo.modifiedFiles > 0) {
        addChip(`${gitStatusInfo.modifiedFiles} modified`);
    }

    // Commits ahead of remote
    if (gitStatusInfo.localCommits > 0) {
        addChip(`↑ ${gitStatusInfo.localCommits} ahead`);
    }

    // Commits behind remote (unfetched)
    if (gitStatusInfo.unfetchedCommits > 0) {
        addChip(`↓ ${gitStatusInfo.unfetchedCommits} behind`);
    }

    // Last activity timestamp
    const activityText = formatLastActivity(gitStatusInfo.lastActivity);
    if (activityText) {
        addChip(activityText);
    }

    // Conflict indicator
    if (gitStatusInfo.hasConflicts) {
        addChip('⚠ Conflicts', 'text-danger');
    }

    // Only append detail row if it has children.
    if (detail.hasChildNodes()) {
        wrapper.appendChild(detail);
    }

    return wrapper;
}
