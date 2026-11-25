import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    GENERATED_MARKER_TOKEN,
    containsGeneratedMarker,
    neutraliseGeneratedMarkers,
    collapseToSingleLine,
    normaliseSingleParagraph,
} from '../utils/single-paragraph-text.js';
import { GENERATED_BEGIN_MARKER, GENERATED_END_MARKER } from '../orchestration/workspace-index.js';

// T-45 (marker helpers)

test('markers: both generated markers contain GENERATED_MARKER_TOKEN', () => {
    assert.ok(GENERATED_BEGIN_MARKER.includes(GENERATED_MARKER_TOKEN));
    assert.ok(GENERATED_END_MARKER.includes(GENERATED_MARKER_TOKEN));
});

test('containsGeneratedMarker: detects begin, end and bare token; false otherwise', () => {
    assert.strictEqual(containsGeneratedMarker(GENERATED_BEGIN_MARKER), true);
    assert.strictEqual(containsGeneratedMarker(`x ${GENERATED_END_MARKER} y`), true);
    assert.strictEqual(containsGeneratedMarker(`bare ${GENERATED_MARKER_TOKEN} token`), true);
    assert.strictEqual(containsGeneratedMarker('plain text with <!-- a comment -->'), false);
});

test('neutraliseGeneratedMarkers: rewrites begin/end markers and the bare token', () => {
    for (const input of [GENERATED_BEGIN_MARKER, GENERATED_END_MARKER, `a ${GENERATED_MARKER_TOKEN} b`, `${GENERATED_BEGIN_MARKER}${GENERATED_END_MARKER}`]) {
        const out = neutraliseGeneratedMarkers(input);
        assert.notStrictEqual(out, input);
        assert.strictEqual(containsGeneratedMarker(out), false);
        assert.ok(!out.includes(GENERATED_BEGIN_MARKER) && !out.includes(GENERATED_END_MARKER));
    }
});

test('neutraliseGeneratedMarkers: identity for marker-free text', () => {
    for (const input of ['', 'plain', 'multi\nline | pipes', '<!-- other comment -->']) {
        assert.strictEqual(neutraliseGeneratedMarkers(input), input);
    }
});

test('collapseToSingleLine: collapses CR, LF and CRLF to single spaces and trims', () => {
    assert.strictEqual(collapseToSingleLine('a\nb'), 'a b');
    assert.strictEqual(collapseToSingleLine('a\rb'), 'a b');
    assert.strictEqual(collapseToSingleLine('a\r\nb'), 'a b');
    assert.strictEqual(collapseToSingleLine('  a\n  '), 'a');
    assert.strictEqual(collapseToSingleLine('no breaks'), 'no breaks');
});

// T-45 (normaliseSingleParagraph part)

test('normaliseSingleParagraph: collapses line breaks and trims', () => {
    assert.strictEqual(normaliseSingleParagraph('  a\r\nb\nc\rd  ', 100, 'Field'), 'a b c d');
    assert.strictEqual(normaliseSingleParagraph('plain', 100, 'Field'), 'plain');
});

test('normaliseSingleParagraph: rejects empty input naming the field', () => {
    assert.throws(() => normaliseSingleParagraph(' \n ', 10, 'Directive'), /^Error: Directive is required\./);
});

test('normaliseSingleParagraph: enforces max length after collapsing', () => {
    assert.strictEqual(normaliseSingleParagraph('abcde', 5, 'Field'), 'abcde');
    assert.throws(() => normaliseSingleParagraph('abcdef', 5, 'Field'), /Field must be at most 5 characters/);
});

test('normaliseSingleParagraph: rejects marker text naming the field', () => {
    assert.throws(() => normaliseSingleParagraph(GENERATED_BEGIN_MARKER, 500, 'Field'), /Field must not contain/);
});
