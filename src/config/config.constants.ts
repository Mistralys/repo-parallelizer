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

// ---------------------------------------------------------------------------
// Notes view — card height
// ---------------------------------------------------------------------------

/**
 * Minimum card height (px) allowed in the notes view.
 */
export const MIN_NOTES_CARD_HEIGHT = 120;

/**
 * Maximum card height (px) allowed in the notes view.
 */
export const MAX_NOTES_CARD_HEIGHT = 800;

/**
 * Default card height (px) used in the notes view when not set by the user.
 */
export const DEFAULT_NOTES_CARD_HEIGHT = 220;

// ---------------------------------------------------------------------------
// Notes view — column count
// ---------------------------------------------------------------------------

/**
 * Minimum number of columns allowed in the notes view grid.
 */
export const MIN_NOTES_COLUMNS = 1;

/**
 * Maximum number of columns allowed in the notes view grid.
 */
export const MAX_NOTES_COLUMNS = 6;

/**
 * Default number of columns used in the notes view grid when not set by the user.
 */
export const DEFAULT_NOTES_COLUMNS = 2;
