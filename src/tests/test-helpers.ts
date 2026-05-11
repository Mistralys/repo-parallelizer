/**
 * Shared test utilities for all unit test suites in `src/tests/`.
 *
 * Exports:
 *  - `makeTestConfig`        — builds a minimal `AppConfig` rooted at a temp directory.
 *  - `createTempDirTracker`  — creates self-cleaning temp directories for test isolation.
 *  - `setupFakeGit`          — installs a fake `git` binary that records invocations.
 */

import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';

import { type AppConfig } from '../config/config.types.js';

/**
 * Creates a minimal `AppConfig` suitable for use in unit tests.
 *
 * `storageFolder` and `projectsFolder` are derived from the supplied `base`
 * directory so that each test can work inside its own isolated temp tree.
 * All other fields are set to sensible defaults that match production
 * defaults.  Pass `overrides` to adjust individual fields without having to
 * repeat the full object literal.
 *
 * @param base      - Root temp-directory for this test (e.g. the value
 *                    returned by your `makeTempDir()` call).
 * @param overrides - Optional partial config to merge on top of the defaults.
 * @returns A complete `AppConfig` object.
 */
export function makeTestConfig(base: string, overrides?: Partial<AppConfig>): AppConfig {
    return {
        storageFolder: path.join(base, 'storage'),
        projectsFolder: path.join(base, 'projects'),
        cloneDepth: 50,
        serverPort: 4200,
        gitPollingIntervalSeconds: 30,
        notesCardHeight: 220,
        notesColumns: 2,
        ...overrides,
    };
}

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
