/**
 * Minimum allowed polling interval in seconds.
 * Enforced by PUT /api/config/polling and mirrored in the settings UI.
 */
export const MIN_POLLING_INTERVAL_SECONDS = 10;

/**
 * Maximum allowed polling interval in seconds (24 hours).
 * Enforced by PUT /api/config/polling and mirrored in the settings UI (input.max).
 */
export const MAX_POLLING_INTERVAL_SECONDS = 86_400;
