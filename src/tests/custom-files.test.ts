import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    validateCustomFileInput,
    isExecutableFile,
    applyLineEndingPolicy,
    type CustomFile,
    type CustomFileInput,
} from '../models/project/custom-file.js';
import { writeCustomFiles, removeCustomFileCopy } from '../orchestration/custom-files.js';
import { renderWorkspaceAgents, renderWorkspaceReadme, type WorkspaceIndexContext } from '../orchestration/workspace-index.js';
import { createTempDirTracker } from './test-helpers.js';

const makeTempDir = createTempDirTracker('paralizer-custom-files-test-');

function input(overrides?: Partial<CustomFileInput>): CustomFileInput {
    return {
        Directory: 'scripts',
        FileName: 'run.sh',
        Label: 'Run',
        Description: 'Runs things.',
        Content: '#!/bin/sh\necho hi\n',
        ListInAgents: false,
        ...overrides,
    };
}

function file(overrides?: Partial<CustomFile>): CustomFile {
    return { Id: 'id-1', DateModified: '2026-11-18T00:00:00.000Z', ...input(), ...overrides };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('validate: normalises directory separators and trims', () => {
    const v = validateCustomFileInput(input({ Directory: ' .\\docs\\notes\\ ', FileName: ' a.md ' }), [], []);
    assert.equal(v.Directory, 'docs/notes');
    assert.equal(v.FileName, 'a.md');
});

test('validate: empty directory targets the workspace root', () => {
    assert.equal(validateCustomFileInput(input({ Directory: '' }), [], []).Directory, '');
});

for (const bad of ['../x', 'a/../../x', '/etc', 'C:/x', 'a//b', 'a/./b', 'a/b.', 'con', 'a/b:c']) {
    test(`validate: rejects directory "${bad}"`, () => {
        assert.throws(() => validateCustomFileInput(input({ Directory: bad }), [], []));
    });
}

for (const bad of ['a/b.sh', 'a\\b.sh', '..', '.', 'x?.sh', '']) {
    test(`validate: rejects file name "${bad}"`, () => {
        assert.throws(() => validateCustomFileInput(input({ FileName: bad }), [], []));
    });
}

test('validate: rejects reserved generated root files, case-insensitively', () => {
    assert.throws(() => validateCustomFileInput(input({ Directory: '', FileName: 'agents.md' }), [], []), /generated/);
    // …but the same name in a sub-folder is fine.
    validateCustomFileInput(input({ Directory: 'docs', FileName: 'AGENTS.md' }), [], []);
});

test('validate: rejects a path inside a repository folder', () => {
    assert.throws(() => validateCustomFileInput(input({ Directory: 'Repo-A/scripts' }), ['repo-a'], []), /repository/);
    assert.throws(() => validateCustomFileInput(input({ Directory: '' }), ['run.sh'], []), /repository/);
});

test('validate: rejects duplicate path case-insensitively, allows the same name elsewhere', () => {
    assert.throws(() => validateCustomFileInput(input({ FileName: 'RUN.SH' }), [], [file()]), /already uses/);
    validateCustomFileInput(input({ Directory: 'other' }), [], [file()]);
});

test('validate: rejects oversized and NUL-containing content, requires a label', () => {
    assert.throws(() => validateCustomFileInput(input({ Content: 'x'.repeat(300 * 1024) }), [], []), /size/);
    assert.throws(() => validateCustomFileInput(input({ Content: 'a\u0000b' }), [], []), /plain text/);
    assert.throws(() => validateCustomFileInput(input({ Label: '  ' }), [], []), /Label/);
});

// ---------------------------------------------------------------------------
// Executable + line endings
// ---------------------------------------------------------------------------

test('isExecutableFile: shell extensions and shebang, not Windows scripts or docs', () => {
    assert.equal(isExecutableFile('a.sh', ''), true);
    assert.equal(isExecutableFile('A.COMMAND', ''), true);
    assert.equal(isExecutableFile('tool', '#!/usr/bin/env node\n'), true);
    assert.equal(isExecutableFile('a.bat', '@echo off'), false);
    assert.equal(isExecutableFile('a.md', '# hi'), false);
});

test('applyLineEndingPolicy: CRLF for batch, LF for shell, untouched otherwise', () => {
    assert.equal(applyLineEndingPolicy('a.bat', 'a\nb\r\nc'), 'a\r\nb\r\nc');
    assert.equal(applyLineEndingPolicy('a.sh', 'a\r\nb'), 'a\nb');
    assert.equal(applyLineEndingPolicy('a.md', 'a\r\nb\n'), 'a\r\nb\n');
});

// ---------------------------------------------------------------------------
// Writer / remover
// ---------------------------------------------------------------------------

function makeWorkspace(): { root: string; ws: string } {
    const root = makeTempDir();
    const ws = path.join(root, 'proj', 'DEV');
    fs.mkdirSync(ws, { recursive: true });
    return { root, ws };
}

test('write: creates directories, overwrites local edits, sets mode', () => {
    const { root, ws } = makeWorkspace();
    const f = file();
    const res = writeCustomFiles(root, 'proj', 'DEV', [f], []);
    assert.deepEqual(res.written, ['scripts/run.sh']);

    const target = path.join(ws, 'scripts', 'run.sh');
    fs.writeFileSync(target, 'local edit');
    writeCustomFiles(root, 'proj', 'DEV', [f], []);
    assert.equal(fs.readFileSync(target, 'utf8'), f.Content);

    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(target).mode & 0o111, 0o111);
        writeCustomFiles(root, 'proj', 'DEV', [file({ FileName: 'notes.md', Content: '# n' })], []);
        assert.equal(fs.statSync(path.join(ws, 'scripts', 'notes.md')).mode & 0o111, 0);
    }
});

test('write: no-op when the workspace folder does not exist', () => {
    const root = makeTempDir();
    const res = writeCustomFiles(root, 'proj', 'NOPE', [file()], []);
    assert.deepEqual(res, { written: [], skipped: [] });
    assert.equal(fs.existsSync(path.join(root, 'proj')), false);
});

test('write: skips repository-folder and reserved targets', () => {
    const { root, ws } = makeWorkspace();
    const res = writeCustomFiles(root, 'proj', 'DEV', [
        file({ Id: 'a', Directory: 'repo-a' }),
        file({ Id: 'b', Directory: '', FileName: 'AGENTS.md' }),
    ], ['repo-a']);
    assert.equal(res.written.length, 0);
    assert.equal(res.skipped.length, 2);
    assert.equal(fs.existsSync(path.join(ws, 'repo-a')), false);
});

test('write: a traversal that bypassed validation is still skipped', () => {
    const { root } = makeWorkspace();
    const res = writeCustomFiles(root, 'proj', 'DEV', [file({ Directory: '../..', FileName: 'pwn.txt' })], []);
    assert.deepEqual(res.written, []);
    assert.equal(fs.existsSync(path.join(root, 'pwn.txt')), false);
});

test('write: a symlinked sub-folder pointing outside the workspace is skipped', { skip: process.platform === 'win32' }, () => {
    const { root, ws } = makeWorkspace();
    const outside = makeTempDir();
    fs.symlinkSync(outside, path.join(ws, 'scripts'));
    const res = writeCustomFiles(root, 'proj', 'DEV', [file()], []);
    assert.deepEqual(res.written, []);
    assert.equal(fs.readdirSync(outside).length, 0);
});

test('remove: deletes the copy and prunes now-empty directories, keeps non-empty ones', () => {
    const { root, ws } = makeWorkspace();
    const f = file({ Directory: 'a/b' });
    writeCustomFiles(root, 'proj', 'DEV', [f], []);
    assert.equal(removeCustomFileCopy(root, 'proj', 'DEV', f), true);
    assert.equal(fs.existsSync(path.join(ws, 'a')), false);
    assert.equal(fs.existsSync(ws), true);

    writeCustomFiles(root, 'proj', 'DEV', [f], []);
    fs.writeFileSync(path.join(ws, 'a', 'keep.txt'), 'x');
    removeCustomFileCopy(root, 'proj', 'DEV', f);
    assert.equal(fs.existsSync(path.join(ws, 'a', 'keep.txt')), true);
    assert.equal(fs.existsSync(path.join(ws, 'a', 'b')), false);
});

test('remove: missing file / workspace is a silent no-op and a directory is never deleted', () => {
    const { root, ws } = makeWorkspace();
    assert.equal(removeCustomFileCopy(root, 'proj', 'DEV', file()), false);
    assert.equal(removeCustomFileCopy(root, 'proj', 'GONE', file()), false);
    fs.mkdirSync(path.join(ws, 'scripts', 'run.sh'), { recursive: true });
    assert.equal(removeCustomFileCopy(root, 'proj', 'DEV', file()), false);
    assert.equal(fs.existsSync(path.join(ws, 'scripts', 'run.sh')), true);
});

// ---------------------------------------------------------------------------
// AGENTS.md rendering
// ---------------------------------------------------------------------------

function ctx(customFiles?: WorkspaceIndexContext['customFiles']): WorkspaceIndexContext {
    return {
        projectsFolder: '/x', projectId: 'p', projectName: 'P', projectDescription: '',
        workspaceId: 'DEV', workspaceDescription: '', workspaceNotes: '', repositories: [],
        customFiles, guiUrl: 'http://localhost/', toolVersion: '1', toolRoot: '/opt/paralizer', generatedAt: 't',
    };
}

test('render: AGENTS.md lists flagged custom files, escaped, before the directives; README does not', () => {
    const agents = renderWorkspaceAgents(ctx([
        { path: 'scripts/run.sh', label: 'Run | all', description: 'Line1\nLine2' },
    ]));
    assert.match(agents, /## Custom Files/);
    assert.match(agents, /\| `scripts\/run\.sh` \| Run \\\| all \| Line1 Line2 \|/);
    assert.ok(agents.indexOf('## Custom Files') < agents.indexOf('## Agent Directives'));
    assert.doesNotMatch(renderWorkspaceReadme(ctx([{ path: 'a', label: 'b', description: '' }])), /Custom Files/);
});

test('render: no section when nothing is listed', () => {
    assert.doesNotMatch(renderWorkspaceAgents(ctx([])), /Custom Files/);
    assert.doesNotMatch(renderWorkspaceAgents(ctx(undefined)), /Custom Files/);
});
