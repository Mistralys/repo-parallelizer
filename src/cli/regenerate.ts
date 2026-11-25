/**
 * `paralizer regenerate` — re-renders the generated workspace artefacts
 * (`.code-workspace`, `README.md`, `AGENTS.md`, `CLAUDE.md`) without mutating
 * any stored project data, so existing workspaces pick up new generated text
 * after a Paralizer upgrade.
 *
 * Each workspace is regenerated independently through the artefact
 * choke-point (`WorkspaceArtifactsOrchestrator.regenerateWorkspace`); a
 * failure in one workspace is reported and does not stop the others.
 *
 * The command logic is dependency-injected ({@link RegenerateCliDeps}) so it
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

/** Collaborators of the command; replaced by fakes in tests. */
export interface RegenerateCliDeps {
    projectManager: Pick<ProjectManager, 'list' | 'getById'>;
    artifacts: Pick<WorkspaceArtifactsOrchestrator, 'regenerateWorkspace'>;
    /** Writes to standard output (no newline is appended). */
    out: (text: string) => void;
    /** Writes to standard error (no newline is appended). */
    err: (text: string) => void;
}

/** Help text for the `regenerate` command. */
export const REGENERATE_HELP = `Regenerate — re-render the generated workspace files without changing any data.

Usage:
  paralizer regenerate [<project-id>] [--workspace <ID>]

Regenerates the .code-workspace file, README.md, AGENTS.md and CLAUDE.md of
  - every workspace of every project (no arguments),
  - every workspace of one project (<project-id>), or
  - a single workspace (<project-id> --workspace <ID>).

Use it after upgrading paralizer so existing workspaces receive new generated text.
Text outside the generated markers is preserved. No stored project data is written.

Options:
  --workspace <ID>   Only regenerate this workspace (requires <project-id>)

Output: one line per workspace, "ok" or "failed: <message>".
Exit codes: 0 all ok, 1 usage error or unknown project/workspace, 2 a workspace failed.

Examples:
  paralizer regenerate
  paralizer regenerate my-project
  paralizer regenerate my-project --workspace DEV`;

/**
 * Runs one `regenerate` invocation.
 *
 * @param args - Arguments after `regenerate`.
 * @returns The process exit code; this function never throws for user errors.
 */
export async function runRegenerateCommand(args: string[], deps: RegenerateCliDeps): Promise<number> {
    try {
        if (['help', '--help', '-h'].includes(args[0])) {
            deps.out(`${REGENERATE_HELP}\n`);
            return EXIT_OK;
        }
        const { values, positionals } = parseCommandArgs(args, { workspace: { type: 'string' } });
        if (positionals.length > 1) {
            throw new UsageError('Usage: paralizer regenerate [<project-id>] [--workspace <ID>]');
        }
        const projectId = positionals[0];
        if (values.workspace !== undefined && projectId === undefined) {
            throw new UsageError('--workspace requires a <project-id>. Usage: paralizer regenerate [<project-id>] [--workspace <ID>]');
        }

        const targets = resolveTargets(projectId, values.workspace, deps);
        if (targets.length === 0) {
            deps.out('No workspaces to regenerate.\n');
            return EXIT_OK;
        }

        let failed = 0;
        for (const { projectId: pid, workspaceId } of targets) {
            try {
                deps.artifacts.regenerateWorkspace(pid, workspaceId);
                deps.out(`${pid}/${workspaceId}: ok\n`);
            } catch (err) {
                failed++;
                deps.out(`${pid}/${workspaceId}: failed: ${err instanceof Error ? err.message : String(err)}\n`);
            }
        }
        return failed > 0 ? EXIT_SYNC_FAILED : EXIT_OK;
    } catch (err) {
        deps.err(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
        return EXIT_ERROR;
    }
}

/**
 * Builds the real dependencies: loads `config.json`, instantiates the
 * managers and the artefact orchestrator (including `repositoryFileManager`,
 * so the "Repository Files" section is rendered), and wires the process streams.
 *
 * @throws {Error} If the config cannot be loaded.
 */
export function createDefaultRegenerateDeps(): RegenerateCliDeps {
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
// Private helpers
// ---------------------------------------------------------------------------

interface RegenerateTarget {
    projectId: string;
    workspaceId: string;
}

/**
 * Expands the command line into (project, workspace) pairs.
 *
 * @throws {Error} The named project or workspace does not exist.
 */
function resolveTargets(
    projectId: string | undefined,
    workspaceId: string | undefined,
    deps: RegenerateCliDeps,
): RegenerateTarget[] {
    const projectIds = projectId !== undefined ? [projectId] : deps.projectManager.list().map((p) => p.Id);
    const targets: RegenerateTarget[] = [];

    for (const pid of projectIds) {
        const project = deps.projectManager.getById(pid);
        if (!project) {
            throw new Error(`Project "${pid}" does not exist.`);
        }
        const ids = Object.keys(project.Workspaces);
        if (workspaceId !== undefined) {
            if (!ids.includes(workspaceId)) {
                throw new Error(`Workspace "${workspaceId}" does not exist in project "${pid}".`);
            }
            targets.push({ projectId: pid, workspaceId });
        } else {
            for (const id of ids) targets.push({ projectId: pid, workspaceId: id });
        }
    }
    return targets;
}
