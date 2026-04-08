import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError } from './requestUtils.js';

// ---------------------------------------------------------------------------
// MIME type map
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
};

const DEFAULT_MIME = 'application/octet-stream';

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Serves a static file from `baseDir` for the URL in `req`.
 *
 * - `/` (root) is silently remapped to `index.html`.
 * - A path that resolves outside `baseDir` (directory traversal) gets a 403
 *   **without any filesystem I/O**.
 * - If the resolved file does not exist, `false` is returned so the caller
 *   can fall through to the API router.
 * - Otherwise the file is streamed to the response with an appropriate
 *   `Content-Type` header and `true` is returned.
 *
 * @param req     Incoming HTTP request (only `req.url` is read).
 * @param res     ServerResponse to write to.
 * @param baseDir Absolute path to the static files directory.
 * @returns       `true` if the file was served (or a 403 was sent),
 *                `false` if the file was not found.
 */
export async function serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    baseDir: string,
): Promise<boolean> {
    // Strip query string and decode percent-encoding.
    const rawUrl = req.url ?? '/';
    let urlPath = rawUrl.split('?')[0];

    // Decode before resolving so %2e%2e won't slip past the prefix check.
    try {
        urlPath = decodeURIComponent(urlPath);
    } catch {
        sendError(res, 400, 'Malformed URL');
        return true;
    }

    // Root → index.html
    if (urlPath === '/' || urlPath === '') {
        urlPath = '/index.html';
    }

    // Resolve to an absolute path (path.join already normalises `..` segments).
    const resolved = path.resolve(baseDir, '.' + urlPath);

    // Guard: the resolved path must still be inside baseDir.
    // We append sep to baseDir so /foo/barbaz doesn't match /foo/bar.
    const safeBase = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
    if (!resolved.startsWith(safeBase) && resolved !== baseDir) {
        sendError(res, 403, 'Forbidden');
        return true;
    }

    // File existence check (avoids throwing on stat for missing files).
    if (!existsSync(resolved)) {
        return false;
    }

    // Make sure it's a regular file, not a directory.
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) {
        return false;
    }

    // Determine Content-Type from extension.
    const ext = path.extname(resolved).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? DEFAULT_MIME;

    res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': fileStat.size,
    });

    await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(resolved);
        stream.pipe(res);
        stream.on('end', resolve);
        stream.on('error', reject);
    });

    return true;
}
