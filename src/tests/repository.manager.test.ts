import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import type { AppConfig } from '../config/config.types.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { NotFoundError } from '../errors.js';
import { createTempDirTracker } from './test-helpers.js';

const makeTempDir = createTempDirTracker('paralizer-repo-test-');

function makeTestConfig(base: string): AppConfig {
    return {
        storageFolder: path.join(base, 'storage'),
        projectsFolder: path.join(base, 'projects'),
        cloneDepth: 50,
        serverPort: 4200,
        gitPollingIntervalSeconds: 30,
        notesCardHeight: 220,
        notesColumns: 2,
    };
}

function makeManager(base: string): RepositoryManager {
    const config = makeTestConfig(base);
    fs.mkdirSync(config.storageFolder, { recursive: true });
    return new RepositoryManager(config);
}

// ─── list ────────────────────────────────────────────────────────────────────

test('list returns empty array when no repositories exist', () => {
    const manager = makeManager(makeTempDir());
    assert.deepStrictEqual(manager.list(), []);
});

test('list returns all added repositories', () => {
    const manager = makeManager(makeTempDir());
    manager.add({ url: 'https://github.com/user/alpha.git' });
    manager.add({ url: 'https://github.com/user/beta.git' });
    const repos = manager.list();
    assert.strictEqual(repos.length, 2);
    assert.ok(repos.some((r) => r.Id === 'alpha'));
    assert.ok(repos.some((r) => r.Id === 'beta'));
});

// ─── getById ─────────────────────────────────────────────────────────────────

test('getById returns the matching repository', () => {
    const manager = makeManager(makeTempDir());
    manager.add({ url: 'https://github.com/user/my-repo.git' });
    const repo = manager.getById('my-repo');
    assert.ok(repo !== undefined);
    assert.strictEqual(repo.Id, 'my-repo');
    assert.strictEqual(repo.Url, 'https://github.com/user/my-repo.git');
});

test('getById returns undefined for a non-existent ID', () => {
    const manager = makeManager(makeTempDir());
    assert.strictEqual(manager.getById('nonexistent'), undefined);
});

// ─── exists ──────────────────────────────────────────────────────────────────

test('exists returns true when repository is present', () => {
    const manager = makeManager(makeTempDir());
    manager.add({ url: 'https://github.com/user/repo.git' });
    assert.ok(manager.exists('repo'));
});

test('exists returns false when repository is absent', () => {
    const manager = makeManager(makeTempDir());
    assert.strictEqual(manager.exists('nonexistent'), false);
});

// ─── add ─────────────────────────────────────────────────────────────────────

test('add infers ID from HTTPS URL when no explicit ID is given', () => {
    const manager = makeManager(makeTempDir());
    const repo = manager.add({ url: 'https://github.com/user/my-repo.git' });
    assert.strictEqual(repo.Id, 'my-repo');
});

test('add infers ID from SSH URL when no explicit ID is given', () => {
    const manager = makeManager(makeTempDir());
    const repo = manager.add({ url: 'git@github.com:user/my-repo.git' });
    assert.strictEqual(repo.Id, 'my-repo');
});

test('add uses explicit ID when provided', () => {
    const manager = makeManager(makeTempDir());
    const repo = manager.add({ url: 'https://github.com/user/repo.git', id: 'custom-id' });
    assert.strictEqual(repo.Id, 'custom-id');
});

test('add defaults Name to the resolved ID when name is omitted', () => {
    const manager = makeManager(makeTempDir());
    const repo = manager.add({ url: 'https://github.com/user/my-repo.git' });
    assert.strictEqual(repo.Name, 'my-repo');
});

test('add stores the provided Name when given', () => {
    const manager = makeManager(makeTempDir());
    const repo = manager.add({ url: 'https://github.com/user/repo.git', name: 'My Repository' });
    assert.strictEqual(repo.Name, 'My Repository');
});

test('add persists the repository so list() immediately reflects it', () => {
    const manager = makeManager(makeTempDir());
    manager.add({ url: 'https://github.com/user/repo.git' });
    assert.strictEqual(manager.list().length, 1);
});

test('add throws a descriptive error when URL produces an empty slug and no ID is given', () => {
    const manager = makeManager(makeTempDir());
    assert.throws(
        () => manager.add({ url: '!@#$%' }),
        /empty slug/,
    );
});

test('add throws a descriptive error for duplicate ID', () => {
    const manager = makeManager(makeTempDir());
    manager.add({ url: 'https://github.com/user/repo.git', id: 'my-repo' });
    assert.throws(
        () => manager.add({ url: 'https://github.com/user/other.git', id: 'my-repo' }),
        /already exists/,
    );
});

test('add throws a descriptive error for duplicate URL', () => {
    const manager = makeManager(makeTempDir());
    manager.add({ url: 'https://github.com/user/repo.git' });
    assert.throws(
        () => manager.add({ url: 'https://github.com/user/repo.git', id: 'repo-alias' }),
        /already exists/,
    );
});

// ─── update ──────────────────────────────────────────────────────────────────

test('update changes the Name of the repository', () => {
    const manager = makeManager(makeTempDir());
    manager.add({ url: 'https://github.com/user/repo.git', name: 'Old Name' });
    const updated = manager.update('repo', { name: 'New Name' });
    assert.strictEqual(updated.Name, 'New Name');
});

test('update persists the change so getById() reflects it', () => {
    const manager = makeManager(makeTempDir());
    manager.add({ url: 'https://github.com/user/repo.git', name: 'Old Name' });
    manager.update('repo', { name: 'New Name' });
    assert.strictEqual(manager.getById('repo')?.Name, 'New Name');
});

test('update throws a descriptive error for a non-existent ID', () => {
    const manager = makeManager(makeTempDir());
    assert.throws(
        () => manager.update('nonexistent', { name: 'Whatever' }),
        /does not exist/,
    );
});

test('update throws NotFoundError for a non-existent ID', () => {
    const manager = makeManager(makeTempDir());
    try {
        manager.update('nonexistent', { name: 'Whatever' });
        assert.fail('expected an error to be thrown');
    } catch (err) {
        assert.ok(err instanceof NotFoundError);
    }
});

// ─── remove ──────────────────────────────────────────────────────────────────

test('remove deletes the repository from the store', () => {
    const manager = makeManager(makeTempDir());
    manager.add({ url: 'https://github.com/user/repo.git' });
    manager.remove('repo');
    assert.strictEqual(manager.list().length, 0);
});

test('remove does not affect other repositories', () => {
    const manager = makeManager(makeTempDir());
    manager.add({ url: 'https://github.com/user/alpha.git' });
    manager.add({ url: 'https://github.com/user/beta.git' });
    manager.remove('alpha');
    assert.strictEqual(manager.list().length, 1);
    assert.ok(manager.exists('beta'));
});

test('remove throws a descriptive error for a non-existent ID', () => {
    const manager = makeManager(makeTempDir());
    assert.throws(
        () => manager.remove('nonexistent'),
        /does not exist/,
    );
});

test('remove throws NotFoundError for a non-existent ID', () => {
    const manager = makeManager(makeTempDir());
    try {
        manager.remove('nonexistent');
        assert.fail('expected an error to be thrown');
    } catch (err) {
        assert.ok(err instanceof NotFoundError);
    }
});

// ─── CRUD round-trip ─────────────────────────────────────────────────────────

test('CRUD round-trip: add → list → getById → update → remove', () => {
    const manager = makeManager(makeTempDir());

    // add
    const created = manager.add({ url: 'https://github.com/user/repo.git', name: 'Original' });
    assert.strictEqual(created.Id, 'repo');
    assert.strictEqual(created.Name, 'Original');

    // list
    assert.strictEqual(manager.list().length, 1);

    // getById
    const fetched = manager.getById('repo');
    assert.ok(fetched !== undefined);
    assert.strictEqual(fetched.Url, 'https://github.com/user/repo.git');

    // update
    const updated = manager.update('repo', { name: 'Renamed' });
    assert.strictEqual(updated.Name, 'Renamed');
    assert.strictEqual(manager.getById('repo')?.Name, 'Renamed');

    // remove
    manager.remove('repo');
    assert.strictEqual(manager.list().length, 0);
    assert.strictEqual(manager.getById('repo'), undefined);
});

// ─── stateless behaviour ─────────────────────────────────────────────────────

test('two independent manager instances share the same on-disk state', () => {
    const base = makeTempDir();
    const m1 = makeManager(base);
    const m2 = makeManager(base);
    m1.add({ url: 'https://github.com/user/repo.git' });
    assert.strictEqual(m2.list().length, 1, 'second instance should see writes made by first');
    assert.ok(m2.exists('repo'));
});

// ─── ID validation ───────────────────────────────────────────────────────────

test('add rejects explicit ID with path traversal sequence', () => {
    const manager = makeManager(makeTempDir());
    assert.throws(
        () => manager.add({ url: 'https://github.com/user/repo.git', id: '../../etc/passwd' }),
        /Invalid repository ID/,
    );
});

test('add rejects explicit ID with uppercase characters', () => {
    const manager = makeManager(makeTempDir());
    assert.throws(
        () => manager.add({ url: 'https://github.com/user/repo.git', id: 'My-Repo' }),
        /Invalid repository ID/,
    );
});

test('add rejects explicit ID with spaces', () => {
    const manager = makeManager(makeTempDir());
    assert.throws(
        () => manager.add({ url: 'https://github.com/user/repo.git', id: 'my repo' }),
        /Invalid repository ID/,
    );
});

test('add trims whitespace from explicit ID before validation', () => {
    const manager = makeManager(makeTempDir());
    const repo = manager.add({ url: 'https://github.com/user/repo.git', id: '  my-repo  ' });
    assert.strictEqual(repo.Id, 'my-repo');
});

// ─── URL credential redaction ────────────────────────────────────────────────

test('add does not expose credentials in duplicate URL error messages', () => {
    const manager = makeManager(makeTempDir());
    manager.add({ url: 'https://token@github.com/user/repo.git' });
    try {
        manager.add({ url: 'https://token@github.com/user/repo.git', id: 'repo-alias' });
        assert.fail('expected an error to be thrown');
    } catch (err) {
        const message = (err as Error).message;
        // Credentials are stripped before the duplicate check, so the raw token
        // must never appear in the error message.
        assert.ok(!message.includes('token@'), 'error message should not contain credentials');
    }
});

// ─── Embedded credential stripping ───────────────────────────────────────────

test('add strips embedded credentials from URL before storing', () => {
    const manager = makeManager(makeTempDir());
    const repo = manager.add({ url: 'https://ghp_abc@github.com/user/repo.git' });
    assert.strictEqual(repo.Url, 'https://github.com/user/repo.git');
});

test('add sets credentialsStripped flag when credentials are stripped', () => {
    const manager = makeManager(makeTempDir());
    const repo = manager.add({ url: 'https://ghp_abc@github.com/user/repo.git' });
    assert.strictEqual(repo.credentialsStripped, true);
});

test('add does not set credentialsStripped when URL has no embedded credentials', () => {
    const manager = makeManager(makeTempDir());
    const repo = manager.add({ url: 'https://github.com/user/clean-repo.git' });
    assert.strictEqual(repo.credentialsStripped, undefined);
});

test('add does not persist credentialsStripped to the store', () => {
    const base = makeTempDir();
    const manager = makeManager(base);
    manager.add({ url: 'https://ghp_abc@github.com/user/repo.git' });
    // Re-read from disk — credentialsStripped must not be present.
    const stored = manager.getById('repo');
    assert.strictEqual(stored?.credentialsStripped, undefined);
});

test('add compares duplicate URL against the clean URL, not the original', () => {
    const manager = makeManager(makeTempDir());
    manager.add({ url: 'https://github.com/user/repo.git' });
    // Adding the same URL with embedded credentials should still trigger the duplicate check.
    assert.throws(
        () => manager.add({ url: 'https://ghp_abc@github.com/user/repo.git', id: 'repo-alias' }),
        /already exists/,
    );
});

test('add stores URL unchanged when URL has no embedded credentials', () => {
    const manager = makeManager(makeTempDir());
    const repo = manager.add({ url: 'https://github.com/user/clean-repo.git' });
    assert.strictEqual(repo.Url, 'https://github.com/user/clean-repo.git');
});
