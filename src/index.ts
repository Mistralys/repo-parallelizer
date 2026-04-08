#!/usr/bin/env node

/**
 * CLI entry point for repo-parallelizer.
 *
 * On success: loads config.json from the tool root, starts the HTTP server,
 * and logs a success message including the port number.
 *
 * On failure: writes a human-readable error message to stderr and exits
 * with code 1. Common failure reasons:
 *  - config.json is missing — copy config.dist.json to config.json and fill
 *    in the required fields (see config.dist.json for defaults).
 *  - config.json is missing one or more required fields:
 *      - `projectsFolder`            — path to the directory where repositories are cloned
 *      - `storageFolder`             — path to the directory where JSON data files are stored
 *      - `serverPort`                — TCP port the HTTP server will listen on (e.g. 4200)
 *      - `gitPollingIntervalSeconds` — how often (in seconds) git remotes are polled
 *      - `cloneDepth`                — depth passed to `git clone --depth` (0 = full clone)
 *  - config.json contains malformed JSON
 *  - The configured port is already in use
 */
import * as path from 'node:path';
import { loadConfig } from './config/config.js';
import { startServer } from './server/index.js';

try {
    const config = loadConfig();
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
    const staticDir = path.resolve(__dirname, '..', 'gui', 'public');

    startServer({
        appConfig: config,
        staticDir,
        serverPort: config.serverPort,
        pollIntervalSeconds: config.gitPollingIntervalSeconds,
    }).then(() => {
        console.log(`repo-parallelizer: Server listening on http://localhost:${config.serverPort}`);
    }).catch((err) => {
        process.stderr.write(`repo-parallelizer error: ${(err as Error).message}\n`);
        process.exit(1);
    });
} catch (err) {
    process.stderr.write(`repo-parallelizer error: ${(err as Error).message}\n`);
    process.exit(1);
}
