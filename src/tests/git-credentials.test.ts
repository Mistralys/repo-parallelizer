import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    extractHost,
    injectCredentialToken,
    resolveCredential,
    hasEmbeddedCredentials,
    stripEmbeddedCredentials,
    hostsEqual,
} from '../git/git-credentials.js';
import type { GitCredentialEntry } from '../config/config.types.js';

// ─── extractHost() ────────────────────────────────────────────────────────────

test('extractHost() returns the hostname for a standard HTTPS URL', () => {
    assert.strictEqual(extractHost('https://github.com/org/repo.git'), 'github.com');
});

test('extractHost() returns the hostname for an HTTPS URL with a port', () => {
    assert.strictEqual(extractHost('https://gitlab.example.com:8443/org/repo.git'), 'gitlab.example.com');
});

test('extractHost() returns null for an SSH URL (git@ format)', () => {
    assert.strictEqual(extractHost('git@github.com:org/repo.git'), null);
});

test('extractHost() returns null for an SSH URL (ssh:// scheme)', () => {
    assert.strictEqual(extractHost('ssh://git@github.com/org/repo.git'), null);
});

test('extractHost() returns null for a git:// URL', () => {
    assert.strictEqual(extractHost('git://github.com/org/repo.git'), null);
});

test('extractHost() returns null for an empty string', () => {
    assert.strictEqual(extractHost(''), null);
});

test('extractHost() returns null for a malformed URL', () => {
    assert.strictEqual(extractHost('not-a-url'), null);
});

test('extractHost() returns null for an http:// URL (non-HTTPS)', () => {
    assert.strictEqual(extractHost('http://github.com/org/repo.git'), null);
});

// ─── hasEmbeddedCredentials() ─────────────────────────────────────────────────

test('hasEmbeddedCredentials() returns true for URL with a token in userinfo', () => {
    assert.strictEqual(hasEmbeddedCredentials('https://token@github.com/org/repo.git'), true);
});

test('hasEmbeddedCredentials() returns true for URL with user:pass in userinfo', () => {
    assert.strictEqual(hasEmbeddedCredentials('https://user:pass@github.com/org/repo.git'), true);
});

test('hasEmbeddedCredentials() returns false for a plain HTTPS URL (no userinfo)', () => {
    assert.strictEqual(hasEmbeddedCredentials('https://github.com/org/repo.git'), false);
});

test('hasEmbeddedCredentials() returns false for an SSH URL', () => {
    assert.strictEqual(hasEmbeddedCredentials('git@github.com:org/repo.git'), false);
});

test('hasEmbeddedCredentials() returns false for an empty string', () => {
    assert.strictEqual(hasEmbeddedCredentials(''), false);
});

test('hasEmbeddedCredentials() returns false for a malformed URL', () => {
    assert.strictEqual(hasEmbeddedCredentials('not-a-url'), false);
});

test('hasEmbeddedCredentials() returns false for a git:// URL', () => {
    assert.strictEqual(hasEmbeddedCredentials('git://github.com/org/repo.git'), false);
});

// ─── stripEmbeddedCredentials() ───────────────────────────────────────────────

test('stripEmbeddedCredentials() removes user:pass from HTTPS URL', () => {
    assert.strictEqual(
        stripEmbeddedCredentials('https://user:pass@github.com/org/repo.git'),
        'https://github.com/org/repo.git',
    );
});

test('stripEmbeddedCredentials() removes token-only userinfo from HTTPS URL', () => {
    assert.strictEqual(
        stripEmbeddedCredentials('https://ghp_token@github.com/org/repo.git'),
        'https://github.com/org/repo.git',
    );
});

test('stripEmbeddedCredentials() returns URL unchanged when no credentials are embedded', () => {
    const url = 'https://github.com/org/repo.git';
    assert.strictEqual(stripEmbeddedCredentials(url), url);
});

test('stripEmbeddedCredentials() returns SSH URL unchanged', () => {
    const url = 'git@github.com:org/repo.git';
    assert.strictEqual(stripEmbeddedCredentials(url), url);
});

test('stripEmbeddedCredentials() returns empty string unchanged', () => {
    assert.strictEqual(stripEmbeddedCredentials(''), '');
});

test('stripEmbeddedCredentials() returns malformed URL unchanged', () => {
    assert.strictEqual(stripEmbeddedCredentials('not-a-url'), 'not-a-url');
});

test('stripEmbeddedCredentials() preserves path and port after stripping', () => {
    assert.strictEqual(
        stripEmbeddedCredentials('https://user:pass@gitlab.example.com:8443/org/repo.git'),
        'https://gitlab.example.com:8443/org/repo.git',
    );
});

test('stripEmbeddedCredentials() scrubs token from git prose error message', () => {
    const input = "fatal: repository 'https://ghp_tok3n@github.com/org/repo.git' not found";
    const result = stripEmbeddedCredentials(input);
    assert.ok(!result.includes('ghp_tok3n'), `token should be redacted — got: ${result}`);
    assert.ok(result.includes('https://***@github.com'), `host should be preserved — got: ${result}`);
});

test('stripEmbeddedCredentials() scrubs multiple embedded URLs in a single prose message', () => {
    const input = "error: https://token1@host1.com/a and https://token2@host2.com/b";
    const result = stripEmbeddedCredentials(input);
    assert.ok(!result.includes('token1') && !result.includes('token2'), `tokens must be redacted — got: ${result}`);
});

// ─── resolveCredential() ──────────────────────────────────────────────────────

/** Shared fixture used across resolveCredential() tests. */
const CREDS: GitCredentialEntry[] = [
    { id: 'github-personal', label: 'GitHub Personal', host: 'github.com', token: 'ghp_abc' },
    { id: 'gitlab-work',     label: 'GitLab Work',     host: 'gitlab.com', token: 'glpat_xyz' },
];

test('resolveCredential() returns the matching entry when credentialId matches', () => {
    const result = resolveCredential('https://github.com/org/repo.git', CREDS, 'github-personal');
    assert.deepStrictEqual(result, CREDS[0]);
});

test('resolveCredential() returns null when credentialId does not match any entry', () => {
    const result = resolveCredential('https://github.com/org/repo.git', CREDS, 'stale-id');
    assert.strictEqual(result, null);
});

test('resolveCredential() auto-selects single host match when no credentialId is provided', () => {
    const result = resolveCredential('https://github.com/org/repo.git', CREDS);
    assert.deepStrictEqual(result, CREDS[0]);
});

test('resolveCredential() returns null when no credentials match the URL host', () => {
    const result = resolveCredential('https://bitbucket.org/org/repo.git', CREDS);
    assert.strictEqual(result, null);
});

test('resolveCredential() returns null when multiple credentials match the URL host (ambiguous)', () => {
    const ambiguousCreds: GitCredentialEntry[] = [
        { id: 'github-1', label: 'GitHub Acct 1', host: 'github.com', token: 'ghp_one' },
        { id: 'github-2', label: 'GitHub Acct 2', host: 'github.com', token: 'ghp_two' },
    ];
    const result = resolveCredential('https://github.com/org/repo.git', ambiguousCreds);
    assert.strictEqual(result, null);
});

test('resolveCredential() returns null when credentials array is empty and no credentialId is provided', () => {
    const result = resolveCredential('https://github.com/org/repo.git', []);
    assert.strictEqual(result, null);
});

test('resolveCredential() returns null when credentials array is empty and credentialId is provided', () => {
    const result = resolveCredential('https://github.com/org/repo.git', [], 'any-id');
    assert.strictEqual(result, null);
});

test('resolveCredential() returns null for a non-HTTPS URL (auto-selection path)', () => {
    const result = resolveCredential('git@github.com:org/repo.git', CREDS);
    assert.strictEqual(result, null);
});

test('resolveCredential() auto-selects a host match regardless of the stored host\'s casing', () => {
    const mixedCaseCreds: GitCredentialEntry[] = [
        { id: 'github-personal', label: 'GitHub Personal', host: 'GitHub.COM', token: 'ghp_abc' },
    ];
    const result = resolveCredential('https://github.com/org/repo.git', mixedCaseCreds);
    assert.deepStrictEqual(result, mixedCaseCreds[0]);
});

// ─── hostsEqual() ──────────────────────────────────────────────────────────────

test('hostsEqual() returns true for hostnames differing only by case', () => {
    assert.strictEqual(hostsEqual('GitHub.com', 'github.com'), true);
});

test('hostsEqual() returns false for genuinely different hostnames', () => {
    assert.strictEqual(hostsEqual('github.com', 'gitlab.com'), false);
});

// ─── injectCredentialToken() ──────────────────────────────────────────────────

test('injectCredentialToken() injects the token into an HTTPS URL', () => {
    const result = injectCredentialToken('https://github.com/org/repo.git', 'ghp_abc');
    assert.strictEqual(result, 'https://ghp_abc@github.com/org/repo.git');
});

test('injectCredentialToken() returns the original URL unchanged for an SSH URL', () => {
    const original = 'git@github.com:org/repo.git';
    assert.strictEqual(injectCredentialToken(original, 'ghp_abc'), original);
});

test('injectCredentialToken() returns the original URL unchanged for a non-HTTPS scheme', () => {
    const original = 'http://github.com/org/repo.git';
    assert.strictEqual(injectCredentialToken(original, 'ghp_abc'), original);
});

test('injectCredentialToken() preserves path and query string after injection', () => {
    const result = injectCredentialToken('https://github.com/org/repo.git?foo=bar', 'tok');
    assert.ok(result.startsWith('https://tok@github.com'), `unexpected result: ${result}`);
    assert.ok(result.includes('/org/repo.git?foo=bar'), `unexpected result: ${result}`);
});

test('injectCredentialToken() percent-encodes special characters in the token', () => {
    // The WHATWG URL serialiser must encode '@' and '/' inside the token so the
    // resulting URL is unambiguous and safe to pass directly to git.
    const result = injectCredentialToken('https://github.com/org/repo.git', 'tok@en/val');
    assert.ok(!result.includes('tok@en/val'), `raw special chars must be encoded — got: ${result}`);
    assert.ok(result.startsWith('https://'), `must remain HTTPS — got: ${result}`);
});
