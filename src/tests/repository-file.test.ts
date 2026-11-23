import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    validateRepositoryFileSet,
    repositoryFileMetadataProblem,
    repositoryFileRelativePath,
    REPOSITORY_FILE_MAX_COUNT,
    REPOSITORY_FILE_MAX_LABEL_LENGTH,
    REPOSITORY_FILE_MAX_DESCRIPTION_LENGTH,
    type RepositoryFile,
} from '../models/repository/repository-file.js';

function file(overrides?: Partial<RepositoryFile>): RepositoryFile {
    return {
        Id: 'id-1',
        Directory: '',
        FileName: 'run.sh',
        Label: 'Run',
        Description: 'Runs things.',
        Content: '#!/bin/sh\necho hi\n',
        Executable: true,
        ListInAgents: false,
        DateModified: '2026-11-18T00:00:00.000Z',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// validateRepositoryFileSet
// ---------------------------------------------------------------------------

test('validateRepositoryFileSet: returns an empty set unchanged', () => {
    assert.deepStrictEqual(validateRepositoryFileSet([]), []);
});

test('validateRepositoryFileSet: normalises a valid set, preserving Id and DateModified', () => {
    const input = [file({ Id: 'abc', Label: '  Run  ', DateModified: '2026-11-19T00:00:00.000Z' })];
    const result = validateRepositoryFileSet(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].Id, 'abc');
    assert.equal(result[0].DateModified, '2026-11-19T00:00:00.000Z');
    assert.equal(result[0].Label, 'Run');
});

test('validateRepositoryFileSet: preserves an explicit Executable flag rather than re-deriving it', () => {
    const input = [file({ Executable: false, Content: '#!/bin/sh\necho hi\n' })];
    const result = validateRepositoryFileSet(input);
    assert.equal(result[0].Executable, false);
});

test('validateRepositoryFileSet: rejects a set over REPOSITORY_FILE_MAX_COUNT files', () => {
    const files = Array.from({ length: REPOSITORY_FILE_MAX_COUNT + 1 }, (_, i) =>
        file({ Id: `id-${i}`, FileName: `f${i}.txt`, Executable: false, Content: '' }),
    );
    assert.throws(
        () => validateRepositoryFileSet(files),
        new RegExp(String(REPOSITORY_FILE_MAX_COUNT)),
    );
});

test('validateRepositoryFileSet: allows a set at exactly REPOSITORY_FILE_MAX_COUNT files', () => {
    const files = Array.from({ length: REPOSITORY_FILE_MAX_COUNT }, (_, i) =>
        file({ Id: `id-${i}`, FileName: `f${i}.txt`, Executable: false, Content: '' }),
    );
    assert.doesNotThrow(() => validateRepositoryFileSet(files));
});

test('validateRepositoryFileSet: rejects a case-insensitive path duplicate, prefixed with the offending path', () => {
    const files = [
        file({ Id: 'id-1', Directory: 'scripts', FileName: 'Run.sh' }),
        file({ Id: 'id-2', Directory: 'scripts', FileName: 'run.sh' }),
    ];
    assert.throws(
        () => validateRepositoryFileSet(files),
        (err: unknown) =>
            err instanceof Error &&
            err.message.startsWith(`File "${repositoryFileRelativePath(files[1])}": `) &&
            /already uses the path/.test(err.message),
    );
});

test('validateRepositoryFileSet: rejects an over-length Label, message equal to validateRepositoryFileInput() plus the path prefix', () => {
    const tooLong = 'x'.repeat(REPOSITORY_FILE_MAX_LABEL_LENGTH + 1);
    const files = [file({ Label: tooLong })];
    assert.throws(
        () => validateRepositoryFileSet(files),
        (err: unknown) =>
            err instanceof Error &&
            err.message === `File "${repositoryFileRelativePath(files[0])}": Label must be at most ${REPOSITORY_FILE_MAX_LABEL_LENGTH} characters.`,
    );
});

test('validateRepositoryFileSet: rejects an empty Label', () => {
    const files = [file({ Label: '   ' })];
    assert.throws(
        () => validateRepositoryFileSet(files),
        /Label is required\./,
    );
});

test('validateRepositoryFileSet: rejects an over-length Description', () => {
    const tooLong = 'x'.repeat(REPOSITORY_FILE_MAX_DESCRIPTION_LENGTH + 1);
    const files = [file({ Description: tooLong })];
    assert.throws(
        () => validateRepositoryFileSet(files),
        new RegExp(`Description must be at most ${REPOSITORY_FILE_MAX_DESCRIPTION_LENGTH} characters\\.`),
    );
});

test('validateRepositoryFileSet: rejects the reserved .git segment', () => {
    const files = [file({ Directory: '.git' })];
    assert.throws(() => validateRepositoryFileSet(files), /reserved/);
});

test('validateRepositoryFileSet: rejects invalid content (embedded NUL byte)', () => {
    const files = [file({ Content: 'a\u0000b', Executable: false })];
    assert.throws(() => validateRepositoryFileSet(files), /plain text/);
});

test('validateRepositoryFileSet: error message prefix names the offending file, not a sibling', () => {
    const files = [
        file({ Id: 'id-1', Directory: '', FileName: 'good.txt', Label: 'Good', Executable: false, Content: '' }),
        file({ Id: 'id-2', Directory: '', FileName: 'bad.txt', Label: '', Executable: false, Content: '' }),
    ];
    assert.throws(
        () => validateRepositoryFileSet(files),
        (err: unknown) => err instanceof Error && err.message.startsWith('File "bad.txt": '),
    );
});

// ---------------------------------------------------------------------------
// repositoryFileMetadataProblem
// ---------------------------------------------------------------------------

test('repositoryFileMetadataProblem: returns undefined for valid metadata', () => {
    assert.equal(repositoryFileMetadataProblem({ Label: 'Run', Description: 'Runs things.' }), undefined);
});

test('repositoryFileMetadataProblem: returns undefined for an empty Description', () => {
    assert.equal(repositoryFileMetadataProblem({ Label: 'Run', Description: '' }), undefined);
});

test('repositoryFileMetadataProblem: returns the Label violation message for an empty Label', () => {
    assert.equal(repositoryFileMetadataProblem({ Label: '   ', Description: '' }), 'Label is required.');
});

test('repositoryFileMetadataProblem: returns the Label violation message for an over-length Label', () => {
    const tooLong = 'x'.repeat(REPOSITORY_FILE_MAX_LABEL_LENGTH + 1);
    assert.equal(
        repositoryFileMetadataProblem({ Label: tooLong, Description: '' }),
        `Label must be at most ${REPOSITORY_FILE_MAX_LABEL_LENGTH} characters.`,
    );
});

test('repositoryFileMetadataProblem: returns the Description violation message for an over-length Description', () => {
    const tooLong = 'x'.repeat(REPOSITORY_FILE_MAX_DESCRIPTION_LENGTH + 1);
    assert.equal(
        repositoryFileMetadataProblem({ Label: 'Run', Description: tooLong }),
        `Description must be at most ${REPOSITORY_FILE_MAX_DESCRIPTION_LENGTH} characters.`,
    );
});

test('repositoryFileMetadataProblem: checks Label before Description when both are invalid', () => {
    const tooLongLabel = 'x'.repeat(REPOSITORY_FILE_MAX_LABEL_LENGTH + 1);
    const tooLongDescription = 'y'.repeat(REPOSITORY_FILE_MAX_DESCRIPTION_LENGTH + 1);
    assert.equal(
        repositoryFileMetadataProblem({ Label: tooLongLabel, Description: tooLongDescription }),
        `Label must be at most ${REPOSITORY_FILE_MAX_LABEL_LENGTH} characters.`,
    );
});
