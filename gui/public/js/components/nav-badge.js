/**
 * Nav Badge Component — polls the error-log count endpoint and updates the
 * badge element in the top navigation bar.
 *
 * Usage:
 *   import { initNavBadge, destroyNavBadge, refreshNavBadge } from './components/nav-badge.js';
 *
 *   initNavBadge();          // start polling
 *   refreshNavBadge();       // force an immediate refresh (e.g. after "Clear All")
 *   destroyNavBadge();       // stop polling
 */

import { api } from '../api.js';

const POLL_INTERVAL_MS = 30_000; // 30 seconds

/** @type {number|null} */
let intervalId = null;

/**
 * Fetch the current error-log count and update the badge element.
 */
async function updateBadge() {
    const badge = document.getElementById('error-log-badge');
    if (!badge) return;

    try {
        const result = await api.errorLog.count();
        const count = typeof result.total === 'number' ? result.total : 0;

        if (count > 0) {
            badge.textContent = String(count);
            badge.hidden = false;
        } else {
            badge.textContent = '';
            badge.hidden = true;
        }
    } catch {
        // Silently ignore — badge is a non-critical UI element.
    }
}

/**
 * Start the nav badge polling loop. Safe to call multiple times — subsequent
 * calls are no-ops if already running.
 */
export function initNavBadge() {
    if (intervalId !== null) return;

    // Immediate first fetch.
    updateBadge();

    intervalId = window.setInterval(updateBadge, POLL_INTERVAL_MS);
}

/**
 * Stop the nav badge polling loop and hide the badge.
 */
export function destroyNavBadge() {
    if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
    }
}

/**
 * Force an immediate badge refresh. Call this after actions that change the
 * error-log count (e.g. "Clear All").
 */
export function refreshNavBadge() {
    updateBadge();
}
