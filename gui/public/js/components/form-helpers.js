/**
 * Form Helper Utilities.
 *
 * Provides two building blocks used throughout the application's forms:
 *
 *  - `createFormField(label, type, name, options)` — generates a labelled
 *    form control wrapped in a `.form-group` div.
 *  - `validateRequired(form, fields)` — checks that named fields in a form
 *    element are non-empty and shows inline error messages when they are not.
 *
 * All CSS classes used (`form-group`, `form-input`, `form-select`,
 * `form-textarea`, `form-error`) are defined in styles.css.
 *
 * This module also exports shared validation constants:
 *  - `WORKSPACE_ID_PATTERN` — the regex that workspace IDs must satisfy
 *    (`/^[A-Z]{2,10}$/`), used in both `project-detail.js` and
 *    `workspace-detail.js` to avoid duplicating the constraint.
 *
 * Usage:
 *   import { createFormField, validateRequired, WORKSPACE_ID_PATTERN } from './components/form-helpers.js';
 *
 *   const nameField = createFormField('Project Name', 'text', 'name', {
 *     required: true,
 *     placeholder: 'my-project',
 *   });
 *   form.appendChild(nameField);
 *
 *   form.addEventListener('submit', (e) => {
 *     e.preventDefault();
 *     if (!validateRequired(form, ['name', 'description'])) return;
 *     // … proceed
 *   });
 */

// ---------------------------------------------------------------------------
// Shared validation constants
// ---------------------------------------------------------------------------

/**
 * Workspace ID format constraint: 2–10 uppercase ASCII letters only.
 *
 * Exported so that all views that create or rename workspaces reference a
 * single authoritative pattern instead of duplicating the literal regex.
 *
 * @type {RegExp}
 */
export const WORKSPACE_ID_PATTERN = /^[A-Z]{2,10}$/;

// ---------------------------------------------------------------------------
// CSS.escape fallback — avoids reliance on the browser-only CSS.escape API
// (absent in jsdom and older environments).
// ---------------------------------------------------------------------------

const cssEscape = typeof CSS !== 'undefined' && CSS.escape
    ? CSS.escape
    : (s) => s.replace(/([^\w-])/g, '\\$1');

// ---------------------------------------------------------------------------
// createFormField
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} FormFieldOptions
 * @property {boolean}          [required]     - Whether the field is required.
 * @property {string}           [placeholder]  - Placeholder text (inputs only).
 * @property {string}           [value]        - Pre-populated value.
 * @property {string}           [hint]         - Optional hint text shown below the control.
 * @property {Array<{value: string, label: string}>|string[]} [choices]
 *   Options for `<select>` elements.  Each item may be a plain string or an
 *   object with `value` and `label` properties.
 * @property {number}           [rows]         - Row count for `<textarea>`.
 * @property {string}           [id]           - Override the auto-generated element ID.
 */

/**
 * Generate a labelled form control wrapped in a `.form-group` container.
 *
 * Supported `type` values:
 * - Any `<input>` type string (`'text'`, `'url'`, `'email'`, `'password'`,
 *   `'number'`, `'checkbox'`, …).
 * - `'select'` — renders a `<select>` populated from `options.choices`.
 * - `'textarea'` — renders a `<textarea>`.
 *
 * @param {string}           label   - Human-readable label text.
 * @param {string}           type    - Field type (see above).
 * @param {string}           name    - The `name` attribute for the control.
 * @param {FormFieldOptions} [opts]  - Optional configuration.
 * @returns {HTMLDivElement} The `.form-group` wrapper element.
 */
export function createFormField(label, type, name, opts = {}) {
    const {
        required = false,
        placeholder = '',
        value = '',
        hint = '',
        choices = [],
        rows = 3,
        id: overrideId,
    } = opts;

    const fieldId = overrideId || `field-${name}-${Math.random().toString(36).slice(2, 7)}`;

    // ------------------------------------------------------------------
    // Wrapper
    // ------------------------------------------------------------------
    const group = document.createElement('div');
    group.className = 'form-group';

    // ------------------------------------------------------------------
    // Label
    // ------------------------------------------------------------------
    const labelEl = document.createElement('label');
    labelEl.htmlFor = fieldId;
    labelEl.textContent = required ? `${label} *` : label;
    group.appendChild(labelEl);

    // ------------------------------------------------------------------
    // Control
    // ------------------------------------------------------------------
    let control;

    if (type === 'select') {
        control = document.createElement('select');
        control.className = 'form-select';

        choices.forEach((choice) => {
            const opt = document.createElement('option');
            if (typeof choice === 'string') {
                opt.value = choice;
                opt.textContent = choice;
            } else {
                opt.value = choice.value;
                opt.textContent = choice.label;
            }
            if (opt.value === value) opt.selected = true;
            control.appendChild(opt);
        });

    } else if (type === 'textarea') {
        control = document.createElement('textarea');
        control.className = 'form-textarea';
        control.rows = rows;
        if (placeholder) control.placeholder = placeholder;
        if (value)       control.value = value;

    } else {
        control = document.createElement('input');
        control.type = type;
        control.className = 'form-input';
        if (placeholder)        control.placeholder = placeholder;
        if (value)              control.value = value;
    }

    control.id = fieldId;
    control.name = name;
    if (required) control.required = true;

    // Clear the inline error on every change so feedback stays fresh.
    control.addEventListener('input', () => clearFieldError(group));

    group.appendChild(control);

    // ------------------------------------------------------------------
    // Hint text
    // ------------------------------------------------------------------
    if (hint) {
        const hintEl = document.createElement('span');
        hintEl.className = 'hint';
        hintEl.textContent = hint;
        group.appendChild(hintEl);
    }

    // ------------------------------------------------------------------
    // Error placeholder (hidden initially)
    // ------------------------------------------------------------------
    const errorEl = document.createElement('span');
    errorEl.className = 'form-error field-error';
    errorEl.setAttribute('aria-live', 'polite');
    errorEl.hidden = true;
    group.appendChild(errorEl);

    return group;
}

// ---------------------------------------------------------------------------
// validateRequired
// ---------------------------------------------------------------------------

/**
 * Show an inline error message inside a `.form-group` element.
 *
 * @param {HTMLElement} group
 * @param {string}      message
 */
function showFieldError(group, message) {
    const control = group.querySelector('input, select, textarea');
    const errorEl = group.querySelector('.field-error');

    if (control) {
        control.classList.add('error');
        control.setAttribute('aria-invalid', 'true');
    }
    if (errorEl) {
        errorEl.textContent = message;
        errorEl.hidden = false;
    }
}

/**
 * Clear any inline error state inside a `.form-group` element.
 *
 * @param {HTMLElement} group
 */
function clearFieldError(group) {
    const control = group.querySelector('input, select, textarea');
    const errorEl = group.querySelector('.field-error');

    if (control) {
        control.classList.remove('error');
        control.removeAttribute('aria-invalid');
    }
    if (errorEl) {
        errorEl.textContent = '';
        errorEl.hidden = true;
    }
}

/**
 * Validate that specified named fields in a form are non-empty.
 *
 * For each listed field name the function looks up the corresponding
 * `<input>`, `<select>`, or `<textarea>` element by `name` attribute,
 * checks whether its trimmed value is non-empty, and shows an inline
 * error message inside the parent `.form-group` when validation fails.
 *
 * Previously shown errors on *all* listed fields are cleared before
 * re-validation so stale messages do not linger.
 *
 * @param {HTMLFormElement} form   - The form element to validate.
 * @param {string[]}        fields - Array of field `name` attributes to check.
 * @returns {boolean} `true` if every listed field has a non-empty value;
 *   `false` if one or more fields failed validation (errors shown in UI).
 */
export function validateRequired(form, fields) {
    // First pass: clear all existing errors for the listed fields.
    fields.forEach((fieldName) => {
        const control = form.querySelector(`[name="${cssEscape(fieldName)}"]`);
        if (control) {
            const group = control.closest('.form-group');
            if (group) clearFieldError(group);
        }
    });

    // Second pass: validate and collect failures.
    let valid = true;
    let firstInvalidControl = null;

    fields.forEach((fieldName) => {
        const control = form.querySelector(`[name="${cssEscape(fieldName)}"]`);
        if (!control) return; // skip unknown field names

        const isEmpty = control.value.trim() === '';
        if (isEmpty) {
            const group = control.closest('.form-group');
            if (group) showFieldError(group, 'This field is required.');
            if (!firstInvalidControl) firstInvalidControl = control;
            valid = false;
        }
    });

    // Move focus to the first invalid field for accessibility.
    if (firstInvalidControl) {
        firstInvalidControl.focus();
    }

    return valid;
}
