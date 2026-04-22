/**
 * Shared GUI constants — Repo Parallelizer.
 *
 * Centralises values that must remain consistent across multiple views and
 * components. Import from here instead of re-declaring inline.
 *
 * @module utils/constants
 */

/**
 * The workspace ID that is always treated as the stable reference workspace.
 * This value is enforced at the storage layer and must never be changed here.
 *
 * @type {string}
 */
export const STABLE_WS_ID = 'STABLE';
