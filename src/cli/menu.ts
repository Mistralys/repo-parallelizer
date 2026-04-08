import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import {
    printHeader,
    printOption,
    printSuccess,
    printError,
    printInfo,
    waitForKey,
    clearScreen,
} from './terminal-ui.js';
import { runSetup } from './setup.js';
import { generateDocs } from './docs.js';
import { startServer, stopServer } from '../server/index.js';
import { loadConfig } from '../config/config.js';
import { getToolRoot } from '../utils/paths.js';

// ---------------------------------------------------------------------------
// Version (read once, cached)
// ---------------------------------------------------------------------------

let _version: string | undefined;

/**
 * Reads the `version` field from `package.json` at the tool root.
 * The result is cached after the first call.
 *
 * @returns The version string (e.g. "0.3.0"), or "unknown" on any error.
 */
function getVersion(): string {
    if (_version !== undefined) {
        return _version;
    }

    try {
        const pkgPath = path.join(getToolRoot(), 'package.json');
        const raw = fs.readFileSync(pkgPath, 'utf8');
        const pkg = JSON.parse(raw) as { version?: string };
        _version = typeof pkg.version === 'string' ? pkg.version : 'unknown';
    } catch {
        _version = 'unknown';
    }

    return _version;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Launches the interactive CLI menu and runs in a loop until the user quits
 * or selects "Launch GUI" (which keeps the process alive via the HTTP server).
 *
 * Key bindings:
 *  - `s` / `S` — Run the setup wizard, then return to menu.
 *  - `g` / `G` — Start the HTTP server and open the browser. Does **not**
 *                return to the menu — the event loop stays alive.
 *  - `d` / `D` — Generate documentation, then return to menu.
 *  - `q` / `Q` — Exit the menu cleanly.
 */
export async function showMenu(): Promise<void> {
    const version = getVersion();

    while (true) {
        clearScreen();
        printHeader(`repo-parallelizer v${version}`);
        console.log();
        printOption('S', 'Setup — Run the setup wizard');
        printOption('G', 'Launch GUI — Start server and open browser');
        printOption('D', 'Generate Docs — Run CTX Generator');
        printOption('Q', 'Quit');
        console.log();

        const key = await waitForKey(['s', 'g', 'd', 'q']);

        switch (key) {
            case 's':
                await runSetup();
                await pressAnyKeyToContinue();
                break;

            case 'g':
                // launchGui either returns early on config/start failure (in
                // which case we fall through and the menu loops), or it keeps
                // the process alive until Ctrl+C calls process.exit(0).
                await launchGui();
                break; // Reached only if launchGui() returned early (config/start error).

            case 'd':
                await generateDocs();
                await pressAnyKeyToContinue();
                break;

            case 'q':
                return;
        }
    }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Loads config, starts the HTTP server, and attempts to open the default
 * browser at the server URL.
 *
 * If the config cannot be loaded the error is reported and the function
 * returns so `showMenu` can loop back to the menu prompt.
 *
 * If config loads and the server starts successfully, this function prints
 * the URL and a "Press Ctrl+C to stop" notice and does **not** return — the
 * HTTP server's event loop keeps the process alive.
 */
async function launchGui(): Promise<void> {
    let config;
    try {
        config = loadConfig();
    } catch (err) {
        printError('No config.json found. Run setup first.');
        printInfo(`Details: ${(err as Error).message}`);
        return; // Return to menu.
    }

    const staticDir = path.resolve(getToolRoot(), 'gui', 'public');
    const port = config.serverPort;
    const url = `http://localhost:${port}`;

    try {
        await startServer({
            appConfig: config,
            staticDir,
            serverPort: port,
            pollIntervalSeconds: config.gitPollingIntervalSeconds,
        });
    } catch (err) {
        printError(`Failed to start server: ${(err as Error).message}`);
        return; // Return to menu.
    }

    printSuccess(`Server listening on ${url}`);

    // Attempt to open the browser — failures are non-fatal; we print the URL
    // so the user can open it manually.
    try {
        openBrowser(url);
    } catch {
        // Silently ignore — the URL is already visible in the terminal.
    }

    printInfo('Press Ctrl+C to stop the server.');

    // The HTTP server keeps the Node.js event loop alive. Ctrl+C shuts the
    // server down cleanly and exits the process — the menu is NOT resumed.
    await new Promise<never>((_, reject) => {
        process.once('SIGINT', async () => {
            printInfo('\nShutting down server...');
            try {
                await stopServer();
            } catch (err) {
                printError(`Error during shutdown: ${(err as Error).message}`);
            }
            process.exit(0);
        });
    });
}

/**
 * Opens `url` in the default browser using the appropriate platform command.
 * The spawned process is detached and unreferenced so it does not block
 * Node.js from exiting.
 *
 * @param url - The URL to open.
 */
function openBrowser(url: string): void {
    let cmd: string;
    let args: string[];

    if (process.platform === 'darwin') {
        cmd = 'open';
        args = [url];
    } else if (process.platform === 'win32') {
        cmd = 'cmd';
        args = ['/c', 'start', url];
    } else {
        cmd = 'xdg-open';
        args = [url];
    }

    const child = cp.spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
}

/**
 * Prints "Press any key to continue…" and waits for a single keypress.
 * Accepts any printable ASCII key (a–z, 0–9, space, enter).
 */
async function pressAnyKeyToContinue(): Promise<void> {
    console.log();
    process.stdout.write('Press any key to continue...');

    // Accept a broad set of common keys so the user isn't confused by having
    // to guess which key works.
    const keys = [
        ' ', '\r', '\n',
        'a','b','c','d','e','f','g','h','i','j','k','l','m',
        'n','o','p','q','r','s','t','u','v','w','x','y','z',
        '0','1','2','3','4','5','6','7','8','9',
    ];

    await waitForKey(keys);
    console.log();
}
