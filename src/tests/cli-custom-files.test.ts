import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initializeStorage } from '../storage/json-storage.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { ProjectManager } from '../models/project/project.manager.js';
import { WorkspaceArtifactsOrchestrator } from '../orchestration/workspace-artifacts.js';
import {
    runCustomFilesCommand,
    EXIT_OK,
    EXIT_ERROR,
    EXIT_SYNC_FAILED,
    type CustomFilesCliDeps,
} from '../cli/custom-files.js';
import { createTempDirTracker, makeTestConfig } from './test-helpers.js';

const makeTempDir = createTempDirTracker('paralizer-cli-custom-files-test-');

interface Harness {
    deps: CustomFilesCliDeps;
    projectsFolder: string;
    stdout: () => string;
    stderr: () => string;
    run: (...args: string[]) => Promise<number>;
    workspacePath: (...segments: string[]) => string;
}

function makeHarness(stdin = ''): Harness {
    const base = makeTempDir();
    const config = makeTestConfig(base);
    initializeStorage(config);
    const repoManager = new RepositoryManager(config);
    const projectManager = new ProjectManager(config, repoManager);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create('Demo', ['repo'], undefined, 'demo');
    // Workspace folders must exist for the artefact writer to write into them.
    fs.mkdirSync(path.join(config.projectsFolder, 'demo', 'STABLE'), { recursive: true });
    const artifacts = new WorkspaceArtifactsOrchestrator(config, projectManager, repoManager);

    let out = '';
    let err = '';
    const deps: CustomFilesCliDeps = {
        projectManager,
        artifacts,
        readStdin: async () => stdin,
        out: (t) => { out += t; },
        err: (t) => { err += t; },
    };
    return {
        deps,
        projectsFolder: config.projectsFolder,
        stdout: () => out,
        stderr: () => err,
        run: (...args) => runCustomFilesCommand(args, deps),
        workspacePath: (...segments) => path.join(config.projectsFolder, 'demo', 'STABLE', ...segments),
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
    assert.match(h.stdout(), /paralizer custom-files <subcommand>/);
    assert.strictEqual(await h.run(), EXIT_ERROR);
});

test('add from a content file syncs the file into the workspace and marks scripts executable', async () => {
    const h = makeHarness();
    const src = writeTemp('#!/bin/sh\necho hi\n');
    const code = await h.run('add', 'demo', '--directory', 'scripts', '--file-name', 'run.sh', '--label', 'Run', '--content-file', src);
    assert.strictEqual(code, EXIT_OK, h.stderr());
    assert.strictEqual(fs.readFileSync(h.workspacePath('scripts', 'run.sh'), 'utf8'), '#!/bin/sh\necho hi\n');
    assert.match(h.stdout(), /executable/);
});

test('add reads content from stdin and --list-in-agents lists it in the workspace AGENTS.md', async () => {
    const h = makeHarness('hello\n');
    const code = await h.run('add', 'demo', '--file-name', 'note.txt', '--label', 'Note', '--stdin', '--list-in-agents');
    assert.strictEqual(code, EXIT_OK, h.stderr());
    assert.strictEqual(fs.readFileSync(h.workspacePath('note.txt'), 'utf8'), 'hello\n');
    assert.match(fs.readFileSync(h.workspacePath('AGENTS.md'), 'utf8'), /note\.txt/);
});

test('add without a content source or required options fails with exit 1 and changes nothing', async () => {
    const h = makeHarness();
    assert.strictEqual(await h.run('add', 'demo', '--file-name', 'a.txt', '--label', 'A'), EXIT_ERROR);
    assert.strictEqual(await h.run('add', 'demo', '--content', 'x'), EXIT_ERROR);
    assert.deepStrictEqual(h.deps.projectManager.listCustomFiles('demo'), []);
});

test('add rejects conflicting content sources and unknown options', async () => {
    const h = makeHarness();
    assert.strictEqual(await h.run('add', 'demo', '--file-name', 'a.txt', '--label', 'A', '--content', 'x', '--stdin'), EXIT_ERROR);
    assert.match(h.stderr(), /only one of/);
    assert.strictEqual(await h.run('add', 'demo', '--bogus'), EXIT_ERROR);
});

test('validation errors from the model layer are reported (path escape, reserved name)', async () => {
    const h = makeHarness();
    assert.strictEqual(await h.run('add', 'demo', '--directory', '../x', '--file-name', 'a.txt', '--label', 'A', '--content', 'x'), EXIT_ERROR);
    assert.strictEqual(await h.run('add', 'demo', '--file-name', 'AGENTS.md', '--label', 'A', '--content', 'x'), EXIT_ERROR);
    assert.deepStrictEqual(h.deps.projectManager.listCustomFiles('demo'), []);
});

test('unknown project exits 1', async () => {
    const h = makeHarness();
    assert.strictEqual(await h.run('list', 'nope'), EXIT_ERROR);
});

test('list and show work by path, id and unique id prefix; show prints raw content', async () => {
    const h = makeHarness();
    await h.run('add', 'demo', '--directory', 'docs', '--file-name', 'a.md', '--label', 'A', '--content', 'alpha');
    const [file] = h.deps.projectManager.listCustomFiles('demo');

    const listed = makeHarness();
    assert.strictEqual(await listed.run('list', 'demo'), EXIT_OK);
    assert.match(listed.stdout(), /No custom files/);

    h.deps.out = () => undefined;
    let shown = '';
    h.deps.out = (t) => { shown += t; };
    for (const ref of ['docs/a.md', 'DOCS\\a.md', file.Id, file.Id.slice(0, 6)]) {
        shown = '';
        assert.strictEqual(await h.run('show', 'demo', ref), EXIT_OK, ref);
        assert.strictEqual(shown, 'alpha');
    }
    shown = '';
    assert.strictEqual(await h.run('list', 'demo', '--json'), EXIT_OK);
    assert.strictEqual((JSON.parse(shown) as unknown[]).length, 1);
    assert.strictEqual(await h.run('show', 'demo', 'missing.txt'), EXIT_ERROR);
});

test('update changes only the given fields and re-syncs the content', async () => {
    const h = makeHarness();
    await h.run('add', 'demo', '--file-name', 'a.txt', '--label', 'Original', '--description', 'Keep me', '--content', 'v1', '--list-in-agents');
    assert.strictEqual(await h.run('update', 'demo', 'a.txt', '--content', 'v2'), EXIT_OK, h.stderr());

    const [file] = h.deps.projectManager.listCustomFiles('demo');
    assert.strictEqual(file.Content, 'v2');
    assert.strictEqual(file.Label, 'Original');
    assert.strictEqual(file.Description, 'Keep me');
    assert.strictEqual(file.ListInAgents, true);
    assert.strictEqual(fs.readFileSync(h.workspacePath('a.txt'), 'utf8'), 'v2');

    assert.strictEqual(await h.run('update', 'demo', 'a.txt', '--no-list-in-agents'), EXIT_OK);
    assert.strictEqual(h.deps.projectManager.listCustomFiles('demo')[0].ListInAgents, false);
});

test('update that moves or renames a file removes the old copy', async () => {
    const h = makeHarness();
    await h.run('add', 'demo', '--directory', 'old', '--file-name', 'a.txt', '--label', 'A', '--content', 'x');
    assert.ok(fs.existsSync(h.workspacePath('old', 'a.txt')));

    assert.strictEqual(await h.run('update', 'demo', 'old/a.txt', '--directory', 'new', '--file-name', 'b.txt'), EXIT_OK, h.stderr());
    assert.ok(!fs.existsSync(h.workspacePath('old', 'a.txt')));
    assert.ok(!fs.existsSync(h.workspacePath('old')), 'emptied directory is pruned');
    assert.strictEqual(fs.readFileSync(h.workspacePath('new', 'b.txt'), 'utf8'), 'x');
});

test('delete removes the definition and the copies; a failed validation leaves the file untouched', async () => {
    const h = makeHarness();
    await h.run('add', 'demo', '--file-name', 'a.txt', '--label', 'A', '--content', 'x');
    assert.strictEqual(await h.run('update', 'demo', 'a.txt', '--file-name', 'bad/name'), EXIT_ERROR);
    assert.ok(fs.existsSync(h.workspacePath('a.txt')));

    assert.strictEqual(await h.run('delete', 'demo', 'a.txt'), EXIT_OK);
    assert.deepStrictEqual(h.deps.projectManager.listCustomFiles('demo'), []);
    assert.ok(!fs.existsSync(h.workspacePath('a.txt')));
    assert.strictEqual(await h.run('delete', 'demo', 'a.txt'), EXIT_ERROR);
});

test('a sync failure after a successful save exits with the dedicated code', async () => {
    const h = makeHarness();
    h.deps.artifacts = {
        regenerateProject: () => { throw new Error('disk full'); },
        removeCustomFileCopies: () => undefined,
    };
    const code = await h.run('add', 'demo', '--file-name', 'a.txt', '--label', 'A', '--content', 'x');
    assert.strictEqual(code, EXIT_SYNC_FAILED);
    assert.match(h.stderr(), /disk full/);
    assert.strictEqual(h.deps.projectManager.listCustomFiles('demo').length, 1);
});
