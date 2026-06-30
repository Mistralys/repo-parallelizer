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

/**
 * Short application name used in browser tab titles.
 *
 * @type {string}
 */
export const APP_NAME_SHORT = 'Paralizer';

/**
 * Sentinel substring present in credential-missing error messages emitted by
 * the workspace and repository orchestrators.
 *
 * When a clone failure's error string contains this text the workspace detail
 * view surfaces a "Missing Credential" badge instead of the generic "No data"
 * error badge.
 *
 * Must remain in sync with the error message template in:
 *   src/orchestration/workspace-orchestrator.ts
 *   src/orchestration/repository-orchestrator.ts
 *
 * @type {string}
 */
export const CREDENTIAL_MISSING_SENTINEL = 'requires a credential for host';
