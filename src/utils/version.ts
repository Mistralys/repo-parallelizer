import * as fs from 'node:fs';
import * as path from 'node:path';
import { getToolRoot } from './paths.js';

/**
 * Returns the tool's own version string, read from its `package.json`
 * (located at {@link getToolRoot}).
 *
 * No-argument by design: unlike a generic `readVersion(pkgPath)` reader,
 * callers never need to know where the tool's own `package.json` lives —
 * that knowledge is resolved internally via `getToolRoot()`.
 *
 * @returns The `version` field from the tool's `package.json`, or `'unknown'`
 *          when the file is missing, unreadable, or does not contain a
 *          non-empty string `version` field. Never throws.
 */
export function getToolVersion(): string {
    try {
        const pkgPath = path.join(getToolRoot(), 'package.json');
        const raw = fs.readFileSync(pkgPath, 'utf8');
        const pkg = JSON.parse(raw) as { version?: unknown };
        return typeof pkg.version === 'string' && pkg.version.length > 0
            ? pkg.version
            : 'unknown';
    } catch {
        return 'unknown';
    }
}
