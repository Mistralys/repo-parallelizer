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

// ---------------------------------------------------------------------------
// Notes view — card height
// ---------------------------------------------------------------------------

/**
 * Minimum card height (px) allowed in the notes view.
 */
export const MIN_NOTES_CARD_HEIGHT = 120;

/**
 * Maximum card height (px) allowed in the notes view.
 */
export const MAX_NOTES_CARD_HEIGHT = 800;

/**
 * Default card height (px) used in the notes view when not set by the user.
 */
export const DEFAULT_NOTES_CARD_HEIGHT = 220;

// ---------------------------------------------------------------------------
// Notes view — column count
// ---------------------------------------------------------------------------

/**
 * Minimum number of columns allowed in the notes view grid.
 */
export const MIN_NOTES_COLUMNS = 1;

/**
 * Maximum number of columns allowed in the notes view grid.
 */
export const MAX_NOTES_COLUMNS = 6;

/**
 * Default number of columns used in the notes view grid when not set by the user.
 */
export const DEFAULT_NOTES_COLUMNS = 2;

// ---------------------------------------------------------------------------
// Git clone depth
// ---------------------------------------------------------------------------

/**
 * Minimum clone depth (0 means a full/unlimited clone, which is valid).
 */
export const MIN_CLONE_DEPTH = 0;

/**
 * Maximum clone depth. Git uses 32-bit signed integers for depth.
 */
export const MAX_CLONE_DEPTH = 2_147_483_647;

// ---------------------------------------------------------------------------
// Server port
// ---------------------------------------------------------------------------

/**
 * Minimum TCP port number (well-known / system ports start at 1).
 */
export const MIN_SERVER_PORT = 1;

/**
 * Maximum TCP port number (standard 16-bit unsigned range).
 */
export const MAX_SERVER_PORT = 65_535;

// ---------------------------------------------------------------------------
// GitCredentialEntry — per-field maximum lengths
// ---------------------------------------------------------------------------

/**
 * Maximum character length for a credential `id` field.
 * IDs are kebab-case strings; 100 characters provides a generous upper bound
 * while guarding against unbounded input.
 */
export const MAX_CREDENTIAL_ID_LENGTH = 100;

/**
 * Maximum character length for a credential `label` field.
 * Labels are human-readable display names; 200 characters is sufficient for
 * any reasonable label.
 */
export const MAX_CREDENTIAL_LABEL_LENGTH = 200;

/**
 * Maximum character length for a credential `host` field.
 * 253 characters is the maximum length of a fully-qualified DNS hostname
 * per RFC 1035.
 */
export const MAX_CREDENTIAL_HOST_LENGTH = 253;

/**
 * Maximum character length for a credential `token` field.
 * 500 characters covers GitHub fine-grained PATs (~93 chars) and similar
 * tokens with a wide safety margin.
 */
export const MAX_CREDENTIAL_TOKEN_LENGTH = 500;

```
###  Path: `/src/config/config.ts`

```ts
import { chmodSync } from 'node:fs';
import { getConfigPath } from '../utils/paths.js';
import { readJsonFile, writeJsonFile, FileNotFoundError } from '../storage/json-storage.js';
import type { AppConfig, GitCredentialEntry } from './config.types.js';
import { toKebabCase } from '../utils/slug.js';
import {
    DEFAULT_NOTES_CARD_HEIGHT,
    DEFAULT_NOTES_COLUMNS,
    MIN_NOTES_CARD_HEIGHT,
    MAX_NOTES_CARD_HEIGHT,
    MIN_NOTES_COLUMNS,
    MAX_NOTES_COLUMNS,
    MIN_POLLING_INTERVAL_SECONDS,
    MAX_POLLING_INTERVAL_SECONDS,
    MIN_CLONE_DEPTH,
    MAX_CLONE_DEPTH,
    MIN_SERVER_PORT,
    MAX_SERVER_PORT,
    MAX_CREDENTIAL_ID_LENGTH,
    MAX_CREDENTIAL_LABEL_LENGTH,
    MAX_CREDENTIAL_HOST_LENGTH,
    MAX_CREDENTIAL_TOKEN_LENGTH,
} from './config.constants.js';

const REQUIRED_FIELDS: ReadonlyArray<keyof AppConfig> = ['projectsFolder', 'storageFolder'];

// When adding a new non-optional AppConfig field with a sensible default: add the
// key to the Pick<AppConfig, ...> union and its value here, then update loadConfig()
// to fall back to it. The satisfies guard below will catch if DEFAULTS is incomplete.
export const DEFAULTS: Readonly<Pick<AppConfig, 'cloneDepth' | 'serverPort' | 'gitPollingIntervalSeconds' | 'notesCardHeight' | 'notesColumns'>> = {
    cloneDepth: 50,
    serverPort: 4200,
    gitPollingIntervalSeconds: 30,
    notesCardHeight: DEFAULT_NOTES_CARD_HEIGHT,
    notesColumns: DEFAULT_NOTES_COLUMNS,
};

// Compile-time guard: ensures DEFAULTS + required fields cover the full AppConfig shape.
// If a new required field is added to AppConfig without updating DEFAULTS, this line
// will produce a type error.
const _defaultsCoverageGuard: AppConfig = {
    ...DEFAULTS,
    projectsFolder: '',
    storageFolder: '',
} satisfies AppConfig;
void _defaultsCoverageGuard;

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
        cloneDepth: parseIntegerField(raw['cloneDepth'], 'cloneDepth', DEFAULTS.cloneDepth, MIN_CLONE_DEPTH, MAX_CLONE_DEPTH),
        serverPort: parseIntegerField(raw['serverPort'], 'serverPort', DEFAULTS.serverPort, MIN_SERVER_PORT, MAX_SERVER_PORT),
        gitPollingIntervalSeconds: parseIntegerField(
            raw['gitPollingIntervalSeconds'],
            'gitPollingIntervalSeconds',
            DEFAULTS.gitPollingIntervalSeconds,
            MIN_POLLING_INTERVAL_SECONDS,
            MAX_POLLING_INTERVAL_SECONDS,
        ),
        gitCredentials: parseGitCredentials(raw['gitCredentials']),
        webserverUrl: typeof raw['webserverUrl'] === 'string' && raw['webserverUrl'].trim() !== ''
            ? raw['webserverUrl'].trim().replace(/\/+$/, '')
            : undefined,
        notesCardHeight: parseIntegerField(
            raw['notesCardHeight'],
            'notesCardHeight',
            DEFAULTS.notesCardHeight,
            MIN_NOTES_CARD_HEIGHT,
            MAX_NOTES_CARD_HEIGHT,
        ),
        notesColumns: parseIntegerField(
            raw['notesColumns'],
            'notesColumns',
            DEFAULTS.notesColumns,
            MIN_NOTES_COLUMNS,
            MAX_NOTES_COLUMNS,
        ),
    };
}

/**
 * Parses a numeric config field, enforcing integer-only values and optional
 * `[min, max]` range bounds.
 *
 * - If `value` is not a `number`, returns `defaultValue`.
 * - If `value` is a number but not an integer (e.g. a float like `220.5`),
 *   returns `defaultValue`.
 * - If `min` and `max` are provided and the integer value is outside that range,
 *   emits `console.warn` but returns the value as-is (no clamping).
 *
 * @param value     Raw value read from the config file.
 * @param fieldName Field name used in warning messages.
 * @param defaultValue Fallback value for non-numeric or float inputs.
 * @param min       Optional lower bound (inclusive).
 * @param max       Optional upper bound (inclusive).
 */
function parseIntegerField(
    value: unknown,
    fieldName: string,
    defaultValue: number,
    min?: number,
    max?: number,
): number {
    if (typeof value !== 'number') {
        return defaultValue;
    }
    if (!Number.isInteger(value)) {
        return defaultValue;
    }
    if (min !== undefined && max !== undefined && (value < min || value > max)) {
        console.warn(
            `Configuration warning: "${fieldName}" value ${value} is outside the allowed range ` +
            `[${min}, ${max}]. The value will be used as-is.`
        );
    }
    return value;
}

/**
 * Validates and returns the `gitCredentials` value from the raw config,
 * auto-migrating the legacy `Record<string, string>` format to the new
 * `GitCredentialEntry[]` format when necessary.
 *
 * **Accepted inputs:**
 * - `undefined` / `null` → returns `undefined`
 * - `GitCredentialEntry[]` (new format) → validated and returned as-is
 * - `Record<string, string>` (old format, hostname→token map) → migrated to
 *   `GitCredentialEntry[]` with `id` derived from the hostname in kebab-case
 *   and `label` set to the hostname. Colliding IDs get a numeric suffix (`-2`,
 *   `-3`, …).
 * - An empty array `[]` → returns `[]`
 *
 * **Validation (new-format arrays):**
 * - Every entry must have non-empty `id`, `label`, `host`, and `token` fields.
 * - Duplicate `id` values within the array are rejected.
 *
 * **Whitespace normalization:**
 * All returned entries have leading and trailing whitespace trimmed from their
 * field values. For new-format array entries, all four fields (`id`, `label`,
 * `host`, `token`) are trimmed. For legacy-format entries, all three of `label`,
 * `host`, and `token` are trimmed — `label` is derived from the hostname key
 * after trimming, consistent with the new-format path. `host` is additionally
 * lowercased in both formats (hostnames are case-insensitive; `label` keeps its
 * original casing for display).
 *
 * @returns `undefined` when the field is absent or null; otherwise a
 *   `GitCredentialEntry[]` (possibly empty).
 * @throws {Error} If the value is present but structurally invalid, or if any
 *   entry fails validation.
 */
function parseGitCredentials(value: unknown): GitCredentialEntry[] | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    // --- New format: array of GitCredentialEntry objects ---
    if (Array.isArray(value)) {
        // Empty array is valid — treat as "no credentials".
        if (value.length === 0) {
            return [];
        }

        const seenIds = new Set<string>();

        for (let i = 0; i < value.length; i++) {
            const entry = value[i] as Record<string, unknown>;

            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
                throw new Error(
                    `Configuration error: gitCredentials[${i}] must be a credential object, got ${typeof entry}.`
                );
            }

            for (const field of ['id', 'label', 'host', 'token'] as const) {
                const fieldValue = entry[field];
                if (typeof fieldValue !== 'string' || fieldValue.trim() === '') {
                    throw new Error(
                        `Configuration error: gitCredentials[${i}].${field} must be a non-empty string.`
                    );
                }
            }

            // Per-field length limits — enforce the same limits as the credential API.
            const fieldLimits: Array<['id' | 'label' | 'host' | 'token', number]> = [
                ['id', MAX_CREDENTIAL_ID_LENGTH],
                ['label', MAX_CREDENTIAL_LABEL_LENGTH],
                ['host', MAX_CREDENTIAL_HOST_LENGTH],
                ['token', MAX_CREDENTIAL_TOKEN_LENGTH],
            ];
            for (const [field, maxLen] of fieldLimits) {
                const fieldValue = entry[field] as string;
                if (fieldValue.length > maxLen) {
                    throw new Error(
                        `Configuration error: gitCredentials[${i}].${field} must not exceed ${maxLen} characters (got ${fieldValue.length}).`
                    );
                }
            }

            const id = (entry['id'] as string).trim();
            if (seenIds.has(id)) {
                throw new Error(
                    `Configuration error: gitCredentials contains duplicate id "${id}".`
                );
            }
            seenIds.add(id);
        }

        // Trim all four fields on every entry before returning so that
        // downstream consumers always receive normalized values. `host` is
        // additionally lowercased — hostnames are case-insensitive (RFC 4343),
        // and matching elsewhere (buildCredentialOptionsResponse, resolveCredential)
        // compares against a URL-derived host that is always lowercase.
        return (value as Array<Record<string, unknown>>).map(entry => ({
            id: (entry['id'] as string).trim(),
            label: (entry['label'] as string).trim(),
            host: (entry['host'] as string).trim().toLowerCase(),
            token: (entry['token'] as string).trim(),
        })) as GitCredentialEntry[];
    }

    // --- Old format: plain object mapping hostname → token ---
    if (typeof value === 'object') {
        const legacyMap = value as Record<string, unknown>;
        const entries = Object.entries(legacyMap);

        // Empty legacy object → return undefined (no credentials configured).
        if (entries.length === 0) {
            return undefined;
        }

        const result: GitCredentialEntry[] = [];
        const usedIds = new Set<string>();

        for (const [index, [host, token]] of entries.entries()) {
            if (typeof token !== 'string') {
                throw new Error(
                    `Configuration error: gitCredentials entry #${index + 1} (legacy format) must have a string value, got ${typeof token}.`
                );
            }
            if (token === '') {
                throw new Error(
                    `Configuration error: gitCredentials entry #${index + 1} (legacy format) must not have an empty string value.`
                );
            }

            // Derive a kebab-case ID from the hostname.
            const baseId = toKebabCase(host);
            let candidateId = baseId;
            let suffix = 2;
            while (usedIds.has(candidateId)) {
                candidateId = `${baseId}-${suffix}`;
                suffix++;
            }
            usedIds.add(candidateId);

            result.push({
                id: candidateId,
                label: host.trim(),
                host: host.trim().toLowerCase(),
                token: token.trim(),
            });
        }

        return result;
    }

    throw new Error(
        'Configuration error: "gitCredentials" must be an array of credential entries or omitted.'
    );
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

```
---
**File Statistics**
- **Size**: 13.49 KB
- **Lines**: 416
File: `modules/config/architecture-core.md`
