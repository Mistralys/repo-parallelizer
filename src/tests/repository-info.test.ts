import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
    REPOSITORY_INFO_FOLDER_NAME,
    REPOSITORY_INFO_FILE_NAME,
    REPOSITORY_INFO_README_FILE_NAME,
    REPOSITORY_INFO_SCHEMA_VERSION,
    buildRepositoryInfoPayload,
    buildInformationalUrl,
    hashRepositoryInfoPayload,
    readRepositoryInfoFile,
    renderRepositoryInfoFile,
    renderRepositoryInfoReadme,
    evaluateRepositoryInfoSync,
    diffRepositoryInfo,
    diffRepositoryFiles,
    defaultFileImportAction,
    resolveFileImportAction,
    writeRepositoryInfoFile,
    writeRepositoryInfoReadme,
    infoFolderPathspec,
    type RepositoryInfoPayload,
    type RepositoryInfoReadResult,
    type RepositoryInfoFileEntry,
    type RepositoryFileDiff,
} from '../orchestration/repository-info.js';
import type { RepositoryFileHashEntry } from '../orchestration/repository-files.js';
import type { Repository } from '../models/repository/repository.types.js';
import { createTempDirTracker } from './test-helpers.js';

const makeTempDir = createTempDirTracker('paralizer-repo-info-test-');

function makeRepo(overrides: Partial<Repository> = {}): Repository {
    return {
        Id: 'my-repo',
        Name: 'My Repo',
        Url: 'https://github.com/org/my-repo.git',
        ...overrides,
    };
}

function infoFolder(mainFolder: string): string {
    return path.join(mainFolder, REPOSITORY_INFO_FOLDER_NAME);
}

function infoFile(mainFolder: string): string {
    return path.join(infoFolder(mainFolder), REPOSITORY_INFO_FILE_NAME);
}

function readmeFile(mainFolder: string): string {
    return path.join(infoFolder(mainFolder), REPOSITORY_INFO_README_FILE_NAME);
}

// ─── buildRepositoryInfoPayload() / buildInformationalUrl() ──────────────────

test('buildRepositoryInfoPayload() returns Id/Name/Description/Files=[], empty string for an absent description', () => {
    const payload = buildRepositoryInfoPayload(makeRepo());
    assert.deepEqual(payload, { Id: 'my-repo', Name: 'My Repo', Description: '', Files: [] });
});

test('buildRepositoryInfoPayload() uses the repository Description when set', () => {
    const payload = buildRepositoryInfoPayload(makeRepo({ Description: 'A short description' }));
    assert.equal(payload.Description, 'A short description');
});

test('buildInformationalUrl() strips embedded credentials from the registered Url', () => {
    const url = buildInformationalUrl(makeRepo({ Url: 'https://token@github.com/org/my-repo.git' }));
    assert.equal(url, 'https://github.com/org/my-repo.git');
});

// ─── hashRepositoryInfoPayload() — AC-02b ────────────────────────────────────

test('hashRepositoryInfoPayload() is stable for identical payloads', () => {
    const a = hashRepositoryInfoPayload({ Id: 'x', Name: 'Y', Description: 'Z' });
    const b = hashRepositoryInfoPayload({ Id: 'x', Name: 'Y', Description: 'Z' });
    assert.equal(a, b);
});

test('hashRepositoryInfoPayload() changes when Name changes', () => {
    const a = hashRepositoryInfoPayload({ Id: 'x', Name: 'Y', Description: 'Z' });
    const b = hashRepositoryInfoPayload({ Id: 'x', Name: 'Y2', Description: 'Z' });
    assert.notEqual(a, b);
});

test('hashRepositoryInfoPayload() does not take Url into account (it is not part of the payload type)', () => {
    // RepositoryInfoPayload has no Url field at all — this test documents
    // that the hash is computed purely from Id/Name/Description.
    const payload: RepositoryInfoPayload = { Id: 'x', Name: 'Y', Description: 'Z' };
    const json = JSON.stringify([payload.Id, payload.Name, payload.Description]);
    const expected = crypto.createHash('sha256').update(json).digest('hex');
    assert.equal(hashRepositoryInfoPayload(payload), expected);
});

// ─── readRepositoryInfoFile() — AC-08 ────────────────────────────────────────

test('readRepositoryInfoFile() returns absent when the file does not exist', () => {
    const mainFolder = makeTempDir();
    const result = readRepositoryInfoFile(mainFolder);
    assert.deepEqual(result, { status: 'absent' });
});

test('readRepositoryInfoFile() returns ok with the parsed payload for a valid file', () => {
    const mainFolder = makeTempDir();
    fs.mkdirSync(infoFolder(mainFolder), { recursive: true });
    fs.writeFileSync(
        infoFile(mainFolder),
        JSON.stringify({ SchemaVersion: 1, Id: 'my-repo', Name: 'My Repo', Url: 'https://x', Description: 'D', Settings: {} }),
    );

    const result = readRepositoryInfoFile(mainFolder);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.payload, { Id: 'my-repo', Name: 'My Repo', Description: 'D', Files: [] });
});

test('readRepositoryInfoFile() returns invalid for unparseable JSON', () => {
    const mainFolder = makeTempDir();
    fs.mkdirSync(infoFolder(mainFolder), { recursive: true });
    fs.writeFileSync(infoFile(mainFolder), '{ not valid json');

    const result = readRepositoryInfoFile(mainFolder);
    assert.equal(result.status, 'invalid');
    assert.ok(result.error);
});

test('readRepositoryInfoFile() returns invalid for a non-object JSON value', () => {
    const mainFolder = makeTempDir();
    fs.mkdirSync(infoFolder(mainFolder), { recursive: true });
    fs.writeFileSync(infoFile(mainFolder), '[1, 2, 3]');

    const result = readRepositoryInfoFile(mainFolder);
    assert.equal(result.status, 'invalid');
});

test('readRepositoryInfoFile() returns invalid when Id/Name/Description are missing or non-string', () => {
    const mainFolder = makeTempDir();
    fs.mkdirSync(infoFolder(mainFolder), { recursive: true });
    fs.writeFileSync(infoFile(mainFolder), JSON.stringify({ SchemaVersion: 1, Id: 'repo', Name: 123, Description: 'D' }));

    const result = readRepositoryInfoFile(mainFolder);
    assert.equal(result.status, 'invalid');
});

test('readRepositoryInfoFile() returns unsupported-schema for a SchemaVersion above the current one', () => {
    const mainFolder = makeTempDir();
    fs.mkdirSync(infoFolder(mainFolder), { recursive: true });
    fs.writeFileSync(
        infoFile(mainFolder),
        JSON.stringify({ SchemaVersion: REPOSITORY_INFO_SCHEMA_VERSION + 1, Id: 'my-repo', Name: 'My Repo', Description: 'D' }),
    );

    const result = readRepositoryInfoFile(mainFolder);
    assert.equal(result.status, 'unsupported-schema');
});

test('readRepositoryInfoFile() tolerates a missing Url field', () => {
    const mainFolder = makeTempDir();
    fs.mkdirSync(infoFolder(mainFolder), { recursive: true });
    fs.writeFileSync(infoFile(mainFolder), JSON.stringify({ SchemaVersion: 1, Id: 'my-repo', Name: 'My Repo', Description: 'D' }));

    const result = readRepositoryInfoFile(mainFolder);
    assert.equal(result.status, 'ok');
});

test('readRepositoryInfoFile() tolerates a non-string Url field', () => {
    const mainFolder = makeTempDir();
    fs.mkdirSync(infoFolder(mainFolder), { recursive: true });
    fs.writeFileSync(infoFile(mainFolder), JSON.stringify({ SchemaVersion: 1, Id: 'my-repo', Name: 'My Repo', Url: 42, Description: 'D' }));

    const result = readRepositoryInfoFile(mainFolder);
    assert.equal(result.status, 'ok');
});

// ─── renderRepositoryInfoFile() — AC-02 ──────────────────────────────────────

test('renderRepositoryInfoFile() produces exactly SchemaVersion/Id/Name/Url/Description/Settings/Files for a fresh file', () => {
    const payload: RepositoryInfoPayload = { Id: 'my-repo', Name: 'My Repo', Description: 'D' };
    const content = renderRepositoryInfoFile(payload, 'https://github.com/org/my-repo.git');
    const parsed = JSON.parse(content);

    assert.deepEqual(
        Object.keys(parsed).sort(),
        ['Description', 'Files', 'Id', 'Name', 'Settings', 'SchemaVersion', 'Url'].sort(),
    );
    assert.equal(parsed.SchemaVersion, REPOSITORY_INFO_SCHEMA_VERSION);
    assert.equal(parsed.Id, 'my-repo');
    assert.equal(parsed.Name, 'My Repo');
    assert.equal(parsed.Url, 'https://github.com/org/my-repo.git');
    assert.equal(parsed.Description, 'D');
    assert.deepEqual(parsed.Settings, {});
    assert.deepEqual(parsed.Files, []);
});

test('renderRepositoryInfoFile() never contains a token, CredentialId or machine-local setting', () => {
    const payload: RepositoryInfoPayload = { Id: 'my-repo', Name: 'My Repo', Description: 'D' };
    const content = renderRepositoryInfoFile(payload, 'https://github.com/org/my-repo.git');
    assert.ok(!content.includes('CredentialId'));
    assert.ok(!content.includes('LastWrittenHash'));
    assert.ok(!content.includes('LastSyncedAt'));
});

test('renderRepositoryInfoFile() uses 4-space indentation and a trailing newline', () => {
    const payload: RepositoryInfoPayload = { Id: 'x', Name: 'Y', Description: 'Z' };
    const content = renderRepositoryInfoFile(payload, 'https://x');
    assert.ok(content.endsWith('\n'), 'expected a trailing newline');
    assert.ok(content.includes('\n    "Id"'), `expected 4-space indentation, got: ${JSON.stringify(content)}`);
});

test('renderRepositoryInfoFile() preserves unknown top-level keys from existingRaw', () => {
    const payload: RepositoryInfoPayload = { Id: 'x', Name: 'Y', Description: 'Z' };
    const existingRaw = {
        SchemaVersion: 1, Id: 'x', Name: 'old', Url: 'https://old', Description: 'old', Settings: {},
        FutureTopLevelKey: 'preserve-me',
    };
    const content = renderRepositoryInfoFile(payload, 'https://x', existingRaw);
    const parsed = JSON.parse(content);
    assert.equal(parsed.FutureTopLevelKey, 'preserve-me');
});

test('renderRepositoryInfoFile() preserves unknown Settings keys from existingRaw', () => {
    const payload: RepositoryInfoPayload = { Id: 'x', Name: 'Y', Description: 'Z' };
    const existingRaw = {
        SchemaVersion: 1, Id: 'x', Name: 'old', Url: 'https://old', Description: 'old',
        Settings: { futureSetting: true },
    };
    const content = renderRepositoryInfoFile(payload, 'https://x', existingRaw);
    const parsed = JSON.parse(content);
    assert.deepEqual(parsed.Settings, { futureSetting: true });
});

test('renderRepositoryInfoFile() always writes Url from informationalUrl, ignoring existingRaw.Url', () => {
    const payload: RepositoryInfoPayload = { Id: 'x', Name: 'Y', Description: 'Z' };
    const existingRaw = { SchemaVersion: 1, Id: 'x', Name: 'Y', Url: 'https://stale', Description: 'Z', Settings: {} };
    const content = renderRepositoryInfoFile(payload, 'https://fresh', existingRaw);
    const parsed = JSON.parse(content);
    assert.equal(parsed.Url, 'https://fresh');
});

// ─── evaluateRepositoryInfoSync() — AC-07, decision table ────────────────────

function okFolder(payload: RepositoryInfoPayload): RepositoryInfoReadResult {
    return { status: 'ok', payload, raw: { SchemaVersion: 1, ...payload, Settings: {} } };
}

test('evaluateRepositoryInfoSync(): absent folder -> write-required', () => {
    const state = evaluateRepositoryInfoSync({
        dataHash: 'h', folder: { status: 'absent' }, repositoryId: 'repo',
    });
    assert.equal(state, 'write-required');
});

test('evaluateRepositoryInfoSync(): invalid folder -> invalid-file', () => {
    const state = evaluateRepositoryInfoSync({
        dataHash: 'h', folder: { status: 'invalid', error: 'bad' }, repositoryId: 'repo',
    });
    assert.equal(state, 'invalid-file');
});

test('evaluateRepositoryInfoSync(): unsupported-schema folder -> unsupported-schema', () => {
    const state = evaluateRepositoryInfoSync({
        dataHash: 'h', folder: { status: 'unsupported-schema' }, repositoryId: 'repo',
    });
    assert.equal(state, 'unsupported-schema');
});

test('evaluateRepositoryInfoSync(): Id mismatch -> id-mismatch', () => {
    const payload: RepositoryInfoPayload = { Id: 'other-repo', Name: 'N', Description: 'D' };
    const state = evaluateRepositoryInfoSync({
        dataHash: hashRepositoryInfoPayload(payload), folder: okFolder(payload), repositoryId: 'repo',
    });
    assert.equal(state, 'id-mismatch');
});

test('evaluateRepositoryInfoSync(): folderHash = dataHash -> in-sync', () => {
    const payload: RepositoryInfoPayload = { Id: 'repo', Name: 'N', Description: 'D' };
    const state = evaluateRepositoryInfoSync({
        dataHash: hashRepositoryInfoPayload(payload), folder: okFolder(payload), repositoryId: 'repo',
    });
    assert.equal(state, 'in-sync');
});

test('evaluateRepositoryInfoSync(): differing hashes, no baseline -> conflict', () => {
    const folderPayload: RepositoryInfoPayload = { Id: 'repo', Name: 'Folder Name', Description: 'D' };
    const dataHash = hashRepositoryInfoPayload({ Id: 'repo', Name: 'Data Name', Description: 'D' });
    const state = evaluateRepositoryInfoSync({
        dataHash, folder: okFolder(folderPayload), repositoryId: 'repo',
    });
    assert.equal(state, 'conflict');
});

test('evaluateRepositoryInfoSync(): folder = baseline, data != baseline -> write-required (local edit)', () => {
    const baselinePayload: RepositoryInfoPayload = { Id: 'repo', Name: 'Baseline Name', Description: 'D' };
    const baselineHash = hashRepositoryInfoPayload(baselinePayload);
    const dataHash = hashRepositoryInfoPayload({ Id: 'repo', Name: 'New Name', Description: 'D' });

    const state = evaluateRepositoryInfoSync({
        dataHash, folder: okFolder(baselinePayload), lastWrittenHash: baselineHash, repositoryId: 'repo',
    });
    assert.equal(state, 'write-required');
});

test('evaluateRepositoryInfoSync(): folder != baseline, data = baseline -> incoming', () => {
    const baselinePayload: RepositoryInfoPayload = { Id: 'repo', Name: 'Baseline Name', Description: 'D' };
    const baselineHash = hashRepositoryInfoPayload(baselinePayload);
    const folderPayload: RepositoryInfoPayload = { Id: 'repo', Name: 'Upstream Name', Description: 'D' };

    const state = evaluateRepositoryInfoSync({
        dataHash: baselineHash, folder: okFolder(folderPayload), lastWrittenHash: baselineHash, repositoryId: 'repo',
    });
    assert.equal(state, 'incoming');
});

test('evaluateRepositoryInfoSync(): folder != baseline, data != baseline -> conflict', () => {
    const baselinePayload: RepositoryInfoPayload = { Id: 'repo', Name: 'Baseline Name', Description: 'D' };
    const baselineHash = hashRepositoryInfoPayload(baselinePayload);
    const folderPayload: RepositoryInfoPayload = { Id: 'repo', Name: 'Upstream Name', Description: 'D' };
    const dataHash = hashRepositoryInfoPayload({ Id: 'repo', Name: 'Local Name', Description: 'D' });

    const state = evaluateRepositoryInfoSync({
        dataHash, folder: okFolder(folderPayload), lastWrittenHash: baselineHash, repositoryId: 'repo',
    });
    assert.equal(state, 'conflict');
});

test('evaluateRepositoryInfoSync(): an Url-only difference evaluates as in-sync (AC-02b)', () => {
    // The hash excludes Url entirely, so folder/data payloads with identical
    // Id/Name/Description but a conceptually different Url still hash equal.
    const payload: RepositoryInfoPayload = { Id: 'repo', Name: 'N', Description: 'D' };
    const dataHash = hashRepositoryInfoPayload(payload);
    const state = evaluateRepositoryInfoSync({ dataHash, folder: okFolder(payload), repositoryId: 'repo' });
    assert.equal(state, 'in-sync');
});

// ─── diffRepositoryInfo() — AC-02b ────────────────────────────────────────────

test('diffRepositoryInfo() reports only differing fields', () => {
    const current: RepositoryInfoPayload = { Id: 'repo', Name: 'A', Description: 'Same' };
    const incoming: RepositoryInfoPayload = { Id: 'repo', Name: 'B', Description: 'Same' };
    const diffs = diffRepositoryInfo(current, incoming);
    assert.deepEqual(diffs, [{ field: 'Name', current: 'A', incoming: 'B' }]);
});

test('diffRepositoryInfo() never includes Url in the diff (payload has no Url field)', () => {
    const current: RepositoryInfoPayload = { Id: 'repo', Name: 'A', Description: 'D' };
    const incoming: RepositoryInfoPayload = { Id: 'repo', Name: 'A', Description: 'D' };
    const diffs = diffRepositoryInfo(current, incoming);
    const hasUrlField = diffs.some((d) => (d.field as string) === 'Url');
    assert.equal(diffs.length, 0);
    assert.equal(hasUrlField, false);
});

// ─── writeRepositoryInfoFile() — AC-06 ────────────────────────────────────────

test('writeRepositoryInfoFile() writes the file on first call', () => {
    const mainFolder = makeTempDir();
    const content = renderRepositoryInfoFile({ Id: 'repo', Name: 'N', Description: 'D' }, 'https://x');
    const result = writeRepositoryInfoFile(mainFolder, content);
    assert.deepEqual(result, { written: true });
    assert.equal(fs.readFileSync(infoFile(mainFolder), 'utf8'), content);
});

test('writeRepositoryInfoFile() does not rewrite (mtime unchanged) when content is identical', async () => {
    const mainFolder = makeTempDir();
    const content = renderRepositoryInfoFile({ Id: 'repo', Name: 'N', Description: 'D' }, 'https://x');
    writeRepositoryInfoFile(mainFolder, content);
    const mtimeBefore = fs.statSync(infoFile(mainFolder)).mtimeMs;

    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = writeRepositoryInfoFile(mainFolder, content);

    assert.deepEqual(result, { written: false });
    assert.equal(fs.statSync(infoFile(mainFolder)).mtimeMs, mtimeBefore);
});

test('writeRepositoryInfoFile() rewrites when content differs', () => {
    const mainFolder = makeTempDir();
    const contentA = renderRepositoryInfoFile({ Id: 'repo', Name: 'A', Description: 'D' }, 'https://x');
    const contentB = renderRepositoryInfoFile({ Id: 'repo', Name: 'B', Description: 'D' }, 'https://x');
    writeRepositoryInfoFile(mainFolder, contentA);
    const result = writeRepositoryInfoFile(mainFolder, contentB);
    assert.deepEqual(result, { written: true });
    assert.equal(fs.readFileSync(infoFile(mainFolder), 'utf8'), contentB);
});

test('writeRepositoryInfoFile() rejects an info folder symlinked outside the main folder', { skip: process.platform === 'win32' }, () => {
    const mainFolder = makeTempDir();
    const outsideTarget = makeTempDir();
    fs.symlinkSync(outsideTarget, infoFolder(mainFolder), 'dir');

    const content = renderRepositoryInfoFile({ Id: 'repo', Name: 'N', Description: 'D' }, 'https://x');
    const result = writeRepositoryInfoFile(mainFolder, content);

    assert.deepEqual(result, { written: false });
    assert.strictEqual(fs.existsSync(path.join(outsideTarget, REPOSITORY_INFO_FILE_NAME)), false);
});

// ─── writeRepositoryInfoReadme() — AC-02a ─────────────────────────────────────

test('writeRepositoryInfoReadme() writes the fixed, deterministic README text', () => {
    const mainFolder = makeTempDir();
    const result = writeRepositoryInfoReadme(mainFolder);
    assert.deepEqual(result, { written: true });
    const written = fs.readFileSync(readmeFile(mainFolder), 'utf8');
    assert.equal(written, renderRepositoryInfoReadme());
});

test('writeRepositoryInfoReadme() restores a hand-edited README on the next write', () => {
    const mainFolder = makeTempDir();
    writeRepositoryInfoReadme(mainFolder);
    fs.writeFileSync(readmeFile(mainFolder), 'hand-edited content\n');

    const result = writeRepositoryInfoReadme(mainFolder);
    assert.deepEqual(result, { written: true });
    assert.equal(fs.readFileSync(readmeFile(mainFolder), 'utf8'), renderRepositoryInfoReadme());
});

test('writeRepositoryInfoReadme() does not rewrite when content is already the rendered text', () => {
    const mainFolder = makeTempDir();
    writeRepositoryInfoReadme(mainFolder);
    const result = writeRepositoryInfoReadme(mainFolder);
    assert.deepEqual(result, { written: false });
});

test('writeRepositoryInfoReadme() rejects an info folder symlinked outside the main folder', { skip: process.platform === 'win32' }, () => {
    const mainFolder = makeTempDir();
    const outsideTarget = makeTempDir();
    fs.symlinkSync(outsideTarget, infoFolder(mainFolder), 'dir');

    const result = writeRepositoryInfoReadme(mainFolder);

    assert.deepEqual(result, { written: false });
    assert.strictEqual(fs.existsSync(path.join(outsideTarget, REPOSITORY_INFO_README_FILE_NAME)), false);
});

// ─── renderRepositoryInfoReadme() — AC-02a ────────────────────────────────────

test('renderRepositoryInfoReadme() is deterministic across calls', () => {
    assert.equal(renderRepositoryInfoReadme(), renderRepositoryInfoReadme());
});

test('renderRepositoryInfoReadme() contains no absolute path', () => {
    const content = renderRepositoryInfoReadme();
    // A POSIX absolute path segment or a Windows drive-letter path would
    // indicate machine-specific content leaking into the generated text.
    assert.ok(!/\/(Users|home|var|private)\//.test(content), `README unexpectedly contains an absolute path: ${content}`);
    assert.ok(!/^[A-Za-z]:\\/m.test(content), `README unexpectedly contains a Windows absolute path: ${content}`);
});

test('renderRepositoryInfoReadme() mentions the workspace AGENTS.md', () => {
    assert.ok(renderRepositoryInfoReadme().includes('AGENTS.md'));
});

// ─── infoFolderPathspec() ─────────────────────────────────────────────────────

test('infoFolderPathspec() returns the folder name with a trailing slash', () => {
    assert.equal(infoFolderPathspec(), `${REPOSITORY_INFO_FOLDER_NAME}/`);
});

// ─── Milestone 2: Files — buildRepositoryInfoPayload() / hashRepositoryInfoPayload() compatibility rule ──

function fileEntry(overrides: Partial<RepositoryInfoFileEntry> = {}): RepositoryInfoFileEntry {
    return {
        Path: 'bin/hello.sh',
        Label: 'hello.sh',
        Description: '',
        Executable: true,
        ListInAgents: false,
        ContentHash: 'abc123',
        ...overrides,
    };
}

function hashEntry(overrides: Partial<{
    path: string; label: string; description: string; executable: boolean; listInAgents: boolean; contentHash: string;
}> = {}): RepositoryFileHashEntry {
    const e = {
        path: 'bin/hello.sh', label: 'hello.sh', description: '', executable: true, listInAgents: false, contentHash: 'abc123',
        ...overrides,
    };
    return [e.path, e.label, e.description, e.executable, e.listInAgents, e.contentHash];
}

test('buildRepositoryInfoPayload() defaults Files to [] when no files are passed', () => {
    const payload = buildRepositoryInfoPayload(makeRepo());
    assert.deepEqual(payload.Files, []);
});

test('buildRepositoryInfoPayload() converts canonicalFilesForHash()-shaped tuples into RepositoryInfoFileEntry objects, sorted by Path', () => {
    const payload = buildRepositoryInfoPayload(makeRepo(), [
        hashEntry({ path: 'z.sh' }),
        hashEntry({ path: 'a.sh' }),
    ]);
    assert.deepEqual(payload.Files!.map((f) => f.Path), ['a.sh', 'z.sh']);
    assert.deepEqual(payload.Files![0], fileEntry({ Path: 'a.sh' }));
});

test('hashRepositoryInfoPayload() with empty Files is byte-identical to the M1 hash (compatibility rule)', () => {
    const payload: RepositoryInfoPayload = { Id: 'x', Name: 'Y', Description: 'Z', Files: [] };
    const m1Json = JSON.stringify(['x', 'Y', 'Z']);
    const expected = crypto.createHash('sha256').update(m1Json).digest('hex');
    assert.equal(hashRepositoryInfoPayload(payload), expected);
});

test('hashRepositoryInfoPayload() with a non-empty Files differs from the Files-less hash of the same Id/Name/Description', () => {
    const withoutFiles = hashRepositoryInfoPayload({ Id: 'x', Name: 'Y', Description: 'Z', Files: [] });
    const withFiles = hashRepositoryInfoPayload({ Id: 'x', Name: 'Y', Description: 'Z', Files: [fileEntry()] });
    assert.notEqual(withoutFiles, withFiles);
});

test('hashRepositoryInfoPayload() is independent of the order Files happened to be built in', () => {
    const a = hashRepositoryInfoPayload({ Id: 'x', Name: 'Y', Description: 'Z', Files: [fileEntry({ Path: 'a.sh' }), fileEntry({ Path: 'z.sh' })] });
    const b = hashRepositoryInfoPayload({ Id: 'x', Name: 'Y', Description: 'Z', Files: [fileEntry({ Path: 'z.sh' }), fileEntry({ Path: 'a.sh' })] });
    assert.equal(a, b);
});

test('hashRepositoryInfoPayload() changes when a file\'s ContentHash changes', () => {
    const a = hashRepositoryInfoPayload({ Id: 'x', Name: 'Y', Description: 'Z', Files: [fileEntry({ ContentHash: 'h1' })] });
    const b = hashRepositoryInfoPayload({ Id: 'x', Name: 'Y', Description: 'Z', Files: [fileEntry({ ContentHash: 'h2' })] });
    assert.notEqual(a, b);
});

test('evaluateRepositoryInfoSync(): an existing M1 baseline (no Files) stays in-sync after the upgrade', () => {
    // Simulates an M1 info.json (no Files key at all) read after upgrading to
    // a Paralizer that knows about Files: readRepositoryInfoFile() treats the
    // absent key as [], and the repository has no files either.
    const mainFolder = makeTempDir();
    fs.mkdirSync(infoFolder(mainFolder), { recursive: true });
    fs.writeFileSync(
        infoFile(mainFolder),
        JSON.stringify({ SchemaVersion: 1, Id: 'my-repo', Name: 'My Repo', Description: 'D' }),
    );

    const dataPayload = buildRepositoryInfoPayload(makeRepo({ Id: 'my-repo', Name: 'My Repo', Description: 'D' }));
    const dataHash = hashRepositoryInfoPayload(dataPayload);
    const folderRead = readRepositoryInfoFile(mainFolder);

    const state = evaluateRepositoryInfoSync({ dataHash, folder: folderRead, repositoryId: 'my-repo' });
    assert.equal(state, 'in-sync');
    assert.equal(folderRead.raw!.SchemaVersion, 1);
});

// ─── Milestone 2: Files — info.json rendering ─────────────────────────────────

test('renderRepositoryInfoFile() renders Files sorted by path, with exactly Path/Label/Description/Executable/ListInAgents (no ContentHash)', () => {
    const payload: RepositoryInfoPayload = {
        Id: 'repo', Name: 'N', Description: 'D',
        Files: [fileEntry({ Path: 'z.sh' }), fileEntry({ Path: 'a.sh' })],
    };
    const content = renderRepositoryInfoFile(payload, 'https://x');
    const parsed = JSON.parse(content);

    assert.deepEqual(parsed.Files.map((f: { Path: string }) => f.Path), ['a.sh', 'z.sh']);
    for (const entry of parsed.Files) {
        assert.deepEqual(Object.keys(entry).sort(), ['Description', 'Executable', 'Label', 'ListInAgents', 'Path'].sort());
    }
});

test('renderRepositoryInfoFile() renders Files as [] when the payload has no files', () => {
    const payload: RepositoryInfoPayload = { Id: 'repo', Name: 'N', Description: 'D', Files: [] };
    const content = renderRepositoryInfoFile(payload, 'https://x');
    assert.deepEqual(JSON.parse(content).Files, []);
});

test('renderRepositoryInfoFile() never duplicates Files as a preserved unknown top-level key', () => {
    const payload: RepositoryInfoPayload = { Id: 'repo', Name: 'N', Description: 'D', Files: [fileEntry()] };
    const existingRaw = {
        SchemaVersion: 1, Id: 'repo', Name: 'old', Description: 'old', Settings: {},
        Files: [{ Path: 'stale.sh', Label: 'stale', Description: '', Executable: false, ListInAgents: false }],
    };
    const content = renderRepositoryInfoFile(payload, 'https://x', existingRaw);
    const parsed = JSON.parse(content);

    assert.equal(Object.keys(parsed).filter((k) => k === 'Files').length, 1);
    assert.deepEqual(parsed.Files.map((f: { Path: string }) => f.Path), ['bin/hello.sh']);
});

// ─── Milestone 2: Files — readRepositoryInfoFile() validation ────────────────

test('readRepositoryInfoFile() treats an absent Files key as [] (an un-upgraded M1 file)', () => {
    const mainFolder = makeTempDir();
    fs.mkdirSync(infoFolder(mainFolder), { recursive: true });
    fs.writeFileSync(infoFile(mainFolder), JSON.stringify({ SchemaVersion: 1, Id: 'repo', Name: 'N', Description: 'D' }));

    const result = readRepositoryInfoFile(mainFolder);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.payload!.Files, []);
});

test('readRepositoryInfoFile() parses valid Files entries, with ContentHash set to \'\' (never stored in info.json)', () => {
    const mainFolder = makeTempDir();
    fs.mkdirSync(infoFolder(mainFolder), { recursive: true });
    fs.writeFileSync(infoFile(mainFolder), JSON.stringify({
        SchemaVersion: 1, Id: 'repo', Name: 'N', Description: 'D',
        Files: [{ Path: 'bin/hello.sh', Label: 'Hello', Description: 'desc', Executable: true, ListInAgents: false }],
    }));

    const result = readRepositoryInfoFile(mainFolder);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.payload!.Files, [
        { Path: 'bin/hello.sh', Label: 'Hello', Description: 'desc', Executable: true, ListInAgents: false, ContentHash: '' },
    ]);
});

test('readRepositoryInfoFile() returns invalid when Files is not an array', () => {
    const mainFolder = makeTempDir();
    fs.mkdirSync(infoFolder(mainFolder), { recursive: true });
    fs.writeFileSync(infoFile(mainFolder), JSON.stringify({ SchemaVersion: 1, Id: 'repo', Name: 'N', Description: 'D', Files: 'nope' }));

    const result = readRepositoryInfoFile(mainFolder);
    assert.equal(result.status, 'invalid');
    assert.ok(result.error);
});

test('readRepositoryInfoFile() returns invalid when a Files entry has a wrong field type', () => {
    const mainFolder = makeTempDir();
    fs.mkdirSync(infoFolder(mainFolder), { recursive: true });
    fs.writeFileSync(infoFile(mainFolder), JSON.stringify({
        SchemaVersion: 1, Id: 'repo', Name: 'N', Description: 'D',
        Files: [{ Path: 'bin/hello.sh', Label: 'Hello', Description: 'desc', Executable: 'yes', ListInAgents: false }],
    }));

    const result = readRepositoryInfoFile(mainFolder);
    assert.equal(result.status, 'invalid');
});

test('readRepositoryInfoFile() returns invalid when a Files entry is missing a required field', () => {
    const mainFolder = makeTempDir();
    fs.mkdirSync(infoFolder(mainFolder), { recursive: true });
    fs.writeFileSync(infoFile(mainFolder), JSON.stringify({
        SchemaVersion: 1, Id: 'repo', Name: 'N', Description: 'D',
        Files: [{ Path: 'bin/hello.sh', Label: 'Hello', Executable: true, ListInAgents: false }],
    }));

    const result = readRepositoryInfoFile(mainFolder);
    assert.equal(result.status, 'invalid');
});

test('readRepositoryInfoFile() returns invalid, naming both paths, when two Files entries collide on a case-only duplicate path', () => {
    const mainFolder = makeTempDir();
    fs.mkdirSync(infoFolder(mainFolder), { recursive: true });
    fs.writeFileSync(infoFile(mainFolder), JSON.stringify({
        SchemaVersion: 1, Id: 'repo', Name: 'N', Description: 'D',
        Files: [
            { Path: 'a.sh', Label: 'A', Description: '', Executable: false, ListInAgents: false },
            { Path: 'A.sh', Label: 'B', Description: '', Executable: false, ListInAgents: false },
        ],
    }));

    const result = readRepositoryInfoFile(mainFolder);
    assert.equal(result.status, 'invalid');
    assert.ok(result.error);
    assert.ok(result.error!.includes('a.sh'));
    assert.ok(result.error!.includes('A.sh'));
});

test('readRepositoryInfoFile() does not flag two Files entries with distinct (non-colliding) paths', () => {
    const mainFolder = makeTempDir();
    fs.mkdirSync(infoFolder(mainFolder), { recursive: true });
    fs.writeFileSync(infoFile(mainFolder), JSON.stringify({
        SchemaVersion: 1, Id: 'repo', Name: 'N', Description: 'D',
        Files: [
            { Path: 'a.sh', Label: 'A', Description: '', Executable: false, ListInAgents: false },
            { Path: 'b.sh', Label: 'B', Description: '', Executable: false, ListInAgents: false },
        ],
    }));

    const result = readRepositoryInfoFile(mainFolder);
    assert.equal(result.status, 'ok');
});

test('evaluateRepositoryInfoSync() yields invalid-file for a case-only duplicate Files path', () => {
    const state = evaluateRepositoryInfoSync({
        dataHash: 'h',
        folder: {
            status: 'invalid',
            error: 'info.json\'s "Files" entries "a.sh" and "A.sh" collide on the same path, differing only by case.',
        },
        repositoryId: 'repo',
    });
    assert.equal(state, 'invalid-file');
});

// ─── Milestone 2: Files — diffRepositoryFiles() ───────────────────────────────

test('diffRepositoryFiles(): a file present only in the folder (teammate-added) is incoming-only', () => {
    const diffs = diffRepositoryFiles([], [fileEntry()]);
    assert.deepEqual(diffs, [{ path: 'bin/hello.sh', kind: 'incoming-only' }]);
});

test('diffRepositoryFiles(): a file present only locally (teammate-removed, or not yet pulled) is local-only', () => {
    const diffs = diffRepositoryFiles([fileEntry()], []);
    assert.deepEqual(diffs, [{ path: 'bin/hello.sh', kind: 'local-only' }]);
});

test('diffRepositoryFiles(): a file present on both sides with a differing ContentHash is changed, with a Content change entry', () => {
    const local = [fileEntry({ ContentHash: 'local-hash' })];
    const folder = [fileEntry({ ContentHash: 'folder-hash' })];
    const diffs = diffRepositoryFiles(local, folder);
    assert.deepEqual(diffs, [{
        path: 'bin/hello.sh',
        kind: 'changed',
        changes: [{ field: 'Content', local: 'local-hash', incoming: 'folder-hash' }],
    }]);
});

test('diffRepositoryFiles(): a changed Label/Description/Executable/ListInAgents each surfaces as its own change entry', () => {
    const local = [fileEntry({ Label: 'A', Description: 'a', Executable: true, ListInAgents: false })];
    const folder = [fileEntry({ Label: 'B', Description: 'b', Executable: false, ListInAgents: true })];
    const diffs = diffRepositoryFiles(local, folder);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0]!.kind, 'changed');
    const fields = diffs[0]!.changes!.map((c) => c.field).sort();
    assert.deepEqual(fields, ['Description', 'Executable', 'Label', 'ListInAgents'].sort());
});

test('diffRepositoryFiles(): an identical file on both sides produces no diff entry', () => {
    const diffs = diffRepositoryFiles([fileEntry()], [fileEntry()]);
    assert.deepEqual(diffs, []);
});

test('diffRepositoryFiles(): a CRLF-only difference (already normalised into equal ContentHash) yields no diff entry', () => {
    // canonicalFilesForHash() normalises line endings before hashing, so an
    // LF/CRLF-only difference between two checkouts produces the same
    // ContentHash on both sides — diffRepositoryFiles() never re-reads raw
    // content, so it correctly reports no change here.
    const diffs = diffRepositoryFiles([fileEntry({ ContentHash: 'same' })], [fileEntry({ ContentHash: 'same' })]);
    assert.deepEqual(diffs, []);
});

test('diffRepositoryFiles(): matches paths case-insensitively', () => {
    const local = [fileEntry({ Path: 'Bin/Hello.sh' })];
    const folder = [fileEntry({ Path: 'bin/hello.sh' })];
    const diffs = diffRepositoryFiles(local, folder);
    assert.deepEqual(diffs, []);
});

// ─── Milestone 2: Files — defaultFileImportAction() / resolveFileImportAction() ──

function makeDiff(overrides: Partial<RepositoryFileDiff> = {}): RepositoryFileDiff {
    return { path: 'bin/hello.sh', kind: 'incoming-only', ...overrides };
}

test('defaultFileImportAction(): "discard" for incoming-only, "keep" for local-only and changed', () => {
    assert.equal(defaultFileImportAction('incoming-only'), 'discard');
    assert.equal(defaultFileImportAction('local-only'), 'keep');
    assert.equal(defaultFileImportAction('changed'), 'keep');
});

test('resolveFileImportAction(): omitted selection resolves to the default for the diff\'s kind', () => {
    assert.equal(resolveFileImportAction(makeDiff({ kind: 'incoming-only' }), undefined), 'discard');
    assert.equal(resolveFileImportAction(makeDiff({ kind: 'local-only' }), undefined), 'keep');
    assert.equal(resolveFileImportAction(makeDiff({ kind: 'changed' }), undefined), 'keep');
});

test('resolveFileImportAction(): accepts every action in the kind\'s action table', () => {
    assert.equal(resolveFileImportAction(makeDiff({ kind: 'incoming-only' }), 'add'), 'add');
    assert.equal(resolveFileImportAction(makeDiff({ kind: 'incoming-only' }), 'discard'), 'discard');
    assert.equal(resolveFileImportAction(makeDiff({ kind: 'local-only' }), 'keep'), 'keep');
    assert.equal(resolveFileImportAction(makeDiff({ kind: 'local-only' }), 'delete'), 'delete');
    assert.equal(resolveFileImportAction(makeDiff({ kind: 'changed' }), 'overwrite'), 'overwrite');
    assert.equal(resolveFileImportAction(makeDiff({ kind: 'changed' }), 'keep'), 'keep');
});

test('resolveFileImportAction(): rejects an action not in the kind\'s action table (e.g. "skip", or a cross-kind action)', () => {
    assert.throws(() => resolveFileImportAction(makeDiff({ kind: 'incoming-only' }), 'skip' as never), /Unsupported import action/);
    assert.throws(() => resolveFileImportAction(makeDiff({ kind: 'incoming-only' }), 'keep'), /Unsupported import action/);
    assert.throws(() => resolveFileImportAction(makeDiff({ kind: 'local-only' }), 'add'), /Unsupported import action/);
    assert.throws(() => resolveFileImportAction(makeDiff({ kind: 'changed' }), 'add'), /Unsupported import action/);
});

test('resolveFileImportAction(): a problem incoming-only file may only be discarded, not added', () => {
    const diff = makeDiff({ kind: 'incoming-only', problem: 'File must be plain text (binary data is not supported).' });
    assert.equal(resolveFileImportAction(diff, undefined), 'discard');
    assert.equal(resolveFileImportAction(diff, 'discard'), 'discard');
    assert.throws(() => resolveFileImportAction(diff, 'add'), /cannot be imported as-is/);
});

test('resolveFileImportAction(): a problem changed file may only be kept, not overwritten', () => {
    const diff = makeDiff({ kind: 'changed', problem: 'File exceeds the maximum size of 256 KB.' });
    assert.equal(resolveFileImportAction(diff, undefined), 'keep');
    assert.equal(resolveFileImportAction(diff, 'keep'), 'keep');
    assert.throws(() => resolveFileImportAction(diff, 'overwrite'), /cannot be imported as-is/);
});

// ─── Milestone 2: README files/ section ──────────────────────────────────────

test('renderRepositoryInfoReadme() documents the files/ folder: purpose, git-only delivery, maintained-by-Paralizer and invocation', () => {
    const content = renderRepositoryInfoReadme();
    assert.ok(content.includes('files/'));
    assert.ok(/git/i.test(content));
    assert.ok(content.includes('sh .workspace/files/<name>.sh'));
    assert.ok(content.includes('Files'));
});

test('renderRepositoryInfoReadme() files/ section contains no absolute path', () => {
    const content = renderRepositoryInfoReadme();
    assert.ok(!/\/(Users|home|var|private)\//.test(content));
    assert.ok(!/^[A-Za-z]:\\/m.test(content));
});
