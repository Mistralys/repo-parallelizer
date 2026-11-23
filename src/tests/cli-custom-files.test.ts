import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { initializeStorage } from '../storage/json-storage.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { RepositoryFileManager } from '../models/repository/repository-file.manager.js';
import { ProjectManager } from '../models/project/project.manager.js';
import { WorkspaceArtifactsOrchestrator } from '../orchestration/workspace-artifacts.js';
import { RepositoryInfoSyncOrchestrator } from '../orchestration/repository-info-sync.js';
import { resolveMainFolderPath } from '../orchestration/repository-main-folder.js';
import {
    runCustomFilesCommand,
    createDefaultCustomFilesDeps,
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

// ---------------------------------------------------------------------------
// createDefaultCustomFilesDeps(): repository info sync wiring (WP-008, AC-18)
// ---------------------------------------------------------------------------

function git(args: string, cwd: string): string {
    return execSync(`git ${args}`, { cwd }).toString().trim();
}

/** Creates a minimal local "origin" git repository with one commit on `main`. */
function buildInfoSyncOrigin(base: string): string {
    const originPath = path.join(base, 'origin');
    fs.mkdirSync(originPath, { recursive: true });
    git('init -q -b main', originPath);
    git('config user.email "origin@test.local"', originPath);
    git('config user.name "Origin Author"', originPath);
    fs.writeFileSync(path.join(originPath, 'README.md'), 'hello');
    git('add .', originPath);
    git('commit -q -m initial', originPath);
    // Plain (non-bare) working copy checked out on "main" — updateInstead
    // lets its own working tree follow a push, matching the fixture pattern
    // used by repository-info-sync.test.ts.
    git('config receive.denyCurrentBranch updateInstead', originPath);
    return originPath;
}

/**
 * Runs `fn` with `config.json` written to a fresh temp directory and
 * `PARALIZER_CONFIG_PATH` pointed at it, so `createDefaultCustomFilesDeps()`
 * (which calls the real `loadConfig()`) reads this isolated config instead
 * of any real `config.json` on disk. Always restores/clears the env var.
 */
async function withDefaultDepsConfig<T>(
    base: string,
    fn: (config: ReturnType<typeof makeTestConfig>, configPath: string) => Promise<T>,
): Promise<T> {
    const config = makeTestConfig(base);
    const configPath = path.join(base, 'config.json');
    fs.mkdirSync(config.projectsFolder, { recursive: true });
    fs.mkdirSync(config.storageFolder, { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 4)}\n`, 'utf8');

    const previous = process.env['PARALIZER_CONFIG_PATH'];
    process.env['PARALIZER_CONFIG_PATH'] = configPath;
    try {
        return await fn(config, configPath);
    } finally {
        if (previous === undefined) {
            delete process.env['PARALIZER_CONFIG_PATH'];
        } else {
            process.env['PARALIZER_CONFIG_PATH'] = previous;
        }
    }
}

test('createDefaultCustomFilesDeps(): the constructed WorkspaceArtifactsOrchestrator also syncs repository info on regeneration', async () => {
    const base = makeTempDir();
    await withDefaultDepsConfig(base, async (config) => {
        initializeStorage(config);

        // Set up the repository and enable info sync using a throwaway
        // orchestrator pointed at the same storage/projects folders that
        // createDefaultCustomFilesDeps() will read from.
        const setupRepoManager = new RepositoryManager(config);
        const setupRepositoryFileManager = new RepositoryFileManager(config, setupRepoManager);
        const setupProjectManager = new ProjectManager(config, setupRepoManager);
        const setupSync = new RepositoryInfoSyncOrchestrator(config, setupRepoManager, setupRepositoryFileManager);

        const originPath = buildInfoSyncOrigin(base);
        const repoId = 'info-sync-repo';
        setupRepoManager.add({ id: repoId, url: `file://${originPath}`, name: 'Original Name' });
        await setupSync.saveSettings(repoId, { enabled: true });

        setupProjectManager.create('Info Sync Project', [repoId], undefined, 'info-sync-project');

        // Change the repository's Name so the next sync has something new
        // to write — this is what proves the CLI's own orchestrator (built
        // fresh inside createDefaultCustomFilesDeps(), not the setup one
        // above) actually performs the sync.
        setupRepoManager.update(repoId, { name: 'Updated Via CLI Wiring' });

        const deps = createDefaultCustomFilesDeps();
        deps.artifacts.regenerateProject('info-sync-project');

        const mainFolder = resolveMainFolderPath(config, repoId);
        const written = JSON.parse(
            fs.readFileSync(path.join(mainFolder, '.workspace', 'info.json'), 'utf8'),
        ) as Record<string, unknown>;
        assert.strictEqual(written['Name'], 'Updated Via CLI Wiring');
    });
});

test('createDefaultCustomFilesDeps(): regeneration leaves a repository\'s already-committed files untouched (no accidental delete pass)', async () => {
    const base = makeTempDir();
    await withDefaultDepsConfig(base, async (config) => {
        initializeStorage(config);

        const setupRepoManager = new RepositoryManager(config);
        const setupRepositoryFileManager = new RepositoryFileManager(config, setupRepoManager);
        const setupProjectManager = new ProjectManager(config, setupRepoManager);
        const setupSync = new RepositoryInfoSyncOrchestrator(config, setupRepoManager, setupRepositoryFileManager);

        const originPath = buildInfoSyncOrigin(base);
        const repoId = 'info-sync-files-repo';
        setupRepoManager.add({ id: repoId, url: `file://${originPath}`, name: 'Original Name' });
        await setupSync.saveSettings(repoId, { enabled: true });

        setupRepositoryFileManager.add(repoId, {
            Directory: '',
            FileName: 'run.sh',
            Label: 'Run',
            Description: 'Runs things.',
            Content: '#!/bin/sh\necho hi\n',
            Executable: true,
            ListInAgents: false,
        });
        setupSync.syncRepository(repoId);

        setupProjectManager.create('Info Sync Files Project', [repoId], undefined, 'info-sync-files-project');

        const mainFolder = resolveMainFolderPath(config, repoId);
        const filePath = path.join(mainFolder, '.workspace', 'files', 'run.sh');
        assert.ok(fs.existsSync(filePath), 'the setup sync should have committed the file to the managed clone');

        // The CLI's own orchestrator (built fresh inside
        // createDefaultCustomFilesDeps(), not the setup one above) must be
        // wired with a RepositoryFileManager on the same storage folder, so
        // its regeneration run computes the same non-empty file set rather
        // than an empty one that would trigger the delete pass.
        const deps = createDefaultCustomFilesDeps();
        deps.artifacts.regenerateProject('info-sync-files-project');

        assert.ok(fs.existsSync(filePath), 'the already-committed file must not have been deleted by the regeneration run');
    });
});
