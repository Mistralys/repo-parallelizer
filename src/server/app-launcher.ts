import { spawn } from 'node:child_process';

/**
 * Launches an external application as a detached, fire-and-forget child
 * process.  The spawned process is fully decoupled from the Node.js process:
 * it runs with `detached: true` and `stdio: 'ignore'` so it continues living
 * independently even if the parent exits.
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
 * @returns A promise that resolves once the child process has been successfully
 *   spawned, or rejects with a descriptive error if spawning fails.
 * @throws {Error} If `command` is empty or blank — message:
 *   `'Failed to launch application: command must not be empty.'`
 * @throws {Error} If the OS-level spawn fails (e.g. command not found) — message
 *   format: `'Failed to launch application "<command>": <os-error-message>'`
 */
export function launchApplication(command: string, args: string[]): Promise<void> {
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
