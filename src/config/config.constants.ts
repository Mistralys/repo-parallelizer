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

// ---------------------------------------------------------------------------
// Git clone depth
// ---------------------------------------------------------------------------

/**
 * Minimum clone depth (0 means a full/unlimited clone, which is valid).
 */
export const MIN_CLONE_DEPTH = 0;

/**
 * Maximum clone depth. Git uses 32-bit signed integers for depth.
 */
export const MAX_CLONE_DEPTH = 2_147_483_647;

// ---------------------------------------------------------------------------
// Server port
// ---------------------------------------------------------------------------

/**
 * Minimum TCP port number (well-known / system ports start at 1).
 */
export const MIN_SERVER_PORT = 1;

/**
 * Maximum TCP port number (standard 16-bit unsigned range).
 */
export const MAX_SERVER_PORT = 65_535;
