import * as fs from 'node:fs';
import * as path from 'node:path';
import { printHeader, printSuccess, printError, printInfo, askQuestion, askYesNo } from './terminal-ui.js';
import { getToolRoot, getConfigPath } from '../utils/paths.js';
import { initializeStorage } from '../storage/json-storage.js';
import type { AppConfig } from '../config/config.types.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
    cloneDepth: 50,
    serverPort: 4200,
    gitPollingIntervalSeconds: 30,
    storageFolder: 'data/storage',
} as const;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Prompts the user for a filesystem path, validating that it exists (or offering
 * to create it). Loops until a valid, resolved path is accepted.
 *
 * Exported with an underscore prefix to signal internal use; consumed by tests.
 *
 * @param label        - The prompt label shown to the user.
 * @param defaultValue - Optional pre-filled hint shown in parentheses.
 * @param _ask         - Injectable askQuestion implementation (for testing).
 * @param _confirm     - Injectable askYesNo implementation (for testing).
 * @returns The resolved absolute path entered by the user.
 */
export async function _promptPath(
    label: string,
    defaultValue?: string,
    _ask: (prompt: string) => Promise<string> = askQuestion,
    _confirm: (prompt: string, defaultYes?: boolean) => Promise<boolean> = askYesNo,
): Promise<string> {
    const hint = defaultValue ? ` (${defaultValue})` : '';

    while (true) {
        const raw = await _ask(`${label}${hint}:`);
        const input = raw.trim() === '' && defaultValue ? defaultValue : raw.trim();

        if (input === '') {
            printError('  Path cannot be empty. Please enter a valid path.');
            continue;
        }

        // Resolve relative paths against the tool root so the stored value
        // matches what loadConfig() / getProjectsFolder() expect.
        const resolved = path.isAbsolute(input)
            ? input
            : path.resolve(getToolRoot(), input);

        if (fs.existsSync(resolved)) {
            return resolved;
        }

        const create = await _confirm(`  Directory does not exist. Create it?`, true);
        if (create) {
            try {
                fs.mkdirSync(resolved, { recursive: true });
                printSuccess(`  Created: ${resolved}`);
                return resolved;
            } catch (err) {
                printError(`  Failed to create directory: ${(err as Error).message}`);
                // Loop back and ask again.
            }
        }
        // User declined creation — ask again.
    }
}

/**
 * Prompts the user for a numeric value, applying range validation.
 * An empty response uses `defaultValue`.
 *
 * Exported with an underscore prefix to signal internal use; consumed by tests.
 *
 * @param label        - The prompt label (without the default hint).
 * @param defaultValue - Value used when the user presses Enter without typing.
 * @param min          - Minimum accepted value (inclusive). Defaults to -Infinity.
 * @param max          - Maximum accepted value (inclusive). Defaults to +Infinity.
 * @param _ask         - Injectable askQuestion implementation (for testing).
 * @returns The validated number entered by the user (or the default).
 */
export async function _promptNumber(
    label: string,
    defaultValue: number,
    min: number = -Infinity,
    max: number = Infinity,
    _ask: (prompt: string) => Promise<string> = askQuestion,
): Promise<number> {
    while (true) {
        const raw = await _ask(`${label} [${defaultValue}]:`);

        if (raw.trim() === '') {
            return defaultValue;
        }

        const parsed = Number(raw.trim());

        if (!Number.isInteger(parsed)) {
            printError(`  Please enter a whole number.`);
            continue;
        }

        if (parsed < min || parsed > max) {
            if (isFinite(min) && isFinite(max)) {
                printError(`  Value must be between ${min} and ${max}.`);
            } else if (isFinite(min)) {
                printError(`  Value must be >= ${min}.`);
            } else {
                printError(`  Value must be <= ${max}.`);
            }
            continue;
        }

        return parsed;
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Injectable IO adapter for `runSetup()`. Providing this allows the setup
 * wizard to be exercised in tests without a real TTY.
 */
export interface SetupIO {
    ask: (prompt: string) => Promise<string>;
    confirm: (prompt: string, defaultYes?: boolean) => Promise<boolean>;
}

/**
 * Runs the interactive first-time setup wizard.
 *
 * Guides the user through:
 * 1. Checking / overwriting an existing config.json.
 * 2. Collecting projectsFolder and storageFolder (with directory creation).
 * 3. Collecting numeric settings (cloneDepth, serverPort, gitPollingIntervalSeconds).
 * 4. Writing config.json and initializing the storage directories.
 *
 * @param io - Optional IO adapter for dependency injection (testing). Defaults
 *             to the real TTY-based `askQuestion` / `askYesNo` functions.
 */
export async function runSetup(io?: SetupIO): Promise<void> {
    const ask = io?.ask ?? askQuestion;
    const confirm = io?.confirm ?? askYesNo;

    try {
        printHeader('repo-parallelizer — Setup Wizard');
        console.log('');

        // ------------------------------------------------------------------
        // Step 1 — Check for existing config.json
        // ------------------------------------------------------------------
        const configPath = getConfigPath();

        if (fs.existsSync(configPath)) {
            const overwrite = await confirm('config.json already exists. Overwrite?', false);
            if (!overwrite) {
                printInfo('Setup cancelled — existing config.json was not modified.');
                return;
            }
        }

        // ------------------------------------------------------------------
        // Step 2 — Projects folder
        // ------------------------------------------------------------------
        console.log('');
        printInfo('Where should repositories be cloned?');
        const projectsFolder = await _promptPath('Projects folder path', undefined, ask, confirm);

        // ------------------------------------------------------------------
        // Step 3 — Storage folder
        // ------------------------------------------------------------------
        console.log('');
        printInfo('Where should the tool store its data files?');
        const storageFolder = await _promptPath('Storage folder path', DEFAULTS.storageFolder, ask, confirm);

        // ------------------------------------------------------------------
        // Step 4 — Numeric settings
        // ------------------------------------------------------------------
        console.log('');
        const cloneDepth = await _promptNumber(
            'Clone depth (0 = full clone)',
            DEFAULTS.cloneDepth,
            0,
            Infinity,
            ask,
        );

        const serverPort = await _promptNumber(
            'Server port',
            DEFAULTS.serverPort,
            1,
            65535,
            ask,
        );

        const gitPollingIntervalSeconds = await _promptNumber(
            'Git polling interval (seconds)',
            DEFAULTS.gitPollingIntervalSeconds,
            1,
            Infinity,
            ask,
        );

        // ------------------------------------------------------------------
        // Step 5 — Write config.json
        // ------------------------------------------------------------------
        const config: AppConfig = {
            projectsFolder,
            storageFolder,
            cloneDepth,
            serverPort,
            gitPollingIntervalSeconds,
        };

        fs.writeFileSync(configPath, JSON.stringify(config, null, 4) + '\n', 'utf8');

        // ------------------------------------------------------------------
        // Step 6 — Initialize storage directories and seed files
        // ------------------------------------------------------------------
        initializeStorage(config);

        // ------------------------------------------------------------------
        // Step 7 — Success summary
        // ------------------------------------------------------------------
        console.log('');
        printSuccess('✔  Setup complete!');
        console.log('');
        printInfo(`  config.json written to:  ${configPath}`);
        printInfo(`  Projects folder:          ${projectsFolder}`);
        printInfo(`  Storage folder:           ${storageFolder}`);
        printInfo(`  Clone depth:              ${cloneDepth}`);
        printInfo(`  Server port:              ${serverPort}`);
        printInfo(`  Polling interval:         ${gitPollingIntervalSeconds}s`);
        console.log('');
        printInfo('Run `paralizer` or `menu.sh` to start.');
        console.log('');
    } catch (err) {
        printError(`Setup failed: ${(err as Error).message}`);
    }
}
