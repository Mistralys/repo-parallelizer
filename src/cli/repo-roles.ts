/**
 * `paralizer repo-roles` — non-interactive management of the per-project
 * repository role texts (the "Role / relations" text rendered into the
 * generated workspace files), so that agents and scripts can change them
 * without the GUI.
 *
 * Every mutation goes through `ProjectManager` (which validates and persists)
 * and then re-renders the generated workspace index files of every workspace
 * through the artefact choke-point (`refreshProjectIndexes`), exactly like the
 * project-scope `custom-files` and `directives` commands.
 *
 * The command logic is dependency-injected ({@link RepoRolesCliDeps}) so it
 * can be tested without a config file, a TTY, or the real process streams.
 */
import { loadConfig } from '../config/config.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { RepositoryFileManager } from '../models/repository/repository-file.manager.js';
import { ProjectManager } from '../models/project/project.manager.js';
import { WorkspaceArtifactsOrchestrator } from '../orchestration/workspace-artifacts.js';
import { RepositoryInfoSyncOrchestrator } from '../orchestration/repository-info-sync.js';
import {
    EXIT_OK,
    EXIT_ERROR,
    EXIT_SYNC_FAILED,
    UsageError,
    parseCommandArgs,
} from './file-command-helpers.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Exit codes returned by {@link runRepoRolesCommand}. */
export { EXIT_OK, EXIT_ERROR, EXIT_SYNC_FAILED };

/** Collaborators of the command; replaced by fakes in tests. */
export interface RepoRolesCliDeps {
    projectManager: Pick<ProjectManager, 'getById' | 'getRepositoryRoles' | 'setRepositoryRole'>;
    artifacts: Pick<WorkspaceArtifactsOrchestrator, 'refreshProjectIndexes'>;
    /** Writes to standard output (no newline is appended). */
    out: (text: string) => void;
    /** Writes to standard error (no newline is appended). */
    err: (text: string) => void;
}

/** Help text for the `repo-roles` command group. */
export const REPO_ROLES_HELP = `Repository roles — an owner-defined "Role / relations" text per repository, stored \
on the project and rendered into the generated workspace files.

Usage:
  paralizer repo-roles <subcommand> <project-id> [repo-id] [options]

Subcommands:
  list  <project-id> [repo-id]          List the roles of the project's repositories
  set   <project-id> <repo-id>          Set or replace a repository's role (--text)
  clear <project-id> <repo-id>          Remove a repository's role
  help                                  Show this help

Options:
  --text <text>   The role text (set)
  --json          Machine-readable output (list)

Notes:
  - A role is a single paragraph (max 500 characters; line breaks become spaces).
  - The role belongs to the project: the same repository can have a different
    role in another project.
  - Every change is validated and then re-rendered into the generated files of
    all workspaces of the project. Edit roles with this command, never inside a
    generated file.
  - Exit codes: 0 success, 1 error (nothing changed), 2 saved but workspace sync failed.

Examples:
  paralizer repo-roles list my-project
  paralizer repo-roles set my-project my-repo --text "Shared library; release before the consumers."
  paralizer repo-roles clear my-project my-repo`;

/**
 * Runs one `repo-roles` invocation.
 *
 * @param args - Arguments after `repo-roles` (subcommand first).
 * @returns The process exit code; this function never throws for user errors.
 */
export async function runRepoRolesCommand(args: string[], deps: RepoRolesCliDeps): Promise<number> {
    const [subcommand, ...rest] = args;

    if (subcommand === undefined || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        deps.out(`${REPO_ROLES_HELP}\n`);
        return subcommand === undefined ? EXIT_ERROR : EXIT_OK;
    }

    try {
        switch (subcommand) {
            case 'list':
                return handleList(rest, deps);
            case 'set':
                return handleSet(rest, deps);
            case 'clear':
                return handleClear(rest, deps);
            default:
                deps.err(`Unknown repo-roles subcommand "${subcommand}". Run 'paralizer help' for usage.\n`);
                return EXIT_ERROR;
        }
    } catch (err) {
        deps.err(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        return EXIT_ERROR;
    }
}

/**
 * Builds the real dependencies: loads `config.json`, instantiates the
 * managers and the artefact orchestrator, and wires the process streams.
 *
 * @throws {Error} If the config cannot be loaded.
 */
export function createDefaultRepoRolesDeps(): RepoRolesCliDeps {
    const config = loadConfig();
    const repoManager = new RepositoryManager(config);
    const repositoryFileManager = new RepositoryFileManager(config, repoManager);
    const projectManager = new ProjectManager(config, repoManager);
    const repositoryInfoSync = new RepositoryInfoSyncOrchestrator(config, repoManager, repositoryFileManager);
    const artifacts = new WorkspaceArtifactsOrchestrator(
        config, projectManager, repoManager, repositoryInfoSync, undefined, repositoryFileManager,
    );
    return {
        projectManager,
        artifacts,
        out: (text) => { process.stdout.write(text); },
        err: (text) => { process.stderr.write(text); },
    };
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

const OPTIONS = {
    text: { type: 'string' },
    json: { type: 'boolean' },
} as const;

function handleList(args: string[], deps: RepoRolesCliDeps): number {
    const { values, positionals } = parseCommandArgs(args, OPTIONS);
    if (positionals.length < 1 || positionals.length > 2) {
        throw new UsageError('Usage: paralizer repo-roles list <project-id> [repo-id] [--json]');
    }
    const [projectId, repoId] = positionals;
    const repositories = requireProject(deps, projectId);
    if (repoId !== undefined) requireListed(repositories, projectId, repoId);

    const roles = deps.projectManager.getRepositoryRoles(projectId);
    const shown = repoId === undefined ? repositories : [repoId];
    const entries = shown.map((id) => ({ repositoryId: id, role: roles[id] ?? '' }));

    if (values.json === true) {
        deps.out(`${JSON.stringify(entries, null, 2)}\n`);
        return EXIT_OK;
    }
    if (entries.length === 0) {
        deps.out('No repositories.\n');
        return EXIT_OK;
    }
    for (const entry of entries) {
        deps.out(`${entry.repositoryId}\n    ${entry.role === '' ? '(no role)' : entry.role}\n`);
    }
    return EXIT_OK;
}

function handleSet(args: string[], deps: RepoRolesCliDeps): number {
    const { values, positionals } = parseCommandArgs(args, OPTIONS);
    if (positionals.length !== 2) {
        throw new UsageError('Usage: paralizer repo-roles set <project-id> <repo-id> --text <text>');
    }
    const [projectId, repoId] = positionals;
    if (values.text === undefined || values.text.trim() === '') {
        throw new UsageError("set requires a non-empty --text <text> (use 'clear' to remove a role).");
    }
    requireListed(requireProject(deps, projectId), projectId, repoId);

    deps.projectManager.setRepositoryRole(projectId, repoId, values.text);
    return report(deps, `Set the role of repository "${repoId}".`, syncProject(deps, projectId));
}

function handleClear(args: string[], deps: RepoRolesCliDeps): number {
    const { positionals } = parseCommandArgs(args, OPTIONS);
    if (positionals.length !== 2) {
        throw new UsageError('Usage: paralizer repo-roles clear <project-id> <repo-id>');
    }
    const [projectId, repoId] = positionals;
    requireListed(requireProject(deps, projectId), projectId, repoId);

    deps.projectManager.setRepositoryRole(projectId, repoId, '');
    return report(deps, `Cleared the role of repository "${repoId}".`, syncProject(deps, projectId));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * @returns The project's repository IDs.
 * @throws {Error} The project does not exist.
 */
function requireProject(deps: RepoRolesCliDeps, projectId: string): string[] {
    const project = deps.projectManager.getById(projectId);
    if (!project) {
        throw new Error(`Project "${projectId}" does not exist.`);
    }
    return project.Repositories;
}

/** @throws {Error} The repository is not listed in the project. */
function requireListed(repositories: readonly string[], projectId: string, repoId: string): void {
    if (!repositories.includes(repoId)) {
        throw new Error(`Repository "${repoId}" is not listed in project "${projectId}".`);
    }
}

/**
 * Re-renders the generated files of every workspace of the project.
 *
 * @returns A failure message, or `undefined` on success.
 */
function syncProject(deps: RepoRolesCliDeps, projectId: string): string | undefined {
    try {
        const result = deps.artifacts.refreshProjectIndexes(projectId);
        if (result.failed.length > 0) {
            return result.failed.map((f) => `workspace "${f.workspaceId}": ${f.error}`).join('; ');
        }
        return undefined;
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}

function report(deps: RepoRolesCliDeps, message: string, syncFailure: string | undefined): number {
    if (syncFailure === undefined) {
        deps.out(`${message} Generated files are in sync.\n`);
        return EXIT_OK;
    }
    deps.out(`${message}\n`);
    deps.err(`Warning: the role was saved, but syncing the workspaces failed: ${syncFailure}\n`);
    return EXIT_SYNC_FAILED;
}
