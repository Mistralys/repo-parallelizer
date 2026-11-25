import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initializeStorage } from '../storage/json-storage.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { ProjectManager } from '../models/project/project.manager.js';
import type { DirectiveScope } from '../models/project/directive.js';
import { NotFoundError } from '../errors.js';
import { createTempDirTracker, makeTestConfig } from './test-helpers.js';

const makeTempDir = createTempDirTracker('paralizer-directives-test-');

function setup() {
    const base = makeTempDir();
    const config = makeTestConfig(base);
    initializeStorage(config);
    const repoManager = new RepositoryManager(config);
    const pm = new ProjectManager(config, repoManager);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    pm.create('Alpha', ['repo'], undefined, 'alpha');
    const ts = '2026-01-01T00:00:00.000Z';
    pm.addWorkspace('alpha', 'DEV', { Description: 'dev', DateCreated: ts, DateModified: ts });
    return { config, pm };
}

const PROJECT: DirectiveScope = { kind: 'project' };
const DEV: DirectiveScope = { kind: 'workspace', workspaceId: 'DEV' };

// T-20

test('project scope: add/list/update/remove with UUID ids and persistence', () => {
    const { config, pm } = setup();
    const added = pm.addDirective('alpha', PROJECT, { Text: 'Be kind' });
    assert.match(added.Id, /^[0-9a-f-]{36}$/);
    assert.deepStrictEqual(pm.listDirectives('alpha', PROJECT), [added]);

    const stored = JSON.parse(fs.readFileSync(path.join(config.storageFolder, 'projects', 'alpha.json'), 'utf-8'));
    assert.strictEqual(stored.Directives[0].Text, 'Be kind');

    const updated = pm.updateDirective('alpha', PROJECT, added.Id, { Text: 'Be very kind' });
    assert.strictEqual(updated.Id, added.Id);
    assert.strictEqual(pm.listDirectives('alpha', PROJECT)[0].Text, 'Be very kind');

    const removed = pm.removeDirective('alpha', PROJECT, added.Id);
    assert.strictEqual(removed.Id, added.Id);
    assert.deepStrictEqual(pm.listDirectives('alpha', PROJECT), []);
});

test('project scope: NotFoundError for unknown project and directive', () => {
    const { pm } = setup();
    assert.throws(() => pm.listDirectives('nope', PROJECT), NotFoundError);
    assert.throws(() => pm.addDirective('nope', PROJECT, { Text: 'x' }), NotFoundError);
    assert.throws(() => pm.updateDirective('alpha', PROJECT, 'missing', { Text: 'x' }), NotFoundError);
    assert.throws(() => pm.removeDirective('alpha', PROJECT, 'missing'), NotFoundError);
});

test('workspace scope: blank or missing workspaceId is a validation error, not NotFound', () => {
    const { pm } = setup();
    for (const id of ['', '   ', undefined]) {
        const scope = { kind: 'workspace', workspaceId: id } as unknown as DirectiveScope;
        assert.throws(() => pm.addDirective('alpha', scope, { Text: 'x' }), (e: Error) => !(e instanceof NotFoundError) && /workspace ID is required/.test(e.message));
        assert.throws(() => pm.listDirectives('alpha', scope), /workspace ID is required/);
    }
});

test('missing scope is rejected: no implicit default', () => {
    const { pm } = setup();
    assert.throws(() => pm.addDirective('alpha', undefined as unknown as DirectiveScope, { Text: 'x' }), /scope is required/);
    assert.deepStrictEqual(pm.listDirectives('alpha', PROJECT), []);
});

test('scopes are independent', () => {
    const { pm } = setup();
    pm.addDirective('alpha', PROJECT, { Text: 'same' });
    pm.addDirective('alpha', DEV, { Text: 'same' });
    assert.strictEqual(pm.listDirectives('alpha', PROJECT).length, 1);
    assert.strictEqual(pm.listDirectives('alpha', DEV).length, 1);
});

test('duplicate within the same scope is rejected', () => {
    const { pm } = setup();
    pm.addDirective('alpha', PROJECT, { Text: 'Same' });
    assert.throws(() => pm.addDirective('alpha', PROJECT, { Text: 'same' }), /already exists/);
});

test('add/update/remove refresh DateModified of directive and project', async () => {
    const { pm } = setup();
    const before = pm.getById('alpha')!.DateModified;
    await new Promise((r) => setTimeout(r, 5));
    const d = pm.addDirective('alpha', PROJECT, { Text: 'one' });
    const afterAdd = pm.getById('alpha')!.DateModified;
    assert.notStrictEqual(afterAdd, before);
    assert.strictEqual(d.DateModified, afterAdd);

    await new Promise((r) => setTimeout(r, 5));
    const u = pm.updateDirective('alpha', PROJECT, d.Id, { Text: 'two' });
    const afterUpdate = pm.getById('alpha')!.DateModified;
    assert.notStrictEqual(afterUpdate, afterAdd);
    assert.notStrictEqual(u.DateModified, d.DateModified);
    assert.strictEqual(u.DateModified, afterUpdate);

    await new Promise((r) => setTimeout(r, 5));
    pm.removeDirective('alpha', PROJECT, d.Id);
    assert.notStrictEqual(pm.getById('alpha')!.DateModified, afterUpdate);
});

// T-21

test('workspace scope: CRUD, NotFound for unknown workspace', () => {
    const { pm } = setup();
    const d = pm.addDirective('alpha', DEV, { Text: 'dev only' });
    assert.deepStrictEqual(pm.listDirectives('alpha', DEV), [d]);
    assert.deepStrictEqual(pm.listDirectives('alpha', PROJECT), []);
    pm.updateDirective('alpha', DEV, d.Id, { Text: 'dev only 2' });
    assert.strictEqual(pm.listDirectives('alpha', DEV)[0].Text, 'dev only 2');
    assert.throws(() => pm.addDirective('alpha', { kind: 'workspace', workspaceId: 'NOPE' }, { Text: 'x' }), NotFoundError);
    pm.removeDirective('alpha', DEV, d.Id);
    assert.deepStrictEqual(pm.listDirectives('alpha', DEV), []);
});

test('workspace directives survive renameWorkspace and vanish on removeWorkspace', () => {
    const { pm } = setup();
    const d = pm.addDirective('alpha', DEV, { Text: 'travels' });
    pm.renameWorkspace('alpha', 'DEV', 'TEST', '2026-02-01T00:00:00.000Z');
    assert.deepStrictEqual(pm.listDirectives('alpha', { kind: 'workspace', workspaceId: 'TEST' }), [d]);
    assert.throws(() => pm.listDirectives('alpha', DEV), NotFoundError);

    pm.removeWorkspace('alpha', 'TEST');
    assert.strictEqual(pm.getById('alpha')!.Workspaces['TEST'], undefined);
    assert.ok(!JSON.stringify(pm.getById('alpha')).includes('travels'));
});

// T-22

test('legacy project JSON without Directives loads and lists []; schema unchanged', () => {
    const { config, pm } = setup();
    const file = path.join(config.storageFolder, 'projects', 'alpha.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.strictEqual('Directives' in raw, false);
    assert.strictEqual(raw.SchemaVersion, 1);
    assert.deepStrictEqual(pm.listDirectives('alpha', PROJECT), []);
    assert.deepStrictEqual(pm.listDirectives('alpha', DEV), []);
    pm.addDirective('alpha', PROJECT, { Text: 'x' });
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).SchemaVersion, 1);
});

test('inherited Object.prototype keys are not resolved as workspace IDs', () => {
    const { pm } = setup();
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
        const scope: DirectiveScope = { kind: 'workspace', workspaceId: id };
        assert.throws(() => pm.listDirectives('alpha', scope), NotFoundError, id);
        assert.throws(() => pm.addDirective('alpha', scope, { Text: 'x' }), NotFoundError, id);
    }
    assert.strictEqual(({} as { Directives?: unknown }).Directives, undefined);
});

// T-23

test('repository roles: set, replace, clear, persist and reject unknown repository', () => {
    const { config, pm } = setup();
    assert.deepStrictEqual(pm.getRepositoryRoles('alpha'), {});

    assert.strictEqual(pm.setRepositoryRole('alpha', 'repo', ' Core\nlibrary '), 'Core library');
    assert.deepStrictEqual(pm.getRepositoryRoles('alpha'), { repo: 'Core library' });
    const file = path.join(config.storageFolder, 'projects', 'alpha.json');
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).RepositoryRoles.repo, 'Core library');

    pm.setRepositoryRole('alpha', 'repo', 'Other');
    assert.strictEqual(pm.getRepositoryRoles('alpha').repo, 'Other');

    assert.strictEqual(pm.setRepositoryRole('alpha', 'repo', '  '), '');
    assert.deepStrictEqual(pm.getRepositoryRoles('alpha'), {});
    assert.strictEqual('RepositoryRoles' in JSON.parse(fs.readFileSync(file, 'utf-8')), false);

    assert.throws(() => pm.setRepositoryRole('alpha', 'nope', 'x'), NotFoundError);
    assert.throws(() => pm.setRepositoryRole('missing', 'repo', 'x'), NotFoundError);
    assert.throws(() => pm.setRepositoryRole('alpha', 'repo', 'x'.repeat(501)), /at most 500/);
    assert.throws(() => pm.setRepositoryRole('alpha', 'repo', 'a paralizer:generated:end b'), /marker/);
    assert.throws(() => pm.getRepositoryRoles('missing'), NotFoundError);
});

test('repository roles: removeRepository drops the role; legacy JSON loads with empty map', () => {
    const { config, pm } = setup();
    pm.setRepositoryRole('alpha', 'repo', 'Core');
    pm.removeRepository('alpha', 'repo');
    assert.deepStrictEqual(pm.getRepositoryRoles('alpha'), {});
    const file = path.join(config.storageFolder, 'projects', 'alpha.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.strictEqual('RepositoryRoles' in stored, false);

    delete stored.RepositoryRoles;
    const schemaVersion = stored.SchemaVersion;
    fs.writeFileSync(file, JSON.stringify(stored, null, 2));
    assert.deepStrictEqual(pm.getRepositoryRoles('alpha'), {});
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).SchemaVersion, schemaVersion);
});
