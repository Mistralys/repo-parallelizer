/**
 * Shared normalisation helpers for backend response objects.
 *
 * The Go backend serialises object fields with capitalised keys (`Id`, `Name`,
 * `Url`, etc.). These helpers accept either casing and return a consistently
 * lowercase-keyed object so view code can rely on a single shape.
 *
 * @module utils/normalise
 */

/**
 * Normalise a repository object from the backend.
 *
 * @param {Object} repo
 * @returns {{ id: string, name: string, url: string, description: string, credentialId: string|undefined, LastRefreshedAt: string|undefined, infoSync: { enabled: boolean, lastSyncedAt: string|undefined }|undefined }}
 *
 * @remarks
 * Unlike other normalised fields, `LastRefreshedAt` intentionally retains its
 * Go-capitalised casing in the returned object. This preserves compatibility
 * with existing consumers (e.g. `buildRepoStatusCells`) that already reference
 * it by that name. All other fields (`id`, `name`, `url`, `description`,
 * `credentialId`, `infoSync`) use camelCase as the normalised form.
 *
 * `infoSync` is only populated with `enabled` and `lastSyncedAt` — the
 * backend's `InfoSync.LastWrittenHash` is a machine-local sync-detection
 * detail with no GUI use and is intentionally never exposed here. `infoSync`
 * itself is `undefined` when the backend omits `InfoSync` (sync never
 * configured for this repository).
 */
export function normaliseRepo(repo) {
    const rawInfoSync = repo.InfoSync || repo.infoSync;
    return {
        id:              repo.Id   || repo.id   || '',
        name:            repo.Name || repo.name || '',
        url:             repo.Url  || repo.url  || repo.URL || '',
        description:     repo.Description || repo.description || '',
        credentialId:    repo.CredentialId || repo.credentialId || undefined,
        LastRefreshedAt: repo.LastRefreshedAt || repo.lastRefreshedAt || undefined,
        infoSync: rawInfoSync
            ? {
                enabled:      rawInfoSync.Enabled != null ? rawInfoSync.Enabled : !!rawInfoSync.enabled,
                lastSyncedAt: rawInfoSync.LastSyncedAt || rawInfoSync.lastSyncedAt || undefined,
            }
            : undefined,
    };
}

/**
 * Normalise a project object from the backend (Go-style capitalised keys or
 * lowercase — both are supported).
 *
 * @param {Object} project
 * @returns {{ id: string, name: string, description: string, repositories: string[] }}
 */
export function normaliseProject(project) {
    return {
        id:           project.Id          || project.id          || '',
        name:         project.Name        || project.name        || '',
        description:  project.Description || project.description || '',
        repositories: Array.isArray(project.Repositories)
            ? project.Repositories
            : (Array.isArray(project.repositories) ? project.repositories : []),
    };
}

/**
 * Normalise a workspace object from the backend.
 *
 * The backend returns `WorkspaceID` and `DateCreated` (not `Id` / `CreatedAt`),
 * so we must map both naming conventions.
 *
 * @param {Object} ws
 * @returns {{ id: string, description: string, createdAt: string, initialized: boolean, folderPath: string, notes: string }}
 */
export function normaliseWorkspace(ws) {
    return {
        id:          ws.WorkspaceID || ws.Id   || ws.id          || '',
        description: ws.Description || ws.description || '',
        createdAt:   ws.DateCreated || ws.CreatedAt || ws.createdAt || ws.created_at || '',
        initialized: ws.Initialized != null ? ws.Initialized : (ws.initialized != null ? ws.initialized : true),
        folderPath:  ws.FolderPath  || ws.folderPath  || '',
        notes:       ws.Notes       ?? ws.notes       ?? '',
    };
}

/**
 * Normalise the response from `GET /api/notes`.
 *
 * Transforms the PascalCase backend shape into camelCase for frontend use:
 *
 * Backend:
 * ```json
 * { "Projects": [{ "ProjectId": "x", "ProjectName": "X",
 *     "Workspaces": [{ "WorkspaceId": "STABLE", "Notes": "" }] }] }
 * ```
 *
 * Normalised:
 * ```json
 * { "projects": [{ "projectId": "x", "projectName": "X",
 *     "workspaces": [{ "workspaceId": "STABLE", "notes": "" }] }] }
 * ```
 *
 * @param {{ Projects: Array<{ ProjectId: string, ProjectName: string,
 *   Workspaces: Array<{ WorkspaceId: string, Notes: string }> }> }} response
 * @returns {{ projects: Array<{ projectId: string, projectName: string,
 *   workspaces: Array<{ workspaceId: string, notes: string }> }> }}
 */
export function normaliseNotesResponse(response) {
    const rawProjects = Array.isArray(response?.Projects) ? response.Projects : [];
    return {
        projects: rawProjects.map((p) => ({
            projectId:   p.ProjectId   || '',
            projectName: p.ProjectName || '',
            workspaces: Array.isArray(p.Workspaces)
                ? p.Workspaces.map((ws) => ({
                    workspaceId: ws.WorkspaceId || '',
                    notes:       ws.Notes ?? '',
                }))
                : [],
        })),
    };
}

/**
 * Normalise an error log entry from the backend.
 *
 * The Go backend serialises struct fields with capitalised keys (`Id`,
 * `Severity`, `Source`, `Message`, `Details`, `Timestamp`, `Project`,
 * `Workspace`, `Repository`). This helper accepts either casing and returns
 * a consistently camelCase-keyed object for use in view code.
 *
 * @param {Object} entry
 * @returns {{
 *   id:         number,
 *   severity:   string,
 *   source:     string,
 *   message:    string,
 *   details:    string,
 *   timestamp:  string,
 *   project:    string,
 *   workspace:  string,
 *   repository: string
 * }}
 */
export function normaliseErrorEntry(entry) {
    return {
        id:         entry.Id         ?? entry.id         ?? 0,
        severity:   entry.Severity   || entry.severity   || '',
        source:     entry.Source     || entry.source     || '',
        message:    entry.Message    || entry.message    || '',
        details:    entry.Details    || entry.details    || '',
        timestamp:  entry.Timestamp  || entry.timestamp  || '',
        project:    entry.Project    || entry.project    || '',
        workspace:  entry.Workspace  || entry.workspace  || '',
        repository: entry.Repository || entry.repository || '',
    };
}

/**
 * Normalise a repository file object from the backend (PascalCase or
 * camelCase `RepositoryFile`, Milestone 2). Mirrors `normaliseCustomFile()`
 * in `views/project-custom-files.js`: fills every field's default and drops
 * any unrecognised key from the input object.
 *
 * @param {Object} f
 * @returns {{ id: string, directory: string, fileName: string, label: string, description: string, content: string, executable: boolean, listInAgents: boolean, dateModified: string }}
 */
export function normaliseRepositoryFile(f) {
    return {
        id:           f.Id           || f.id           || '',
        directory:    f.Directory    ?? f.directory    ?? '',
        fileName:     f.FileName     ?? f.fileName     ?? '',
        label:        f.Label        ?? f.label        ?? '',
        description:  f.Description  ?? f.description  ?? '',
        content:      f.Content      ?? f.content      ?? '',
        executable:   (f.Executable   ?? f.executable)   === true,
        listInAgents: (f.ListInAgents ?? f.listInAgents) === true,
        dateModified: f.DateModified  || f.dateModified  || '',
    };
}
