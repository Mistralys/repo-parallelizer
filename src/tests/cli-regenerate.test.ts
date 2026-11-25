import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initializeStorage } from '../storage/json-storage.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { ProjectManager } from '../models/project/project.manager.js';
import { WorkspaceArtifactsOrchestrator } from '../orchestration/workspace-artifacts.js';
import {
    runRegenerateCommand,
    REGENERATE_HELP,
    type RegenerateCliDeps,
} from '../cli/regenerate.js';
import { EXIT_OK, EXIT_ERROR, EXIT_SYNC_FAILED } from '../cli/file-command-helpers.js';
import { createTempDirTracker, makeTestConfig } from './test-helpers.js';

const makeTempDir = createTempDirTracker('paralizer-cli-regenerate-test-');

interface Harness {
    run: (...args: string[]) => Promise<number>;
    stdout: () => string;
    stderr: () => string;
    calls: string[];
    storageSnapshot: () => string;
    workspaceFile: (project: string, ws: string, name: string) => string;
}

function snapshotDir(dir: string): string {
    const entries: string[] = [];
    const walk = (d: string): void => {
        for (const name of fs.readdirSync(d).sort()) {
            const full = path.join(d, name);
            if (fs.statSync(full).isDirectory()) walk(full);
            else entries.push(`${full}\n${fs.readFileSync(full, 'utf8')}`);
        }
    };
    walk(dir);
    return entries.join('\n---\n');
}

/** Two projects (each gets a default STABLE workspace; DEV is added); `failOn` makes the real regeneration throw for "project/ws". */
function makeHarness(failOn: string[] = []): Harness {
    const base = makeTempDir();
    const config = makeTestConfig(base);
    initializeStorage(config);
    const repoManager = new RepositoryManager(config);
    const projectManager = new ProjectManager(config, repoManager);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create('Alpha', ['repo'], undefined, 'alpha');
    projectManager.create('Beta', ['repo'], undefined, 'beta');
    for (const [p, w] of [['alpha', 'DEV'], ['alpha', 'STABLE'], ['beta', 'DEV'], ['beta', 'STABLE']]) {
        projectManager.addWorkspace(p, w, { Description: `${p} ${w}`, Notes: '', DateCreated: '2026-01-01T00:00:00.000Z', DateModified: '2026-01-01T00:00:00.000Z' });
        fs.mkdirSync(path.join(config.projectsFolder, p, w), { recursive: true });
    }
    const real = new WorkspaceArtifactsOrchestrator(config, projectManager, repoManager);

    const calls: string[] = [];
    let out = '';
    let err = '';
    const deps: RegenerateCliDeps = {
        projectManager,
        artifacts: {
            regenerateWorkspace: (p, w) => {
                calls.push(`${p}/${w}`);
                if (failOn.includes(`${p}/${w}`)) throw new Error('boom');
                real.regenerateWorkspace(p, w);
            },
        },
        out: (t) => { out += t; },
        err: (t) => { err += t; },
    };
    return {
        run: (...args) => runRegenerateCommand(args, deps),
        stdout: () => out,
        stderr: () => err,
        calls,
        storageSnapshot: () => snapshotDir(config.storageFolder),
        workspaceFile: (p, w, n) => path.join(config.projectsFolder, p, w, n),
    };
}

test('help prints the documentation and exits 0', async () => {
    const h = makeHarness();
    assert.strictEqual(await h.run('help'), EXIT_OK);
    assert.ok(h.stdout().includes(REGENERATE_HELP));
});

test('no arguments regenerates every workspace of every project', async () => {
    const h = makeHarness();
    assert.strictEqual(await h.run(), EXIT_OK);
    assert.deepStrictEqual([...h.calls].sort(), ['alpha/DEV', 'alpha/STABLE', 'beta/DEV', 'beta/STABLE']);
    assert.ok(fs.existsSync(h.workspaceFile('alpha', 'DEV', 'AGENTS.md')));
    assert.match(h.stdout(), /alpha\/DEV: ok/);
});

test('a project ID regenerates that project only', async () => {
    const h = makeHarness();
    assert.strictEqual(await h.run('alpha'), EXIT_OK);
    assert.deepStrictEqual([...h.calls].sort(), ['alpha/DEV', 'alpha/STABLE']);
});

test('--workspace regenerates that workspace only', async () => {
    const h = makeHarness();
    assert.strictEqual(await h.run('alpha', '--workspace', 'STABLE'), EXIT_OK);
    assert.deepStrictEqual(h.calls, ['alpha/STABLE']);
});

test('usage errors and unknown project/workspace exit 1 without regenerating', async () => {
    const h = makeHarness();
    assert.strictEqual(await h.run('nope'), EXIT_ERROR);
    assert.strictEqual(await h.run('alpha', '--workspace', 'NOPE'), EXIT_ERROR);
    assert.strictEqual(await h.run('--workspace', 'DEV'), EXIT_ERROR);
    assert.strictEqual(await h.run('a', 'b'), EXIT_ERROR);
    assert.strictEqual(await h.run('--bogus'), EXIT_ERROR);
    assert.deepStrictEqual(h.calls, []);
    assert.match(h.stderr(), /does not exist/);
});

test('one failing workspace does not stop the others: one line each, exit 2', async () => {
    const h = makeHarness(['alpha/DEV']);
    assert.strictEqual(await h.run(), EXIT_SYNC_FAILED);
    assert.deepStrictEqual([...h.calls].sort(), ['alpha/DEV', 'alpha/STABLE', 'beta/DEV', 'beta/STABLE']);
    const lines = h.stdout().trim().split('\n');
    assert.strictEqual(lines.length, 4);
    assert.ok(lines.includes('alpha/DEV: failed: boom'));
    assert.ok(lines.includes('beta/DEV: ok'));
});

test('T-12: regenerate writes no stored project data', async () => {
    const h = makeHarness();
    const before = h.storageSnapshot();
    assert.strictEqual(await h.run(), EXIT_OK);
    assert.strictEqual(h.storageSnapshot(), before);
});
