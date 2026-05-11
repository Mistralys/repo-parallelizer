/**
 * Shared HTTP mock helpers for server-layer unit tests.
 *
 * Provides lightweight in-process fakes for Node's `IncomingMessage` and
 * `ServerResponse` objects so route handlers can be tested without standing up
 * a real HTTP server.
 *
 * **Exports**
 * - `mockRequest(method, url, bodyJson?)` — builds a fake `IncomingMessage` that
 *   emits `data` + `end` (or just `end`) on the next tick, and emits `error` on
 *   `.destroy()`.
 * - `MockResponse` — interface capturing the result of a handler call
 *   (`statusCode`, `headers`, `body`, raw `res`).
 * - `mockResponse()` — builds a `MockResponse` whose `.res` intercepts
 *   `writeHead()` and `end()` calls so assertions can inspect status codes and
 *   response bodies. `statusCode` starts as `undefined` (not `0`) so tests can
 *   distinguish "handler never wrote a response" from a deliberate `200`.
 * - `MockStreamResponse` — interface for streaming responses that capture
 *   `endCalled` and `piped` flags instead of a body string (used by
 *   `staticServer.test.ts` where responses are piped via `ReadStream.pipe(res)`).
 * - `mockStreamResponse()` — builds a `MockStreamResponse` whose `.res` accepts
 *   `writeHead()`, `end()`, and `write()` (the minimum a piped stream needs).
 * - `flushAsync()` — awaits two `process.nextTick` callbacks, giving async route
 *   handlers and event emitters time to run before assertions fire.
 *
 * **Consumers**
 * - `src/server/__tests__/routes/branches.test.ts`
 * - `src/server/__tests__/routes/config.test.ts`
 * - `src/server/__tests__/routes/error-log.test.ts`
 * - `src/server/__tests__/routes/notes.test.ts`
 * - `src/server/__tests__/routes/projects.test.ts`
 * - `src/server/__tests__/routes/repositories.test.ts`
 * - `src/server/__tests__/routes/status.test.ts`
 * - `src/server/__tests__/routes/workspaces.test.ts`
 * - `src/server/__tests__/routes/workspaces-health.test.ts`
 * - `src/server/__tests__/routes/workspaces-launch.test.ts`
 * - `src/server/__tests__/config.notes-display.test.ts`
 * - `src/server/__tests__/requestUtils.test.ts`
 * - `src/server/__tests__/router.test.ts`
 * - `src/server/__tests__/staticServer.test.ts`
 */
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

export function mockRequest(method: string, url: string, bodyJson?: unknown): IncomingMessage {
    const req = new EventEmitter() as IncomingMessage;
    (req as unknown as { method: string }).method = method;
    (req as unknown as { url: string }).url = url;
    (req as unknown as { destroy(): void }).destroy = () => {
        req.emit('error', new Error('destroyed'));
    };

    process.nextTick(() => {
        if (bodyJson !== undefined) {
            req.emit('data', Buffer.from(JSON.stringify(bodyJson)));
        }
        req.emit('end');
    });

    return req;
}

export interface MockResponse {
    statusCode: number | undefined;
    headers: Record<string, string | number>;
    body: string;
    res: ServerResponse;
}

export function mockResponse(): MockResponse {
    const mock: MockResponse = {
        statusCode: undefined,
        headers: {},
        body: '',
        res: null as unknown as ServerResponse,
    };

    const res = new EventEmitter() as unknown as ServerResponse;

    (res as unknown as {
        writeHead(status: number, headers?: Record<string, string | number>): void;
    }).writeHead = (status: number, headers?: Record<string, string | number>) => {
        mock.statusCode = status;
        if (headers !== undefined) {
            mock.headers = { ...headers };
        }
    };

    (res as unknown as { end(body?: string): void }).end = (body?: string) => {
        mock.body = body ?? '';
    };

    mock.res = res;
    return mock;
}

export interface MockStreamResponse {
    statusCode: number | undefined;
    headers: Record<string, string | number>;
    endCalled: boolean;
    piped: boolean;
    res: ServerResponse;
}

export function mockStreamResponse(): MockStreamResponse {
    const mock: MockStreamResponse = {
        statusCode: undefined,
        headers: {},
        endCalled: false,
        piped: false,
        res: null as unknown as ServerResponse,
    };

    const res = new EventEmitter() as unknown as ServerResponse;

    (res as unknown as {
        writeHead(status: number, headers?: Record<string, string | number>): void;
    }).writeHead = (status: number, headers?: Record<string, string | number>) => {
        mock.statusCode = status;
        if (headers !== undefined) {
            mock.headers = { ...headers };
        }
    };

    (res as unknown as { end(body?: string): void }).end = (body?: string) => {
        void body;
        mock.endCalled = true;
    };

    // The ReadStream.pipe(res) destination needs `write` and `end` on the writable side.
    (res as unknown as { write(chunk: unknown): boolean }).write = (_chunk: unknown): boolean => {
        mock.piped = true;
        return true;
    };

    mock.res = res;
    return mock;
}

/**
 * Awaits two `process.nextTick` turns, giving async route handlers and event
 * emitters time to complete before assertions fire.
 */
export async function flushAsync(): Promise<void> {
    await new Promise<void>((r) => process.nextTick(r));
    await new Promise<void>((r) => process.nextTick(r));
}
