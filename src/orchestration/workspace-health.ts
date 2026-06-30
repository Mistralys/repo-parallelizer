import * as fs from 'node:fs';
import * as path from 'node:path';
import { getWorkspaceFilePath } from './vscode-workspace.js';
import type { ErrorLogManager } from '../error-log/error-log.manager.js';

export interface WorkspaceHealthIssue {
    type: string;
    severity: 'error' | 'warning';
    message: string;
    fixAction: string;
    repositoryId?: string;
}

export interface WorkspaceHealthReport {
    healthy: boolean;
    issues: WorkspaceHealthIssue[];
}

/**
 * Performs a side-effect-free health check on a workspace.
 *
 * Checks:
 * 1. Whether the VS Code .code-workspace file exists on disk.
 * 2. Whether each repository directory contains a `.git` entry
 *    (i.e. has been successfully cloned).
 * 3. (Optional) Whether the error log contains recent credential-missing entries
 *    for repositories in this workspace. Only performed when `errorLogManager`
 *    is provided.
 *
 * Note on `.git` detection: the clone check uses `fs.existsSync` on the `.git`
 * path entry, which returns `true` for both a `.git` directory (standard clone)
 * and a `.git` file (git worktree pointer). Both forms are treated as a
 * successfully cloned repository. If you need to distinguish between a full
 * clone and a worktree, use `fs.statSync().isDirectory()` instead.
 *
 * @param projectId       Project identifier (used as the project slug in paths).
 * @param workspaceId     Workspace identifier.
 * @param projectsFolder  Root folder where projects are stored on disk.
 * @param repositoryIds   Ordered list of repository IDs belonging to the workspace.
 * @param errorLogManager Optional error log manager. When provided, the health
 *                        report includes `credential-missing` issues for repositories
 *                        whose most recent `Source: 'credentials'` log entry has
 *                        `Severity: 'error'`. Both `'error'` and `'info'` entries
 *                        are evaluated — a newer `'info'` entry (written after a
 *                        successful credential-based clone) suppresses the issue.
 * @returns               A health report with a `healthy` flag and an array of issues.
 *
 * @remarks
 * **Stale credential-missing badge resolution:**
 * The credential check (Check 3) surfaces `credential-missing` issues only when
 * the *most recent* `Source: 'credentials'` entry for a repository has
 * `Severity: 'error'`. After a user assigns a credential and the next setup run
 * completes successfully, the orchestrators write a `Severity: 'info'` entry for
 * that repository. Because entries are returned newest-first and the Set
 * de-duplication keeps only the first (most recent) entry per repository, a
 * subsequent `'info'` entry suppresses the stale `'error'` — clearing the amber
 * badge without deleting history. If the credential is later removed and an error
 * entry is written again, that error entry re-surfaces the issue.
 */
export function checkWorkspaceHealth(
    projectId: string,
    workspaceId: string,
    projectsFolder: string,
    repositoryIds: string[],
    errorLogManager?: ErrorLogManager,
): WorkspaceHealthReport {
    const issues: WorkspaceHealthIssue[] = [];

    // Check 1: VS Code workspace file exists.
    const workspaceFilePath = getWorkspaceFilePath(projectsFolder, projectId, workspaceId);
    if (!fs.existsSync(workspaceFilePath)) {
        issues.push({
            type: 'workspace-file-missing',
            severity: 'warning',
            message: 'VS Code workspace file is missing.',
            fixAction: 'regenerate-workspace-file',
        });
    }

    // Check 2: Each repository has been cloned (has a .git subdirectory).
    for (const repoId of repositoryIds) {
        const repoPath = path.join(projectsFolder, projectId, workspaceId, repoId);
        if (!fs.existsSync(path.join(repoPath, '.git'))) {
            issues.push({
                type: 'repository-not-cloned',
                severity: 'warning',
                message: `Repository "${repoId}" is not cloned.`,
                fixAction: 'setup-workspace',
                repositoryId: repoId,
            });
        }
    }

    // Check 3: (Optional) Credential-missing errors from the most recent credential operation.
    // Query all credential entries (both 'error' and 'info') for this workspace
    // and inspect the most recent entry per repository. A 'credential-missing'
    // health issue is only surfaced when the most recent entry has Severity: 'error'.
    // A newer Severity: 'info' entry (written after a successful credential-based
    // clone) suppresses the stale error badge without deleting history.
    // Entries are returned newest-first from errorLogManager.list(), so the Set
    // de-duplication naturally keeps only the most recent entry per repository.
    if (errorLogManager) {
        const { entries } = errorLogManager.list({ source: 'credentials' });

        // Filter to entries scoped to this workspace.
        const wsEntries = entries.filter(
            (e) =>
                e.Context.WorkspaceId === workspaceId &&
                e.Context.ProjectId === projectId &&
                e.Context.RepositoryId !== undefined,
        );

        // De-duplicate by repository ID, keeping only the most recent entry per repo.
        // Relies on errorLogManager.list() returning entries newest-first — see ErrorLogManager.list().
        // Only push a credential-missing issue when the most recent entry is an error.
        const seenRepos = new Set<string>();
        for (const entry of wsEntries) {
            const repoId = entry.Context.RepositoryId!;
            if (!seenRepos.has(repoId)) {
                seenRepos.add(repoId);
                if (entry.Severity === 'error') {
                    issues.push({
                        type: 'credential-missing',
                        severity: 'warning',
                        message: entry.Message,
                        fixAction: 'configure-credential',
                        repositoryId: repoId,
                    });
                }
                // Severity: 'info' means the most recent credential operation
                // succeeded — suppress any stale credential-missing badge.
            }
        }
    }

    return {
        healthy: issues.length === 0,
        issues,
    };
}
