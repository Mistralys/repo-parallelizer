import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    extractHost,
    injectCredentials,
    hasEmbeddedCredentials,
    stripEmbeddedCredentials,
} from '../git/git-credentials.js';

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

// ─── injectCredentials() ──────────────────────────────────────────────────────

test('injectCredentials() injects the token for a matching HTTPS host', () => {
    const result = injectCredentials(
        'https://github.com/org/repo.git',
        { 'github.com': 'ghp_abc' },
    );
    assert.strictEqual(result, 'https://ghp_abc@github.com/org/repo.git');
});

test('injectCredentials() returns original URL when host is not in credentials map', () => {
    const original = 'https://github.com/org/repo.git';
    const result = injectCredentials(original, { 'gitlab.com': 'token123' });
    assert.strictEqual(result, original);
});

test('injectCredentials() returns original URL when credentials map is empty', () => {
    const original = 'https://github.com/org/repo.git';
    const result = injectCredentials(original, {});
    assert.strictEqual(result, original);
});

test('injectCredentials() returns original URL for an SSH URL', () => {
    const original = 'git@github.com:org/repo.git';
    const result = injectCredentials(original, { 'github.com': 'token' });
    assert.strictEqual(result, original);
});

test('injectCredentials() returns original URL for an empty string', () => {
    assert.strictEqual(injectCredentials('', { 'github.com': 'token' }), '');
});

test('injectCredentials() handles multiple hosts and picks the correct one', () => {
    const creds = { 'github.com': 'ghp_github', 'gitlab.com': 'glpat_gitlab' };
    assert.strictEqual(
        injectCredentials('https://gitlab.com/org/repo.git', creds),
        'https://glpat_gitlab@gitlab.com/org/repo.git',
    );
    assert.strictEqual(
        injectCredentials('https://github.com/org/repo.git', creds),
        'https://ghp_github@github.com/org/repo.git',
    );
});

test('injectCredentials() preserves path and query string after injection', () => {
    const result = injectCredentials(
        'https://github.com/org/repo.git?foo=bar',
        { 'github.com': 'ghp_tok' },
    );
    assert.ok(result.includes('/org/repo.git?foo=bar'), `unexpected result: ${result}`);
    assert.ok(result.startsWith('https://ghp_tok@github.com'), `unexpected result: ${result}`);
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
