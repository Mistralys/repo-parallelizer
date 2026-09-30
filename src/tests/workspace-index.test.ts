import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    WORKSPACE_INDEX_FILE_NAMES,
    GENERATED_BEGIN_MARKER,
    GENERATED_END_MARKER,
    escapeMarkdownCell,
    renderWorkspaceReadme,
    renderWorkspaceAgents,
    renderClaudePointer,
    mergeGeneratedContent,
    writeWorkspaceIndexFiles,
    removeWorkspaceIndexFiles,
    checkIndexFileStatus,
    type WorkspaceIndexContext,
} from '../orchestration/workspace-index.js';
import { createTempDirTracker } from './test-helpers.js';

const makeTempDir = createTempDirTracker('paralizer-workspace-index-test-');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<WorkspaceIndexContext>): WorkspaceIndexContext {
    return {
        projectsFolder: '/tmp/does-not-matter',
        projectId: 'my-project',
        projectName: 'My Project',
        projectDescription: 'A project description.',
        workspaceId: 'DEV',
        workspaceDescription: 'A workspace description.',
        workspaceNotes: 'Some notes.',
        repositories: [
            { id: 'repo-a', name: 'Repo A', description: 'First repo.', url: 'https://github.com/org/repo-a.git' },
            { id: 'repo-b', name: 'Repo B', description: 'Second repo.', url: 'https://github.com/org/repo-b.git' },
        ],
        guiUrl: 'http://localhost:4200/#/projects/my-project/workspaces/DEV',
        toolVersion: '1.2.3',
        generatedAt: '2026-09-25T00:00:00.000Z',
        ...overrides,
    };
}

/** Builds a real workspace folder under a fresh temp root and returns its path. */
function makeWorkspaceFolder(): { projectsFolder: string; workspaceFolder: string } {
    const projectsFolder = makeTempDir();
    const workspaceFolder = path.join(projectsFolder, 'my-project', 'DEV');
    fs.mkdirSync(workspaceFolder, { recursive: true });
    return { projectsFolder, workspaceFolder };
}

// ---------------------------------------------------------------------------
// escapeMarkdownCell() — AC-06
// ---------------------------------------------------------------------------

test('escapeMarkdownCell: escapes pipes', () => {
    assert.strictEqual(escapeMarkdownCell('a | b'), 'a \\| b');
});

test('escapeMarkdownCell: collapses CR/LF sequences to a single space', () => {
    assert.strictEqual(escapeMarkdownCell('line one\nline two\r\nline three'), 'line one line two line three');
});

test('escapeMarkdownCell: trims leading and trailing whitespace', () => {
    assert.strictEqual(escapeMarkdownCell('   padded   '), 'padded');
});

test('escapeMarkdownCell: a description with a pipe and a newline yields a single well-formed table row', () => {
    const ctx = makeContext({
        repositories: [
            { id: 'repo-a', name: 'Repo A', description: 'Line one | with pipe\nLine two', url: 'https://github.com/org/repo-a.git' },
        ],
    });

    const body = renderWorkspaceReadme(ctx);
    const rowLine = body.split('\n').find((l) => l.startsWith('| repo-a '));

    assert.ok(rowLine !== undefined, 'expected a table row for repo-a');
    // Exactly 5 pipe characters => 4 columns (the escaped pipe must not count as a separator).
    assert.strictEqual((rowLine as string).match(/(?<!\\)\|/g)?.length, 5);
    assert.ok(!(rowLine as string).includes('\n'));
});

test('escapeMarkdownCell: a repository URL with a pipe and a newline is escaped in the table row, not embedded raw', () => {
    const ctx = makeContext({
        repositories: [
            { id: 'repo-a', name: 'Repo A', description: 'First repo.', url: 'https://github.com/org/repo-a.git|evil\ninjected' },
        ],
    });

    const body = renderWorkspaceReadme(ctx);
    const rowLine = body.split('\n').find((l) => l.startsWith('| repo-a '));

    assert.ok(rowLine !== undefined, 'expected a table row for repo-a');
    // Exactly 5 pipe characters => 4 columns (the escaped pipe in the URL must not count as a separator).
    assert.strictEqual((rowLine as string).match(/(?<!\\)\|/g)?.length, 5);
    assert.ok(!(rowLine as string).includes('\n'));
    assert.ok((rowLine as string).includes('evil injected'));
});

// ---------------------------------------------------------------------------
// renderWorkspaceReadme() / renderWorkspaceAgents() / renderClaudePointer() — AC-05
// ---------------------------------------------------------------------------

test('renderWorkspaceReadme: emits project/workspace metadata, the repository table in supplied order, and the GUI link', () => {
    const ctx = makeContext();
    const body = renderWorkspaceReadme(ctx);

    assert.match(body, /My Project/);
    assert.match(body, /A project description\./);
    assert.match(body, /DEV/);
    assert.match(body, /A workspace description\./);
    assert.match(body, /Some notes\./);
    assert.match(body, /http:\/\/localhost:4200\/#\/projects\/my-project\/workspaces\/DEV/);
    assert.match(body, /1\.2\.3/);
    assert.match(body, /2026-09-25T00:00:00\.000Z/);

    const repoAIndex = body.indexOf('repo-a');
    const repoBIndex = body.indexOf('repo-b');
    assert.ok(repoAIndex !== -1 && repoBIndex !== -1 && repoAIndex < repoBIndex, 'repositories must appear in supplied order');
});

test('renderWorkspaceReadme: omits the agent-directives block', () => {
    const body = renderWorkspaceReadme(makeContext());
    assert.doesNotMatch(body, /Agent Directives/);
});

test('renderWorkspaceAgents: emits the same metadata plus the agent-directives block', () => {
    const ctx = makeContext();
    const readmeBody = renderWorkspaceReadme(ctx);
    const agentsBody = renderWorkspaceAgents(ctx);

    assert.ok(agentsBody.startsWith(readmeBody));
    assert.match(agentsBody, /## Agent Directives/);
    assert.match(agentsBody, /independent git repository/);
});

test('renderClaudePointer: returns exactly the @AGENTS.md pointer line', () => {
    assert.strictEqual(renderClaudePointer(), '@AGENTS.md');
});

// ---------------------------------------------------------------------------
// mergeGeneratedContent() — AC-07
// ---------------------------------------------------------------------------

test('mergeGeneratedContent: builds a fresh fenced file when existing is null', () => {
    const { content, skipped } = mergeGeneratedContent(null, 'BODY');

    assert.strictEqual(skipped, false);
    assert.strictEqual(content, `${GENERATED_BEGIN_MARKER}\nBODY\n${GENERATED_END_MARKER}\n`);
});

test('mergeGeneratedContent: preserves text before and after the fence and replaces the fenced body', () => {
    const existing = `# Hand-written intro\n\n${GENERATED_BEGIN_MARKER}\nOLD BODY\n${GENERATED_END_MARKER}\n\n# Hand-written outro\n`;
    const { content, skipped } = mergeGeneratedContent(existing, 'NEW BODY');

    assert.strictEqual(skipped, false);
    assert.match(content, /^# Hand-written intro/);
    assert.match(content, /# Hand-written outro\n$/);
    assert.match(content, /NEW BODY/);
    assert.doesNotMatch(content, /OLD BODY/);
});

test('mergeGeneratedContent: round-tripping twice with the same body is idempotent', () => {
    const first = mergeGeneratedContent(null, 'STABLE BODY');
    const second = mergeGeneratedContent(first.content, 'STABLE BODY');

    assert.strictEqual(second.content, first.content);
});

test('mergeGeneratedContent: reports skipped=true and leaves content unchanged when no begin marker is present', () => {
    const existing = '# A file I wrote myself, with no generated fence.\n';
    const { content, skipped } = mergeGeneratedContent(existing, 'BODY');

    assert.strictEqual(skipped, true);
    assert.strictEqual(content, existing);
});

// ---------------------------------------------------------------------------
// writeWorkspaceIndexFiles() — AC-08, AC-09
// ---------------------------------------------------------------------------

test('writeWorkspaceIndexFiles: writes all three files on first run', () => {
    const { projectsFolder, workspaceFolder } = makeWorkspaceFolder();
    const ctx = makeContext({ projectsFolder });

    const { written, skipped } = writeWorkspaceIndexFiles(ctx);

    assert.deepEqual(written.sort(), [...WORKSPACE_INDEX_FILE_NAMES].sort());
    assert.deepEqual(skipped, []);
    for (const name of WORKSPACE_INDEX_FILE_NAMES) {
        assert.ok(fs.existsSync(path.join(workspaceFolder, name)), `${name} should exist`);
    }
});

test('writeWorkspaceIndexFiles: reports a file with no begin marker as skipped and leaves its bytes unchanged', () => {
    const { projectsFolder, workspaceFolder } = makeWorkspaceFolder();
    const handAuthored = '# My own README, thank you.\n';
    fs.writeFileSync(path.join(workspaceFolder, 'README.md'), handAuthored, 'utf8');

    const ctx = makeContext({ projectsFolder });
    const { written, skipped } = writeWorkspaceIndexFiles(ctx);

    assert.ok(skipped.includes('README.md'));
    assert.ok(!written.includes('README.md'));
    assert.strictEqual(fs.readFileSync(path.join(workspaceFolder, 'README.md'), 'utf8'), handAuthored);
});

test('writeWorkspaceIndexFiles: writes nothing and creates no directory when the workspace folder is absent', () => {
    const projectsFolder = makeTempDir();
    const workspaceFolder = path.join(projectsFolder, 'my-project', 'DEV');
    const ctx = makeContext({ projectsFolder });

    const { written, skipped } = writeWorkspaceIndexFiles(ctx);

    assert.deepEqual(written, []);
    assert.deepEqual(skipped, []);
    assert.strictEqual(fs.existsSync(workspaceFolder), false);
});

test('writeWorkspaceIndexFiles: rejects a target that resolves to a directory', () => {
    const { projectsFolder, workspaceFolder } = makeWorkspaceFolder();
    // "README.md" exists as a directory instead of a file.
    fs.mkdirSync(path.join(workspaceFolder, 'README.md'));

    const ctx = makeContext({ projectsFolder });
    const { written, skipped } = writeWorkspaceIndexFiles(ctx);

    assert.ok(skipped.includes('README.md'));
    assert.ok(!written.includes('README.md'));
    assert.ok(fs.statSync(path.join(workspaceFolder, 'README.md')).isDirectory());
});

test('writeWorkspaceIndexFiles: rejects a workspace folder symlinked outside projectsFolder', () => {
    const projectsFolder = makeTempDir();
    const outsideTarget = makeTempDir(); // a sibling temp root, not under projectsFolder
    const projectDir = path.join(projectsFolder, 'my-project');
    fs.mkdirSync(projectDir, { recursive: true });

    // The workspace folder itself is a symlink pointing outside projectsFolder.
    fs.symlinkSync(outsideTarget, path.join(projectDir, 'DEV'), 'dir');

    const ctx = makeContext({ projectsFolder });
    const { written, skipped } = writeWorkspaceIndexFiles(ctx);

    assert.deepEqual(written, []);
    assert.deepEqual(skipped.sort(), [...WORKSPACE_INDEX_FILE_NAMES].sort());
    for (const name of WORKSPACE_INDEX_FILE_NAMES) {
        assert.strictEqual(fs.existsSync(path.join(outsideTarget, name)), false, `${name} must not be written outside projectsFolder`);
    }
});

test('writeWorkspaceIndexFiles: rejects a broken symlink planted at a target filename', () => {
    const { projectsFolder, workspaceFolder } = makeWorkspaceFolder();
    const outsideRoot = makeTempDir();
    // A target that does not (and, deliberately, will never) exist — the
    // symlink is broken from the moment it is created.
    const outsideTarget = path.join(outsideRoot, 'escaped-README.md');

    fs.symlinkSync(outsideTarget, path.join(workspaceFolder, 'README.md'));

    const ctx = makeContext({ projectsFolder });
    const { written, skipped } = writeWorkspaceIndexFiles(ctx);

    assert.ok(skipped.includes('README.md'));
    assert.ok(!written.includes('README.md'));
    assert.strictEqual(fs.existsSync(outsideTarget), false, 'the broken symlink target must not be created outside projectsFolder');
});

test('writeWorkspaceIndexFiles: rejects a symlink at a target filename pointing to an existing outside file', () => {
    const { projectsFolder, workspaceFolder } = makeWorkspaceFolder();
    const outsideRoot = makeTempDir();
    const outsideTarget = path.join(outsideRoot, 'existing-README.md');
    const outsideOriginalContent = '# Pre-existing outside file, must not be touched.\n';
    fs.writeFileSync(outsideTarget, outsideOriginalContent, 'utf8');

    fs.symlinkSync(outsideTarget, path.join(workspaceFolder, 'README.md'));

    const ctx = makeContext({ projectsFolder });
    const { written, skipped } = writeWorkspaceIndexFiles(ctx);

    assert.ok(skipped.includes('README.md'));
    assert.ok(!written.includes('README.md'));
    assert.strictEqual(fs.readFileSync(outsideTarget, 'utf8'), outsideOriginalContent, 'the existing outside file must be left untouched');
});

// ---------------------------------------------------------------------------
// removeWorkspaceIndexFiles() — AC-08
// ---------------------------------------------------------------------------

test('removeWorkspaceIndexFiles: removes only files that contain the begin marker', () => {
    const { projectsFolder, workspaceFolder } = makeWorkspaceFolder();
    const ctx = makeContext({ projectsFolder });
    writeWorkspaceIndexFiles(ctx);

    const handAuthored = '# Hand authored, no marker.\n';
    fs.writeFileSync(path.join(workspaceFolder, 'CLAUDE.md'), handAuthored, 'utf8');

    removeWorkspaceIndexFiles(projectsFolder, ctx.projectId, ctx.workspaceId);

    assert.strictEqual(fs.existsSync(path.join(workspaceFolder, 'README.md')), false);
    assert.strictEqual(fs.existsSync(path.join(workspaceFolder, 'AGENTS.md')), false);
    // CLAUDE.md had no marker (overwritten by the hand-authored write above) — left in place.
    assert.strictEqual(fs.existsSync(path.join(workspaceFolder, 'CLAUDE.md')), true);
    assert.strictEqual(fs.readFileSync(path.join(workspaceFolder, 'CLAUDE.md'), 'utf8'), handAuthored);
});

test('removeWorkspaceIndexFiles: tolerates a missing workspace folder and missing files', () => {
    const projectsFolder = makeTempDir();
    assert.doesNotThrow(() => removeWorkspaceIndexFiles(projectsFolder, 'nonexistent-project', 'GHOST'));
});

// ---------------------------------------------------------------------------
// checkIndexFileStatus() — AC-14, AC-19
// ---------------------------------------------------------------------------

test('checkIndexFileStatus: classifies each file as missing, present-managed, or present-unmanaged', () => {
    const { projectsFolder, workspaceFolder } = makeWorkspaceFolder();

    // README.md: managed (contains the begin marker).
    fs.writeFileSync(path.join(workspaceFolder, 'README.md'), `${GENERATED_BEGIN_MARKER}\nBODY\n${GENERATED_END_MARKER}\n`, 'utf8');
    // AGENTS.md: unmanaged (no marker).
    fs.writeFileSync(path.join(workspaceFolder, 'AGENTS.md'), '# Hand authored\n', 'utf8');
    // CLAUDE.md: absent entirely.

    const { missing, unmanaged } = checkIndexFileStatus(projectsFolder, 'my-project', 'DEV');

    assert.deepEqual(missing, ['CLAUDE.md']);
    assert.deepEqual(unmanaged, ['AGENTS.md']);
});

test('checkIndexFileStatus: returns both arrays empty when the workspace folder is absent, without creating it', () => {
    const projectsFolder = makeTempDir();
    const workspaceFolder = path.join(projectsFolder, 'my-project', 'DEV');

    const { missing, unmanaged } = checkIndexFileStatus(projectsFolder, 'my-project', 'DEV');

    assert.deepEqual(missing, []);
    assert.deepEqual(unmanaged, []);
    assert.strictEqual(fs.existsSync(workspaceFolder), false);
});

test('checkIndexFileStatus: performs no write to an existing managed file', () => {
    const { projectsFolder, workspaceFolder } = makeWorkspaceFolder();
    const managedContent = `${GENERATED_BEGIN_MARKER}\nBODY\n${GENERATED_END_MARKER}\n`;
    fs.writeFileSync(path.join(workspaceFolder, 'README.md'), managedContent, 'utf8');

    checkIndexFileStatus(projectsFolder, 'my-project', 'DEV');

    assert.strictEqual(fs.readFileSync(path.join(workspaceFolder, 'README.md'), 'utf8'), managedContent);
});

test('checkIndexFileStatus() and writeWorkspaceIndexFiles() agree on the same unmanaged file', () => {
    const { projectsFolder, workspaceFolder } = makeWorkspaceFolder();
    const handAuthored = '# Hand authored, no marker.\n';
    fs.writeFileSync(path.join(workspaceFolder, 'README.md'), handAuthored, 'utf8');

    const ctx = makeContext({ projectsFolder });
    const { skipped } = writeWorkspaceIndexFiles(ctx);
    const { unmanaged } = checkIndexFileStatus(projectsFolder, 'my-project', 'DEV');

    assert.ok(skipped.includes('README.md'));
    assert.ok(unmanaged.includes('README.md'));
});
