import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    UsageError,
    parseCommandArgs,
    requirePositionals,
    readContentSource,
    readFlagPair,
    resolveFileReference,
} from '../cli/file-command-helpers.js';

// ─── parseCommandArgs() ───────────────────────────────────────────────────────

test('parseCommandArgs() rethrows a parseArgs() failure as a UsageError with a help hint', () => {
    assert.throws(
        () => parseCommandArgs(['--bogus'], {}),
        (err: unknown) => err instanceof UsageError && /see 'paralizer help'/.test((err as Error).message),
    );
});

test('parseCommandArgs() parses known options and positionals normally', () => {
    const { values, positionals } = parseCommandArgs(['a', '--label', 'X', 'b'], { label: { type: 'string' } });
    assert.deepEqual(positionals, ['a', 'b']);
    assert.equal(values.label, 'X');
});

// ─── requirePositionals() ─────────────────────────────────────────────────────

test('requirePositionals() throws a command-name-aware usage message when the count does not match', () => {
    assert.throws(
        () => requirePositionals(['a'], 2, 'show <project-id> <file>', 'custom-files'),
        (err: unknown) => err instanceof UsageError && (err as Error).message === "Usage: paralizer custom-files show <project-id> <file>",
    );
    assert.throws(
        () => requirePositionals([], 1, 'list --repo <repo-id>', 'repo-files'),
        (err: unknown) => err instanceof UsageError && (err as Error).message === "Usage: paralizer repo-files list --repo <repo-id>",
    );
});

test('requirePositionals() does not throw when the count matches', () => {
    assert.doesNotThrow(() => requirePositionals(['a', 'b'], 2, 'usage', 'custom-files'));
});

// ─── readContentSource() ──────────────────────────────────────────────────────

test('readContentSource() returns the single given source: --content, --stdin, or --content-file', async () => {
    const readStdin = async () => 'from-stdin';
    assert.equal(await readContentSource({ content: 'literal' }, readStdin), 'literal');
    assert.equal(await readContentSource({ stdin: true }, readStdin), 'from-stdin');
});

test("readContentSource() treats --content-file - as reading stdin", async () => {
    const readStdin = async () => 'from-stdin';
    assert.equal(await readContentSource({ 'content-file': '-' }, readStdin), 'from-stdin');
});

test('readContentSource() returns undefined when no source was given', async () => {
    assert.equal(await readContentSource({}, async () => ''), undefined);
});

test('readContentSource() rejects more than one source option', async () => {
    await assert.rejects(
        () => readContentSource({ content: 'a', stdin: true }, async () => ''),
        (err: unknown) => err instanceof UsageError && /only one of/.test((err as Error).message),
    );
});

test('readContentSource() throws a plain Error (not UsageError) when --content-file cannot be read', async () => {
    await assert.rejects(
        () => readContentSource({ 'content-file': '/does/not/exist/at/all.txt' }, async () => ''),
        (err: unknown) => !(err instanceof UsageError) && err instanceof Error && /Cannot read content file/.test(err.message),
    );
});

// ─── readFlagPair() ───────────────────────────────────────────────────────────

test('readFlagPair() returns true/false/undefined for --name / --no-name / neither', () => {
    assert.equal(readFlagPair({ executable: true }, 'executable'), true);
    assert.equal(readFlagPair({ 'no-executable': true }, 'executable'), false);
    assert.equal(readFlagPair({}, 'executable'), undefined);
});

test('readFlagPair() rejects both --name and --no-name', () => {
    assert.throws(
        () => readFlagPair({ 'list-in-agents': true, 'no-list-in-agents': true }, 'list-in-agents'),
        (err: unknown) => err instanceof UsageError && (err as Error).message === 'Use only one of --list-in-agents and --no-list-in-agents.',
    );
});

// ─── resolveFileReference() ───────────────────────────────────────────────────

interface Item {
    Id: string;
    path: string;
}

function makeItems(): Item[] {
    return [
        { Id: 'abcdef12', path: 'scripts/deploy.sh' },
        { Id: 'abcdef99', path: 'scripts/build.sh' },
        { Id: '11112222', path: 'notes.txt' },
    ];
}

const opts = { relativePath: (i: Item) => i.path, noun: 'test item', listHint: 'paralizer test list' };

test('resolveFileReference() resolves by exact ID first', () => {
    const found = resolveFileReference(makeItems(), 'abcdef12', opts);
    assert.equal(found.path, 'scripts/deploy.sh');
});

test('resolveFileReference() resolves by case-insensitive path, with backslashes accepted', () => {
    assert.equal(resolveFileReference(makeItems(), 'SCRIPTS/DEPLOY.SH', opts).Id, 'abcdef12');
    assert.equal(resolveFileReference(makeItems(), 'scripts\\deploy.sh', opts).Id, 'abcdef12');
});

test('resolveFileReference() resolves by a unique ID prefix of at least 4 characters', () => {
    assert.equal(resolveFileReference(makeItems(), '1111', opts).path, 'notes.txt');
});

test('resolveFileReference() rejects an ambiguous prefix with a scope-specific message', () => {
    assert.throws(
        () => resolveFileReference(makeItems(), 'abcdef', opts),
        /"abcdef" matches several test items — use a longer ID prefix or the path\./,
    );
});

test('resolveFileReference() rejects a short prefix (< 4 chars) as a no-match, not an ambiguous match', () => {
    assert.throws(
        () => resolveFileReference(makeItems(), 'abc', opts),
        /No test item matches "abc"\. Run 'paralizer test list' to see them\./,
    );
});

test('resolveFileReference() reports no match with the scope-specific list hint', () => {
    assert.throws(
        () => resolveFileReference(makeItems(), 'does-not-exist', opts),
        /No test item matches "does-not-exist"\. Run 'paralizer test list' to see them\./,
    );
});

test('resolveFileReference() works without relativePath: ID, unique prefix, ambiguous prefix, no match', () => {
    const noPath = { noun: 'directive', listHint: 'paralizer directives list <project-id>' };
    assert.equal(resolveFileReference(makeItems(), 'ABCDEF12', noPath).path, 'scripts/deploy.sh');
    assert.equal(resolveFileReference(makeItems(), '1111', noPath).path, 'notes.txt');
    assert.throws(() => resolveFileReference(makeItems(), 'abcdef', noPath), /matches several directives/);
    // A path is not a valid reference when no relativePath callback is given.
    assert.throws(() => resolveFileReference(makeItems(), 'notes.txt', noPath), /No directive matches/);
});
