/**
 * Shared `WorkspaceIndexContext` fixtures used by the golden-baseline capture
 * script (`capture-golden.ts`) and the workspace-index output-stability tests.
 *
 * All values are fixed (including `generatedAt`) so renderer output is
 * deterministic.
 *
 * - A: minimal — two repositories, one-line notes.
 * - B: custom files and repository files present, project and workspace descriptions.
 * - C: hostile strings — pipes, newlines and backticks in names, descriptions and notes.
 */

import type { WorkspaceIndexContext, WorkspaceIndexSiblingRow } from '../../orchestration/workspace-index.js';

const COMMON = {
    projectsFolder: '/data/projects',
    toolVersion: '1.7.0',
    toolRoot: '/opt/paralizer',
    generatedAt: '2026-01-02T03:04:05.000Z',
    guiUrl: 'http://localhost:4200/#/projects/demo/workspaces/DEV',
} as const;

/** Fixture A: minimal, two repositories, one-line notes. */
export const CONTEXT_A: WorkspaceIndexContext = {
    ...COMMON,
    projectId: 'demo',
    projectName: 'Demo',
    projectDescription: '',
    workspaceId: 'DEV',
    workspaceDescription: '',
    workspaceNotes: 'Development workspace.',
    repositories: [
        { id: 'api', name: 'API', description: '', url: 'https://example.com/org/api.git' },
        { id: 'web', name: 'Web', description: '', url: 'https://example.com/org/web.git' },
    ],
};

/** Fixture B: custom files and repository files, with project and workspace descriptions. */
export const CONTEXT_B: WorkspaceIndexContext = {
    ...COMMON,
    projectId: 'demo',
    projectName: 'Demo Project',
    projectDescription: 'A demo project spanning several repositories.',
    workspaceId: 'DEV',
    workspaceDescription: 'Day-to-day development.',
    workspaceNotes: 'Use the wrapper scripts.\nRun the tests before pushing.',
    repositories: [
        { id: 'api', name: 'API', description: 'REST backend', url: 'https://example.com/org/api.git' },
        { id: 'web', name: 'Web', description: 'Frontend', url: 'https://example.com/org/web.git' },
        { id: 'docs', name: 'Docs', description: 'Documentation site', url: 'https://example.com/org/docs.git' },
    ],
    customFiles: [
        { path: 'scripts/build-all.sh', label: 'Build all', description: 'Builds every repository.' },
        { path: 'notes/rules.md', label: 'Rules', description: '' },
    ],
    repositoryFiles: [
        { repositoryId: 'api', path: 'run-api.sh', label: 'Run API', description: 'Starts the API locally.' },
        { repositoryId: 'web', path: 'lint.sh', label: 'Lint', description: '' },
    ],
};

/** Fixture C: hostile strings (pipes, newlines, backticks). */
export const CONTEXT_C: WorkspaceIndexContext = {
    ...COMMON,
    projectId: 'demo',
    projectName: 'Pipe | Project `x`',
    projectDescription: 'Line one\nLine two | with pipe and `code`',
    workspaceId: 'DEV',
    workspaceDescription: 'Desc | pipe\r\nsecond `line`',
    workspaceNotes: 'Note | pipe\n\n```\nfenced\n```\nTrailing `tick`',
    repositories: [
        {
            id: 'api',
            name: 'A|P|I `core`',
            description: 'Multi\nline | desc `x`',
            url: 'https://example.com/org/api.git?a=1|2',
        },
        { id: 'web', name: 'Web\nSite', description: '`tick` | pipe', url: 'https://example.com/org/web.git' },
    ],
    customFiles: [
        { path: 'scripts/a|b.sh', label: 'Pipe | label `x`', description: 'Line\nbreak | `tick`' },
    ],
    repositoryFiles: [
        { repositoryId: 'api', path: 'dir/c|d.sh', label: 'Hostile\nlabel `x`', description: 'a | b\nc `d`' },
    ],
};

/**
 * Sibling rows for a two-workspace project (`STABLE` + `DEV`, `DEV` current),
 * matching {@link COMMON}'s projects folder and project ID.
 */
const TWO_WORKSPACES: WorkspaceIndexSiblingRow[] = [
    {
        id: 'STABLE',
        relativePath: '../STABLE',
        absolutePath: '/data/projects/demo/STABLE',
        guiUrl: 'http://localhost:4200/#/projects/demo/workspaces/STABLE',
        isCurrent: false,
    },
    {
        id: 'DEV',
        relativePath: '../DEV',
        absolutePath: '/data/projects/demo/DEV',
        guiUrl: 'http://localhost:4200/#/projects/demo/workspaces/DEV',
        isCurrent: true,
    },
];

/** Fixture A with a second workspace. */
export const CONTEXT_A_TWO: WorkspaceIndexContext = { ...CONTEXT_A, siblingWorkspaces: TWO_WORKSPACES };

/** Fixture B with a second workspace. */
export const CONTEXT_B_TWO: WorkspaceIndexContext = { ...CONTEXT_B, siblingWorkspaces: TWO_WORKSPACES };

/** Fixture C with a second workspace. */
export const CONTEXT_C_TWO: WorkspaceIndexContext = { ...CONTEXT_C, siblingWorkspaces: TWO_WORKSPACES };
