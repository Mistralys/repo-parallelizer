import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { RepositoryManager } from '../models/repository/repository.manager.js';
import { RepositoryFileManager } from '../models/repository/repository-file.manager.js';
import {
    validateRepositoryFileInput,
    repositoryFileRelativePath,
    REPOSITORY_FILE_MAX_COUNT,
    RESERVED_REPOSITORY_FILE_SEGMENTS,
    type RepositoryFile,
    type RepositoryFileInput,
} from '../models/repository/repository-file.js';
import { NotFoundError } from '../errors.js';
import { createTempDirTracker, makeTestConfig } from './test-helpers.js';

const makeTempDir = createTempDirTracker('paralizer-repository-file-test-');

function input(overrides?: Partial<RepositoryFileInput>): RepositoryFileInput {
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

function makeManagers(base: string): { repos: RepositoryManager; files: RepositoryFileManager; storageFolder: string } {
    const config = makeTestConfig(base);
    fs.mkdirSync(config.storageFolder, { recursive: true });
    const repos = new RepositoryManager(config);
    const files = new RepositoryFileManager(config, repos);
    return { repos, files, storageFolder: config.storageFolder };
}

function addRepo(repos: RepositoryManager, id = 'my-repo'): string {
    repos.add({ url: `https://github.com/user/${id}.git`, id });
    return id;
}

// ---------------------------------------------------------------------------
// validateRepositoryFileInput
// ---------------------------------------------------------------------------

test('validate: normalises directory separators and trims', () => {
    const v = validateRepositoryFileInput(input({ Directory: ' .\\docs\\notes\\ ', FileName: ' a.md ' }), []);
    assert.equal(v.Directory, 'docs/notes');
    assert.equal(v.FileName, 'a.md');
});

test('validate: empty directory targets the files/ root', () => {
    assert.equal(validateRepositoryFileInput(input({ Directory: '' }), []).Directory, '');
});

for (const bad of ['../x', 'a/../../x', '/etc', 'C:/x', 'a//b', 'a/./b', 'a/b.', 'con', 'a/b:c']) {
    test(`validate: rejects directory "${bad}"`, () => {
        assert.throws(() => validateRepositoryFileInput(input({ Directory: bad }), []));
    });
}

for (const bad of ['a/b.sh', 'a\\b.sh', '..', '.', 'x?.sh', '']) {
    test(`validate: rejects file name "${bad}"`, () => {
        assert.throws(() => validateRepositoryFileInput(input({ FileName: bad }), []));
    });
}

test('validate: rejects the reserved .git segment as a directory component', () => {
    assert.throws(
        () => validateRepositoryFileInput(input({ Directory: '.git' }), []),
        /reserved/,
    );
});

test('validate: rejects the reserved .git segment nested inside a directory', () => {
    assert.throws(
        () => validateRepositoryFileInput(input({ Directory: 'a/.git/b' }), []),
        /\.\.|reserved/,
    );
});

test('validate: rejects the reserved .git segment case-insensitively', () => {
    assert.throws(
        () => validateRepositoryFileInput(input({ Directory: '.GIT' }), []),
        /reserved/,
    );
});

test('RESERVED_REPOSITORY_FILE_SEGMENTS contains .git', () => {
    assert.deepStrictEqual([...RESERVED_REPOSITORY_FILE_SEGMENTS], ['.git']);
});

test('validate: rejects content over the 256 KB limit', () => {
    const big = 'a'.repeat(256 * 1024 + 1);
    assert.throws(() => validateRepositoryFileInput(input({ Content: big }), []), /256 KB|maximum size/);
});

test('validate: rejects binary content (embedded NUL byte)', () => {
    assert.throws(() => validateRepositoryFileInput(input({ Content: 'a\u0000b' }), []), /plain text/);
});

test('validate: rejects a path colliding case-insensitively with another file', () => {
    const existing: RepositoryFile = {
        Id: 'id-1',
        Directory: 'scripts',
        FileName: 'Run.sh',
        Label: 'Existing',
        Description: '',
        Content: '#!/bin/sh\n',
        Executable: true,
        ListInAgents: false,
        DateModified: '2026-11-18T00:00:00.000Z',
    };
    assert.throws(
        () => validateRepositoryFileInput(input({ Directory: 'scripts', FileName: 'run.sh' }), [existing]),
        /already uses the path/,
    );
});

test('validate: enforces the REPOSITORY_FILE_MAX_COUNT limit', () => {
    const others: RepositoryFile[] = Array.from({ length: REPOSITORY_FILE_MAX_COUNT }, (_, i) => ({
        Id: `id-${i}`,
        Directory: '',
        FileName: `f${i}.txt`,
        Label: 'L',
        Description: '',
        Content: '',
        Executable: false,
        ListInAgents: false,
        DateModified: '2026-11-18T00:00:00.000Z',
    }));
    assert.throws(
        () => validateRepositoryFileInput(input({ FileName: 'one-more.txt' }), others),
        new RegExp(String(REPOSITORY_FILE_MAX_COUNT)),
    );
});

test('validate: allows updating a file when the repository is already at the count limit', () => {
    // `others` excludes the file being edited, so it sits one below the limit —
    // keeping that file in place must not be treated as exceeding the cap.
    const others: RepositoryFile[] = Array.from({ length: REPOSITORY_FILE_MAX_COUNT - 1 }, (_, i) => ({
        Id: `id-${i}`,
        Directory: '',
        FileName: `f${i}.txt`,
        Label: 'L',
        Description: '',
        Content: '',
        Executable: false,
        ListInAgents: false,
        DateModified: '2026-11-18T00:00:00.000Z',
    }));
    assert.doesNotThrow(() => validateRepositoryFileInput(input({ FileName: 'kept.txt' }), others));
});

test('validate: defaults Executable from the shebang/extension heuristic when omitted', () => {
    const v = validateRepositoryFileInput(input({ FileName: 'run.sh', Content: '#!/bin/sh\necho hi\n' }), []);
    assert.equal(v.Executable, true);
});

test('validate: an explicit Executable flag overrides the heuristic', () => {
    const v = validateRepositoryFileInput(input({ FileName: 'run.sh', Content: 'echo hi\n', Executable: false }), []);
    assert.equal(v.Executable, false);
});

test('repositoryFileRelativePath joins directory and file name', () => {
    assert.equal(repositoryFileRelativePath({ Directory: 'scripts', FileName: 'run.sh' }), 'scripts/run.sh');
    assert.equal(repositoryFileRelativePath({ Directory: '', FileName: 'run.sh' }), 'run.sh');
});

// ---------------------------------------------------------------------------
// RepositoryFileManager — list / get / add
// ---------------------------------------------------------------------------

test('list returns an empty array for a repository with no files', () => {
    const { repos, files } = makeManagers(makeTempDir());
    const repoId = addRepo(repos);
    assert.deepStrictEqual(files.list(repoId), []);
});

test('list throws NotFoundError for an unknown repository', () => {
    const { files } = makeManagers(makeTempDir());
    assert.throws(() => files.list('nonexistent'), NotFoundError);
});

test('add persists a file so list() immediately reflects it', () => {
    const { repos, files } = makeManagers(makeTempDir());
    const repoId = addRepo(repos);
    const created = files.add(repoId, input());
    assert.equal(created.FileName, 'run.sh');
    assert.ok(created.Id);
    assert.ok(created.DateModified);

    const listed = files.list(repoId);
    assert.equal(listed.length, 1);
    assert.deepStrictEqual(listed[0], created);
});

test('add throws NotFoundError for an unknown repository', () => {
    const { files } = makeManagers(makeTempDir());
    assert.throws(() => files.add('nonexistent', input()), NotFoundError);
});

test('add throws a descriptive error on invalid input', () => {
    const { repos, files } = makeManagers(makeTempDir());
    const repoId = addRepo(repos);
    assert.throws(() => files.add(repoId, input({ FileName: '' })));
});

test('get returns the matching file', () => {
    const { repos, files } = makeManagers(makeTempDir());
    const repoId = addRepo(repos);
    const created = files.add(repoId, input());
    assert.deepStrictEqual(files.get(repoId, created.Id), created);
});

test('get throws NotFoundError for an unknown repository', () => {
    const { files } = makeManagers(makeTempDir());
    assert.throws(() => files.get('nonexistent', 'some-id'), NotFoundError);
});

test('get throws NotFoundError for an unknown file ID', () => {
    const { repos, files } = makeManagers(makeTempDir());
    const repoId = addRepo(repos);
    assert.throws(() => files.get(repoId, 'nonexistent'), NotFoundError);
});

// ---------------------------------------------------------------------------
// RepositoryFileManager — update
// ---------------------------------------------------------------------------

test('update replaces editable fields and returns previous and updated', () => {
    const { repos, files } = makeManagers(makeTempDir());
    const repoId = addRepo(repos);
    const created = files.add(repoId, input());

    const { previous, updated } = files.update(repoId, created.Id, input({ Label: 'Renamed' }));

    assert.deepStrictEqual(previous, created);
    assert.equal(updated.Id, created.Id);
    assert.equal(updated.Label, 'Renamed');
    assert.ok(updated.DateModified);

    const fetched = files.get(repoId, created.Id);
    assert.deepStrictEqual(fetched, updated);
});

test('update throws NotFoundError for an unknown repository, with the operation label in the message', () => {
    const { files } = makeManagers(makeTempDir());
    assert.throws(
        () => files.update('nonexistent', 'some-id', input()),
        (err: unknown) => err instanceof NotFoundError && /update file/.test((err as Error).message),
    );
});

test('update throws NotFoundError for an unknown file ID, with the operation label in the message', () => {
    const { repos, files } = makeManagers(makeTempDir());
    const repoId = addRepo(repos);
    assert.throws(
        () => files.update(repoId, 'nonexistent', input()),
        (err: unknown) => err instanceof NotFoundError && /update file/.test((err as Error).message),
    );
});

test('update rejects a rename onto an existing path differing only by case, inside the same load/save cycle', () => {
    const { repos, files } = makeManagers(makeTempDir());
    const repoId = addRepo(repos);
    files.add(repoId, input({ FileName: 'Run.sh' }));
    const second = files.add(repoId, input({ FileName: 'other.sh' }));

    assert.throws(
        () => files.update(repoId, second.Id, input({ FileName: 'run.sh' })),
        /already uses the path/,
    );

    // The store on disk must be unaffected by the rejected rename.
    const listed = files.list(repoId);
    assert.ok(listed.some((f) => f.Id === second.Id && f.FileName === 'other.sh'));
});

test('update allows keeping a file at its own unchanged path', () => {
    const { repos, files } = makeManagers(makeTempDir());
    const repoId = addRepo(repos);
    const created = files.add(repoId, input());
    const { updated } = files.update(repoId, created.Id, input({ Label: 'Still here' }));
    assert.equal(updated.FileName, created.FileName);
    assert.equal(updated.Label, 'Still here');
});

// ---------------------------------------------------------------------------
// RepositoryFileManager — remove
// ---------------------------------------------------------------------------

test('remove deletes the file and returns the removed record', () => {
    const { repos, files } = makeManagers(makeTempDir());
    const repoId = addRepo(repos);
    const created = files.add(repoId, input());

    const removed = files.remove(repoId, created.Id);
    assert.deepStrictEqual(removed, created);
    assert.deepStrictEqual(files.list(repoId), []);
});

test('remove throws NotFoundError for an unknown repository, with the operation label in the message', () => {
    const { files } = makeManagers(makeTempDir());
    assert.throws(
        () => files.remove('nonexistent', 'some-id'),
        (err: unknown) => err instanceof NotFoundError && /remove file/.test((err as Error).message),
    );
});

test('remove throws NotFoundError for an unknown file ID, with the operation label in the message', () => {
    const { repos, files } = makeManagers(makeTempDir());
    const repoId = addRepo(repos);
    assert.throws(
        () => files.remove(repoId, 'nonexistent'),
        (err: unknown) => err instanceof NotFoundError && /remove file/.test((err as Error).message),
    );
});

// ---------------------------------------------------------------------------
// RepositoryFileManager — replaceAll
// ---------------------------------------------------------------------------

test('replaceAll overwrites the entire file list', () => {
    const { repos, files } = makeManagers(makeTempDir());
    const repoId = addRepo(repos);
    files.add(repoId, input());

    const replacement: RepositoryFile[] = [
        {
            Id: 'fixed-id',
            Directory: '',
            FileName: 'new.txt',
            Label: 'New',
            Description: '',
            Content: 'hello',
            Executable: false,
            ListInAgents: true,
            DateModified: '2026-11-20T00:00:00.000Z',
        },
    ];
    files.replaceAll(repoId, replacement);
    assert.deepStrictEqual(files.list(repoId), replacement);
});

test('replaceAll with an empty array clears the file list', () => {
    const { repos, files } = makeManagers(makeTempDir());
    const repoId = addRepo(repos);
    files.add(repoId, input());
    files.replaceAll(repoId, []);
    assert.deepStrictEqual(files.list(repoId), []);
});

test('replaceAll throws NotFoundError for an unknown repository', () => {
    const { files } = makeManagers(makeTempDir());
    assert.throws(() => files.replaceAll('nonexistent', []), NotFoundError);
});

test('replaceAll normalises the stored files (e.g. trims Label) via validateRepositoryFileSet()', () => {
    const { repos, files } = makeManagers(makeTempDir());
    const repoId = addRepo(repos);

    const replacement: RepositoryFile[] = [
        {
            Id: 'fixed-id',
            Directory: '',
            FileName: 'new.txt',
            Label: '  New  ',
            Description: '',
            Content: 'hello',
            Executable: false,
            ListInAgents: true,
            DateModified: '2026-11-20T00:00:00.000Z',
        },
    ];
    files.replaceAll(repoId, replacement);

    const listed = files.list(repoId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].Label, 'New');
    assert.equal(listed[0].Id, 'fixed-id');
    assert.equal(listed[0].DateModified, '2026-11-20T00:00:00.000Z');
});

test('replaceAll throws on a set exceeding REPOSITORY_FILE_MAX_COUNT and leaves the store file bytes unchanged', () => {
    const { repos, files, storageFolder } = makeManagers(makeTempDir());
    const repoId = addRepo(repos);
    files.add(repoId, input());

    const storePath = path.join(storageFolder, 'repository-files', `${repoId}.json`);
    const before = fs.readFileSync(storePath, 'utf8');

    const tooMany: RepositoryFile[] = Array.from({ length: REPOSITORY_FILE_MAX_COUNT + 1 }, (_, i) => ({
        Id: `id-${i}`,
        Directory: '',
        FileName: `f${i}.txt`,
        Label: 'L',
        Description: '',
        Content: '',
        Executable: false,
        ListInAgents: false,
        DateModified: '2026-11-18T00:00:00.000Z',
    }));

    assert.throws(
        () => files.replaceAll(repoId, tooMany),
        new RegExp(String(REPOSITORY_FILE_MAX_COUNT)),
    );
    assert.equal(fs.readFileSync(storePath, 'utf8'), before);
});

test('replaceAll throws on a case-insensitive path duplicate within the replacement set', () => {
    const { repos, files } = makeManagers(makeTempDir());
    const repoId = addRepo(repos);

    const duplicate: RepositoryFile[] = [
        {
            Id: 'id-1',
            Directory: 'scripts',
            FileName: 'Run.sh',
            Label: 'A',
            Description: '',
            Content: '',
            Executable: false,
            ListInAgents: false,
            DateModified: '2026-11-18T00:00:00.000Z',
        },
        {
            Id: 'id-2',
            Directory: 'scripts',
            FileName: 'run.sh',
            Label: 'B',
            Description: '',
            Content: '',
            Executable: false,
            ListInAgents: false,
            DateModified: '2026-11-18T00:00:00.000Z',
        },
    ];

    assert.throws(() => files.replaceAll(repoId, duplicate), /already uses the path/);
});

test('replaceAll throws on an over-length Label, with the offending path in the message', () => {
    const { repos, files } = makeManagers(makeTempDir());
    const repoId = addRepo(repos);

    const invalid: RepositoryFile[] = [
        {
            Id: 'id-1',
            Directory: '',
            FileName: 'bad.txt',
            Label: 'x'.repeat(200),
            Description: '',
            Content: '',
            Executable: false,
            ListInAgents: false,
            DateModified: '2026-11-18T00:00:00.000Z',
        },
    ];

    assert.throws(() => files.replaceAll(repoId, invalid), /File "bad\.txt": Label must be at most/);
});

// ---------------------------------------------------------------------------
// RepositoryFileManager — removeStore
// ---------------------------------------------------------------------------

test('removeStore deletes the store file when present', () => {
    const { repos, files, storageFolder } = makeManagers(makeTempDir());
    const repoId = addRepo(repos);
    files.add(repoId, input());

    const storePath = path.join(storageFolder, 'repository-files', `${repoId}.json`);
    assert.ok(fs.existsSync(storePath));

    files.removeStore(repoId);
    assert.ok(!fs.existsSync(storePath));
});

test('removeStore is a no-op when the store file is absent', () => {
    const { files } = makeManagers(makeTempDir());
    assert.doesNotThrow(() => files.removeStore('never-had-files'));
});

test('removeStore does not require the repository to still exist', () => {
    const { repos, files, storageFolder } = makeManagers(makeTempDir());
    const repoId = addRepo(repos);
    files.add(repoId, input());
    repos.remove(repoId);

    const storePath = path.join(storageFolder, 'repository-files', `${repoId}.json`);
    assert.ok(fs.existsSync(storePath));
    assert.doesNotThrow(() => files.removeStore(repoId));
    assert.ok(!fs.existsSync(storePath));
});

test('removeStore rejects a path-traversal repoId as a silent no-op, without touching the filesystem', () => {
    const { repos, files, storageFolder } = makeManagers(makeTempDir());
    addRepo(repos);

    // A sibling ".json" file outside repository-files/ that a traversal
    // attempt could otherwise reach and delete.
    const outsideTarget = path.join(storageFolder, 'repositories.json');
    const before = fs.readFileSync(outsideTarget, 'utf8');

    assert.doesNotThrow(() => files.removeStore('../../repositories'));
    assert.doesNotThrow(() => files.removeStore('../../../../some/other/store'));

    assert.equal(fs.readFileSync(outsideTarget, 'utf8'), before);
});

for (const bad of ['../x', 'a/b', '.', '..', 'UPPERCASE', 'has space', 'trailing-', '-leading', '']) {
    test(`removeStore is a no-op for the non-kebab-case repoId "${bad}"`, () => {
        const { files } = makeManagers(makeTempDir());
        assert.doesNotThrow(() => files.removeStore(bad));
    });
}

// ---------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------

test('repositories.json is never written to by RepositoryFileManager', () => {
    const { repos, files, storageFolder } = makeManagers(makeTempDir());
    const repoId = addRepo(repos);
    const repositoriesJsonPath = path.join(storageFolder, 'repositories.json');
    const before = fs.readFileSync(repositoriesJsonPath, 'utf8');

    files.add(repoId, input());
    const created = files.list(repoId)[0];
    files.update(repoId, created.Id, input({ Label: 'Changed' }));
    files.remove(repoId, created.Id);

    const after = fs.readFileSync(repositoriesJsonPath, 'utf8');
    assert.equal(after, before);
});
