import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import type { AppConfig } from '../config/config.types.js';
import { initializeStorage, writeJsonFile } from '../storage/json-storage.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { ProjectManager } from '../models/project/project.manager.js';
import { WorkspaceManager } from '../models/workspace/workspace.manager.js';
import { WorkspaceOrchestrator } from '../orchestration/workspace-orchestrator.js';
import { RepositoryOrchestrator } from '../orchestration/repository-orchestrator.js';

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
    const config = makeConfig(base);
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

    const wsFile = path.join(config.projectsFolder, `${projectId}-STABLE.code-workspace`);
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
    const config = makeConfig(base);
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
    const config = makeConfig(base);
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

    const wsFile = path.join(config.projectsFolder, `${projectId}-STABLE.code-workspace`);
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
    const config = makeConfig(base);
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
    const config = makeConfig(base);
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
