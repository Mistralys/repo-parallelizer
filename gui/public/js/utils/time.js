/**
 * Shared time-formatting utilities for the GUI.
 *
 * Consolidates relative-time logic previously duplicated in:
 *   - views/error-log.js (relativeTime)
 *   - components/status-badge.js (formatLastActivity)
 */

// ---------------------------------------------------------------------------
// relativeTime — verbose relative timestamps for error-log entries
// ---------------------------------------------------------------------------

/**
 * Return a human-readable relative time string for the given ISO timestamp.
 * Falls back to the raw timestamp string if parsing fails.
 *
 * @param {string} isoString - ISO 8601 timestamp from the backend.
 * @returns {string}
 */
export function relativeTime(isoString) {
    if (!isoString) return '—';

    let date;
    try {
        date = new Date(isoString);
        if (isNaN(date.getTime())) return isoString;
    } catch {
        return isoString;
    }

    const diffMs  = Date.now() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 5)   return 'just now';
    if (diffSec < 60)  return `${diffSec} sec ago`;

    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60)  return `${diffMin} min ago`;

    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24)   return `${diffHr} hr ago`;

    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30)  return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;

    const diffMo = Math.floor(diffDay / 30);
    if (diffMo < 12)   return `${diffMo} month${diffMo === 1 ? '' : 's'} ago`;

    const diffYr = Math.floor(diffMo / 12);
    return `${diffYr} yr${diffYr === 1 ? '' : 's'} ago`;
}

// ---------------------------------------------------------------------------
// formatLastActivity — compact relative timestamps for status badges
// ---------------------------------------------------------------------------

/**
 * Format an ISO timestamp into a human-readable relative or absolute string.
 * Returns an empty string when the input is falsy.
 *
 * @param {string|null} isoTimestamp
 * @returns {string}
 */
export function formatLastActivity(isoTimestamp) {
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
