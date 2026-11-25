import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const ENTRY = path.resolve(__dirname, '..', 'index.js');

test('T-43: `paralizer help` exits 0 and lists the regenerate command', () => {
    const result = spawnSync(process.execPath, [ENTRY, 'help'], { encoding: 'utf8' });

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /^\s+regenerate\s/m);
    assert.match(result.stdout, /paralizer regenerate \[<project-id>\]/);
});

test('T-43: `paralizer help` lists the directives command', () => {
    const result = spawnSync(process.execPath, [ENTRY, 'help'], { encoding: 'utf8' });

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /^\s+directives\s/m);
    assert.match(result.stdout, /paralizer directives <subcommand>/);
});

test('T-43: `paralizer help` lists the repo-roles command', () => {
    const result = spawnSync(process.execPath, [ENTRY, 'help'], { encoding: 'utf8' });

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /^\s+repo-roles\s/m);
    assert.match(result.stdout, /paralizer repo-roles <subcommand>/);
});
