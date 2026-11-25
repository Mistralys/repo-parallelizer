import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initializeStorage } from '../storage/json-storage.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { ProjectManager } from '../models/project/project.manager.js';
import { WorkspaceArtifactsOrchestrator } from '../orchestration/workspace-artifacts.js';
import {
    runRepoRolesCommand,
    EXIT_OK,
    EXIT_ERROR,
    EXIT_SYNC_FAILED,
    type RepoRolesCliDeps,
} from '../cli/repo-roles.js';
import { createTempDirTracker, makeTestConfig } from './test-helpers.js';

const makeTempDir = createTempDirTracker('paralizer-cli-repo-roles-test-');

function makeHarness(options: { failedWorkspaces?: boolean } = {}) {
    const base = makeTempDir();
    const config = makeTestConfig(base);
    initializeStorage(config);
    const repoManager = new RepositoryManager(config);
    const projectManager = new ProjectManager(config, repoManager);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create('Demo', ['repo'], undefined, 'demo');
    fs.mkdirSync(path.join(config.projectsFolder, 'demo', 'STABLE'), { recursive: true });
    const real = new WorkspaceArtifactsOrchestrator(config, projectManager, repoManager);

    const refresh: string[] = [];
    let out = '';
    let err = '';
    const deps: RepoRolesCliDeps = {
        projectManager,
        artifacts: {
            refreshProjectIndexes: (id) => {
                refresh.push(id);
                return options.failedWorkspaces
                    ? { refreshed: [], failed: [{ workspaceId: 'STABLE', error: 'boom' }] }
                    : real.refreshProjectIndexes(id);
            },
        },
        out: (t) => { out += t; },
        err: (t) => { err += t; },
    };
    return {
        refresh,
        projectManager,
        stdout: () => out,
        stderr: () => err,
        run: (...args: string[]) => runRepoRolesCommand(args, deps),
    };
}

// T-34

test('help exits 0; no subcommand exits 1; unknown subcommand exits 1', async () => {
    const h = makeHarness();
    assert.strictEqual(await h.run('help'), EXIT_OK);
    assert.match(h.stdout(), /paralizer repo-roles <subcommand>/);
    assert.strictEqual(await h.run(), EXIT_ERROR);
    assert.strictEqual(await h.run('bogus'), EXIT_ERROR);
});

test('set, list, clear round-trip and refresh the project indexes', async () => {
    const h = makeHarness();

    assert.strictEqual(await h.run('set', 'demo', 'repo', '--text', 'Shared\nlibrary.'), EXIT_OK);
    assert.deepStrictEqual(h.projectManager.getRepositoryRoles('demo'), { repo: 'Shared library.' });
    assert.deepStrictEqual(h.refresh, ['demo']);

    assert.strictEqual(await h.run('list', 'demo'), EXIT_OK);
    assert.match(h.stdout(), /repo\n {4}Shared library\./);

    assert.strictEqual(await h.run('clear', 'demo', 'repo'), EXIT_OK);
    assert.deepStrictEqual(h.projectManager.getRepositoryRoles('demo'), {});
    assert.deepStrictEqual(h.refresh, ['demo', 'demo']);
});

test('list --json outputs every repository, optionally filtered', async () => {
    const h = makeHarness();
    h.projectManager.setRepositoryRole('demo', 'repo', 'Role.');

    assert.strictEqual(await h.run('list', 'demo', '--json'), EXIT_OK);
    assert.deepStrictEqual(JSON.parse(h.stdout()), [{ repositoryId: 'repo', role: 'Role.' }]);

    const filtered = makeHarness();
    assert.strictEqual(await filtered.run('list', 'demo', 'repo', '--json'), EXIT_OK);
    assert.deepStrictEqual(JSON.parse(filtered.stdout()), [{ repositoryId: 'repo', role: '' }]);
});

test('validation errors and unknown project/repository exit 1 without changes', async () => {
    const h = makeHarness();
    assert.strictEqual(await h.run('set', 'demo', 'repo'), EXIT_ERROR);
    assert.strictEqual(await h.run('set', 'demo', 'repo', '--text', '   '), EXIT_ERROR);
    assert.strictEqual(await h.run('set', 'demo', 'repo', '--text', 'x'.repeat(501)), EXIT_ERROR);
    assert.strictEqual(await h.run('set', 'nope', 'repo', '--text', 'x'), EXIT_ERROR);
    assert.strictEqual(await h.run('set', 'demo', 'nope', '--text', 'x'), EXIT_ERROR);
    assert.strictEqual(await h.run('clear', 'demo', 'nope'), EXIT_ERROR);
    assert.strictEqual(await h.run('list', 'nope'), EXIT_ERROR);
    assert.strictEqual(await h.run('list', 'demo', 'nope'), EXIT_ERROR);
    assert.strictEqual(await h.run('clear', 'demo'), EXIT_ERROR);
    assert.deepStrictEqual(h.projectManager.getRepositoryRoles('demo'), {});
    assert.deepStrictEqual(h.refresh, []);
});

test('exit 2 when refreshProjectIndexes reports a failed workspace; role stays saved', async () => {
    const h = makeHarness({ failedWorkspaces: true });
    assert.strictEqual(await h.run('set', 'demo', 'repo', '--text', 'Role.'), EXIT_SYNC_FAILED);
    assert.match(h.stderr(), /workspace "STABLE": boom/);
    assert.deepStrictEqual(h.projectManager.getRepositoryRoles('demo'), { repo: 'Role.' });
});
