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
import { ProjectOrchestrator } from '../orchestration/project-orchestrator.js';

// ─── Global fixtures ──────────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-proj-orch-test-'));
const originRepoPath = path.join(tmpRoot, 'origin');

process.on('exit', () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Creates a simple local git repo with one commit on `main`. */
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
    orchestrator: ProjectOrchestrator;
}

function makeFixture(base: string): TestFixture {
    const config = makeConfig(base);
    initializeStorage(config);

    const repoManager = new RepositoryManager(config);
    const projectManager = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);
    const workspaceOrchestrator = new WorkspaceOrchestrator(config, projectManager, workspaceManager, repoManager);
    const orchestrator = new ProjectOrchestrator(config, projectManager, workspaceOrchestrator);

    repoManager.add({ url: originRepoPath, id: 'test-repo' });

    return { config, repoManager, projectManager, workspaceManager, workspaceOrchestrator, orchestrator };
}

// ─── createProject ───────────────────────────────────────────────────────────

test('createProject creates the project root folder', async () => {
    const { config, orchestrator } = makeFixture(makeTempDir());
    await orchestrator.createProject('My Project', ['test-repo'], undefined, 'my-project');
    assert.ok(fs.existsSync(path.join(config.projectsFolder, 'my-project')), 'project root folder should exist');
});

test('createProject creates the STABLE workspace folder', async () => {
    const { config, orchestrator } = makeFixture(makeTempDir());
    await orchestrator.createProject('My Project', ['test-repo'], undefined, 'my-project');
    assert.ok(
        fs.existsSync(path.join(config.projectsFolder, 'my-project', 'STABLE')),
        'STABLE workspace folder should exist',
    );
});

test('createProject clones the repository into the STABLE workspace', async () => {
    const { config, orchestrator } = makeFixture(makeTempDir());
    await orchestrator.createProject('My Project', ['test-repo'], undefined, 'my-project');
    const repoDir = path.join(config.projectsFolder, 'my-project', 'STABLE', 'test-repo');
    assert.ok(fs.existsSync(path.join(repoDir, '.git')), 'cloned repo .git directory should exist');
});

test('createProject generates a VS Code workspace file for STABLE', async () => {
    const { config, orchestrator } = makeFixture(makeTempDir());
    await orchestrator.createProject('My Project', ['test-repo'], undefined, 'my-project');
    const wsFile = path.join(config.projectsFolder, 'my-project-STABLE.code-workspace');
    assert.ok(fs.existsSync(wsFile), 'STABLE VS Code workspace file should exist');
});

test('createProject returns OrchestrationResult with repo results', async () => {
    const { orchestrator } = makeFixture(makeTempDir());
    const result = await orchestrator.createProject('My Project', ['test-repo'], undefined, 'my-project');
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].repositoryId, 'test-repo');
    assert.strictEqual(result.results[0].success, true);
});

test('createProject persists the project data entry', async () => {
    const { orchestrator, projectManager } = makeFixture(makeTempDir());
    await orchestrator.createProject('My Project', ['test-repo'], undefined, 'my-project');
    const project = projectManager.getById('my-project');
    assert.ok(project !== undefined, 'project should be in the data store');
    assert.strictEqual(project!.Name, 'My Project');
});

test('createProject throws when repository does not exist', async () => {
    const { orchestrator } = makeFixture(makeTempDir());
    await assert.rejects(
        () => orchestrator.createProject('My Project', ['nonexistent-repo'], undefined, 'my-project'),
        /does not exist/,
    );
});

// ─── deleteProject ───────────────────────────────────────────────────────────

test('deleteProject removes the project root folder', async () => {
    const { config, orchestrator } = makeFixture(makeTempDir());
    await orchestrator.createProject('My Project', ['test-repo'], undefined, 'my-project');
    const projectFolder = path.join(config.projectsFolder, 'my-project');
    assert.ok(fs.existsSync(projectFolder), 'precondition: folder should exist');

    orchestrator.deleteProject('my-project');
    assert.ok(!fs.existsSync(projectFolder), 'project folder should be removed after delete');
});

test('deleteProject removes all workspace subfolders (cascading)', async () => {
    const { config, orchestrator, workspaceManager } = makeFixture(makeTempDir());
    await orchestrator.createProject('My Project', ['test-repo'], undefined, 'my-project');

    // Create an additional workspace to verify cascading delete
    workspaceManager.create('my-project', 'DEV');
    const stableDir = path.join(config.projectsFolder, 'my-project', 'STABLE');
    assert.ok(fs.existsSync(stableDir), 'precondition: STABLE folder should exist');

    orchestrator.deleteProject('my-project');
    assert.ok(!fs.existsSync(path.join(config.projectsFolder, 'my-project')), 'entire project tree should be removed');
});

test('deleteProject removes the STABLE VS Code workspace file', async () => {
    const { config, orchestrator } = makeFixture(makeTempDir());
    await orchestrator.createProject('My Project', ['test-repo'], undefined, 'my-project');
    const wsFile = path.join(config.projectsFolder, 'my-project-STABLE.code-workspace');
    assert.ok(fs.existsSync(wsFile), 'precondition: STABLE VS Code file should exist');

    orchestrator.deleteProject('my-project');
    assert.ok(!fs.existsSync(wsFile), 'STABLE VS Code workspace file should be removed');
});

test('deleteProject removes VS Code workspace files for all workspaces', async () => {
    const { config, orchestrator, workspaceManager } = makeFixture(makeTempDir());
    await orchestrator.createProject('My Project', ['test-repo'], undefined, 'my-project');
    workspaceManager.create('my-project', 'DEV');
    // Manually create a DEV .code-workspace file to simulate
    const devWsFile = path.join(config.projectsFolder, 'my-project-DEV.code-workspace');
    fs.writeFileSync(devWsFile, '{}', 'utf8');
    assert.ok(fs.existsSync(devWsFile), 'precondition: DEV VS Code file should exist');

    orchestrator.deleteProject('my-project');
    assert.ok(!fs.existsSync(devWsFile), 'DEV VS Code workspace file should be removed');
});

test('deleteProject removes the project data entry', async () => {
    const { orchestrator, projectManager } = makeFixture(makeTempDir());
    await orchestrator.createProject('My Project', ['test-repo'], undefined, 'my-project');
    assert.ok(projectManager.getById('my-project') !== undefined, 'precondition: project must exist');

    orchestrator.deleteProject('my-project');
    assert.strictEqual(projectManager.getById('my-project'), undefined, 'project data entry should be removed');
});

test('deleteProject succeeds when project folder does not exist on disk', async () => {
    const { config, orchestrator, projectManager } = makeFixture(makeTempDir());
    // Create the data entry only (no disk setup)
    projectManager.create('Ghost Project', ['test-repo'], undefined, 'ghost-project');
    const projectFolder = path.join(config.projectsFolder, 'ghost-project');
    assert.ok(!fs.existsSync(projectFolder), 'precondition: folder should not exist');

    assert.doesNotThrow(() => orchestrator.deleteProject('ghost-project'));
    assert.strictEqual(projectManager.getById('ghost-project'), undefined, 'project data entry should be removed');
});

test('deleteProject throws when project does not exist', () => {
    const { orchestrator } = makeFixture(makeTempDir());
    assert.throws(
        () => orchestrator.deleteProject('nonexistent-project'),
        /does not exist/,
    );
});

// ─── renameProject ───────────────────────────────────────────────────────────

test('renameProject renames the project folder on disk', async () => {
    const { config, orchestrator } = makeFixture(makeTempDir());
    await orchestrator.createProject('My Project', ['test-repo'], undefined, 'old-project');

    const oldFolder = path.join(config.projectsFolder, 'old-project');
    const newFolder = path.join(config.projectsFolder, 'new-project');
    assert.ok(fs.existsSync(oldFolder), 'precondition: old folder should exist');

    orchestrator.renameProject('old-project', 'new-project');

    assert.ok(!fs.existsSync(oldFolder), 'old project folder should not exist after rename');
    assert.ok(fs.existsSync(newFolder), 'new project folder should exist after rename');
});

test('renameProject generates the new VS Code workspace file', async () => {
    const { config, orchestrator } = makeFixture(makeTempDir());
    await orchestrator.createProject('My Project', ['test-repo'], undefined, 'old-project');

    orchestrator.renameProject('old-project', 'new-project');

    const newFile = path.join(config.projectsFolder, 'new-project-STABLE.code-workspace');
    assert.ok(fs.existsSync(newFile), 'new VS Code workspace file should exist after rename');
});

test('renameProject removes the old VS Code workspace file', async () => {
    const { config, orchestrator } = makeFixture(makeTempDir());
    await orchestrator.createProject('My Project', ['test-repo'], undefined, 'old-project');
    const oldFile = path.join(config.projectsFolder, 'old-project-STABLE.code-workspace');
    assert.ok(fs.existsSync(oldFile), 'precondition: old VS Code file should exist');

    orchestrator.renameProject('old-project', 'new-project');

    assert.ok(!fs.existsSync(oldFile), 'old VS Code workspace file should not exist after rename');
});

test('renameProject updates folder paths in the VS Code workspace file', async () => {
    const { config, orchestrator } = makeFixture(makeTempDir());
    await orchestrator.createProject('My Project', ['test-repo'], undefined, 'old-project');

    orchestrator.renameProject('old-project', 'new-project');

    const newFile = path.join(config.projectsFolder, 'new-project-STABLE.code-workspace');
    const parsed = JSON.parse(fs.readFileSync(newFile, 'utf8'));
    const expectedRepoPath = path.join(config.projectsFolder, 'new-project', 'STABLE', 'test-repo');
    assert.strictEqual(parsed.folders[0].path, expectedRepoPath, 'folder path should reference new project directory');
    // Verify old ID is not in any path
    assert.ok(
        !parsed.folders[0].path.includes('old-project'),
        'folder path should not contain the old project ID',
    );
});

test('renameProject updates the project data entry', async () => {
    const { orchestrator, projectManager } = makeFixture(makeTempDir());
    await orchestrator.createProject('My Project', ['test-repo'], undefined, 'old-project');

    orchestrator.renameProject('old-project', 'new-project');

    assert.strictEqual(projectManager.getById('old-project'), undefined, 'old ID should not exist in data');
    const renamedProject = projectManager.getById('new-project');
    assert.ok(renamedProject !== undefined, 'new ID should exist in data');
    assert.strictEqual(renamedProject!.Id, 'new-project');
});

test('renameProject handles all workspaces (cascading VS Code file regeneration)', async () => {
    const { config, orchestrator, workspaceManager } = makeFixture(makeTempDir());
    await orchestrator.createProject('My Project', ['test-repo'], undefined, 'old-project');

    // Add a second workspace to verify renaming handles multiple workspaces
    workspaceManager.create('old-project', 'DEV');
    const oldDevFile = path.join(config.projectsFolder, 'old-project-DEV.code-workspace');
    // Simulate the DEV workspace file existing
    fs.writeFileSync(oldDevFile, JSON.stringify({ folders: [], settings: {} }, null, 4) + '\n', 'utf8');

    orchestrator.renameProject('old-project', 'new-project');

    assert.ok(!fs.existsSync(oldDevFile), 'old DEV VS Code file should be removed after rename');
    const newDevFile = path.join(config.projectsFolder, 'new-project-DEV.code-workspace');
    assert.ok(fs.existsSync(newDevFile), 'new DEV VS Code file should be created after rename');
});

test('renameProject throws when oldId does not exist', () => {
    const { orchestrator } = makeFixture(makeTempDir());
    assert.throws(
        () => orchestrator.renameProject('nonexistent-project', 'new-id'),
        /does not exist/,
    );
});

test('renameProject throws when newId is not valid kebab-case', async () => {
    const { orchestrator } = makeFixture(makeTempDir());
    await orchestrator.createProject('My Project', ['test-repo'], undefined, 'old-project');
    assert.throws(
        () => orchestrator.renameProject('old-project', 'INVALID_ID'),
        /invalid|kebab|format/i,
    );
});

// ─── createProject rollback ───────────────────────────────────────────────────

test('createProject rolls back data entry when createWorkspace() fails', async () => {
    const { projectManager, orchestrator, workspaceOrchestrator } = makeFixture(makeTempDir());

    // Override createWorkspace to simulate a hard failure.
    workspaceOrchestrator.createWorkspace = async (_projectId: string, _workspaceId: string) => {
        throw new Error('Simulated workspace creation failure');
    };

    // The call should reject with the simulated error.
    await assert.rejects(
        () => orchestrator.createProject('Failing Project', ['test-repo'], undefined, 'failing-project'),
        /Simulated workspace creation failure/,
    );

    // After the failure, no orphaned data entry should remain.
    assert.strictEqual(
        projectManager.getById('failing-project'),
        undefined,
        'createProject() must remove the orphaned data entry on failure',
    );
});

// ─── renameProject path-traversal guard ──────────────────────────────────────

test('renameProject throws with "Security check failed" for a path-traversal newId', async () => {
    const { orchestrator } = makeFixture(makeTempDir());
    await orchestrator.createProject('My Project', ['test-repo'], undefined, 'valid-id');

    assert.throws(
        () => orchestrator.renameProject('valid-id', '../../outside'),
        /Security check failed/,
    );
});
