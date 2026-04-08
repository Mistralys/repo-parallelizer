import { spawn } from 'node:child_process';
import type { GitResult, RunGitOptions } from './git.types.js';

/**
 * Spawns a git sub-process and collects its output.
 *
 * The process is always spawned with `shell: false` to prevent shell
 * injection — arguments must be provided as a pre-split array, never
 * as a single concatenated string.
 *
 * The promise **resolves** for all normal outcomes including non-zero exit
 * codes; the caller inspects `GitResult.exitCode` and decides whether to
 * treat the result as an error.
 *
 * The promise **rejects** only for spawn-level failures such as ENOENT
 * (git binary not found on PATH).
 *
 * When `options.timeoutMs` is set, an `AbortController` is used to kill the
 * process after the specified duration; in that case the promise resolves
 * with `exitCode: -1` and a descriptive stderr message rather than hanging.
 *
 * When `options.maxBufferBytes` is set (default 10 MB), the process is killed
 * and the promise resolves with `exitCode: -1` if the combined stdout + stderr
 * size exceeds the limit.  The partial output captured before the limit is
 * returned in `stdout`.
 *
 * @param args    - Git arguments, e.g. `['clone', '--depth', '1', url, dest]`.
 * @param cwd     - Working directory for the spawned process. Defaults to the
 *                  calling process's current working directory when omitted.
 * @param options - Optional timeout and buffer-limit controls.
 */
export function runGit(args: string[], cwd?: string, options?: RunGitOptions): Promise<GitResult> {
    return new Promise((resolve, reject) => {
        const maxBufferBytes = options?.maxBufferBytes ?? 10 * 1024 * 1024; // 10 MB default

        // Set up AbortController for optional timeout.
        const controller = options?.timeoutMs !== undefined ? new AbortController() : undefined;

        const proc = spawn('git', args, {
            shell: false,
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            ...(controller ? { signal: controller.signal } : {}),
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let totalBytes = 0;
        let bufferLimitExceeded = false;
        let aborted = false;
        let settled = false;

        // Arm the timeout.
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        if (controller !== undefined && options?.timeoutMs !== undefined) {
            const timeoutMs = options.timeoutMs;
            timeoutHandle = setTimeout(() => {
                aborted = true;
                controller.abort();
            }, timeoutMs);
        }

        /** Resolves the promise exactly once and clears any pending timeout. */
        function settle(result: GitResult): void {
            if (settled) return;
            settled = true;
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
            resolve(result);
        }

        proc.stdout.on('data', (chunk: Buffer) => {
            if (bufferLimitExceeded) return;
            totalBytes += chunk.length;
            if (totalBytes > maxBufferBytes) {
                bufferLimitExceeded = true;
                proc.kill();
                return;
            }
            stdoutChunks.push(chunk);
        });

        proc.stderr.on('data', (chunk: Buffer) => {
            if (bufferLimitExceeded) return;
            totalBytes += chunk.length;
            if (totalBytes > maxBufferBytes) {
                bufferLimitExceeded = true;
                proc.kill();
                return;
            }
            stderrChunks.push(chunk);
        });

        proc.on('error', (err: NodeJS.ErrnoException) => {
            // AbortError is emitted when the AbortController fires — the 'close'
            // event will follow and settle the promise with exitCode -1.
            if (err.name === 'AbortError') return;
            if (settled) return;
            settled = true;
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
            reject(err);
        });

        proc.on('close', (code: number | null) => {
            if (aborted) {
                settle({
                    exitCode: -1,
                    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                    stderr: `git process was aborted after ${options!.timeoutMs}ms timeout`,
                });
                return;
            }
            if (bufferLimitExceeded) {
                settle({
                    exitCode: -1,
                    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                    stderr: `git output exceeded buffer limit of ${maxBufferBytes} bytes; process terminated`,
                });
                return;
            }
            settle({
                exitCode: code ?? 1,
                stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                stderr: Buffer.concat(stderrChunks).toString('utf8'),
            });
        });
    });
}

/**
 * Runs a git command and returns trimmed stdout on success.
 *
 * Throws an `Error` when the process exits with a non-zero code. The error
 * message includes the exit code and the trimmed stderr output to aid
 * diagnosis.
 *
 * @param args - Git arguments.
 * @param cwd  - Working directory for the spawned process.
 */
export async function runGitOrThrow(args: string[], cwd?: string): Promise<string> {
    const result = await runGit(args, cwd);
    if (result.exitCode !== 0) {
        throw new Error(
            `git ${args[0] ?? '(unknown)'} failed (exit ${result.exitCode}):\n${result.stderr.trim()}`,
        );
    }
    return result.stdout.trim();
}
