import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toKebabCase, isValidKebabCase, inferSlugFromUrl, isValidWorkspaceId } from '../utils/slug.js';

// --- toKebabCase ---

test('toKebabCase: converts spaces to hyphens', () => {
    assert.strictEqual(toKebabCase('My Cool Project'), 'my-cool-project');
});

test('toKebabCase: trims leading and trailing whitespace', () => {
    assert.strictEqual(toKebabCase('  hello world  '), 'hello-world');
});

test('toKebabCase: collapses consecutive special characters to one hyphen', () => {
    assert.strictEqual(toKebabCase('foo___bar--baz'), 'foo-bar-baz');
});

test('toKebabCase: preserves leading digits', () => {
    assert.strictEqual(toKebabCase('123 My Project'), '123-my-project');
});

test('toKebabCase: strips non-ASCII characters', () => {
    assert.strictEqual(toKebabCase('héllo'), 'h-llo');
});

test('toKebabCase: returns empty string for all-special input', () => {
    assert.strictEqual(toKebabCase('!@#$%'), '');
});

test('toKebabCase: single word is lowercased', () => {
    assert.strictEqual(toKebabCase('PROJECT'), 'project');
});

// --- isValidKebabCase ---

test('isValidKebabCase: accepts a valid multi-part slug', () => {
    assert.ok(isValidKebabCase('my-project'));
});

test('isValidKebabCase: accepts a single lowercase word', () => {
    assert.ok(isValidKebabCase('project'));
});

test('isValidKebabCase: accepts a slug with digits', () => {
    assert.ok(isValidKebabCase('project-2'));
});

test('isValidKebabCase: rejects uppercase letters', () => {
    assert.ok(!isValidKebabCase('My-Project'));
});

test('isValidKebabCase: rejects underscores', () => {
    assert.ok(!isValidKebabCase('my_project'));
});

test('isValidKebabCase: rejects consecutive hyphens', () => {
    assert.ok(!isValidKebabCase('foo--bar'));
});

test('isValidKebabCase: rejects leading hyphen', () => {
    assert.ok(!isValidKebabCase('-project'));
});

test('isValidKebabCase: rejects trailing hyphen', () => {
    assert.ok(!isValidKebabCase('project-'));
});

test('isValidKebabCase: rejects empty string', () => {
    assert.ok(!isValidKebabCase(''));
});

// --- inferSlugFromUrl ---

test('inferSlugFromUrl: HTTPS URL with .git suffix', () => {
    assert.strictEqual(
        inferSlugFromUrl('https://github.com/user/my-repo.git'),
        'my-repo'
    );
});

test('inferSlugFromUrl: SSH URL with .git suffix', () => {
    assert.strictEqual(
        inferSlugFromUrl('git@github.com:user/my-repo.git'),
        'my-repo'
    );
});

test('inferSlugFromUrl: HTTPS URL without .git suffix', () => {
    assert.strictEqual(
        inferSlugFromUrl('https://github.com/user/my-repo'),
        'my-repo'
    );
});

test('inferSlugFromUrl: returns empty string for empty input', () => {
    assert.strictEqual(inferSlugFromUrl(''), '');
});

// --- isValidWorkspaceId ---

test('isValidWorkspaceId: accepts a 2-char uppercase ID', () => {
    assert.ok(isValidWorkspaceId('AB'));
});

test('isValidWorkspaceId: accepts a 6-char uppercase ID', () => {
    assert.ok(isValidWorkspaceId('ABCDEF'));
});

test('isValidWorkspaceId: accepts a 3-char uppercase ID', () => {
    assert.ok(isValidWorkspaceId('DEV'));
});

test('isValidWorkspaceId: rejects a single character', () => {
    assert.ok(!isValidWorkspaceId('A'));
});

test('isValidWorkspaceId: rejects 7+ characters', () => {
    assert.ok(!isValidWorkspaceId('ABCDEFG'));
});

test('isValidWorkspaceId: rejects lowercase letters', () => {
    assert.ok(!isValidWorkspaceId('ab'));
});

test('isValidWorkspaceId: rejects digits in the ID', () => {
    assert.ok(!isValidWorkspaceId('AB1'));
});

test('isValidWorkspaceId: rejects empty string', () => {
    assert.ok(!isValidWorkspaceId(''));
});
