import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serveStatic } from '../staticServer.js';
import { mockRequest as sharedMockRequest, mockStreamResponse, type MockStreamResponse } from './helpers/mock-http.js';

// ---------------------------------------------------------------------------
// Temporary base directory — set up once, torn down after all tests
// ---------------------------------------------------------------------------

const BASE_DIR = mkdtempSync(path.join(tmpdir(), 'static-test-'));

// Populate fixtures
writeFileSync(path.join(BASE_DIR, 'index.html'), '<html>hello</html>');
writeFileSync(path.join(BASE_DIR, 'style.css'),  'body { margin: 0 }');
writeFileSync(path.join(BASE_DIR, 'app.js'),     'console.log("hi")');
writeFileSync(path.join(BASE_DIR, 'data.json'),  '{"ok":true}');
writeFileSync(path.join(BASE_DIR, 'logo.png'),   Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
writeFileSync(path.join(BASE_DIR, 'icon.svg'),   '<svg/>');
writeFileSync(path.join(BASE_DIR, 'favicon.ico'), Buffer.alloc(4));

// A sub-directory for directory-request tests
const SUB_DIR = path.join(BASE_DIR, 'subdir');
mkdirSync(SUB_DIR);
writeFileSync(path.join(SUB_DIR, 'page.html'), '<html>sub</html>');

after(() => {
    rmSync(BASE_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/** Thin wrapper: shared mockRequest expects (method, url); static tests only pass url. */
const mockRequest = (url: string) => sharedMockRequest('GET', url);

/** Alias for readability in this test file. */
const mockResponse = mockStreamResponse;
type MockResponse = MockStreamResponse;

// ---------------------------------------------------------------------------
// Root path → index.html
// ---------------------------------------------------------------------------

test('serveStatic: / serves index.html and returns true', async () => {
    const mock = mockResponse();
    const result = await serveStatic(mockRequest('/'), mock.res, BASE_DIR);

    assert.strictEqual(result, true);
    assert.strictEqual(mock.statusCode, 200);
});

test('serveStatic: / sets Content-Type to text/html', async () => {
    const mock = mockResponse();
    await serveStatic(mockRequest('/'), mock.res, BASE_DIR);

    assert.ok(
        (mock.headers['Content-Type'] as string).startsWith('text/html'),
        `Expected text/html, got: ${mock.headers['Content-Type']}`,
    );
});

// ---------------------------------------------------------------------------
// Content-Type correctness per extension
// ---------------------------------------------------------------------------

const MIME_CASES: Array<[string, string, string]> = [
    ['/index.html', 'text/html',        '.html'],
    ['/style.css',  'text/css',         '.css'],
    ['/app.js',     'text/javascript',  '.js'],
    ['/data.json',  'application/json', '.json'],
    ['/logo.png',   'image/png',        '.png'],
    ['/icon.svg',   'image/svg+xml',    '.svg'],
    ['/favicon.ico','image/x-icon',     '.ico'],
];

for (const [url, expectedMimePrefix, ext] of MIME_CASES) {
    test(`serveStatic: Content-Type for ${ext} starts with "${expectedMimePrefix}"`, async () => {
        const mock = mockResponse();
        const result = await serveStatic(mockRequest(url), mock.res, BASE_DIR);

        assert.strictEqual(result, true, `Expected true for ${url}`);
        assert.ok(
            (mock.headers['Content-Type'] as string).startsWith(expectedMimePrefix),
            `Expected "${expectedMimePrefix}" in Content-Type, got: ${mock.headers['Content-Type']}`,
        );
    });
}

// ---------------------------------------------------------------------------
// Valid asset in sub-directory
// ---------------------------------------------------------------------------

test('serveStatic: serves a file in a sub-directory', async () => {
    const mock = mockResponse();
    const result = await serveStatic(mockRequest('/subdir/page.html'), mock.res, BASE_DIR);

    assert.strictEqual(result, true);
    assert.strictEqual(mock.statusCode, 200);
});

// ---------------------------------------------------------------------------
// Content-Length header
// ---------------------------------------------------------------------------

test('serveStatic: sets Content-Length header', async () => {
    const mock = mockResponse();
    await serveStatic(mockRequest('/index.html'), mock.res, BASE_DIR);

    const len = mock.headers['Content-Length'];
    assert.ok(typeof len === 'number' && len > 0, `Expected positive Content-Length, got: ${len}`);
});

// ---------------------------------------------------------------------------
// Directory traversal → 403
// ---------------------------------------------------------------------------

test('serveStatic: ../ traversal attempt returns 403', async () => {
    const mock = mockResponse();
    // Attempt to escape base directory
    const result = await serveStatic(mockRequest('/../etc/passwd'), mock.res, BASE_DIR);

    assert.strictEqual(result, true, 'Expected true (request was handled with 403)');
    assert.strictEqual(mock.statusCode, 403);
});

test('serveStatic: URL-encoded traversal attempt returns 403', async () => {
    const mock = mockResponse();
    const result = await serveStatic(mockRequest('/%2e%2e%2fetc%2fpasswd'), mock.res, BASE_DIR);

    // After decoding this becomes /../etc/passwd → should 403
    assert.strictEqual(mock.statusCode, 403);
    void result; // may be true or we can assert it
});

test('serveStatic: traversal that resolves inside base is allowed', async () => {
    // /subdir/../index.html normalises to /index.html — still inside base
    const mock = mockResponse();
    const result = await serveStatic(mockRequest('/subdir/../index.html'), mock.res, BASE_DIR);

    assert.strictEqual(result, true);
    assert.strictEqual(mock.statusCode, 200);
});

test('serveStatic: does not perform any file I/O before the 403 is sent (traversal)', async () => {
    // We verify this indirectly: if existsSync were called before the guard,
    // a non-existent path would return false instead of 403.
    const mock = mockResponse();
    // Use a path that definitely doesn't exist outside base
    const result = await serveStatic(mockRequest('/../../nonexistent-file-xyz'), mock.res, BASE_DIR);

    assert.strictEqual(result, true);
    assert.strictEqual(mock.statusCode, 403);
});

// ---------------------------------------------------------------------------
// Missing file → returns false
// ---------------------------------------------------------------------------

test('serveStatic: returns false for a non-existent file', async () => {
    const mock = mockResponse();
    const result = await serveStatic(mockRequest('/does-not-exist.html'), mock.res, BASE_DIR);

    assert.strictEqual(result, false);
    assert.strictEqual(mock.statusCode, undefined, 'Should not write any response for missing file');
});

test('serveStatic: returns false for a missing nested path', async () => {
    const mock = mockResponse();
    const result = await serveStatic(mockRequest('/subdir/no-such-file.txt'), mock.res, BASE_DIR);

    assert.strictEqual(result, false);
});

// ---------------------------------------------------------------------------
// Directory path → returns false (not a regular file)
// ---------------------------------------------------------------------------

test('serveStatic: returns false when path resolves to a directory', async () => {
    const mock = mockResponse();
    // /subdir/ resolves to the actual sub-directory created above
    const result = await serveStatic(mockRequest('/subdir'), mock.res, BASE_DIR);

    assert.strictEqual(result, false);
});

// ---------------------------------------------------------------------------
// Query string stripped
// ---------------------------------------------------------------------------

test('serveStatic: ignores query string when resolving the file path', async () => {
    const mock = mockResponse();
    const result = await serveStatic(mockRequest('/index.html?v=123'), mock.res, BASE_DIR);

    assert.strictEqual(result, true);
    assert.strictEqual(mock.statusCode, 200);
});
