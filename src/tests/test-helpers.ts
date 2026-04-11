import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';

/**
 * Creates a temp-directory tracker that auto-cleans all created directories
 * on process exit. Call the returned function to create a new temp directory.
 *
 * @param prefix - The temp directory name prefix (e.g. `'paralizer-config-test-'`).
 * @returns A `makeTempDir()` function that creates and tracks temp directories.
 */
export function createTempDirTracker(prefix: string): () => string {
    const cleanupPaths: string[] = [];
    process.on('exit', () => {
        for (const p of cleanupPaths) {
            fs.rmSync(p, { recursive: true, force: true });
        }
    });
    return (): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
        cleanupPaths.push(dir);
        return dir;
    };
}

/**
 * Creates a fake `git` executable in `dir` that records all invocation
 * arguments to `dir/captured-args.txt` and exits with code 128 (simulating a
 * failed clone).  The real git binary is never called.
 *
 * @returns Path of the file where captured arguments are written.
 */
export function setupFakeGit(dir: string): string {
    const capturedArgsFile = path.join(dir, 'captured-args.txt');
    const fakeGitPath = path.join(dir, 'git');
    fs.writeFileSync(
        fakeGitPath,
        `#!/bin/sh\necho "$@" >> ${capturedArgsFile}\nexit 128\n`,
        { mode: 0o755 },
    );
    return capturedArgsFile;
}
