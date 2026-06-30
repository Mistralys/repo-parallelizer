/**
 * A single named Git credential entry used to authenticate against a remote host.
 *
 * Credentials are stored as an array so that multiple tokens can exist for the
 * same host (e.g. different accounts on github.com). Each repository references
 * the credential it needs via its `CredentialId` field.
 */
export interface GitCredentialEntry {
    /** Unique identifier for this credential, used to reference it from repositories. */
    id: string;

    /** Human-readable display name shown in the UI (e.g. "GitHub personal account"). */
    label: string;

    /**
     * Hostname this credential applies to (e.g. `"github.com"`).
     * Used for auto-selection when a repository's host has exactly one matching credential.
     */
    host: string;

    /** Personal Access Token, password, or other credential string. */
    token: string;
}

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
     * Named credential entries used when cloning or fetching from private
     * repositories.
     *
     * Each entry carries an `id`, `label`, `host`, and `token`. Repositories
     * reference a specific credential via their `CredentialId` field. When a
     * repository has no explicit `CredentialId`, the tool auto-selects the
     * sole credential whose `host` matches the repository's remote URL (if
     * exactly one such credential exists).
     *
     * Omit the field or leave the array empty for public repositories.
     */
    gitCredentials?: GitCredentialEntry[];

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

    /**
     * Height (in pixels) of each note card in the notes view.
     * Must be between {@link MIN_NOTES_CARD_HEIGHT} and {@link MAX_NOTES_CARD_HEIGHT}.
     * @default DEFAULT_NOTES_CARD_HEIGHT
     * @remarks Non-integer values (floats, NaN, Infinity) are rejected by `loadConfig()`
     * and replaced with the default. Out-of-range integers are accepted as-is with a
     * `console.warn` warning — no clamping is performed.
     */
    notesCardHeight: number;

    /**
     * Number of columns displayed in the notes view grid.
     * Must be between {@link MIN_NOTES_COLUMNS} and {@link MAX_NOTES_COLUMNS}.
     * @default DEFAULT_NOTES_COLUMNS
     * @remarks Non-integer values (floats, NaN, Infinity) are rejected by `loadConfig()`
     * and replaced with the default. Out-of-range integers are accepted as-is with a
     * `console.warn` warning — no clamping is performed.
     */
    notesColumns: number;
}
