import * as cp from 'node:child_process';
import { printSuccess, printError, printInfo } from './terminal-ui.js';
import { getToolRoot } from '../utils/paths.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs `ctx generate` from the tool root to generate project documentation.
 *
 * Behaviour:
 * - If `ctx` is found on PATH, the command is spawned with its stdout/stderr
 *   piped directly to the terminal so the user sees real-time progress.
 * - If `ctx` is **not** found, installation instructions are printed instead.
 *
 * @returns A promise that resolves once the generation command has exited
 *          (or the not-found message has been printed).
 */
export async function generateDocs(): Promise<void> {
    if (!isCtxAvailable()) {
        printError('CTX Generator (ctx) is not installed or not on PATH.');
        printInfo('Install it from: https://github.com/context-hub/generator');
        printInfo("After installing, run 'paralizer docs' or select Docs from the menu.");
        return;
    }

    printInfo('Generating documentation with CTX Generator...');

    try {
        const exitCode = await runCtxGenerate();

        if (exitCode === 0) {
            printSuccess('Documentation generated successfully.');
        } else {
            printError(`Documentation generation failed (exit code ${exitCode}).`);
        }
    } catch (err) {
        printError(`Failed to spawn ctx generate: ${(err as Error).message}`);
    }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Checks whether `ctx` is available on the current PATH.
 * Uses `spawnSync` with `stdio: 'ignore'` to suppress any output.
 *
 * @returns `true` if `ctx --version` exits without an error; `false` otherwise.
 */
function isCtxAvailable(): boolean {
    const result = cp.spawnSync('ctx', ['--version'], { stdio: 'ignore' });
    // `error` is set when the executable cannot be found (ENOENT).
    return result.error === undefined && result.status !== null;
}

/**
 * Spawns `ctx generate` from the tool root directory, piping stdout/stderr
 * to the parent process.
 *
 * @returns A promise that resolves to the process exit code (0 = success).
 */
function runCtxGenerate(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
        const child = cp.spawn('ctx', ['generate'], {
            cwd: getToolRoot(),
            stdio: ['ignore', 'inherit', 'inherit'],
        });

        child.on('error', (err) => {
            reject(err);
        });

        child.on('close', (code) => {
            resolve(code ?? 1);
        });
    });
}
