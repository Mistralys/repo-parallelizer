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
 * @returns {{ id: string, name: string, url: string }}
 */
export function normaliseRepo(repo) {
    return {
        id:   repo.Id   || repo.id   || '',
        name: repo.Name || repo.name || '',
        url:  repo.Url  || repo.url  || repo.URL || '',
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
 * @param {Object} ws
 * @returns {{ id: string, description: string, createdAt: string }}
 */
export function normaliseWorkspace(ws) {
    return {
        id:          ws.Id          || ws.id          || '',
        description: ws.Description || ws.description || '',
        createdAt:   ws.CreatedAt   || ws.createdAt   || ws.created_at || '',
    };
}
