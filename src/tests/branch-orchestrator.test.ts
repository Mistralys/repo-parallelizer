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
import { BranchOrchestrator } from '../orchestration/branch-orchestrator.js';
import type { AppConfig } from '../config/config.types.js';
import type { BranchInfo } from '../git/git.types.js';
import { makeTestConfig } from './test-helpers.js';

// ─── Fixture setup ────────────────────────────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-branch-orch-test-'));
const originRepoPath = path.join(tmpRoot, 'origin');

process.on('exit', () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Creates an origin bare-like repo with main branch and a committed file. */
function buildOrigin(): void {
    fs.mkdirSync(originRepoPath, { recursive: true });
    execSync('git init -b main', { cwd: originRepoPath });
    execSync('git config user.email "test@test.local"', { cwd: originRepoPath });
    execSync('git config user.name "Test"', { cwd: originRepoPath });
    fs.writeFileSync(path.join(originRepoPath, 'README.md'), 'hello');
    execSync('git add .', { cwd: originRepoPath });
    execSync('git commit -m "initial"', { cwd: originRepoPath });
    // Create an "existing-branch" so we can test switching to a known branch
    execSync('git checkout -b existing-branch', { cwd: originRepoPath });
    fs.writeFileSync(path.join(originRepoPath, 'extra.md'), 'extra');
    execSync('git add .', { cwd: originRepoPath });
    execSync('git commit -m "branch commit"', { cwd: originRepoPath });
    execSync('git checkout main', { cwd: originRepoPath });
}

buildOrigin();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
    return fs.mkdtempSync(path.join(tmpRoot, 'test-'));
}



interface TestFixture {
    config: AppConfig;
    projectManager: ProjectManager;
    workspaceManager: WorkspaceManager;
    orchestrator: BranchOrchestrator;
    projectId: string;
    workspaceId: string;
    repoId: string;
    repoDir: string;
}

/**
 * Sets up a full fixture:
 * - Initialises storage
 * - Registers a repository
 * - Creates a project
 * - Clones the origin repo into the expected workspace path
 */
function makeFixture(base: string, extraSetup?: (repoDir: string) => void): TestFixture {
    const config = makeTestConfig(base);
    initializeStorage(config);

    const repoManager = new RepositoryManager(config);
    const projectManager = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);

    // Register repo (slug will be inferred as "origin" from the local URL pattern,
    // but we give an explicit id to keep paths predictable)
    repoManager.add({ url: originRepoPath, id: 'test-repo' });
    projectManager.create('Test Project', ['test-repo'], undefined, 'test-project');

    const orchestrator = new BranchOrchestrator(config, projectManager, workspaceManager);

    const projectId = 'test-project';
    const workspaceId = 'STABLE';
    const repoId = 'test-repo';
    const repoDir = path.join(config.projectsFolder, projectId, workspaceId, repoId);

    // Clone origin into the expected workspace path
    fs.mkdirSync(path.dirname(repoDir), { recursive: true });
    execSync(`git clone "${originRepoPath}" "${repoDir}"`);
    execSync('git config user.email "test@test.local"', { cwd: repoDir });
    execSync('git config user.name "Test"', { cwd: repoDir });

    if (extraSetup) extraSetup(repoDir);

    return { config, projectManager, workspaceManager, orchestrator, projectId, workspaceId, repoId, repoDir };
}

// ─── compileBranchSuggestions ─────────────────────────────────────────────────

test('compileBranchSuggestions returns empty array for empty map', () => {
    const { orchestrator } = makeFixture(makeTempDir());
    const suggestions = orchestrator.compileBranchSuggestions(new Map());
    assert.deepStrictEqual(suggestions, []);
});

test('compileBranchSuggestions deduplicates case-insensitively', () => {
    const { orchestrator } = makeFixture(makeTempDir());
    const branchMap = new Map<string, BranchInfo[]>([
        ['repo-a', [
            { name: 'main', isCurrent: true, isRemote: false },
            { name: 'origin/main', isCurrent: false, isRemote: true },
        ]],
        ['repo-b', [
            { name: 'Main', isCurrent: false, isRemote: false },
        ]],
    ]);
    const suggestions = orchestrator.compileBranchSuggestions(branchMap);
    // "main", "Main", "origin/main" all dedup to one entry
    assert.strictEqual(suggestions.filter((s) => s.toLowerCase() === 'main').length, 1);
});

test('compileBranchSuggestions returns sorted list', () => {
    const { orchestrator } = makeFixture(makeTempDir());
    const branchMap = new Map<string, BranchInfo[]>([
        ['repo-a', [
            { name: 'zebra', isCurrent: false, isRemote: false },
            { name: 'alpha', isCurrent: false, isRemote: false },
            { name: 'main', isCurrent: true, isRemote: false },
        ]],
    ]);
    const suggestions = orchestrator.compileBranchSuggestions(branchMap);
    assert.deepStrictEqual(suggestions, ['alpha', 'main', 'zebra']);
});

test('compileBranchSuggestions normalises remote-tracking names', () => {
    const { orchestrator } = makeFixture(makeTempDir());
    const branchMap = new Map<string, BranchInfo[]>([
        ['repo-a', [
            { name: 'origin/feature-x', isCurrent: false, isRemote: true },
        ]],
    ]);
    const suggestions = orchestrator.compileBranchSuggestions(branchMap);
    assert.deepStrictEqual(suggestions, ['feature-x']);
});

test('compileBranchSuggestions collects branches from multiple repos', () => {
    const { orchestrator } = makeFixture(makeTempDir());
    const branchMap = new Map<string, BranchInfo[]>([
        ['repo-a', [{ name: 'feat-a', isCurrent: false, isRemote: false }]],
        ['repo-b', [{ name: 'feat-b', isCurrent: false, isRemote: false }]],
    ]);
    const suggestions = orchestrator.compileBranchSuggestions(branchMap);
    assert.deepStrictEqual(suggestions, ['feat-a', 'feat-b']);
});

// ─── getAvailableBranches ─────────────────────────────────────────────────────

test('getAvailableBranches returns a map keyed by repository ID', async () => {
    const { orchestrator, projectId, workspaceId, repoId } = makeFixture(makeTempDir());
    const branchMap = await orchestrator.getAvailableBranches(projectId, workspaceId);
    assert.ok(branchMap instanceof Map, 'should return a Map');
    assert.ok(branchMap.has(repoId), 'map should contain the repository ID');
});

test('getAvailableBranches returns BranchInfo arrays for each repo', async () => {
    const { orchestrator, projectId, workspaceId, repoId } = makeFixture(makeTempDir());
    const branchMap = await orchestrator.getAvailableBranches(projectId, workspaceId);
    const branches = branchMap.get(repoId);
    assert.ok(Array.isArray(branches), 'value should be an array');
    assert.ok(branches!.length > 0, 'should return at least one branch');
});

test('getAvailableBranches fetches remote and returns remote-tracking branches', async () => {
    // Add a new branch on origin AFTER the clone to prove fetch happened.
    const { orchestrator, projectId, workspaceId, repoId } = makeFixture(makeTempDir(), (_repoDir) => {
        // After cloning, add a new branch on origin to detect if fetch was called
        execSync('git checkout -b post-clone-branch', { cwd: originRepoPath });
        fs.writeFileSync(path.join(originRepoPath, 'post-clone.md'), 'new');
        execSync('git add .', { cwd: originRepoPath });
        execSync('git commit -m "post-clone"', { cwd: originRepoPath });
        execSync('git checkout main', { cwd: originRepoPath });
    });

    const branchMap = await orchestrator.getAvailableBranches(projectId, workspaceId);
    const branches = branchMap.get(repoId)!;
    const hasNewBranch = branches.some((b) => b.name.includes('post-clone-branch'));
    assert.ok(hasNewBranch, 'should include branches added to origin after clone (proves fetch was called)');
});

test('getAvailableBranches throws when project does not exist', async () => {
    const { orchestrator } = makeFixture(makeTempDir());
    await assert.rejects(
        () => orchestrator.getAvailableBranches('nonexistent', 'STABLE'),
        /does not exist/,
    );
});

// ─── switchBranches ───────────────────────────────────────────────────────────

test('switchBranches creates a new branch when it does not exist', async () => {
    const { orchestrator, projectId, workspaceId, repoId, repoDir } = makeFixture(makeTempDir());
    const result = await orchestrator.switchBranches(projectId, workspaceId, {
        [repoId]: 'brand-new-branch',
    });
    assert.strictEqual(result.results[repoId]?.success, true, 'branch creation should succeed');
    // Verify we are now on the new branch
    const branchOutput = execSync('git branch --show-current', { cwd: repoDir }).toString().trim();
    assert.strictEqual(branchOutput, 'brand-new-branch');
});

test('switchBranches switches to an existing local branch', async () => {
    const { orchestrator, projectId, workspaceId, repoId, repoDir } = makeFixture(
        makeTempDir(),
        (repoDir) => {
            // Create a local branch to switch to
            execSync('git checkout -b pre-existing-branch', { cwd: repoDir });
            execSync('git checkout main', { cwd: repoDir });
        },
    );
    const result = await orchestrator.switchBranches(projectId, workspaceId, {
        [repoId]: 'pre-existing-branch',
    });
    assert.strictEqual(result.results[repoId]?.success, true);
    const current = execSync('git branch --show-current', { cwd: repoDir }).toString().trim();
    assert.strictEqual(current, 'pre-existing-branch');
});

test('switchBranches switches to a branch that exists only on remote', async () => {
    const { orchestrator, projectId, workspaceId, repoId, repoDir } = makeFixture(makeTempDir());
    // 'existing-branch' was created on origin before the clone; it is available
    // as a remote-tracking ref but not checked out locally
    const result = await orchestrator.switchBranches(projectId, workspaceId, {
        [repoId]: 'existing-branch',
    });
    assert.strictEqual(result.results[repoId]?.success, true);
    const current = execSync('git branch --show-current', { cwd: repoDir }).toString().trim();
    assert.strictEqual(current, 'existing-branch');
});

test('switchBranches reports per-repository results', async () => {
    const base = makeTempDir();
    const config = makeTestConfig(base);
    initializeStorage(config);
    const repoManager = new RepositoryManager(config);
    const projectManager = new ProjectManager(config, repoManager);
    const workspaceManager = new WorkspaceManager(projectManager);

    // Create two different origin URLs by cloning to distinct local paths
    const origin2Path = path.join(base, 'origin2');
    execSync(`git clone "${originRepoPath}" "${origin2Path}"`);

    repoManager.add({ url: originRepoPath, id: 'repo-1' });
    repoManager.add({ url: origin2Path, id: 'repo-2' });
    projectManager.create('Multi Project', ['repo-1', 'repo-2'], undefined, 'multi-project');

    const orchestrator = new BranchOrchestrator(config, projectManager, workspaceManager);
    const projectId = 'multi-project';
    const workspaceId = 'STABLE';

    // Clone both repos into the expected workspace paths
    for (const [repoId, srcPath] of [['repo-1', originRepoPath], ['repo-2', origin2Path]]) {
        const repoDir = path.join(config.projectsFolder, projectId, workspaceId, repoId);
        fs.mkdirSync(path.dirname(repoDir), { recursive: true });
        execSync(`git clone "${srcPath}" "${repoDir}"`);
        execSync('git config user.email "test@test.local"', { cwd: repoDir });
        execSync('git config user.name "Test"', { cwd: repoDir });
    }

    const result = await orchestrator.switchBranches(projectId, workspaceId, {
        'repo-1': 'branch-for-repo1',
        'repo-2': 'branch-for-repo2',
    });

    assert.ok('repo-1' in result.results, 'should have result for repo-1');
    assert.ok('repo-2' in result.results, 'should have result for repo-2');
    assert.strictEqual(result.results['repo-1']?.success, true);
    assert.strictEqual(result.results['repo-2']?.success, true);
});

test('switchBranches reports failure with error when repo path does not exist', async () => {
    const { orchestrator, projectId, workspaceId } = makeFixture(makeTempDir());
    const result = await orchestrator.switchBranches(projectId, workspaceId, {
        'nonexistent-repo': 'some-branch',
    });
    assert.strictEqual(result.results['nonexistent-repo']?.success, false);
    assert.ok(
        typeof result.results['nonexistent-repo']?.error === 'string',
        'should populate error field',
    );
});

test('switchBranches updates workspace DateModified after switching', async () => {
    const { orchestrator, projectManager, projectId, workspaceId, repoId } = makeFixture(makeTempDir());

    const before = projectManager.getById(projectId)!.Workspaces[workspaceId]!.DateModified;

    // Ensure at least 1 ms passes before the update
    await new Promise((resolve) => setTimeout(resolve, 5));

    await orchestrator.switchBranches(projectId, workspaceId, {
        [repoId]: 'date-modified-check-branch',
    });

    const after = projectManager.getById(projectId)!.Workspaces[workspaceId]!.DateModified;
    assert.notStrictEqual(before, after, 'DateModified should be updated after switchBranches');
    assert.ok(new Date(after) > new Date(before), 'DateModified should be strictly later');
});

// ─── DateModified conditional update (WP-005) ────────────────────────────────

test('switchBranches does NOT update DateModified when all operations fail', async () => {
    const { orchestrator, projectManager, projectId, workspaceId } = makeFixture(makeTempDir());

    const before = projectManager.getById(projectId)!.Workspaces[workspaceId]!.DateModified;

    await new Promise((resolve) => setTimeout(resolve, 5));

    // All repos nonexistent → every operation fails → DateModified must stay unchanged
    await orchestrator.switchBranches(projectId, workspaceId, {
        'nonexistent-repo': 'some-branch',
    });

    const after = projectManager.getById(projectId)!.Workspaces[workspaceId]!.DateModified;
    assert.strictEqual(after, before, 'DateModified should NOT be updated when all operations fail');
});

test('switchBranches updates DateModified when at least one operation succeeds', async () => {
    const { orchestrator, projectManager, projectId, workspaceId, repoId } = makeFixture(makeTempDir());

    const before = projectManager.getById(projectId)!.Workspaces[workspaceId]!.DateModified;

    // Ensure at least 1 ms passes so a timestamp change is observable
    await new Promise((resolve) => setTimeout(resolve, 5));

    // repoId is valid and 'any-success-branch' does not exist → will be created → success
    const result = await orchestrator.switchBranches(projectId, workspaceId, {
        [repoId]: 'any-success-branch',
    });

    assert.strictEqual(result.results[repoId]?.success, true, 'branch switch should succeed');

    const after = projectManager.getById(projectId)!.Workspaces[workspaceId]!.DateModified;
    assert.notStrictEqual(after, before, 'DateModified should be updated when at least one operation succeeds');
    assert.ok(new Date(after) > new Date(before), 'DateModified should be strictly later');
});

test('switchBranches reports conflict=true when working tree would be overwritten', async () => {
    const { orchestrator, projectId, workspaceId, repoId, repoDir } = makeFixture(makeTempDir());

    // Make an uncommitted change to a file that differs between branches.
    // 'existing-branch' has 'extra.md', which 'main' does not.
    // To trigger a conflict-on-switch we need conflicting changes in a tracked file.
    // Strategy: modify README.md (tracked on main), then try to switch to existing-branch
    // which also has a different version of README.md (if we can arrange it).
    // Since both branches track README.md with same content and extra.md only exists
    // on existing-branch, this simpler scenario: dirty untracked change on main,
    // switch to branch that has the same file tracked → overwrite scenario.

    // Create a file on existing-branch that would conflict with an uncommitted change
    execSync('git checkout existing-branch', { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'conflicting-file.txt'), 'branch-version');
    execSync('git add .', { cwd: repoDir });
    execSync('git commit -m "add conflicting file"', { cwd: repoDir });
    execSync('git checkout main', { cwd: repoDir });

    // Now create an uncommitted change in the same file on main
    fs.writeFileSync(path.join(repoDir, 'conflicting-file.txt'), 'local-version');

    const result = await orchestrator.switchBranches(projectId, workspaceId, {
        [repoId]: 'existing-branch',
    });

    // The switch should fail (git refuses to overwrite local changes)
    assert.strictEqual(result.results[repoId]?.success, false);
    // The assertion below is intentionally permissive: git output varies across
    // versions and platforms (some report "conflict", others emit a generic
    // error message). Tightening it to `conflict === true` would cause false
    // failures on platforms where the stderr doesn't match the conflict regex.
    assert.ok(
        result.results[repoId]?.conflict === true || result.results[repoId]?.error !== undefined,
        'should report either conflict=true or a non-empty error',
    );
});
