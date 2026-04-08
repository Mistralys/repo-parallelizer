import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { getToolRoot, getConfigPath, getStorageFolder, getProjectsFolder } from '../utils/paths.js';

test('getToolRoot() returns a directory containing package.json', () => {
    const root = getToolRoot();
    assert.ok(
        fs.existsSync(path.join(root, 'package.json')),
        'tool root should contain package.json'
    );
});

test('getToolRoot() returns an absolute path', () => {
    assert.ok(path.isAbsolute(getToolRoot()), 'tool root should be an absolute path');
});

test('getToolRoot() is consistent across calls (cache)', () => {
    assert.strictEqual(getToolRoot(), getToolRoot());
});

test('getConfigPath() ends with config.json', () => {
    assert.ok(getConfigPath().endsWith('config.json'), 'config path should end with config.json');
});

test('getConfigPath() is inside tool root', () => {
    assert.ok(
        getConfigPath().startsWith(getToolRoot()),
        'config path should be inside the tool root'
    );
});

test('getStorageFolder() resolves a relative path against tool root', () => {
    const resolved = getStorageFolder({ storageFolder: 'data/storage', projectsFolder: '/' });
    assert.ok(path.isAbsolute(resolved), 'result should be an absolute path');
    assert.ok(resolved.startsWith(getToolRoot()), 'relative path should resolve under tool root');
});

test('getStorageFolder() returns an absolute path unchanged', () => {
    const abs = path.resolve('/tmp/storage');
    assert.strictEqual(
        getStorageFolder({ storageFolder: abs, projectsFolder: '/' }),
        abs
    );
});

test('getProjectsFolder() resolves a relative path against tool root', () => {
    const resolved = getProjectsFolder({ storageFolder: '/', projectsFolder: 'my-projects' });
    assert.ok(path.isAbsolute(resolved), 'result should be an absolute path');
    assert.ok(resolved.startsWith(getToolRoot()), 'relative path should resolve under tool root');
});

test('getProjectsFolder() returns an absolute path unchanged', () => {
    const abs = path.resolve('/tmp/projects');
    assert.strictEqual(
        getProjectsFolder({ storageFolder: '/', projectsFolder: abs }),
        abs
    );
});
