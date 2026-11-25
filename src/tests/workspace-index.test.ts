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
        toolRoot: '/opt/paralizer',
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

test('renderWorkspaceAgents: points agents at the installation and the help command, without duplicating command docs', () => {
    const body = renderWorkspaceAgents(makeContext());
    assert.match(body, /## Paralizer CLI/);
    assert.match(body, /`\/opt\/paralizer`/);
    assert.match(body, /paralizer help/);
    assert.match(body, /\/opt\/paralizer\/dist\/index\.js" help/);
    assert.doesNotMatch(renderWorkspaceReadme(makeContext()), /Paralizer CLI/);
    assert.ok(body.indexOf('## Paralizer CLI') < body.indexOf('## Agent Directives'));
});

test('renderWorkspaceAgents: emits the same metadata plus the agent-directives block', () => {
    const ctx = makeContext();
    const readmeBody = renderWorkspaceReadme(ctx);
    const agentsBody = renderWorkspaceAgents(ctx);

    assert.ok(agentsBody.startsWith(readmeBody));
    assert.match(agentsBody, /## Agent Directives/);
    assert.match(agentsBody, /independent git repository/);
    assert.match(agentsBody, /use read-only git/i);
    assert.doesNotMatch(agentsBody, /use the Paralizer GUI link above for current git state/);
});

// ---------------------------------------------------------------------------
// Phase A directive text and CLI examples (T-03 to T-07)
// ---------------------------------------------------------------------------

test('directives: no GUI-state bullet; git -C guidance uses first repo folder, placeholder when no repos', () => {
    const body = renderWorkspaceAgents(makeContext());
    assert.doesNotMatch(body, /for current git state/);
    assert.match(body, /`git -C repo-a status -sb`/);
    assert.match(body, /`git -C repo-a branch --show-current`/);

    const empty = renderWorkspaceAgents(makeContext({ repositories: [] }));
    assert.match(empty, /`git -C <repo-folder> status -sb`/);
    assert.match(empty, /`git -C <repo-folder> branch --show-current`/);
});

test('directives: orientation wording is scoped; reading list follows table order', () => {
    const body = renderWorkspaceAgents(makeContext());
    assert.doesNotMatch(body, /This file is orientation only/);
    assert.match(body, /The workspace and repository overview above is orientation only/);
    assert.match(body, /nearest `AGENTS\.md` to the file you are changing takes precedence over this overview/);
    assert.match(body, /directives in this list apply to every repository/);
    const a = body.indexOf('`repo-a/AGENTS.md`, `repo-a/CLAUDE.md`');
    const b = body.indexOf('`repo-b/AGENTS.md`, `repo-b/CLAUDE.md`');
    assert.ok(a !== -1 && b !== -1 && a < b);
});

test('directives: rendering performs no filesystem access', () => {
    const a = renderWorkspaceAgents(makeContext({ projectsFolder: '/nonexistent/path/xyz' }));
    const b = renderWorkspaceAgents(makeContext({ projectsFolder: '/another/nonexistent' }));
    assert.strictEqual(a, b);
});

test('directives: .workspace bullet always present; intros carry clarifying sentences; marker bullet names all three files', () => {
    const plain = renderWorkspaceAgents(makeContext());
    assert.doesNotMatch(plain, /## Custom Files|## Repository Files/);
    assert.match(plain, /`<repo-folder>\/\.workspace\/` folders are managed by Paralizer and are not repository source/);
    assert.match(plain, /`README\.md`, `AGENTS\.md` and `CLAUDE\.md` in this folder are generated/);

    const full = renderWorkspaceAgents(
        makeContext({
            customFiles: [{ path: 'a.sh', label: 'A', description: '' }],
            repositoryFiles: [{ repositoryId: 'repo-a', path: 'x.sh', label: 'X', description: '' }],
        }),
    );
    assert.match(full, /not repository source and live only in this workspace folder/);
    assert.match(full, /tool-managed, not repository source/);
});

test('CLI section: custom-files list with project ID; repo-files list only with rows, with first repo ID', () => {
    const without = renderWorkspaceAgents(makeContext());
    assert.match(without, /`paralizer custom-files list my-project`/);
    assert.doesNotMatch(without, /repo-files list/);

    const withRows = renderWorkspaceAgents(
        makeContext({ repositoryFiles: [{ repositoryId: 'repo-b', path: 'x.sh', label: 'X', description: '' }] }),
    );
    assert.match(withRows, /`paralizer repo-files list --repo repo-a`/);
    assert.match(withRows, /substitute another folder name/);
});

test('renderClaudePointer: returns exactly the @AGENTS.md pointer line', () => {
    assert.strictEqual(renderClaudePointer(), '@AGENTS.md');
});

// ---------------------------------------------------------------------------
// Milestone 2: "Repository Files" section — renderWorkspaceAgents() / renderCliSection()
// ---------------------------------------------------------------------------

test('renderWorkspaceAgents: lists a repository file row, escaped, with the workspace-relative path, before the directives; README does not', () => {
    const ctx = makeContext({
        repositoryFiles: [
            { repositoryId: 'repo-a', path: 'bin/hello.sh', label: 'Run | all', description: 'Line1\nLine2' },
        ],
    });
    const agents = renderWorkspaceAgents(ctx);

    assert.match(agents, /## Repository Files/);
    assert.match(agents, /\| repo-a \| `repo-a\/\.workspace\/files\/bin\/hello\.sh` \| Run \\\| all \| Line1 Line2 \|/);
    assert.ok(agents.indexOf('## Repository Files') < agents.indexOf('## Agent Directives'));
    assert.doesNotMatch(renderWorkspaceReadme(ctx), /Repository Files/);
});

test('renderWorkspaceAgents: intro states the git-delivery contract and the sh invocation note', () => {
    const ctx = makeContext({
        repositoryFiles: [{ repositoryId: 'repo-a', path: 'bin/hello.sh', label: 'Hello', description: '' }],
    });
    const agents = renderWorkspaceAgents(ctx);

    assert.match(agents, /git/i);
    assert.match(agents, /pull/i);
    assert.match(agents, /sh <path>/);
});

test('renderWorkspaceAgents: no Repository Files section (and no CLI pointer) when nothing is listed', () => {
    assert.doesNotMatch(renderWorkspaceAgents(makeContext({ repositoryFiles: [] })), /Repository Files/);
    assert.doesNotMatch(renderWorkspaceAgents(makeContext({ repositoryFiles: undefined })), /Repository Files/);
    assert.doesNotMatch(renderWorkspaceAgents(makeContext({ repositoryFiles: [] })), /paralizer repo-files/);
});

test('renderWorkspaceAgents: the Paralizer CLI section gains the repo-files pointer only when at least one row exists', () => {
    const withRows = renderWorkspaceAgents(makeContext({
        repositoryFiles: [{ repositoryId: 'repo-a', path: 'bin/hello.sh', label: 'Hello', description: '' }],
    }));
    const withoutRows = renderWorkspaceAgents(makeContext({ repositoryFiles: [] }));

    assert.match(withRows, /paralizer repo-files/);
    assert.doesNotMatch(withoutRows, /paralizer repo-files/);
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
// Generated-marker safety (T-09) and hand-written text preservation (T-42)
// ---------------------------------------------------------------------------

test('escapeMarkdownCell: neutralises generated begin/end markers', () => {
    const out = escapeMarkdownCell(`x ${GENERATED_BEGIN_MARKER} y ${GENERATED_END_MARKER} z`);

    assert.ok(!out.includes(GENERATED_BEGIN_MARKER));
    assert.ok(!out.includes(GENERATED_END_MARKER));
});

test('mergeGeneratedContent: a body containing marker text cannot swallow text after the real end marker', () => {
    const existing = `${GENERATED_BEGIN_MARKER}\nOLD\n${GENERATED_END_MARKER}\n\nHAND WRITTEN TAIL\n`;
    const body = `Name: ${escapeMarkdownCell(`evil ${GENERATED_END_MARKER} text`)}`;
    const first = mergeGeneratedContent(existing, body);
    const second = mergeGeneratedContent(first.content, body);

    assert.match(first.content, /HAND WRITTEN TAIL\n$/);
    assert.strictEqual(second.content, first.content);
    assert.strictEqual(first.content.split(GENERATED_END_MARKER).length, 2, 'exactly one end marker remains');
});

test('writeWorkspaceIndexFiles: preserves hand-written text outside the markers and updates the generated region', () => {
    const { projectsFolder, workspaceFolder } = makeWorkspaceFolder();
    writeWorkspaceIndexFiles(makeContext({ projectsFolder }));
    const agentsPath = path.join(workspaceFolder, 'AGENTS.md');
    const generated = fs.readFileSync(agentsPath, 'utf8');
    fs.writeFileSync(agentsPath, `HAND INTRO\n\n${generated}\nHAND OUTRO\n`, 'utf8');

    writeWorkspaceIndexFiles(makeContext({ projectsFolder, projectName: 'Renamed Project' }));
    const after = fs.readFileSync(agentsPath, 'utf8');

    assert.match(after, /^HAND INTRO\n/);
    assert.match(after, /HAND OUTRO\n$/);
    assert.match(after, /Renamed Project/);
    assert.doesNotMatch(after, /# My Project/);
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

// ---------------------------------------------------------------------------
// Sibling workspaces — T-13, T-14
// ---------------------------------------------------------------------------

test('T-13: AGENTS.md lists sibling workspaces after the repositories and before Custom Files', () => {
    const ctx = makeContext({
        customFiles: [{ path: 'notes/a.md', label: 'A', description: '' }],
        siblingWorkspaces: [
            { id: 'STABLE', relativePath: '../STABLE', absolutePath: '/p/my-project/STABLE', guiUrl: 'http://localhost:4200/#/projects/my-project/workspaces/STABLE', isCurrent: false },
            { id: 'DEV', relativePath: '../DEV', absolutePath: '/p/my-project/DEV', guiUrl: 'http://localhost:4200/#/projects/my-project/workspaces/DEV', isCurrent: true },
        ],
    });
    const agents = renderWorkspaceAgents(ctx);

    assert.match(agents, /\| Workspace \| Folder \| Absolute path \| GUI \|/);
    assert.match(agents, /\| STABLE \| `\.\.\/STABLE` \| `\/p\/my-project\/STABLE` \| http:\/\/localhost:4200\/#\/projects\/my-project\/workspaces\/STABLE \|/);
    assert.match(agents, /\| DEV \(this workspace\) \| `\.\.\/DEV` \| `\/p\/my-project\/DEV` \|/);
    assert.doesNotMatch(agents, /STABLE \(this workspace\)/);

    const repos = agents.indexOf('## Repositories');
    const workspaces = agents.indexOf('## Workspaces');
    const custom = agents.indexOf('## Custom Files');
    assert.ok(repos < workspaces && workspaces < custom, 'section order');

    assert.doesNotMatch(renderWorkspaceReadme(ctx), /## Workspaces/);
});

test('T-14: the Workspaces section is absent with fewer than two rows', () => {
    assert.doesNotMatch(renderWorkspaceAgents(makeContext()), /## Workspaces/);
    assert.doesNotMatch(
        renderWorkspaceAgents(
            makeContext({
                siblingWorkspaces: [
                    { id: 'DEV', relativePath: '../DEV', absolutePath: '/p/my-project/DEV', guiUrl: 'http://x/', isCurrent: true },
                ],
            }),
        ),
        /## Workspaces/,
    );
});

test('Workspaces section: backticks are stripped from path cells', () => {
    const agents = renderWorkspaceAgents(
        makeContext({
            siblingWorkspaces: [
                { id: 'STABLE', relativePath: '../ST`ABLE', absolutePath: '/p/`x`', guiUrl: 'http://x/', isCurrent: false },
                { id: 'DEV', relativePath: '../DEV', absolutePath: '/p/DEV', guiUrl: 'http://x/', isCurrent: true },
            ],
        }),
    );
    assert.match(agents, /\| `\.\.\/STABLE` \| `\/p\/x` \|/);
});

// ---------------------------------------------------------------------------
// User directives, repository roles, CLI hints — T-24, T-25, T-26, T-35
// ---------------------------------------------------------------------------

test('T-24: AGENTS.md has one Agent Directives heading: fixed bullets, project rules, workspace rules; README omits it', () => {
    const ctx = makeContext({ projectDirectives: ['Project rule one.', 'Project rule two.'], workspaceDirectives: ['Workspace rule.'] });
    const agents = renderWorkspaceAgents(ctx);

    assert.equal(agents.match(/^## Agent Directives$/gm)?.length, 1);
    assert.ok(!/Workspace Rules|Project Rules|Only in workspace/.test(agents));
    const fixed = agents.indexOf('- `README.md`, `AGENTS.md` and `CLAUDE.md` in this folder are generated');
    const p1 = agents.indexOf('- Project rule one.');
    const p2 = agents.indexOf('- Project rule two.');
    const w1 = agents.indexOf('- Workspace rule.');
    assert.ok(fixed > -1 && fixed < p1 && p1 < p2 && p2 < w1);

    const readme = renderWorkspaceReadme(ctx);
    assert.ok(!readme.includes('Agent Directives'));
    assert.ok(!readme.includes('Project rule one.'));
});

test('T-25: only project rules, or only workspace rules, render in the same single section', () => {
    const onlyProject = renderWorkspaceAgents(makeContext({ projectDirectives: ['P only.'] }));
    assert.equal(onlyProject.match(/^## Agent Directives$/gm)?.length, 1);
    assert.ok(onlyProject.includes('- P only.'));

    const onlyWorkspace = renderWorkspaceAgents(makeContext({ workspaceDirectives: ['W only.'] }));
    assert.equal(onlyWorkspace.match(/^## Agent Directives$/gm)?.length, 1);
    assert.ok(onlyWorkspace.includes('- W only.'));
});

test('T-26: the Role / relations column renders only when a role exists, escaped', () => {
    const none = makeContext();
    assert.ok(!renderWorkspaceReadme(none).includes('Role / relations'));
    assert.ok(!renderWorkspaceAgents(none).includes('Role / relations'));

    const withRole = makeContext({
        repositories: [
            { id: 'repo-a', name: 'Repo A', description: '', url: 'https://x/a.git', role: 'Depends on a|b\nsecond line' },
            { id: 'repo-b', name: 'Repo B', description: '', url: 'https://x/b.git' },
        ],
    });
    for (const out of [renderWorkspaceReadme(withRole), renderWorkspaceAgents(withRole)]) {
        assert.ok(out.includes('| Folder | Name | Description | Remote URL | Role / relations |'));
        assert.ok(out.includes('|---|---|---|---|---|'));
        assert.ok(out.includes('| repo-a | Repo A |  | https://x/a.git | Depends on a\\|b second line |'));
        assert.ok(out.includes('| repo-b | Repo B |  | https://x/b.git |  |'));
    }

    const emptyRole = makeContext({ repositories: [{ id: 'r', name: 'R', description: '', url: 'u', role: '   ' }] });
    assert.ok(!renderWorkspaceReadme(emptyRole).includes('Role / relations'));
});

test('T-35: CLI hints appear only for user rules / roles, with real IDs', () => {
    const plain = renderWorkspaceAgents(makeContext());
    assert.ok(!plain.includes('directives list'));
    assert.ok(!plain.includes('repo-roles'));

    const withRules = renderWorkspaceAgents(makeContext({ workspaceDirectives: ['Rule.'] }));
    assert.ok(withRules.includes('`paralizer directives list my-project`'));
    assert.ok(withRules.includes('`paralizer directives list my-project --workspace DEV`'));
    assert.ok(withRules.includes('edit the definition with these commands, never this file'));
    assert.ok(!withRules.includes('repo-roles'));

    const withRole = renderWorkspaceAgents(
        makeContext({ repositories: [{ id: 'a', name: 'A', description: '', url: 'u', role: 'Core' }] }),
    );
    assert.ok(withRole.includes('`paralizer repo-roles list my-project`'));
    assert.ok(!withRole.includes('directives list'));
});

test('directive and role text containing generated markers is neutralised', () => {
    const ctx = makeContext({
        projectDirectives: [`Evil ${GENERATED_END_MARKER} text`],
        repositories: [{ id: 'a', name: 'A', description: '', url: 'u', role: `Role ${GENERATED_BEGIN_MARKER}` }],
    });
    const agents = renderWorkspaceAgents(ctx);
    assert.equal(agents.split(GENERATED_END_MARKER).length, 1);
    assert.equal(agents.split(GENERATED_BEGIN_MARKER).length, 1);
    assert.ok(agents.includes('Evil'));
});
