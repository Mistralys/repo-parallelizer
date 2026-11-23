import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initializeStorage } from '../storage/json-storage.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { RepositoryFileManager } from '../models/repository/repository-file.manager.js';
import { ProjectManager } from '../models/project/project.manager.js';
import { WorkspaceArtifactsOrchestrator } from '../orchestration/workspace-artifacts.js';
import { RepositoryInfoSyncOrchestrator } from '../orchestration/repository-info-sync.js';
import {
    runRepoFilesCommand,
    EXIT_OK,
    EXIT_ERROR,
    EXIT_SYNC_FAILED,
    type RepoFilesCliDeps,
} from '../cli/repo-files.js';
import { createTempDirTracker, makeTestConfig } from './test-helpers.js';

const makeTempDir = createTempDirTracker('paralizer-cli-repo-files-test-');

interface Harness {
    deps: RepoFilesCliDeps;
    fileManager: RepositoryFileManager;
    repoManager: RepositoryManager;
    stdout: () => string;
    stderr: () => string;
    run: (...args: string[]) => Promise<number>;
}

/** `repoId`'s info sync is marked enabled directly (bypassing the real async clone) unless `enabled` is false. */
function makeHarness(options: { stdin?: string; enabled?: boolean } = {}): Harness {
    const { stdin = '', enabled = true } = options;
    const base = makeTempDir();
    const config = makeTestConfig(base);
    initializeStorage(config);

    const repoManager = new RepositoryManager(config);
    const fileManager = new RepositoryFileManager(config, repoManager);
    const infoSync = new RepositoryInfoSyncOrchestrator(config, repoManager, fileManager);
    const projectManager = new ProjectManager(config, repoManager);
    const artifacts = new WorkspaceArtifactsOrchestrator(config, projectManager, repoManager, infoSync, undefined, fileManager);

    repoManager.add({ id: 'my-repo', url: 'https://example.invalid/repo.git' });
    if (enabled) {
        repoManager.setInfoSyncSettings('my-repo', { Enabled: true });
    }

    let out = '';
    let err = '';
    const deps: RepoFilesCliDeps = {
        fileManager,
        infoSync,
        artifacts,
        readStdin: async () => stdin,
        out: (t) => { out += t; },
        err: (t) => { err += t; },
    };
    return {
        deps,
        fileManager,
        repoManager,
        stdout: () => out,
        stderr: () => err,
        run: (...args) => runRepoFilesCommand(args, deps),
    };
}

function writeTemp(content: string): string {
    const file = path.join(makeTempDir(), 'content.txt');
    fs.writeFileSync(file, content);
    return file;
}

test('help prints the documentation and exits 0; no subcommand exits 1', async () => {
    const h = makeHarness();
    assert.strictEqual(await h.run('help'), EXIT_OK);
    assert.match(h.stdout(), /paralizer repo-files <subcommand>/);
    assert.strictEqual(await h.run(), EXIT_ERROR);
});

test('add from a content file with --executable syncs the file into the repository store', async () => {
    const h = makeHarness();
    const src = writeTemp('echo hi\n');
    const code = await h.run('add', '--repo', 'my-repo', '--directory', 'scripts', '--file-name', 'run.sh', '--label', 'Run', '--content-file', src, '--executable');
    assert.strictEqual(code, EXIT_OK, h.stderr());

    const [file] = h.fileManager.list('my-repo');
    assert.strictEqual(file.Content, 'echo hi\n');
    assert.strictEqual(file.Executable, true);
    assert.match(h.stdout(), /Commit & Push in the Paralizer GUI to publish/);
});

test('add reads content from stdin and --list-in-agents lists it', async () => {
    const h = makeHarness({ stdin: 'hello\n' });
    const code = await h.run('add', '--repo', 'my-repo', '--file-name', 'note.txt', '--label', 'Note', '--stdin', '--list-in-agents');
    assert.strictEqual(code, EXIT_OK, h.stderr());

    const [file] = h.fileManager.list('my-repo');
    assert.strictEqual(file.Content, 'hello\n');
    assert.strictEqual(file.ListInAgents, true);
});

test('add without a content source or required options fails with exit 1 and changes nothing', async () => {
    const h = makeHarness();
    assert.strictEqual(await h.run('add', '--repo', 'my-repo', '--file-name', 'a.txt', '--label', 'A'), EXIT_ERROR);
    assert.strictEqual(await h.run('add', '--repo', 'my-repo', '--content', 'x'), EXIT_ERROR);
    assert.deepStrictEqual(h.fileManager.list('my-repo'), []);
});

test('add rejects conflicting content sources, unknown options, and a missing --repo', async () => {
    const h = makeHarness();
    assert.strictEqual(await h.run('add', '--repo', 'my-repo', '--file-name', 'a.txt', '--label', 'A', '--content', 'x', '--stdin'), EXIT_ERROR);
    assert.match(h.stderr(), /only one of/);
    assert.strictEqual(await h.run('add', '--repo', 'my-repo', '--bogus'), EXIT_ERROR);
    assert.strictEqual(await h.run('add', '--file-name', 'a.txt', '--label', 'A', '--content', 'x'), EXIT_ERROR);
});

test('validation errors from the model layer are reported (reserved path segment)', async () => {
    const h = makeHarness();
    assert.strictEqual(await h.run('add', '--repo', 'my-repo', '--directory', '.git', '--file-name', 'a.txt', '--label', 'A', '--content', 'x'), EXIT_ERROR);
    assert.deepStrictEqual(h.fileManager.list('my-repo'), []);
});

test('unknown repository exits 1', async () => {
    const h = makeHarness();
    assert.strictEqual(await h.run('list', '--repo', 'does-not-exist'), EXIT_ERROR);
});

test('with sync disabled, a mutation returns exit 1 and nothing is written; list/show still work', async () => {
    const h = makeHarness({ enabled: false });
    assert.strictEqual(await h.run('add', '--repo', 'my-repo', '--file-name', 'a.txt', '--label', 'A', '--content', 'x'), EXIT_ERROR);
    assert.deepStrictEqual(h.fileManager.list('my-repo'), []);

    assert.strictEqual(await h.run('list', '--repo', 'my-repo'), EXIT_OK);
    assert.match(h.stdout(), /No repository files/);
});

test('list and show work by path, id and unique id prefix; show prints raw content', async () => {
    const h = makeHarness();
    await h.run('add', '--repo', 'my-repo', '--directory', 'docs', '--file-name', 'a.md', '--label', 'A', '--content', 'alpha');
    const [file] = h.fileManager.list('my-repo');

    const listed = makeHarness();
    assert.strictEqual(await listed.run('list', '--repo', 'my-repo'), EXIT_OK);
    assert.match(listed.stdout(), /No repository files/);

    for (const ref of ['docs/a.md', 'DOCS\\a.md', file.Id, file.Id.slice(0, 6)]) {
        let shown = '';
        h.deps.out = (t) => { shown += t; };
        assert.strictEqual(await h.run('show', '--repo', 'my-repo', ref), EXIT_OK, ref);
        assert.strictEqual(shown, 'alpha');
    }

    let jsonOut = '';
    h.deps.out = (t) => { jsonOut += t; };
    assert.strictEqual(await h.run('list', '--repo', 'my-repo', '--json'), EXIT_OK);
    assert.strictEqual((JSON.parse(jsonOut) as unknown[]).length, 1);

    assert.strictEqual(await h.run('show', '--repo', 'my-repo', 'missing.txt'), EXIT_ERROR);
});

test('update changes only the given fields', async () => {
    const h = makeHarness();
    await h.run('add', '--repo', 'my-repo', '--file-name', 'a.txt', '--label', 'Original', '--description', 'Keep me', '--content', 'v1', '--executable');
    assert.strictEqual(await h.run('update', '--repo', 'my-repo', 'a.txt', '--content', 'v2'), EXIT_OK, h.stderr());

    const [file] = h.fileManager.list('my-repo');
    assert.strictEqual(file.Content, 'v2');
    assert.strictEqual(file.Label, 'Original');
    assert.strictEqual(file.Description, 'Keep me');
    assert.strictEqual(file.Executable, true, '--executable from the add must be preserved when update omits the flag');

    assert.strictEqual(await h.run('update', '--repo', 'my-repo', 'a.txt', '--no-executable'), EXIT_OK);
    assert.strictEqual(h.fileManager.list('my-repo')[0].Executable, false);
});

test('delete removes the definition', async () => {
    const h = makeHarness();
    await h.run('add', '--repo', 'my-repo', '--file-name', 'a.txt', '--label', 'A', '--content', 'x');

    assert.strictEqual(await h.run('delete', '--repo', 'my-repo', 'a.txt'), EXIT_OK);
    assert.deepStrictEqual(h.fileManager.list('my-repo'), []);
    assert.strictEqual(await h.run('delete', '--repo', 'my-repo', 'a.txt'), EXIT_ERROR);
});

test('a sync failure after a successful save exits with the dedicated code', async () => {
    const h = makeHarness();
    h.deps.artifacts = {
        regenerateForRepository: () => { throw new Error('disk full'); },
    };
    const code = await h.run('add', '--repo', 'my-repo', '--file-name', 'a.txt', '--label', 'A', '--content', 'x');
    assert.strictEqual(code, EXIT_SYNC_FAILED);
    assert.match(h.stderr(), /disk full/);
    assert.strictEqual(h.fileManager.list('my-repo').length, 1);
});
