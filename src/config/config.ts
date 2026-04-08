import { getConfigPath } from '../utils/paths.js';
import { readJsonFile, FileNotFoundError } from '../storage/json-storage.js';
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
    };
}
