import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initializeStorage } from '../storage/json-storage.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { ProjectManager } from '../models/project/project.manager.js';
import { WorkspaceArtifactsOrchestrator } from '../orchestration/workspace-artifacts.js';
import {
    runDirectivesCommand,
    EXIT_OK,
    EXIT_ERROR,
    EXIT_SYNC_FAILED,
    type DirectivesCliDeps,
} from '../cli/directives.js';
import { createTempDirTracker, makeTestConfig } from './test-helpers.js';

const makeTempDir = createTempDirTracker('paralizer-cli-directives-test-');

interface Calls {
    refresh: string[];
    regenerate: string[];
}

function makeHarness(options: { stdin?: string; failedWorkspaces?: boolean } = {}) {
    const base = makeTempDir();
    const config = makeTestConfig(base);
    initializeStorage(config);
    const repoManager = new RepositoryManager(config);
    const projectManager = new ProjectManager(config, repoManager);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create('Demo', ['repo'], undefined, 'demo');
    const ts = '2026-01-01T00:00:00.000Z';
    projectManager.addWorkspace('demo', 'DEV', { Description: 'dev', DateCreated: ts, DateModified: ts });
    for (const ws of ['STABLE', 'DEV']) {
        fs.mkdirSync(path.join(config.projectsFolder, 'demo', ws), { recursive: true });
    }
    const real = new WorkspaceArtifactsOrchestrator(config, projectManager, repoManager);

    const calls: Calls = { refresh: [], regenerate: [] };
    let out = '';
    let err = '';
    const deps: DirectivesCliDeps = {
        projectManager,
        artifacts: {
            refreshProjectIndexes: (id) => {
                calls.refresh.push(id);
                return options.failedWorkspaces
                    ? { refreshed: [], failed: [{ workspaceId: 'DEV', error: 'boom' }] }
                    : real.refreshProjectIndexes(id);
            },
            regenerateWorkspace: (id, ws) => {
                calls.regenerate.push(`${id}/${ws}`);
                real.regenerateWorkspace(id, ws);
            },
        },
        readStdin: async () => options.stdin ?? '',
        out: (t) => { out += t; },
        err: (t) => { err += t; },
    };
    return {
        calls,
        projectManager,
        stdout: () => out,
        stderr: () => err,
        run: (...args: string[]) => runDirectivesCommand(args, deps),
    };
}

// T-33

test('help exits 0; no subcommand exits 1; unknown subcommand exits 1', async () => {
    const h = makeHarness();
    assert.strictEqual(await h.run('help'), EXIT_OK);
    assert.match(h.stdout(), /paralizer directives <subcommand>/);
    assert.strictEqual(await h.run(), EXIT_ERROR);
    assert.strictEqual(await h.run('bogus'), EXIT_ERROR);
});

test('project scope: add/list/update/delete, refreshing all workspaces', async () => {
    const h = makeHarness();
    assert.strictEqual(await h.run('list', 'demo'), EXIT_OK);
    assert.match(h.stdout(), /No project directives/);

    assert.strictEqual(await h.run('add', 'demo', '--text', 'Release dependencies first.'), EXIT_OK, h.stderr());
    assert.deepStrictEqual(h.calls.refresh, ['demo']);

    const [d] = h.projectManager.listDirectives('demo', { kind: 'project' });
    assert.strictEqual(await h.run('update', 'demo', d.Id.slice(0, 6), '--text', 'Changed.'), EXIT_OK, h.stderr());
    assert.strictEqual(h.projectManager.listDirectives('demo', { kind: 'project' })[0].Text, 'Changed.');

    assert.strictEqual(await h.run('delete', 'demo', d.Id), EXIT_OK, h.stderr());
    assert.deepStrictEqual(h.projectManager.listDirectives('demo', { kind: 'project' }), []);
    assert.deepStrictEqual(h.calls.regenerate, []);
});

test('workspace scope: --workspace maps to workspace scope and regenerates only that workspace', async () => {
    const h = makeHarness();
    assert.strictEqual(await h.run('add', 'demo', '--workspace', 'DEV', '--text', 'Dev only.'), EXIT_OK, h.stderr());
    assert.deepStrictEqual(h.calls.regenerate, ['demo/DEV']);
    assert.deepStrictEqual(h.calls.refresh, []);
    assert.deepStrictEqual(h.projectManager.listDirectives('demo', { kind: 'project' }), []);
    const [d] = h.projectManager.listDirectives('demo', { kind: 'workspace', workspaceId: 'DEV' });
    assert.strictEqual(d.Text, 'Dev only.');

    assert.strictEqual(await h.run('delete', 'demo', d.Id, '--workspace', 'DEV'), EXIT_OK, h.stderr());
    assert.deepStrictEqual(h.projectManager.listDirectives('demo', { kind: 'workspace', workspaceId: 'DEV' }), []);
});

test('--json list and --stdin text', async () => {
    const h = makeHarness({ stdin: 'From\nstdin\n' });
    assert.strictEqual(await h.run('add', 'demo', '--stdin'), EXIT_OK, h.stderr());
    const out = h.stdout().length;
    assert.strictEqual(await h.run('list', 'demo', '--json'), EXIT_OK);
    const parsed = JSON.parse(h.stdout().slice(out));
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].Text, 'From stdin');
});

test('an empty --workspace value is a usage error and changes nothing', async () => {
    const h = makeHarness();
    assert.strictEqual(await h.run('add', 'demo', '--workspace', '', '--text', 'x'), EXIT_ERROR);
    assert.match(h.stderr(), /--workspace requires a workspace ID/);
    assert.strictEqual(await h.run('list', 'demo', '--workspace', ''), EXIT_ERROR);
    assert.deepStrictEqual(h.projectManager.listDirectives('demo', { kind: 'project' }), []);
});

test('usage and validation errors exit 1', async () => {
    const h = makeHarness();
    assert.strictEqual(await h.run('add', 'demo'), EXIT_ERROR);
    assert.match(h.stderr(), /text source/);
    assert.strictEqual(await h.run('add', 'demo', '--text', 'a', '--stdin'), EXIT_ERROR);
    assert.strictEqual(await h.run('add', 'demo', '--text', '   '), EXIT_ERROR);
    assert.strictEqual(await h.run('add', 'missing', '--text', 'a'), EXIT_ERROR);
    assert.strictEqual(await h.run('add', 'demo', '--workspace', 'NOPE', '--text', 'a'), EXIT_ERROR);
    assert.strictEqual(await h.run('update', 'demo', 'zzzzzz', '--text', 'a'), EXIT_ERROR);
    assert.match(h.stderr(), /No directive matches/);
    assert.strictEqual(await h.run('delete', 'demo'), EXIT_ERROR);
});

test('project scope exits 2 when refreshProjectIndexes reports a failed workspace; the directive is saved', async () => {
    const h = makeHarness({ failedWorkspaces: true });
    assert.strictEqual(await h.run('add', 'demo', '--text', 'Saved anyway.'), EXIT_SYNC_FAILED);
    assert.match(h.stderr(), /saved, but syncing/);
    assert.match(h.stderr(), /boom/);
    assert.strictEqual(h.projectManager.listDirectives('demo', { kind: 'project' }).length, 1);
});
