import type { BaseStore } from '../../storage/storage.types.js';

/**
 * Represents a single workspace within a project.
 * Workspace IDs are uppercase alphabetic strings (e.g. "STABLE", "DEV").
 */
export interface ProjectWorkspace {
    /** Human-readable description of this workspace. */
    Description: string;

    /** ISO 8601 timestamp when this workspace was created. */
    DateCreated: string;

    /** ISO 8601 timestamp when this workspace was last modified. */
    DateModified: string;
}

/**
 * Full project data stored in the per-project JSON file
 * at `{STORAGE_FOLDER}/projects/{id}.json`.
 */
export interface ProjectData {
    /** Unique kebab-case project identifier. */
    Id: string;

    /** Human-readable display name. */
    Name: string;

    /** Short description of the project. */
    Description: string;

    /** ISO 8601 timestamp when this project was created. */
    DateCreated: string;

    /** ISO 8601 timestamp when this project was last modified. */
    DateModified: string;

    /** Ordered list of repository IDs tracked by this project. */
    Repositories: string[];

    /**
     * Map of workspace ID to workspace data.
     * Always contains at least the "STABLE" workspace.
     */
    Workspaces: Record<string, ProjectWorkspace>;

    SchemaVersion: number;
}

/**
 * Lightweight summary entry stored in the project index.
 */
export interface ProjectIndexEntry {
    /** Unique kebab-case project identifier. */
    Id: string;

    /** Human-readable display name. */
    Name: string;
}

/**
 * Top-level shape of the projects-index.json storage file.
 */
export interface ProjectIndex extends BaseStore {
    Projects: ProjectIndexEntry[];
}
