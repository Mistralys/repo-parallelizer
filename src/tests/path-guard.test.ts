import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import {
    isLexicallyContained,
    bestEffortRealpath,
    resolveRootRealPath,
    escapesRootViaRealpath,
    isDirectoryShaped,
    guardedFileTarget,
    pruneEmptyParents,
    MAX_SYMLINK_RESOLUTION_DEPTH,
} from '../utils/path-guard.js';

// ─── Fixture setup ────────────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-path-guard-test-'));

// Ensure the temporary directory is removed when the process exits.
process.on('exit', () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let dirCounter = 0;

function makeCase(): string {
    const dir = fs.mkdtempSync(path.join(tmpRoot, `case-${++dirCounter}-`));
    return dir;
}

// ─── isLexicallyContained() ───────────────────────────────────────────────────

test('isLexicallyContained() accepts the root itself', () => {
    assert.equal(isLexicallyContained('/a/b', '/a/b'), true);
});

test('isLexicallyContained() accepts a strict descendant', () => {
    assert.equal(isLexicallyContained('/a/b/c', '/a/b'), true);
});

test('isLexicallyContained() rejects a sibling path sharing a name prefix with the root', () => {
    // "/a/b-evil" shares the string prefix "/a/b" with root "/a/b" but is not
    // a descendant of it — the `+ path.sep` guard must reject this.
    assert.equal(isLexicallyContained('/a/b-evil', '/a/b'), false);
});

test('isLexicallyContained() rejects an unrelated path', () => {
    assert.equal(isLexicallyContained('/x/y', '/a/b'), false);
});

// ─── bestEffortRealpath() / escapesRootViaRealpath() ──────────────────────────

test('bestEffortRealpath() resolves a non-existent target inside the root without escaping', () => {
    const root = makeCase();
    const target = path.join(root, 'not-yet-created.md');

    const resolved = bestEffortRealpath(target);
    const resolvedRoot = resolveRootRealPath(root);

    assert.equal(isLexicallyContained(resolved, resolvedRoot), true);
    assert.equal(escapesRootViaRealpath(target, resolvedRoot), false);
});

test('escapesRootViaRealpath() reports a broken leaf symlink pointing outside the root as an escape', () => {
    const root = makeCase();
    const outsideTarget = path.join(tmpRoot, 'outside-target-does-not-exist.md');
    const linkPath = path.join(root, 'broken-link.md');

    fs.symlinkSync(outsideTarget, linkPath);

    const resolvedRoot = resolveRootRealPath(root);
    assert.equal(escapesRootViaRealpath(linkPath, resolvedRoot), true);
});

test('escapesRootViaRealpath() does not report an escape for a symlink resolving inside the root', () => {
    const root = makeCase();
    const insideTarget = path.join(root, 'inside-target.md');
    fs.writeFileSync(insideTarget, 'content', 'utf8');
    const linkPath = path.join(root, 'inside-link.md');
    fs.symlinkSync(insideTarget, linkPath);

    const resolvedRoot = resolveRootRealPath(root);
    assert.equal(escapesRootViaRealpath(linkPath, resolvedRoot), false);
});

test('escapesRootViaRealpath() reports a symlink chain longer than MAX_SYMLINK_RESOLUTION_DEPTH as an escape rather than throwing', () => {
    const root = makeCase();
    const chainLength = MAX_SYMLINK_RESOLUTION_DEPTH + 5;

    // Build a chain of symlinks link_0 -> link_1 -> ... -> link_{chainLength-1} -> final target.
    const finalTarget = path.join(root, 'final-target.md');
    fs.writeFileSync(finalTarget, 'content', 'utf8');

    let previousTarget = finalTarget;
    let headLink = '';
    for (let i = chainLength - 1; i >= 0; i--) {
        const linkPath = path.join(root, `link_${i}.md`);
        fs.symlinkSync(previousTarget, linkPath);
        previousTarget = linkPath;
        headLink = linkPath;
    }

    const resolvedRoot = resolveRootRealPath(root);

    assert.doesNotThrow(() => escapesRootViaRealpath(headLink, resolvedRoot));
    assert.equal(escapesRootViaRealpath(headLink, resolvedRoot), true);
});

// ─── isDirectoryShaped() ───────────────────────────────────────────────────────

test('isDirectoryShaped() returns true for a directory', () => {
    const root = makeCase();
    assert.equal(isDirectoryShaped(root), true);
});

test('isDirectoryShaped() returns false for a file', () => {
    const root = makeCase();
    const filePath = path.join(root, 'a-file.md');
    fs.writeFileSync(filePath, 'content', 'utf8');
    assert.equal(isDirectoryShaped(filePath), false);
});

test('isDirectoryShaped() returns false for an absent path', () => {
    const root = makeCase();
    const missingPath = path.join(root, 'does-not-exist.md');
    assert.equal(isDirectoryShaped(missingPath), false);
});

// ─── guardedFileTarget() ───────────────────────────────────────────────────

test('guardedFileTarget() resolves a safe relative path inside the root', () => {
    const root = makeCase();
    const resolved = guardedFileTarget(root, 'scripts/run.sh');
    assert.equal(resolved, path.join(root, 'scripts', 'run.sh'));
});

test('guardedFileTarget() rejects the root itself as a target', () => {
    const root = makeCase();
    assert.equal(guardedFileTarget(root, '.'), null);
});

test('guardedFileTarget() rejects a ".." traversal escaping the root', () => {
    const root = makeCase();
    assert.equal(guardedFileTarget(root, '../../etc/passwd'), null);
});

test('guardedFileTarget() rejects a symlinked sub-folder pointing outside the root', { skip: process.platform === 'win32' }, () => {
    const root = makeCase();
    const outside = makeCase();
    fs.symlinkSync(outside, path.join(root, 'scripts'));
    assert.equal(guardedFileTarget(root, 'scripts/run.sh'), null);
});

test('guardedFileTarget() rejects a target that already exists on disk as a directory', () => {
    const root = makeCase();
    fs.mkdirSync(path.join(root, 'a-folder'));
    assert.equal(guardedFileTarget(root, 'a-folder'), null);
});

// ─── pruneEmptyParents() ───────────────────────────────────────────────────

test('pruneEmptyParents() removes now-empty ancestor directories up to (not including) the given root', () => {
    const root = makeCase();
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });

    pruneEmptyParents(nested, root);

    assert.equal(fs.existsSync(path.join(root, 'a')), false);
    assert.equal(fs.existsSync(root), true);
});

test('pruneEmptyParents() stops at the first non-empty ancestor', () => {
    const root = makeCase();
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, 'a', 'keep.txt'), 'x');

    pruneEmptyParents(nested, root);

    assert.equal(fs.existsSync(path.join(root, 'a', 'b')), false);
    assert.equal(fs.existsSync(path.join(root, 'a', 'keep.txt')), true);
});

test('pruneEmptyParents() never removes the given root even when it is empty', () => {
    const root = makeCase();
    pruneEmptyParents(root, root);
    assert.equal(fs.existsSync(root), true);
});

test('pruneEmptyParents() does not climb past the given root to a shared-prefix sibling', () => {
    // Guards against a lexical-containment bug where "/a/b-evil" would be
    // treated as "inside" root "/a/b" purely by string prefix.
    const root = makeCase();
    const siblingPrefixed = `${root}-evil`;
    fs.mkdirSync(siblingPrefixed);
    pruneEmptyParents(siblingPrefixed, root);
    // Nothing to assert on removal (the dir is outside root by design) —
    // the call must simply not throw and must leave the root untouched.
    assert.equal(fs.existsSync(root), true);
});
