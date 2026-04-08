import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    readJsonFile,
    writeJsonFile,
    ensureDirectory,
    FileNotFoundError,
} from '../storage/json-storage.js';

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-test-'));
}

// --- writeJsonFile + readJsonFile ---

test('writeJsonFile + readJsonFile round-trips a flat object', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'data.json');
    const data = { name: 'test', value: 42 };
    writeJsonFile(filePath, data);
    assert.deepStrictEqual(readJsonFile<typeof data>(filePath), data);
});

test('writeJsonFile + readJsonFile round-trips a nested object', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'nested.json');
    const data = { a: { b: { c: [1, 2, 3], flag: true } } };
    writeJsonFile(filePath, data);
    assert.deepStrictEqual(readJsonFile<typeof data>(filePath), data);
});

test('writeJsonFile uses 4-space indentation', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'indent.json');
    writeJsonFile(filePath, { x: 1 });
    const content = fs.readFileSync(filePath, 'utf8');
    assert.ok(content.includes('    "x"'), 'expected 4-space indentation');
});

test('writeJsonFile appends a trailing newline', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'newline.json');
    writeJsonFile(filePath, { x: 1 });
    const content = fs.readFileSync(filePath, 'utf8');
    assert.ok(content.endsWith('\n'), 'file should end with a newline character');
});

test('writeJsonFile creates parent directories automatically', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'sub', 'dir', 'data.json');
    writeJsonFile(filePath, { ok: true });
    assert.ok(fs.existsSync(filePath));
});

// --- readJsonFile errors ---

test('readJsonFile throws FileNotFoundError for a missing file', () => {
    assert.throws(
        () => readJsonFile('/nonexistent/path/file.json'),
        FileNotFoundError
    );
});

test('FileNotFoundError.filePath contains the requested path', () => {
    const target = '/no/such/file.json';
    let caught: FileNotFoundError | undefined;
    try {
        readJsonFile(target);
    } catch (err) {
        if (err instanceof FileNotFoundError) {
            caught = err;
        }
    }
    assert.ok(caught !== undefined, 'expected a FileNotFoundError to be thrown');
    assert.strictEqual(caught.filePath, target);
});

test('readJsonFile throws on malformed JSON', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'bad.json');
    fs.writeFileSync(filePath, '{ not: valid json }', 'utf8');
    assert.throws(() => readJsonFile(filePath), /Failed to parse JSON/);
});

// --- ensureDirectory ---

test('ensureDirectory creates a deeply nested directory', () => {
    const dir = makeTempDir();
    const nested = path.join(dir, 'a', 'b', 'c');
    ensureDirectory(nested);
    assert.ok(fs.existsSync(nested));
});

test('ensureDirectory is a no-op when the directory already exists', () => {
    const dir = makeTempDir();
    assert.doesNotThrow(() => ensureDirectory(dir));
});
