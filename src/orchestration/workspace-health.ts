import * as fs from 'node:fs';
import * as path from 'node:path';
import { getWorkspaceFilePath } from './vscode-workspace.js';

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
 * @returns               A health report with a `healthy` flag and an array of issues.
 */
export function checkWorkspaceHealth(
    projectId: string,
    workspaceId: string,
    projectsFolder: string,
    repositoryIds: string[],
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

    return {
        healthy: issues.length === 0,
        issues,
    };
}
