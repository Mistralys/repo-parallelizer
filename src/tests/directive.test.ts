import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DIRECTIVE_MAX_LENGTH,
    DIRECTIVES_MAX_COUNT,
    validateDirectiveInput,
    type AgentDirective,
} from '../models/project/directive.js';
import { GENERATED_BEGIN_MARKER } from '../orchestration/workspace-index.js';

// T-19 (directive part)

function dir(text: string, i = 0): AgentDirective {
    return { Id: `id-${i}`, Text: text, DateModified: '2026-01-01T00:00:00.000Z' };
}

test('limits: documented values', () => {
    assert.strictEqual(DIRECTIVE_MAX_LENGTH, 1000);
    assert.strictEqual(DIRECTIVES_MAX_COUNT, 50);
});

test('validateDirectiveInput: trims and collapses newlines', () => {
    const out = validateDirectiveInput({ Text: '  Run tests\r\nbefore commit\nplease  ' }, []);
    assert.strictEqual(out.Text, 'Run tests before commit please');
});

test('validateDirectiveInput: rejects empty and whitespace-only text', () => {
    assert.throws(() => validateDirectiveInput({ Text: '' }, []), /Directive is required/);
    assert.throws(() => validateDirectiveInput({ Text: ' \n ' }, []), /Directive is required/);
});

test('validateDirectiveInput: enforces max length boundary', () => {
    assert.doesNotThrow(() => validateDirectiveInput({ Text: 'a'.repeat(DIRECTIVE_MAX_LENGTH) }, []));
    assert.throws(() => validateDirectiveInput({ Text: 'a'.repeat(DIRECTIVE_MAX_LENGTH + 1) }, []), /at most 1000/);
});

test('validateDirectiveInput: rejects marker strings', () => {
    assert.throws(() => validateDirectiveInput({ Text: `x ${GENERATED_BEGIN_MARKER}` }, []), /marker/);
});

test('validateDirectiveInput: rejects case-insensitive duplicates in scope', () => {
    assert.throws(() => validateDirectiveInput({ Text: 'USE tabs' }, [dir('use Tabs')]), /already exists/);
    assert.doesNotThrow(() => validateDirectiveInput({ Text: 'other' }, [dir('use tabs')]));
});

test('validateDirectiveInput: enforces max count per scope', () => {
    const full = Array.from({ length: DIRECTIVES_MAX_COUNT }, (_, i) => dir(`rule ${i}`, i));
    assert.throws(() => validateDirectiveInput({ Text: 'one more' }, full), /At most 50/);
    assert.doesNotThrow(() => validateDirectiveInput({ Text: 'one more' }, full.slice(1)));
});

// T-19 (repository-role part)

test('validateRepositoryRole: limit, clearing, single paragraph and markers', async () => {
    const { REPOSITORY_ROLE_MAX_LENGTH, validateRepositoryRole } = await import('../models/project/repository-role.js');
    assert.strictEqual(REPOSITORY_ROLE_MAX_LENGTH, 500);
    assert.strictEqual(validateRepositoryRole('  \n '), '');
    assert.strictEqual(validateRepositoryRole(' a\nb '), 'a b');
    assert.strictEqual(validateRepositoryRole('x'.repeat(500)).length, 500);
    assert.throws(() => validateRepositoryRole('x'.repeat(501)), /at most 500 characters/);
    assert.throws(() => validateRepositoryRole(`x ${GENERATED_BEGIN_MARKER}`), /marker/);
});
