import { spawn } from 'node:child_process';

/**
 * Options accepted by the internal {@link spawnDetached} helper.
 */
interface SpawnDetachedOptions {
    /** Working directory the spawned process should start in. */
    cwd?: string;
}

/**
 * Spawns a detached, fire-and-forget child process and wires up the
 * guard/spawn/event-listener logic shared by every process-launching
 * function in this module.  The spawned process is fully decoupled from the
 * Node.js process: it runs with `detached: true` and `stdio: 'ignore'` so it
 * continues living independently even if the parent exits.
 *
 * Cross-platform notes:
 * - On **Windows** (`process.platform === 'win32'`), `shell: true` is used so
 *   that `.cmd` / `.bat` launchers (e.g. `code.cmd`) are found on PATH and
 *   executed correctly by the Windows shell.
 * - On all other platforms, `shell: false` is used for direct process
 *   execution without an intermediate shell.
 *
 * @param command - The executable to launch (e.g. `"code"`, `"github"`).
 * @param args    - Command-line arguments to pass to the executable.
 * @param options - Optional spawn settings, e.g. a working directory (`cwd`).
 * @returns A promise that resolves once the child process has been successfully
 *   spawned, or rejects with a descriptive error if spawning fails.
 * @throws {Error} If `command` is empty or blank — message:
 *   `'Failed to launch application: command must not be empty.'`
 * @throws {Error} If the OS-level spawn fails (e.g. command not found) — message
 *   format: `'Failed to launch application "<command>": <os-error-message>'`
 */
function spawnDetached(
    command: string,
    args: string[],
    options?: SpawnDetachedOptions,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        // Guard against empty command strings early. Node's spawn() throws
        // synchronously for empty filenames, which would bypass the Promise-
        // wrapped `error` event handler and produce an inconsistently formatted
        // rejection.  Failing fast here keeps rejection behaviour uniform for
        // all invalid inputs.
        if (!command.trim()) {
            reject(new Error('Failed to launch application: command must not be empty.'));
            return;
        }

        const useShell = process.platform === 'win32';

        const child = spawn(command, args, {
            shell: useShell,
            detached: true,
            stdio: 'ignore',
            cwd: options?.cwd,
        });

        // `unref()` lets the parent exit without waiting for this child.
        child.unref();

        child.on('spawn', () => {
            resolve();
        });

        child.on('error', (err: Error) => {
            reject(
                new Error(
                    `Failed to launch application "${command}": ${err.message}`,
                ),
            );
        });
    });
}

/**
 * Launches an external application as a detached, fire-and-forget child
 * process. See {@link spawnDetached} for the underlying spawn/event-wiring
 * behaviour.
 *
 * @param command - The executable to launch (e.g. `"code"`, `"github"`).
 * @param args    - Command-line arguments to pass to the executable.
 * @returns A promise that resolves once the child process has been successfully
 *   spawned, or rejects with a descriptive error if spawning fails.
 * @throws {Error} If `command` is empty or blank — message:
 *   `'Failed to launch application: command must not be empty.'`
 * @throws {Error} If the OS-level spawn fails (e.g. command not found) — message
 *   format: `'Failed to launch application "<command>": <os-error-message>'`
 */
export function launchApplication(command: string, args: string[]): Promise<void> {
    return spawnDetached(command, args);
}

/**
 * Resolves the platform-specific terminal command needed to open a native
 * terminal window at the given directory. Pure and side-effect-free so it is
 * unit-testable without spawning a real terminal in CI.
 *
 * - **macOS** (`darwin`): `open -a Terminal <directoryPath>` — the directory
 *   is passed as an argument to `open`, so no `cwd` is needed.
 * - **Windows** (`win32`): `cmd /c start cmd` with the target directory
 *   passed via the spawned process's `cwd` option.
 * - **Other platforms** (Linux and other POSIX systems): `x-terminal-emulator`
 *   (the Debian `update-alternatives` convention) with the target directory
 *   passed via `cwd`.
 *
 * @param directoryPath - The absolute path to open a terminal window at.
 * @param platform - The platform to resolve the command for, typically
 *   `process.platform`.
 * @returns The `{ command, args, cwd }` triple to pass to a spawn function.
 */
export function buildTerminalCommand(
    directoryPath: string,
    platform: NodeJS.Platform,
): { command: string; args: string[]; cwd?: string } {
    if (platform === 'darwin') {
        return { command: 'open', args: ['-a', 'Terminal', directoryPath] };
    }

    if (platform === 'win32') {
        return { command: 'cmd', args: ['/c', 'start', 'cmd'], cwd: directoryPath };
    }

    return { command: 'x-terminal-emulator', args: [], cwd: directoryPath };
}

/**
 * Opens a native terminal window at the given directory, using the
 * platform-appropriate command resolved by {@link buildTerminalCommand}.
 *
 * @param directoryPath - The absolute path to open a terminal window at.
 * @returns A promise that resolves once the terminal process has been
 *   successfully spawned, or rejects with a descriptive error if spawning
 *   fails.
 * @throws {Error} If the OS-level spawn fails (e.g. the terminal command is
 *   not installed) — message format:
 *   `'Failed to launch application "<command>": <os-error-message>'`
 */
export function launchTerminal(directoryPath: string): Promise<void> {
    const { command, args, cwd } = buildTerminalCommand(directoryPath, process.platform);
    return spawnDetached(command, args, { cwd });
}
