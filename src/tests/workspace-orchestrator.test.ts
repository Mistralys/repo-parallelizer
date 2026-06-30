import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { initializeStorage } from '../storage/json-storage.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { ProjectManager } from '../models/project/project.manager.js';
import { WorkspaceManager } from '../models/workspace/workspace.manager.js';
import { WorkspaceOrchestrator } from '../orchestration/workspace-orchestrator.js';
import { ErrorLogManager } from '../error-log/error-log.manager.js';
import type { AppConfig } from '../config/config.types.js';
import { setupFakeGit, makeTestConfig } from './test-helpers.js';

// ─── Global fixtures ──────────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-ws-orch-test-'));
const originRepoPath = path.join(tmpRoot, 'origin');

process.on('exit', () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Creates a simple origin repo with one commit on `main`. */
function buildOrigin(): void {
    fs.mkdirSync(originRepoPath, { recursive: true });
    execSync('git init -b main', { cwd: originRepoPath });
    execSync('git config user.email "test@test.local"', { cwd: originRepoPath });
    execSync('git config user.name "Test"', { cwd: originRepoPath });
    fs.writeFileSync(path.join(originRepoPath, 'README.md'), 'hello');
    execSync('git add .', { cwd: originRepoPath });
    execSync('git commit -m "initial"', { cwd: originRepoPath });
}

buildOrigin();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(tmpRoot, 'test-'));
}



interface TestFixture {
    config: AppConfig;
    repoManager: RepositoryManager;
    projectManager: ProjectManager;
    workspaceManager: WorkspaceManager;
    orchestrator: WorkspaceOrchestrator;
    projectId: string;
    repoId: string;
}

function makeFixture(base: string): TestFixture {
    const config = makeTestConfig(base);
    initializeStorage(config);

    const repoManager = new RepositoryManager(config);
    const projectManager = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);
    const orchestrator = new WorkspaceOrchestrator(config, projectManager, workspaceManager, repoManager);

    repoManager.add({ url: originRepoPath, id: 'test-repo' });
    projectManager.create('Test Project', ['test-repo'], undefined, 'test-project');

    return { config, repoManager, projectManager, workspaceManager, orchestrator, projectId: 'test-project', repoId: 'test-repo' };
}

// ─── createWorkspace ──────────────────────────────────────────────────────────

test('createWorkspace creates the workspace folder', async () => {
    const { config, orchestrator, projectId } = makeFixture(makeTempDir());
    await orchestrator.createWorkspace(projectId, 'DEV');
    const wsFolder = path.join(config.projectsFolder, projectId, 'DEV');
    assert.ok(fs.existsSync(wsFolder), 'workspace folder should exist');
});

test('createWorkspace generates the VS Code workspace file', async () => {
    const { config, orchestrator, projectId } = makeFixture(makeTempDir());
    await orchestrator.createWorkspace(projectId, 'DEV');
    const wsFile = path.join(config.projectsFolder, projectId, `${projectId}-DEV.code-workspace`);
    assert.ok(fs.existsSync(wsFile), 'VS Code workspace file should exist');
});

test('createWorkspace generates a valid workspace file with correct folder paths', async () => {
    const { config, orchestrator, projectId, repoId } = makeFixture(makeTempDir());
    await orchestrator.createWorkspace(projectId, 'DEV');
    const wsFile = path.join(config.projectsFolder, projectId, `${projectId}-DEV.code-workspace`);
    const parsed = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
    assert.ok(Array.isArray(parsed.folders), 'folders should be an array');
    assert.strictEqual(parsed.folders.length, 1, 'expected one folder entry');
    const expectedPath = path.join(config.projectsFolder, projectId, 'DEV', repoId);
    assert.strictEqual(parsed.folders[0].path, expectedPath, 'folder path should match cloned repo location');
});

test('createWorkspace returns successful result per repository', async () => {
    const { orchestrator, projectId } = makeFixture(makeTempDir());
    const result = await orchestrator.createWorkspace(projectId, 'DEV');
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].repositoryId, 'test-repo');
    assert.strictEqual(result.results[0].success, true);
    assert.strictEqual(result.results[0].error, undefined);
});

test('createWorkspace clones the repository to the correct path', async () => {
    const { config, orchestrator, projectId, repoId } = makeFixture(makeTempDir());
    await orchestrator.createWorkspace(projectId, 'DEV');
    const repoDir = path.join(config.projectsFolder, projectId, 'DEV', repoId);
    assert.ok(fs.existsSync(path.join(repoDir, '.git')), 'cloned repo should have a .git directory');
});

test('createWorkspace returns failure for unreachable repo without aborting workspace creation', async () => {
    const dir = makeTempDir();
    const config = makeTestConfig(dir);
    initializeStorage(config);
    const repoManager = new RepositoryManager(config);
    const projectManager = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);
    const orchestrator = new WorkspaceOrchestrator(config, projectManager, workspaceManager, repoManager);

    repoManager.add({ url: originRepoPath, id: 'good-repo' });
    repoManager.add({ url: '/nonexistent/repo/path', id: 'bad-repo' });
    projectManager.create('Mixed Project', ['good-repo', 'bad-repo'], undefined, 'mixed-project');

    const result = await orchestrator.createWorkspace('mixed-project', 'DEV');

    assert.strictEqual(result.results.length, 2, 'should have one result per repository');

    const goodResult = result.results.find((r) => r.repositoryId === 'good-repo');
    const badResult = result.results.find((r) => r.repositoryId === 'bad-repo');

    assert.ok(goodResult?.success, 'good repo should succeed');
    assert.ok(!badResult?.success, 'bad repo should fail');
    assert.ok(typeof badResult?.error === 'string' && badResult.error.length > 0, 'failure should carry an error message');

    // Workspace folder and VS Code file are still created despite partial failure.
    assert.ok(fs.existsSync(path.join(config.projectsFolder, 'mixed-project', 'DEV')), 'workspace folder should exist despite partial failure');
    assert.ok(fs.existsSync(path.join(config.projectsFolder, 'mixed-project', 'mixed-project-DEV.code-workspace')), 'VS Code workspace file should exist despite partial failure');
});

test('createWorkspace throws when project does not exist', async () => {
    const { orchestrator } = makeFixture(makeTempDir());
    await assert.rejects(
        () => orchestrator.createWorkspace('nonexistent-project', 'DEV'),
        /does not exist/,
    );
});

test('createWorkspace retries clone when repo directory exists but has no .git', async () => {
    const { config, orchestrator, projectId, repoId } = makeFixture(makeTempDir());
    const wsFolder = path.join(config.projectsFolder, projectId, 'DEV');
    const repoDir  = path.join(wsFolder, repoId);

    // Simulate a leftover directory from a failed clone.
    fs.mkdirSync(repoDir, { recursive: true });
    assert.ok(fs.existsSync(repoDir), 'leftover dir should exist before retry');
    assert.ok(!fs.existsSync(path.join(repoDir, '.git')), 'leftover dir should NOT have .git');

    const result = await orchestrator.createWorkspace(projectId, 'DEV');

    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].success, true, 'retry should succeed');
    assert.ok(fs.existsSync(path.join(repoDir, '.git')), 'cloned repo should have .git after retry');
});

test('createWorkspace skips clone when repo directory already has .git', async () => {
    const { config, orchestrator, projectId, repoId } = makeFixture(makeTempDir());

    // First run — clone normally.
    await orchestrator.createWorkspace(projectId, 'DEV');
    const repoDir = path.join(config.projectsFolder, projectId, 'DEV', repoId);
    assert.ok(fs.existsSync(path.join(repoDir, '.git')), 'repo should be cloned');

    // Second run — should skip (idempotent).
    const result = await orchestrator.createWorkspace(projectId, 'DEV');
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].success, true, 'already-cloned repo should succeed');
});

// ─── deleteWorkspace ──────────────────────────────────────────────────────────

test('deleteWorkspace throws when attempting to delete STABLE workspace', () => {
    const { orchestrator, projectId } = makeFixture(makeTempDir());
    assert.throws(
        () => orchestrator.deleteWorkspace(projectId, 'STABLE'),
        /Cannot delete the STABLE workspace/,
    );
});

test('deleteWorkspace removes the workspace folder', async () => {
    const { config, orchestrator, workspaceManager, projectId } = makeFixture(makeTempDir());
    workspaceManager.create(projectId, 'DEV');
    await orchestrator.createWorkspace(projectId, 'DEV');
    const wsFolder = path.join(config.projectsFolder, projectId, 'DEV');
    assert.ok(fs.existsSync(wsFolder), 'workspace folder should exist before delete');

    orchestrator.deleteWorkspace(projectId, 'DEV');
    assert.ok(!fs.existsSync(wsFolder), 'workspace folder should not exist after delete');
});

test('deleteWorkspace removes the VS Code workspace file', async () => {
    const { config, orchestrator, workspaceManager, projectId } = makeFixture(makeTempDir());
    workspaceManager.create(projectId, 'DEV');
    await orchestrator.createWorkspace(projectId, 'DEV');
    const wsFile = path.join(config.projectsFolder, projectId, `${projectId}-DEV.code-workspace`);
    assert.ok(fs.existsSync(wsFile), 'VS Code workspace file should exist before delete');

    orchestrator.deleteWorkspace(projectId, 'DEV');
    assert.ok(!fs.existsSync(wsFile), 'VS Code workspace file should not exist after delete');
});

test('deleteWorkspace removes the workspace data entry', async () => {
    const { orchestrator, workspaceManager, projectId } = makeFixture(makeTempDir());
    workspaceManager.create(projectId, 'DEV');
    await orchestrator.createWorkspace(projectId, 'DEV');
    assert.ok(workspaceManager.getById(projectId, 'DEV') !== undefined, 'workspace should exist before delete');

    orchestrator.deleteWorkspace(projectId, 'DEV');
    assert.strictEqual(
        workspaceManager.getById(projectId, 'DEV'),
        undefined,
        'workspace data entry should not exist after delete',
    );
});

test('deleteWorkspace succeeds when workspace folder does not exist on disk', () => {
    const { orchestrator, workspaceManager, projectId } = makeFixture(makeTempDir());
    workspaceManager.create(projectId, 'DEV');
    // No call to createWorkspace — folder never created on disk.
    assert.doesNotThrow(() => orchestrator.deleteWorkspace(projectId, 'DEV'));
});

test('deleteWorkspace validates that target path is under projectsFolder', () => {
    const dir = makeTempDir();
    const config = makeTestConfig(dir);
    const repoManager = new RepositoryManager(config);
    const projectManager = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);
    const orchestrator = new WorkspaceOrchestrator(config, projectManager, workspaceManager, repoManager);

    // A projectId with path traversal segments resolves outside projectsFolder.
    assert.throws(
        () => orchestrator.deleteWorkspace('../../outside', 'DEV'),
        /Security check failed/,
    );
});

// ─── renameWorkspace ──────────────────────────────────────────────────────────

test('renameWorkspace throws when attempting to rename STABLE workspace', () => {
    const { orchestrator, projectId } = makeFixture(makeTempDir());
    assert.throws(
        () => orchestrator.renameWorkspace(projectId, 'STABLE', 'NEWNAME'),
        /Cannot rename the STABLE workspace/,
    );
});

test('renameWorkspace renames the workspace folder on disk', async () => {
    const { config, orchestrator, workspaceManager, projectId } = makeFixture(makeTempDir());
    workspaceManager.create(projectId, 'DEV');
    await orchestrator.createWorkspace(projectId, 'DEV');

    const oldFolder = path.join(config.projectsFolder, projectId, 'DEV');
    const newFolder = path.join(config.projectsFolder, projectId, 'FEAT');
    assert.ok(fs.existsSync(oldFolder), 'old folder should exist before rename');

    orchestrator.renameWorkspace(projectId, 'DEV', 'FEAT');

    assert.ok(!fs.existsSync(oldFolder), 'old folder should not exist after rename');
    assert.ok(fs.existsSync(newFolder), 'new folder should exist after rename');
});

test('renameWorkspace creates the new VS Code workspace file', async () => {
    const { config, orchestrator, workspaceManager, projectId } = makeFixture(makeTempDir());
    workspaceManager.create(projectId, 'DEV');
    await orchestrator.createWorkspace(projectId, 'DEV');

    orchestrator.renameWorkspace(projectId, 'DEV', 'FEAT');

    const newFile = path.join(config.projectsFolder, projectId, `${projectId}-FEAT.code-workspace`);
    assert.ok(fs.existsSync(newFile), 'new VS Code workspace file should exist after rename');
});

test('renameWorkspace removes the old VS Code workspace file', async () => {
    const { config, orchestrator, workspaceManager, projectId } = makeFixture(makeTempDir());
    workspaceManager.create(projectId, 'DEV');
    await orchestrator.createWorkspace(projectId, 'DEV');
    const oldFile = path.join(config.projectsFolder, projectId, `${projectId}-DEV.code-workspace`);
    assert.ok(fs.existsSync(oldFile), 'old VS Code workspace file should exist before rename');

    orchestrator.renameWorkspace(projectId, 'DEV', 'FEAT');

    assert.ok(!fs.existsSync(oldFile), 'old VS Code workspace file should not exist after rename');
});

test('renameWorkspace updates folder paths in the VS Code workspace file content', async () => {
    const { config, orchestrator, workspaceManager, projectId, repoId } = makeFixture(makeTempDir());
    workspaceManager.create(projectId, 'DEV');
    await orchestrator.createWorkspace(projectId, 'DEV');

    orchestrator.renameWorkspace(projectId, 'DEV', 'FEAT');

    const newFile = path.join(config.projectsFolder, projectId, `${projectId}-FEAT.code-workspace`);
    const parsed = JSON.parse(fs.readFileSync(newFile, 'utf8'));
    const expectedPath = path.join(config.projectsFolder, projectId, 'FEAT', repoId);

    assert.strictEqual(parsed.folders[0].path, expectedPath, 'folder path should reference new workspace directory');
    // Verify old workspace ID is not present in any folder path.
    const oldPathSegment = path.join(projectId, 'DEV', repoId);
    for (const folder of parsed.folders as { path: string }[]) {
        assert.ok(!folder.path.includes(oldPathSegment), 'no folder path should contain the old workspace ID');
    }
});

test('renameWorkspace updates the workspace data entry', async () => {
    const { orchestrator, workspaceManager, projectId } = makeFixture(makeTempDir());
    workspaceManager.create(projectId, 'DEV');
    await orchestrator.createWorkspace(projectId, 'DEV');

    orchestrator.renameWorkspace(projectId, 'DEV', 'FEAT');

    assert.strictEqual(
        workspaceManager.getById(projectId, 'DEV'),
        undefined,
        'old workspace ID should not exist in data after rename',
    );
    assert.ok(
        workspaceManager.getById(projectId, 'FEAT') !== undefined,
        'new workspace ID should exist in data after rename',
    );
});

test('renameWorkspace throws when newId equals oldId', async () => {
    const { orchestrator, workspaceManager, projectId } = makeFixture(makeTempDir());
    workspaceManager.create(projectId, 'DEV');
    await orchestrator.createWorkspace(projectId, 'DEV');
    assert.throws(
        () => orchestrator.renameWorkspace(projectId, 'DEV', 'DEV'),
        /must be different from the current ID/,
    );
});

test('renameWorkspace throws when newId is not a valid workspace ID', async () => {
    const { orchestrator, workspaceManager, projectId } = makeFixture(makeTempDir());
    workspaceManager.create(projectId, 'DEV');
    await orchestrator.createWorkspace(projectId, 'DEV');
    assert.throws(
        () => orchestrator.renameWorkspace(projectId, 'DEV', 'bad-id'),
        /Invalid workspace ID/,
    );
});

// ─── Credential injection (createWorkspace) ───────────────────────────────────

test('createWorkspace passes token-injected URL to cloneRepository when credentials match', async () => {
    const dir = makeTempDir();
    const fakeGitDir = fs.mkdtempSync(path.join(tmpRoot, 'fake-git-ws-inj-'));
    const capturedArgsFile = setupFakeGit(fakeGitDir);

    const config = makeTestConfig(dir);
    // Only HTTPS URLs are processed — provide a single credential for auto-selection.
    config.gitCredentials = [{ id: 'cred-ws-inj', label: 'Test Credential', host: 'private.example', token: 'ghp_testtoken' }];
    initializeStorage(config);

    const repoManager     = new RepositoryManager(config);
    const projectManager  = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);
    const orchestrator    = new WorkspaceOrchestrator(config, projectManager, workspaceManager, repoManager);

    repoManager.add({ url: 'https://private.example/org/priv-repo.git', id: 'priv-repo' });
    projectManager.create('Priv Project', ['priv-repo'], undefined, 'priv-project-ws-inject');

    // Temporarily prepend the fake-git directory to PATH so the orchestrator's
    // git spawn picks up our stub binary instead of the real git.
    const origPath = process.env.PATH ?? '';
    process.env.PATH = `${fakeGitDir}:${origPath}`;
    try {
        await orchestrator.createWorkspace('priv-project-ws-inject', 'DEV');
    } finally {
        process.env.PATH = origPath;
    }

    // The fake git writes all CLI arguments to capturedArgsFile — the injected
    // URL (https://ghp_testtoken@private.example/...) must appear among them.
    const captured = fs.existsSync(capturedArgsFile)
        ? fs.readFileSync(capturedArgsFile, 'utf8')
        : '';
    assert.ok(
        captured.includes('ghp_testtoken@private.example'),
        `expected injected URL with token in git arguments; got: "${captured}"`,
    );
});

test('createWorkspace returns credential-missing error when no credentials are configured for an HTTPS repo', async () => {
    const dir = makeTempDir();

    const config = makeTestConfig(dir); // gitCredentials deliberately absent
    initializeStorage(config);

    const repoManager     = new RepositoryManager(config);
    const projectManager  = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);
    const orchestrator    = new WorkspaceOrchestrator(config, projectManager, workspaceManager, repoManager);

    repoManager.add({ url: 'https://private.example/org/priv-repo.git', id: 'priv-repo', name: 'Priv Repo' });
    projectManager.create('Priv Project', ['priv-repo'], undefined, 'priv-project-ws-no-creds');

    const result = await orchestrator.createWorkspace('priv-project-ws-no-creds', 'DEV');

    // When no credential resolves for an HTTPS repo, the operation must fail
    // with a descriptive message — git clone is never attempted.
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].success, false);
    assert.ok(
        result.results[0].error?.includes('private.example'),
        `expected error to mention the host; got: "${result.results[0].error}"`,
    );
    assert.ok(
        result.results[0].error?.includes('requires a credential'),
        `expected error to describe missing credential; got: "${result.results[0].error}"`,
    );
});

test('createWorkspace returns credential-missing error when multiple credentials exist for an HTTPS repo host (ambiguous)', async () => {
    const dir = makeTempDir();

    const config = makeTestConfig(dir);
    // Two credentials for the same host — resolution is ambiguous without an explicit CredentialId.
    config.gitCredentials = [
        { id: 'cred-ws-amb-1', label: 'Account A', host: 'private.example', token: 'token-a' },
        { id: 'cred-ws-amb-2', label: 'Account B', host: 'private.example', token: 'token-b' },
    ];
    initializeStorage(config);

    const repoManager     = new RepositoryManager(config);
    const projectManager  = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);
    const orchestrator    = new WorkspaceOrchestrator(config, projectManager, workspaceManager, repoManager);

    // Repo has no CredentialId — auto-selection fails (ambiguous).
    repoManager.add({ url: 'https://private.example/org/priv-repo.git', id: 'priv-repo-amb-ws', name: 'Priv Repo' });
    projectManager.create('Priv Project Amb', ['priv-repo-amb-ws'], undefined, 'priv-project-ws-ambiguous');

    const result = await orchestrator.createWorkspace('priv-project-ws-ambiguous', 'DEV');

    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].success, false);
    assert.ok(
        result.results[0].error?.includes('private.example'),
        `expected error to mention the host; got: "${result.results[0].error}"`,
    );
});

// ─── ErrorLogManager integration (credential-missing) ─────────────────────────

test('createWorkspace logs credential-missing error via ErrorLogManager with source "credentials"', async () => {
    const dir = makeTempDir();

    const config = makeTestConfig(dir); // no gitCredentials configured
    initializeStorage(config);

    const repoManager     = new RepositoryManager(config);
    const projectManager  = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);
    const errorLogManager = new ErrorLogManager(config);
    const orchestrator    = new WorkspaceOrchestrator(config, projectManager, workspaceManager, repoManager, errorLogManager);

    repoManager.add({ url: 'https://private.example/org/priv-repo.git', id: 'priv-repo-ws-log', name: 'Priv Repo' });
    projectManager.create('Priv Project Log', ['priv-repo-ws-log'], undefined, 'priv-project-ws-log');

    await orchestrator.createWorkspace('priv-project-ws-log', 'DEV');

    // Verify that the error log received an entry with source 'credentials'.
    const { entries } = errorLogManager.list({});
    assert.ok(entries.length > 0, 'expected at least one error log entry');
    const credEntry = entries.find((e) => e.Source === 'credentials');
    assert.ok(credEntry !== undefined, 'expected an error log entry with source "credentials"');
    assert.strictEqual(credEntry.Severity, 'error');
    assert.ok(
        credEntry.Message.includes('private.example'),
        `expected error log message to mention the host; got: "${credEntry.Message}"`,
    );
    assert.ok(
        credEntry.Message.includes('requires a credential'),
        `expected error log message to describe missing credential; got: "${credEntry.Message}"`,
    );
});

// ─── Credential success log entry (createWorkspace) ──────────────────────────

test('createWorkspace writes a credentials/info log entry after successful credential-based clone', async () => {
    const dir = makeTempDir();
    const fakeGitDir = fs.mkdtempSync(path.join(tmpRoot, 'fake-git-ws-success-log-'));

    // Set up a fake git that exits with 0 (successful clone).
    const fakeGitPath = path.join(fakeGitDir, 'git');
    const capturedArgsFile = path.join(fakeGitDir, 'captured-args.txt');
    fs.writeFileSync(fakeGitPath, `#!/bin/sh\necho "$@" >> ${capturedArgsFile}\nmkdir -p "$2/.git"\nexit 0\n`, { mode: 0o755 });

    const config = makeTestConfig(dir);
    config.gitCredentials = [{ id: 'cred-ws-success', label: 'Success Cred', host: 'private.example', token: 'ghp_success' }];
    initializeStorage(config);

    const repoManager     = new RepositoryManager(config);
    const projectManager  = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);
    const errorLogManager = new ErrorLogManager(config);
    const orchestrator    = new WorkspaceOrchestrator(config, projectManager, workspaceManager, repoManager, errorLogManager);

    repoManager.add({ url: 'https://private.example/org/cred-repo.git', id: 'cred-repo-ws', name: 'Cred Repo' });
    projectManager.create('Cred Project WS', ['cred-repo-ws'], undefined, 'cred-project-ws-success');

    const origPath = process.env.PATH ?? '';
    process.env.PATH = `${fakeGitDir}:${origPath}`;
    try {
        await orchestrator.createWorkspace('cred-project-ws-success', 'DEV');
    } finally {
        process.env.PATH = origPath;
    }

    const { entries } = errorLogManager.list({ source: 'credentials' });
    const infoEntry = entries.find((e) => e.Severity === 'info');
    assert.ok(infoEntry !== undefined, 'expected a credentials/info log entry after successful credential-based clone');
    assert.strictEqual(infoEntry.Source, 'credentials');
    assert.strictEqual(infoEntry.Operation, 'workspace-setup');
    assert.strictEqual(infoEntry.Context.ProjectId, 'cred-project-ws-success');
    assert.strictEqual(infoEntry.Context.WorkspaceId, 'DEV');
    assert.strictEqual(infoEntry.Context.RepositoryId, 'cred-repo-ws');
});

test('createWorkspace does NOT write a credentials/info log entry for SSH clones (credential === null)', async () => {
    const dir = makeTempDir();
    const fakeGitDir = fs.mkdtempSync(path.join(tmpRoot, 'fake-git-ws-ssh-nolog-'));

    // SSH clone succeeds with exit 0 — credential is null, so no info entry.
    const fakeGitPath = path.join(fakeGitDir, 'git');
    const capturedArgsFile = path.join(fakeGitDir, 'captured-args.txt');
    fs.writeFileSync(fakeGitPath, `#!/bin/sh\necho "$@" >> ${capturedArgsFile}\nmkdir -p "$2/.git"\nexit 0\n`, { mode: 0o755 });

    const config = makeTestConfig(dir);
    // Configure a credential for a different host so SSH URL is not matched.
    config.gitCredentials = [{ id: 'cred-ws-ssh-nolog', label: 'Other Cred', host: 'other.example', token: 'ghp_other' }];
    initializeStorage(config);

    const repoManager     = new RepositoryManager(config);
    const projectManager  = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);
    const errorLogManager = new ErrorLogManager(config);
    const orchestrator    = new WorkspaceOrchestrator(config, projectManager, workspaceManager, repoManager, errorLogManager);

    // SSH URL → credential is null (host is null for SSH, so no credential check).
    repoManager.add({ url: 'git@github.com:org/ssh-repo.git', id: 'ssh-repo-ws-nolog', name: 'SSH Repo' });
    projectManager.create('SSH Project WS', ['ssh-repo-ws-nolog'], undefined, 'ssh-project-ws-nolog');

    const origPath = process.env.PATH ?? '';
    process.env.PATH = `${fakeGitDir}:${origPath}`;
    try {
        await orchestrator.createWorkspace('ssh-project-ws-nolog', 'DEV');
    } finally {
        process.env.PATH = origPath;
    }

    const { entries } = errorLogManager.list({ source: 'credentials' });
    const infoEntry = entries.find((e) => e.Severity === 'info');
    assert.strictEqual(infoEntry, undefined, 'SSH clones (credential === null) must NOT produce a credentials/info entry');
});
