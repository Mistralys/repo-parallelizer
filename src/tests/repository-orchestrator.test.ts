import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { initializeStorage, writeJsonFile } from '../storage/json-storage.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { ProjectManager } from '../models/project/project.manager.js';
import { WorkspaceManager } from '../models/workspace/workspace.manager.js';
import { WorkspaceOrchestrator } from '../orchestration/workspace-orchestrator.js';
import { RepositoryOrchestrator } from '../orchestration/repository-orchestrator.js';
import { ErrorLogManager } from '../error-log/error-log.manager.js';
import type { AppConfig } from '../config/config.types.js';
import { setupFakeGit, makeTestConfig } from './test-helpers.js';

// ─── Global fixtures ──────────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-repo-orch-test-'));
const originRepoPath = path.join(tmpRoot, 'origin');
const origin2RepoPath = path.join(tmpRoot, 'origin2');

process.on('exit', () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Creates a simple local git repo with one commit on `main`. */
function buildRepo(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    execSync('git init -b main', { cwd: dir });
    execSync('git config user.email "test@test.local"', { cwd: dir });
    execSync('git config user.name "Test"', { cwd: dir });
    fs.writeFileSync(path.join(dir, 'README.md'), `hello from ${path.basename(dir)}`);
    execSync('git add .', { cwd: dir });
    execSync('git commit -m "initial"', { cwd: dir });
}

buildRepo(originRepoPath);
buildRepo(origin2RepoPath);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(tmpRoot, 'test-'));
}



interface TestFixture {
    config: AppConfig;
    repoManager: RepositoryManager;
    projectManager: ProjectManager;
    workspaceManager: WorkspaceManager;
    workspaceOrchestrator: WorkspaceOrchestrator;
    orchestrator: RepositoryOrchestrator;
    projectId: string;
}

/**
 * Creates a fixture with:
 * - One project ('test-project') containing 'repo-a'
 * - A STABLE workspace already cloned via WorkspaceOrchestrator
 */
async function makeFixture(base: string): Promise<TestFixture> {
    const config = makeTestConfig(base);
    initializeStorage(config);

    const repoManager = new RepositoryManager(config);
    const projectManager = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);
    const workspaceOrchestrator = new WorkspaceOrchestrator(config, projectManager, workspaceManager, repoManager);
    const orchestrator = new RepositoryOrchestrator(config, projectManager, repoManager);

    repoManager.add({ url: originRepoPath, id: 'repo-a' });
    repoManager.add({ url: origin2RepoPath, id: 'repo-b' });

    projectManager.create('Test Project', ['repo-a'], undefined, 'test-project');

    // Clone repo-a into STABLE workspace
    await workspaceOrchestrator.createWorkspace('test-project', 'STABLE');

    return { config, repoManager, projectManager, workspaceManager, workspaceOrchestrator, orchestrator, projectId: 'test-project' };
}

// ─── addRepositoryToProject ───────────────────────────────────────────────────

test('addRepositoryToProject clones the repository into the existing workspace', async () => {
    const { config, orchestrator, projectId } = await makeFixture(makeTempDir());
    await orchestrator.addRepositoryToProject(projectId, 'repo-b');

    const clonePath = path.join(config.projectsFolder, projectId, 'STABLE', 'repo-b');
    assert.ok(fs.existsSync(path.join(clonePath, '.git')), 'repo-b should be cloned in STABLE workspace');
});

test('addRepositoryToProject clones into all existing workspaces', async () => {
    const base = makeTempDir();
    const { config, orchestrator, workspaceManager, workspaceOrchestrator, projectId } = await makeFixture(base);

    // Add a second workspace (DEV)
    workspaceManager.create(projectId, 'DEV');
    await workspaceOrchestrator.createWorkspace(projectId, 'DEV');

    await orchestrator.addRepositoryToProject(projectId, 'repo-b');

    const stablePath = path.join(config.projectsFolder, projectId, 'STABLE', 'repo-b');
    const devPath = path.join(config.projectsFolder, projectId, 'DEV', 'repo-b');
    assert.ok(fs.existsSync(path.join(stablePath, '.git')), 'repo-b should be cloned in STABLE');
    assert.ok(fs.existsSync(path.join(devPath, '.git')), 'repo-b should be cloned in DEV');
});

test('addRepositoryToProject updates VS Code workspace file to include new repo', async () => {
    const { config, orchestrator, projectId } = await makeFixture(makeTempDir());
    await orchestrator.addRepositoryToProject(projectId, 'repo-b');

    const wsFile = path.join(config.projectsFolder, projectId, `${projectId}-STABLE.code-workspace`);
    const parsed = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
    const repoPaths = parsed.folders.map((f: { path: string }) => f.path);

    const expectedRepoB = path.join(config.projectsFolder, projectId, 'STABLE', 'repo-b');
    assert.ok(repoPaths.includes(expectedRepoB), 'VS Code workspace file should include repo-b path');
});

test('addRepositoryToProject updates project data to include new repo', async () => {
    const { orchestrator, projectManager, projectId } = await makeFixture(makeTempDir());
    await orchestrator.addRepositoryToProject(projectId, 'repo-b');

    const project = projectManager.getById(projectId)!;
    assert.ok(project.Repositories.includes('repo-b'), 'repo-b should be in project repositories');
});

test('addRepositoryToProject returns per-workspace clone results', async () => {
    const { orchestrator, projectId } = await makeFixture(makeTempDir());
    const result = await orchestrator.addRepositoryToProject(projectId, 'repo-b');

    assert.ok(Array.isArray(result.workspaceResults), 'should return workspaceResults array');
    assert.strictEqual(result.workspaceResults.length, 1, 'one workspace result for STABLE');
    assert.strictEqual(result.workspaceResults[0].workspaceId, 'STABLE');
    assert.strictEqual(result.workspaceResults[0].success, true);
});

test('addRepositoryToProject captures failure for unreachable repo without aborting', async () => {
    const base = makeTempDir();
    const config = makeTestConfig(base);
    initializeStorage(config);

    const repoManager = new RepositoryManager(config);
    const projectManager = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);
    const workspaceOrchestrator = new WorkspaceOrchestrator(config, projectManager, workspaceManager, repoManager);
    const orchestrator = new RepositoryOrchestrator(config, projectManager, repoManager);

    repoManager.add({ url: originRepoPath, id: 'repo-a' });
    repoManager.add({ url: '/nonexistent/bad-repo', id: 'bad-repo' });

    projectManager.create('Test Project', ['repo-a'], undefined, 'test-project');
    await workspaceOrchestrator.createWorkspace('test-project', 'STABLE');

    const result = await orchestrator.addRepositoryToProject('test-project', 'bad-repo');

    assert.strictEqual(result.workspaceResults.length, 1);
    assert.strictEqual(result.workspaceResults[0].success, false);
    assert.ok(typeof result.workspaceResults[0].error === 'string', 'should include error message');
    // Data was still updated
    assert.ok(
        projectManager.getById('test-project')!.Repositories.includes('bad-repo'),
        'project data should still be updated despite clone failure',
    );
});

test('addRepositoryToProject throws when repository does not exist globally', async () => {
    const { orchestrator, projectId } = await makeFixture(makeTempDir());
    await assert.rejects(
        () => orchestrator.addRepositoryToProject(projectId, 'nonexistent-repo'),
        /does not exist/,
    );
});

test('addRepositoryToProject throws when project does not exist', async () => {
    const { orchestrator } = await makeFixture(makeTempDir());
    await assert.rejects(
        () => orchestrator.addRepositoryToProject('nonexistent-project', 'repo-b'),
        /does not exist/,
    );
});

test('addRepositoryToProject rejects a clone path that resolves outside projectsFolder', async () => {
    const base = makeTempDir();
    const config = makeTestConfig(base);
    initializeStorage(config);

    const repoManager = new RepositoryManager(config);
    const projectManager = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);
    const workspaceOrchestrator = new WorkspaceOrchestrator(config, projectManager, workspaceManager, repoManager);
    const orchestrator = new RepositoryOrchestrator(config, projectManager, repoManager);

    // Seed one legitimate repo so the project can be created.
    repoManager.add({ url: originRepoPath, id: 'repo-a' });
    projectManager.create('Traversal Project', ['repo-a'], undefined, 'traversal-project');
    await workspaceOrchestrator.createWorkspace('traversal-project', 'STABLE');

    // Inject a repo with a path-traversal ID directly into the storage files,
    // bypassing the public-API validators. This simulates data that has been
    // hand-edited or arrived via a future less-strict code path.
    // repoPath() computes: projectsFolder / projectId / workspaceId / repositoryId
    // With repositoryId = '../../../../escape' the resolved path will land outside
    // projectsFolder, so the guard must fire before any clone attempt is made.
    const traversalId = '../../../../escape';

    // Inject into repositories store.
    const repoStorePath = path.join(config.storageFolder, 'repositories.json');
    const repoStore = JSON.parse(fs.readFileSync(repoStorePath, 'utf8'));
    repoStore.Repositories.push({ Id: traversalId, Name: 'escape', Url: originRepoPath });
    writeJsonFile(repoStorePath, repoStore);

    // Inject into the project's own JSON file so addRepository() won't throw
    // "already listed" (the repo is not in the project yet — addRepository() will
    // add it before the clone loop runs).
    // No change needed here: the project currently only has repo-a.

    await assert.rejects(
        () => orchestrator.addRepositoryToProject('traversal-project', traversalId),
        /Security check failed/,
    );
});

// ─── removeRepositoryFromProject ─────────────────────────────────────────────

test('removeRepositoryFromProject removes clone from existing workspace', async () => {
    const { config, orchestrator, projectId } = await makeFixture(makeTempDir());

    const clonePath = path.join(config.projectsFolder, projectId, 'STABLE', 'repo-a');
    assert.ok(fs.existsSync(clonePath), 'precondition: repo-a clone should exist');

    orchestrator.removeRepositoryFromProject(projectId, 'repo-a');

    assert.ok(!fs.existsSync(clonePath), 'repo-a clone should be removed from STABLE');
});

test('removeRepositoryFromProject removes clones from all workspaces', async () => {
    const base = makeTempDir();
    const { config, orchestrator, workspaceManager, workspaceOrchestrator, projectId } = await makeFixture(base);

    // Add DEV workspace with a clone of repo-a
    workspaceManager.create(projectId, 'DEV');
    await workspaceOrchestrator.createWorkspace(projectId, 'DEV');

    const stablePath = path.join(config.projectsFolder, projectId, 'STABLE', 'repo-a');
    const devPath = path.join(config.projectsFolder, projectId, 'DEV', 'repo-a');
    assert.ok(fs.existsSync(stablePath), 'precondition: STABLE clone should exist');
    assert.ok(fs.existsSync(devPath), 'precondition: DEV clone should exist');

    orchestrator.removeRepositoryFromProject(projectId, 'repo-a');

    assert.ok(!fs.existsSync(stablePath), 'repo-a should be removed from STABLE');
    assert.ok(!fs.existsSync(devPath), 'repo-a should be removed from DEV');
});

test('removeRepositoryFromProject updates VS Code workspace files to exclude the repo', async () => {
    const base = makeTempDir();
    const { config, orchestrator, projectId } = await makeFixture(base);

    // Add repo-b first so we have something left in the workspace file
    await orchestrator.addRepositoryToProject(projectId, 'repo-b');

    orchestrator.removeRepositoryFromProject(projectId, 'repo-a');

    const wsFile = path.join(config.projectsFolder, projectId, `${projectId}-STABLE.code-workspace`);
    const parsed = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
    const repoPaths = parsed.folders.map((f: { path: string }) => f.path);

    const removedPath = path.join(config.projectsFolder, projectId, 'STABLE', 'repo-a');
    assert.ok(!repoPaths.includes(removedPath), 'VS Code workspace file should not include repo-a path');

    const remainingPath = path.join(config.projectsFolder, projectId, 'STABLE', 'repo-b');
    assert.ok(repoPaths.includes(remainingPath), 'VS Code workspace file should still include repo-b path');
});

test('removeRepositoryFromProject updates project data to exclude the repo', async () => {
    const { orchestrator, projectManager, projectId } = await makeFixture(makeTempDir());
    orchestrator.removeRepositoryFromProject(projectId, 'repo-a');

    const project = projectManager.getById(projectId)!;
    assert.ok(!project.Repositories.includes('repo-a'), 'repo-a should not be in project repositories');
});

test('removeRepositoryFromProject succeeds when clone folder does not exist on disk', async () => {
    const base = makeTempDir();
    const config = makeTestConfig(base);
    initializeStorage(config);

    const repoManager = new RepositoryManager(config);
    const projectManager = new ProjectManager(config, repoManager);
    const orchestrator = new RepositoryOrchestrator(config, projectManager, repoManager);

    repoManager.add({ url: originRepoPath, id: 'repo-a' });
    // Create project data without cloning
    projectManager.create('Test Project', ['repo-a'], undefined, 'test-project');

    // No workspace orchestrator call — no files on disk
    assert.doesNotThrow(() => orchestrator.removeRepositoryFromProject('test-project', 'repo-a'));
    assert.ok(
        !projectManager.getById('test-project')!.Repositories.includes('repo-a'),
        'data should be updated',
    );
});

test('removeRepositoryFromProject throws when project does not exist', async () => {
    const { orchestrator } = await makeFixture(makeTempDir());
    assert.throws(
        () => orchestrator.removeRepositoryFromProject('nonexistent-project', 'repo-a'),
        /does not exist/,
    );
});

// ─── deleteRepositoryGlobally ─────────────────────────────────────────────────

test('deleteRepositoryGlobally removes repository from global store', async () => {
    const { orchestrator, repoManager } = await makeFixture(makeTempDir());
    assert.ok(repoManager.getById('repo-b') !== undefined, 'precondition: repo-b should exist');

    orchestrator.deleteRepositoryGlobally('repo-b');

    assert.strictEqual(repoManager.getById('repo-b'), undefined, 'repo-b should be removed from global store');
});

test('deleteRepositoryGlobally removes clones from all projects that reference it', async () => {
    const base = makeTempDir();
    const { config, orchestrator, projectId } = await makeFixture(base);

    // Add repo-b to the project and clone it
    await orchestrator.addRepositoryToProject(projectId, 'repo-b');
    const clonePath = path.join(config.projectsFolder, projectId, 'STABLE', 'repo-b');
    assert.ok(fs.existsSync(clonePath), 'precondition: repo-b clone should exist');

    orchestrator.deleteRepositoryGlobally('repo-b');

    assert.ok(!fs.existsSync(clonePath), 'repo-b clone should be removed after global delete');
});

test('deleteRepositoryGlobally cascades to all projects that reference the repo', async () => {
    const base = makeTempDir();
    const config = makeTestConfig(base);
    initializeStorage(config);

    const repoManager = new RepositoryManager(config);
    const projectManager = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);
    const workspaceOrchestrator = new WorkspaceOrchestrator(config, projectManager, workspaceManager, repoManager);
    const orchestrator = new RepositoryOrchestrator(config, projectManager, repoManager);

    repoManager.add({ url: originRepoPath, id: 'repo-a' });
    repoManager.add({ url: origin2RepoPath, id: 'repo-b' });

    // Create two projects both containing repo-b
    projectManager.create('Project One', ['repo-a', 'repo-b'], undefined, 'proj-one');
    projectManager.create('Project Two', ['repo-a', 'repo-b'], undefined, 'proj-two');

    await workspaceOrchestrator.createWorkspace('proj-one', 'STABLE');
    await workspaceOrchestrator.createWorkspace('proj-two', 'STABLE');

    const cloneOne = path.join(config.projectsFolder, 'proj-one', 'STABLE', 'repo-b');
    const cloneTwo = path.join(config.projectsFolder, 'proj-two', 'STABLE', 'repo-b');
    assert.ok(fs.existsSync(cloneOne), 'precondition: proj-one repo-b clone should exist');
    assert.ok(fs.existsSync(cloneTwo), 'precondition: proj-two repo-b clone should exist');

    orchestrator.deleteRepositoryGlobally('repo-b');

    assert.ok(!fs.existsSync(cloneOne), 'repo-b clone should be removed from proj-one');
    assert.ok(!fs.existsSync(cloneTwo), 'repo-b clone should be removed from proj-two');
    assert.ok(
        !projectManager.getById('proj-one')!.Repositories.includes('repo-b'),
        'repo-b should not be in proj-one data',
    );
    assert.ok(
        !projectManager.getById('proj-two')!.Repositories.includes('repo-b'),
        'repo-b should not be in proj-two data',
    );
    assert.strictEqual(repoManager.getById('repo-b'), undefined, 'repo-b should be removed from global store');
});

test('deleteRepositoryGlobally succeeds when no projects reference the repo', async () => {
    const { orchestrator, repoManager } = await makeFixture(makeTempDir());
    assert.ok(repoManager.getById('repo-b') !== undefined, 'precondition: repo-b should exist');

    // repo-b is registered but not in any project
    assert.doesNotThrow(() => orchestrator.deleteRepositoryGlobally('repo-b'));
    assert.strictEqual(repoManager.getById('repo-b'), undefined, 'repo-b should be removed from global store');
});

test('deleteRepositoryGlobally throws when repository does not exist globally', async () => {
    const { orchestrator } = await makeFixture(makeTempDir());
    assert.throws(
        () => orchestrator.deleteRepositoryGlobally('nonexistent-repo'),
        /does not exist/,
    );
});

// ─── Credential injection (addRepositoryToProject) ────────────────────────────

test('addRepositoryToProject passes token-injected URL to cloneRepository when credentials match', async () => {
    const base = makeTempDir();
    const fakeGitDir = fs.mkdtempSync(path.join(tmpRoot, 'fake-git-ro-inj-'));
    const capturedArgsFile = setupFakeGit(fakeGitDir);

    const config = makeTestConfig(base);
    // Only HTTPS URLs are processed — provide a single credential for auto-selection.
    config.gitCredentials = [{ id: 'cred-ro-inj', label: 'Test Credential', host: 'private.example', token: 'ghp_testtoken' }];
    initializeStorage(config);

    const repoManager    = new RepositoryManager(config);
    const projectManager = new ProjectManager(config, repoManager);
    const orchestrator   = new RepositoryOrchestrator(config, projectManager, repoManager);

    repoManager.add({ url: 'https://private.example/org/priv-repo.git', id: 'priv-repo' });
    // Create project WITHOUT priv-repo so addRepositoryToProject can add it (that is its purpose).
    projectManager.create('Priv Project', [], undefined, 'priv-project-ro-inject');

    // Temporarily prepend the fake-git directory to PATH.
    const origPath = process.env.PATH ?? '';
    process.env.PATH = `${fakeGitDir}:${origPath}`;
    let result;
    try {
        result = await orchestrator.addRepositoryToProject('priv-project-ro-inject', 'priv-repo');
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
    assert.ok(result.workspaceResults.length > 0, 'expected at least one workspace result');
});

test('addRepositoryToProject returns credential-missing error when no credentials are configured for an HTTPS repo', async () => {
    const base = makeTempDir();

    const config = makeTestConfig(base); // gitCredentials deliberately absent
    initializeStorage(config);

    const repoManager    = new RepositoryManager(config);
    const projectManager = new ProjectManager(config, repoManager);
    const orchestrator   = new RepositoryOrchestrator(config, projectManager, repoManager);

    repoManager.add({ url: 'https://private.example/org/priv-repo.git', id: 'priv-repo-ro-nocr', name: 'Priv Repo' });
    // Create a project with a STABLE workspace so addRepositoryToProject has a workspace to iterate over.
    projectManager.create('Priv Project', [], undefined, 'priv-project-ro-no-creds');

    const result = await orchestrator.addRepositoryToProject('priv-project-ro-no-creds', 'priv-repo-ro-nocr');

    // When no credential resolves for an HTTPS repo, the operation must fail
    // with a descriptive message — git clone is never attempted.
    assert.ok(result.workspaceResults.length > 0, 'expected at least one workspace result');
    assert.strictEqual(result.workspaceResults[0].success, false);
    assert.ok(
        result.workspaceResults[0].error?.includes('private.example'),
        `expected error to mention the host; got: "${result.workspaceResults[0].error}"`,
    );
    assert.ok(
        result.workspaceResults[0].error?.includes('requires a credential'),
        `expected error to describe missing credential; got: "${result.workspaceResults[0].error}"`,
    );
});

test('addRepositoryToProject returns credential-missing error when multiple credentials exist for the same host (ambiguous)', async () => {
    const base = makeTempDir();

    const config = makeTestConfig(base);
    // Two credentials for the same host — resolution is ambiguous without an explicit CredentialId.
    config.gitCredentials = [
        { id: 'cred-ro-amb-1', label: 'Account A', host: 'private.example', token: 'token-a' },
        { id: 'cred-ro-amb-2', label: 'Account B', host: 'private.example', token: 'token-b' },
    ];
    initializeStorage(config);

    const repoManager    = new RepositoryManager(config);
    const projectManager = new ProjectManager(config, repoManager);
    const orchestrator   = new RepositoryOrchestrator(config, projectManager, repoManager);

    // Repo has no CredentialId — auto-selection fails (ambiguous).
    repoManager.add({ url: 'https://private.example/org/priv-repo.git', id: 'priv-repo-ro-amb', name: 'Priv Repo' });
    projectManager.create('Priv Project Amb', [], undefined, 'priv-project-ro-ambiguous');

    const result = await orchestrator.addRepositoryToProject('priv-project-ro-ambiguous', 'priv-repo-ro-amb');

    assert.ok(result.workspaceResults.length > 0, 'expected at least one workspace result');
    assert.strictEqual(result.workspaceResults[0].success, false);
    assert.ok(
        result.workspaceResults[0].error?.includes('private.example'),
        `expected error to mention the host; got: "${result.workspaceResults[0].error}"`,
    );
});

// ─── ErrorLogManager integration (credential-missing) ─────────────────────────

// ─── SSH URL bypass ────────────────────────────────────────────────────────────

test('addRepositoryToProject passes SSH URL unchanged to cloneRepository when gitCredentials are configured', async () => {
    // Arrange: credentials exist for a host, but the repository uses an SSH URL —
    // credential injection must be bypassed and the original SSH URL passed to git.
    const base = makeTempDir();
    const fakeGitDir = fs.mkdtempSync(path.join(tmpRoot, 'fake-git-ssh-bypass-'));
    const capturedArgsFile = setupFakeGit(fakeGitDir);

    const config = makeTestConfig(base);
    // Configure credentials for github.com — should NOT affect SSH URL handling.
    config.gitCredentials = [{ id: 'cred-ssh-bypass', label: 'GitHub Token', host: 'github.com', token: 'ghp_sshbypasstoken' }];
    initializeStorage(config);

    const repoManager    = new RepositoryManager(config);
    const projectManager = new ProjectManager(config, repoManager);
    const orchestrator   = new RepositoryOrchestrator(config, projectManager, repoManager);

    const sshUrl = 'git@github.com:org/ssh-repo.git';
    repoManager.add({ url: sshUrl, id: 'ssh-repo', name: 'SSH Repo' });
    projectManager.create('SSH Project', [], undefined, 'ssh-bypass-project');

    // Temporarily prepend the fake-git directory to PATH.
    const origPath = process.env.PATH ?? '';
    process.env.PATH = `${fakeGitDir}:${origPath}`;
    let result;
    try {
        result = await orchestrator.addRepositoryToProject('ssh-bypass-project', 'ssh-repo');
    } finally {
        process.env.PATH = origPath;
    }

    // The fake git writes all CLI arguments to capturedArgsFile.
    // The SSH URL must appear verbatim — no token injected.
    const captured = fs.existsSync(capturedArgsFile)
        ? fs.readFileSync(capturedArgsFile, 'utf8')
        : '';

    assert.ok(
        captured.includes(sshUrl),
        `expected original SSH URL in git arguments; got: "${captured}"`,
    );
    assert.ok(
        !captured.includes('ghp_sshbypasstoken'),
        `token must NOT appear in git arguments for SSH URL; got: "${captured}"`,
    );
    // The operation should return a workspace result (clone failed due to fake git,
    // but the URL was still attempted — confirming bypass rather than credential-missing short-circuit).
    assert.ok(result.workspaceResults.length > 0, 'expected at least one workspace result');
});

test('addRepositoryToProject logs credential-missing error via ErrorLogManager with source "credentials"', async () => {
    const base = makeTempDir();

    // Two credentials for the same host — resolution is ambiguous without an explicit CredentialId.
    // This simulates AC#6: multiple same-host credentials cause the error to propagate.
    const config = makeTestConfig(base);
    config.gitCredentials = [
        { id: 'cred-log-1', label: 'Account A', host: 'private.example', token: 'token-a' },
        { id: 'cred-log-2', label: 'Account B', host: 'private.example', token: 'token-b' },
    ];
    initializeStorage(config);

    const repoManager     = new RepositoryManager(config);
    const projectManager  = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);
    const workspaceOrchestrator = new WorkspaceOrchestrator(config, projectManager, workspaceManager, repoManager);
    const errorLogManager = new ErrorLogManager(config);
    const orchestrator    = new RepositoryOrchestrator(config, projectManager, repoManager, errorLogManager);

    // Seed a local (clonable) repo so the project has a workspace to iterate over.
    repoManager.add({ url: originRepoPath, id: 'repo-a-log' });
    projectManager.create('Priv Project Log', ['repo-a-log'], undefined, 'priv-project-ro-log');
    await workspaceOrchestrator.createWorkspace('priv-project-ro-log', 'STABLE');

    // Repo has no CredentialId — auto-selection fails (ambiguous) because two same-host credentials exist.
    repoManager.add({ url: 'https://private.example/org/priv-repo.git', id: 'priv-repo-ro-log', name: 'Priv Repo' });

    await orchestrator.addRepositoryToProject('priv-project-ro-log', 'priv-repo-ro-log');

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

// ─── Credential success log entry (addRepositoryToProject) ────────────────────

test('addRepositoryToProject writes a credentials/info log entry after successful credential-based clone', async () => {
    const base = makeTempDir();
    const fakeGitDir = fs.mkdtempSync(path.join(tmpRoot, 'fake-git-ro-success-log-'));

    // Set up a fake git that exits with 0 (successful clone) and creates the .git dir.
    const fakeGitPath = path.join(fakeGitDir, 'git');
    const capturedArgsFile = path.join(fakeGitDir, 'captured-args.txt');
    fs.writeFileSync(fakeGitPath, `#!/bin/sh\necho "$@" >> ${capturedArgsFile}\nmkdir -p "$2/.git"\nexit 0\n`, { mode: 0o755 });

    const config = makeTestConfig(base);
    config.gitCredentials = [{ id: 'cred-ro-success', label: 'Success Cred', host: 'private.example', token: 'ghp_success' }];
    initializeStorage(config);

    const repoManager     = new RepositoryManager(config);
    const projectManager  = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);
    const workspaceOrchestrator = new WorkspaceOrchestrator(config, projectManager, workspaceManager, repoManager);
    const errorLogManager = new ErrorLogManager(config);
    const orchestrator    = new RepositoryOrchestrator(config, projectManager, repoManager, errorLogManager);

    // Seed project with a clonable repo so the STABLE workspace exists on disk.
    repoManager.add({ url: originRepoPath, id: 'repo-a-success-log' });
    projectManager.create('Cred Project RO', ['repo-a-success-log'], undefined, 'cred-project-ro-success');
    await workspaceOrchestrator.createWorkspace('cred-project-ro-success', 'STABLE');

    // Add the credential-based repo using a fake git that succeeds.
    repoManager.add({ url: 'https://private.example/org/cred-repo.git', id: 'cred-repo-ro', name: 'Cred Repo' });

    const origPath = process.env.PATH ?? '';
    process.env.PATH = `${fakeGitDir}:${origPath}`;
    try {
        await orchestrator.addRepositoryToProject('cred-project-ro-success', 'cred-repo-ro');
    } finally {
        process.env.PATH = origPath;
    }

    const { entries } = errorLogManager.list({ source: 'credentials' });
    const infoEntry = entries.find((e) => e.Severity === 'info');
    assert.ok(infoEntry !== undefined, 'expected a credentials/info log entry after successful credential-based clone');
    assert.strictEqual(infoEntry.Source, 'credentials');
    assert.strictEqual(infoEntry.Operation, 'add-repository');
    assert.strictEqual(infoEntry.Context.ProjectId, 'cred-project-ro-success');
    assert.strictEqual(infoEntry.Context.RepositoryId, 'cred-repo-ro');
});

test('addRepositoryToProject does NOT write a credentials/info log entry for SSH clones (credential === null)', async () => {
    const base = makeTempDir();
    const fakeGitDir = fs.mkdtempSync(path.join(tmpRoot, 'fake-git-ro-ssh-nolog-'));

    // SSH clone succeeds with exit 0.
    const fakeGitPath = path.join(fakeGitDir, 'git');
    const capturedArgsFile = path.join(fakeGitDir, 'captured-args.txt');
    fs.writeFileSync(fakeGitPath, `#!/bin/sh\necho "$@" >> ${capturedArgsFile}\nmkdir -p "$2/.git"\nexit 0\n`, { mode: 0o755 });

    const config = makeTestConfig(base);
    // Credential for a different host so it is not matched against SSH URL.
    config.gitCredentials = [{ id: 'cred-ro-ssh-nolog', label: 'Other Cred', host: 'other.example', token: 'ghp_other' }];
    initializeStorage(config);

    const repoManager     = new RepositoryManager(config);
    const projectManager  = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);
    const workspaceOrchestrator = new WorkspaceOrchestrator(config, projectManager, workspaceManager, repoManager);
    const errorLogManager = new ErrorLogManager(config);
    const orchestrator    = new RepositoryOrchestrator(config, projectManager, repoManager, errorLogManager);

    // Seed project with a clonable repo so the STABLE workspace exists on disk.
    repoManager.add({ url: originRepoPath, id: 'repo-a-ssh-nolog' });
    projectManager.create('SSH Project RO', ['repo-a-ssh-nolog'], undefined, 'ssh-project-ro-nolog');
    await workspaceOrchestrator.createWorkspace('ssh-project-ro-nolog', 'STABLE');

    // SSH URL → host is null → credential is null → no info entry expected.
    repoManager.add({ url: 'git@github.com:org/ssh-repo.git', id: 'ssh-repo-ro-nolog', name: 'SSH Repo' });

    const origPath = process.env.PATH ?? '';
    process.env.PATH = `${fakeGitDir}:${origPath}`;
    try {
        await orchestrator.addRepositoryToProject('ssh-project-ro-nolog', 'ssh-repo-ro-nolog');
    } finally {
        process.env.PATH = origPath;
    }

    const { entries } = errorLogManager.list({ source: 'credentials' });
    const infoEntry = entries.find((e) => e.Severity === 'info');
    assert.strictEqual(infoEntry, undefined, 'SSH clones (credential === null) must NOT produce a credentials/info entry');
});
