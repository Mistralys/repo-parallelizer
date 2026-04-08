import * as readline from 'node:readline';
import pc from 'picocolors';

/**
 * Prints a bold/cyan styled header line to stdout.
 *
 * @param text - The header text to display.
 */
export function printHeader(text: string): void {
    console.log(pc.bold(pc.cyan(text)));
}

/**
 * Prints a menu option with the key highlighted in bold/yellow.
 *
 * @param key   - The shortcut key to display (e.g. "S" renders as "[S]").
 * @param label - The option description rendered in default color.
 */
export function printOption(key: string, label: string): void {
    process.stdout.write(`  ${pc.bold(pc.yellow(`[${key}]`))} ${label}\n`);
}

/**
 * Prints a green-colored success message to stdout.
 *
 * @param text - The success message to display.
 */
export function printSuccess(text: string): void {
    console.log(pc.green(text));
}

/**
 * Prints a red-colored error message to stderr.
 *
 * @param text - The error message to display.
 */
export function printError(text: string): void {
    process.stderr.write(pc.red(text) + '\n');
}

/**
 * Prints a blue/dim info message to stdout.
 *
 * @param text - The informational message to display.
 */
export function printInfo(text: string): void {
    console.log(pc.dim(pc.blue(text)));
}

/**
 * Listens for a single keypress using `node:readline` in raw mode.
 * Returns the pressed key (lowercased). Only resolves when a key in
 * `validKeys` is pressed. Handles Ctrl+C for graceful exit.
 *
 * @param validKeys - Array of lowercase key characters that will trigger resolution.
 * @returns A promise that resolves to the matched key (lowercased).
 */
export function waitForKey(validKeys: string[]): Promise<string> {
    if (!process.stdin.isTTY) {
        return Promise.reject(new Error('waitForKey() requires an interactive terminal (TTY).'));
    }

    return new Promise<string>((resolve) => {
        const normalised = validKeys.map((k) => k.toLowerCase());

        const onData = (buf: Buffer): void => {
            const ch = buf.toString('utf8').toLowerCase();

            // Ctrl+C — exit gracefully
            if (ch === '\x03') {
                process.stdin.setRawMode(false);
                process.stdin.removeListener('data', onData);
                process.stdin.pause();
                process.exit(0);
            }

            if (normalised.includes(ch)) {
                process.stdin.setRawMode(false);
                process.stdin.removeListener('data', onData);
                process.stdin.pause();
                resolve(ch);
            }
        };

        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', onData);
    });
}

/**
 * Text input prompt using `node:readline`.
 * Returns the trimmed user input.
 *
 * @param prompt - The prompt text displayed before the cursor.
 * @returns A promise that resolves to the trimmed input string.
 */
export function askQuestion(prompt: string): Promise<string> {
    return new Promise<string>((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        rl.question(prompt, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

/**
 * Yes/No prompt. Displays `[Y/n]` or `[y/N]` based on the `defaultYes` flag.
 * An empty input resolves to the default. Accepts "y", "yes", "n", "no"
 * (case-insensitive).
 *
 * @param prompt     - The question text (without the Y/N indicator).
 * @param defaultYes - When true (the default), Enter selects Yes.
 * @returns A promise that resolves to `true` for Yes and `false` for No.
 */
export function askYesNo(prompt: string, defaultYes: boolean = true): Promise<boolean> {
    const indicator = defaultYes ? '[Y/n]' : '[y/N]';
    const fullPrompt = `${prompt} ${indicator} `;

    return new Promise<boolean>((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        rl.question(fullPrompt, (answer) => {
            rl.close();
            const trimmed = answer.trim().toLowerCase();

            if (trimmed === '') {
                resolve(defaultYes);
                return;
            }

            if (trimmed === 'y' || trimmed === 'yes') {
                resolve(true);
                return;
            }

            if (trimmed === 'n' || trimmed === 'no') {
                resolve(false);
                return;
            }

            // Unrecognised input — fall back to default
            resolve(defaultYes);
        });
    });
}

/**
 * Clears the terminal screen using the ANSI reset escape sequence (`\x1Bc`).
 */
export function clearScreen(): void {
    process.stdout.write('\x1Bc');
}
