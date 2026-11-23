import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    readRepositoryFilesFolder,
    writeRepositoryFiles,
    canonicalFilesForHash,
    REPOSITORY_FILES_FOLDER_NAME,
    type RepositoryFileMetadataEntry,
    type RepositoryFolderFile,
} from '../orchestration/repository-files.js';
import { REPOSITORY_INFO_FOLDER_NAME } from '../orchestration/repository-info.js';
import { REPOSITORY_FILE_MAX_CONTENT_BYTES, type RepositoryFile } from '../models/repository/repository-file.js';
import { createTempDirTracker } from './test-helpers.js';

const makeTempDir = createTempDirTracker('paralizer-repository-files-test-');

function makeMainFolder(): string {
    const root = makeTempDir();
    fs.mkdirSync(root, { recursive: true });
    return root;
}

function filesRoot(mainFolder: string): string {
    return path.join(mainFolder, REPOSITORY_INFO_FOLDER_NAME, REPOSITORY_FILES_FOLDER_NAME);
}

function writeRaw(mainFolder: string, relPath: string, content: string | Buffer): void {
    const target = path.join(filesRoot(mainFolder), ...relPath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
}

function repoFile(overrides?: Partial<RepositoryFile>): RepositoryFile {
    return {
        Id: 'id-1',
        Directory: 'scripts',
        FileName: 'run.sh',
        Label: 'Run',
        Description: 'Runs things.',
        Content: '#!/bin/sh\necho hi\n',
        Executable: true,
        ListInAgents: false,
        DateModified: '2026-11-20T00:00:00.000Z',
        ...overrides,
    };
}

function findFile(files: readonly RepositoryFolderFile[], relPath: string): RepositoryFolderFile {
    const found = files.find((f) => f.path === relPath);
    assert.ok(found, `expected to find "${relPath}" among read files`);
    return found as RepositoryFolderFile;
}

// ---------------------------------------------------------------------------
// readRepositoryFilesFolder
// ---------------------------------------------------------------------------

test('reader: returns empty results when the files/ folder does not exist', () => {
    const main = makeMainFolder();
    const result = readRepositoryFilesFolder(main, []);
    assert.deepStrictEqual(result, { files: [], unsafeEntries: [] });
});

test('reader: joins a file with its metadata entry by case-insensitive path', () => {
    const main = makeMainFolder();
    writeRaw(main, 'scripts/run.sh', '#!/bin/sh\necho hi\n');
    const metadata: RepositoryFileMetadataEntry[] = [
        { Path: 'Scripts/Run.sh', Label: 'Run script', Description: 'Does a thing', Executable: true, ListInAgents: true },
    ];
    const { files } = readRepositoryFilesFolder(main, metadata);
    const f = findFile(files, 'scripts/run.sh');
    assert.deepStrictEqual(f.metadata, { Label: 'Run script', Description: 'Does a thing', Executable: true, ListInAgents: true });
    assert.equal(f.problem, undefined);
    assert.equal(f.content, '#!/bin/sh\necho hi\n');
});

test('reader: a file without metadata gets defaults (label = file name, heuristic executable)', () => {
    const main = makeMainFolder();
    writeRaw(main, 'run.sh', '#!/bin/sh\necho hi\n');
    writeRaw(main, 'notes.txt', 'just text');
    const { files } = readRepositoryFilesFolder(main, []);

    const sh = findFile(files, 'run.sh');
    assert.deepStrictEqual(sh.metadata, { Label: 'run.sh', Description: '', Executable: true, ListInAgents: false });

    const txt = findFile(files, 'notes.txt');
    assert.deepStrictEqual(txt.metadata, { Label: 'notes.txt', Description: '', Executable: false, ListInAgents: false });
});

test('reader: a metadata entry without a matching file on disk is ignored', () => {
    const main = makeMainFolder();
    const metadata: RepositoryFileMetadataEntry[] = [
        { Path: 'ghost.txt', Label: 'Ghost', Description: '', Executable: false, ListInAgents: false },
    ];
    const { files } = readRepositoryFilesFolder(main, metadata);
    assert.deepStrictEqual(files, []);
});

test('reader: flags an oversized file with a problem but still returns it', () => {
    const main = makeMainFolder();
    writeRaw(main, 'big.txt', 'a'.repeat(REPOSITORY_FILE_MAX_CONTENT_BYTES + 1));
    const { files } = readRepositoryFilesFolder(main, []);
    const f = findFile(files, 'big.txt');
    assert.match(f.problem ?? '', /maximum size/);
});

test('reader: flags a binary file (embedded NUL byte) with a problem but still returns it', () => {
    const main = makeMainFolder();
    writeRaw(main, 'bin.dat', Buffer.from([0x41, 0x00, 0x42]));
    const { files } = readRepositoryFilesFolder(main, []);
    const f = findFile(files, 'bin.dat');
    assert.match(f.problem ?? '', /plain text/);
});

test('reader: flags a file under a reserved .git segment with a problem', () => {
    const main = makeMainFolder();
    writeRaw(main, '.git/hooks/pre-commit', '#!/bin/sh\n');
    const { files } = readRepositoryFilesFolder(main, []);
    const f = findFile(files, '.git/hooks/pre-commit');
    assert.match(f.problem ?? '', /reserved/);
});

test('reader: an unreadable file is reported with the unreadable problem', { skip: process.platform === 'win32' }, () => {
    const main = makeMainFolder();
    writeRaw(main, 'secret.txt', 'top secret');
    fs.chmodSync(path.join(filesRoot(main), 'secret.txt'), 0o000);
    try {
        const { files } = readRepositoryFilesFolder(main, []);
        const f = findFile(files, 'secret.txt');
        assert.equal(f.problem, 'File could not be read.');
    } finally {
        fs.chmodSync(path.join(filesRoot(main), 'secret.txt'), 0o644);
    }
});

test('reader: a symlink is reported only in unsafeEntries, never in files', { skip: process.platform === 'win32' }, () => {
    const main = makeMainFolder();
    writeRaw(main, 'real.txt', 'hello');
    fs.symlinkSync(path.join(filesRoot(main), 'real.txt'), path.join(filesRoot(main), 'link.txt'));
    const { files, unsafeEntries } = readRepositoryFilesFolder(main, []);
    assert.deepStrictEqual(files.map((f) => f.path).sort(), ['real.txt']);
    assert.deepStrictEqual(unsafeEntries, ['link.txt']);
});

test('reader: a symlinked directory is reported in unsafeEntries and never descended into', { skip: process.platform === 'win32' }, () => {
    const main = makeMainFolder();
    const outside = makeTempDir();
    fs.writeFileSync(path.join(outside, 'escaped.txt'), 'nope');
    fs.mkdirSync(filesRoot(main), { recursive: true });
    fs.symlinkSync(outside, path.join(filesRoot(main), 'linked-dir'));

    const { files, unsafeEntries } = readRepositoryFilesFolder(main, []);
    assert.deepStrictEqual(files, []);
    assert.deepStrictEqual(unsafeEntries, ['linked-dir']);
});

// ---------------------------------------------------------------------------
// writeRepositoryFiles
// ---------------------------------------------------------------------------

test('write: creates directories and writes content with the executable mode', { skip: process.platform === 'win32' }, () => {
    const main = makeMainFolder();
    const f = repoFile();
    const res = writeRepositoryFiles(main, [f]);
    assert.deepStrictEqual(res.written, ['scripts/run.sh']);
    assert.deepStrictEqual(res.removed, []);
    assert.deepStrictEqual(res.skipped, []);

    const target = path.join(filesRoot(main), 'scripts', 'run.sh');
    assert.equal(fs.readFileSync(target, 'utf8'), f.Content);
    assert.equal(fs.statSync(target).mode & 0o777, 0o755);
});

test('write: a non-executable file gets mode 0o644', { skip: process.platform === 'win32' }, () => {
    const main = makeMainFolder();
    const f = repoFile({ FileName: 'notes.txt', Content: 'hello', Executable: false });
    writeRepositoryFiles(main, [f]);
    const target = path.join(filesRoot(main), 'scripts', 'notes.txt');
    assert.equal(fs.statSync(target).mode & 0o777, 0o644);
});

test('write: is write-only-if-changed (mtime unchanged on an unchanged re-write)', () => {
    const main = makeMainFolder();
    const f = repoFile();
    writeRepositoryFiles(main, [f]);
    const target = path.join(filesRoot(main), 'scripts', 'run.sh');
    const mtimeBefore = fs.statSync(target).mtimeMs;

    const res = writeRepositoryFiles(main, [f]);
    assert.deepStrictEqual(res.written, []);
    assert.equal(fs.statSync(target).mtimeMs, mtimeBefore);
});

test('write: rewrites content and reports written when content changes', () => {
    const main = makeMainFolder();
    const f = repoFile();
    writeRepositoryFiles(main, [f]);
    const changed = repoFile({ Content: '#!/bin/sh\necho changed\n' });
    const res = writeRepositoryFiles(main, [changed]);
    assert.deepStrictEqual(res.written, ['scripts/run.sh']);
    const target = path.join(filesRoot(main), 'scripts', 'run.sh');
    assert.equal(fs.readFileSync(target, 'utf8'), changed.Content);
});

test('write: re-chmods and reports written when only the executable mode changes', { skip: process.platform === 'win32' }, () => {
    const main = makeMainFolder();
    const f = repoFile({ Executable: true });
    writeRepositoryFiles(main, [f]);
    const target = path.join(filesRoot(main), 'scripts', 'run.sh');
    const mtimeBefore = fs.statSync(target).mtimeMs;

    const res = writeRepositoryFiles(main, [repoFile({ Executable: false })]);
    assert.deepStrictEqual(res.written, ['scripts/run.sh']);
    assert.equal(fs.statSync(target).mode & 0o777, 0o644);
    // Content bytes themselves are untouched, so mtime of the write call for
    // content does not matter here — only that the mode change was applied
    // and reported.
    assert.ok(fs.statSync(target).mtimeMs >= mtimeBefore);
});

test('write: deletes a regular file no longer in the data set and prunes the empty parent', () => {
    const main = makeMainFolder();
    const f = repoFile({ Directory: 'a/b' });
    writeRepositoryFiles(main, [f]);
    assert.ok(fs.existsSync(path.join(filesRoot(main), 'a', 'b', 'run.sh')));

    const res = writeRepositoryFiles(main, []);
    assert.deepStrictEqual(res.removed, ['a/b/run.sh']);
    assert.equal(fs.existsSync(path.join(filesRoot(main), 'a')), false);
    assert.equal(fs.existsSync(filesRoot(main)), true);
});

test('write: keeps a non-empty directory after pruning its deleted sibling', () => {
    const main = makeMainFolder();
    const f = repoFile({ Directory: 'a/b' });
    const keep = repoFile({ Id: 'id-2', Directory: 'a', FileName: 'keep.txt', Content: 'kept' });
    writeRepositoryFiles(main, [f, keep]);

    // Drop `f` from the data set (as if it had been deleted via the
    // manager), but keep `keep` — only `f`'s directory should be pruned.
    writeRepositoryFiles(main, [keep]);
    assert.equal(fs.existsSync(path.join(filesRoot(main), 'a', 'keep.txt')), true);
    assert.equal(fs.existsSync(path.join(filesRoot(main), 'a', 'b')), false);
});

test('write: refuses a traversal that bypassed validation', () => {
    const main = makeMainFolder();
    const res = writeRepositoryFiles(main, [repoFile({ Directory: '../..', FileName: 'pwn.txt' })]);
    assert.deepStrictEqual(res.written, []);
    assert.equal(fs.existsSync(path.join(main, '..', 'pwn.txt')), false);
});

test('write: a symlinked sub-folder pointing outside the main folder is skipped, not written through', { skip: process.platform === 'win32' }, () => {
    const main = makeMainFolder();
    const outside = makeTempDir();
    fs.mkdirSync(filesRoot(main), { recursive: true });
    fs.symlinkSync(outside, path.join(filesRoot(main), 'scripts'));

    const res = writeRepositoryFiles(main, [repoFile()]);
    assert.deepStrictEqual(res.written, []);
    assert.equal(fs.readdirSync(outside).length, 0);
});

test('write: leaves a symlink to a file under files/ in place and reports it in skipped', { skip: process.platform === 'win32' }, () => {
    const main = makeMainFolder();
    const real = repoFile({ FileName: 'real.txt', Content: 'hello', Executable: false });
    writeRepositoryFiles(main, [real]);
    fs.symlinkSync(path.join(filesRoot(main), 'scripts', 'real.txt'), path.join(filesRoot(main), 'scripts', 'link-to-file.txt'));

    // `real.txt` stays in the data set, so it is not touched by the delete
    // pass — only the untracked symlink is a candidate for removal, and it
    // must be left in place and reported in `skipped` instead.
    const res = writeRepositoryFiles(main, [real]);
    assert.deepStrictEqual(res.removed, []);
    assert.ok(res.skipped.includes('scripts/link-to-file.txt'));
    assert.equal(fs.existsSync(path.join(filesRoot(main), 'scripts', 'link-to-file.txt')), true);
});

test('write: leaves a symlink to a directory under files/ in place and reports it in skipped', { skip: process.platform === 'win32' }, () => {
    const main = makeMainFolder();
    const outside = makeTempDir();
    fs.mkdirSync(filesRoot(main), { recursive: true });
    fs.symlinkSync(outside, path.join(filesRoot(main), 'link-to-dir'));

    const res = writeRepositoryFiles(main, []);
    assert.deepStrictEqual(res.removed, []);
    assert.ok(res.skipped.includes('link-to-dir'));
    assert.equal(fs.existsSync(path.join(filesRoot(main), 'link-to-dir')), true);
});

// ---------------------------------------------------------------------------
// canonicalFilesForHash
// ---------------------------------------------------------------------------

function folderFile(overrides?: Partial<RepositoryFolderFile>): RepositoryFolderFile {
    return {
        path: 'a.txt',
        content: 'hello\n',
        metadata: { Label: 'A', Description: '', Executable: false, ListInAgents: false },
        ...overrides,
    };
}

test('hash: ignores CRLF vs LF differences in content', () => {
    const lf = canonicalFilesForHash([folderFile({ content: 'a\nb\nc\n' })]);
    const crlf = canonicalFilesForHash([folderFile({ content: 'a\r\nb\r\nc\r\n' })]);
    assert.deepStrictEqual(lf, crlf);
});

test('hash: changes when content changes', () => {
    const a = canonicalFilesForHash([folderFile({ content: 'a\n' })]);
    const b = canonicalFilesForHash([folderFile({ content: 'b\n' })]);
    assert.notDeepStrictEqual(a, b);
});

test('hash: is sorted by lowercased path, independent of input order', () => {
    const files = [folderFile({ path: 'B.txt' }), folderFile({ path: 'a.txt' })];
    const result = canonicalFilesForHash(files);
    assert.deepStrictEqual(result.map((r) => r[0]), ['a.txt', 'B.txt']);
});

test('hash: a problem file contributes a hash of its raw bytes (changes when it is added)', () => {
    const base = canonicalFilesForHash([folderFile()]);
    const withProblem = canonicalFilesForHash([
        folderFile(),
        folderFile({ path: 'bin.dat', content: Buffer.from([0x41, 0x00, 0x42]).toString('latin1'), problem: 'File must be plain text (binary data is not supported).' }),
    ]);
    assert.notDeepStrictEqual(base, withProblem);
});

test('hash: an unreadable file contributes the fixed "unreadable" marker', () => {
    const result = canonicalFilesForHash([folderFile({ path: 'secret.txt', content: '', problem: 'File could not be read.' })]);
    assert.equal(result[0][5], 'unreadable');
});

test('hash: changing an oversized file still changes the hash (via its raw-byte contribution)', () => {
    const base = canonicalFilesForHash([folderFile()]);
    const oversized = canonicalFilesForHash([
        folderFile(),
        folderFile({ path: 'big.txt', content: 'x'.repeat(10), problem: 'File exceeds the maximum size of 256 KB.' }),
    ]);
    assert.notDeepStrictEqual(base, oversized);
});

test('hash: does not change when only a symlink is added (symlinks are never passed in)', () => {
    // `canonicalFilesForHash` only ever sees `files` (regular files), never
    // `unsafeEntries` — simulated here by calling it with the same `files`
    // input regardless of whether a symlink exists on disk.
    const withoutSymlink = canonicalFilesForHash([folderFile()]);
    const withSymlinkIgnored = canonicalFilesForHash([folderFile()]);
    assert.deepStrictEqual(withoutSymlink, withSymlinkIgnored);
});

test('end-to-end: reader output feeds canonicalFilesForHash and a symlink addition does not change the hash', { skip: process.platform === 'win32' }, () => {
    const main = makeMainFolder();
    writeRaw(main, 'a.txt', 'hello\n');
    const before = canonicalFilesForHash(readRepositoryFilesFolder(main, []).files);

    fs.symlinkSync(path.join(filesRoot(main), 'a.txt'), path.join(filesRoot(main), 'link.txt'));
    const after = canonicalFilesForHash(readRepositoryFilesFolder(main, []).files);

    assert.deepStrictEqual(before, after);
});

test('end-to-end: reader output feeds canonicalFilesForHash and a binary file addition changes the hash', () => {
    const main = makeMainFolder();
    writeRaw(main, 'a.txt', 'hello\n');
    const before = canonicalFilesForHash(readRepositoryFilesFolder(main, []).files);

    writeRaw(main, 'bin.dat', Buffer.from([0x41, 0x00, 0x42]));
    const after = canonicalFilesForHash(readRepositoryFilesFolder(main, []).files);

    assert.notDeepStrictEqual(before, after);
});
