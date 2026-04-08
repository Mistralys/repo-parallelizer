import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AppConfig } from '../../config/config.types.js';
import { readJsonFile, writeJsonFile, FileNotFoundError } from '../../storage/json-storage.js';
import { toKebabCase, isValidKebabCase } from '../../utils/slug.js';
import { NotFoundError } from '../../errors.js';
// `import type` used here intentionally: RepositoryManager is injected via the constructor
// and never constructed inside this module, so no runtime import is needed. TypeScript
// erases the type import entirely, avoiding any potential circular-reference warning.
import type { RepositoryManager } from '../repository/repository.manager.js';
import type { ProjectData, ProjectIndex, ProjectIndexEntry, ProjectWorkspace } from './project.types.js';
import { STABLE_WORKSPACE_ID } from '../workspace/workspace.types.js';

const INDEX_FILE = 'projects-index.json';
const PROJECTS_SUBDIR = 'projects';
const SCHEMA_VERSION = 1;

const DEFAULT_INDEX: ProjectIndex = { Projects: [], SchemaVersion: SCHEMA_VERSION };

/**
 * Provides CRUD operations over the persisted project store.
 *
 * Uses a dual-file storage strategy:
 * - A lightweight index (`projects-index.json`) for fast listing.
 * - Individual project files (`projects/{id}.json`) for full project data.
 *
 * Every public method is stateless — it re-reads from disk on each call so
 * that concurrent writes from other processes are always reflected.
 */
export class ProjectManager {
    private readonly indexPath: string;
    private readonly projectsDir: string;

    constructor(
        private readonly config: AppConfig,
        private readonly repositoryManager: RepositoryManager,
    ) {
        this.indexPath = path.join(config.storageFolder, INDEX_FILE);
        this.projectsDir = path.join(config.storageFolder, PROJECTS_SUBDIR);
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private loadIndex(): ProjectIndex {
        try {
            return readJsonFile<ProjectIndex>(this.indexPath);
        } catch (err) {
            if (err instanceof FileNotFoundError) {
                return { ...DEFAULT_INDEX, Projects: [] };
            }
            throw err;
        }
    }

    private saveIndex(index: ProjectIndex): void {
        writeJsonFile(this.indexPath, index);
    }

    private projectFilePath(id: string): string {
        return path.join(this.projectsDir, `${id}.json`);
    }

    private loadProject(id: string): ProjectData | undefined {
        try {
            return readJsonFile<ProjectData>(this.projectFilePath(id));
        } catch (err) {
            if (err instanceof FileNotFoundError) {
                return undefined;
            }
            throw err;
        }
    }

    private saveProject(data: ProjectData): void {
        writeJsonFile(this.projectFilePath(data.Id), data);
    }

    private now(): string {
        return new Date().toISOString();
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Returns all projects from the index.
     */
    list(): ProjectIndexEntry[] {
        return this.loadIndex().Projects;
    }

    /**
     * Reads and returns the full project data, or `undefined` if not found.
     */
    getById(id: string): ProjectData | undefined {
        return this.loadProject(id);
    }

    /**
     * Creates a new project.
     *
     * - When `id` is omitted, it is generated from `name` via `toKebabCase()`.
     * - When `id` is provided explicitly it is validated via `isValidKebabCase()`
     *   after trimming. Path-traversal sequences and invalid formats are rejected.
     * - Validates that all `repositoryIds` exist via the RepositoryManager.
     * - Auto-creates a STABLE workspace with correct timestamps.
     * - Saves the project file and updates the project index.
     *
     * @throws {Error} If the explicit `id` is not valid kebab-case.
     * @throws {Error} If `name` produces an empty slug and no `id` was given.
     * @throws {Error} If any repository ID does not exist.
     * @throws {Error} If a project with the resolved ID already exists.
     */
    create(
        name: string,
        repositoryIds: string[],
        description?: string,
        id?: string,
    ): ProjectData {
        let resolvedId = id;
        if (resolvedId) {
            resolvedId = resolvedId.trim();
            if (!isValidKebabCase(resolvedId)) {
                throw new Error(
                    `Invalid project ID "${resolvedId}": must be a valid kebab-case string ` +
                    `(lowercase alphanumeric segments separated by single hyphens).`
                );
            }
        } else {
            resolvedId = toKebabCase(name);
            if (resolvedId === '') {
                throw new Error(
                    `Cannot generate a project ID from name "${name}": the name produced an empty slug. ` +
                    `Please provide an explicit ID.`
                );
            }
        }

        for (const repoId of repositoryIds) {
            if (!this.repositoryManager.exists(repoId)) {
                throw new Error(`Repository with ID "${repoId}" does not exist.`);
            }
        }

        const index = this.loadIndex();
        if (index.Projects.some((p) => p.Id === resolvedId)) {
            throw new Error(`A project with ID "${resolvedId}" already exists.`);
        }

        const timestamp = this.now();
        const project: ProjectData = {
            Id: resolvedId,
            Name: name,
            Description: description ?? '',
            DateCreated: timestamp,
            DateModified: timestamp,
            Repositories: [...repositoryIds],
            Workspaces: {
                [STABLE_WORKSPACE_ID]: {
                    Description: 'Stable workspace',
                    DateCreated: timestamp,
                    DateModified: timestamp,
                },
            },
            SchemaVersion: SCHEMA_VERSION,
        };

        this.saveProject(project);
        index.Projects.push({ Id: resolvedId, Name: name });
        this.saveIndex(index);
        return project;
    }

    /**
     * Updates mutable project fields (`Name` and/or `Description`).
     * Always updates `DateModified`. Keeps the index in sync when `Name` changes.
     *
     * @throws {Error} If no project with the given ID exists.
     */
    update(id: string, changes: { Name?: string; Description?: string }): ProjectData {
        const project = this.loadProject(id);
        if (!project) {
            throw new NotFoundError(`Cannot update: project with ID "${id}" does not exist.`);
        }

        if (changes.Name !== undefined) {
            project.Name = changes.Name;
        }
        if (changes.Description !== undefined) {
            project.Description = changes.Description;
        }
        project.DateModified = this.now();
        this.saveProject(project);

        if (changes.Name !== undefined) {
            const index = this.loadIndex();
            const entry = index.Projects.find((p) => p.Id === id);
            if (entry) {
                entry.Name = changes.Name;
                this.saveIndex(index);
            }
        }

        return project;
    }

    /**
     * Renames a project by changing its ID.
     *
     * - Validates `newId` via `isValidKebabCase()` after trimming.
     * - Updates the `Id` field inside the project data file.
     * - Renames the project JSON file on disk (old file is deleted).
     * - Updates the project index entry.
     * - Updates `DateModified`.
     *
     * @throws {Error} If `newId` is not valid kebab-case.
     * @throws {Error} If no project with `oldId` exists.
     * @throws {Error} If a project with `newId` already exists.
     */
    rename(oldId: string, newId: string): ProjectData {
        newId = newId.trim();
        if (!isValidKebabCase(newId)) {
            throw new Error(
                `Invalid project ID "${newId}": must be a valid kebab-case string ` +
                `(lowercase alphanumeric segments separated by single hyphens).`
            );
        }

        const project = this.loadProject(oldId);
        if (!project) {
            throw new NotFoundError(`Cannot rename: project with ID "${oldId}" does not exist.`);
        }

        const index = this.loadIndex();
        if (index.Projects.some((p) => p.Id === newId)) {
            throw new Error(`Cannot rename: a project with ID "${newId}" already exists.`);
        }

        const oldFilePath = this.projectFilePath(oldId);
        const newFilePath = this.projectFilePath(newId);

        project.Id = newId;
        project.DateModified = this.now();

        // Write the new file first so no data is lost if the subsequent
        // delete or index write fails.
        writeJsonFile(newFilePath, project);
        fs.unlinkSync(oldFilePath);

        const entry = index.Projects.find((p) => p.Id === oldId);
        if (entry) {
            entry.Id = newId;
        }
        this.saveIndex(index);

        return project;
    }

    /**
     * Removes a project from the index and deletes the project JSON file.
     *
     * @throws {Error} If no project with the given ID exists in the index.
     */
    remove(id: string): void {
        const index = this.loadIndex();
        const entryIndex = index.Projects.findIndex((p) => p.Id === id);
        if (entryIndex === -1) {
            throw new NotFoundError(`Cannot remove: project with ID "${id}" does not exist.`);
        }

        const filePath = this.projectFilePath(id);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        index.Projects.splice(entryIndex, 1);
        this.saveIndex(index);
    }

    /**
     * Adds a repository to the project's repository list.
     * Updates `DateModified`.
     *
     * @throws {Error} If the project does not exist.
     * @throws {Error} If the repository ID does not exist.
     * @throws {Error} If the repository is already listed in the project.
     */
    addRepository(projectId: string, repositoryId: string): ProjectData {
        const project = this.loadProject(projectId);
        if (!project) {
            throw new NotFoundError(`Cannot addRepository: project with ID "${projectId}" does not exist.`);
        }

        if (!this.repositoryManager.exists(repositoryId)) {
            throw new NotFoundError(`Repository with ID "${repositoryId}" does not exist.`);
        }

        if (project.Repositories.includes(repositoryId)) {
            throw new Error(
                `Repository "${repositoryId}" is already listed in project "${projectId}".`
            );
        }

        project.Repositories.push(repositoryId);
        project.DateModified = this.now();
        this.saveProject(project);
        return project;
    }

    /**
     * Removes a repository from the project's repository list.
     * Updates `DateModified`.
     *
     * @throws {Error} If the project does not exist.
     * @throws {Error} If the repository is not listed in the project.
     */
    removeRepository(projectId: string, repositoryId: string): ProjectData {
        const project = this.loadProject(projectId);
        if (!project) {
            throw new NotFoundError(`Cannot removeRepository: project with ID "${projectId}" does not exist.`);
        }

        const idx = project.Repositories.indexOf(repositoryId);
        if (idx === -1) {
            throw new Error(
                `Repository "${repositoryId}" is not listed in project "${projectId}".`
            );
        }

        project.Repositories.splice(idx, 1);
        project.DateModified = this.now();
        this.saveProject(project);
        return project;
    }

    // -------------------------------------------------------------------------
    // Workspace storage helpers (used exclusively by WorkspaceManager)
    // -------------------------------------------------------------------------

    /**
     * Adds a new workspace entry to the project's Workspaces map and persists it.
     * No format or uniqueness validation is performed — WorkspaceManager is
     * responsible for all business-rule checks before calling this method.
     *
     * @throws {Error} If the project does not exist.
     */
    addWorkspace(projectId: string, workspaceId: string, workspace: ProjectWorkspace): ProjectData {
        const project = this.loadProject(projectId);
        if (!project) {
            throw new NotFoundError(`Cannot addWorkspace: project with ID "${projectId}" does not exist.`);
        }
        project.Workspaces[workspaceId] = workspace;
        project.DateModified = this.now();
        this.saveProject(project);
        return project;
    }

    /**
     * Applies partial field updates to an existing workspace entry and persists the project.
     *
     * **Intentional design:** No workspace-existence check is performed here.
     * `WorkspaceManager.update()` always validates that the workspace exists
     * before calling this helper, so the check is not duplicated at the storage
     * layer. This helper is package-internal (used exclusively by
     * WorkspaceManager) — callers that bypass WorkspaceManager must perform
     * their own existence check before invoking this method.
     *
     * Note: `renameWorkspace()` does include a defensive null guard because it
     * also needs to access the workspace entry to move it — the guard there
     * serves a structural role, not just a validation one.
     *
     * @throws {Error} If the project does not exist.
     */
    updateWorkspace(
        projectId: string,
        workspaceId: string,
        changes: Partial<Pick<ProjectWorkspace, 'Description' | 'DateModified'>>,
    ): ProjectData {
        const project = this.loadProject(projectId);
        if (!project) {
            throw new NotFoundError(`Cannot updateWorkspace: project with ID "${projectId}" does not exist.`);
        }
        const ws = project.Workspaces[workspaceId];
        if (!ws) {
            throw new NotFoundError(`Cannot updateWorkspace: workspace "${workspaceId}" does not exist in project "${projectId}".`);
        }
        if (changes.Description !== undefined) {
            ws.Description = changes.Description;
        }
        if (changes.DateModified !== undefined) {
            ws.DateModified = changes.DateModified;
        }
        project.DateModified = this.now();
        this.saveProject(project);
        return project;
    }

    /**
     * Removes a workspace entry from the project's Workspaces map and persists the project.
     * No STABLE-protection check is performed — WorkspaceManager handles that.
     *
     * @throws {Error} If the project does not exist.
     */
    removeWorkspace(projectId: string, workspaceId: string): ProjectData {
        const project = this.loadProject(projectId);
        if (!project) {
            throw new NotFoundError(`Cannot removeWorkspace: project with ID "${projectId}" does not exist.`);
        }
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete project.Workspaces[workspaceId];
        project.DateModified = this.now();
        this.saveProject(project);
        return project;
    }

    /**
     * Renames a workspace key in the Workspaces map, updates the entry's
     * `DateModified` to the supplied timestamp, and persists the project.
     * No format or uniqueness validation is performed — WorkspaceManager is
     * responsible for all business-rule checks before calling this method.
     *
     * @throws {Error} If the project does not exist.
     */
    renameWorkspace(
        projectId: string,
        oldId: string,
        newId: string,
        dateModified: string,
    ): ProjectData {
        const project = this.loadProject(projectId);
        if (!project) {
            throw new NotFoundError(`Cannot renameWorkspace: project with ID "${projectId}" does not exist.`);
        }
        const ws = project.Workspaces[oldId];
        if (!ws) {
            throw new NotFoundError(`Cannot renameWorkspace: workspace "${oldId}" does not exist in project "${projectId}".`);
        }
        ws.DateModified = dateModified;
        project.Workspaces[newId] = ws;
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete project.Workspaces[oldId];
        project.DateModified = this.now();
        this.saveProject(project);
        return project;
    }
}
