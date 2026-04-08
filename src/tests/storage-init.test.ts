import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AppConfig } from '../config/config.types.js';
import { initializeStorage } from '../storage/json-storage.js';

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-init-test-'));
}

function makeConfig(base: string): AppConfig {
    return {
        storageFolder: path.join(base, 'storage'),
        projectsFolder: path.join(base, 'projects'),
        cloneDepth: 50,
        serverPort: 4200,
        gitPollingIntervalSeconds: 30,
    };
}

// --- Directory creation on first call ---

test('initializeStorage creates storageFolder on first call', () => {
    const base = makeTempDir();
    const config = makeConfig(base);
    initializeStorage(config);
    assert.ok(fs.existsSync(config.storageFolder), 'storageFolder should exist');
});

test('initializeStorage creates projects subfolder inside storageFolder on first call', () => {
    const base = makeTempDir();
    const config = makeConfig(base);
    initializeStorage(config);
    assert.ok(
        fs.existsSync(path.join(config.storageFolder, 'projects')),
        'storage/projects subdirectory should exist',
    );
});

test('initializeStorage creates projectsFolder on first call', () => {
    const base = makeTempDir();
    const config = makeConfig(base);
    initializeStorage(config);
    assert.ok(fs.existsSync(config.projectsFolder), 'projectsFolder should exist');
});

// --- Seed file structure ---

test('initializeStorage creates repositories.json with correct JSON structure', () => {
    const base = makeTempDir();
    const config = makeConfig(base);
    initializeStorage(config);
    const repoPath = path.join(config.storageFolder, 'repositories.json');
    assert.ok(fs.existsSync(repoPath), 'repositories.json should exist');
    const content = JSON.parse(fs.readFileSync(repoPath, 'utf8'));
    assert.deepStrictEqual(content, { Repositories: [], SchemaVersion: 1 });
});

test('initializeStorage creates projects-index.json with correct JSON structure', () => {
    const base = makeTempDir();
    const config = makeConfig(base);
    initializeStorage(config);
    const indexPath = path.join(config.storageFolder, 'projects-index.json');
    assert.ok(fs.existsSync(indexPath), 'projects-index.json should exist');
    const content = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    assert.deepStrictEqual(content, { Projects: [], SchemaVersion: 1 });
});

// --- Idempotency (second call must not overwrite non-empty files) ---

test('second initializeStorage() call does not overwrite non-empty repositories.json', () => {
    const base = makeTempDir();
    const config = makeConfig(base);
    initializeStorage(config);
    const repoPath = path.join(config.storageFolder, 'repositories.json');
    const modified = { Repositories: [{ id: 'repo-1' }], SchemaVersion: 1 };
    fs.writeFileSync(repoPath, JSON.stringify(modified, null, 4) + '\n', 'utf8');
    initializeStorage(config);
    const content = JSON.parse(fs.readFileSync(repoPath, 'utf8'));
    assert.deepStrictEqual(content, modified);
});

test('second initializeStorage() call does not overwrite non-empty projects-index.json', () => {
    const base = makeTempDir();
    const config = makeConfig(base);
    initializeStorage(config);
    const indexPath = path.join(config.storageFolder, 'projects-index.json');
    const modified = { Projects: [{ id: 'proj-1' }], SchemaVersion: 1 };
    fs.writeFileSync(indexPath, JSON.stringify(modified, null, 4) + '\n', 'utf8');
    initializeStorage(config);
    const content = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    assert.deepStrictEqual(content, modified);
});

// --- Partial initialization (directories pre-exist, seed files missing) ---

test('initializeStorage creates missing seed files when directories already exist', () => {
    const base = makeTempDir();
    const config = makeConfig(base);
    fs.mkdirSync(config.storageFolder, { recursive: true });
    fs.mkdirSync(path.join(config.storageFolder, 'projects'), { recursive: true });
    fs.mkdirSync(config.projectsFolder, { recursive: true });
    initializeStorage(config);
    assert.ok(
        fs.existsSync(path.join(config.storageFolder, 'repositories.json')),
        'repositories.json should be created even when directories pre-exist',
    );
    assert.ok(
        fs.existsSync(path.join(config.storageFolder, 'projects-index.json')),
        'projects-index.json should be created even when directories pre-exist',
    );
});

// --- Edge cases ---

test('initializeStorage is idempotent for directories that already exist', () => {
    const base = makeTempDir();
    const config = makeConfig(base);
    initializeStorage(config);
    // Second call must not throw even though all dirs and files already exist.
    assert.doesNotThrow(() => initializeStorage(config));
});

test('initializeStorage does not modify seed file content on repeated calls', () => {
    const base = makeTempDir();
    const config = makeConfig(base);
    initializeStorage(config);
    const repoPath = path.join(config.storageFolder, 'repositories.json');
    const indexPath = path.join(config.storageFolder, 'projects-index.json');
    const repoBefore = fs.readFileSync(repoPath, 'utf8');
    const indexBefore = fs.readFileSync(indexPath, 'utf8');
    initializeStorage(config);
    assert.strictEqual(fs.readFileSync(repoPath, 'utf8'), repoBefore);
    assert.strictEqual(fs.readFileSync(indexPath, 'utf8'), indexBefore);
});
