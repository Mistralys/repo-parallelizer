/**
 * Repository role cell — inline click-to-edit "Role / relations" cell of the
 * project's repository table.
 *
 * Clicking the cell swaps the text for an input. The role is saved on blur or
 * Enter and cleared by saving empty text; Escape cancels the edit. The server
 * normalises the text (single paragraph, length-limited), so the value it
 * returns is what the cell displays afterwards.
 *
 * @module views/project-repository-roles
 */

import { api } from '../api.js';
import { showToast } from '../components/toast.js';

/** Mirrors REPOSITORY_ROLE_MAX_LENGTH on the server. */
export const REPOSITORY_ROLE_MAX_LENGTH = 500;

/** Placeholder shown while a repository has no role. */
export const ROLE_PLACEHOLDER = 'Add role…';

/**
 * Build the role table cell for one repository.
 *
 * @param {string} projectId
 * @param {string} repoId
 * @param {string} [initialRole] - Stored role text; empty or missing for none.
 * @returns {HTMLTableCellElement}
 */
export function buildRepositoryRoleCell(projectId, repoId, initialRole) {
    const cell = document.createElement('td');
    cell.className = 'repo-role-cell';

    let role = typeof initialRole === 'string' ? initialRole : '';

    function renderDisplay() {
        cell.innerHTML = '';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'repo-role-display' + (role === '' ? ' repo-role-display--empty' : '');
        btn.textContent = role === '' ? ROLE_PLACEHOLDER : role;
        btn.title = 'Click to edit the role / relations of this repository';
        btn.addEventListener('click', renderEditor);
        cell.appendChild(btn);
    }

    function renderEditor() {
        cell.innerHTML = '';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'repo-role-input';
        input.value = role;
        input.maxLength = REPOSITORY_ROLE_MAX_LENGTH;
        input.placeholder = 'e.g. Backend API; consumed by web-app';
        input.setAttribute('aria-label', `Role / relations of ${repoId}`);

        let settled = false;

        async function save() {
            if (settled) return;
            settled = true;
            const text = input.value.trim();

            if (text === role) {
                renderDisplay();
                return;
            }

            input.disabled = true;
            try {
                const res = await api.projects.setRepositoryRole(projectId, repoId, text);
                role = res && typeof res.role === 'string' ? res.role : text;
                renderDisplay();
            } catch (err) {
                showToast(err.message || 'Failed to save the repository role.', 'error');
                settled = false;
                input.disabled = false;
                input.focus();
            }
        }

        input.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') {
                ev.preventDefault();
                save();
            } else if (ev.key === 'Escape') {
                ev.preventDefault();
                settled = true;
                renderDisplay();
            }
        });
        input.addEventListener('blur', save);

        cell.appendChild(input);
        input.focus();
    }

    renderDisplay();
    return cell;
}
