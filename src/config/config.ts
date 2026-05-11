import { chmodSync } from 'node:fs';
import { getConfigPath } from '../utils/paths.js';
import { readJsonFile, writeJsonFile, FileNotFoundError } from '../storage/json-storage.js';
import type { AppConfig } from './config.types.js';
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
