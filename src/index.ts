#!/usr/bin/env node

/**
 * CLI entry point for repo-parallelizer.
 *
 * Dispatches to the appropriate action based on the first CLI argument:
 *
 *   paralizer           → Interactive CLI menu (default)
 *   paralizer menu      → Interactive CLI menu
 *   paralizer serve     → Start the HTTP server directly (requires config.json)
 *   paralizer setup     → Run the setup wizard (no config.json required)
 *   paralizer docs      → Generate CTX documentation (no config.json required)
 *   paralizer custom-files <subcommand> → Manage a project's custom files (non-interactive)
 *   paralizer help      → Print the full command documentation and exit with code 0
 *   paralizer <other>   → Print usage help and exit with code 1
 *
 * Options:
 *   --verbose   (with 'serve') Print detailed configuration before starting.
 */
import * as path from 'node:path';
import { loadConfig } from './config/config.js';
import { startServer } from './server/index.js';
import { showMenu } from './cli/menu.js';
import { runSetup } from './cli/setup.js';
import { generateDocs } from './cli/docs.js';
import {
    CUSTOM_FILES_HELP,
    createDefaultCustomFilesDeps,
    runCustomFilesCommand,
    EXIT_ERROR,
} from './cli/custom-files.js';
import { getToolRoot } from './utils/paths.js';

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

const command = process.argv[2] ?? 'menu';

(async () => {
    switch (command) {
        case 'menu':
            await showMenu();
            break;

        case 'serve':
            await startServerCommand();
            break;

        case 'setup':
            await runSetup();
            break;

        case 'docs':
            await generateDocs();
            break;

        case 'custom-files':
            await runCustomFilesCliCommand();
            break;

        case 'help':
        case '--help':
        case '-h':
            printFullHelp();
            break;

        default:
            printUsage();
            process.exit(1);
    }
})().catch((err) => {
    process.stderr.write(`repo-parallelizer: unexpected error: ${(err as Error).message}\n`);
    process.exit(1);
});

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Loads config and starts the HTTP server directly (the 'serve' command).
 *
 * Exits with code 1 if config cannot be loaded, printing a helpful suggestion
 * to run 'paralizer setup'.
 *
 * Supports --verbose to print a detailed config summary before starting.
 */
async function startServerCommand(): Promise<void> {
    let config;
    try {
        config = loadConfig();
    } catch (err) {
        process.stderr.write(`repo-parallelizer error: ${(err as Error).message}\n`);
        process.stderr.write(`Run 'paralizer setup' to create a config file.\n`);
        process.exit(1);
    }

    console.log('repo-parallelizer: Configuration loaded successfully.');

    if (process.argv.includes('--verbose')) {
        console.log(`  projectsFolder:            ${config.projectsFolder}`);
        console.log(`  storageFolder:             ${config.storageFolder}`);
        console.log(`  cloneDepth:                ${config.cloneDepth}`);
        console.log(`  serverPort:                ${config.serverPort}`);
        console.log(`  gitPollingIntervalSeconds: ${config.gitPollingIntervalSeconds}`);
    }

    // __dirname is natively available because this project compiles to CommonJS
    // (no "type": "module" in package.json + tsconfig module:Node16 → CJS output).
    // Do NOT replace with fileURLToPath(import.meta.url) — that is ESM-only and
    // would fail to compile in CJS mode.
    const staticDir = path.resolve(getToolRoot(), 'gui', 'public');

    try {
        await startServer({
            appConfig: config,
            staticDir,
            serverPort: config.serverPort,
            pollIntervalSeconds: config.gitPollingIntervalSeconds,
        });
        console.log(`repo-parallelizer: Server listening on http://localhost:${config.serverPort}`);
    } catch (err) {
        process.stderr.write(`repo-parallelizer error: ${(err as Error).message}\n`);
        process.exit(1);
    }
}

/**
 * Runs the 'custom-files' command group. The help subcommand needs no config;
 * everything else loads `config.json` first. Sets `process.exitCode` rather
 * than calling `process.exit()` so piped output is flushed.
 */
async function runCustomFilesCliCommand(): Promise<void> {
    const args = process.argv.slice(3);
    const wantsHelp = args.length === 0 || ['help', '--help', '-h'].includes(args[0]);

    if (wantsHelp) {
        // Help never touches the data layer, so it works without a config file.
        console.log(CUSTOM_FILES_HELP);
        process.exitCode = args.length === 0 ? EXIT_ERROR : 0;
        return;
    }

    let deps;
    try {
        deps = createDefaultCustomFilesDeps();
    } catch (err) {
        process.stderr.write(`repo-parallelizer error: ${(err as Error).message}\n`);
        process.stderr.write(`Run 'paralizer setup' to create a config file.\n`);
        process.exitCode = EXIT_ERROR;
        return;
    }

    process.exitCode = await runCustomFilesCommand(args, deps);
}

/**
 * Prints the full command documentation (`paralizer help`) to stdout.
 * This is the single place agents are pointed to, so it includes the
 * documentation of every command group.
 */
function printFullHelp(): void {
    printUsage();
    console.log(`\n${CUSTOM_FILES_HELP}`);
}

/**
 * Prints a concise usage / help message to stdout.
 */
function printUsage(): void {
    console.log(`Usage: paralizer [command]

Commands:
  menu    Interactive CLI menu (default)
  serve   Start the GUI server directly
  setup   Run the setup wizard
  docs    Generate CTX documentation
  custom-files  Manage a project's custom files (list, show, add, update, delete)
  help    Show this help including the full command documentation

Options:
  --verbose  Show detailed configuration (with 'serve')`);
}
