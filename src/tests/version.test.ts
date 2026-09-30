import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getToolVersion } from '../utils/version.js';
import { getToolRoot } from '../utils/paths.js';

test('getToolVersion() takes no arguments', () => {
    assert.strictEqual(getToolVersion.length, 0);
});

test('getToolVersion() returns a non-empty string', () => {
    const version = getToolVersion();
    assert.strictEqual(typeof version, 'string');
    assert.ok(version.length > 0);
});

test('getToolVersion() matches the version field in the tool\'s own package.json', () => {
    const pkgPath = path.join(getToolRoot(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: unknown };
    assert.strictEqual(getToolVersion(), pkg.version);
});

test('getToolVersion() is consistent across calls', () => {
    assert.strictEqual(getToolVersion(), getToolVersion());
});

test('getToolVersion() never throws', () => {
    assert.doesNotThrow(() => getToolVersion());
});
