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

// ---------------------------------------------------------------------------
// GitCredentialEntry — per-field maximum lengths
// ---------------------------------------------------------------------------

/**
 * Maximum character length for a credential `id` field.
 * IDs are kebab-case strings; 100 characters provides a generous upper bound
 * while guarding against unbounded input.
 */
export const MAX_CREDENTIAL_ID_LENGTH = 100;

/**
 * Maximum character length for a credential `label` field.
 * Labels are human-readable display names; 200 characters is sufficient for
 * any reasonable label.
 */
export const MAX_CREDENTIAL_LABEL_LENGTH = 200;

/**
 * Maximum character length for a credential `host` field.
 * 253 characters is the maximum length of a fully-qualified DNS hostname
 * per RFC 1035.
 */
export const MAX_CREDENTIAL_HOST_LENGTH = 253;

/**
 * Maximum character length for a credential `token` field.
 * 500 characters covers GitHub fine-grained PATs (~93 chars) and similar
 * tokens with a wide safety margin.
 */
export const MAX_CREDENTIAL_TOKEN_LENGTH = 500;
