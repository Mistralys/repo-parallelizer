# Models - Architecture
_SOURCE: Data types and manager classes for all three model domains_
# Data types and manager classes for all three model domains
```
// Structure of documents
└── src/
    └── models/
        └── project/
            ├── project.manager.ts
            ├── project.types.ts
        └── repository/
            ├── repository.manager.ts
            ├── repository.types.ts
        └── workspace/
            └── workspace.manager.ts
            └── workspace.types.ts

```
###  Path: `/src/models/project/project.manager.ts`

```ts
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

```
###  Path: `/src/models/project/project.types.ts`

```ts
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

```
###  Path: `/src/models/repository/repository.manager.ts`

```ts
import * as path from 'node:path';
import type { AppConfig } from '../../config/config.types.js';
import { readJsonFile, writeJsonFile, FileNotFoundError } from '../../storage/json-storage.js';
import { inferSlugFromUrl, isValidKebabCase } from '../../utils/slug.js';
import { NotFoundError } from '../../errors.js';
import { hasEmbeddedCredentials, stripEmbeddedCredentials } from '../../git/git-credentials.js';
import type { Repository, RepositoryStore } from './repository.types.js';

const REPOSITORIES_FILE = 'repositories.json';

const DEFAULT_STORE: RepositoryStore = { Repositories: [], SchemaVersion: 1 };

/**
 * Strips embedded credentials from a URL before interpolation into error
 * messages. Replaces `//user:pass@` or `//token@` with `//***@`.
 *
 * **Used only for error message interpolation** — not for producing clean URLs
 * to store or compare. For sanitising URLs before storage, use
 * `stripEmbeddedCredentials()` from `git-credentials.ts`, which applies the
 * WHATWG URL object path for pure HTTPS URLs and a regex fallback for prose
 * strings (e.g. git error messages).
 */
function redactUrl(url: string): string {
    return url.replace(/\/\/[^@]+@/, '//***@');
}

/**
 * Provides CRUD operations over the persisted repositories store.
 *
 * Every public method is stateless — it re-reads the store from disk on each
 * call so that concurrent writes from other processes are always reflected.
 */
export class RepositoryManager {
    private readonly filePath: string;

    constructor(config: AppConfig) {
        this.filePath = path.join(config.storageFolder, REPOSITORIES_FILE);
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private load(): RepositoryStore {
        try {
            return readJsonFile<RepositoryStore>(this.filePath);
        } catch (err) {
            if (err instanceof FileNotFoundError) {
                // Spread DEFAULT_STORE and override Repositories with a fresh array
                // so that callers pushing to store.Repositories cannot accidentally
                // mutate the module-level constant across calls.
                return { ...DEFAULT_STORE, Repositories: [] };
            }
            throw err;
        }
    }

    private save(store: RepositoryStore): void {
        writeJsonFile(this.filePath, store);
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Returns all repositories in the store.
     */
    list(): Repository[] {
        return this.load().Repositories;
    }

    /**
     * Returns the repository with the given ID, or `undefined` if not found.
     */
    getById(id: string): Repository | undefined {
        return this.load().Repositories.find((r) => r.Id === id);
    }

    /**
     * Returns `true` when a repository with the given ID exists in the store.
     */
    exists(id: string): boolean {
        return this.getById(id) !== undefined;
    }

    /**
     * Adds a new repository to the store.
     *
     * - When `id` is omitted, the ID is inferred from `url` via `inferSlugFromUrl()`.
     * - When `id` is provided explicitly it is validated via `isValidKebabCase()`
     *   after trimming. Path-traversal sequences and invalid formats are rejected.
     * - When `name` is omitted, it defaults to the resolved ID.
     *
     * @param params.url  Remote Git URL (HTTPS or SSH).
     * @param params.name Optional human-readable display name. Defaults to the resolved ID.
     * @param params.id   Optional explicit repository ID. Must be a valid kebab-case string.
     *
     * @throws {Error} If the explicit `id` is not valid kebab-case.
     * @throws {Error} If the URL produces an empty slug and no explicit `id` was given.
     * @throws {Error} If a repository with the same ID already exists.
     * @throws {Error} If a repository with the same URL already exists.
     */
    add(params: { url: string; name?: string; id?: string }): Repository {
        const store = this.load();

        let id = params.id;
        if (id) {
            id = id.trim();
            if (!isValidKebabCase(id)) {
                throw new Error(
                    `Invalid repository ID "${id}": must be a valid kebab-case string ` +
                    `(lowercase alphanumeric segments separated by single hyphens).`
                );
            }
        } else {
            id = inferSlugFromUrl(params.url);
            if (id === '') {
                throw new Error(
                    `Cannot infer a repository ID from URL "${redactUrl(params.url)}": the URL produced an empty slug. ` +
                    `Please provide an explicit ID.`
                );
            }
        }

        const name = params.name ?? id;

        // Strip embedded credentials from the URL before storing.
        let cleanUrl = params.url;
        if (hasEmbeddedCredentials(params.url)) {
            cleanUrl = stripEmbeddedCredentials(params.url);
            console.warn(
                `[repo-parallelizer] Warning: repository URL contains embedded credentials. ` +
                `The credentials have been stripped from the stored URL. ` +
                `Configure private repository access via "gitCredentials" in config.json instead.`
            );
        }

        const duplicate = store.Repositories.find((r) => r.Id === id);
        if (duplicate) {
            throw new Error(
                `A repository with ID "${id}" already exists.`
            );
        }

        const duplicateUrl = store.Repositories.find((r) => r.Url === cleanUrl);
        if (duplicateUrl) {
            throw new Error(
                `A repository with URL "${redactUrl(cleanUrl)}" already exists (ID: "${duplicateUrl.Id}").`
            );
        }

        const repo: Repository = { Id: id, Name: name, Url: cleanUrl };
        store.Repositories.push(repo);
        this.save(store);
        return repo;
    }

    /**
     * Updates the `Name` of an existing repository.
     *
     * @throws {Error} If no repository with the given ID exists.
     */
    update(id: string, params: { name: string }): Repository {
        const store = this.load();
        const index = store.Repositories.findIndex((r) => r.Id === id);

        if (index === -1) {
            throw new NotFoundError(`Cannot update: repository with ID "${id}" does not exist.`);
        }

        store.Repositories[index] = { ...store.Repositories[index], Name: params.name };
        this.save(store);
        return store.Repositories[index];
    }

    /**
     * Removes the repository with the given ID from the store.
     *
     * @throws {Error} If no repository with the given ID exists.
     */
    remove(id: string): void {
        const store = this.load();
        const index = store.Repositories.findIndex((r) => r.Id === id);

        if (index === -1) {
            throw new NotFoundError(`Cannot remove: repository with ID "${id}" does not exist.`);
        }

        store.Repositories.splice(index, 1);
        this.save(store);
    }
}

```
###  Path: `/src/models/repository/repository.types.ts`

```ts
import type { BaseStore } from '../../storage/storage.types.js';

/**
 * Represents a single tracked Git repository.
 */
export interface Repository {
    /** Unique kebab-case identifier, inferred from URL when not provided explicitly. */
    Id: string;

    /** Human-readable display name. */
    Name: string;

    /** Remote Git URL (HTTPS or SSH). */
    Url: string;
}

/**
 * Top-level shape of the repositories.json storage file.
 */
export interface RepositoryStore extends BaseStore {
    Repositories: Repository[];
}

```
###  Path: `/src/models/workspace/workspace.manager.ts`

```ts
// `import type` used here intentionally: ProjectManager is injected via the constructor
// and never constructed inside this module, so no runtime import is needed.
import type { ProjectManager } from '../project/project.manager.js';
import { isValidWorkspaceId } from '../../utils/slug.js';
import { NotFoundError } from '../../errors.js';
import { STABLE_WORKSPACE_ID } from './workspace.types.js';
import type { WorkspaceInfo } from './workspace.types.js';

/**
 * Provides CRUD operations over the Workspaces collection embedded in each
 * project's storage file.
 *
 * All persistence is delegated to ProjectManager — WorkspaceManager has no
 * storage files of its own. Every public method is stateless between calls.
 *
 * ## STABLE workspace invariant
 *
 * Every project is guaranteed to have exactly one workspace with the ID
 * `"STABLE"`. This workspace is auto-created by `ProjectManager.create()` and
 * cannot be removed or renamed:
 *
 * - `remove()` throws if `workspaceId` is `"STABLE"`.
 * - `rename()` throws if `oldId` is `"STABLE"`.
 *
 * The `isStable()` helper captures the definition of "STABLE" in a single
 * place. All protection checks call it so that any future change to the
 * reserved ID only needs to be made in one location.
 */
export class WorkspaceManager {
    constructor(
        private readonly projectManager: ProjectManager,
    ) {}

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private now(): string {
        return new Date().toISOString();
    }

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    /**
     * Returns all workspaces for the given project as flat WorkspaceInfo objects.
     *
     * @throws {Error} If the project does not exist.
     */
    list(projectId: string): WorkspaceInfo[] {
        const project = this.projectManager.getById(projectId);
        if (!project) {
            throw new NotFoundError(
                `Cannot list workspaces: project with ID "${projectId}" does not exist.`
            );
        }
        return Object.entries(project.Workspaces).map(([wsId, ws]) => ({
            ProjectID: projectId,
            WorkspaceID: wsId,
            Description: ws.Description,
            DateCreated: ws.DateCreated,
            DateModified: ws.DateModified,
        }));
    }

    /**
     * Returns the WorkspaceInfo for a single workspace, or `undefined` if not found.
     *
     * @throws {Error} If the project does not exist.
     */
    getById(projectId: string, workspaceId: string): WorkspaceInfo | undefined {
        const project = this.projectManager.getById(projectId);
        if (!project) {
            throw new NotFoundError(
                `Cannot get workspace: project with ID "${projectId}" does not exist.`
            );
        }
        const ws = project.Workspaces[workspaceId];
        if (!ws) {
            return undefined;
        }
        return {
            ProjectID: projectId,
            WorkspaceID: workspaceId,
            Description: ws.Description,
            DateCreated: ws.DateCreated,
            DateModified: ws.DateModified,
        };
    }

    /**
     * Creates a new workspace in the given project.
     *
     * - Validates `workspaceId` format via `isValidWorkspaceId()`.
     * - Validates that no workspace with the same ID already exists in the project.
     *
     * @throws {Error} If the project does not exist.
     * @throws {Error} If `workspaceId` is not 2–6 uppercase ASCII letters.
     * @throws {Error} If a workspace with `workspaceId` already exists in the project.
     */
    create(projectId: string, workspaceId: string, description?: string): WorkspaceInfo {
        if (!isValidWorkspaceId(workspaceId)) {
            throw new Error(
                `Invalid workspace ID "${workspaceId}": must be 2–6 uppercase ASCII letters (A–Z) ` +
                `with no digits or special characters.`
            );
        }

        const project = this.projectManager.getById(projectId);
        if (!project) {
            throw new NotFoundError(
                `Cannot create workspace: project with ID "${projectId}" does not exist.`
            );
        }

        if (workspaceId in project.Workspaces) {
            throw new Error(
                `A workspace with ID "${workspaceId}" already exists in project "${projectId}".`
            );
        }

        const timestamp = this.now();
        const workspace = {
            Description: description ?? '',
            DateCreated: timestamp,
            DateModified: timestamp,
        };

        this.projectManager.addWorkspace(projectId, workspaceId, workspace);

        return {
            ProjectID: projectId,
            WorkspaceID: workspaceId,
            Description: workspace.Description,
            DateCreated: timestamp,
            DateModified: timestamp,
        };
    }

    /**
     * Updates the `Description` of an existing workspace.
     * Always updates `DateModified` on the workspace entry.
     *
     * @throws {Error} If the project does not exist.
     * @throws {Error} If the workspace does not exist.
     */
    update(projectId: string, workspaceId: string, changes: { Description?: string }): WorkspaceInfo {
        const project = this.projectManager.getById(projectId);
        if (!project) {
            throw new NotFoundError(
                `Cannot update workspace: project with ID "${projectId}" does not exist.`
            );
        }

        if (!(workspaceId in project.Workspaces)) {
            throw new NotFoundError(
                `Cannot update: workspace "${workspaceId}" does not exist in project "${projectId}".`
            );
        }

        const dateModified = this.now();
        const updated = this.projectManager.updateWorkspace(projectId, workspaceId, {
            Description: changes.Description,
            DateModified: dateModified,
        });

        const ws = updated.Workspaces[workspaceId];
        return {
            ProjectID: projectId,
            WorkspaceID: workspaceId,
            Description: ws.Description,
            DateCreated: ws.DateCreated,
            DateModified: ws.DateModified,
        };
    }

    /**
     * Renames a workspace by changing its ID.
     *
     * - Protects the STABLE workspace: `oldId` must not be `"STABLE"`.
     * - Validates the new ID format via `isValidWorkspaceId()`.
     * - Validates the new ID is unique within the project.
     * - Updates `DateModified` on the workspace entry.
     *
     * @throws {Error} If attempting to rename the STABLE workspace.
     * @throws {Error} If the project does not exist.
     * @throws {Error} If the workspace does not exist.
     * @throws {Error} If `newId` is not 2–6 uppercase ASCII letters.
     * @throws {Error} If a workspace with `newId` already exists in the project.
     */
    rename(projectId: string, oldId: string, newId: string): WorkspaceInfo {
        if (this.isStable(oldId)) {
            throw new Error(
                `Cannot rename the STABLE workspace: it is the default workspace for ` +
                `project "${projectId}" and cannot be renamed.`
            );
        }

        if (!isValidWorkspaceId(newId)) {
            throw new Error(
                `Invalid workspace ID "${newId}": must be 2–6 uppercase ASCII letters (A–Z) ` +
                `with no digits or special characters.`
            );
        }

        const project = this.projectManager.getById(projectId);
        if (!project) {
            throw new NotFoundError(
                `Cannot rename workspace: project with ID "${projectId}" does not exist.`
            );
        }

        if (!(oldId in project.Workspaces)) {
            throw new NotFoundError(
                `Cannot rename: workspace "${oldId}" does not exist in project "${projectId}".`
            );
        }

        if (newId in project.Workspaces) {
            throw new Error(
                `Cannot rename: a workspace with ID "${newId}" already exists in project "${projectId}".`
            );
        }

        const dateModified = this.now();
        const updated = this.projectManager.renameWorkspace(projectId, oldId, newId, dateModified);

        const ws = updated.Workspaces[newId];
        return {
            ProjectID: projectId,
            WorkspaceID: newId,
            Description: ws.Description,
            DateCreated: ws.DateCreated,
            DateModified: ws.DateModified,
        };
    }

    /**
     * Removes a workspace from the project.
     *
     * @throws {Error} If attempting to remove the STABLE workspace.
     * @throws {Error} If the project does not exist.
     * @throws {Error} If the workspace does not exist.
     */
    remove(projectId: string, workspaceId: string): void {
        if (this.isStable(workspaceId)) {
            throw new Error(
                `Cannot remove the STABLE workspace: it is the default workspace for ` +
                `project "${projectId}" and cannot be deleted.`
            );
        }

        const project = this.projectManager.getById(projectId);
        if (!project) {
            throw new NotFoundError(
                `Cannot remove workspace: project with ID "${projectId}" does not exist.`
            );
        }

        if (!(workspaceId in project.Workspaces)) {
            throw new NotFoundError(
                `Cannot remove: workspace "${workspaceId}" does not exist in project "${projectId}".`
            );
        }

        this.projectManager.removeWorkspace(projectId, workspaceId);
    }

    /**
     * Returns `true` if and only if `workspaceId` is `"STABLE"`.
     */
    isStable(workspaceId: string): boolean {
        return workspaceId === STABLE_WORKSPACE_ID;
    }
}

```
###  Path: `/src/models/workspace/workspace.types.ts`

```ts
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

    /** Unique workspace identifier (2–6 uppercase ASCII letters, e.g. "STABLE", "DEV"). */
    WorkspaceID: string;

    /** Human-readable description of this workspace. */
    Description: string;

    /** ISO 8601 timestamp when this workspace was created. */
    DateCreated: string;

    /** ISO 8601 timestamp when this workspace was last modified. */
    DateModified: string;
}

```
---
**File Statistics**
- **Size**: 37.47 KB
- **Lines**: 1090
File: `modules/models/architecture-core.md`
