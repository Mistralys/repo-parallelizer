/**
 * Workspace directives section — Repo Parallelizer GUI.
 *
 * Workspace-specific agent directives: owner-defined single-paragraph rules
 * that paralizer renders into the generated AGENTS.md of this one workspace
 * (project-wide directives are managed on the project page). Mounted by
 * `workspace-detail.js` below the Notes section.
 *
 * The list is fetched on its own (`api.workspaces.directives.list`) and the
 * shared `directive-list-editor.js` component re-reads it after each
 * mutation, so the host view never re-renders.
 *
 * @module workspace-directives
 */

import { api } from '../api.js';
import { buildDirectiveListEditor } from '../components/directive-list-editor.js';
import { DIRECTIVE_MAX_LENGTH, DIRECTIVES_MAX_COUNT } from './project-directives.js';

/**
 * Build the "Workspace directives" section.
 *
 * @param {string} projectId
 * @param {string} wid - Workspace ID.
 * @returns {HTMLElement} The section; its list is filled in once loaded.
 */
export function buildWorkspaceDirectivesSection(projectId, wid) {
    const section = document.createElement('section');
    section.className = 'workspace-directives-section';

    const heading = document.createElement('h3');
    heading.className = 'workspace-directives-heading';
    heading.textContent = 'Workspace directives';
    section.appendChild(heading);

    const intro = document.createElement('p');
    intro.className = 'text-secondary directives-intro';
    intro.textContent =
        'Directives are rules written into the generated AGENTS.md of this workspace only, ' +
        'so agents entering it follow them. Project-wide directives are managed on the project page.';
    section.appendChild(intro);

    const body = document.createElement('div');
    body.className = 'directives-body';
    body.textContent = 'Loading directives…';
    section.appendChild(body);

    const reload = () => api.workspaces.directives.list(projectId, wid);

    reload().then(
        (directives) => {
            body.replaceChildren(buildDirectiveListEditor({
                directives,
                maxLength: DIRECTIVE_MAX_LENGTH,
                maxCount: DIRECTIVES_MAX_COUNT,
                scopeLabel: 'workspace',
                onCreate: (text) => api.workspaces.directives.create(projectId, wid, text),
                onUpdate: (id, text) => api.workspaces.directives.update(projectId, wid, id, text),
                onDelete: (id) => api.workspaces.directives.remove(projectId, wid, id),
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
