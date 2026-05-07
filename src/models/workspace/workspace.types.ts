import type { ProjectWorkspace } from '../project/project.types.js';

export type { ProjectWorkspace };

/**
 * The reserved workspace ID for the default stable workspace.
 * Every project is guaranteed to have exactly one workspace with this ID.
 */
export const STABLE_WORKSPACE_ID = 'STABLE';

/**
 * Flat view of a workspace that includes its parent project ID.
 * Returned by WorkspaceManager.list() and WorkspaceManager.getById().
 */
export interface WorkspaceInfo {
    /** ID of the project this workspace belongs to. */
    ProjectID: string;

    /** Unique workspace identifier (2–10 uppercase ASCII letters, e.g. "STABLE", "DEV"). */
    WorkspaceID: string;

    /** Human-readable description of this workspace. */
    Description: string;

    /** ISO 8601 timestamp when this workspace was created. */
    DateCreated: string;

    /** ISO 8601 timestamp when this workspace was last modified. */
    DateModified: string;

    /** Free-text notes about this workspace. Empty string when none have been set. */
    Notes: string;
}
