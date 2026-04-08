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
