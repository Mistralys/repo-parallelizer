/**
 * `paralizer custom-files` — non-interactive management of a project's custom
 * files, so that agents (and scripts) can change them without the GUI.
 *
 * Every mutation goes through the same code path as the REST API:
 * `ProjectManager` validates and persists the definition, then the artefact
 * choke-point (`WorkspaceArtifactsOrchestrator`) syncs all workspaces. A
 * moved/renamed file has its previous copies removed first, exactly like
 * `PUT /api/projects/:id/custom-files/:fileId`.
 *
 * The command logic is dependency-injected ({@link CustomFilesCliDeps}) so it
 * can be tested without a config file, a TTY, or the real process streams.
 */
import { loadConfig } from '../config/config.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { RepositoryFileManager } from '../models/repository/repository-file.manager.js';
import { ProjectManager } from '../models/project/project.manager.js';
import { WorkspaceArtifactsOrchestrator } from '../orchestration/workspace-artifacts.js';
import { RepositoryInfoSyncOrchestrator } from '../orchestration/repository-info-sync.js';
import {
    customFileRelativePath,
    isExecutableFile,
    type CustomFile,
    type CustomFileInput,
} from '../models/project/custom-file.js';
import {
    EXIT_OK,
    EXIT_ERROR,
    EXIT_SYNC_FAILED,
    UsageError,
    parseCommandArgs,
    requirePositionals,
    FILE_FIELD_OPTIONS,
    readContentSource,
    readFlagPair,
    resolveFileReference,
    readStdin,
} from './file-command-helpers.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Exit codes returned by {@link runCustomFilesCommand}. */
export { EXIT_OK, EXIT_ERROR, EXIT_SYNC_FAILED };

/** Collaborators of the command; replaced by fakes in tests. */
export interface CustomFilesCliDeps {
    projectManager: Pick<
        ProjectManager,
        'listCustomFiles' | 'addCustomFile' | 'updateCustomFile' | 'removeCustomFile'
    >;
    artifacts: Pick<WorkspaceArtifactsOrchestrator, 'regenerateProject' | 'removeCustomFileCopies'>;
    /** Reads all of standard input as UTF-8 text. */
    readStdin: () => Promise<string>;
    /** Writes to standard output (no newline is appended). */
    out: (text: string) => void;
    /** Writes to standard error (no newline is appended). */
    err: (text: string) => void;
}

/** Help text for the `custom-files` command group. */
export const CUSTOM_FILES_HELP = `Custom files — project files that paralizer copies into every workspace.

Usage:
  paralizer custom-files <subcommand> <project-id> [file] [options]

Subcommands:
  list   <project-id>           List the project's custom files
  show   <project-id> <file>    Print a file's content to stdout (--json: full definition)
  add    <project-id>           Create a custom file
  update <project-id> <file>    Change a custom file; only the given options are changed
  delete <project-id> <file>    Delete a custom file and its copies in all workspaces
  help                          Show this help

<file> is the file's ID (a unique prefix of at least 4 characters is enough) or its
workspace-relative path, e.g. scripts/deploy.sh. Use 'list' to see both.

Options for add / update:
  --file-name <name>        File name incl. extension (add: required)
  --label <text>            Short human-readable label (add: required)
  --directory <dir>         Folder relative to the workspace root (default: the root)
  --description <text>      What the file is for
  --list-in-agents          List the file in the generated workspace AGENTS.md
  --no-list-in-agents       Do not list it (update only)
  --content-file <path>     Read the content from a file ('-' reads standard input)
  --stdin                   Read the content from standard input
  --content <text>          Use the given text as content
  (add requires exactly one content source; update changes the content only when one is given)

Options for list / show:
  --json                    Machine-readable output

Notes:
  - Every change is validated and then synced to all workspaces of the project.
    Workspace copies are overwritten on each sync: edit the definition with this
    command, never the copy inside a workspace.
  - Moving or renaming a file (update --directory / --file-name) removes the old copies.
  - Content is UTF-8 text, max 256 KB. Shell scripts become executable automatically.
  - Exit codes: 0 success, 1 error (nothing changed), 2 saved but workspace sync failed.

Examples:
  paralizer custom-files list my-project
  paralizer custom-files show my-project scripts/deploy.sh > /tmp/deploy.sh
  paralizer custom-files update my-project scripts/deploy.sh --content-file ./deploy.sh
  paralizer custom-files add my-project --directory scripts --file-name build.sh \\
      --label "Build script" --list-in-agents --content-file ./build.sh
  paralizer custom-files delete my-project scripts/build.sh`;

/**
 * Runs one `custom-files` invocation.
 *
 * @param args - Arguments after `custom-files` (subcommand first).
 * @returns The process exit code; this function never throws for user errors.
 */
export async function runCustomFilesCommand(args: string[], deps: CustomFilesCliDeps): Promise<number> {
    const [subcommand, ...rest] = args;

    if (subcommand === undefined || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        deps.out(`${CUSTOM_FILES_HELP}\n`);
        return subcommand === undefined ? EXIT_ERROR : EXIT_OK;
    }

    try {
        switch (subcommand) {
            case 'list':
                return handleList(rest, deps);
            case 'show':
                return handleShow(rest, deps);
            case 'add':
                return await handleAdd(rest, deps);
            case 'update':
                return await handleUpdate(rest, deps);
            case 'delete':
                return handleDelete(rest, deps);
            default:
                deps.err(`Unknown custom-files subcommand "${subcommand}". Run 'paralizer help' for usage.\n`);
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
export function createDefaultCustomFilesDeps(): CustomFilesCliDeps {
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

function handleList(args: string[], deps: CustomFilesCliDeps): number {
    const { values, positionals } = parseCommandArgs(args, { json: { type: 'boolean' } });
    requirePositionals(positionals, 1, 'list <project-id> [--json]', 'custom-files');

    const files = deps.projectManager.listCustomFiles(positionals[0]);
    if (values.json === true) {
        deps.out(`${JSON.stringify(files, null, 2)}\n`);
        return EXIT_OK;
    }
    if (files.length === 0) {
        deps.out('No custom files.\n');
        return EXIT_OK;
    }
    for (const file of files) {
        const flags = file.ListInAgents ? ' [listed in AGENTS.md]' : '';
        deps.out(`${customFileRelativePath(file)}\n    id: ${file.Id}\n    label: ${file.Label}${flags}\n`);
        if (file.Description !== '') deps.out(`    description: ${file.Description}\n`);
    }
    return EXIT_OK;
}

/** Resolves a custom-file reference within `files`, with scope-specific messages. */
function resolveCustomFile(files: readonly CustomFile[], ref: string): CustomFile {
    return resolveFileReference(files, ref, {
        relativePath: customFileRelativePath,
        noun: 'custom file',
        listHint: 'paralizer custom-files list <project-id>',
    });
}

function handleShow(args: string[], deps: CustomFilesCliDeps): number {
    const { values, positionals } = parseCommandArgs(args, { json: { type: 'boolean' } });
    requirePositionals(positionals, 2, 'show <project-id> <file> [--json]', 'custom-files');

    const file = resolveCustomFile(deps.projectManager.listCustomFiles(positionals[0]), positionals[1]);
    deps.out(values.json === true ? `${JSON.stringify(file, null, 2)}\n` : file.Content);
    return EXIT_OK;
}

async function handleAdd(args: string[], deps: CustomFilesCliDeps): Promise<number> {
    const { values, positionals } = parseCommandArgs(args, FILE_FIELD_OPTIONS);
    requirePositionals(
        positionals, 1,
        'add <project-id> --file-name <name> --label <text> (--content-file <path> | --stdin | --content <text>)',
        'custom-files',
    );
    const projectId = positionals[0];

    if (values['file-name'] === undefined || values.label === undefined) {
        throw new UsageError('add requires --file-name and --label.');
    }
    const content = await readContentSource(values, deps.readStdin);
    if (content === undefined) {
        throw new UsageError('add requires a content source: --content-file <path>, --stdin or --content <text>.');
    }
    const listFlag = readFlagPair(values, 'list-in-agents');

    const created = deps.projectManager.addCustomFile(projectId, {
        Directory: values.directory ?? '',
        FileName: values['file-name'],
        Label: values.label,
        Description: values.description ?? '',
        Content: content,
        ListInAgents: listFlag === true,
    });

    const syncFailure = syncProject(deps, projectId, undefined);
    return report(deps, `Created ${describe(created)}.`, syncFailure);
}

async function handleUpdate(args: string[], deps: CustomFilesCliDeps): Promise<number> {
    const { values, positionals } = parseCommandArgs(args, FILE_FIELD_OPTIONS);
    requirePositionals(positionals, 2, 'update <project-id> <file> [options]', 'custom-files');
    const projectId = positionals[0];

    const current = resolveCustomFile(deps.projectManager.listCustomFiles(projectId), positionals[1]);
    const content = await readContentSource(values, deps.readStdin);
    const listFlag = readFlagPair(values, 'list-in-agents');

    const input: CustomFileInput = {
        Directory: values.directory ?? current.Directory,
        FileName: values['file-name'] ?? current.FileName,
        Label: values.label ?? current.Label,
        Description: values.description ?? current.Description,
        Content: content ?? current.Content,
        ListInAgents: listFlag ?? current.ListInAgents,
    };

    const { previous, updated } = deps.projectManager.updateCustomFile(projectId, current.Id, input);
    const moved = previous.Directory !== updated.Directory || previous.FileName !== updated.FileName;

    const syncFailure = syncProject(deps, projectId, moved ? previous : undefined);
    return report(deps, `Updated ${describe(updated)}.`, syncFailure);
}

function handleDelete(args: string[], deps: CustomFilesCliDeps): number {
    const { positionals } = parseCommandArgs(args, {});
    requirePositionals(positionals, 2, 'delete <project-id> <file>', 'custom-files');
    const projectId = positionals[0];

    const file = resolveCustomFile(deps.projectManager.listCustomFiles(projectId), positionals[1]);
    const removed = deps.projectManager.removeCustomFile(projectId, file.Id);

    let syncFailure: string | undefined;
    try {
        deps.artifacts.removeCustomFileCopies(projectId, removed);
        deps.artifacts.regenerateProject(projectId);
    } catch (err) {
        syncFailure = err instanceof Error ? err.message : String(err);
    }
    return report(deps, `Deleted ${customFileRelativePath(removed)} (id: ${removed.Id}).`, syncFailure);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Syncs all workspaces after a mutation (mirrors the REST handlers).
 *
 * @param previous - Previous definition to purge first, when the file moved.
 * @returns A failure message, or `undefined` on success.
 */
function syncProject(deps: CustomFilesCliDeps, projectId: string, previous: CustomFile | undefined): string | undefined {
    try {
        if (previous !== undefined) deps.artifacts.removeCustomFileCopies(projectId, previous);
        deps.artifacts.regenerateProject(projectId);
        return undefined;
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}

function describe(file: CustomFile): string {
    const exec = isExecutableFile(file.FileName, file.Content) ? ', executable' : '';
    return `${customFileRelativePath(file)} (id: ${file.Id}${exec})`;
}

function report(deps: CustomFilesCliDeps, message: string, syncFailure: string | undefined): number {
    if (syncFailure === undefined) {
        deps.out(`${message} All workspaces are in sync.\n`);
        return EXIT_OK;
    }
    deps.out(`${message}\n`);
    deps.err(`Warning: the definition was saved, but syncing the workspaces failed: ${syncFailure}\n`);
    return EXIT_SYNC_FAILED;
}
