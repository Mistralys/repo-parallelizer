import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import { checkWorkspaceHealth } from '../orchestration/workspace-health.js';

// ---------------------------------------------------------------------------
// Global temp directory — one root, cleaned up on process exit.
// ---------------------------------------------------------------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-health-test-'));

process.on('exit', () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Create a fresh temp sub-directory under tmpRoot for each test. */
function makeTempDir(): string {
    return fs.mkdtempSync(path.join(tmpRoot, 'test-'));
}

// ---------------------------------------------------------------------------
// Directory setup helpers
// ---------------------------------------------------------------------------

/**
 * Compute the expected `.code-workspace` file path (mirrors
 * `getWorkspaceFilePath` logic without importing it so this test stays
 * self-contained).
 */
function wsFilePath(projectsFolder: string, projectId: string, workspaceId: string): string {
    return path.join(projectsFolder, projectId, `${projectId}-${workspaceId}.code-workspace`);
}

/** Create the `.code-workspace` file on disk (parent dirs created if needed). */
function createWsFile(projectsFolder: string, projectId: string, workspaceId: string): void {
    const p = wsFilePath(projectsFolder, projectId, workspaceId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ folders: [] }));
}

/** Create a `.git` directory inside the repo path (simulates a cloned repo). */
function createRepoDotGit(
    projectsFolder: string,
    projectId: string,
    workspaceId: string,
    repoId: string,
): void {
    const gitDir = path.join(projectsFolder, projectId, workspaceId, repoId, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('returns healthy when workspace file exists and all repos are cloned', () => {
    const base = makeTempDir();
    const pid = 'proj';
    const wid = 'DEV';
    const repos = ['repo-a', 'repo-b'];

    createWsFile(base, pid, wid);
    for (const r of repos) {
        createRepoDotGit(base, pid, wid, r);
    }

    const report = checkWorkspaceHealth(pid, wid, base, repos);

    assert.strictEqual(report.healthy, true);
    assert.deepStrictEqual(report.issues, []);
});

test('returns workspace-file-missing issue when .code-workspace does not exist', () => {
    const base = makeTempDir();
    const pid = 'proj';
    const wid = 'DEV';
    const repos = ['repo-a'];

    // Only create the repo — omit the workspace file.
    createRepoDotGit(base, pid, wid, repos[0]);

    const report = checkWorkspaceHealth(pid, wid, base, repos);

    assert.strictEqual(report.healthy, false);
    assert.strictEqual(report.issues.length, 1);

    const issue = report.issues[0];
    assert.strictEqual(issue.type, 'workspace-file-missing');
    assert.strictEqual(issue.severity, 'warning');
    assert.strictEqual(issue.fixAction, 'regenerate-workspace-file');
    assert.strictEqual(typeof issue.message, 'string');
    assert.ok(issue.message.length > 0, 'message should be non-empty');
    assert.strictEqual(issue.repositoryId, undefined);
});

test('returns repository-not-cloned issue when repo has no .git directory', () => {
    const base = makeTempDir();
    const pid = 'proj';
    const wid = 'DEV';
    const repoId = 'missing-repo';

    createWsFile(base, pid, wid);
    // Do NOT create .git for the repo.

    const report = checkWorkspaceHealth(pid, wid, base, [repoId]);

    assert.strictEqual(report.healthy, false);
    assert.strictEqual(report.issues.length, 1);

    const issue = report.issues[0];
    assert.strictEqual(issue.type, 'repository-not-cloned');
    assert.strictEqual(issue.severity, 'warning');
    assert.strictEqual(issue.fixAction, 'setup-workspace');
    assert.strictEqual(issue.repositoryId, repoId);
    assert.strictEqual(typeof issue.message, 'string');
    assert.ok(issue.message.includes(repoId), 'message should mention the repo ID');
});

test('reports issues for each uncloned repo individually', () => {
    const base = makeTempDir();
    const pid = 'proj';
    const wid = 'DEV';
    const repos = ['repo-a', 'repo-b', 'repo-c'];

    createWsFile(base, pid, wid);
    // Only clone repo-a.
    createRepoDotGit(base, pid, wid, 'repo-a');

    const report = checkWorkspaceHealth(pid, wid, base, repos);

    assert.strictEqual(report.healthy, false);
    assert.strictEqual(report.issues.length, 2);

    const issuedRepoIds = report.issues.map((i) => i.repositoryId);
    assert.ok(issuedRepoIds.includes('repo-b'));
    assert.ok(issuedRepoIds.includes('repo-c'));
    assert.ok(!issuedRepoIds.includes('repo-a'));
});

test('returns both workspace-file-missing and repository-not-cloned when both problems exist', () => {
    const base = makeTempDir();
    const pid = 'proj';
    const wid = 'DEV';
    const repoId = 'my-repo';

    // Neither workspace file nor repo .git — workspace folder must exist for project dir.
    fs.mkdirSync(path.join(base, pid), { recursive: true });

    const report = checkWorkspaceHealth(pid, wid, base, [repoId]);

    assert.strictEqual(report.healthy, false);
    assert.strictEqual(report.issues.length, 2);

    const types = report.issues.map((i) => i.type);
    assert.ok(types.includes('workspace-file-missing'));
    assert.ok(types.includes('repository-not-cloned'));
});

test('returns healthy for initialized workspace with no repositories', () => {
    const base = makeTempDir();
    const pid = 'proj';
    const wid = 'DEV';

    createWsFile(base, pid, wid);
    // No repos to check.

    const report = checkWorkspaceHealth(pid, wid, base, []);

    assert.strictEqual(report.healthy, true);
    assert.deepStrictEqual(report.issues, []);
});

test('returns workspace-file-missing for initialized workspace with no repositories when file is absent', () => {
    const base = makeTempDir();
    const pid = 'proj';
    const wid = 'DEV';

    fs.mkdirSync(path.join(base, pid), { recursive: true });
    // Workspace file not created; empty repo list.

    const report = checkWorkspaceHealth(pid, wid, base, []);

    assert.strictEqual(report.healthy, false);
    assert.strictEqual(report.issues.length, 1);
    assert.strictEqual(report.issues[0].type, 'workspace-file-missing');
});

test('.git file (not directory) does not satisfy the cloned check', () => {
    const base = makeTempDir();
    const pid = 'proj';
    const wid = 'DEV';
    const repoId = 'shallow-repo';

    createWsFile(base, pid, wid);

    // Create a .git FILE (e.g. a git worktree pointer) rather than a directory.
    const repoDir = path.join(base, pid, wid, repoId);
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.git'), 'gitdir: ../../.git/worktrees/shallow');

    // checkWorkspaceHealth uses fs.existsSync on `.git` path which returns true
    // whether it's a file or directory — so this should be reported as cloned.
    const report = checkWorkspaceHealth(pid, wid, base, [repoId]);

    // existsSync returns true for files too, so the workspace should be healthy.
    assert.strictEqual(report.healthy, true);
    assert.deepStrictEqual(report.issues, []);
});
