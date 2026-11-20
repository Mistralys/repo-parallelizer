import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRemoteAuth } from '../orchestration/remote-auth.js';
import type { GitCredentialEntry } from '../config/config.types.js';
import type { Repository } from '../models/repository/repository.types.js';

function makeRepo(overrides: Partial<Repository> = {}): Repository {
    return {
        Id: 'repo-a',
        Name: 'Repo A',
        Url: 'https://github.com/org/repo-a.git',
        ...overrides,
    };
}

function makeCredential(overrides: Partial<GitCredentialEntry> = {}): GitCredentialEntry {
    return {
        id: 'cred-1',
        label: 'GitHub personal account',
        host: 'github.com',
        token: 'secret-token',
        ...overrides,
    };
}

// ─── HTTPS URL with a resolvable credential ───────────────────────────────────

test('resolveRemoteAuth() returns ok: true with the injected URL and credential for an HTTPS URL with a matching credential', () => {
    const repo = makeRepo();
    const credential = makeCredential();

    const result = resolveRemoteAuth(repo, [credential]);

    assert.deepEqual(result, {
        ok: true,
        url: 'https://secret-token@github.com/org/repo-a.git',
        credential,
    });
});

test('resolveRemoteAuth() resolves via explicit CredentialId when set', () => {
    const credentialA = makeCredential({ id: 'cred-a', host: 'github.com', token: 'token-a' });
    const credentialB = makeCredential({ id: 'cred-b', host: 'github.com', token: 'token-b' });
    const repo = makeRepo({ CredentialId: 'cred-b' });

    const result = resolveRemoteAuth(repo, [credentialA, credentialB]);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.url, 'https://token-b@github.com/org/repo-a.git');
    assert.equal(result.ok && result.credential?.id, 'cred-b');
});

// ─── HTTPS URL without a resolvable credential ────────────────────────────────

test('resolveRemoteAuth() returns ok: false with the legacy error message for an HTTPS URL with no matching credential', () => {
    const repo = makeRepo({ Name: 'Repo A', Url: 'https://github.com/org/repo-a.git' });

    const result = resolveRemoteAuth(repo, []);

    assert.deepEqual(result, {
        ok: false,
        host: 'github.com',
        message:
            "Repository 'Repo A' requires a credential for host 'github.com'. " +
            'Please select a credential in the repository settings.',
    });
});

test('resolveRemoteAuth() returns ok: false when multiple credentials match ambiguously (no CredentialId)', () => {
    const credentialA = makeCredential({ id: 'cred-a' });
    const credentialB = makeCredential({ id: 'cred-b' });
    const repo = makeRepo();

    const result = resolveRemoteAuth(repo, [credentialA, credentialB]);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.host, 'github.com');
});

// ─── SSH URL ───────────────────────────────────────────────────────────────────

test('resolveRemoteAuth() returns ok: true with credential: null and the unchanged URL for an SSH URL', () => {
    const repo = makeRepo({ Url: 'git@github.com:org/repo-a.git' });

    const result = resolveRemoteAuth(repo, [makeCredential()]);

    assert.deepEqual(result, {
        ok: true,
        url: 'git@github.com:org/repo-a.git',
        credential: null,
    });
});

test('resolveRemoteAuth() returns ok: true with credential: null for an SSH URL with no credentials configured', () => {
    const repo = makeRepo({ Url: 'ssh://git@github.com/org/repo-a.git' });

    const result = resolveRemoteAuth(repo, []);

    assert.deepEqual(result, {
        ok: true,
        url: 'ssh://git@github.com/org/repo-a.git',
        credential: null,
    });
});
