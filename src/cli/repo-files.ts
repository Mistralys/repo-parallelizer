/**
 * `paralizer repo-files` — non-interactive management of a repository's
 * files (Milestone 2), so that agents (and scripts) can change them without
 * the GUI.
 *
 * Every mutation goes through the same code path as the REST API:
 * `RepositoryFileManager` validates and persists the definition, then the
 * artefact choke-point (`WorkspaceArtifactsOrchestrator.regenerateForRepository()`)
 * updates the repository's managed clone. Unlike `custom-files`, this
 * command group never commits or pushes — publishing a change still
 * requires Commit & Push in the Paralizer GUI.
 *
 * Every mutation first requires info sync to be enabled for the repository
 * (`RepositoryInfoSyncOrchestrator.assertSyncEnabled()`); `list`/`show` work
 * regardless.
 *
 * The command logic is dependency-injected ({@link RepoFilesCliDeps}) so it
 * can be tested without a config file, a TTY, or the real process streams.
 */
import { loadConfig } from '../config/config.js';
import { RepositoryManager } from '../models/repository/repository.manager.js';
import { RepositoryFileManager } from '../models/repository/repository-file.manager.js';
import { ProjectManager } from '../models/project/project.manager.js';
import { WorkspaceArtifactsOrchestrator } from '../orchestration/workspace-artifacts.js';
import { RepositoryInfoSyncOrchestrator } from '../orchestration/repository-info-sync.js';
import {
    repositoryFileRelativePath,
    type RepositoryFile,
    type RepositoryFileInput,
} from '../models/repository/repository-file.js';
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

/** Exit codes returned by {@link runRepoFilesCommand}. */
export { EXIT_OK, EXIT_ERROR, EXIT_SYNC_FAILED };

/** Collaborators of the command; replaced by fakes in tests. */
export interface RepoFilesCliDeps {
    fileManager: Pick<RepositoryFileManager, 'list' | 'add' | 'update' | 'remove'>;
    infoSync: Pick<RepositoryInfoSyncOrchestrator, 'assertSyncEnabled'>;
    artifacts: Pick<WorkspaceArtifactsOrchestrator, 'regenerateForRepository'>;
    /** Reads all of standard input as UTF-8 text. */
    readStdin: () => Promise<string>;
    /** Writes to standard output (no newline is appended). */
    out: (text: string) => void;
    /** Writes to standard error (no newline is appended). */
    err: (text: string) => void;
}

/** Help text for the `repo-files` command group. */
export const REPO_FILES_HELP = `Repository files — small per-repository files (e.g. wrapper scripts) that \
Paralizer syncs through git into the repository's \`.workspace/files/\` folder.

Usage:
  paralizer repo-files <subcommand> --repo <repo-id> [file] [options]

Subcommands:
  list   --repo <repo-id>           List the repository's files
  show   --repo <repo-id> <file>    Print a file's content to stdout (--json: full definition)
  add    --repo <repo-id>           Create a repository file
  update --repo <repo-id> <file>    Change a repository file; only the given options are changed
  delete --repo <repo-id> <file>    Delete a repository file
  help                              Show this help

<file> is the file's ID (a unique prefix of at least 4 characters is enough) or its
\`.workspace/files/\`-relative path, e.g. scripts/deploy.sh. Use 'list' to see both.

Options for add / update:
  --file-name <name>        File name incl. extension (add: required)
  --label <text>            Short human-readable label (add: required)
  --directory <dir>         Folder relative to the \`.workspace/files/\` folder (default: the root)
  --description <text>      What the file is for
  --list-in-agents          List the file in the generated workspace AGENTS.md
  --no-list-in-agents       Do not list it (update only)
  --executable              Mark the file as executable (committed with mode 755)
  --no-executable           Do not mark it (update only)
  --content-file <path>     Read the content from a file ('-' reads standard input)
  --stdin                   Read the content from standard input
  --content <text>          Use the given text as content
  (add requires exactly one content source; update changes the content only when one is given)

Options for list / show:
  --json                    Machine-readable output

Notes:
  - Info sync must be enabled for the repository (see the Paralizer GUI) before
    add/update/delete; list/show work regardless.
  - Every change is saved, then the repository's managed clone is updated —
    but this command never commits or pushes. Commit & Push in the Paralizer
    GUI to publish the change.
  - Content is UTF-8 text, max 256 KB.
  - Exit codes: 0 success, 1 error (nothing changed), 2 saved but updating the managed clone failed.

Examples:
  paralizer repo-files list --repo my-repo
  paralizer repo-files show --repo my-repo scripts/deploy.sh > /tmp/deploy.sh
  paralizer repo-files update --repo my-repo scripts/deploy.sh --content-file ./deploy.sh
  paralizer repo-files add --repo my-repo --directory scripts --file-name build.sh \\
      --label "Build script" --executable --content-file ./build.sh
  paralizer repo-files delete --repo my-repo scripts/build.sh`;

/**
 * Runs one `repo-files` invocation.
 *
 * @param args - Arguments after `repo-files` (subcommand first).
 * @returns The process exit code; this function never throws for user errors.
 */
export async function runRepoFilesCommand(args: string[], deps: RepoFilesCliDeps): Promise<number> {
    const [subcommand, ...rest] = args;

    if (subcommand === undefined || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        deps.out(`${REPO_FILES_HELP}\n`);
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
                deps.err(`Unknown repo-files subcommand "${subcommand}". Run 'paralizer help' for usage.\n`);
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
export function createDefaultRepoFilesDeps(): RepoFilesCliDeps {
    const config = loadConfig();
    const repoManager = new RepositoryManager(config);
    const fileManager = new RepositoryFileManager(config, repoManager);
    const projectManager = new ProjectManager(config, repoManager);
    const infoSync = new RepositoryInfoSyncOrchestrator(config, repoManager, fileManager);
    const artifacts = new WorkspaceArtifactsOrchestrator(
        config, projectManager, repoManager, infoSync, undefined, fileManager,
    );
    return {
        fileManager,
        infoSync,
        artifacts,
        readStdin,
        out: (text) => { process.stdout.write(text); },
        err: (text) => { process.stderr.write(text); },
    };
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

/** `add`/`update` field options, extending the shared set with the executable flag pair. */
const REPO_FILE_OPTIONS = {
    ...FILE_FIELD_OPTIONS,
    executable: { type: 'boolean' },
    'no-executable': { type: 'boolean' },
} as const;

/** Requires `--repo <repo-id>` and returns its (non-empty) value. */
function requireRepoId(values: { repo?: string }): string {
    if (values.repo === undefined || values.repo.trim() === '') {
        throw new UsageError('--repo <repo-id> is required.');
    }
    return values.repo;
}

/** Resolves a repository-file reference within `files`, with scope-specific messages. */
function resolveRepoFile(files: readonly RepositoryFile[], ref: string): RepositoryFile {
    return resolveFileReference(files, ref, {
        relativePath: repositoryFileRelativePath,
        noun: 'repository file',
        listHint: 'paralizer repo-files list --repo <repo-id>',
    });
}

function handleList(args: string[], deps: RepoFilesCliDeps): number {
    const { values, positionals } = parseCommandArgs(args, { repo: { type: 'string' }, json: { type: 'boolean' } });
    requirePositionals(positionals, 0, 'list --repo <repo-id> [--json]', 'repo-files');
    const repoId = requireRepoId(values);

    const files = deps.fileManager.list(repoId);
    if (values.json === true) {
        deps.out(`${JSON.stringify(files, null, 2)}\n`);
        return EXIT_OK;
    }
    if (files.length === 0) {
        deps.out('No repository files.\n');
        return EXIT_OK;
    }
    for (const file of files) {
        const flags: string[] = [];
        if (file.Executable) flags.push('executable');
        if (file.ListInAgents) flags.push('listed in AGENTS.md');
        const flagsText = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
        deps.out(`${repositoryFileRelativePath(file)}\n    id: ${file.Id}\n    label: ${file.Label}${flagsText}\n`);
        if (file.Description !== '') deps.out(`    description: ${file.Description}\n`);
    }
    return EXIT_OK;
}

function handleShow(args: string[], deps: RepoFilesCliDeps): number {
    const { values, positionals } = parseCommandArgs(args, { repo: { type: 'string' }, json: { type: 'boolean' } });
    requirePositionals(positionals, 1, 'show --repo <repo-id> <file> [--json]', 'repo-files');
    const repoId = requireRepoId(values);

    const file = resolveRepoFile(deps.fileManager.list(repoId), positionals[0]);
    deps.out(values.json === true ? `${JSON.stringify(file, null, 2)}\n` : file.Content);
    return EXIT_OK;
}

async function handleAdd(args: string[], deps: RepoFilesCliDeps): Promise<number> {
    const { values, positionals } = parseCommandArgs(args, { repo: { type: 'string' }, ...REPO_FILE_OPTIONS });
    requirePositionals(
        positionals, 0,
        'add --repo <repo-id> --file-name <name> --label <text> (--content-file <path> | --stdin | --content <text>)',
        'repo-files',
    );
    const repoId = requireRepoId(values);
    deps.infoSync.assertSyncEnabled(repoId);

    if (values['file-name'] === undefined || values.label === undefined) {
        throw new UsageError('add requires --file-name and --label.');
    }
    const content = await readContentSource(values, deps.readStdin);
    if (content === undefined) {
        throw new UsageError('add requires a content source: --content-file <path>, --stdin or --content <text>.');
    }
    const listFlag = readFlagPair(values, 'list-in-agents');
    const execFlag = readFlagPair(values, 'executable');

    const input: RepositoryFileInput = {
        Directory: values.directory ?? '',
        FileName: values['file-name'],
        Label: values.label,
        Description: values.description ?? '',
        Content: content,
        ListInAgents: listFlag === true,
    };
    if (execFlag !== undefined) {
        input.Executable = execFlag;
    }

    const created = deps.fileManager.add(repoId, input);

    const syncFailure = regenerate(deps, repoId);
    return report(deps, `Created ${describe(created)}.`, syncFailure);
}

async function handleUpdate(args: string[], deps: RepoFilesCliDeps): Promise<number> {
    const { values, positionals } = parseCommandArgs(args, { repo: { type: 'string' }, ...REPO_FILE_OPTIONS });
    requirePositionals(positionals, 1, 'update --repo <repo-id> <file> [options]', 'repo-files');
    const repoId = requireRepoId(values);
    deps.infoSync.assertSyncEnabled(repoId);

    const current = resolveRepoFile(deps.fileManager.list(repoId), positionals[0]);
    const content = await readContentSource(values, deps.readStdin);
    const listFlag = readFlagPair(values, 'list-in-agents');
    const execFlag = readFlagPair(values, 'executable');

    const input: RepositoryFileInput = {
        Directory: values.directory ?? current.Directory,
        FileName: values['file-name'] ?? current.FileName,
        Label: values.label ?? current.Label,
        Description: values.description ?? current.Description,
        Content: content ?? current.Content,
        Executable: execFlag ?? current.Executable,
        ListInAgents: listFlag ?? current.ListInAgents,
    };

    const { updated } = deps.fileManager.update(repoId, current.Id, input);

    const syncFailure = regenerate(deps, repoId);
    return report(deps, `Updated ${describe(updated)}.`, syncFailure);
}

function handleDelete(args: string[], deps: RepoFilesCliDeps): number {
    const { values, positionals } = parseCommandArgs(args, { repo: { type: 'string' } });
    requirePositionals(positionals, 1, 'delete --repo <repo-id> <file>', 'repo-files');
    const repoId = requireRepoId(values);
    deps.infoSync.assertSyncEnabled(repoId);

    const file = resolveRepoFile(deps.fileManager.list(repoId), positionals[0]);
    const removed = deps.fileManager.remove(repoId, file.Id);

    const syncFailure = regenerate(deps, repoId);
    return report(deps, `Deleted ${repositoryFileRelativePath(removed)} (id: ${removed.Id}).`, syncFailure);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Updates the repository's managed clone after a mutation (mirrors the REST
 * handlers' artefact choke-point call). Never commits or pushes.
 *
 * @returns A failure message, or `undefined` on success.
 */
function regenerate(deps: RepoFilesCliDeps, repositoryId: string): string | undefined {
    try {
        deps.artifacts.regenerateForRepository(repositoryId);
        return undefined;
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}

function describe(file: RepositoryFile): string {
    const exec = file.Executable ? ', executable' : '';
    return `${repositoryFileRelativePath(file)} (id: ${file.Id}${exec})`;
}

function report(deps: RepoFilesCliDeps, message: string, syncFailure: string | undefined): number {
    if (syncFailure === undefined) {
        deps.out(`${message} Commit & Push in the Paralizer GUI to publish.\n`);
        return EXIT_OK;
    }
    deps.out(`${message}\n`);
    deps.err(`Warning: the definition was saved, but updating the managed clone failed: ${syncFailure}\n`);
    return EXIT_SYNC_FAILED;
}
