/**
 * Project Directives tab — Repo Parallelizer GUI.
 *
 * Project-wide agent directives: owner-defined single-paragraph rules that
 * paralizer renders into the generated AGENTS.md of every workspace of the
 * project. Rendered inside the "Directives" tab panel of `project-detail.js`.
 *
 * The list is fetched on its own (`api.projects.directives.list`) rather than
 * from the project payload, and the shared `directive-list-editor.js`
 * component re-reads it after each mutation, so this tab never forces a full
 * project-view re-render.
 *
 * @module project-directives
 */

import { api } from '../api.js';
import { buildDirectiveListEditor } from '../components/directive-list-editor.js';

/** Mirror of the server's `DIRECTIVE_MAX_LENGTH` (counter limit only; the server validates). */
export const DIRECTIVE_MAX_LENGTH = 1000;

/** Mirror of the server's `DIRECTIVES_MAX_COUNT`. */
export const DIRECTIVES_MAX_COUNT = 50;

/**
 * Build the Directives section for a project.
 *
 * @param {string} projectId
 * @returns {HTMLElement} The section; its list is filled in once loaded.
 */
export function buildProjectDirectivesSection(projectId) {
    const section = document.createElement('section');
    section.className = 'project-directives-section';

    const intro = document.createElement('p');
    intro.className = 'text-secondary directives-intro';
    intro.textContent =
        'Directives are rules written into the generated AGENTS.md of every workspace of this ' +
        'project, so agents entering a workspace follow them. Changes are re-rendered into all ' +
        'workspaces automatically. Workspace-specific directives are managed per workspace.';
    section.appendChild(intro);

    const body = document.createElement('div');
    body.className = 'directives-body';
    body.textContent = 'Loading directives…';
    section.appendChild(body);

    const reload = () => api.projects.directives.list(projectId);

    reload().then(
        (directives) => {
            body.replaceChildren(buildDirectiveListEditor({
                directives,
                maxLength: DIRECTIVE_MAX_LENGTH,
                maxCount: DIRECTIVES_MAX_COUNT,
                scopeLabel: 'project',
                onCreate: (text) => api.projects.directives.create(projectId, text),
                onUpdate: (id, text) => api.projects.directives.update(projectId, id, text),
                onDelete: (id) => api.projects.directives.remove(projectId, id),
                reload,
            }));
        },
        (err) => {
            const failure = document.createElement('p');
            failure.className = 'form-error';
            failure.setAttribute('role', 'alert');
            failure.textContent = (err && err.message) || 'Failed to load directives.';
            body.replaceChildren(failure);
        },
    );

    return section;
}
