import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import {
    generateWorkspaceFile,
    removeWorkspaceFile,
    getWorkspaceFilePath,
    migrateWorkspaceFiles,
} from '../orchestration/vscode-workspace.js';

const _tempDirs: string[] = [];
process.on('exit', () => {
    for (const dir of _tempDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
});

function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-vscode-ws-test-'));
    _tempDirs.push(dir);
    return dir;
}

// ─── getWorkspaceFilePath ─────────────────────────────────────────────────────

test('getWorkspaceFilePath returns the correct format', () => {
    const result = getWorkspaceFilePath('/projects', 'my-project', 'STABLE');
    assert.strictEqual(result, path.join('/projects', 'my-project', 'my-project-STABLE.code-workspace'));
});

test('getWorkspaceFilePath works with nested projectsFolder', () => {
    const result = getWorkspaceFilePath('/base/projects', 'alpha', 'DEV');
    assert.strictEqual(result, path.join('/base/projects', 'alpha', 'alpha-DEV.code-workspace'));
});

// ─── generateWorkspaceFile — new file ────────────────────────────────────────

test('generateWorkspaceFile creates the file when it does not exist', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'test.code-workspace');
    generateWorkspaceFile('STABLE', [], filePath);
    assert.ok(fs.existsSync(filePath), 'file should be created');
});

test('generateWorkspaceFile creates a valid JSON file with folders and settings', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'test.code-workspace');
    generateWorkspaceFile('STABLE', [
        { slug: 'repo-a', path: '/projects/my-project/STABLE/repo-a' },
    ], filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.ok('folders' in parsed, 'should have folders property');
    assert.ok('settings' in parsed, 'should have settings property');
    assert.deepStrictEqual(parsed.settings, {}, 'settings should be empty object');
});

test('generateWorkspaceFile creates correct folder entries with absolute path and name', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'test.code-workspace');
    generateWorkspaceFile('STABLE', [
        { slug: 'repo-a', path: '/abs/path/repo-a' },
        { slug: 'repo-b', path: '/abs/path/repo-b' },
    ], filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.strictEqual(parsed.folders.length, 2);
    assert.strictEqual(parsed.folders[0].path, '/abs/path/repo-a');
    assert.strictEqual(parsed.folders[0].name, 'repo-a (STABLE)');
    assert.strictEqual(parsed.folders[1].path, '/abs/path/repo-b');
    assert.strictEqual(parsed.folders[1].name, 'repo-b (STABLE)');
});

test('generateWorkspaceFile folder name uses "slug (WORKSPACE_ID)" format', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'test.code-workspace');
    generateWorkspaceFile('DEV', [
        { slug: 'core', path: '/projects/alpha/DEV/core' },
    ], filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.strictEqual(parsed.folders[0].name, 'core (DEV)');
});

test('generateWorkspaceFile assigns distinct names to each folder for multi-repo projects', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'test.code-workspace');
    generateWorkspaceFile('DEV', [
        { slug: 'frontend', path: '/projects/my-project/DEV/frontend' },
        { slug: 'backend', path: '/projects/my-project/DEV/backend' },
        { slug: 'infra', path: '/projects/my-project/DEV/infra' },
    ], filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const names: string[] = parsed.folders.map((f: { name: string }) => f.name);
    assert.strictEqual(names[0], 'frontend (DEV)');
    assert.strictEqual(names[1], 'backend (DEV)');
    assert.strictEqual(names[2], 'infra (DEV)');
    const uniqueNames = new Set(names);
    assert.strictEqual(uniqueNames.size, names.length, 'every folder should have a distinct name');
});

test('generateWorkspaceFile creates parent directories if they do not exist', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'sub', 'dir', 'test.code-workspace');
    generateWorkspaceFile('DEV', [], filePath);
    assert.ok(fs.existsSync(filePath), 'file should be created inside nested dirs');
});

// ─── generateWorkspaceFile — existing file ───────────────────────────────────

test('generateWorkspaceFile replaces folders when file already exists', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'test.code-workspace');
    generateWorkspaceFile('STABLE', [
        { slug: 'repo-a', path: '/abs/repo-a' },
    ], filePath);
    generateWorkspaceFile('STABLE', [
        { slug: 'repo-b', path: '/abs/repo-b' },
        { slug: 'repo-c', path: '/abs/repo-c' },
    ], filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.strictEqual(parsed.folders.length, 2);
    assert.strictEqual(parsed.folders[0].path, '/abs/repo-b');
    assert.strictEqual(parsed.folders[1].path, '/abs/repo-c');
});

test('generateWorkspaceFile preserves settings when updating an existing file', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'test.code-workspace');
    const existing = {
        folders: [],
        settings: { 'editor.fontSize': 14, 'workbench.colorTheme': 'Monokai' },
    };
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 4) + '\n', 'utf8');
    generateWorkspaceFile('STABLE', [
        { slug: 'repo-a', path: '/abs/repo-a' },
    ], filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.deepStrictEqual(parsed.settings, existing.settings, 'settings should be preserved');
});

test('generateWorkspaceFile preserves extensions when updating an existing file', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'test.code-workspace');
    const existing = {
        folders: [],
        settings: {},
        extensions: { recommendations: ['dbaeumer.vscode-eslint'] },
    };
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 4) + '\n', 'utf8');
    generateWorkspaceFile('STABLE', [], filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.deepStrictEqual(parsed.extensions, existing.extensions, 'extensions should be preserved');
});

test('generateWorkspaceFile preserves arbitrary custom properties on an existing file', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'test.code-workspace');
    const existing = {
        folders: [],
        settings: {},
        myCustomKey: 'keep-me',
    };
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 4) + '\n', 'utf8');
    generateWorkspaceFile('STABLE', [], filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.strictEqual(parsed.myCustomKey, 'keep-me', 'custom keys should be preserved');
});

// ─── removeWorkspaceFile ──────────────────────────────────────────────────────

test('removeWorkspaceFile deletes an existing file', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'test.code-workspace');
    fs.writeFileSync(filePath, '{}', 'utf8');
    assert.ok(fs.existsSync(filePath), 'precondition: file should exist before removal');
    removeWorkspaceFile(filePath);
    assert.ok(!fs.existsSync(filePath), 'file should be deleted');
});

test('removeWorkspaceFile does not throw when the file does not exist', () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, 'nonexistent.code-workspace');
    assert.doesNotThrow(() => removeWorkspaceFile(filePath));
});

// ─── migrateWorkspaceFiles ────────────────────────────────────────────────────

test('migrateWorkspaceFiles moves matching files from flat root into project subdirectory', () => {
    const projectsFolder = makeTempDir();
    const slug = 'my-app';

    // Create flat-layout files to be migrated.
    fs.writeFileSync(path.join(projectsFolder, 'my-app-STABLE.code-workspace'), '{}', 'utf8');
    fs.writeFileSync(path.join(projectsFolder, 'my-app-DEV.code-workspace'), '{}', 'utf8');

    const moved = migrateWorkspaceFiles(projectsFolder, [slug]);

    assert.strictEqual(moved, 2, 'should report 2 files moved');
    assert.ok(
        fs.existsSync(path.join(projectsFolder, slug, 'my-app-STABLE.code-workspace')),
        'STABLE file should be at nested location',
    );
    assert.ok(
        fs.existsSync(path.join(projectsFolder, slug, 'my-app-DEV.code-workspace')),
        'DEV file should be at nested location',
    );
    assert.ok(
        !fs.existsSync(path.join(projectsFolder, 'my-app-STABLE.code-workspace')),
        'STABLE file should no longer exist at flat location',
    );
    assert.ok(
        !fs.existsSync(path.join(projectsFolder, 'my-app-DEV.code-workspace')),
        'DEV file should no longer exist at flat location',
    );
});

test('migrateWorkspaceFiles is idempotent — re-running after migration produces no errors and no duplicate files', () => {
    const projectsFolder = makeTempDir();
    const slug = 'alpha';

    // Simulate already-migrated state: file only exists at nested location.
    const nestedDir = path.join(projectsFolder, slug);
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, 'alpha-STABLE.code-workspace'), '{}', 'utf8');

    // Running migration with no flat-layout files should be a no-op.
    assert.doesNotThrow(() => {
        const moved = migrateWorkspaceFiles(projectsFolder, [slug]);
        assert.strictEqual(moved, 0, 'should report 0 files moved when already in-place');
    });

    // The nested file should still be intact.
    assert.ok(
        fs.existsSync(path.join(nestedDir, 'alpha-STABLE.code-workspace')),
        'nested file should still exist after idempotent run',
    );
});

test('migrateWorkspaceFiles returns 0 when no matching source files exist', () => {
    const projectsFolder = makeTempDir();
    const moved = migrateWorkspaceFiles(projectsFolder, ['some-project']);
    assert.strictEqual(moved, 0, 'should return 0 when no matching files exist');
});

test('migrateWorkspaceFiles leaves unrecognized .code-workspace files untouched', () => {
    const projectsFolder = makeTempDir();

    // A .code-workspace file that does not match any known slug.
    const unknownFile = path.join(projectsFolder, 'unknown-project-STABLE.code-workspace');
    fs.writeFileSync(unknownFile, '{}', 'utf8');

    const moved = migrateWorkspaceFiles(projectsFolder, ['my-app']);

    assert.strictEqual(moved, 0, 'should report 0 files moved');
    assert.ok(fs.existsSync(unknownFile), 'unrecognized file should remain at original location');
});
