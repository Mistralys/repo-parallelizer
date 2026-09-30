import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { initializeStorage } from '../storage/json-storage.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { ProjectManager } from '../models/project/project.manager.js';
import { WorkspaceManager } from '../models/workspace/workspace.manager.js';
import { WorkspaceArtifactsOrchestrator } from '../orchestration/workspace-artifacts.js';
import { GENERATED_BEGIN_MARKER } from '../orchestration/workspace-index.js';
import { STABLE_WORKSPACE_ID } from '../models/workspace/workspace.types.js';
import type { AppConfig } from '../config/config.types.js';
import { makeTestConfig, createTempDirTracker } from './test-helpers.js';

const makeTempDir = createTempDirTracker('paralizer-workspace-artifacts-test-');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface TestFixture {
    config: AppConfig;
    repoManager: RepositoryManager;
    projectManager: ProjectManager;
    workspaceManager: WorkspaceManager;
    orchestrator: WorkspaceArtifactsOrchestrator;
    projectId: string;
    repoId: string;
}

function makeFixture(overrides?: Partial<AppConfig>): TestFixture {
    const base = makeTempDir();
    const config = makeTestConfig(base, overrides);
    initializeStorage(config);

    const repoManager = new RepositoryManager(config);
    const projectManager = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);
    const orchestrator = new WorkspaceArtifactsOrchestrator(config, projectManager, repoManager);

    repoManager.add({ url: 'https://example.com/org/test-repo.git', id: 'test-repo', name: 'Test Repo' });
    projectManager.create('Test Project', ['test-repo'], 'A project.', 'test-project');

    return { config, repoManager, projectManager, workspaceManager, orchestrator, projectId: 'test-project', repoId: 'test-repo' };
}

function wsFolder(config: AppConfig, projectId: string, workspaceId: string): string {
    return path.join(config.projectsFolder, projectId, workspaceId);
}

function wsFilePath(config: AppConfig, projectId: string, workspaceId: string): string {
    return path.join(config.projectsFolder, projectId, `${projectId}-${workspaceId}.code-workspace`);
}

// ---------------------------------------------------------------------------
// regenerateWorkspace()
// ---------------------------------------------------------------------------

test('regenerateWorkspace: writes the .code-workspace file even when the workspace folder does not exist', () => {
    const { config, orchestrator, projectId } = makeFixture();
    orchestrator.regenerateWorkspace(projectId, STABLE_WORKSPACE_ID);

    assert.ok(fs.existsSync(wsFilePath(config, projectId, STABLE_WORKSPACE_ID)), '.code-workspace file should be written');
    assert.ok(!fs.existsSync(wsFolder(config, projectId, STABLE_WORKSPACE_ID)), 'workspace folder should not be created as a side effect');
});

test('regenerateWorkspace: skips index files when the workspace folder does not exist', () => {
    const { config, orchestrator, projectId } = makeFixture();
    orchestrator.regenerateWorkspace(projectId, STABLE_WORKSPACE_ID);

    assert.ok(!fs.existsSync(path.join(wsFolder(config, projectId, STABLE_WORKSPACE_ID), 'README.md')));
});

test('regenerateWorkspace: writes .code-workspace and all three index files together when the folder exists', () => {
    const { config, orchestrator, projectId } = makeFixture();
    fs.mkdirSync(wsFolder(config, projectId, STABLE_WORKSPACE_ID), { recursive: true });

    orchestrator.regenerateWorkspace(projectId, STABLE_WORKSPACE_ID);

    assert.ok(fs.existsSync(wsFilePath(config, projectId, STABLE_WORKSPACE_ID)));
    for (const name of ['README.md', 'AGENTS.md', 'CLAUDE.md']) {
        assert.ok(
            fs.existsSync(path.join(wsFolder(config, projectId, STABLE_WORKSPACE_ID), name)),
            `${name} should be written`,
        );
    }
});

test('regenerateWorkspace: .code-workspace folders include only repositories still present in the repository store', () => {
    const { config, repoManager, orchestrator, projectId, projectManager } = makeFixture();
    repoManager.add({ url: 'https://example.com/org/ghost.git', id: 'ghost-repo', name: 'Ghost' });
    projectManager.addRepository(projectId, 'ghost-repo');

    // Delete the repo from the store after it has been listed on the project,
    // simulating a repository that was removed globally without ever being
    // detached from this specific project (defensive case for regenerate()).
    repoManager.remove('ghost-repo');

    fs.mkdirSync(wsFolder(config, projectId, STABLE_WORKSPACE_ID), { recursive: true });
    orchestrator.regenerateWorkspace(projectId, STABLE_WORKSPACE_ID);

    const wsFile = JSON.parse(fs.readFileSync(wsFilePath(config, projectId, STABLE_WORKSPACE_ID), 'utf8'));
    assert.strictEqual(wsFile.folders.length, 1, 'the deleted repository should be skipped, not thrown on');
    assert.ok(wsFile.folders[0].path.endsWith('test-repo'));

    const readme = fs.readFileSync(path.join(wsFolder(config, projectId, STABLE_WORKSPACE_ID), 'README.md'), 'utf8');
    assert.ok(!readme.includes('ghost-repo'), 'index file should not list the deleted repository either');
});

test('regenerateWorkspace: index content reflects project/workspace metadata and guiUrl', () => {
    const { config, orchestrator, projectId } = makeFixture({ serverPort: 5555 });
    fs.mkdirSync(wsFolder(config, projectId, STABLE_WORKSPACE_ID), { recursive: true });

    orchestrator.regenerateWorkspace(projectId, STABLE_WORKSPACE_ID);

    const readme = fs.readFileSync(path.join(wsFolder(config, projectId, STABLE_WORKSPACE_ID), 'README.md'), 'utf8');
    assert.ok(readme.includes(GENERATED_BEGIN_MARKER));
    assert.ok(readme.includes('Test Project'));
    assert.ok(readme.includes(`http://localhost:5555/#/projects/${projectId}/workspaces/${STABLE_WORKSPACE_ID}`));
});

test('regenerateWorkspace: uses overrides.workspaceMeta instead of project.Workspaces lookup', () => {
    const { config, orchestrator, projectId } = makeFixture();
    fs.mkdirSync(wsFolder(config, projectId, 'DEV'), { recursive: true });

    // "DEV" is not present in project.Workspaces at all — this exercises the
    // rename ordering scenario where the folder has moved to the new ID
    // before WorkspaceManager.rename() updates the data.
    orchestrator.regenerateWorkspace(projectId, 'DEV', {
        workspaceMeta: {
            Description: 'Overridden description',
            DateCreated: '2026-01-01T00:00:00.000Z',
            DateModified: '2026-01-01T00:00:00.000Z',
            Notes: 'Overridden notes',
        },
    });

    const readme = fs.readFileSync(path.join(wsFolder(config, projectId, 'DEV'), 'README.md'), 'utf8');
    assert.ok(readme.includes('Overridden description'));
    assert.ok(readme.includes('Overridden notes'));
});

test('regenerateWorkspace: throws when the project does not exist', () => {
    const { orchestrator } = makeFixture();
    assert.throws(() => orchestrator.regenerateWorkspace('no-such-project', STABLE_WORKSPACE_ID));
});

test('regenerateWorkspace: throws when the workspace is absent from project data and no override is given', () => {
    const { orchestrator, projectId } = makeFixture();
    assert.throws(() => orchestrator.regenerateWorkspace(projectId, 'GHOST'));
});

// ---------------------------------------------------------------------------
// regenerateProject()
// ---------------------------------------------------------------------------

test('regenerateProject: regenerates artefacts for every workspace of the project', () => {
    const { config, orchestrator, workspaceManager, projectId } = makeFixture();
    workspaceManager.create(projectId, 'DEV');
    fs.mkdirSync(wsFolder(config, projectId, STABLE_WORKSPACE_ID), { recursive: true });
    fs.mkdirSync(wsFolder(config, projectId, 'DEV'), { recursive: true });

    orchestrator.regenerateProject(projectId);

    assert.ok(fs.existsSync(wsFilePath(config, projectId, STABLE_WORKSPACE_ID)));
    assert.ok(fs.existsSync(wsFilePath(config, projectId, 'DEV')));
    assert.ok(fs.existsSync(path.join(wsFolder(config, projectId, STABLE_WORKSPACE_ID), 'README.md')));
    assert.ok(fs.existsSync(path.join(wsFolder(config, projectId, 'DEV'), 'README.md')));
});

test('regenerateProject: throws when the project does not exist', () => {
    const { orchestrator } = makeFixture();
    assert.throws(() => orchestrator.regenerateProject('no-such-project'));
});

// ---------------------------------------------------------------------------
// regenerateForRepository()
// ---------------------------------------------------------------------------

test('regenerateForRepository: regenerates every project listing the repository', () => {
    const { config, orchestrator, projectManager, repoManager, projectId } = makeFixture();
    projectManager.create('Second Project', ['test-repo'], undefined, 'second-project');
    fs.mkdirSync(wsFolder(config, projectId, STABLE_WORKSPACE_ID), { recursive: true });
    fs.mkdirSync(wsFolder(config, 'second-project', STABLE_WORKSPACE_ID), { recursive: true });

    orchestrator.regenerateForRepository('test-repo');

    assert.ok(fs.existsSync(wsFilePath(config, projectId, STABLE_WORKSPACE_ID)));
    assert.ok(fs.existsSync(wsFilePath(config, 'second-project', STABLE_WORKSPACE_ID)));
    assert.deepStrictEqual(repoManager.getById('test-repo')?.Id, 'test-repo');
});

test('regenerateForRepository: skips projects that do not list the repository', () => {
    const { config, orchestrator, projectManager, projectId } = makeFixture();
    projectManager.create('Unrelated Project', [], undefined, 'unrelated-project');
    fs.mkdirSync(wsFolder(config, 'unrelated-project', STABLE_WORKSPACE_ID), { recursive: true });

    orchestrator.regenerateForRepository('test-repo');

    assert.ok(fs.existsSync(wsFilePath(config, projectId, STABLE_WORKSPACE_ID)), 'the listing project should be regenerated');
    assert.ok(
        !fs.existsSync(wsFilePath(config, 'unrelated-project', STABLE_WORKSPACE_ID)),
        'the unrelated project should be left untouched',
    );
});

// ---------------------------------------------------------------------------
// removeWorkspace()
// ---------------------------------------------------------------------------

test('removeWorkspace: removes the .code-workspace file and the generated index files', () => {
    const { config, orchestrator, projectId } = makeFixture();
    fs.mkdirSync(wsFolder(config, projectId, STABLE_WORKSPACE_ID), { recursive: true });
    orchestrator.regenerateWorkspace(projectId, STABLE_WORKSPACE_ID);

    orchestrator.removeWorkspace(projectId, STABLE_WORKSPACE_ID);

    assert.ok(!fs.existsSync(wsFilePath(config, projectId, STABLE_WORKSPACE_ID)));
    for (const name of ['README.md', 'AGENTS.md', 'CLAUDE.md']) {
        assert.ok(!fs.existsSync(path.join(wsFolder(config, projectId, STABLE_WORKSPACE_ID), name)));
    }
});

test('removeWorkspace: tolerates artefacts that were never created', () => {
    const { orchestrator, projectId } = makeFixture();
    assert.doesNotThrow(() => orchestrator.removeWorkspace(projectId, 'NEVER-CREATED'));
});
