/**
 * API Client for Repo Parallelizer GUI.
 *
 * Centralises all HTTP communication with the backend REST API.
 * All methods return Promises. Non-2xx responses throw an Error whose
 * message is taken from the `error` field in the JSON response body.
 *
 * Usage:
 *   import { api } from './api.js';
 *
 *   const repos = await api.repositories.list();
 *   const project = await api.projects.get('my-project');
 */

// ---------------------------------------------------------------------------
// Internal HTTP helper
// ---------------------------------------------------------------------------

/**
 * Perform a fetch request and return the parsed JSON body.
 *
 * For 204 No Content responses the Promise resolves with `undefined`.
 * For non-2xx responses, an Error is thrown whose message comes from
 * the `error` field in the JSON response body (falling back to the HTTP
 * status text if the body cannot be parsed).
 *
 * @param {string} method - HTTP method (GET, POST, PUT, DELETE, …).
 * @param {string} url    - Absolute or relative URL.
 * @param {Object} [body] - Optional request body (serialised as JSON).
 * @returns {Promise<*>}
 */
async function request(method, url, body) {
    /** @type {RequestInit} */
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
    };

    if (body !== undefined) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    // 204 No Content — nothing to parse.
    if (response.status === 204) {
        return undefined;
    }

    // Attempt to parse JSON for all other responses.
    let json;
    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('application/json')) {
        json = await response.json();
    }

    if (!response.ok) {
        const message =
            (json && json.error) ? json.error : response.statusText;
        throw new Error(message);
    }

    return json;
}

// ---------------------------------------------------------------------------
// Shared type definitions
// ---------------------------------------------------------------------------

/**
 * A project object as returned by the backend REST API.
 *
 * The Go backend serialises struct fields using their Go-style capitalised
 * names (`Id`, `Name`, `Description`, `Repositories`). Future serialiser
 * changes may emit lowercase equivalents (`id`, `name`, `description`,
 * `repositories`). View code **must** normalise both casings:
 *
 * ```js
 * const id   = project.Id   || project.id   || '';
 * const name = project.Name || project.name || id;
 * ```
 *
 * @typedef {Object} ProjectResponse
 * @property {string}   [Id]            - Project ID (Go-capitalised key).
 * @property {string}   [id]            - Project ID (lowercase key).
 * @property {string}   [Name]          - Human-readable project name (Go-capitalised key).
 * @property {string}   [name]          - Human-readable project name (lowercase key).
 * @property {string}   [Description]   - Optional project description (Go-capitalised key).
 * @property {string}   [description]   - Optional project description (lowercase key).
 * @property {Array}    [Repositories]  - Array of associated repository objects (Go-capitalised key).
 * @property {Array}    [repositories]  - Array of associated repository objects (lowercase key).
 */

// ---------------------------------------------------------------------------
// API namespaces
// ---------------------------------------------------------------------------

/**
 * Repository endpoints.
 *
 * @namespace api.repositories
 */
const repositories = {
    /**
     * List all registered repositories.
     * @returns {Promise<Object[]>}
     */
    list() {
        return request('GET', '/api/repositories');
    },

    /**
     * Get a single repository by ID.
     * @param {string} id
     * @returns {Promise<Object>}
     */
    get(id) {
        return request('GET', `/api/repositories/${encodeURIComponent(id)}`);
    },

    /**
     * Register a new repository.
     * @param {{ url: string, name?: string, id?: string }} data
     * @returns {Promise<Object>} The created repository (HTTP 201).
     */
    create(data) {
        return request('POST', '/api/repositories', data);
    },

    /**
     * Update a repository's metadata.
     * @param {string} id
     * @param {{ name: string }} data
     * @returns {Promise<Object>}
     */
    update(id, data) {
        return request('PUT', `/api/repositories/${encodeURIComponent(id)}`, data);
    },

    /**
     * Delete a repository.
     * @param {string} id
     * @returns {Promise<void>}
     */
    delete(id) {
        return request('DELETE', `/api/repositories/${encodeURIComponent(id)}`);
    },
};

/**
 * Project endpoints.
 *
 * @namespace api.projects
 */
const projects = {
    /**
     * List all projects.
     * @returns {Promise<ProjectResponse[]>}
     */
    list() {
        return request('GET', '/api/projects');
    },

    /**
     * Get a single project by ID.
     * @param {string} id
     * @returns {Promise<ProjectResponse>}
     */
    get(id) {
        return request('GET', `/api/projects/${encodeURIComponent(id)}`);
    },

    /**
     * Create a new project.
     * @param {{ name: string, repositoryIds?: string[], description?: string, id?: string }} data
     * @returns {Promise<ProjectResponse>} The created project (HTTP 201).
     */
    create(data) {
        return request('POST', '/api/projects', data);
    },

    /**
     * Update a project's metadata.
     * @param {string} id
     * @param {{ name?: string, description?: string }} data
     * @returns {Promise<ProjectResponse>}
     */
    update(id, data) {
        return request('PUT', `/api/projects/${encodeURIComponent(id)}`, data);
    },

    /**
     * Rename a project (changes its ID).
     * @param {string} id    - Current project ID.
     * @param {string} newId - Desired new project ID.
     * @returns {Promise<ProjectResponse>}
     */
    rename(id, newId) {
        return request('PUT', `/api/projects/${encodeURIComponent(id)}/rename`, { newId });
    },

    /**
     * Delete a project.
     * @param {string} id
     * @returns {Promise<void>}
     */
    delete(id) {
        return request('DELETE', `/api/projects/${encodeURIComponent(id)}`);
    },

    /**
     * Add a repository to a project.
     * @param {string} projectId
     * @param {string} repoId
     * @returns {Promise<ProjectResponse>} The updated project.
     */
    addRepository(projectId, repoId) {
        return request(
            'POST',
            `/api/projects/${encodeURIComponent(projectId)}/repositories`,
            { repositoryId: repoId },
        );
    },

    /**
     * Remove a repository from a project.
     * @param {string} projectId
     * @param {string} repoId
     * @returns {Promise<void>}
     */
    removeRepository(projectId, repoId) {
        return request(
            'DELETE',
            `/api/projects/${encodeURIComponent(projectId)}/repositories/${encodeURIComponent(repoId)}`,
        );
    },
};

/**
 * Workspace endpoints.
 *
 * External-application launchers are grouped under the {@link api.workspaces.launch}
 * sub-namespace rather than as flat methods on this namespace. Add any new
 * launcher methods (e.g. "Open in Terminal") to `api.workspaces.launch` to
 * keep the top-level namespace from growing unwieldy. This mirrors the
 * `api.config.credentials` / `api.config.polling` sub-namespace pattern.
 *
 * @namespace api.workspaces
 */
const workspaces = {
    /**
     * List all workspaces for a project.
     * @param {string} projectId
     * @returns {Promise<Object[]>}
     */
    list(projectId) {
        return request('GET', `/api/projects/${encodeURIComponent(projectId)}/workspaces`);
    },

    /**
     * Get a single workspace.
     * @param {string} projectId
     * @param {string} wid - Workspace ID.
     * @returns {Promise<Object>}
     */
    get(projectId, wid) {
        return request(
            'GET',
            `/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wid)}`,
        );
    },

    /**
     * Create a new workspace inside a project.
     * @param {string} projectId
     * @param {{ workspaceId: string, description?: string }} data
     * @returns {Promise<Object>} The created workspace (HTTP 201).
     */
    create(projectId, data) {
        return request(
            'POST',
            `/api/projects/${encodeURIComponent(projectId)}/workspaces`,
            data,
        );
    },

    /**
     * Update a workspace's metadata.
     * @param {string} projectId
     * @param {string} wid
     * @param {{ description: string }} data
     * @returns {Promise<Object>}
     */
    update(projectId, wid, data) {
        return request(
            'PUT',
            `/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wid)}`,
            data,
        );
    },

    /**
     * Rename a workspace (changes its ID).
     * @param {string} projectId
     * @param {string} wid    - Current workspace ID.
     * @param {string} newId  - Desired new workspace ID.
     * @returns {Promise<Object>}
     */
    rename(projectId, wid, newId) {
        return request(
            'PUT',
            `/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wid)}/rename`,
            { newId },
        );
    },

    /**
     * Delete a workspace.
     * @param {string} projectId
     * @param {string} wid
     * @returns {Promise<void>}
     */
    delete(projectId, wid) {
        return request(
            'DELETE',
            `/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wid)}`,
        );
    },

    /**
     * Set up a workspace on disk (create folder, clone repos, generate .code-workspace file).
     * @param {string} projectId
     * @param {string} wid
     * @returns {Promise<Object>}
     */
    setup(projectId, wid) {
        return request(
            'POST',
            `/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wid)}/setup`,
        );
    },

    /**
     * Fetch the health report for an initialized workspace.
     *
     * Returns a {@link WorkspaceHealthReport} describing any structural issues
     * (missing .code-workspace file, uncloned repositories, etc.).
     *
     * @param {string} projectId
     * @param {string} wid
     * @returns {Promise<{ healthy: boolean, issues: Array<{ type: string, severity: string, message: string, fixAction: string, repositoryId?: string }> }>}
     */
    health(projectId, wid) {
        return request(
            'GET',
            `/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wid)}/health`,
        );
    },

    /**
     * Regenerate the VS Code .code-workspace file from the current project
     * repository list without performing any git cloning.
     *
     * @param {string} projectId
     * @param {string} wid
     * @returns {Promise<{ success: boolean }>}
     */
    regenerateFile(projectId, wid) {
        return request(
            'POST',
            `/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wid)}/regenerate-workspace-file`,
        );
    },

    /**
     * External-application launch methods.
     *
     * @namespace api.workspaces.launch
     */
    launch: {
        /**
         * Launch VS Code for the given workspace.
         *
         * Sends a POST to the backend launch endpoint which opens VS Code
         * with the workspace's `.code-workspace` file. No request body is sent.
         *
         * @memberof api.workspaces.launch
         * @param {string} projectId
         * @param {string} wid - Workspace ID.
         * @returns {Promise<{ success: boolean }>}
         */
        vscode(projectId, wid) {
            return request(
                'POST',
                `/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wid)}/launch/vscode`,
            );
        },

        /**
         * Launch GitHub Desktop for a specific repository within the workspace.
         *
         * Sends a POST to the backend launch endpoint which opens GitHub Desktop
         * pointed at the repository's local clone directory. No request body is sent.
         *
         * @memberof api.workspaces.launch
         * @param {string} projectId
         * @param {string} wid    - Workspace ID.
         * @param {string} repoId - Repository ID.
         * @returns {Promise<{ success: boolean }>}
         */
        githubDesktop(projectId, wid, repoId) {
            return request(
                'POST',
                `/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wid)}/launch/github-desktop/${encodeURIComponent(repoId)}`,
            );
        },
    },
};

/**
 * Branch endpoints.
 *
 * @namespace api.branches
 */
const branches = {
    /**
     * List branches for all repositories in a workspace.
     *
     * @param {string} projectId
     * @param {string} wid
     * @returns {Promise<{
     *   branches: Record<string, Array<{name: string, isCurrent: boolean, isRemote: boolean, upstream?: string}>>,
     *   suggestions: string[]
     * }>}
     */
    list(projectId, wid) {
        return request(
            'GET',
            `/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wid)}/branches`,
        );
    },

    /**
     * Switch branches across repositories in a workspace.
     *
     * @param {string} projectId
     * @param {string} wid
     * @param {Record<string, string>} assignments - Map of repoId → branchName.
     * @returns {Promise<{results: Record<string, {success: boolean, conflict: boolean, error?: string}>}>}
     */
    switch(projectId, wid, assignments) {
        return request(
            'POST',
            `/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wid)}/branches/switch`,
            { assignments },
        );
    },
};

/**
 * Status endpoints.
 *
 * @namespace api.status
 */
const status = {
    /**
     * Get the current git status for all repositories in a workspace.
     *
     * @param {string} projectId
     * @param {string} wid
     * @returns {Promise<Record<string, {
     *   currentBranch: string|null,
     *   localCommits: number,
     *   unfetchedCommits: number,
     *   modifiedFiles: number,
     *   lastActivity: string|null,
     *   hasConflicts: boolean
     * }|null>>} Keyed by repository ID.
     */
    get(projectId, wid) {
        return request(
            'GET',
            `/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wid)}/status`,
        );
    },

    /**
     * Force-refresh git status for all repositories in a workspace.
     * Returns the same shape as {@link api.status.get} but with freshly polled data.
     *
     * @param {string} projectId
     * @param {string} wid
     * @returns {Promise<Record<string, Object|null>>}
     */
    refresh(projectId, wid) {
        return request(
            'POST',
            `/api/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wid)}/status/refresh`,
        );
    },
};

/**
 * Error Log endpoints.
 *
 * @namespace api.errorLog
 */
const errorLog = {
    /**
     * List error log entries, with optional filters.
     *
     * @param {{ severity?: string, source?: string, limit?: number, offset?: number }} [params]
     * @returns {Promise<Object>} Paginated result containing `entries` and `total`.
     */
    list(params) {
        let url = '/api/error-log';
        if (params && Object.keys(params).length > 0) {
            const qs = new URLSearchParams();
            if (params.severity !== undefined) qs.set('severity', params.severity);
            if (params.source   !== undefined) qs.set('source',   params.source);
            if (params.limit    !== undefined) qs.set('limit',    String(params.limit));
            if (params.offset   !== undefined) qs.set('offset',   String(params.offset));
            const qsString = qs.toString();
            if (qsString) url += '?' + qsString;
        }
        return request('GET', url);
    },

    /**
     * Get a single error log entry by ID.
     *
     * @param {number} id
     * @returns {Promise<Object>}
     */
    get(id) {
        return request('GET', `/api/error-log/${encodeURIComponent(id)}`);
    },

    /**
     * Clear all error log entries.
     *
     * @returns {Promise<void>} Resolves with `undefined` on HTTP 204.
     */
    clear() {
        return request('DELETE', '/api/error-log');
    },

    /**
     * Return the distinct Source values present in the error log, sorted
     * alphabetically. Useful for populating filter dropdowns dynamically.
     *
     * @returns {Promise<{ sources: string[] }>}
     */
    sources() {
        return request('GET', '/api/error-log/sources');
    },

    /**
     * Return only the total count of error log entries (no entry payload).
     * Useful for badge/counter display.
     *
     * @returns {Promise<Object>} Object containing at least a `total` field.
     */
    count() {
        return request('GET', '/api/error-log?limit=0');
    },
};

/**
 * Config / credentials endpoints.
 *
 * @namespace api.config
 */
const config = {
    credentials: {
        /**
         * List all configured git credentials with masked tokens.
         *
         * @returns {Promise<Record<string, string>>} Map of host → masked token.
         */
        list() {
            return request('GET', '/api/config/credentials');
        },

        /**
         * Add or update a host credential.
         *
         * @param {{ host: string, token: string }} data
         * @returns {Promise<Record<string, string>>} Updated masked credentials map.
         */
        set(data) {
            return request('PUT', '/api/config/credentials', data);
        },

        /**
         * Remove a host credential.
         *
         * @param {string} host
         * @returns {Promise<Record<string, string>>} Updated masked credentials map after deletion.
         */
        delete(host) {
            return request('DELETE', `/api/config/credentials/${encodeURIComponent(host)}`);
        },
    },

    polling: {
        /**
         * Get the current polling configuration.
         *
         * @returns {Promise<{ gitPollingIntervalSeconds: number }>}
         */
        get() {
            return request('GET', '/api/config/polling');
        },

        /**
         * Update the git polling interval.
         *
         * @param {number} seconds - New interval in seconds (minimum 10).
         * @returns {Promise<{ gitPollingIntervalSeconds: number }>}
         */
        set(seconds) {
            return request('PUT', '/api/config/polling', { seconds });
        },
    },

    webserverUrl: {
        /**
         * Get the current webserver URL.
         *
         * @returns {Promise<{ webserverUrl: string|null }>}
         */
        get() {
            return request('GET', '/api/config/webserver-url');
        },

        /**
         * Update the webserver URL.
         *
         * @param {string} url - The new webserver base URL. Pass an empty string to clear.
         * @returns {Promise<{ webserverUrl: string|null }>}
         */
        set(url) {
            return request('PUT', '/api/config/webserver-url', { url });
        },
    },
};

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

/**
 * Namespaced API client.
 *
 * @type {{
 *   repositories: typeof repositories,
 *   projects:     typeof projects,
 *   workspaces:   typeof workspaces,
 *   branches:     typeof branches,
 *   status:       typeof status,
 *   config:       typeof config,
 *   errorLog:     typeof errorLog,
 * }}
 */
export const api = {
    repositories,
    projects,
    workspaces,
    branches,
    status,
    config,
    errorLog,
};
