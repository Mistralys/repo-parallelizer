/**
 * Directive List Editor — shared GUI building block.
 *
 * Renders an ordered list of agent directives (single-paragraph rules that
 * paralizer writes into the generated AGENTS.md) with inline add, edit and
 * delete. It is used by the project "Directives" tab and is deliberately
 * scope-agnostic: the calling view decides which API namespace the callbacks
 * talk to (project-wide or workspace-scoped), so the same component serves
 * both.
 *
 * Behaviour:
 *   - A character counter under the textarea (`n / max`).
 *   - A rejected save/delete shows the server's message inline, next to the
 *     control that caused it (`role="alert"`); the editor stays open.
 *   - Delete asks for confirmation through `confirm-dialog.js`.
 *   - Success and failure of deletes are also announced through `toast.js`.
 *   - After every successful mutation the list is re-read through `reload()`
 *     and re-rendered in place; the host view does not need to re-render.
 *
 * The server is authoritative for validation (length, duplicates, count,
 * generated-marker text); the form only blocks empty text.
 *
 * @module directive-list-editor
 */

import { showToast } from './toast.js';
import { showConfirm } from './confirm-dialog.js';

/**
 * @typedef {Object} DirectiveListEditorOptions
 * @property {Array<{ Id: string, Text: string }>} directives - Initial list (PascalCase API shape).
 * @property {number} maxLength - Maximum directive length in characters (counter limit).
 * @property {number} maxCount - Maximum number of directives; the add button is disabled at the limit.
 * @property {string} scopeLabel - Human-readable scope used in labels (e.g. `"project"`).
 * @property {function(string): Promise<unknown>} onCreate - Creates a directive from text.
 * @property {function(string, string): Promise<unknown>} onUpdate - Replaces a directive's text (id, text).
 * @property {function(string): Promise<unknown>} onDelete - Deletes a directive (id).
 * @property {function(): Promise<Array<{ Id: string, Text: string }>>} reload - Re-reads the list.
 */

/**
 * Build the directive list editor.
 *
 * @param {DirectiveListEditorOptions} options
 * @returns {HTMLElement} The editor root element.
 */
export function buildDirectiveListEditor(options) {
    const root = document.createElement('div');
    root.className = 'directive-list-editor';

    let directives = Array.isArray(options.directives) ? options.directives : [];

    /** Re-reads the list from the server and re-renders. */
    async function reloadAndRender() {
        directives = await options.reload();
        render();
    }

    function render() {
        root.replaceChildren();

        if (directives.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'empty-state-inline text-secondary';
            empty.textContent = `No ${options.scopeLabel} directives yet.`;
            root.appendChild(empty);
        } else {
            const list = document.createElement('ul');
            list.className = 'directive-list';
            list.setAttribute('aria-label', `Directives of this ${options.scopeLabel}`);
            for (const directive of directives) {
                list.appendChild(buildItem(directive));
            }
            root.appendChild(list);
        }

        const slot = document.createElement('div');
        slot.className = 'directive-editor-slot';

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'btn btn-secondary btn-sm directive-add-btn';
        addBtn.textContent = '+ Add Directive';
        if (directives.length >= options.maxCount) {
            addBtn.disabled = true;
            addBtn.title = `At most ${options.maxCount} directives are allowed per scope.`;
        }
        addBtn.addEventListener('click', () => {
            slot.replaceChildren(buildForm(null, {
                onClose: () => {
                    slot.replaceChildren();
                    addBtn.hidden = false;
                    addBtn.focus();
                },
            }));
            addBtn.hidden = true;
            slot.querySelector('textarea')?.focus();
        });

        const toolbar = document.createElement('div');
        toolbar.className = 'directive-toolbar';
        toolbar.appendChild(addBtn);
        root.appendChild(toolbar);
        root.appendChild(slot);
    }

    /**
     * @param {{ Id: string, Text: string }} directive
     * @returns {HTMLLIElement}
     */
    function buildItem(directive) {
        const item = document.createElement('li');
        item.className = 'directive-item';
        item.dataset.directiveId = directive.Id;

        const text = document.createElement('p');
        text.className = 'directive-text';
        text.textContent = directive.Text;
        item.appendChild(text);

        const actions = document.createElement('div');
        actions.className = 'directive-actions';

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'btn btn-secondary btn-sm directive-edit-btn';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => {
            const form = buildForm(directive, {
                onClose: () => {
                    form.remove();
                    item.hidden = false;
                    editBtn.focus();
                },
            });
            item.hidden = true;
            item.after(form);
            form.querySelector('textarea')?.focus();
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn btn-danger btn-sm directive-delete-btn';
        deleteBtn.textContent = 'Delete';
        deleteBtn.addEventListener('click', async () => {
            deleteBtn.disabled = true;
            try {
                await showConfirm(
                    'Delete Directive',
                    `Delete this directive? It is removed from the generated AGENTS.md. This cannot be undone.\n\n"${directive.Text}"`,
                );
            } catch {
                // Cancelled — nothing to report.
                deleteBtn.disabled = false;
                return;
            }
            try {
                await options.onDelete(directive.Id);
                showToast('Directive deleted.', 'success');
                await reloadAndRender();
            } catch (err) {
                showToast(err?.message || 'Failed to delete directive.', 'error');
                deleteBtn.disabled = false;
            }
        });

        actions.appendChild(editBtn);
        actions.appendChild(deleteBtn);
        item.appendChild(actions);
        return item;
    }

    /**
     * Builds the inline add/edit form.
     *
     * @param {{ Id: string, Text: string }|null} directive - `null` to add.
     * @param {{ onClose: function(): void }} cb
     * @returns {HTMLFormElement}
     */
    function buildForm(directive, cb) {
        const isEdit = directive !== null;
        const form = document.createElement('form');
        form.className = 'directive-form';
        form.noValidate = true;

        const textareaId = `directive-text-${Math.random().toString(36).slice(2, 10)}`;
        const label = document.createElement('label');
        label.htmlFor = textareaId;
        label.textContent = isEdit ? 'Directive text' : 'New directive';

        const textarea = document.createElement('textarea');
        textarea.id = textareaId;
        textarea.name = 'text';
        textarea.className = 'form-textarea directive-textarea';
        textarea.rows = 3;
        textarea.value = isEdit ? directive.Text : '';

        const counter = document.createElement('span');
        counter.className = 'directive-counter text-secondary';
        counter.setAttribute('aria-live', 'polite');

        const error = document.createElement('span');
        error.className = 'form-error directive-form-error';
        error.setAttribute('role', 'alert');

        const hint = document.createElement('p');
        hint.className = 'form-hint text-secondary';
        hint.textContent = 'A directive is a single paragraph; line breaks become spaces.';

        function updateCounter() {
            const length = textarea.value.length;
            counter.textContent = `${length} / ${options.maxLength}`;
            counter.classList.toggle('directive-counter--over', length > options.maxLength);
        }
        textarea.addEventListener('input', updateCounter);
        updateCounter();

        const actions = document.createElement('div');
        actions.className = 'form-actions';

        const saveBtn = document.createElement('button');
        saveBtn.type = 'submit';
        saveBtn.className = 'btn btn-primary btn-sm';
        saveBtn.textContent = isEdit ? 'Save' : 'Add';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-secondary btn-sm';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', cb.onClose);

        actions.appendChild(saveBtn);
        actions.appendChild(cancelBtn);

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            error.textContent = '';
            const value = textarea.value;
            if (value.trim() === '') {
                error.textContent = 'Directive text is required.';
                textarea.classList.add('error');
                return;
            }
            textarea.classList.remove('error');

            saveBtn.disabled = true;
            try {
                if (isEdit) {
                    await options.onUpdate(directive.Id, value);
                } else {
                    await options.onCreate(value);
                }
            } catch (err) {
                error.textContent = err?.message || 'Failed to save directive.';
                textarea.classList.add('error');
                saveBtn.disabled = false;
                return;
            }
            showToast(isEdit ? 'Directive saved.' : 'Directive added.', 'success');
            try {
                await reloadAndRender();
            } catch (err) {
                showToast(err?.message || 'Saved, but reloading the list failed.', 'error');
                saveBtn.disabled = false;
            }
        });

        form.appendChild(label);
        form.appendChild(textarea);
        form.appendChild(counter);
        form.appendChild(error);
        form.appendChild(hint);
        form.appendChild(actions);
        return form;
    }

    render();
    return root;
}
