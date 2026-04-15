# GUI - Architecture Components
_SOURCE: Reusable UI components and utilities_
# Reusable UI components and utilities
```
// Structure of documents
└── gui/
    └── public/
        └── js/
            └── components/
                ├── confirm-dialog.js
                ├── form-helpers.js
                ├── nav-badge.js
                ├── status-badge.js
                ├── theme-toggle.js
                ├── toast.js
            └── utils/
                └── nav-highlight.js
                └── normalise.js
                └── time.js

```
###  Path: `/gui/public/js/components/confirm-dialog.js`

```js
/**
 * Confirmation Dialog Component.
 *
 * Renders a modal overlay asking the user to confirm or cancel an action.
 * The overlay uses CSS classes defined in styles.css (`.modal-overlay`,
 * `.modal`, `.modal-title`, `.modal-body`, `.modal-actions`).
 *
 * Usage:
 *   import { showConfirm } from './components/confirm-dialog.js';
 *
 *   try {
 *     await showConfirm('Delete project', 'This action cannot be undone.');
 *     // User clicked Confirm → proceed
 *   } catch {
 *     // User clicked Cancel or pressed Escape → abort
 *   }
 */

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Show a confirmation modal dialog.
 *
 * The dialog is appended to `document.body` and removed from the DOM when
 * the user dismisses it (via Confirm, Cancel, or Escape key).
 *
 * @param {string} title   - Short title shown at the top of the dialog.
 * @param {string} message - Explanatory message shown in the dialog body.
 * @returns {Promise<void>} Resolves when the user clicks Confirm; rejects
 *   when the user clicks Cancel or presses Escape.
 */
export function showConfirm(title, message) {
    return new Promise((resolve, reject) => {
        // ------------------------------------------------------------------
        // Build DOM
        // ------------------------------------------------------------------
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'confirm-dialog-title');
        overlay.setAttribute('aria-describedby', 'confirm-dialog-body');

        const modal = document.createElement('div');
        modal.className = 'modal';

        const titleEl = document.createElement('h2');
        titleEl.className = 'modal-title';
        titleEl.id = 'confirm-dialog-title';
        titleEl.textContent = title;

        const bodyEl = document.createElement('p');
        bodyEl.className = 'modal-body';
        bodyEl.id = 'confirm-dialog-body';
        bodyEl.textContent = message;

        const actionsEl = document.createElement('div');
        actionsEl.className = 'modal-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-secondary';
        cancelBtn.textContent = 'Cancel';

        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'btn btn-primary';
        confirmBtn.textContent = 'Confirm';

        actionsEl.appendChild(cancelBtn);
        actionsEl.appendChild(confirmBtn);

        modal.appendChild(titleEl);
        modal.appendChild(bodyEl);
        modal.appendChild(actionsEl);
        overlay.appendChild(modal);

        // ------------------------------------------------------------------
        // Helpers
        // ------------------------------------------------------------------

        /** Remove the overlay from the DOM and detach keyboard listener. */
        function cleanup() {
            document.removeEventListener('keydown', onKeydown);
            if (overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
        }

        function onConfirm() {
            cleanup();
            resolve();
        }

        function onCancel() {
            cleanup();
            reject(new Error('User cancelled'));
        }

        /** Close on Escape key. */
        function onKeydown(event) {
            if (event.key === 'Escape') {
                onCancel();
            }
        }

        // ------------------------------------------------------------------
        // Event listeners
        // ------------------------------------------------------------------
        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);

        // Click on the backdrop (overlay itself, not the modal) cancels.
        overlay.addEventListener('click', (event) => {
            if (event.target === overlay) {
                onCancel();
            }
        });

        document.addEventListener('keydown', onKeydown);

        // ------------------------------------------------------------------
        // Mount & focus
        // ------------------------------------------------------------------
        document.body.appendChild(overlay);

        // Move focus into the dialog for accessibility.
        confirmBtn.focus();
    });
}

```
###  Path: `/gui/public/js/components/form-helpers.js`

```js
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

```
###  Path: `/gui/public/js/components/nav-badge.js`

```js
/**
 * Nav Badge Component — polls the error-log count endpoint and updates the
 * badge element in the top navigation bar.
 *
 * Usage:
 *   import { initNavBadge, destroyNavBadge, refreshNavBadge } from './components/nav-badge.js';
 *
 *   initNavBadge();          // start polling
 *   refreshNavBadge();       // force an immediate refresh (e.g. after "Clear All")
 *   destroyNavBadge();       // stop polling
 */

import { api } from '../api.js';

const POLL_INTERVAL_MS = 30_000; // 30 seconds

/** @type {number|null} */
let intervalId = null;

/**
 * Fetch the current error-log count and update the badge element.
 */
async function updateBadge() {
    const badge = document.getElementById('error-log-badge');
    if (!badge) return;

    try {
        const result = await api.errorLog.count();
        const count = typeof result.total === 'number' ? result.total : 0;

        if (count > 0) {
            badge.textContent = String(count);
            badge.hidden = false;
        } else {
            badge.textContent = '';
            badge.hidden = true;
        }
    } catch {
        // Silently ignore — badge is a non-critical UI element.
    }
}

/**
 * Start the nav badge polling loop. Safe to call multiple times — subsequent
 * calls are no-ops if already running.
 */
export function initNavBadge() {
    if (intervalId !== null) return;

    // Immediate first fetch.
    updateBadge();

    intervalId = window.setInterval(updateBadge, POLL_INTERVAL_MS);
}

/**
 * Stop the nav badge polling loop and hide the badge.
 */
export function destroyNavBadge() {
    if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
    }
}

/**
 * Force an immediate badge refresh. Call this after actions that change the
 * error-log count (e.g. "Clear All").
 */
export function refreshNavBadge() {
    updateBadge();
}

```
###  Path: `/gui/public/js/components/status-badge.js`

```js
/**
 * Status Badge Component.
 *
 * Creates a DOM element summarising the git status of a single repository
 * inside a workspace.  CSS classes used here are all defined in styles.css.
 *
 * Usage:
 *   import { createStatusBadge } from './components/status-badge.js';
 *
 *   const badge = createStatusBadge(gitStatusInfo);
 *   container.appendChild(badge);
 *
 * @typedef {Object} GitStatusInfo
 * @property {string|null}  currentBranch     - Active branch name, or null for detached HEAD.
 * @property {number}       localCommits      - Commits ahead of remote.
 * @property {number}       unfetchedCommits  - Commits behind remote (unfetched).
 * @property {number}       modifiedFiles     - Number of modified/staged files.
 * @property {string|null}  lastActivity      - ISO timestamp of last commit, or null.
 * @property {boolean}      hasConflicts      - True when merge conflicts exist.
 */

import { formatLastActivity } from '../utils/time.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine the primary CSS modifier class for the badge based on status
 * priority: conflicts > modified > ahead/behind > clean.
 *
 * @param {GitStatusInfo} info
 * @returns {string} One of: 'status-badge-conflict' | 'status-badge-modified' |
 *   'status-badge-ahead' | 'status-badge-behind' | 'status-badge-clean'
 */
function resolveBadgeClass(info) {
    if (info.hasConflicts)                                 return 'status-badge-conflict';
    if (info.modifiedFiles > 0)                            return 'status-badge-modified';
    if (info.localCommits > 0)                             return 'status-badge-ahead';
    if (info.unfetchedCommits > 0)                         return 'status-badge-behind';
    return 'status-badge-clean';
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

/**
 * Create a status badge DOM element for a git repository.
 *
 * The returned element is a `<div>` that contains:
 * - A coloured pill showing the branch name.
 * - Secondary detail chips: modified count, commits ahead/behind, last
 *   activity, and a conflict warning (each only shown when non-zero / present).
 *
 * When `gitStatusInfo` is `null` a compact "No data" element is returned.
 *
 * @param {GitStatusInfo|null} gitStatusInfo
 * @returns {HTMLElement}
 */
export function createStatusBadge(gitStatusInfo) {
    const wrapper = document.createElement('div');
    wrapper.className = 'status-badge-wrapper';

    // ------------------------------------------------------------------
    // Null / loading state
    // ------------------------------------------------------------------
    if (!gitStatusInfo) {
        const noData = document.createElement('span');
        noData.className = 'status-badge status-badge-error';

        const dot = document.createElement('span');
        dot.className = 'status-badge-dot';

        noData.appendChild(dot);
        noData.appendChild(document.createTextNode('No data'));
        wrapper.appendChild(noData);
        return wrapper;
    }

    // ------------------------------------------------------------------
    // Primary pill — branch name + colour coding
    // ------------------------------------------------------------------
    const pill = document.createElement('span');
    const primaryClass = resolveBadgeClass(gitStatusInfo);
    pill.className = `status-badge ${primaryClass}`;

    const dot = document.createElement('span');
    dot.className = 'status-badge-dot';

    const branchName = gitStatusInfo.currentBranch || 'detached HEAD';
    pill.appendChild(dot);
    pill.appendChild(document.createTextNode(branchName));

    wrapper.appendChild(pill);

    // ------------------------------------------------------------------
    // Detail row — secondary indicators
    // ------------------------------------------------------------------
    const detail = document.createElement('div');
    detail.className = 'status-detail';

    /** Helper: append a detail chip. */
    function addChip(text, extraClass) {
        const chip = document.createElement('span');
        chip.className = `status-detail-item${extraClass ? ` ${extraClass}` : ''}`;
        chip.textContent = text;
        detail.appendChild(chip);
    }

    // Modified files
    if (gitStatusInfo.modifiedFiles > 0) {
        addChip(`${gitStatusInfo.modifiedFiles} modified`);
    }

    // Commits ahead of remote
    if (gitStatusInfo.localCommits > 0) {
        addChip(`↑ ${gitStatusInfo.localCommits} ahead`);
    }

    // Commits behind remote (unfetched)
    if (gitStatusInfo.unfetchedCommits > 0) {
        addChip(`↓ ${gitStatusInfo.unfetchedCommits} behind`);
    }

    // Last activity timestamp
    const activityText = formatLastActivity(gitStatusInfo.lastActivity);
    if (activityText) {
        addChip(activityText);
    }

    // Conflict indicator
    if (gitStatusInfo.hasConflicts) {
        addChip('⚠ Conflicts', 'text-danger');
    }

    // Only append detail row if it has children.
    if (detail.hasChildNodes()) {
        wrapper.appendChild(detail);
    }

    return wrapper;
}

```
###  Path: `/gui/public/js/components/theme-toggle.js`

```js
/**
 * Theme toggle component.
 *
 * Renders a button that switches between light and dark mode by toggling
 * the `data-theme` attribute on `<html>`. The user's preference is persisted
 * in `localStorage` under the key `"theme"`.
 *
 * @module components/theme-toggle
 */

const STORAGE_KEY = 'theme';
const THEME_LIGHT = 'light';
const THEME_DARK = 'dark';

/**
 * Returns the stored theme preference, falling back to `"light"`.
 * @returns {'light' | 'dark'}
 */
function getStoredTheme() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === THEME_DARK) return THEME_DARK;
    return THEME_LIGHT;
}

/**
 * Apply a theme to the document and persist it.
 * @param {'light' | 'dark'} theme
 */
function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(STORAGE_KEY, theme);
}

/**
 * Update the button label to reflect the current theme.
 * Shows a sun when in dark mode (click to go light) and a moon when in
 * light mode (click to go dark).
 * @param {HTMLButtonElement} button
 * @param {'light' | 'dark'} currentTheme
 */
/** Inline SVG icon for the sun (shown in dark mode). */
const SUN_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';

/** Inline SVG icon for the moon (shown in light mode). */
const MOON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

function updateButtonLabel(button, currentTheme) {
    if (currentTheme === THEME_DARK) {
        button.innerHTML = SUN_SVG;
        button.setAttribute('aria-label', 'Switch to light mode');
        button.title = 'Switch to light mode';
    } else {
        button.innerHTML = MOON_SVG;
        button.setAttribute('aria-label', 'Switch to dark mode');
        button.title = 'Switch to dark mode';
    }
}

/**
 * Create a theme toggle button element.
 *
 * The button reads the initial theme from `localStorage` (defaulting to
 * `"light"`), applies it to `document.documentElement.dataset.theme`, and
 * toggles between light and dark on each click — persisting the choice.
 *
 * @returns {HTMLButtonElement} The toggle button, ready to be appended to the DOM.
 */
export function createThemeToggle() {
    const currentTheme = getStoredTheme();
    applyTheme(currentTheme);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-icon';
    updateButtonLabel(button, currentTheme);

    button.addEventListener('click', () => {
        const active = document.documentElement.dataset.theme === THEME_DARK
            ? THEME_LIGHT
            : THEME_DARK;
        applyTheme(active);
        updateButtonLabel(button, active);
    });

    return button;
}

```
###  Path: `/gui/public/js/components/toast.js`

```js
/**
 * Toast Notification Component.
 *
 * Appends transient notification banners to the `#toast-container` element
 * that already exists in index.html.  Each toast auto-dismisses after a
 * configurable timeout with a CSS slide-out transition.  Multiple toasts
 * stack vertically inside the container.
 *
 * CSS classes used: `toast`, `toast-success`, `toast-error`, `toast-info`,
 * `toast-warning`, `toast.removing` — all defined in styles.css.
 *
 * Usage:
 *   import { showToast } from './components/toast.js';
 *
 *   showToast('Repository saved.', 'success');
 *   showToast('Something went wrong.', 'error');
 *   showToast('Branch list refreshed.', 'info');
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** How long (ms) a toast stays visible before the slide-out animation runs. */
const TOAST_DISPLAY_MS = 4_000;

/** Duration (ms) of the CSS slide-out animation — must match styles.css. */
const TOAST_ANIMATION_MS = 200;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Lazily retrieve (or create) the toast container element.
 * Logs a warning if `#toast-container` is absent from the DOM.
 *
 * @returns {HTMLElement|null}
 */
function getContainer() {
    const el = document.getElementById('toast-container');
    if (!el) {
        console.warn('[toast] #toast-container not found in the DOM. Toasts will not be displayed.');
    }
    return el;
}

/**
 * Remove a toast element with a CSS slide-out transition, then detach it
 * from the DOM.
 *
 * @param {HTMLElement} toastEl
 */
function dismissToast(toastEl) {
    // Guard against double-dismiss (e.g., user click + auto-timer firing).
    if (toastEl.dataset.dismissing === 'true') return;
    toastEl.dataset.dismissing = 'true';

    toastEl.classList.add('removing');

    setTimeout(() => {
        if (toastEl.parentNode) {
            toastEl.parentNode.removeChild(toastEl);
        }
    }, TOAST_ANIMATION_MS);
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

/**
 * Display a toast notification.
 *
 * @param {string} message            - Text to display inside the toast.  The
 *   message is rendered via `textContent` (NOT `innerHTML`), so server-controlled
 *   strings (including git error output) are safe to pass here — they will be
 *   displayed as plain text and never interpreted as HTML.
 * @param {'success'|'error'|'info'|'warning'} type - Visual variant.
 * @param {number} [duration]         - Override the auto-dismiss delay in ms.
 * @returns {HTMLElement|null}        - The created toast element, or null if
 *   the container is unavailable.
 */
export function showToast(message, type, duration = TOAST_DISPLAY_MS) {
    const VALID_TYPES = new Set(['success', 'error', 'info', 'warning']);
    const safeType = VALID_TYPES.has(type) ? type : 'info';

    const container = getContainer();
    if (!container) return null;

    // ------------------------------------------------------------------
    // Build element
    // ------------------------------------------------------------------
    const toast = document.createElement('div');
    toast.className = `toast toast-${safeType}`;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    const text = document.createElement('span');
    text.className = 'toast-message';
    text.textContent = message;

    // Close button for manual dismissal.
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn-icon toast-close';
    closeBtn.setAttribute('aria-label', 'Dismiss notification');
    closeBtn.textContent = '×';

    toast.appendChild(text);
    toast.appendChild(closeBtn);

    // ------------------------------------------------------------------
    // Mount
    // ------------------------------------------------------------------
    container.appendChild(toast);

    // ------------------------------------------------------------------
    // Auto-dismiss
    // ------------------------------------------------------------------
    const timer = setTimeout(() => dismissToast(toast), duration);

    closeBtn.addEventListener('click', () => {
        clearTimeout(timer);
        dismissToast(toast);
    });

    return toast;
}

```
###  Path: `/gui/public/js/utils/nav-highlight.js`

```js
/**
 * Active nav-link highlighting utility.
 *
 * Listens for hash changes and toggles the `.active` class on `.nav-link`
 * elements whose `href` matches the current location hash.
 *
 * @module utils/nav-highlight
 */

/**
 * Update the `active` class on all `.nav-link` elements to reflect the
 * current `location.hash`.
 */
function updateActiveNavLink() {
    const hash = location.hash || '#/';
    document.querySelectorAll('.nav-link').forEach((link) => {
        const linkHash = link.getAttribute('href');
        const isActive = hash === linkHash || (linkHash !== '#/' && hash.startsWith(linkHash));
        link.classList.toggle('active', isActive);
    });
}

/**
 * Initialise nav-link highlighting.
 *
 * Performs an immediate highlight pass and registers a `hashchange` listener
 * so the active state stays in sync with navigation.
 */
export function initNavHighlight() {
    window.addEventListener('hashchange', updateActiveNavLink);
    updateActiveNavLink();
}

```
###  Path: `/gui/public/js/utils/normalise.js`

```js
/**
 * Shared normalisation helpers for backend response objects.
 *
 * The Go backend serialises object fields with capitalised keys (`Id`, `Name`,
 * `Url`, etc.). These helpers accept either casing and return a consistently
 * lowercase-keyed object so view code can rely on a single shape.
 *
 * @module utils/normalise
 */

/**
 * Normalise a repository object from the backend.
 *
 * @param {Object} repo
 * @returns {{ id: string, name: string, url: string }}
 */
export function normaliseRepo(repo) {
    return {
        id:   repo.Id   || repo.id   || '',
        name: repo.Name || repo.name || '',
        url:  repo.Url  || repo.url  || repo.URL || '',
    };
}

/**
 * Normalise a project object from the backend (Go-style capitalised keys or
 * lowercase — both are supported).
 *
 * @param {Object} project
 * @returns {{ id: string, name: string, description: string, repositories: string[] }}
 */
export function normaliseProject(project) {
    return {
        id:           project.Id          || project.id          || '',
        name:         project.Name        || project.name        || '',
        description:  project.Description || project.description || '',
        repositories: Array.isArray(project.Repositories)
            ? project.Repositories
            : (Array.isArray(project.repositories) ? project.repositories : []),
    };
}

/**
 * Normalise a workspace object from the backend.
 *
 * The backend returns `WorkspaceID` and `DateCreated` (not `Id` / `CreatedAt`),
 * so we must map both naming conventions.
 *
 * @param {Object} ws
 * @returns {{ id: string, description: string, createdAt: string, initialized: boolean }}
 */
export function normaliseWorkspace(ws) {
    return {
        id:          ws.WorkspaceID || ws.Id   || ws.id          || '',
        description: ws.Description || ws.description || '',
        createdAt:   ws.DateCreated || ws.CreatedAt || ws.createdAt || ws.created_at || '',
        initialized: ws.Initialized != null ? ws.Initialized : (ws.initialized != null ? ws.initialized : true),
        folderPath:  ws.FolderPath  || ws.folderPath  || '',
    };
}

/**
 * Normalise an error log entry from the backend.
 *
 * The Go backend serialises struct fields with capitalised keys (`Id`,
 * `Severity`, `Source`, `Message`, `Details`, `Timestamp`, `Project`,
 * `Workspace`, `Repository`). This helper accepts either casing and returns
 * a consistently camelCase-keyed object for use in view code.
 *
 * @param {Object} entry
 * @returns {{
 *   id:         number,
 *   severity:   string,
 *   source:     string,
 *   message:    string,
 *   details:    string,
 *   timestamp:  string,
 *   project:    string,
 *   workspace:  string,
 *   repository: string
 * }}
 */
export function normaliseErrorEntry(entry) {
    return {
        id:         entry.Id         ?? entry.id         ?? 0,
        severity:   entry.Severity   || entry.severity   || '',
        source:     entry.Source     || entry.source     || '',
        message:    entry.Message    || entry.message    || '',
        details:    entry.Details    || entry.details    || '',
        timestamp:  entry.Timestamp  || entry.timestamp  || '',
        project:    entry.Project    || entry.project    || '',
        workspace:  entry.Workspace  || entry.workspace  || '',
        repository: entry.Repository || entry.repository || '',
    };
}

```
###  Path: `/gui/public/js/utils/time.js`

```js
/**
 * Shared time-formatting utilities for the GUI.
 *
 * Consolidates relative-time logic previously duplicated in:
 *   - views/error-log.js (relativeTime)
 *   - components/status-badge.js (formatLastActivity)
 */

// ---------------------------------------------------------------------------
// relativeTime — verbose relative timestamps for error-log entries
// ---------------------------------------------------------------------------

/**
 * Return a human-readable relative time string for the given ISO timestamp.
 * Falls back to the raw timestamp string if parsing fails.
 *
 * @param {string} isoString - ISO 8601 timestamp from the backend.
 * @returns {string}
 */
export function relativeTime(isoString) {
    if (!isoString) return '—';

    let date;
    try {
        date = new Date(isoString);
        if (isNaN(date.getTime())) return isoString;
    } catch {
        return isoString;
    }

    const diffMs  = Date.now() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 5)   return 'just now';
    if (diffSec < 60)  return `${diffSec} sec ago`;

    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60)  return `${diffMin} min ago`;

    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24)   return `${diffHr} hr ago`;

    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30)  return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;

    const diffMo = Math.floor(diffDay / 30);
    if (diffMo < 12)   return `${diffMo} month${diffMo === 1 ? '' : 's'} ago`;

    const diffYr = Math.floor(diffMo / 12);
    return `${diffYr} yr${diffYr === 1 ? '' : 's'} ago`;
}

// ---------------------------------------------------------------------------
// formatLastActivity — compact relative timestamps for status badges
// ---------------------------------------------------------------------------

/**
 * Format an ISO timestamp into a human-readable relative or absolute string.
 * Returns an empty string when the input is falsy.
 *
 * @param {string|null} isoTimestamp
 * @returns {string}
 */
export function formatLastActivity(isoTimestamp) {
    if (!isoTimestamp) return '';

    const date = new Date(isoTimestamp);
    if (isNaN(date.getTime())) return isoTimestamp; // pass through if unparseable

    const now = Date.now();
    const diffMs = now - date.getTime();
    const diffMinutes = Math.floor(diffMs / 60_000);
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMinutes < 1)  return 'just now';
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    if (diffHours < 24)   return `${diffHours}h ago`;
    if (diffDays < 7)     return `${diffDays}d ago`;

    // Fall back to locale date string for older commits.
    return date.toLocaleDateString();
}

```
---
**File Statistics**
- **Size**: 37.65 KB
- **Lines**: 1121
File: `modules/gui/architecture-components.md`
