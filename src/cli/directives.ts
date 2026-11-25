/**
 * `paralizer directives` — non-interactive management of agent directives
 * (project-wide and per workspace), so that agents and scripts can change them
 * without the GUI.
 *
 * Every mutation goes through `ProjectManager` (which validates and persists)
 * and then re-renders the generated workspace index files through the artefact
 * choke-point (`WorkspaceArtifactsOrchestrator`): a project-scope change
 * refreshes every workspace (`refreshProjectIndexes`), a workspace-scope change
 * only that workspace (`regenerateWorkspace`).
 *
 * The command logic is dependency-injected ({@link DirectivesCliDeps}) so it
 * can be tested without a config file, a TTY, or the real process streams.
 */
import { loadConfig } from '../config/config.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { RepositoryFileManager } from '../models/repository/repository-file.manager.js';
import { ProjectManager } from '../models/project/project.manager.js';
import { WorkspaceArtifactsOrchestrator } from '../orchestration/workspace-artifacts.js';
import { RepositoryInfoSyncOrchestrator } from '../orchestration/repository-info-sync.js';
import type { AgentDirective, DirectiveScope } from '../models/project/directive.js';
import {
    EXIT_OK,
    EXIT_ERROR,
    EXIT_SYNC_FAILED,
    UsageError,
    parseCommandArgs,
    requirePositionals,
    resolveFileReference,
    readStdin,
} from './file-command-helpers.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Exit codes returned by {@link runDirectivesCommand}. */
export { EXIT_OK, EXIT_ERROR, EXIT_SYNC_FAILED };

/** Collaborators of the command; replaced by fakes in tests. */
export interface DirectivesCliDeps {
    projectManager: Pick<
        ProjectManager,
        'listDirectives' | 'addDirective' | 'updateDirective' | 'removeDirective'
    >;
    artifacts: Pick<WorkspaceArtifactsOrchestrator, 'refreshProjectIndexes' | 'regenerateWorkspace'>;
    /** Reads all of standard input as UTF-8 text. */
    readStdin: () => Promise<string>;
    /** Writes to standard output (no newline is appended). */
    out: (text: string) => void;
    /** Writes to standard error (no newline is appended). */
    err: (text: string) => void;
}

/** Help text for the `directives` command group. */
export const DIRECTIVES_HELP = `Directives — owner-defined rules that paralizer renders into the generated AGENTS.md.

Usage:
  paralizer directives <subcommand> <project-id> [directive] [options]

Subcommands:
  list   <project-id>                List the directives of a scope
  add    <project-id>                Add a directive
  update <project-id> <directive>    Replace a directive's text
  delete <project-id> <directive>    Delete a directive
  help                               Show this help

<directive> is the directive's ID (a unique prefix of at least 4 characters is enough).
Use 'list' to see the IDs.

Options:
  --workspace <ID>   Act on the directives of this workspace only. Without it, the
                     command acts on the project-wide directives (all workspaces).
  --text <text>      The directive text (add / update)
  --stdin            Read the directive text from standard input (add / update)
  --json             Machine-readable output (list)

Notes:
  - A directive is a single paragraph (max 1000 characters; line breaks become spaces),
    unique within its scope; at most 50 per scope.
  - Every change is validated and then re-rendered into the generated AGENTS.md of the
    affected workspaces. Edit directives with this command, never inside a generated file.
  - Exit codes: 0 success, 1 error (nothing changed), 2 saved but workspace sync failed.

Examples:
  paralizer directives list my-project
  paralizer directives add my-project --text "Commit per repository; release dependency repositories first, then consumers."
  paralizer directives add my-project --workspace DEV --text "Never push from this workspace."
  paralizer directives update my-project 3f9a --text "New wording."
  paralizer directives delete my-project 3f9a --workspace DEV`;

/**
 * Runs one `directives` invocation.
 *
 * @param args - Arguments after `directives` (subcommand first).
 * @returns The process exit code; this function never throws for user errors.
 */
export async function runDirectivesCommand(args: string[], deps: DirectivesCliDeps): Promise<number> {
    const [subcommand, ...rest] = args;

    if (subcommand === undefined || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        deps.out(`${DIRECTIVES_HELP}\n`);
        return subcommand === undefined ? EXIT_ERROR : EXIT_OK;
    }

    try {
        switch (subcommand) {
            case 'list':
                return handleList(rest, deps);
            case 'add':
                return await handleAdd(rest, deps);
            case 'update':
                return await handleUpdate(rest, deps);
            case 'delete':
                return handleDelete(rest, deps);
            default:
                deps.err(`Unknown directives subcommand "${subcommand}". Run 'paralizer help' for usage.\n`);
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
export function createDefaultDirectivesDeps(): DirectivesCliDeps {
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
        readStdin,
        out: (text) => { process.stdout.write(text); },
        err: (text) => { process.stderr.write(text); },
    };
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

const SCOPE_OPTIONS = {
    workspace: { type: 'string' },
    text: { type: 'string' },
    stdin: { type: 'boolean' },
    json: { type: 'boolean' },
} as const;

function handleList(args: string[], deps: DirectivesCliDeps): number {
    const { values, positionals } = parseCommandArgs(args, SCOPE_OPTIONS);
    requirePositionals(positionals, 1, 'list <project-id> [--workspace <ID>] [--json]', 'directives');
    const scope = readScope(values.workspace);

    const directives = deps.projectManager.listDirectives(positionals[0], scope);
    if (values.json === true) {
        deps.out(`${JSON.stringify(directives, null, 2)}\n`);
        return EXIT_OK;
    }
    if (directives.length === 0) {
        deps.out(`No ${scopeLabel(scope)} directives.\n`);
        return EXIT_OK;
    }
    for (const directive of directives) {
        deps.out(`${directive.Id}\n    ${directive.Text}\n`);
    }
    return EXIT_OK;
}

async function handleAdd(args: string[], deps: DirectivesCliDeps): Promise<number> {
    const { values, positionals } = parseCommandArgs(args, SCOPE_OPTIONS);
    requirePositionals(positionals, 1, 'add <project-id> [--workspace <ID>] (--text <text> | --stdin)', 'directives');
    const projectId = positionals[0];
    const scope = readScope(values.workspace);

    const text = await readText(values, deps.readStdin);
    if (text === undefined) {
        throw new UsageError('add requires a text source: --text <text> or --stdin.');
    }

    const created = deps.projectManager.addDirective(projectId, scope, { Text: text });
    return report(deps, `Added ${scopeLabel(scope)} directive ${created.Id}.`, syncScope(deps, projectId, scope));
}

async function handleUpdate(args: string[], deps: DirectivesCliDeps): Promise<number> {
    const { values, positionals } = parseCommandArgs(args, SCOPE_OPTIONS);
    requirePositionals(positionals, 2, 'update <project-id> <directive> [--workspace <ID>] (--text <text> | --stdin)', 'directives');
    const projectId = positionals[0];
    const scope = readScope(values.workspace);

    const text = await readText(values, deps.readStdin);
    if (text === undefined) {
        throw new UsageError('update requires a text source: --text <text> or --stdin.');
    }

    const current = resolveDirective(deps.projectManager.listDirectives(projectId, scope), positionals[1], scope);
    const updated = deps.projectManager.updateDirective(projectId, scope, current.Id, { Text: text });
    return report(deps, `Updated ${scopeLabel(scope)} directive ${updated.Id}.`, syncScope(deps, projectId, scope));
}

function handleDelete(args: string[], deps: DirectivesCliDeps): number {
    const { positionals, values } = parseCommandArgs(args, SCOPE_OPTIONS);
    requirePositionals(positionals, 2, 'delete <project-id> <directive> [--workspace <ID>]', 'directives');
    const projectId = positionals[0];
    const scope = readScope(values.workspace);

    const current = resolveDirective(deps.projectManager.listDirectives(projectId, scope), positionals[1], scope);
    const removed = deps.projectManager.removeDirective(projectId, scope, current.Id);
    return report(deps, `Deleted ${scopeLabel(scope)} directive ${removed.Id}.`, syncScope(deps, projectId, scope));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Maps `--workspace` to a directive scope: absent means the project scope
 * (an explicit `{ kind: 'project' }`, since the manager has no default scope).
 *
 * @throws {UsageError} `--workspace` was given with an empty value.
 */
function readScope(workspace: string | undefined): DirectiveScope {
    if (workspace === undefined) return { kind: 'project' };
    if (workspace.trim() === '') {
        throw new UsageError('--workspace requires a workspace ID.');
    }
    return { kind: 'workspace', workspaceId: workspace.trim() };
}

function scopeLabel(scope: DirectiveScope): string {
    return scope.kind === 'project' ? 'project' : `workspace ${scope.workspaceId}`;
}

/**
 * Reads the directive text from `--text` or `--stdin`.
 *
 * @returns The raw text, or `undefined` when neither was given.
 * @throws {UsageError} Both were given.
 */
async function readText(
    values: { text?: string; stdin?: boolean },
    readStdinFn: () => Promise<string>,
): Promise<string | undefined> {
    if (values.text !== undefined && values.stdin === true) {
        throw new UsageError('Use only one of --text and --stdin.');
    }
    if (values.text !== undefined) return values.text;
    if (values.stdin === true) return readStdinFn();
    return undefined;
}

function resolveDirective(directives: readonly AgentDirective[], ref: string, scope: DirectiveScope): AgentDirective {
    const flag = scope.kind === 'workspace' ? ` --workspace ${scope.workspaceId}` : '';
    return resolveFileReference(directives, ref, {
        noun: 'directive',
        listHint: `paralizer directives list <project-id>${flag}`,
    });
}

/**
 * Re-renders the generated files affected by a change in `scope`.
 *
 * @returns A failure message, or `undefined` on success.
 */
function syncScope(deps: DirectivesCliDeps, projectId: string, scope: DirectiveScope): string | undefined {
    try {
        if (scope.kind === 'workspace') {
            deps.artifacts.regenerateWorkspace(projectId, scope.workspaceId);
            return undefined;
        }
        const result = deps.artifacts.refreshProjectIndexes(projectId);
        if (result.failed.length > 0) {
            return result.failed.map((f) => `workspace "${f.workspaceId}": ${f.error}`).join('; ');
        }
        return undefined;
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}

function report(deps: DirectivesCliDeps, message: string, syncFailure: string | undefined): number {
    if (syncFailure === undefined) {
        deps.out(`${message} Generated files are in sync.\n`);
        return EXIT_OK;
    }
    deps.out(`${message}\n`);
    deps.err(`Warning: the directive was saved, but syncing the workspaces failed: ${syncFailure}\n`);
    return EXIT_SYNC_FAILED;
}
