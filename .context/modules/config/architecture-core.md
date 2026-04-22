# Configuration - Architecture
_SOURCE: Configuration types and loader_
# Configuration types and loader
```
// Structure of documents
└── src/
    └── config/
        └── config.constants.ts
        └── config.ts
        └── config.types.ts

```
###  Path: `/src/config/config.constants.ts`

```ts
/**
 * Minimum allowed polling interval in seconds.
 * Enforced by PUT /api/config/polling and mirrored in the settings UI.
 */
export const MIN_POLLING_INTERVAL_SECONDS = 10;

/**
 * Maximum allowed polling interval in seconds (24 hours).
 * Enforced by PUT /api/config/polling and mirrored in the settings UI (input.max).
 */
export const MAX_POLLING_INTERVAL_SECONDS = 86_400;

```
###  Path: `/src/config/config.ts`

```ts
import { chmodSync } from 'node:fs';
import { getConfigPath } from '../utils/paths.js';
import { readJsonFile, writeJsonFile, FileNotFoundError } from '../storage/json-storage.js';
import type { AppConfig } from './config.types.js';

const REQUIRED_FIELDS: ReadonlyArray<keyof AppConfig> = ['projectsFolder', 'storageFolder'];

const DEFAULTS: Readonly<Pick<AppConfig, 'cloneDepth' | 'serverPort' | 'gitPollingIntervalSeconds'>> = {
    cloneDepth: 50,
    serverPort: 4200,
    gitPollingIntervalSeconds: 30,
};

/**
 * Loads, validates, and returns the application configuration from `config.json`.
 *
 * **Setup:** Copy `config.dist.json` to `config.json` and fill in the required
 * fields before running the tool.
 *
 * @param configPath Optional absolute path to the config file. Defaults to the
 *   `config.json` in the tool root. Pass a custom path in tests to avoid touching
 *   the real config file.
 * @throws {Error} If `config.json` does not exist (with instruction to copy from
 *   `config.dist.json`).
 * @throws {Error} If any required field is missing, non-string, or empty.
 */
export function loadConfig(configPath?: string): AppConfig {
    const resolvedConfigPath = configPath ?? getConfigPath();
    let raw: Record<string, unknown>;

    try {
        raw = readJsonFile<Record<string, unknown>>(resolvedConfigPath);
    } catch (err) {
        if (err instanceof FileNotFoundError) {
            throw new Error(
                `config.json not found at "${resolvedConfigPath}". ` +
                `Copy config.dist.json to config.json and fill in the required fields.`
            );
        }
        throw err;
    }

    for (const field of REQUIRED_FIELDS) {
        const value = raw[field];
        if (typeof value !== 'string' || value.trim() === '') {
            throw new Error(
                `Configuration error: required field "${field}" must be a non-empty string in config.json.`
            );
        }
    }

    return {
        projectsFolder: raw['projectsFolder'] as string,
        storageFolder: raw['storageFolder'] as string,
        cloneDepth: typeof raw['cloneDepth'] === 'number' ? raw['cloneDepth'] : DEFAULTS.cloneDepth,
        serverPort: typeof raw['serverPort'] === 'number' ? raw['serverPort'] : DEFAULTS.serverPort,
        gitPollingIntervalSeconds:
            typeof raw['gitPollingIntervalSeconds'] === 'number'
                ? raw['gitPollingIntervalSeconds']
                : DEFAULTS.gitPollingIntervalSeconds,
        gitCredentials: parseGitCredentials(raw['gitCredentials']),
        webserverUrl: typeof raw['webserverUrl'] === 'string' && raw['webserverUrl'].trim() !== ''
            ? raw['webserverUrl'].trim().replace(/\/+$/, '')
            : undefined,
    };
}

/**
 * Validates and returns the `gitCredentials` value from the raw config.
 *
 * @returns undefined when the field is absent or null.
 * @throws {Error} If the value is present but is not a plain object, or if any
 *   key maps to a non-string or empty-string token.
 */
function parseGitCredentials(value: unknown): Record<string, string> | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(
            'Configuration error: "gitCredentials" must be a plain object mapping hostnames to credential strings.'
        );
    }

    const credentials = value as Record<string, unknown>;

    for (const [key, token] of Object.entries(credentials)) {
        if (typeof token !== 'string') {
            throw new Error(
                `Configuration error: gitCredentials["${key}"] must be a string, got ${typeof token}.`
            );
        }
        if (token === '') {
            throw new Error(
                `Configuration error: gitCredentials["${key}"] must not be an empty string.`
            );
        }
    }

    return credentials as Record<string, string>;
}

/**
 * Reads `config.json`, sets or removes a single top-level field, and writes the
 * file back via `writeJsonFile()`. All other fields — including `_instructions`
 * — are preserved.
 *
 * @param field - The top-level key to modify (e.g. `"gitCredentials"`).
 * @param value - The value to set, or `undefined` to remove the field.
 * @param configPath - Optional absolute path to the config file. Defaults to
 *   the tool-root `config.json`.
 * @throws {Error} If `config.json` cannot be read or written.
 */
export function saveConfigField(
    field: string,
    value: unknown,
    configPath?: string,
): void {
    const resolvedConfigPath = configPath ?? getConfigPath();
    const raw = readJsonFile<Record<string, unknown>>(resolvedConfigPath);

    if (value === undefined) {
        delete raw[field];
    } else {
        raw[field] = value;
    }

    writeJsonFile(resolvedConfigPath, raw);

    // config.json may contain plaintext PATs in gitCredentials — restrict
    // file permissions to owner-only on POSIX systems.
    if (process.platform !== 'win32') {
        chmodSync(resolvedConfigPath, 0o600);
    }
}

```
###  Path: `/src/config/config.types.ts`

```ts
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

```
---
**File Statistics**
- **Size**: 7.82 KB
- **Lines**: 246
File: `modules/config/architecture-core.md`
