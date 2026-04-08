import type { IncomingMessage, ServerResponse } from 'node:http';

const BODY_LIMIT = 1 * 1024 * 1024; // 1 MB

/**
 * Reads the body of an IncomingMessage, enforces a 1 MB size limit, and
 * resolves with the parsed JSON object.  Rejects with a descriptive error
 * if the body exceeds the limit or contains malformed JSON.
 */
export function parseJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        let settled = false;

        function fail(err: Error): void {
            if (!settled) {
                settled = true;
                reject(err);
            }
        }

        req.on('data', (chunk: Buffer) => {
            if (settled) return;
            totalBytes += chunk.length;
            if (totalBytes > BODY_LIMIT) {
                // Destroy the stream so no further 'data' events fire.
                // We set `settled` before calling destroy() so the 'error'
                // event that some stream implementations emit on destroy does
                // not race against our own rejection.
                settled = true;
                req.destroy();
                reject(new Error(`Request body exceeds the 1 MB limit`));
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => {
            if (settled) return;
            const raw = Buffer.concat(chunks).toString('utf8');
            try {
                resolve(JSON.parse(raw));
                settled = true;
            } catch {
                fail(new Error(`Invalid JSON body: ${raw.slice(0, 120)}`));
            }
        });

        req.on('error', (err: Error) => {
            fail(new Error(`Error reading request body: ${err.message}`));
        });
    });
}

/**
 * Writes a JSON response with the given HTTP status code.
 * Always sets `Content-Type: application/json`.
 */
export function sendJson(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

/**
 * Sends a JSON error response with the shape `{ error: string }`.
 */
export function sendError(res: ServerResponse, status: number, message: string): void {
    sendJson(res, status, { error: message });
}

/**
 * Matches `url` against a `:named`-segment pattern (e.g. `/repos/:id/branches/:branch`)
 * and returns an object mapping each named segment to its captured value.
 * Returns `null` when the URL does not match the pattern.
 *
 * Only the **pathname** portion of the URL is compared — query strings and
 * trailing slashes on the pattern side are not supported.
 *
 * Examples:
 *   extractParams('/repos/:id', '/repos/42')         → { id: '42' }
 *   extractParams('/repos/:id', '/repos/42/extra')   → null
 *   extractParams('/repos/:id', '/other/42')         → null
 */
export function extractParams(
    pattern: string,
    url: string,
): Record<string, string> | null {
    // Strip query string from the incoming URL
    const pathname = url.split('?')[0];

    const patternSegments = pattern.split('/');
    const urlSegments = pathname.split('/');

    if (patternSegments.length !== urlSegments.length) {
        return null;
    }

    const params: Record<string, string> = {};

    for (let i = 0; i < patternSegments.length; i++) {
        const p = patternSegments[i];
        const u = urlSegments[i];

        if (p.startsWith(':')) {
            // Named parameter — capture the value
            const name = p.slice(1);
            params[name] = u;
        } else if (p !== u) {
            // Static segment mismatch
            return null;
        }
    }

    return params;
}

/**
 * Narrows an `unknown` value to an object (not null, not an array).
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
