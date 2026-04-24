import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import type { AppConfig } from '../config/config.types.js';
import { initializeStorage } from '../storage/json-storage.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { ProjectManager } from '../models/project/project.manager.js';
import { NotFoundError } from '../errors.js';
import { createTempDirTracker } from './test-helpers.js';

const makeTempDir = createTempDirTracker('paralizer-project-test-');

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
    return { config, repoManager, projectManager };
}

// ─── list ────────────────────────────────────────────────────────────────────

test('list returns empty array when no projects exist', () => {
    const { projectManager } = makeManagers(makeTempDir());
    assert.deepStrictEqual(projectManager.list(), []);
});

test('list returns index entries for all created projects', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create('Alpha', ['repo'], undefined, 'alpha');
    projectManager.create('Beta', ['repo'], undefined, 'beta');
    const entries = projectManager.list();
    assert.strictEqual(entries.length, 2);
    assert.ok(entries.some((e) => e.Id === 'alpha' && e.Name === 'Alpha'));
    assert.ok(entries.some((e) => e.Id === 'beta' && e.Name === 'Beta'));
});

// ─── create ──────────────────────────────────────────────────────────────────

test('create generates ID from name via toKebabCase when no ID provided', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    const project = projectManager.create('My Cool Project', ['repo']);
    assert.strictEqual(project.Id, 'my-cool-project');
});

test('create uses explicit ID when provided', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    const project = projectManager.create('My Project', ['repo'], undefined, 'custom-id');
    assert.strictEqual(project.Id, 'custom-id');
});

test('create auto-generates a STABLE workspace', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    const project = projectManager.create('My Project', ['repo']);
    assert.ok('STABLE' in project.Workspaces, 'STABLE workspace must be present');
});

test('create sets DateCreated and DateModified to the same ISO 8601 timestamp', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    const project = projectManager.create('My Project', ['repo']);
    assert.ok(project.DateCreated, 'DateCreated should be set');
    assert.strictEqual(project.DateCreated, project.DateModified);
    assert.ok(!isNaN(Date.parse(project.DateCreated)), 'DateCreated must be a valid ISO 8601 date');
});

test('create STABLE workspace has DateCreated and DateModified', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    const project = projectManager.create('My Project', ['repo']);
    const stable = project.Workspaces['STABLE'];
    assert.ok(!isNaN(Date.parse(stable.DateCreated)));
    assert.ok(!isNaN(Date.parse(stable.DateModified)));
    assert.strictEqual(stable.DateCreated, stable.DateModified);
});

test('create stores the provided description', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    const project = projectManager.create('My Project', ['repo'], 'A description');
    assert.strictEqual(project.Description, 'A description');
});

test('create defaults Description to empty string when omitted', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    const project = projectManager.create('My Project', ['repo']);
    assert.strictEqual(project.Description, '');
});

test('create throws when name produces an empty slug and no ID is provided', () => {
    const { projectManager } = makeManagers(makeTempDir());
    assert.throws(
        () => projectManager.create('!@#$%', []),
        /empty slug/,
    );
});

test('create throws when a repository ID does not exist', () => {
    const { projectManager } = makeManagers(makeTempDir());
    assert.throws(
        () => projectManager.create('My Project', ['nonexistent']),
        /Repository with ID "nonexistent" does not exist/,
    );
});

test('create throws when a project with the same ID already exists', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create('My Project', ['repo'], undefined, 'my-project');
    assert.throws(
        () => projectManager.create('Other Project', ['repo'], undefined, 'my-project'),
        /already exists/,
    );
});

test('create updates the project index', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create('My Project', ['repo'], undefined, 'my-project');
    const entries = projectManager.list();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].Id, 'my-project');
    assert.strictEqual(entries[0].Name, 'My Project');
});

// ─── getById ─────────────────────────────────────────────────────────────────

test('getById returns full project data when project exists', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create('My Project', ['repo'], 'A description', 'my-project');
    const project = projectManager.getById('my-project');
    assert.ok(project !== undefined);
    assert.strictEqual(project.Name, 'My Project');
    assert.strictEqual(project.Description, 'A description');
    assert.ok(project.Repositories.includes('repo'));
});

test('getById returns undefined when project does not exist', () => {
    const { projectManager } = makeManagers(makeTempDir());
    assert.strictEqual(projectManager.getById('nonexistent'), undefined);
});

// ─── update ──────────────────────────────────────────────────────────────────

test('update changes the Name field', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    const created = projectManager.create('Old Name', ['repo']);
    const updated = projectManager.update(created.Id, { Name: 'New Name' });
    assert.strictEqual(updated.Name, 'New Name');
});

test('update changes the Description field', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    const created = projectManager.create('My Project', ['repo'], 'Old desc');
    const updated = projectManager.update(created.Id, { Description: 'New desc' });
    assert.strictEqual(updated.Description, 'New desc');
    assert.strictEqual(updated.Name, 'My Project');
});

test('update sets DateModified to a new timestamp', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    const created = projectManager.create('My Project', ['repo']);
    const updated = projectManager.update(created.Id, { Name: 'New Name' });
    assert.ok(updated.DateModified >= created.DateModified);
});

test('update syncs Name in the project index', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    const created = projectManager.create('Old Name', ['repo']);
    projectManager.update(created.Id, { Name: 'New Name' });
    const entry = projectManager.list().find((p) => p.Id === created.Id);
    assert.strictEqual(entry?.Name, 'New Name');
});

test('update throws when project does not exist', () => {
    const { projectManager } = makeManagers(makeTempDir());
    assert.throws(
        () => projectManager.update('nonexistent', { Name: 'Something' }),
        /does not exist/,
    );
});

test('update throws NotFoundError when project does not exist', () => {
    const { projectManager } = makeManagers(makeTempDir());
    try {
        projectManager.update('nonexistent', { Name: 'Something' });
        assert.fail('expected an error to be thrown');
    } catch (err) {
        assert.ok(err instanceof NotFoundError);
    }
});

// ─── rename ──────────────────────────────────────────────────────────────────

test('rename changes the project ID', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create('My Project', ['repo'], undefined, 'old-id');
    const renamed = projectManager.rename('old-id', 'new-id');
    assert.strictEqual(renamed.Id, 'new-id');
});

test('rename deletes the old project JSON file', () => {
    const base = makeTempDir();
    const { config, repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create('My Project', ['repo'], undefined, 'old-id');
    projectManager.rename('old-id', 'new-id');
    const oldPath = path.join(config.storageFolder, 'projects', 'old-id.json');
    assert.ok(!fs.existsSync(oldPath), 'old project file should be deleted');
});

test('rename creates the new project JSON file', () => {
    const base = makeTempDir();
    const { config, repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create('My Project', ['repo'], undefined, 'old-id');
    projectManager.rename('old-id', 'new-id');
    const newPath = path.join(config.storageFolder, 'projects', 'new-id.json');
    assert.ok(fs.existsSync(newPath), 'new project file should exist');
});

test('rename updates the project index entry', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create('My Project', ['repo'], undefined, 'old-id');
    projectManager.rename('old-id', 'new-id');
    const entries = projectManager.list();
    assert.ok(entries.some((p) => p.Id === 'new-id'), 'index should contain new ID');
    assert.ok(!entries.some((p) => p.Id === 'old-id'), 'index should not contain old ID');
});

test('rename updates DateModified', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    const created = projectManager.create('My Project', ['repo'], undefined, 'old-id');
    const renamed = projectManager.rename('old-id', 'new-id');
    assert.ok(renamed.DateModified >= created.DateModified);
});

test('rename throws when source project does not exist', () => {
    const { projectManager } = makeManagers(makeTempDir());
    assert.throws(
        () => projectManager.rename('nonexistent', 'new-id'),
        /does not exist/,
    );
});

test('rename throws NotFoundError when source project does not exist', () => {
    const { projectManager } = makeManagers(makeTempDir());
    try {
        projectManager.rename('nonexistent', 'new-id');
        assert.fail('expected an error to be thrown');
    } catch (err) {
        assert.ok(err instanceof NotFoundError);
    }
});

test('rename throws when target ID already exists', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create('A', ['repo'], undefined, 'project-a');
    projectManager.create('B', ['repo'], undefined, 'project-b');
    assert.throws(
        () => projectManager.rename('project-a', 'project-b'),
        /already exists/,
    );
});

// ─── remove ──────────────────────────────────────────────────────────────────

test('remove deletes the project JSON file', () => {
    const base = makeTempDir();
    const { config, repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create('My Project', ['repo'], undefined, 'my-project');
    projectManager.remove('my-project');
    const filePath = path.join(config.storageFolder, 'projects', 'my-project.json');
    assert.ok(!fs.existsSync(filePath), 'project file should be deleted');
});

test('remove removes the project from the index', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create('My Project', ['repo'], undefined, 'my-project');
    projectManager.remove('my-project');
    assert.ok(!projectManager.list().some((p) => p.Id === 'my-project'));
});

test('remove throws when project does not exist', () => {
    const { projectManager } = makeManagers(makeTempDir());
    assert.throws(
        () => projectManager.remove('nonexistent'),
        /does not exist/,
    );
});

test('remove throws NotFoundError when project does not exist', () => {
    const { projectManager } = makeManagers(makeTempDir());
    try {
        projectManager.remove('nonexistent');
        assert.fail('expected an error to be thrown');
    } catch (err) {
        assert.ok(err instanceof NotFoundError);
    }
});

// ─── addRepository ───────────────────────────────────────────────────────────

test('addRepository adds a repository ID to the project', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo-a.git' });
    repoManager.add({ url: 'https://github.com/user/repo-b.git' });
    const created = projectManager.create('My Project', ['repo-a']);
    const updated = projectManager.addRepository(created.Id, 'repo-b');
    assert.ok(updated.Repositories.includes('repo-b'));
});

test('addRepository updates DateModified', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo-a.git' });
    repoManager.add({ url: 'https://github.com/user/repo-b.git' });
    const created = projectManager.create('My Project', ['repo-a']);
    const updated = projectManager.addRepository(created.Id, 'repo-b');
    assert.ok(updated.DateModified >= created.DateModified);
});

test('addRepository throws when project does not exist', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    assert.throws(
        () => projectManager.addRepository('nonexistent', 'repo'),
        /does not exist/,
    );
});

test('addRepository throws NotFoundError when project does not exist', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    try {
        projectManager.addRepository('nonexistent', 'repo');
        assert.fail('expected an error to be thrown');
    } catch (err) {
        assert.ok(err instanceof NotFoundError);
    }
});

test('addRepository throws when repository does not exist', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    const created = projectManager.create('My Project', ['repo']);
    assert.throws(
        () => projectManager.addRepository(created.Id, 'no-such-repo'),
        /does not exist/,
    );
});

test('addRepository throws when repository is already listed in the project', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    const created = projectManager.create('My Project', ['repo']);
    assert.throws(
        () => projectManager.addRepository(created.Id, 'repo'),
        /already listed/,
    );
});

// ─── removeRepository ────────────────────────────────────────────────────────

test('removeRepository removes a repository ID from the project', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    const created = projectManager.create('My Project', ['repo']);
    const updated = projectManager.removeRepository(created.Id, 'repo');
    assert.ok(!updated.Repositories.includes('repo'));
});

test('removeRepository updates DateModified', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    const created = projectManager.create('My Project', ['repo']);
    const updated = projectManager.removeRepository(created.Id, 'repo');
    assert.ok(updated.DateModified >= created.DateModified);
});

test('removeRepository throws when project does not exist', () => {
    const { projectManager } = makeManagers(makeTempDir());
    assert.throws(
        () => projectManager.removeRepository('nonexistent', 'repo'),
        /does not exist/,
    );
});

test('removeRepository throws NotFoundError when project does not exist', () => {
    const { projectManager } = makeManagers(makeTempDir());
    try {
        projectManager.removeRepository('nonexistent', 'repo');
        assert.fail('expected an error to be thrown');
    } catch (err) {
        assert.ok(err instanceof NotFoundError);
    }
});

test('removeRepository throws when repository is not listed in the project', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    const created = projectManager.create('My Project', ['repo']);
    assert.throws(
        () => projectManager.removeRepository(created.Id, 'no-such-repo'),
        /not listed/,
    );
});

// ─── stateless behaviour ─────────────────────────────────────────────────────

test('all public methods re-read from disk (stateless between calls)', () => {
    const base = makeTempDir();
    const { config, repoManager } = makeManagers(base);
    // Two independent ProjectManager instances over the same storage
    const pm1 = new ProjectManager(config, repoManager);
    const pm2 = new ProjectManager(config, repoManager);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    pm1.create('My Project', ['repo'], undefined, 'my-project');
    assert.strictEqual(pm2.list().length, 1, 'second instance should see writes made by first');
    assert.ok(pm2.getById('my-project') !== undefined);
});

// ─── STABLE workspace structure ───────────────────────────────────────────────

test('STABLE workspace has Description, DateCreated, and DateModified fields', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    const project = projectManager.create('My Project', ['repo']);
    const stable = project.Workspaces['STABLE'];
    assert.ok(stable !== undefined, 'STABLE workspace must exist');
    assert.ok('Description' in stable, 'STABLE workspace must have a Description field');
    assert.ok(typeof stable.Description === 'string', 'Description must be a string');
    assert.ok(!isNaN(Date.parse(stable.DateCreated)), 'DateCreated must be a valid ISO 8601 date');
    assert.ok(!isNaN(Date.parse(stable.DateModified)), 'DateModified must be a valid ISO 8601 date');
});

// ─── CRUD round-trip ─────────────────────────────────────────────────────────

test('CRUD round-trip: create → list → getById → update → rename → addRepository → removeRepository → remove', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo-a.git' });
    repoManager.add({ url: 'https://github.com/user/repo-b.git' });

    // create
    const created = projectManager.create('My Project', ['repo-a'], 'Initial desc', 'my-project');
    assert.strictEqual(created.Id, 'my-project');
    assert.strictEqual(created.Name, 'My Project');
    assert.strictEqual(created.Description, 'Initial desc');
    assert.ok(created.Repositories.includes('repo-a'));
    assert.ok('STABLE' in created.Workspaces);

    // list & index
    const entries = projectManager.list();
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].Id, 'my-project');
    assert.strictEqual(entries[0].Name, 'My Project');

    // getById
    const fetched = projectManager.getById('my-project');
    assert.ok(fetched !== undefined);
    assert.strictEqual(fetched.Id, 'my-project');

    // update
    const updated = projectManager.update('my-project', { Name: 'Renamed Project', Description: 'Updated desc' });
    assert.strictEqual(updated.Name, 'Renamed Project');
    assert.strictEqual(updated.Description, 'Updated desc');
    assert.ok(updated.DateModified >= created.DateModified);
    assert.strictEqual(projectManager.list().find((e) => e.Id === 'my-project')?.Name, 'Renamed Project');

    // addRepository
    const afterAdd = projectManager.addRepository('my-project', 'repo-b');
    assert.ok(afterAdd.Repositories.includes('repo-b'));
    assert.ok(afterAdd.DateModified >= updated.DateModified);

    // removeRepository
    const afterRemove = projectManager.removeRepository('my-project', 'repo-b');
    assert.ok(!afterRemove.Repositories.includes('repo-b'));
    assert.ok(afterRemove.DateModified >= afterAdd.DateModified);

    // rename
    const renamed = projectManager.rename('my-project', 'new-id');
    assert.strictEqual(renamed.Id, 'new-id');
    assert.ok(projectManager.getById('my-project') === undefined, 'old ID should be gone');
    assert.ok(projectManager.getById('new-id') !== undefined, 'new ID should exist');
    const indexAfterRename = projectManager.list();
    assert.ok(indexAfterRename.some((e) => e.Id === 'new-id'));
    assert.ok(!indexAfterRename.some((e) => e.Id === 'my-project'));

    // remove
    projectManager.remove('new-id');
    assert.strictEqual(projectManager.list().length, 0);
    assert.strictEqual(projectManager.getById('new-id'), undefined);
});

// ─── create ID validation ────────────────────────────────────────────────────

test('create rejects explicit ID with path traversal sequence', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    assert.throws(
        () => projectManager.create('My Project', ['repo'], undefined, '../../etc/passwd'),
        /Invalid project ID/,
    );
});

test('create rejects explicit ID with uppercase characters', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    assert.throws(
        () => projectManager.create('My Project', ['repo'], undefined, 'My-Project'),
        /Invalid project ID/,
    );
});

test('create trims whitespace from explicit ID before validation', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    const project = projectManager.create('My Project', ['repo'], undefined, '  my-project  ');
    assert.strictEqual(project.Id, 'my-project');
});

// ─── rename ID validation ────────────────────────────────────────────────────

test('rename rejects newId with path traversal sequence', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create('My Project', ['repo'], undefined, 'my-project');
    assert.throws(
        () => projectManager.rename('my-project', '../../etc/passwd'),
        /Invalid project ID/,
    );
});

test('rename rejects newId with uppercase characters', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create('My Project', ['repo'], undefined, 'my-project');
    assert.throws(
        () => projectManager.rename('my-project', 'New-Id'),
        /Invalid project ID/,
    );
});

test('rename trims whitespace from newId before validation', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create('My Project', ['repo'], undefined, 'my-project');
    const renamed = projectManager.rename('my-project', '  new-id  ');
    assert.strictEqual(renamed.Id, 'new-id');
});

// ─── updateLastActivity ───────────────────────────────────────────────────────

test('updateLastActivity sets LastActivity on the project JSON file', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create('My Project', ['repo'], undefined, 'my-project');
    const ts = '2025-06-01T12:00:00.000Z';
    projectManager.updateLastActivity('my-project', ts);
    const project = projectManager.getById('my-project');
    assert.strictEqual(project?.LastActivity, ts);
});

test('updateLastActivity does NOT modify DateModified', () => {
    const base = makeTempDir();
    const { repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    const created = projectManager.create('My Project', ['repo'], undefined, 'my-project');
    projectManager.updateLastActivity('my-project', '2025-06-01T12:00:00.000Z');
    const after = projectManager.getById('my-project');
    assert.strictEqual(after?.DateModified, created.DateModified);
});

test('updateLastActivity short-circuits without writing to disk when value equals existing LastActivity', () => {
    const base = makeTempDir();
    const { config, repoManager, projectManager } = makeManagers(base);
    repoManager.add({ url: 'https://github.com/user/repo.git' });
    projectManager.create('My Project', ['repo'], undefined, 'my-project');
    const ts = '2025-06-01T12:00:00.000Z';
    projectManager.updateLastActivity('my-project', ts);

    // Record the mtime after the first write
    const filePath = path.join(config.storageFolder, 'projects', 'my-project.json');
    const mtimeBefore = fs.statSync(filePath).mtimeMs;

    // Probe filesystem mtime granularity: write twice in rapid succession and
    // compare mtimes. On FAT-backed or tmpfs volumes (2-second resolution) the
    // two writes may produce the same mtime, making a mtime-based no-write
    // assertion unreliable. Detect this condition and fall back to a content
    // comparison instead.
    const probeFile = path.join(base, 'mtime-probe.tmp');
    fs.writeFileSync(probeFile, 'a');
    const probeA = fs.statSync(probeFile).mtimeMs;
    fs.writeFileSync(probeFile, 'b');
    const probeB = fs.statSync(probeFile).mtimeMs;
    const fineGranularity = probeA !== probeB;

    // Read content snapshot before the second (no-op) call
    const contentBefore = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;

    // Call again with the same value — must NOT write
    projectManager.updateLastActivity('my-project', ts);
    const mtimeAfter = fs.statSync(filePath).mtimeMs;

    if (fineGranularity) {
        assert.strictEqual(mtimeBefore, mtimeAfter, 'file should not be written when value is unchanged');
    } else {
        // Coarse-granularity filesystem: verify content is unchanged instead
        const contentAfter = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
        assert.deepStrictEqual(contentBefore, contentAfter, 'file content should be unchanged when value is unchanged');
    }
});

test('updateLastActivity silently returns when called with a project ID that does not exist', () => {
    const { projectManager } = makeManagers(makeTempDir());
    assert.doesNotThrow(() => projectManager.updateLastActivity('nonexistent', '2025-06-01T12:00:00.000Z'));
});
