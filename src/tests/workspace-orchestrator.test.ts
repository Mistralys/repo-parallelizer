import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { AppConfig } from '../config/config.types.js';
import { initializeStorage } from '../storage/json-storage.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { ProjectManager } from '../models/project/project.manager.js';
import { WorkspaceManager } from '../models/workspace/workspace.manager.js';
import { WorkspaceOrchestrator } from '../orchestration/workspace-orchestrator.js';
import { setupFakeGit } from './test-helpers.js';

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

function makeConfig(base: string): AppConfig {
    return {
        storageFolder: path.join(base, 'storage'),
        projectsFolder: path.join(base, 'projects'),
        cloneDepth: 50,
        serverPort: 4200,
        gitPollingIntervalSeconds: 30,
    };
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
    const config = makeConfig(base);
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
    const wsFile = path.join(config.projectsFolder, `${projectId}-DEV.code-workspace`);
    assert.ok(fs.existsSync(wsFile), 'VS Code workspace file should exist');
});

test('createWorkspace generates a valid workspace file with correct folder paths', async () => {
    const { config, orchestrator, projectId, repoId } = makeFixture(makeTempDir());
    await orchestrator.createWorkspace(projectId, 'DEV');
    const wsFile = path.join(config.projectsFolder, `${projectId}-DEV.code-workspace`);
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
    const config = makeConfig(dir);
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
    assert.ok(fs.existsSync(path.join(config.projectsFolder, 'mixed-project-DEV.code-workspace')), 'VS Code workspace file should exist despite partial failure');
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
    const wsFile = path.join(config.projectsFolder, `${projectId}-DEV.code-workspace`);
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
    const config = makeConfig(dir);
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

    const newFile = path.join(config.projectsFolder, `${projectId}-FEAT.code-workspace`);
    assert.ok(fs.existsSync(newFile), 'new VS Code workspace file should exist after rename');
});

test('renameWorkspace removes the old VS Code workspace file', async () => {
    const { config, orchestrator, workspaceManager, projectId } = makeFixture(makeTempDir());
    workspaceManager.create(projectId, 'DEV');
    await orchestrator.createWorkspace(projectId, 'DEV');
    const oldFile = path.join(config.projectsFolder, `${projectId}-DEV.code-workspace`);
    assert.ok(fs.existsSync(oldFile), 'old VS Code workspace file should exist before rename');

    orchestrator.renameWorkspace(projectId, 'DEV', 'FEAT');

    assert.ok(!fs.existsSync(oldFile), 'old VS Code workspace file should not exist after rename');
});

test('renameWorkspace updates folder paths in the VS Code workspace file content', async () => {
    const { config, orchestrator, workspaceManager, projectId, repoId } = makeFixture(makeTempDir());
    workspaceManager.create(projectId, 'DEV');
    await orchestrator.createWorkspace(projectId, 'DEV');

    orchestrator.renameWorkspace(projectId, 'DEV', 'FEAT');

    const newFile = path.join(config.projectsFolder, `${projectId}-FEAT.code-workspace`);
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

    const config = makeConfig(dir);
    // Only HTTPS URLs are processed by injectCredentials.
    config.gitCredentials = { 'private.example': 'ghp_testtoken' };
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

test('createWorkspace passes original URL to cloneRepository when no credentials match', async () => {
    const dir = makeTempDir();
    const fakeGitDir = fs.mkdtempSync(path.join(tmpRoot, 'fake-git-ws-nocr-'));
    const capturedArgsFile = setupFakeGit(fakeGitDir);

    const config = makeConfig(dir); // gitCredentials deliberately absent
    initializeStorage(config);

    const repoManager     = new RepositoryManager(config);
    const projectManager  = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);
    const orchestrator    = new WorkspaceOrchestrator(config, projectManager, workspaceManager, repoManager);

    repoManager.add({ url: 'https://private.example/org/priv-repo.git', id: 'priv-repo' });
    projectManager.create('Priv Project', ['priv-repo'], undefined, 'priv-project-ws-no-creds');

    const origPath = process.env.PATH ?? '';
    process.env.PATH = `${fakeGitDir}:${origPath}`;
    try {
        await orchestrator.createWorkspace('priv-project-ws-no-creds', 'DEV');
    } finally {
        process.env.PATH = origPath;
    }

    // Without credentials the URL must pass through unchanged — no token injected.
    const captured = fs.existsSync(capturedArgsFile)
        ? fs.readFileSync(capturedArgsFile, 'utf8')
        : '';
    assert.ok(
        captured.includes('https://private.example/org/priv-repo.git'),
        `expected original URL (no token) in git arguments; got: "${captured}"`,
    );
    assert.ok(
        !captured.includes('@private.example'),
        `expected no injected credentials in clone URL; got: "${captured}"`,
    );
});
