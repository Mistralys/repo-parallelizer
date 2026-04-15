/**
 * The application configuration loaded from config.json.
 *
 * Copy config.dist.json to config.json and fill in the required fields before
 * running the tool.
 */
export interface AppConfig {
    /**
     * Absolute or tool-root-relative path to the directory where git repositories
     * will be cloned.  **Required.**
     */
    projectsFolder: string;

    /**
     * Absolute or tool-root-relative path to the directory where the tool stores
     * its JSON data files.  **Required.**
     */
    storageFolder: string;

    /**
     * Depth passed to `git clone --depth` when cloning repositories.
     * A value of 0 means a full clone.
     * @default 50
     */
    cloneDepth: number;

    /**
     * TCP port the built-in HTTP server will listen on.
     * @default 4200
     */
    serverPort: number;

    /**
     * How often (in seconds) the tool polls git remotes for new commits.
     * @default 30
     */
    gitPollingIntervalSeconds: number;

    /**
     * Map of hostname (or URL prefix) to Personal Access Token / password used
     * when cloning or fetching from private repositories.
     *
     * Keys are matched against the remote URL (e.g. `"github.com"`).
     * Values must be non-empty credential strings (PATs, passwords, etc.).
     *
     * Omit the field or leave the object empty for public repositories.
     */
    gitCredentials?: Record<string, string>;

    /**
     * Maximum number of entries retained in the error log. Oldest entries are
     * evicted once this limit is exceeded.
     * @default 500
     */
    maxErrorLogEntries?: number;

    /**
     * Base URL of the local webserver serving the workspace repositories.
     * When set, a "Browse" button appears in the workspace-detail view for
     * each repository, opening `{webserverUrl}/{projectId}/{workspaceId}/{repoId}/`
     * in the default browser.
     *
     * Leave empty or omit to hide the Browse button entirely.
     */
    webserverUrl?: string;
}
