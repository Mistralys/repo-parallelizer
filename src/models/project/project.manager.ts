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
import { randomUUID } from 'node:crypto';
import { validateDirectiveInput, type AgentDirective, type AgentDirectiveInput, type DirectiveScope } from './directive.js';
import { validateRepositoryRole } from './repository-role.js';
import { validateCustomFileInput, type CustomFile, type CustomFileInput } from './custom-file.js';

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
        if (project.RepositoryRoles && Object.prototype.hasOwnProperty.call(project.RepositoryRoles, repositoryId)) {
            delete project.RepositoryRoles[repositoryId];
            if (Object.keys(project.RepositoryRoles).length === 0) {
                delete project.RepositoryRoles;
            }
        }
        project.DateModified = this.now();
        this.saveProject(project);
        return project;
    }

    // -------------------------------------------------------------------------
    // Repository roles
    // -------------------------------------------------------------------------

    /**
     * Returns the project's repository roles as a map of repository ID to
     * role text (empty object when none).
     *
     * @throws {NotFoundError} If the project does not exist.
     */
    getRepositoryRoles(projectId: string): Record<string, string> {
        const project = this.loadProject(projectId);
        if (!project) {
            throw new NotFoundError(`Cannot get repository roles: project with ID "${projectId}" does not exist.`);
        }
        return { ...(project.RepositoryRoles ?? {}) };
    }

    /**
     * Sets, replaces or (with empty text) clears the role of a repository.
     * Text is validated via `validateRepositoryRole()`. Updates `DateModified`.
     *
     * @returns The stored role text, or `''` when the role was cleared.
     * @throws {NotFoundError} If the project does not exist.
     * @throws {Error} If the repository is not listed in the project, or the
     *   text is invalid.
     */
    setRepositoryRole(projectId: string, repositoryId: string, text: string): string {
        const project = this.loadProject(projectId);
        if (!project) {
            throw new NotFoundError(`Cannot set repository role: project with ID "${projectId}" does not exist.`);
        }
        if (!project.Repositories.includes(repositoryId)) {
            throw new NotFoundError(`Repository "${repositoryId}" is not listed in project "${projectId}".`);
        }

        const role = validateRepositoryRole(text);
        const roles: Record<string, string> = { ...(project.RepositoryRoles ?? {}) };
        if (role === '') {
            delete roles[repositoryId];
        } else {
            roles[repositoryId] = role;
        }

        if (Object.keys(roles).length === 0) {
            delete project.RepositoryRoles;
        } else {
            project.RepositoryRoles = roles;
        }
        project.DateModified = this.now();
        this.saveProject(project);
        return role;
    }

    // -------------------------------------------------------------------------
    // Custom files
    // -------------------------------------------------------------------------

    /**
     * Returns the project's custom files (empty array when none).
     *
     * @throws {NotFoundError} If the project does not exist.
     */
    listCustomFiles(projectId: string): CustomFile[] {
        const project = this.loadProject(projectId);
        if (!project) {
            throw new NotFoundError(`Cannot list custom files: project with ID "${projectId}" does not exist.`);
        }
        return project.CustomFiles ?? [];
    }

    /**
     * Adds a custom file. Input is validated and normalised via
     * `validateCustomFileInput()`.
     *
     * @throws {NotFoundError} If the project does not exist.
     * @throws {Error} If validation fails (message is user-presentable).
     */
    addCustomFile(projectId: string, input: CustomFileInput): CustomFile {
        const project = this.loadProject(projectId);
        if (!project) {
            throw new NotFoundError(`Cannot add custom file: project with ID "${projectId}" does not exist.`);
        }

        const files = project.CustomFiles ?? [];
        const valid = validateCustomFileInput(input, project.Repositories, files);
        const now = this.now();
        const file: CustomFile = { Id: randomUUID(), ...valid, DateModified: now };

        project.CustomFiles = [...files, file];
        project.DateModified = now;
        this.saveProject(project);
        return file;
    }

    /**
     * Replaces the editable fields of a custom file.
     *
     * @returns The previous and updated definitions, so the caller can clean
     *   up the old on-disk path when the location changed.
     * @throws {NotFoundError} If the project or the custom file does not exist.
     * @throws {Error} If validation fails.
     */
    updateCustomFile(
        projectId: string,
        fileId: string,
        input: CustomFileInput,
    ): { previous: CustomFile; updated: CustomFile } {
        const project = this.loadProject(projectId);
        if (!project) {
            throw new NotFoundError(`Cannot update custom file: project with ID "${projectId}" does not exist.`);
        }

        const files = project.CustomFiles ?? [];
        const idx = files.findIndex((f) => f.Id === fileId);
        if (idx === -1) {
            throw new NotFoundError(`Custom file "${fileId}" does not exist in project "${projectId}".`);
        }

        const valid = validateCustomFileInput(input, project.Repositories, files.filter((f) => f.Id !== fileId));
        const now = this.now();
        const previous = files[idx];
        const updated: CustomFile = { Id: fileId, ...valid, DateModified: now };

        project.CustomFiles = files.map((f, i) => (i === idx ? updated : f));
        project.DateModified = now;
        this.saveProject(project);
        return { previous, updated };
    }

    /**
     * Removes a custom file definition and returns it, so the caller can
     * delete its copies from the workspaces.
     *
     * @throws {NotFoundError} If the project or the custom file does not exist.
     */
    removeCustomFile(projectId: string, fileId: string): CustomFile {
        const project = this.loadProject(projectId);
        if (!project) {
            throw new NotFoundError(`Cannot remove custom file: project with ID "${projectId}" does not exist.`);
        }

        const files = project.CustomFiles ?? [];
        const removed = files.find((f) => f.Id === fileId);
        if (!removed) {
            throw new NotFoundError(`Custom file "${fileId}" does not exist in project "${projectId}".`);
        }

        project.CustomFiles = files.filter((f) => f.Id !== fileId);
        project.DateModified = this.now();
        this.saveProject(project);
        return removed;
    }

    // -------------------------------------------------------------------------
    // Agent directives
    // -------------------------------------------------------------------------

    /**
     * Resolves the directive list and its owner for a scope. Returns the
     * project plus accessors so callers share one scope-resolution path.
     *
     * @throws {NotFoundError} If the project or workspace does not exist.
     * @throws {Error} If a workspace scope has a blank `workspaceId`, or the
     *   scope kind is unknown.
     */
    private resolveDirectiveScope(projectId: string, scope: DirectiveScope, action: string): {
        project: ProjectData;
        get: () => AgentDirective[];
        set: (list: AgentDirective[], now: string) => void;
    } {
        const project = this.loadProject(projectId);
        if (!project) {
            throw new NotFoundError(`Cannot ${action}: project with ID "${projectId}" does not exist.`);
        }
        const kind = (scope as { kind?: unknown } | undefined)?.kind;
        if (kind === 'project') {
            return {
                project,
                get: () => project.Directives ?? [],
                set: (list) => { project.Directives = list; },
            };
        }
        if (kind === 'workspace') {
            const workspaceId = (scope as { workspaceId?: unknown }).workspaceId;
            if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
                throw new Error('A workspace ID is required for a workspace-scoped directive.');
            }
            // Own-property check: inherited keys ("__proto__", "constructor", ...) must not resolve.
            const ws = Object.prototype.hasOwnProperty.call(project.Workspaces, workspaceId)
                ? project.Workspaces[workspaceId]
                : undefined;
            if (!ws) {
                throw new NotFoundError(`Cannot ${action}: workspace "${workspaceId}" does not exist in project "${projectId}".`);
            }
            return {
                project,
                get: () => ws.Directives ?? [],
                set: (list, now) => { ws.Directives = list; ws.DateModified = now; },
            };
        }
        throw new Error('A directive scope is required: "project" or "workspace".');
    }

    /**
     * Returns the directives of a scope (empty array when none).
     *
     * @throws {NotFoundError} If the project or workspace does not exist.
     * @throws {Error} If the scope is invalid (e.g. blank workspace ID).
     */
    listDirectives(projectId: string, scope: DirectiveScope): AgentDirective[] {
        return this.resolveDirectiveScope(projectId, scope, 'list directives').get();
    }

    /**
     * Adds a directive to a scope. Input is validated via `validateDirectiveInput()`.
     *
     * @throws {NotFoundError} If the project or workspace does not exist.
     * @throws {Error} If the scope or the input is invalid.
     */
    addDirective(projectId: string, scope: DirectiveScope, input: AgentDirectiveInput): AgentDirective {
        const ctx = this.resolveDirectiveScope(projectId, scope, 'add directive');
        const list = ctx.get();
        const valid = validateDirectiveInput(input, list);
        const now = this.now();
        const directive: AgentDirective = { Id: randomUUID(), ...valid, DateModified: now };

        ctx.set([...list, directive], now);
        ctx.project.DateModified = now;
        this.saveProject(ctx.project);
        return directive;
    }

    /**
     * Replaces the text of a directive.
     *
     * @throws {NotFoundError} If the project, workspace or directive does not exist.
     * @throws {Error} If the scope or the input is invalid.
     */
    updateDirective(
        projectId: string,
        scope: DirectiveScope,
        directiveId: string,
        input: AgentDirectiveInput,
    ): AgentDirective {
        const ctx = this.resolveDirectiveScope(projectId, scope, 'update directive');
        const list = ctx.get();
        const idx = list.findIndex((d) => d.Id === directiveId);
        if (idx === -1) {
            throw new NotFoundError(`Directive "${directiveId}" does not exist in project "${projectId}".`);
        }

        const valid = validateDirectiveInput(input, list.filter((d) => d.Id !== directiveId));
        const now = this.now();
        const updated: AgentDirective = { Id: directiveId, ...valid, DateModified: now };

        ctx.set(list.map((d, i) => (i === idx ? updated : d)), now);
        ctx.project.DateModified = now;
        this.saveProject(ctx.project);
        return updated;
    }

    /**
     * Removes a directive and returns it.
     *
     * @throws {NotFoundError} If the project, workspace or directive does not exist.
     * @throws {Error} If the scope is invalid.
     */
    removeDirective(projectId: string, scope: DirectiveScope, directiveId: string): AgentDirective {
        const ctx = this.resolveDirectiveScope(projectId, scope, 'remove directive');
        const list = ctx.get();
        const removed = list.find((d) => d.Id === directiveId);
        if (!removed) {
            throw new NotFoundError(`Directive "${directiveId}" does not exist in project "${projectId}".`);
        }

        const now = this.now();
        ctx.set(list.filter((d) => d.Id !== directiveId), now);
        ctx.project.DateModified = now;
        this.saveProject(ctx.project);
        return removed;
    }

    /**
     * Updates the `LastActivity` timestamp on a project without touching
     * `DateModified`.
     *
     * - Short-circuits (no disk write) when `value` already equals the stored
     *   `LastActivity`.
     * - Silently returns when the project ID does not exist (no error thrown).
     *
     * @param id    The project ID to update.
     * @param value An ISO 8601 timestamp string (e.g. `"2024-03-15T12:34:56.000Z"`).
     *   In practice this value is always sourced from `GitStatusInfo.lastActivity`,
     *   which is derived from a git commit timestamp and normalised to a consistent
     *   UTC offset by the git layer.  No format validation is performed here — the
     *   caller is responsible for passing a well-formed ISO 8601 string.
     * @returns void — intentionally does not return the updated project.
     *   Use `getById()` if you need the full project data after the update.
     */
    updateLastActivity(id: string, value: string): void {
        const project = this.loadProject(id);
        if (!project) {
            return;
        }
        if (project.LastActivity === value) {
            return;
        }
        project.LastActivity = value;
        this.saveProject(project);
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
        changes: Partial<Pick<ProjectWorkspace, 'Description' | 'DateModified' | 'Notes'>>,
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
        if (changes.Notes !== undefined) {
            ws.Notes = changes.Notes;
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
