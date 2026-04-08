import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import type { AppConfig } from '../config/config.types.js';
import { initializeStorage } from '../storage/json-storage.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { ProjectManager } from '../models/project/project.manager.js';
import { WorkspaceManager } from '../models/workspace/workspace.manager.js';
import { NotFoundError } from '../errors.js';

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-workspace-test-'));
}

function makeTestConfig(base: string): AppConfig {
    return {
        storageFolder: path.join(base, 'storage'),
        projectsFolder: path.join(base, 'projects'),
        cloneDepth: 50,
        serverPort: 4200,
        gitPollingIntervalSeconds: 30,
    };
}

function makeManagers(base: string) {
    const config = makeTestConfig(base);
    initializeStorage(config);
    const repoManager = new RepositoryManager(config);
    const projectManager = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);
    return { config, repoManager, projectManager, workspaceManager };
}

/** Helper: creates a project with one repository and returns its ID. */
function makeProject(
    projectManager: ProjectManager,
    repoManager: RepositoryManager,
    name = 'Test Project',
    id = 'test-project',
): string {
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create(name, ['repo'], undefined, id);
    return id;
}

// ─── isStable ────────────────────────────────────────────────────────────────

test('isStable returns true for "STABLE"', () => {
    const { workspaceManager } = makeManagers(makeTempDir());
    assert.ok(workspaceManager.isStable('STABLE'));
});

test('isStable returns false for any other ID', () => {
    const { workspaceManager } = makeManagers(makeTempDir());
    assert.ok(!workspaceManager.isStable('DEV'));
    assert.ok(!workspaceManager.isStable('STAGING'));
    assert.ok(!workspaceManager.isStable('stable'));
    assert.ok(!workspaceManager.isStable(''));
});

// ─── list ────────────────────────────────────────────────────────────────────

test('list throws when project does not exist', () => {
    const { workspaceManager } = makeManagers(makeTempDir());
    assert.throws(
        () => workspaceManager.list('nonexistent'),
        /does not exist/,
    );
});

test('list throws NotFoundError when project does not exist', () => {
    const { workspaceManager } = makeManagers(makeTempDir());
    try {
        workspaceManager.list('nonexistent');
        assert.fail('expected an error to be thrown');
    } catch (err) {
        assert.ok(err instanceof NotFoundError);
    }
});

test('list returns STABLE workspace for a newly created project', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    const workspaces = workspaceManager.list(projectId);
    assert.strictEqual(workspaces.length, 1);
    assert.strictEqual(workspaces[0].WorkspaceID, 'STABLE');
    assert.strictEqual(workspaces[0].ProjectID, projectId);
});

test('list returns all workspaces after additional ones are created', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    workspaceManager.create(projectId, 'DEV');
    workspaceManager.create(projectId, 'QA');
    const workspaces = workspaceManager.list(projectId);
    assert.strictEqual(workspaces.length, 3);
    assert.ok(workspaces.some((w) => w.WorkspaceID === 'STABLE'));
    assert.ok(workspaces.some((w) => w.WorkspaceID === 'DEV'));
    assert.ok(workspaces.some((w) => w.WorkspaceID === 'QA'));
});

test('list WorkspaceInfo entries include all required fields', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    const [entry] = workspaceManager.list(projectId);
    assert.ok('ProjectID' in entry);
    assert.ok('WorkspaceID' in entry);
    assert.ok('Description' in entry);
    assert.ok('DateCreated' in entry);
    assert.ok('DateModified' in entry);
});

// ─── getById ─────────────────────────────────────────────────────────────────

test('getById throws when project does not exist', () => {
    const { workspaceManager } = makeManagers(makeTempDir());
    assert.throws(
        () => workspaceManager.getById('nonexistent', 'STABLE'),
        /does not exist/,
    );
});

test('getById throws NotFoundError when project does not exist', () => {
    const { workspaceManager } = makeManagers(makeTempDir());
    try {
        workspaceManager.getById('nonexistent', 'STABLE');
        assert.fail('expected an error to be thrown');
    } catch (err) {
        assert.ok(err instanceof NotFoundError);
    }
});

test('getById returns WorkspaceInfo for an existing workspace', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    const info = workspaceManager.getById(projectId, 'STABLE');
    assert.ok(info !== undefined);
    assert.strictEqual(info.ProjectID, projectId);
    assert.strictEqual(info.WorkspaceID, 'STABLE');
    assert.ok(!isNaN(Date.parse(info.DateCreated)));
    assert.ok(!isNaN(Date.parse(info.DateModified)));
});

test('getById returns undefined when workspace does not exist', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    assert.strictEqual(workspaceManager.getById(projectId, 'DEV'), undefined);
});

// ─── create ──────────────────────────────────────────────────────────────────

test('create throws for an invalid workspace ID (lowercase)', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    assert.throws(
        () => workspaceManager.create(projectId, 'dev'),
        /Invalid workspace ID/,
    );
});

test('create throws for an invalid workspace ID (too short)', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    assert.throws(
        () => workspaceManager.create(projectId, 'A'),
        /Invalid workspace ID/,
    );
});

test('create throws for an invalid workspace ID (too long)', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    assert.throws(
        () => workspaceManager.create(projectId, 'TOOLONG'),
        /Invalid workspace ID/,
    );
});

test('create throws for an invalid workspace ID (contains digit)', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    assert.throws(
        () => workspaceManager.create(projectId, 'AB1'),
        /Invalid workspace ID/,
    );
});

test('create throws when project does not exist', () => {
    const { workspaceManager } = makeManagers(makeTempDir());
    assert.throws(
        () => workspaceManager.create('nonexistent', 'DEV'),
        /does not exist/,
    );
});

test('create throws NotFoundError when project does not exist', () => {
    const { workspaceManager } = makeManagers(makeTempDir());
    try {
        workspaceManager.create('nonexistent', 'DEV');
        assert.fail('expected an error to be thrown');
    } catch (err) {
        assert.ok(err instanceof NotFoundError);
    }
});

test('create throws for a duplicate workspace ID', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    workspaceManager.create(projectId, 'DEV');
    assert.throws(
        () => workspaceManager.create(projectId, 'DEV'),
        /already exists/,
    );
});

test('create returns WorkspaceInfo with correct fields', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    const info = workspaceManager.create(projectId, 'DEV', 'Development workspace');
    assert.strictEqual(info.ProjectID, projectId);
    assert.strictEqual(info.WorkspaceID, 'DEV');
    assert.strictEqual(info.Description, 'Development workspace');
    assert.ok(!isNaN(Date.parse(info.DateCreated)));
    assert.ok(!isNaN(Date.parse(info.DateModified)));
    assert.strictEqual(info.DateCreated, info.DateModified);
});

test('create defaults Description to empty string when not provided', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    const info = workspaceManager.create(projectId, 'DEV');
    assert.strictEqual(info.Description, '');
});

test('create persists the workspace so list() immediately reflects it', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    workspaceManager.create(projectId, 'DEV');
    const workspaces = workspaceManager.list(projectId);
    assert.ok(workspaces.some((w) => w.WorkspaceID === 'DEV'));
});

// ─── update ──────────────────────────────────────────────────────────────────

test('update throws when project does not exist', () => {
    const { workspaceManager } = makeManagers(makeTempDir());
    assert.throws(
        () => workspaceManager.update('nonexistent', 'STABLE', { Description: 'x' }),
        /does not exist/,
    );
});

test('update throws NotFoundError when project does not exist', () => {
    const { workspaceManager } = makeManagers(makeTempDir());
    try {
        workspaceManager.update('nonexistent', 'STABLE', { Description: 'x' });
        assert.fail('expected an error to be thrown');
    } catch (err) {
        assert.ok(err instanceof NotFoundError);
    }
});

test('update throws when workspace does not exist', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    assert.throws(
        () => workspaceManager.update(projectId, 'DEV', { Description: 'x' }),
        /does not exist/,
    );
});

test('update throws NotFoundError when workspace does not exist', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    try {
        workspaceManager.update(projectId, 'DEV', { Description: 'x' });
        assert.fail('expected an error to be thrown');
    } catch (err) {
        assert.ok(err instanceof NotFoundError);
    }
});

test('update changes the Description field', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    const updated = workspaceManager.update(projectId, 'STABLE', { Description: 'New desc' });
    assert.strictEqual(updated.Description, 'New desc');
});

test('update sets DateModified to a new timestamp', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    const original = workspaceManager.getById(projectId, 'STABLE');
    assert.ok(original !== undefined);
    const updated = workspaceManager.update(projectId, 'STABLE', { Description: 'Changed' });
    assert.ok(updated.DateModified >= original.DateModified);
});

test('update persists changes so getById() reflects them immediately', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    workspaceManager.update(projectId, 'STABLE', { Description: 'Persisted' });
    const fetched = workspaceManager.getById(projectId, 'STABLE');
    assert.strictEqual(fetched?.Description, 'Persisted');
});

// ─── rename ──────────────────────────────────────────────────────────────────

test('rename throws when attempting to rename the STABLE workspace', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    assert.throws(
        () => workspaceManager.rename(projectId, 'STABLE', 'PROD'),
        /Cannot rename the STABLE workspace/,
    );
});

test('rename throws for an invalid new workspace ID', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    workspaceManager.create(projectId, 'DEV');
    assert.throws(
        () => workspaceManager.rename(projectId, 'DEV', 'dev'),
        /Invalid workspace ID/,
    );
});

test('rename throws when project does not exist', () => {
    const { workspaceManager } = makeManagers(makeTempDir());
    assert.throws(
        () => workspaceManager.rename('nonexistent', 'DEV', 'QAT'),
        /does not exist/,
    );
});

test('rename throws NotFoundError when project does not exist', () => {
    const { workspaceManager } = makeManagers(makeTempDir());
    try {
        workspaceManager.rename('nonexistent', 'DEV', 'QAT');
        assert.fail('expected an error to be thrown');
    } catch (err) {
        assert.ok(err instanceof NotFoundError);
    }
});

test('rename throws when old workspace does not exist', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    assert.throws(
        () => workspaceManager.rename(projectId, 'DEV', 'QAT'),
        /does not exist/,
    );
});

test('rename throws when new workspace ID already exists', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    workspaceManager.create(projectId, 'DEV');
    assert.throws(
        () => workspaceManager.rename(projectId, 'DEV', 'STABLE'),
        /already exists/,
    );
});

test('rename returns WorkspaceInfo with the new ID', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    workspaceManager.create(projectId, 'DEV', 'Dev workspace');
    const renamed = workspaceManager.rename(projectId, 'DEV', 'QAT');
    assert.strictEqual(renamed.WorkspaceID, 'QAT');
    assert.strictEqual(renamed.ProjectID, projectId);
    assert.strictEqual(renamed.Description, 'Dev workspace');
});

test('rename updates DateModified on the workspace entry', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    const created = workspaceManager.create(projectId, 'DEV');
    const renamed = workspaceManager.rename(projectId, 'DEV', 'QAT');
    assert.ok(renamed.DateModified >= created.DateModified);
});

test('rename removes the old workspace ID from the project', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    workspaceManager.create(projectId, 'DEV');
    workspaceManager.rename(projectId, 'DEV', 'QAT');
    assert.strictEqual(workspaceManager.getById(projectId, 'DEV'), undefined);
    assert.ok(workspaceManager.getById(projectId, 'QAT') !== undefined);
});

// ─── remove ──────────────────────────────────────────────────────────────────

test('remove throws when attempting to delete the STABLE workspace', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    assert.throws(
        () => workspaceManager.remove(projectId, 'STABLE'),
        /Cannot remove the STABLE workspace/,
    );
});

test('remove throws when project does not exist', () => {
    const { workspaceManager } = makeManagers(makeTempDir());
    assert.throws(
        () => workspaceManager.remove('nonexistent', 'DEV'),
        /does not exist/,
    );
});

test('remove throws NotFoundError when project does not exist', () => {
    const { workspaceManager } = makeManagers(makeTempDir());
    try {
        workspaceManager.remove('nonexistent', 'DEV');
        assert.fail('expected an error to be thrown');
    } catch (err) {
        assert.ok(err instanceof NotFoundError);
    }
});

test('remove throws when workspace does not exist', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    assert.throws(
        () => workspaceManager.remove(projectId, 'DEV'),
        /does not exist/,
    );
});

test('remove deletes the workspace so list() no longer includes it', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    workspaceManager.create(projectId, 'DEV');
    workspaceManager.remove(projectId, 'DEV');
    const workspaces = workspaceManager.list(projectId);
    assert.ok(!workspaces.some((w) => w.WorkspaceID === 'DEV'));
});

test('remove does not affect other workspaces in the project', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);
    workspaceManager.create(projectId, 'DEV');
    workspaceManager.remove(projectId, 'DEV');
    const workspaces = workspaceManager.list(projectId);
    assert.strictEqual(workspaces.length, 1);
    assert.strictEqual(workspaces[0].WorkspaceID, 'STABLE');
});

// ─── CRUD round-trip ─────────────────────────────────────────────────────────

test('CRUD round-trip: create → list → getById → update → rename → remove', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    const projectId = makeProject(projectManager, repoManager);

    // create
    const created = workspaceManager.create(projectId, 'DEV', 'Development workspace');
    assert.strictEqual(created.WorkspaceID, 'DEV');
    assert.strictEqual(created.ProjectID, projectId);
    assert.strictEqual(created.Description, 'Development workspace');
    assert.ok(!isNaN(Date.parse(created.DateCreated)));

    // list
    const workspaces = workspaceManager.list(projectId);
    assert.ok(workspaces.some((w) => w.WorkspaceID === 'DEV'), 'DEV should appear in list');
    assert.strictEqual(workspaces.length, 2, 'STABLE + DEV');

    // getById
    const fetched = workspaceManager.getById(projectId, 'DEV');
    assert.ok(fetched !== undefined);
    assert.strictEqual(fetched.WorkspaceID, 'DEV');
    assert.strictEqual(fetched.Description, 'Development workspace');

    // update
    const updated = workspaceManager.update(projectId, 'DEV', { Description: 'Updated description' });
    assert.strictEqual(updated.Description, 'Updated description');
    assert.ok(updated.DateModified >= created.DateModified);
    assert.strictEqual(workspaceManager.getById(projectId, 'DEV')?.Description, 'Updated description');

    // rename
    const renamed = workspaceManager.rename(projectId, 'DEV', 'QAT');
    assert.strictEqual(renamed.WorkspaceID, 'QAT');
    assert.strictEqual(renamed.Description, 'Updated description');
    assert.ok(renamed.DateModified >= updated.DateModified);
    assert.strictEqual(workspaceManager.getById(projectId, 'DEV'), undefined, 'old ID gone');
    assert.ok(workspaceManager.getById(projectId, 'QAT') !== undefined, 'new ID present');

    // remove
    workspaceManager.remove(projectId, 'QAT');
    assert.strictEqual(workspaceManager.getById(projectId, 'QAT'), undefined, 'removed workspace gone');
    assert.strictEqual(workspaceManager.list(projectId).length, 1, 'only STABLE remains');
    assert.strictEqual(workspaceManager.list(projectId)[0].WorkspaceID, 'STABLE');
});

// ─── cross-project isolation ─────────────────────────────────────────────────

test('workspace operations on project A do not affect project B workspaces', () => {
    const base = makeTempDir();
    const { repoManager, projectManager, workspaceManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create('Project A', ['repo'], undefined, 'project-a');
    projectManager.create('Project B', ['repo'], undefined, 'project-b');

    // Create, update and rename a workspace in project A
    workspaceManager.create('project-a', 'DEV', 'A workspace');
    workspaceManager.update('project-a', 'DEV', { Description: 'Changed' });
    workspaceManager.rename('project-a', 'DEV', 'QAT');

    // Project B should still only have its STABLE workspace, unmodified
    const bWorkspaces = workspaceManager.list('project-b');
    assert.strictEqual(bWorkspaces.length, 1, 'project B should only have STABLE');
    assert.strictEqual(bWorkspaces[0].WorkspaceID, 'STABLE');
    assert.strictEqual(bWorkspaces[0].Description, 'Stable workspace');
});
