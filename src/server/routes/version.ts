import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Router } from '../router.js';
import { sendJson } from '../requestUtils.js';
import { getToolRoot } from '../../utils/paths.js';

// ---------------------------------------------------------------------------
// Version resolution — read both package.json files once at module load time.
// ---------------------------------------------------------------------------

function readVersion(pkgPath: string): string {
    try {
        const raw = fs.readFileSync(pkgPath, 'utf8');
        const pkg = JSON.parse(raw) as { version?: unknown };
        return typeof pkg.version === 'string' && pkg.version.length > 0
            ? pkg.version
            : 'unknown';
    } catch {
        return 'unknown';
    }
}

const toolRoot = getToolRoot();
const appVersion  = readVersion(path.join(toolRoot, 'package.json'));
const guiVersion  = readVersion(path.join(toolRoot, 'gui', 'package.json'));

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers the version endpoint.
 *
 * | Method | Path          | Description                                      |
 * |--------|---------------|--------------------------------------------------|
 * | GET    | /api/version  | Return app and GUI version strings from package.json. |
 *
 * Response shape: `{ appVersion: string, guiVersion: string }`
 */
export function registerVersionRoute(router: Router): void {
    router.get('/api/version', (_req, res) => {
        sendJson(res, 200, { appVersion, guiVersion });
    });
}
