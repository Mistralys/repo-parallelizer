# GUI - Architecture Views
_SOURCE: Page-level view functions_
# Page-level view functions
```
// Structure of documents
└── gui/
    └── public/
        └── js/
            └── views/
                └── branch-switch.js
                └── dashboard.js
                └── error-log.js
                └── notes-collected.js
                └── project-detail.js
                └── repositories.js
                └── repository-detail.js
                └── settings.js
                └── workspace-detail.js

```
###  Path: `/gui/public/js/views/branch-switch.js`

```js
/**
 * Branch Switch Wizard — Repo Parallelizer GUI.
 *
 * A 3-step wizard that guides the user through selecting a target branch,
 * assigning per-repository branch overrides, executing the switch, and
 * displaying per-repo results.
 *
 * ## Steps
 *
 *   Step 1 — Choose Branch
 *     Fetches branch data via `api.branches.list()`. Displays a text input for
 *     typing a branch name and a `<datalist>` of pre-computed suggestions for
 *     quick-pick. "Next" validates input and advances to Step 2.
 *
 *   Step 2 — Assign Per-Repo Branches
 *     Table with one row per repository. Each row has a text input (pre-filled
 *     with the Step 1 branch) and a `<select>` dropdown. The Step 1 branch
 *     appears in a separate "Selected" `<optgroup>` at the top; choosing a
 *     dropdown option copies the value into the corresponding text input.
 *     "Back" returns to Step 1 preserving the branch name; "Confirm" submits.
 *
 *   Step 3 — Results
 *     Calls `api.branches.switch()` with the collected assignments. Displays a
 *     loading indicator during the API call, then shows a results table with
 *     per-repo outcome (success / conflict / error). Conflict rows show a
 *     prominent manual-resolution message. "Done" navigates back to the
 *     workspace detail view.
 *
 * ## Router integration
 *
 * `app.js` calls `setRouter(router)` before `router.start()`. The `_router`
 * variable is null-guarded at every navigation site so the view remains
 * functional in test contexts.
 *
 * @module branch-switch
 */

import { api }          from '../api.js';
import { showToast }    from '../components/toast.js';
import { clearElement } from '../utils/dom.js';
import { APP_NAME_SHORT } from '../utils/constants.js';

// ---------------------------------------------------------------------------
// Router reference — injected from app.js via setRouter()
// ---------------------------------------------------------------------------

/** @type {import('../router.js').Router|null} */
let _router = null;

/**
 * Inject the router instance so branch-switch can navigate on completion.
 * Called from app.js before the router starts.
 *
 * @param {import('../router.js').Router} router
 */
export function setRouter(router) {
    _router = router;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Step indices — kept as named constants for readability. */
const STEP_CHOOSE    = 1;
const STEP_ASSIGN    = 2;
const STEP_RESULTS   = 3;

const STEP_LABELS = [
    'Choose Branch',
    'Assign Per-Repo Branches',
    'Results',
];

// ---------------------------------------------------------------------------
// Loading helper
// ---------------------------------------------------------------------------

/**
 * Render a loading spinner into `el`.
 *
 * @param {HTMLElement} el
 * @param {string} [label]
 */
function showLoading(el, label = 'Loading…') {
    el.innerHTML = `
        <div class="loading-indicator" aria-live="polite">
            <span class="spinner" aria-hidden="true"></span>
            <span>${label}</span>
        </div>
    `;
}

// ---------------------------------------------------------------------------
// Wizard step indicator
// ---------------------------------------------------------------------------

/**
 * Build (or rebuild) the wizard step indicator bar.
 *
 * @param {number} activeStep - 1-indexed current step number.
 * @returns {HTMLElement}
 */
function buildStepIndicator(activeStep) {
    const nav = document.createElement('nav');
    nav.className = 'wizard-steps';
    nav.setAttribute('aria-label', 'Wizard progress');

    STEP_LABELS.forEach((label, idx) => {
        const stepNum = idx + 1;

        const step = document.createElement('div');
        if (stepNum < activeStep) {
            step.className = 'wizard-step completed';
        } else if (stepNum === activeStep) {
            step.className = 'wizard-step active';
            step.setAttribute('aria-current', 'step');
        } else {
            step.className = 'wizard-step';
        }

        const numEl = document.createElement('span');
        numEl.className   = 'wizard-step-number';
        numEl.textContent = stepNum < activeStep ? '✓' : String(stepNum);
        numEl.setAttribute('aria-hidden', 'true');

        const labelEl = document.createElement('span');
        labelEl.className   = 'wizard-step-label';
        labelEl.textContent = label;

        step.appendChild(numEl);
        step.appendChild(labelEl);
        nav.appendChild(step);

        // Divider between steps (not after last)
        if (idx < STEP_LABELS.length - 1) {
            const divider = document.createElement('div');
            divider.className = 'wizard-step-divider';
            divider.setAttribute('aria-hidden', 'true');
            nav.appendChild(divider);
        }
    });

    return nav;
}

// ---------------------------------------------------------------------------
// Step 1 — Choose Branch
// ---------------------------------------------------------------------------

/**
 * Render Step 1 into `stepContent`.
 *
 * Fetches branch data from `api.branches.list()` and populates the suggestion
 * datalist. Calls `onNext(branchName, branchData)` when the user clicks "Next".
 *
 * @param {HTMLElement}  stepContent  - Container for this step's content.
 * @param {string}       projectId
 * @param {string}       wid
 * @param {string}       initialBranch - Previously entered branch name (for "Back" flows).
 * @param {function(string, Object): void} onNext - Callback receiving the chosen
 *   branch name and the full API response.
 */
function renderStep1(stepContent, projectId, wid, initialBranch, onNext) {
    showLoading(stepContent, 'Loading branches…');

    api.branches.list(projectId, wid).then((data) => {
        if (!stepContent.isConnected) return;

        clearElement(stepContent);

        const { suggestions = [], branches: branchMap = {} } = data || {};

        // ---- Description ----
        const desc = document.createElement('p');
        desc.className   = 'text-secondary mb-16';
        desc.textContent = 'Enter a branch name to switch to across all repositories, or choose from the suggestions below.';
        stepContent.appendChild(desc);

        // ---- Branch name input group ----
        const formGroup = document.createElement('div');
        formGroup.className = 'form-group';

        const label = document.createElement('label');
        label.setAttribute('for', 'branch-switch-name');
        label.textContent = 'Branch Name';
        formGroup.appendChild(label);

        // Input with datalist
        const inputWrapper = document.createElement('div');
        inputWrapper.className = 'form-inline';

        const input = document.createElement('input');
        input.type        = 'text';
        input.id          = 'branch-switch-name';
        input.name        = 'branchName';
        input.className   = 'form-input';
        input.placeholder = 'e.g. main or feature/my-feature';
        input.setAttribute('list', 'branch-suggestions');
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('spellcheck', 'false');
        if (initialBranch) {
            input.value = initialBranch;
        }

        // Datalist for suggestions
        const datalist = document.createElement('datalist');
        datalist.id = 'branch-suggestions';
        suggestions.forEach((name) => {
            const option = document.createElement('option');
            option.value = name;
            datalist.appendChild(option);
        });

        inputWrapper.appendChild(input);
        inputWrapper.appendChild(datalist);
        formGroup.appendChild(inputWrapper);

        // Validation error message
        const errorEl = document.createElement('span');
        errorEl.className = 'form-error';
        errorEl.id        = 'branch-name-error';
        errorEl.setAttribute('role', 'alert');
        errorEl.hidden    = true;
        formGroup.appendChild(errorEl);

        stepContent.appendChild(formGroup);

        // ---- Suggestions list (visible quick-picks) ----
        if (suggestions.length > 0) {
            const suggestSection = document.createElement('div');
            suggestSection.className = 'branch-suggestions-section mt-16';

            const suggestLabel = document.createElement('p');
            suggestLabel.className   = 'text-secondary text-sm mb-8';
            suggestLabel.textContent = 'Common branches across repositories:';
            suggestSection.appendChild(suggestLabel);

            const pillList = document.createElement('div');
            pillList.className = 'branch-suggestion-pills';

            suggestions.forEach((name) => {
                const pill = document.createElement('button');
                pill.type      = 'button';
                pill.className = 'btn btn-secondary btn-sm branch-pill';
                pill.textContent = name;
                pill.addEventListener('click', () => {
                    input.value = name;
                    errorEl.hidden = true;
                    input.classList.remove('error');
                    input.removeAttribute('aria-invalid');
                    input.focus();
                });
                pillList.appendChild(pill);
            });

            suggestSection.appendChild(pillList);
            stepContent.appendChild(suggestSection);
        }

        // Repo count hint
        const repoCount = Object.keys(branchMap).length;
        if (repoCount > 0) {
            const hint = document.createElement('p');
            hint.className   = 'text-muted text-xs mt-16';
            hint.textContent = `Branch data available for ${repoCount} repositor${repoCount === 1 ? 'y' : 'ies'}.`;
            stepContent.appendChild(hint);
        }

        // ---- Actions ----
        const actions = document.createElement('div');
        actions.className = 'form-actions mt-24';

        const nextBtn = document.createElement('button');
        nextBtn.type      = 'button';
        nextBtn.className = 'btn btn-primary';
        nextBtn.textContent = 'Next →';

        nextBtn.addEventListener('click', () => {
            const branchName = input.value.trim();

            // Validate
            if (!branchName) {
                errorEl.textContent = 'Please enter a branch name.';
                errorEl.hidden = false;
                input.classList.add('error');
                input.setAttribute('aria-invalid', 'true');
                input.focus();
                return;
            }

            errorEl.hidden = true;
            input.classList.remove('error');
            input.removeAttribute('aria-invalid');

            onNext(branchName, data);
        });

        actions.appendChild(nextBtn);
        stepContent.appendChild(actions);

        // Auto-focus the input (unless pre-filled from a back-navigation)
        if (!initialBranch) {
            input.focus();
        }

    }).catch((err) => {
        if (!stepContent.isConnected) return;
        clearElement(stepContent);

        const errEl = document.createElement('div');
        errEl.className = 'empty-state';

        const title = document.createElement('h3');
        title.textContent = 'Failed to load branches';
        errEl.appendChild(title);

        const msg = document.createElement('p');
        msg.className   = 'text-secondary mt-8';
        msg.textContent = err.message || 'An unexpected error occurred while fetching branch data.';
        errEl.appendChild(msg);

        const retryBtn = document.createElement('button');
        retryBtn.type      = 'button';
        retryBtn.className = 'btn btn-secondary mt-16';
        retryBtn.textContent = 'Retry';
        retryBtn.addEventListener('click', () => {
            renderStep1(stepContent, projectId, wid, initialBranch, onNext);
        });
        errEl.appendChild(retryBtn);

        stepContent.appendChild(errEl);
    });
}

// ---------------------------------------------------------------------------
// Step 2 — Assign Per-Repo Branches
// ---------------------------------------------------------------------------

/**
 * Build a single assignment table row.
 *
 * @param {string}   repoId      - Repository ID (used as the row key and input name).
 * @param {Array<{name: string, isCurrent: boolean, isRemote: boolean, upstream?: string}>} branchInfos
 *   List of branches known for this repository.
 * @param {string}   chosenBranch - The branch selected in Step 1.
 * @returns {HTMLTableRowElement}
 */
function buildAssignmentRow(repoId, branchInfos, chosenBranch) {
    const tr = document.createElement('tr');
    tr.dataset.repoId = repoId;

    // ---- Repository name cell ----
    const nameCell = document.createElement('td');
    nameCell.className = 'repo-name-cell';
    const nameSpan = document.createElement('span');
    nameSpan.className   = 'repo-name font-mono text-sm';
    nameSpan.textContent = repoId;
    nameCell.appendChild(nameSpan);
    tr.appendChild(nameCell);

    // ---- Branch input cell ----
    const inputCell = document.createElement('td');
    inputCell.className = 'branch-input-cell';

    const branchInput = document.createElement('input');
    branchInput.type      = 'text';
    branchInput.name      = `branch-${repoId}`;
    branchInput.className = 'form-input branch-assignment-input';
    branchInput.value     = chosenBranch;
    branchInput.setAttribute('data-repo-id', repoId);
    branchInput.setAttribute('spellcheck', 'false');
    branchInput.setAttribute('autocomplete', 'off');
    branchInput.setAttribute('aria-label', `Branch for ${repoId}`);

    inputCell.appendChild(branchInput);
    tr.appendChild(inputCell);

    // ---- Dropdown cell ----
    const selectCell = document.createElement('td');
    selectCell.className = 'branch-select-cell';

    const select = document.createElement('select');
    select.className = 'form-select branch-assignment-select';
    select.setAttribute('aria-label', `Select a branch for ${repoId}`);

    // "Selected" optgroup at the top — the Step 1 branch
    const selectedGroup = document.createElement('optgroup');
    selectedGroup.label = 'Selected';
    const selectedOpt = document.createElement('option');
    selectedOpt.value       = chosenBranch;
    selectedOpt.textContent = chosenBranch;
    selectedGroup.appendChild(selectedOpt);
    select.appendChild(selectedGroup);

    // Remaining branches from the API (excluding the chosen branch to avoid duplication)
    const otherBranches = (branchInfos || []).filter((bi) => bi.name !== chosenBranch);

    if (otherBranches.length > 0) {
        const localGroup  = document.createElement('optgroup');
        localGroup.label  = 'Available Branches';

        otherBranches.forEach((bi) => {
            const opt = document.createElement('option');
            opt.value       = bi.name;
            opt.textContent = bi.name;
            if (bi.isCurrent) {
                opt.textContent += ' (current)';
            }
            localGroup.appendChild(opt);
        });

        select.appendChild(localGroup);
    }

    // Selecting from the dropdown copies the value into the text input
    select.addEventListener('change', () => {
        if (select.value) {
            branchInput.value = select.value;
        }
    });

    selectCell.appendChild(select);
    tr.appendChild(selectCell);

    return tr;
}

/**
 * Render Step 2 into `stepContent`.
 *
 * @param {HTMLElement}  stepContent
 * @param {string}       chosenBranch  - Branch name from Step 1.
 * @param {Object}       branchData    - Full API response from `api.branches.list()`.
 * @param {function(): void}          onBack   - Callback for "Back" button.
 * @param {function(Record<string, string>): void} onConfirm - Callback with
 *   `{ repoId: branchName }` assignments.
 */
function renderStep2(stepContent, chosenBranch, branchData, onBack, onConfirm) {
    clearElement(stepContent);

    const { branches: branchMap = {} } = branchData || {};
    const repoIds = Object.keys(branchMap);

    // ---- Description ----
    const desc = document.createElement('p');
    desc.className   = 'text-secondary mb-16';
    desc.textContent = `Review and customise the target branch per repository. Each row is pre-filled with "${chosenBranch}". Use the dropdown to quickly select an existing branch, or type a custom name directly.`;
    stepContent.appendChild(desc);

    if (repoIds.length === 0) {
        const empty = document.createElement('p');
        empty.className   = 'empty-state-inline text-secondary';
        empty.textContent = 'No repository branch data returned by the API.';
        stepContent.appendChild(empty);
    } else {
        // ---- Assignment table ----
        const tableWrapper = document.createElement('div');
        tableWrapper.className = 'table-wrapper';

        const table = document.createElement('table');
        table.className = 'data-table branch-assignment-table';

        const thead = document.createElement('thead');
        const htr   = document.createElement('tr');
        ['Repository', 'Target Branch', 'Quick-pick'].forEach((col) => {
            const th = document.createElement('th');
            th.textContent = col;
            htr.appendChild(th);
        });
        thead.appendChild(htr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        repoIds.forEach((repoId) => {
            const branchInfos = branchMap[repoId] || [];
            tbody.appendChild(buildAssignmentRow(repoId, branchInfos, chosenBranch));
        });
        table.appendChild(tbody);
        tableWrapper.appendChild(table);
        stepContent.appendChild(tableWrapper);
    }

    // ---- Actions ----
    const actions = document.createElement('div');
    actions.className = 'form-actions mt-24';

    const backBtn = document.createElement('button');
    backBtn.type      = 'button';
    backBtn.className = 'btn btn-secondary';
    backBtn.textContent = '← Back';
    backBtn.addEventListener('click', () => onBack());

    const confirmBtn = document.createElement('button');
    confirmBtn.type      = 'button';
    confirmBtn.className = 'btn btn-primary';
    confirmBtn.textContent = 'Confirm';
    confirmBtn.addEventListener('click', () => {
        // Collect per-repo branch assignments from all text inputs.
        // Intentional fallback: if a user clears a text input, `inp.value.trim()`
        // returns an empty string which would produce an invalid assignment. The
        // `|| chosenBranch` guard silently reverts that field to the Step 1 branch
        // rather than submitting an empty value. This is deliberate UX behaviour —
        // do not replace with a validation error without updating the README and QA tests.
        /** @type {Record<string, string>} */
        const assignments = {};

        const inputs = stepContent.querySelectorAll('input.branch-assignment-input');
        inputs.forEach((inp) => {
            const rid = inp.getAttribute('data-repo-id');
            if (rid) {
                assignments[rid] = inp.value.trim() || chosenBranch;
            }
        });

        onConfirm(assignments);
    });

    actions.appendChild(backBtn);
    actions.appendChild(confirmBtn);
    stepContent.appendChild(actions);
}

// ---------------------------------------------------------------------------
// Step 3 — Results
// ---------------------------------------------------------------------------

/**
 * Result row outcome category.
 *
 * @typedef {'success'|'conflict'|'error'} OutcomeType
 */

/**
 * Build a CSS class string for a result outcome cell.
 *
 * Precedence: `conflict` is checked first and overrides `success`. A row where
 * both `conflict` and `success` are `true` is treated as a conflict (red), not
 * a success. A row where both are `false` is an error (also red).
 *
 * @param {boolean} success
 * @param {boolean} conflict
 * @returns {string}
 */
function outcomeClass(success, conflict) {
    if (conflict) return 'text-danger';
    if (success)  return 'text-success';
    return 'text-danger';
}

/**
 * Build a human-readable outcome label.
 *
 * Precedence: `conflict` is checked first and overrides `success`. A row where
 * both `conflict` and `success` are `true` is labelled "Conflict", not "Success".
 * A row where both are `false` is labelled "Error".
 *
 * @param {boolean} success
 * @param {boolean} conflict
 * @returns {string}
 */
function outcomeLabel(success, conflict) {
    if (conflict) return 'Conflict';
    if (success)  return 'Success';
    return 'Error';
}

/**
 * Build the results `<tbody>` row for a single repository.
 *
 * @param {string} repoId
 * @param {{ success: boolean, conflict: boolean, error?: string }} result
 * @returns {HTMLTableRowElement}
 */
function buildResultRow(repoId, result) {
    const { success = false, conflict = false, error } = result || {};

    const tr = document.createElement('tr');

    // Repository name
    const nameCell = document.createElement('td');
    nameCell.className = 'repo-name-cell';
    const nameSpan = document.createElement('span');
    nameSpan.className   = 'repo-name font-mono text-sm';
    nameSpan.textContent = repoId;
    nameCell.appendChild(nameSpan);
    tr.appendChild(nameCell);

    // Outcome
    const outcomeCell = document.createElement('td');
    outcomeCell.className = `outcome-cell ${outcomeClass(success, conflict)}`;
    outcomeCell.textContent = outcomeLabel(success, conflict);
    tr.appendChild(outcomeCell);

    // Detail / message
    const detailCell = document.createElement('td');
    detailCell.className = 'detail-cell';

    if (conflict) {
        // Prominent conflict message
        const conflictMsg = document.createElement('span');
        conflictMsg.className   = 'conflict-message text-danger';
        conflictMsg.textContent = 'Merge conflicts detected. Please resolve conflicts manually in your editor.';
        detailCell.appendChild(conflictMsg);
    } else if (error) {
        const errSpan = document.createElement('span');
        errSpan.className   = 'error-message text-secondary text-sm';
        errSpan.textContent = error;
        detailCell.appendChild(errSpan);
    } else if (success) {
        detailCell.textContent = '—';
    }

    tr.appendChild(detailCell);

    return tr;
}

/**
 * Render the results table given the API response.
 *
 * @param {HTMLElement} stepContent
 * @param {string}      projectId
 * @param {string}      wid
 * @param {Record<string, { success: boolean, conflict: boolean, error?: string }>} results
 */
function renderResultsTable(stepContent, projectId, wid, results) {
    clearElement(stepContent);

    const repoIds = Object.keys(results || {});

    const hasConflicts = repoIds.some((id) => results[id] && results[id].conflict);
    const hasErrors    = repoIds.some((id) => results[id] && !results[id].success && !results[id].conflict);
    const allSuccess   = repoIds.length > 0 && repoIds.every((id) => results[id] && results[id].success && !results[id].conflict);

    // ---- Summary banner ----
    if (allSuccess) {
        const banner = document.createElement('div');
        banner.className = 'result-banner result-banner-success text-success mb-16';
        banner.textContent = 'All branches switched successfully.';
        stepContent.appendChild(banner);
    } else if (hasConflicts) {
        const banner = document.createElement('div');
        banner.className = 'result-banner result-banner-warning text-danger mb-16';
        banner.textContent = 'Some repositories have merge conflicts. Please resolve them manually.';
        stepContent.appendChild(banner);
    } else if (hasErrors) {
        const banner = document.createElement('div');
        banner.className = 'result-banner result-banner-error text-danger mb-16';
        banner.textContent = 'Some repositories encountered errors during the branch switch.';
        stepContent.appendChild(banner);
    }

    // ---- Results table ----
    if (repoIds.length === 0) {
        const empty = document.createElement('p');
        empty.className   = 'empty-state-inline text-secondary';
        empty.textContent = 'No results returned.';
        stepContent.appendChild(empty);
    } else {
        const tableWrapper = document.createElement('div');
        tableWrapper.className = 'table-wrapper';

        const table = document.createElement('table');
        table.className = 'data-table branch-results-table';

        const thead = document.createElement('thead');
        const htr   = document.createElement('tr');
        ['Repository', 'Outcome', 'Details'].forEach((col) => {
            const th = document.createElement('th');
            th.textContent = col;
            htr.appendChild(th);
        });
        thead.appendChild(htr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        repoIds.forEach((repoId) => {
            tbody.appendChild(buildResultRow(repoId, results[repoId]));
        });
        table.appendChild(tbody);
        tableWrapper.appendChild(table);
        stepContent.appendChild(tableWrapper);
    }

    // ---- Done button ----
    const actions = document.createElement('div');
    actions.className = 'form-actions mt-24';

    const doneBtn = document.createElement('button');
    doneBtn.type      = 'button';
    doneBtn.className = 'btn btn-primary';
    doneBtn.textContent = 'Done';
    doneBtn.addEventListener('click', () => {
        const target = `#/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wid)}`;
        if (_router) {
            _router.navigate(target);
        } else {
            location.hash = target;
        }
    });

    actions.appendChild(doneBtn);
    stepContent.appendChild(actions);
}

/**
 * Render Step 3 into `stepContent` — submits the assignments and then shows
 * the results table.
 *
 * @param {HTMLElement}              stepContent
 * @param {string}                   projectId
 * @param {string}                   wid
 * @param {Record<string, string>}   assignments  - Per-repo branch assignments.
 */
function renderStep3(stepContent, projectId, wid, assignments) {
    showLoading(stepContent, 'Switching branches… this may take a moment.');

    api.branches.switch(projectId, wid, assignments).then((response) => {
        if (!stepContent.isConnected) return;

        const results = (response && response.results) ? response.results : {};
        renderResultsTable(stepContent, projectId, wid, results);

    }).catch((err) => {
        if (!stepContent.isConnected) return;
        clearElement(stepContent);

        const errEl = document.createElement('div');
        errEl.className = 'empty-state';

        const title = document.createElement('h3');
        title.textContent = 'Branch switch failed';
        errEl.appendChild(title);

        const msg = document.createElement('p');
        msg.className   = 'text-secondary mt-8';
        msg.textContent = err.message || 'An unexpected error occurred during the branch switch.';
        errEl.appendChild(msg);

        showToast(err.message || 'Branch switch failed.', 'error');

        // Navigate back to workspace on fatal error
        const doneBtn = document.createElement('button');
        doneBtn.type      = 'button';
        doneBtn.className = 'btn btn-secondary mt-16';
        doneBtn.textContent = '← Back to Workspace';
        doneBtn.addEventListener('click', () => {
            const target = `#/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wid)}`;
            if (_router) {
                _router.navigate(target);
            } else {
                location.hash = target;
            }
        });
        errEl.appendChild(doneBtn);

        stepContent.appendChild(errEl);
    });
}

// ---------------------------------------------------------------------------
// Wizard shell — builds page chrome and dispatches step renders
// ---------------------------------------------------------------------------

/**
 * Render the full wizard into `container`.
 *
 * Builds the page header (with breadcrumb), step indicator, and a `stepContent`
 * area. Step transitions re-render only `stepContent` and the step indicator.
 *
 * @param {HTMLElement} container
 * @param {string}      projectId
 * @param {string}      wid
 */
function renderWizard(container, projectId, wid) {
    clearElement(container);

    // ---- Page header with breadcrumb ----
    const header = document.createElement('div');
    header.className = 'page-header workspace-detail-header';

    const breadcrumb = document.createElement('nav');
    breadcrumb.className = 'breadcrumb';
    breadcrumb.setAttribute('aria-label', 'Breadcrumb');

    const projectLink = document.createElement('a');
    projectLink.href        = `#/projects/${encodeURIComponent(projectId)}`;
    projectLink.textContent = projectId;
    projectLink.className   = 'breadcrumb-link';
    if (_router) {
        projectLink.addEventListener('click', (e) => {
            e.preventDefault();
            _router.navigate(`#/projects/${encodeURIComponent(projectId)}`);
        });
    }

    const sep1 = document.createElement('span');
    sep1.className   = 'breadcrumb-sep';
    sep1.textContent = ' / ';
    sep1.setAttribute('aria-hidden', 'true');

    const wsLink = document.createElement('a');
    wsLink.href        = `#/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wid)}`;
    wsLink.textContent = wid;
    wsLink.className   = 'breadcrumb-link';
    if (_router) {
        wsLink.addEventListener('click', (e) => {
            e.preventDefault();
            _router.navigate(`#/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wid)}`);
        });
    }

    const sep2 = document.createElement('span');
    sep2.className   = 'breadcrumb-sep';
    sep2.textContent = ' / ';
    sep2.setAttribute('aria-hidden', 'true');

    const currentPage = document.createElement('span');
    currentPage.className   = 'breadcrumb-current';
    currentPage.textContent = 'Switch Branches';
    currentPage.setAttribute('aria-current', 'page');

    breadcrumb.appendChild(projectLink);
    breadcrumb.appendChild(sep1);
    breadcrumb.appendChild(wsLink);
    breadcrumb.appendChild(sep2);
    breadcrumb.appendChild(currentPage);
    header.appendChild(breadcrumb);

    const titleEl = document.createElement('h1');
    titleEl.className   = 'workspace-detail-title';
    titleEl.textContent = 'Switch Branches';
    header.appendChild(titleEl);

    container.appendChild(header);

    // ---- Card wrapping the wizard ----
    const card = document.createElement('div');
    card.className = 'card branch-switch-wizard';

    // Step indicator (will be replaced on transitions)
    let stepIndicator = buildStepIndicator(STEP_CHOOSE);
    card.appendChild(stepIndicator);

    // Step content area
    const stepContent = document.createElement('div');
    stepContent.className = 'wizard-step-content';
    card.appendChild(stepContent);

    container.appendChild(card);

    // ---- State ----
    // These closure variables cache the Step 1 result so that navigating Back
    // from Step 2 restores the previous branch name and avoids a redundant
    // api.branches.list() call.
    let savedBranchName = '';
    let savedBranchData = null;

    // ---- Step navigation helpers ----

    function goToStep(stepNum) {
        // Replace step indicator
        const newIndicator = buildStepIndicator(stepNum);
        card.replaceChild(newIndicator, stepIndicator);
        stepIndicator = newIndicator;
    }

    // ---- Step 1 ----
    function showStep1(initialBranch = '') {
        goToStep(STEP_CHOOSE);
        renderStep1(
            stepContent,
            projectId,
            wid,
            initialBranch,
            (branchName, branchData) => {
                savedBranchName = branchName;
                savedBranchData = branchData;
                showStep2();
            },
        );
    }

    // ---- Step 2 ----
    function showStep2() {
        goToStep(STEP_ASSIGN);
        renderStep2(
            stepContent,
            savedBranchName,
            savedBranchData,
            () => showStep1(savedBranchName),   // Back → preserve branch name
            (assignments) => showStep3(assignments),
        );
    }

    // ---- Step 3 ----
    function showStep3(assignments) {
        goToStep(STEP_RESULTS);
        renderStep3(stepContent, projectId, wid, assignments);
    }

    // Start at Step 1
    showStep1(savedBranchName);
}

// ---------------------------------------------------------------------------
// Public view entry point
// ---------------------------------------------------------------------------

/**
 * Render the Branch Switch Wizard view.
 *
 * The router calls this function with the route parameters extracted from
 * `#/projects/:id/workspaces/:wid/branch-switch`.
 *
 * @param {HTMLElement} container - The `#app` DOM element provided by the router.
 * @param {{ id: string, wid: string }} params - Route parameters.
 */
export function renderBranchSwitch(container, params) {
    const projectId = params.id;
    const wid       = params.wid;

    document.title = 'Branch Switch - ' + APP_NAME_SHORT;
    renderWizard(container, projectId, wid);
}

```
###  Path: `/gui/public/js/views/dashboard.js`

```js
/**
 * Dashboard View — Repo Parallelizer GUI.
 *
 * Renders the application's landing page: a list of all projects (with repo
 * and workspace counts) and a "Create Project" quick-action form.
 *
 * @param {HTMLElement} container - The `#app` root element supplied by the router.
 * @param {Object}      _params   - Route params (none for this route).
 */

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { createFormField, validateRequired } from '../components/form-helpers.js';
import { clearElement } from '../utils/dom.js';
import { APP_NAME_SHORT } from '../utils/constants.js';

// ---------------------------------------------------------------------------
// Debounce helper
// ---------------------------------------------------------------------------

/**
 * Return a debounced version of `fn` that delays invocation by `wait` ms.
 *
 * @template {(...args: unknown[]) => void} T
 * @param {T} fn
 * @param {number} wait - Delay in milliseconds.
 * @returns {T}
 */
function debounce(fn, wait) {
    let timer;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), wait);
    };
}

// ---------------------------------------------------------------------------
// Router instance — imported lazily to avoid circular-dependency issues.
// app.js sets this via setRouter() immediately after instantiation.
// ---------------------------------------------------------------------------

/** @type {import('../router.js').Router|null} */
let _router = null;

/**
 * Inject the router instance so the dashboard can call `router.navigate()`.
 * Called from app.js before the router starts.
 *
 * @param {import('../router.js').Router} router
 */
export function setRouter(router) {
    _router = router;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a single project card DOM element.
 *
 * @param {{ id?: string, Id?: string, Name?: string, name?: string,
 *           Description?: string, description?: string,
 *           Repositories?: Array }} project
 * @param {number} workspaceCount
 * @returns {HTMLElement}
 */
function buildProjectCard(project, workspaceCount) {
    // The backend may use either capitalised or lowercase keys — normalise.
    const id          = project.Id          || project.id          || '';
    const name        = project.Name        || project.name        || id;
    const description = project.Description || project.description || '';
    const repoCount   = Array.isArray(project.Repositories)
        ? project.Repositories.length
        : (Array.isArray(project.repositories) ? project.repositories.length : 0);

    const card = document.createElement('div');
    card.className = 'card project-card';

    // Header row: name + navigate link
    const header = document.createElement('div');
    header.className = 'card-header';

    const titleLink = document.createElement('a');
    titleLink.className = 'project-card-title';
    titleLink.href = `#/projects/${encodeURIComponent(id)}`;
    titleLink.textContent = name;
    titleLink.addEventListener('click', (e) => {
        e.preventDefault();
        if (_router) {
            _router.navigate(`#/projects/${encodeURIComponent(id)}`);
        }
    });

    const projectId = document.createElement('span');
    projectId.className = 'project-card-id text-muted';
    projectId.textContent = id;

    header.appendChild(titleLink);
    header.appendChild(projectId);
    card.appendChild(header);

    // Optional description
    if (description) {
        const desc = document.createElement('p');
        desc.className = 'project-card-description text-secondary';
        desc.textContent = description;
        card.appendChild(desc);
    }

    // Stats row
    const stats = document.createElement('div');
    stats.className = 'project-card-stats';

    const repoStat = document.createElement('span');
    repoStat.className = 'stat-chip';
    repoStat.textContent = `${repoCount} ${repoCount === 1 ? 'repository' : 'repositories'}`;

    const wsStat = document.createElement('span');
    wsStat.className = 'stat-chip';
    wsStat.textContent = `${workspaceCount} ${workspaceCount === 1 ? 'workspace' : 'workspaces'}`;

    const separator = document.createElement('span');
    separator.className = 'stat-separator';
    separator.textContent = '·';

    stats.appendChild(repoStat);
    stats.appendChild(separator);
    stats.appendChild(wsStat);
    card.appendChild(stats);

    return card;
}

/**
 * Render a loading skeleton inside a container element.
 *
 * @param {HTMLElement} el
 */
function showLoading(el) {
    clearElement(el);
    const wrapper = document.createElement('div');
    wrapper.className = 'loading-indicator';
    wrapper.setAttribute('aria-live', 'polite');
    wrapper.setAttribute('aria-label', 'Loading projects\u2026');

    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.textContent = 'Loading projects\u2026';

    wrapper.appendChild(spinner);
    wrapper.appendChild(label);
    el.appendChild(wrapper);
}

// ---------------------------------------------------------------------------
// Filter / Sort toolbar
// ---------------------------------------------------------------------------

/**
 * Represents the current filter and sort state for the project list toolbar.
 *
 * This object flows between {@link renderDashboard}, {@link buildFilterToolbar},
 * {@link applyFiltersAndSort}, and {@link renderProjectGrid} — covering both
 * toolbar control rendering and the filter/sort logic applied to the project list.
 *
 * @typedef {Object} FilterState
 * @property {string} search - Free-text search query matched against project names
 *   and descriptions. Empty string means "no search filter applied".
 * @property {string} repoId - ID of the repository to filter by, or `''` to show
 *   projects from all repositories ("All repositories" option). Matches `repo.id`
 *   / `repo.Id` values returned by `api.repositories.list()`.
 * @property {'alpha'|'activity'} sort - Sort order for the project list.
 *   - `'alpha'`    — alphabetical by project name (A → Z). This is the default.
 *   - `'activity'` — most recently active project first (Last Activity order).
 *
 * @example
 * // Default state — no filter, alphabetical sort
 * const filterState = { search: '', repoId: '', sort: 'alpha' };
 *
 * @example
 * // Filter to a specific repo, sorted by last activity
 * const filterState = { search: 'api', repoId: 'backend-repo', sort: 'activity' };
 */

/**
 * Build the filter/sort toolbar for the project list.
 *
 * Fetches `api.repositories.list()` to populate the repository dropdown.
 * If the fetch fails the toolbar renders without the repository dropdown and
 * shows a toast error.
 *
 * @param {FilterState} initialState      - The current filter/sort values.
 * @param {function(FilterState): void} onFilterChange - Callback fired when any
 *   control value changes.
 * @returns {Promise<HTMLElement>}
 */
async function buildFilterToolbar(initialState, onFilterChange) {
    const bar = document.createElement('div');
    bar.className = 'project-filter-toolbar';

    // ---- Current state (mutated as controls change) ----
    const state = { ...initialState };

    // ---- Helper: notify caller ----
    const notify = () => onFilterChange({ ...state });

    // ---- Search label + input ----
    const searchLabel = document.createElement('label');
    searchLabel.className = 'filter-label';
    searchLabel.textContent = 'Search:';
    searchLabel.setAttribute('for', 'project-filter-search');

    const searchInput = document.createElement('input');
    searchInput.type        = 'search';
    searchInput.id          = 'project-filter-search';
    searchInput.className   = 'form-input project-filter-search';
    searchInput.placeholder = 'Search projects\u2026';
    searchInput.value       = state.search;
    searchInput.setAttribute('aria-label', 'Search projects');

    const debouncedSearch = debounce(() => {
        state.search = searchInput.value;
        notify();
    }, 250);
    searchInput.addEventListener('input', debouncedSearch);

    bar.appendChild(searchLabel);
    bar.appendChild(searchInput);

    // ---- Repository filter label + dropdown ----
    let repos = [];
    try {
        repos = await api.repositories.list();
    } catch (err) {
        showToast(err.message || 'Failed to load repositories for filter.', 'error');
    }

    const repoLabel = document.createElement('label');
    repoLabel.className = 'filter-label';
    repoLabel.textContent = 'Repository:';
    repoLabel.setAttribute('for', 'project-filter-repo');

    const repoSelect = document.createElement('select');
    repoSelect.id = 'project-filter-repo';
    repoSelect.className = 'form-select project-filter-repo';
    repoSelect.setAttribute('aria-label', 'Filter by repository');

    if (Array.isArray(repos) && repos.length > 0) {
        const allOpt = document.createElement('option');
        allOpt.value       = '';
        allOpt.textContent = 'All repositories';
        repoSelect.appendChild(allOpt);

        repos.forEach((repo) => {
            const opt = document.createElement('option');
            opt.value       = repo.id || repo.Id || '';
            opt.textContent = repo.name || repo.Name || opt.value;
            if (opt.value === state.repoId) opt.selected = true;
            repoSelect.appendChild(opt);
        });

        repoSelect.addEventListener('change', () => {
            state.repoId = repoSelect.value;
            notify();
        });
    } else {
        const noReposOpt = document.createElement('option');
        noReposOpt.textContent = 'No repositories';
        repoSelect.appendChild(noReposOpt);
        repoSelect.disabled = true;
    }

    bar.appendChild(repoLabel);
    bar.appendChild(repoSelect);

    // ---- Sort label + selector ----
    const sortLabel = document.createElement('label');
    sortLabel.className = 'filter-label';
    sortLabel.textContent = 'Sort:';
    sortLabel.setAttribute('for', 'project-filter-sort');

    const sortSelect = document.createElement('select');
    sortSelect.id = 'project-filter-sort';
    sortSelect.className = 'form-select project-filter-sort';
    sortSelect.setAttribute('aria-label', 'Sort projects');

    const sortOptions = [
        { value: 'alpha',    label: 'Alphabetical' },
        { value: 'activity', label: 'Last Activity' },
    ];

    sortOptions.forEach(({ value, label }) => {
        const opt = document.createElement('option');
        opt.value       = value;
        opt.textContent = label;
        if (value === state.sort) opt.selected = true;
        sortSelect.appendChild(opt);
    });

    sortSelect.addEventListener('change', () => {
        state.sort = sortSelect.value;
        notify();
    });

    bar.appendChild(sortLabel);
    bar.appendChild(sortSelect);

    return bar;
}

// ---------------------------------------------------------------------------
// Create Project form
// ---------------------------------------------------------------------------

/**
 * Build and return the "Create Project" inline form section.
 * When submitted successfully, `onSuccess` is called so the caller can
 * re-render the project list.
 *
 * @param {function(): void} onSuccess
 * @returns {HTMLElement}
 */
function buildCreateProjectSection(onSuccess) {
    const section = document.createElement('section');
    section.className = 'create-project-section';

    // Toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn btn-primary';
    toggleBtn.textContent = '+ Create Project';
    section.appendChild(toggleBtn);

    // Collapsible form wrapper (hidden by default)
    const formWrapper = document.createElement('div');
    formWrapper.className = 'create-project-form-wrapper';
    formWrapper.hidden = true;
    section.appendChild(formWrapper);

    // Form
    const form = document.createElement('form');
    form.className = 'create-project-form card';
    form.noValidate = true;

    const formTitle = document.createElement('h3');
    formTitle.className = 'form-section-title';
    formTitle.textContent = 'New Project';
    form.appendChild(formTitle);

    const nameField = createFormField('Name', 'text', 'name', {
        required: true,
        placeholder: 'e.g. my-project',
    });
    form.appendChild(nameField);

    const descField = createFormField('Description', 'textarea', 'description', {
        placeholder: 'Optional — short description of the project.',
        rows: 2,
    });
    form.appendChild(descField);

    // Action row
    const actions = document.createElement('div');
    actions.className = 'form-actions';

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'btn btn-primary';
    submitBtn.textContent = 'Create';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = 'Cancel';

    actions.appendChild(submitBtn);
    actions.appendChild(cancelBtn);
    form.appendChild(actions);

    formWrapper.appendChild(form);

    // ---------------------------------------------------------------------------
    // Behaviour
    // ---------------------------------------------------------------------------

    // Toggle form visibility
    toggleBtn.addEventListener('click', () => {
        formWrapper.hidden = !formWrapper.hidden;
        if (!formWrapper.hidden) {
            const nameInput = form.querySelector('[name="name"]');
            if (nameInput) nameInput.focus();
        }
    });

    cancelBtn.addEventListener('click', () => {
        form.reset();
        formWrapper.hidden = true;
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!validateRequired(form, ['name'])) return;

        const name        = form.querySelector('[name="name"]').value.trim();
        const description = form.querySelector('[name="description"]').value.trim();

        submitBtn.disabled = true;
        submitBtn.textContent = 'Creating…';

        try {
            await api.projects.create({ name, description: description || undefined });
            showToast(`Project "${name}" created successfully.`, 'success');
            form.reset();
            formWrapper.hidden = true;
            onSuccess();
        } catch (err) {
            showToast(err.message || 'Failed to create project.', 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create';
        }
    });

    return section;
}

// ---------------------------------------------------------------------------
// Project list — data cache
// ---------------------------------------------------------------------------

/**
 * Module-level cache of fully-enriched project detail objects.
 * Each entry is `{ fullProject, wsCount }` as returned by the API fetch.
 * Populated by `renderProjectList()` and consumed by `applyFiltersAndSort()`.
 *
 * @type {Array<{ fullProject: Object, wsCount: number }>}
 */
let _allProjects = [];

// ---------------------------------------------------------------------------
// Filter / sort logic
// ---------------------------------------------------------------------------

/**
 * Apply the current filter/sort state to `_allProjects` and return the
 * matching subset in the requested order.
 *
 * Filter rules (all applied together — AND semantics):
 *   - `search`  — case-insensitive substring match against name, ID, and
 *                 description. Empty string means no filter.
 *   - `repoId`  — project must contain a repository whose `id`/`Id` equals
 *                 `repoId`. Empty string means no filter.
 *
 * Sort rules:
 *   - `'alpha'`    — ascending by name (case-insensitive); tiebreaker: project
 *                    ID ascending.
 *   - `'activity'` — descending by `LastActivity` / `lastActivity`; entries
 *                    with `null`/`undefined` activity sort last; tiebreaker:
 *                    name ascending (case-insensitive).
 *
 * @param {FilterState} filterState
 * @returns {Array<{ fullProject: Object, wsCount: number }>}
 */
export function applyFiltersAndSort(filterState, allProjects) {
    const { search, repoId, sort } = filterState;
    const needle = search.trim().toLowerCase();

    let result = allProjects.filter(({ fullProject }) => {
        const id   = (fullProject.Id   || fullProject.id          || '').toLowerCase();
        const name = (fullProject.Name || fullProject.name        || '').toLowerCase();
        const desc = (fullProject.Description || fullProject.description || '').toLowerCase();

        // Search filter — substring match across name, ID, description.
        if (needle && !name.includes(needle) && !id.includes(needle) && !desc.includes(needle)) {
            return false;
        }

        // Repository filter — project must contain the selected repo.
        // Repositories is stored as string[] (repo IDs) on the server, but
        // guard against object entries for defensive compatibility.
        if (repoId) {
            const repos = Array.isArray(fullProject.Repositories)
                ? fullProject.Repositories
                : (Array.isArray(fullProject.repositories) ? fullProject.repositories : []);
            const hasRepo = repos.some((r) =>
                (typeof r === 'string' ? r : (r.id || r.Id || '')) === repoId,
            );
            if (!hasRepo) return false;
        }

        return true;
    });

    // Sort
    if (sort === 'activity') {
        result = result.slice().sort((a, b) => {
            const aTime = a.fullProject.LastActivity || a.fullProject.lastActivity || null;
            const bTime = b.fullProject.LastActivity || b.fullProject.lastActivity || null;

            // null/undefined sorts last
            if (aTime === null && bTime === null) {
                // tiebreaker: name ascending
                return (a.fullProject.Name || a.fullProject.name || '')
                    .toLowerCase()
                    .localeCompare((b.fullProject.Name || b.fullProject.name || '').toLowerCase());
            }
            if (aTime === null) return 1;
            if (bTime === null) return -1;

            // Descending by activity timestamp
            if (aTime > bTime) return -1;
            if (aTime < bTime) return 1;

            // tiebreaker: name ascending
            return (a.fullProject.Name || a.fullProject.name || '')
                .toLowerCase()
                .localeCompare((b.fullProject.Name || b.fullProject.name || '').toLowerCase());
        });
    } else {
        // 'alpha' — ascending by name (case-insensitive); tiebreaker: project ID ascending.
        // Uses localeCompare() for consistency with the activity-sort tiebreaker above.
        result = result.slice().sort((a, b) => {
            const aName = (a.fullProject.Name || a.fullProject.name || '').toLowerCase();
            const bName = (b.fullProject.Name || b.fullProject.name || '').toLowerCase();
            const nameCmp = aName.localeCompare(bName);
            if (nameCmp !== 0) return nameCmp;
            // tiebreaker: ID ascending
            const aId = (a.fullProject.Id || a.fullProject.id || '').toLowerCase();
            const bId = (b.fullProject.Id || b.fullProject.id || '').toLowerCase();
            return aId.localeCompare(bId);
        });
    }

    return result;
}

// ---------------------------------------------------------------------------
// Project grid renderer
// ---------------------------------------------------------------------------

/**
 * Render a (possibly empty) array of project detail objects into
 * `listContainer`.
 *
 * Shows "No projects match the current filters." when `filtered` is empty but
 * `hasAnyProjects` is `true` (i.e. filters excluded everything).
 * Shows the original "No projects yet." message when there are no projects at all.
 * Otherwise renders the project cards inside a `.project-grid` wrapper.
 *
 * @param {HTMLElement}                                  listContainer
 * @param {Array<{ fullProject: Object, wsCount: number }>} filtered
 * @param {boolean} hasAnyProjects - Whether the unfiltered project list is
 *   non-empty. Used to choose the correct empty-state message.
 */
function renderProjectGrid(listContainer, filtered, hasAnyProjects) {
    clearElement(listContainer);

    if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        if (!hasAnyProjects) {
            empty.textContent = 'No projects yet. Use the "Create Project" button to add one.';
        } else {
            empty.textContent = 'No projects match the current filters.';
        }
        listContainer.appendChild(empty);
        return;
    }

    const grid = document.createElement('div');
    grid.className = 'project-grid';

    filtered.forEach(({ fullProject, wsCount }) => {
        grid.appendChild(buildProjectCard(fullProject, wsCount));
    });

    listContainer.appendChild(grid);
}

// ---------------------------------------------------------------------------
// Project list — fetch + render
// ---------------------------------------------------------------------------

/**
 * Fetch all project data from the API, update `_allProjects`, then apply
 * the current `filterState` and render the result into `listContainer`.
 *
 * Workspace counts are fetched in parallel for each project.  If a workspace
 * fetch fails the count is shown as "0 workspaces" rather than breaking the
 * whole list.
 *
 * @param {HTMLElement} listContainer - Element to render the list into.
 * @param {FilterState} filterState   - Current filter/sort state to apply
 *   after the data is loaded.
 */
async function renderProjectList(listContainer, filterState) {
    showLoading(listContainer);

    let projects;
    try {
        projects = await api.projects.list();
    } catch (err) {
        clearElement(listContainer);
        const errMsg = document.createElement('div');
        errMsg.className = 'empty-state error-state';
        errMsg.textContent = `Failed to load projects: ${err.message}`;
        listContainer.appendChild(errMsg);
        showToast(err.message || 'Failed to load projects.', 'error');
        return;
    }

    if (!Array.isArray(projects) || projects.length === 0) {
        _allProjects = [];
        renderProjectGrid(listContainer, [], false);
        return;
    }

    // Fetch full project data + workspace counts in parallel per project.
    const projectDetails = await Promise.all(
        projects.map(async (project) => {
            const id = project.Id || project.id || '';
            let fullProject = project;
            let wsCount = 0;
            try {
                const [full, workspaces] = await Promise.all([
                    api.projects.get(id),
                    api.workspaces.list(id),
                ]);
                fullProject = full;
                wsCount = Array.isArray(workspaces) ? workspaces.length : 0;
            } catch (_err) {
                // Degrade gracefully — show index data with 0 counts.
            }
            return { fullProject, wsCount };
        }),
    );

    _allProjects = projectDetails;

    const filtered = applyFiltersAndSort(filterState, _allProjects);
    renderProjectGrid(listContainer, filtered, _allProjects.length > 0);
}

// ---------------------------------------------------------------------------
// Public export — view function
// ---------------------------------------------------------------------------

/**
 * Render the dashboard view.
 *
 * @param {HTMLElement} container - The `#app` root element.
 * @param {Object}      _params   - Route params (unused).
 */
export async function renderDashboard(container, _params) {
    document.title = 'Dashboard - ' + APP_NAME_SHORT;

    // -----------------------------------------------------------------------
    // Page header
    // -----------------------------------------------------------------------
    const header = document.createElement('div');
    header.className = 'page-header';

    const title = document.createElement('h1');
    title.textContent = 'Projects';
    header.appendChild(title);

    container.appendChild(header);

    // -----------------------------------------------------------------------
    // Project list section (declared early so onFilterChange can reference it)
    // -----------------------------------------------------------------------
    const listContainer = document.createElement('div');
    listContainer.className = 'project-list-container';

    // -----------------------------------------------------------------------
    // Filter / sort toolbar (inserted between header and project list)
    // -----------------------------------------------------------------------

    /** @type {FilterState} */
    const filterState = { search: '', repoId: '', sort: 'alpha' };

    /**
     * Called whenever a toolbar control changes.  Applies the updated
     * filter/sort state to the cached project data without re-fetching.
     *
     * @param {FilterState} newState
     */
    const onFilterChange = (newState) => {
        Object.assign(filterState, newState);
        const filtered = applyFiltersAndSort(filterState, _allProjects);
        renderProjectGrid(listContainer, filtered, _allProjects.length > 0);
    };

    const toolbar = await buildFilterToolbar(filterState, onFilterChange);
    container.appendChild(toolbar);

    // Insert list container after toolbar
    container.appendChild(listContainer);

    // -----------------------------------------------------------------------
    // Create Project section
    // -----------------------------------------------------------------------
    const createSection = buildCreateProjectSection(() => {
        // Re-fetch all project data from the API and re-apply the current
        // filter/sort state so newly created projects appear immediately.
        renderProjectList(listContainer, filterState);
    });
    container.appendChild(createSection);

    // -----------------------------------------------------------------------
    // Initial load
    // -----------------------------------------------------------------------
    await renderProjectList(listContainer, filterState);
}

```
###  Path: `/gui/public/js/views/error-log.js`

```js
/**
 * Error Log View — Repo Parallelizer GUI.
 *
 * Renders a paginated, filterable table of error log entries fetched from the
 * REST API:
 *   - Severity and source filter dropdowns re-fetch entries on change.
 *   - Clicking a row toggles an inline `<pre>` detail panel below it.
 *   - "Clear All" button prompts a confirmation dialog and clears all entries.
 *   - Timestamps display relative time (e.g. "3 min ago") with the full ISO
 *     timestamp in the `title` tooltip.
 *   - Severity is rendered as a coloured badge using `.severity-error` or
 *     `.severity-warning` CSS classes.
 *   - All dynamic text is set via `textContent` (never `innerHTML`) for XSS
 *     safety.
 *
 * @param {HTMLElement} container - The `#app` root element supplied by the router.
 * @param {Object}      _params   - Route params (none for this route).
 */

import { api }          from '../api.js';
import { showToast }    from '../components/toast.js';
import { showConfirm }  from '../components/confirm-dialog.js';
import { normaliseErrorEntry } from '../utils/normalise.js';
import { relativeTime } from '../utils/time.js';
import { refreshNavBadge } from '../components/nav-badge.js';
import { APP_NAME_SHORT } from '../utils/constants.js';

// ---------------------------------------------------------------------------
// Severity options — kept in one place so filters and dropdowns stay in sync.
// ---------------------------------------------------------------------------

const SEVERITY_OPTIONS = [
    { value: 'all',     label: 'All Severities' },
    { value: 'error',   label: 'Error'          },
    { value: 'warning', label: 'Warning'        },
];

// ---------------------------------------------------------------------------
// Context breadcrumb helper
// ---------------------------------------------------------------------------

/**
 * Build a compact breadcrumb string from project / workspace / repository fields.
 *
 * @param {{ project: string, workspace: string, repository: string }} entry
 * @returns {string}
 */
function buildContextBreadcrumb(entry) {
    return [entry.project, entry.workspace, entry.repository]
        .filter(Boolean)
        .join(' / ') || '—';
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

/**
 * Build the filter bar containing the severity and source dropdowns plus the
 * "Clear All" button.
 *
 * @param {{ severity: string, source: string }} currentFilters
 * @param {Array<{ value: string, label: string }>} sourceOptions
 * @param {function({ severity: string, source: string }): void} onFilterChange
 * @param {function(): void} onClearAll
 * @returns {HTMLElement}
 */
function buildFilterBar(currentFilters, sourceOptions, onFilterChange, onClearAll) {
    const bar = document.createElement('div');
    bar.className = 'error-log-filter-bar';

    // ---- Severity dropdown ----
    const severityLabel = document.createElement('label');
    severityLabel.textContent = 'Severity:';
    severityLabel.setAttribute('for', 'error-log-severity-filter');
    severityLabel.className = 'filter-label';

    const severitySelect = document.createElement('select');
    severitySelect.id        = 'error-log-severity-filter';
    severitySelect.className = 'form-select';

    SEVERITY_OPTIONS.forEach(({ value, label }) => {
        const opt = document.createElement('option');
        opt.value       = value;
        opt.textContent = label;
        opt.selected    = value === currentFilters.severity;
        severitySelect.appendChild(opt);
    });

    // ---- Source dropdown ----
    const sourceLabel = document.createElement('label');
    sourceLabel.textContent = 'Source:';
    sourceLabel.setAttribute('for', 'error-log-source-filter');
    sourceLabel.className = 'filter-label';

    const sourceSelect = document.createElement('select');
    sourceSelect.id        = 'error-log-source-filter';
    sourceSelect.className = 'form-select';

    sourceOptions.forEach(({ value, label }) => {
        const opt = document.createElement('option');
        opt.value       = value;
        opt.textContent = label;
        opt.selected    = value === currentFilters.source;
        sourceSelect.appendChild(opt);
    });
    // ---- Clear All button ----
    const clearBtn = document.createElement('button');
    clearBtn.type      = 'button';
    clearBtn.className = 'btn btn-danger';
    clearBtn.textContent = 'Clear All';

    // ---- Event wiring ----
    function emitFilterChange() {
        onFilterChange({
            severity: severitySelect.value,
            source:   sourceSelect.value,
        });
    }

    severitySelect.addEventListener('change', emitFilterChange);
    sourceSelect.addEventListener('change', emitFilterChange);
    clearBtn.addEventListener('click', onClearAll);

    // ---- Assemble ----
    bar.appendChild(severityLabel);
    bar.appendChild(severitySelect);
    bar.appendChild(sourceLabel);
    bar.appendChild(sourceSelect);
    bar.appendChild(clearBtn);

    return bar;
}

// ---------------------------------------------------------------------------
// Table building
// ---------------------------------------------------------------------------

/**
 * Build the `<thead>` element for the error log table.
 *
 * @returns {HTMLTableSectionElement}
 */
function buildTableHead() {
    const thead = document.createElement('thead');
    const tr    = document.createElement('tr');

    ['Timestamp', 'Severity', 'Source', 'Context', 'Message'].forEach((label) => {
        const th = document.createElement('th');
        th.textContent = label;
        tr.appendChild(th);
    });

    thead.appendChild(tr);
    return thead;
}

/**
 * Build a severity badge `<span>` for the given severity string.
 *
 * @param {string} severity - 'error', 'warning', or any other string.
 * @returns {HTMLSpanElement}
 */
function buildSeverityBadge(severity) {
    const badge = document.createElement('span');
    const normalised = severity ? severity.toLowerCase() : '';
    badge.className = normalised
        ? `severity-badge severity-${normalised}`
        : 'severity-badge';
    badge.textContent = severity || '—';
    return badge;
}

/**
 * Build a table row pair: the main data row and a hidden detail row below it.
 *
 * Clicking the main row toggles the visibility of the detail row.
 *
 * @param {Object} rawEntry - Raw entry object from the API response.
 * @returns {DocumentFragment} A fragment containing the data row and the
 *   (initially hidden) detail row.
 */
function buildEntryRows(rawEntry) {
    const entry = normaliseErrorEntry(rawEntry);
    const frag  = document.createDocumentFragment();

    // ---- Main data row ----
    const tr = document.createElement('tr');
    tr.className = 'error-log-entry-row';
    tr.setAttribute('role', 'button');
    tr.setAttribute('tabindex', '0');
    tr.setAttribute('aria-expanded', 'false');

    // Timestamp cell
    const tsCell = document.createElement('td');
    tsCell.className = 'error-log-ts-cell';
    const tsSpan = document.createElement('span');
    tsSpan.textContent = relativeTime(entry.timestamp);
    tsSpan.title       = entry.timestamp;
    tsCell.appendChild(tsSpan);
    tr.appendChild(tsCell);

    // Severity cell
    const severityCell = document.createElement('td');
    severityCell.className = 'error-log-severity-cell';
    severityCell.appendChild(buildSeverityBadge(entry.severity));
    tr.appendChild(severityCell);

    // Source cell
    const sourceCell = document.createElement('td');
    sourceCell.className = 'error-log-source-cell';
    sourceCell.textContent = entry.source || '—';
    tr.appendChild(sourceCell);

    // Context cell
    const contextCell = document.createElement('td');
    contextCell.className = 'error-log-context-cell text-muted';
    contextCell.textContent = buildContextBreadcrumb(entry);
    tr.appendChild(contextCell);

    // Message cell
    const msgCell = document.createElement('td');
    msgCell.className = 'error-log-message-cell';
    msgCell.textContent = entry.message || '—';
    tr.appendChild(msgCell);

    // ---- Detail row (hidden by default) ----
    const detailTr = document.createElement('tr');
    detailTr.className = 'error-log-detail-row';
    detailTr.hidden    = true;

    const detailTd = document.createElement('td');
    detailTd.colSpan = 5;

    const pre = document.createElement('pre');
    pre.className  = 'error-log-detail-pre';
    pre.textContent = entry.details || '(no details)';

    detailTd.appendChild(pre);
    detailTr.appendChild(detailTd);

    // ---- Toggle behaviour ----
    function toggleDetail() {
        const expanded = detailTr.hidden;
        detailTr.hidden = !expanded;
        tr.setAttribute('aria-expanded', String(expanded));
        tr.classList.toggle('is-expanded', expanded);
    }

    tr.addEventListener('click', toggleDetail);
    tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleDetail();
        }
    });

    frag.appendChild(tr);
    frag.appendChild(detailTr);
    return frag;
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

/**
 * Build an empty-state row spanning all columns.
 *
 * @returns {HTMLTableRowElement}
 */
function buildEmptyRow() {
    const tr = document.createElement('tr');
    tr.className = 'error-log-empty-row';

    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'text-muted';
    td.textContent = 'No error log entries found.';

    tr.appendChild(td);
    return tr;
}

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

/**
 * Render the Error Log view into `container`.
 *
 * Called by the router whenever the user navigates to `#/error-log`.
 *
 * @param {HTMLElement} container - The `#app` root element supplied by the router.
 * @param {Object}      _params   - Route params (none for this route).
 */
export async function renderErrorLog(container, _params) {
    document.title = 'Error Log - ' + APP_NAME_SHORT;

    // ---- Active filter state ----
    const filters = {
        severity: 'all',
        source:   'all',
    };

    // Current source options (fetched from API; refreshed after clear).
    let sourceOptions = [{ value: 'all', label: 'All Sources' }];

    // ---- Scaffold ----
    container.textContent = '';

    const heading = document.createElement('h1');
    heading.textContent = 'Error Log';
    container.appendChild(heading);

    // Filter bar placeholder — re-created on each render.
    const filterBarSlot = document.createElement('div');
    filterBarSlot.className = 'error-log-filter-bar-slot';
    container.appendChild(filterBarSlot);

    // Summary line (e.g. "42 entries")
    const summary = document.createElement('p');
    summary.className = 'error-log-summary text-muted';
    container.appendChild(summary);

    // Table wrapper
    const tableWrapper = document.createElement('div');
    tableWrapper.className = 'table-responsive';
    container.appendChild(tableWrapper);

    const table = document.createElement('table');
    table.className = 'error-log-table';
    table.appendChild(buildTableHead());

    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    tableWrapper.appendChild(table);

    // ---- loadSources — fetches distinct source values and rebuilds filter bar ----
    async function loadSources() {
        try {
            const result = await api.errorLog.sources();
            const fetched = Array.isArray(result.sources) ? result.sources : [];
            sourceOptions = [
                { value: 'all', label: 'All Sources' },
                ...fetched.map((s) => ({ value: s, label: s })),
            ];
        } catch {
            // Non-fatal — keep the current sourceOptions (at minimum "All Sources").
        }
        rebuildFilterBar();
    }

    // ---- loadEntries — re-fetches and re-renders the tbody ----
    async function loadEntries() {
        tbody.textContent = '';
        summary.textContent = 'Loading…';

        /** @type {{ severity?: string, source?: string }} */
        const apiParams = {};
        if (filters.severity !== 'all') apiParams.severity = filters.severity;
        if (filters.source   !== 'all') apiParams.source   = filters.source;

        let result;
        try {
            result = await api.errorLog.list(apiParams);
        } catch (err) {
            summary.textContent = '';
            showToast(err.message || 'Failed to load error log.', 'error');
            return;
        }

        const entries = Array.isArray(result.entries) ? result.entries : [];
        const total   = typeof result.total === 'number' ? result.total : entries.length;

        summary.textContent = `${total} entr${total === 1 ? 'y' : 'ies'}`;

        if (entries.length === 0) {
            tbody.appendChild(buildEmptyRow());
            return;
        }

        entries.forEach((rawEntry) => {
            tbody.appendChild(buildEntryRows(rawEntry));
        });
    }

    // ---- onFilterChange ----
    function onFilterChange(newFilters) {
        filters.severity = newFilters.severity;
        filters.source   = newFilters.source;
        loadEntries();
    }

    // ---- onClearAll ----
    async function onClearAll() {
        try {
            await showConfirm(
                'Clear Error Log',
                'Delete all error log entries? This action cannot be undone.',
            );
        } catch {
            // User cancelled — do nothing.
            return;
        }

        try {
            await api.errorLog.clear();
            showToast('Error log cleared.', 'success');
            // Reset filters, refresh sources (log is now empty), and reload.
            filters.severity = 'all';
            filters.source   = 'all';
            await loadSources();
            loadEntries();
            refreshNavBadge();
        } catch (err) {
            showToast(err.message || 'Failed to clear error log.', 'error');
        }
    }

    // ---- rebuildFilterBar — replaces the filter bar DOM node ----
    function rebuildFilterBar() {
        filterBarSlot.textContent = '';
        filterBarSlot.appendChild(buildFilterBar(filters, sourceOptions, onFilterChange, onClearAll));
    }

    // ---- Initial render ----
    await loadSources();
    await loadEntries();
}

```
###  Path: `/gui/public/js/views/notes-collected.js`

```js
/**
 * Notes Collected View — Repo Parallelizer GUI.
 *
 * Two-panel layout:
 *   - Left sidebar: all workspaces grouped by project (collapsible groups).
 *     Workspaces with existing notes are visually distinguished with a
 *     `.has-notes` class on the sidebar item.
 *   - Right main panel: editable note cards for workspaces with non-empty notes.
 *     On initial load only non-empty note cards are rendered.
 *     Clicking a sidebar item for a workspace with a card scrolls to it.
 *     Clicking a sidebar item for a workspace without a card creates a new
 *     empty card and focuses the textarea.
 *     Each card auto-saves after 1000 ms of inactivity (debounce).
 *     Saving an empty note removes the card and clears the sidebar indicator.
 *
 * Data flow:
 *   1. `api.notes.list()` fetches the raw PascalCase `GET /api/notes` response.
 *   2. `normaliseNotesResponse()` converts it to a camelCase
 *      `{ projects: [{ projectId, projectName, workspaces: [{ workspaceId, notes }] }] }`
 *      structure used throughout the view.
 *   3. A `notesMap` (`Map<"${projectId}|${workspaceId}", string>`) mirrors the
 *      current note text in memory, keeping sidebar indicators and newly-created
 *      cards in sync with saves without re-fetching from the server.
 *
 * All dynamic text is set via `textContent` (never `innerHTML`) for XSS safety.
 *
 * @param {HTMLElement} container - The `#app` DOM element provided by the router.
 * @param {Object}      _params   - Route params (none for this route).
 */

import { api }                    from '../api.js';
import { showToast }              from '../components/toast.js';
import { normaliseNotesResponse } from '../utils/normalise.js';

// ---------------------------------------------------------------------------
// Internal DOM helpers
// ---------------------------------------------------------------------------

/**
 * Find a note card in the main panel by project + workspace ID using dataset
 * attributes (avoids CSS-escaping concerns with arbitrary ID strings).
 *
 * @param {HTMLElement} mainPanel
 * @param {string}      projectId
 * @param {string}      workspaceId
 * @returns {HTMLElement|null}
 */
function findCard(mainPanel, projectId, workspaceId) {
    for (const card of mainPanel.querySelectorAll('.notes-card')) {
        if (card.dataset.projectId === projectId && card.dataset.workspaceId === workspaceId) {
            return card;
        }
    }
    return null;
}

/**
 * Find a sidebar list item by project + workspace ID.
 *
 * @param {HTMLElement} sidebar
 * @param {string}      projectId
 * @param {string}      workspaceId
 * @returns {HTMLElement|null}
 */
function findSidebarItem(sidebar, projectId, workspaceId) {
    for (const item of sidebar.querySelectorAll('.notes-sidebar-item')) {
        if (item.dataset.projectId === projectId && item.dataset.workspaceId === workspaceId) {
            return item;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Empty-state management
// ---------------------------------------------------------------------------

/**
 * Show or hide the "no notes" empty-state message based on whether the main
 * panel contains any note cards.
 *
 * @param {HTMLElement} mainPanel
 */
function refreshEmptyState(mainPanel) {
    const existing = mainPanel.querySelector('.notes-empty-state');
    const hasCards = mainPanel.querySelector('.notes-card') !== null;
    if (hasCards && existing) {
        existing.remove();
    } else if (!hasCards && !existing) {
        const p = document.createElement('p');
        p.className = 'notes-empty-state';
        p.textContent = 'No workspace notes yet. Click a workspace in the sidebar to add one.';
        mainPanel.appendChild(p);
    }
}

// ---------------------------------------------------------------------------
// Sidebar builder
// ---------------------------------------------------------------------------

/**
 * Build the left sidebar listing all workspaces grouped by project.
 *
 * Each project is rendered as a `<details>` element (open by default) so
 * groups are collapsible. Sidebar items with existing notes carry the
 * `.has-notes` modifier class.
 *
 * @param {Array<{ projectId: string, projectName: string,
 *   workspaces: Array<{ workspaceId: string, notes: string }> }>} projects
 * @param {function(string, string): void} onItemClick
 *   Called with (projectId, workspaceId) when a sidebar button is clicked.
 * @returns {HTMLElement}
 */
function buildSidebar(projects, onItemClick) {
    const aside = document.createElement('aside');
    aside.className = 'notes-sidebar';

    const heading = document.createElement('h2');
    heading.className = 'notes-sidebar-heading';
    heading.textContent = 'Workspaces';
    aside.appendChild(heading);

    for (const project of projects) {
        const details = document.createElement('details');
        details.className = 'notes-sidebar-group';

        const summary = document.createElement('summary');
        summary.className = 'notes-sidebar-group-title';
        summary.textContent = project.projectName || project.projectId;
        details.appendChild(summary);

        const ul = document.createElement('ul');
        ul.className = 'notes-sidebar-list';

        for (const ws of project.workspaces) {
            const li = document.createElement('li');
            li.className = 'notes-sidebar-item';
            li.dataset.projectId   = project.projectId;
            li.dataset.workspaceId = ws.workspaceId;
            if (ws.notes) {
                li.classList.add('has-notes');
            }

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'notes-sidebar-btn';
            btn.textContent = ws.workspaceId;
            btn.addEventListener('click', () => onItemClick(project.projectId, ws.workspaceId));

            li.appendChild(btn);
            ul.appendChild(li);
        }

        details.appendChild(ul);
        aside.appendChild(details);
    }

    return aside;
}

// ---------------------------------------------------------------------------
// Note card builder
// ---------------------------------------------------------------------------

/**
 * Build a single editable note card for a workspace.
 *
 * The card header contains a clickable link to the workspace detail view.
 * The textarea fires a 1000 ms debounced save on `input` events.
 * A status span (aria-live="polite") shows Saving… / Saved / Save failed.
 *
 * @param {string}   projectId
 * @param {string}   projectName
 * @param {string}   workspaceId
 * @param {string}   initialNotes
 * @param {function(string, string, string): Promise<void>} onSave
 *   Called with (projectId, workspaceId, notes). Rejects on save failure.
 * @param {function(): void} onEmpty
 *   Called (after a successful save) when the note text is empty.
 * @returns {HTMLElement}
 */
function buildNoteCard(projectId, projectName, workspaceId, initialNotes, onSave, onEmpty) {
    const article = document.createElement('article');
    article.className = 'notes-card';
    article.dataset.projectId   = projectId;
    article.dataset.workspaceId = workspaceId;

    // ---- Card header ----
    const header = document.createElement('header');
    header.className = 'notes-card-header';

    const link = document.createElement('a');
    link.href = `#/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(workspaceId)}`;
    link.className = 'notes-card-ws-link';
    // textContent used intentionally: projectName/workspaceId come from the
    // server response and must not be treated as markup.
    link.textContent = `${projectName || projectId} \u203a ${workspaceId}`;
    header.appendChild(link);

    const statusEl = document.createElement('span');
    statusEl.className = 'notes-card-status';
    statusEl.setAttribute('aria-live', 'polite');
    statusEl.hidden = true;
    header.appendChild(statusEl);

    article.appendChild(header);

    // ---- Textarea ----
    const textarea = document.createElement('textarea');
    textarea.className = 'notes-card-textarea';
    textarea.value = initialNotes;
    textarea.rows = 6;
    article.appendChild(textarea);

    // ---- Debounced auto-save ----
    let debounceTimer = null;

    textarea.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
            statusEl.textContent = 'Saving\u2026';
            statusEl.hidden = false;
            try {
                await onSave(projectId, workspaceId, textarea.value);
                if (textarea.value === '') {
                    onEmpty();
                    return;
                }
                statusEl.textContent = 'Saved';
                setTimeout(() => { statusEl.hidden = true; }, 3000);
            } catch {
                statusEl.textContent = 'Save failed.';
            }
        }, 1000);
    });

    return article;
}

// ---------------------------------------------------------------------------
// Public view entry point
// ---------------------------------------------------------------------------

/**
 * Render the Notes Collected view.
 *
 * Fetches all workspace notes via `api.notes.list()`, normalises the response,
 * then builds a two-panel layout: sidebar on the left, scrollable main panel
 * on the right.
 *
 * @param {HTMLElement} container - The `#app` DOM element provided by the router.
 * @param {Object}      _params   - Route params (none for this route).
 */
export async function renderNotesCollected(container, _params) {
    // Show loading state immediately.
    const loadingEl = document.createElement('p');
    loadingEl.className = 'notes-loading';
    loadingEl.textContent = 'Loading notes\u2026';
    container.appendChild(loadingEl);

    let rawResponse;
    /** @type {{ notesColumns?: number, notesCardHeight?: number }} */
    let displaySettings;
    try {
        [rawResponse, displaySettings] = await Promise.all([
            api.notes.list(),
            api.config.notesDisplay.get().catch(() => ({})),
        ]);
    } catch (err) {
        container.removeChild(loadingEl);
        showToast(`Failed to load notes: ${err.message}`, 'error');
        const errEl = document.createElement('p');
        errEl.className = 'notes-error';
        errEl.textContent = 'Could not load workspace notes. Please try again.';
        container.appendChild(errEl);
        return;
    }

    container.removeChild(loadingEl);

    const { projects } = normaliseNotesResponse(rawResponse);

    // ---- In-memory notes map — keeps local state in sync with saves ----
    /** @type {Map<string, string>} Key: `${projectId}|${workspaceId}` */
    const notesMap = new Map();
    for (const project of projects) {
        for (const ws of project.workspaces) {
            notesMap.set(`${project.projectId}|${ws.workspaceId}`, ws.notes);
        }
    }

    // ---- Layout container ----
    const layout = document.createElement('div');
    layout.className = 'notes-view';

    // ---- Main panel ----
    const mainPanel = document.createElement('div');
    mainPanel.className = 'notes-main';

    // Apply display settings from API (gracefully degrade if fetch failed).
    if (displaySettings.notesColumns) {
        mainPanel.style.gridTemplateColumns = `repeat(${displaySettings.notesColumns}, 1fr)`;
    }
    if (displaySettings.notesCardHeight) {
        // notesCardHeight is always an integer (pixels) per the NotesDisplayConfig typedef
        // (see api.js — @property {number} notesCardHeight, range 120–800), so appending
        // 'px' unconditionally is safe. If the API contract changes to include units, remove the suffix.
        mainPanel.style.setProperty('--notes-card-height', `${displaySettings.notesCardHeight}px`);
    }

    // Forward-declare sidebar so handlers can reference it after assignment.
    /** @type {HTMLElement} */
    let sidebar; // assigned below after handlers are defined

    // ---- Shared save handler ----
    async function handleSave(projectId, workspaceId, notes) {
        await api.workspaces.update(projectId, workspaceId, { notes });
        notesMap.set(`${projectId}|${workspaceId}`, notes);
        // Update sidebar indicator for non-empty saves.
        if (notes) {
            findSidebarItem(sidebar, projectId, workspaceId)?.classList.add('has-notes');
        }
    }

    // ---- Handler: note saved as empty → remove card + clear sidebar indicator ----
    function handleCardEmpty(projectId, workspaceId) {
        const card = findCard(mainPanel, projectId, workspaceId);
        if (card) card.remove();

        findSidebarItem(sidebar, projectId, workspaceId)?.classList.remove('has-notes');
        notesMap.set(`${projectId}|${workspaceId}`, '');
        refreshEmptyState(mainPanel);
    }

    // ---- Sidebar click handler ----
    function handleSidebarClick(projectId, workspaceId) {
        const existingCard = findCard(mainPanel, projectId, workspaceId);
        if (existingCard) {
            // Card already exists — scroll to it and focus.
            existingCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
            existingCard.querySelector('.notes-card-textarea')?.focus();
            return;
        }

        // No card yet — create a new empty one.
        const project = projects.find((p) => p.projectId === projectId);
        const projectName   = project ? project.projectName : projectId;
        const currentNotes  = notesMap.get(`${projectId}|${workspaceId}`) ?? '';

        const card = buildNoteCard(
            projectId,
            projectName,
            workspaceId,
            currentNotes,
            handleSave,
            () => handleCardEmpty(projectId, workspaceId),
        );

        mainPanel.appendChild(card);
        refreshEmptyState(mainPanel);
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        card.querySelector('.notes-card-textarea')?.focus();
    }

    // ---- Build sidebar (uses handleSidebarClick defined above) ----
    sidebar = buildSidebar(projects, handleSidebarClick);
    layout.appendChild(sidebar);

    // ---- Populate main panel with cards for non-empty notes ----
    for (const project of projects) {
        for (const ws of project.workspaces) {
            if (ws.notes) {
                const card = buildNoteCard(
                    project.projectId,
                    project.projectName,
                    ws.workspaceId,
                    ws.notes,
                    handleSave,
                    () => handleCardEmpty(project.projectId, ws.workspaceId),
                );
                mainPanel.appendChild(card);
            }
        }
    }

    refreshEmptyState(mainPanel);
    layout.appendChild(mainPanel);
    container.appendChild(layout);
}

```
###  Path: `/gui/public/js/views/project-detail.js`

```js
/**
 * Project Detail View — Repo Parallelizer GUI.
 *
 * Renders the full detail page for a single project:
 *   - Project metadata (ID, name/description with inline description edit).
 *   - Repositories section: list with per-repo Remove, plus "Add Repository" picker.
 *   - Workspaces section: list with links, per-workspace Delete (STABLE disabled),
 *     and "Add Workspace" form.
 *   - Rename Project action (changes project ID).
 *   - Delete Project action.
 *
 * ## Data fetching
 *
 * On render, `GET /api/projects/:id`, `GET /api/projects/:id/workspaces`, and
 * `GET /api/repositories` are issued in parallel via `Promise.all`. A loading
 * spinner is shown until all three resolve.
 *
 * ## Refresh strategy (full-refresh-on-mutation)
 *
 * After any successful mutation (add/remove repository, add/delete workspace),
 * the view re-renders itself completely by calling `renderProjectDetail`
 * recursively via the internal `refresh()` helper. This triggers three new
 * parallel API calls and rebuilds the full DOM from scratch.
 *
 * Trade-off: simplicity and guaranteed consistency over efficiency. For the
 * current usage scale this is the right default. A targeted section re-render
 * (e.g. refreshing only the repository list) is a deferred optimisation —
 * it would save two redundant requests per mutation but adds stateful diffing
 * complexity.
 *
 * ## Router injection
 *
 * This module exports `setRouter(router)` so that `renderProjectDetail` can
 * call `router.navigate()` on rename and delete without creating a circular
 * import with `app.js`. `app.js` calls `setProjectDetailRouter(router)` (the
 * aliased import) before `router.start()`. The `_router` variable is
 * null-guarded in all three navigation sites so the view remains functional
 * in test contexts where no router is injected.
 *
 * @module project-detail
 */

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { showConfirm } from '../components/confirm-dialog.js';
import { createFormField, validateRequired, WORKSPACE_ID_PATTERN } from '../components/form-helpers.js';
import { normaliseProject, normaliseRepo, normaliseWorkspace } from '../utils/normalise.js';
import { STABLE_WS_ID, APP_NAME_SHORT } from '../utils/constants.js';

// ---------------------------------------------------------------------------
// Router reference — injected from app.js via setRouter()
// app.js calls setRouter(router) before router.start() to avoid circular deps.
// ---------------------------------------------------------------------------

/** @type {import('../router.js').Router|null} */
let _router = null;

/**
 * Inject the router instance so project-detail can navigate on rename/delete.
 * Called from app.js before the router starts.
 *
 * @param {import('../router.js').Router} router
 */
export function setRouter(router) {
    _router = router;
}

// ---------------------------------------------------------------------------
// Normalisation helpers — imported from utils/normalise.js
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Loading helper
// ---------------------------------------------------------------------------

/**
 * Render a loading spinner into `el`.
 *
 * @param {HTMLElement} el
 * @param {string} [label]
 */
function showLoading(el, label = 'Loading…') {
    el.innerHTML = `
        <div class="loading-indicator" aria-live="polite">
            <span class="spinner" aria-hidden="true"></span>
            <span>${label}</span>
        </div>
    `;
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

/**
 * Build the project metadata header section.
 * Description is editable inline: clicking the edit icon shows a textarea;
 * Save calls `api.projects.update()`.
 *
 * @param {{ id: string, name: string, description: string }} project
 * @returns {HTMLElement}
 */
function buildMetaSection(project) {
    const section = document.createElement('section');
    section.className = 'project-meta-section';

    // Top row: name + ID + edit icon
    const topRow = document.createElement('div');
    topRow.className = 'project-meta-top-row';

    const nameEl = document.createElement('h1');
    nameEl.className = 'project-meta-name';
    nameEl.textContent = project.name || project.id;

    const idLabel = document.createElement('span');
    idLabel.className = 'project-meta-id text-muted';
    idLabel.textContent = project.id;

    const editIconBtn = document.createElement('button');
    editIconBtn.type      = 'button';
    editIconBtn.className = 'btn-icon project-meta-edit-icon';
    editIconBtn.title     = 'Edit project description';
    editIconBtn.setAttribute('aria-label', 'Edit project description');
    editIconBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"/></svg>';

    topRow.appendChild(nameEl);
    topRow.appendChild(idLabel);
    topRow.appendChild(editIconBtn);
    section.appendChild(topRow);

    // Description — read-mode
    const descRow = document.createElement('div');
    descRow.className = 'project-meta-desc-row';

    const descDisplay = document.createElement('p');
    descDisplay.className = 'project-meta-description text-secondary';
    descDisplay.textContent = project.description || 'No description.';

    descRow.appendChild(descDisplay);
    section.appendChild(descRow);

    // Description — edit-mode (hidden initially)
    const editRow = document.createElement('div');
    editRow.className = 'project-meta-edit-row';
    editRow.hidden = true;

    const descTextarea = document.createElement('textarea');
    descTextarea.className = 'form-textarea';
    descTextarea.rows  = 2;
    descTextarea.value = project.description;
    descTextarea.setAttribute('aria-label', 'Project description');
    editRow.appendChild(descTextarea);

    const editActions = document.createElement('div');
    editActions.className = 'form-actions';

    const saveDescBtn = document.createElement('button');
    saveDescBtn.type      = 'button';
    saveDescBtn.className = 'btn btn-primary btn-sm';
    saveDescBtn.textContent = 'Save';

    const cancelDescBtn = document.createElement('button');
    cancelDescBtn.type      = 'button';
    cancelDescBtn.className = 'btn btn-secondary btn-sm';
    cancelDescBtn.textContent = 'Cancel';

    editActions.appendChild(saveDescBtn);
    editActions.appendChild(cancelDescBtn);
    editRow.appendChild(editActions);
    section.appendChild(editRow);

    // ---- Behaviour ----

    editIconBtn.addEventListener('click', () => {
        descRow.hidden   = true;
        editRow.hidden   = false;
        descTextarea.value = project.description;
        descTextarea.focus();
    });

    cancelDescBtn.addEventListener('click', () => {
        descRow.hidden = false;
        editRow.hidden = true;
    });

    saveDescBtn.addEventListener('click', async () => {
        const newDesc = descTextarea.value.trim();
        saveDescBtn.disabled = true;
        saveDescBtn.textContent = 'Saving…';

        try {
            await api.projects.update(project.id, { description: newDesc });
            project.description = newDesc;
            descDisplay.textContent = newDesc || 'No description.';
            showToast('Description updated.', 'success');
            editRow.hidden = true;
            descRow.hidden = false;
        } catch (err) {
            showToast(err.message || 'Failed to update description.', 'error');
        } finally {
            saveDescBtn.disabled = false;
            saveDescBtn.textContent = 'Save';
        }
    });

    return section;
}

/**
 * Build the Repositories section for a project.
 *
 * Lists repos currently in the project (cross-referenced with global repo list
 * for name/URL). Provides a Remove button per repo and an "Add Repository"
 * picker that excludes already-added repos.
 *
 * @param {string}   projectId       - Current project ID.
 * @param {string[]} projectRepoIds  - Repo IDs currently in the project.
 * @param {Array<{ id: string, name: string, url: string }>} allRepos
 *   Full global repository list.
 * @param {function(): Promise<void>} onRefresh - Re-renders the entire view.
 * @returns {HTMLElement}
 */
function buildRepositoriesSection(projectId, projectRepoIds, allRepos, onRefresh) {
    const section = document.createElement('section');
    section.className = 'project-repos-section';

    // Build a map for quick lookup: repoId → { id, name, url }
    const repoMap = new Map(allRepos.map((r) => [r.id, r]));

    // ---- Repo table ----
    if (projectRepoIds.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty-state-inline text-secondary';
        empty.textContent = 'No repositories in this project yet.';
        section.appendChild(empty);
    } else {
        const table = document.createElement('table');
        table.className = 'data-table repos-table';

        const thead = document.createElement('thead');
        const htr   = document.createElement('tr');
        ['Name', 'ID', 'Actions'].forEach((label) => {
            const th = document.createElement('th');
            th.textContent = label;
            htr.appendChild(th);
        });
        thead.appendChild(htr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');

        projectRepoIds.forEach((repoId) => {
            const repo = repoMap.get(repoId);
            const tr = document.createElement('tr');

            // Name cell
            const nameCell = document.createElement('td');
            nameCell.textContent = repo ? (repo.name || repo.id) : repoId;
            tr.appendChild(nameCell);

            // ID cell
            const idCell = document.createElement('td');
            idCell.className = 'text-muted font-mono';
            idCell.textContent = repoId;
            tr.appendChild(idCell);

            // Actions cell
            const actCell = document.createElement('td');
            actCell.className = 'actions';

            const removeBtn = document.createElement('button');
            removeBtn.type      = 'button';
            removeBtn.className = 'btn btn-danger btn-sm';
            removeBtn.textContent = 'Remove';

            removeBtn.addEventListener('click', async () => {
                const label = repo ? (repo.name || repo.id) : repoId;
                try {
                    await showConfirm(
                        'Remove Repository',
                        `Remove "${label}" from this project? The repository itself is not deleted.`,
                    );
                } catch {
                    return;
                }

                removeBtn.disabled = true;
                removeBtn.textContent = 'Removing…';

                try {
                    await api.projects.removeRepository(projectId, repoId);
                    showToast(`Repository "${label}" removed from project.`, 'success');
                    await onRefresh();
                } catch (err) {
                    showToast(err.message || 'Failed to remove repository.', 'error');
                    removeBtn.disabled = false;
                    removeBtn.textContent = 'Remove';
                }
            });

            actCell.appendChild(removeBtn);
            tr.appendChild(actCell);
            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        section.appendChild(table);
    }

    // ---- Add Repository picker ----
    const availableRepos = allRepos.filter((r) => !projectRepoIds.includes(r.id));

    if (availableRepos.length > 0) {
        const addRow = document.createElement('div');
        addRow.className = 'add-repo-picker-row';

        const selectEl = document.createElement('select');
        selectEl.className = 'form-select repo-picker-select';

        const defaultOpt = document.createElement('option');
        defaultOpt.value       = '';
        defaultOpt.textContent = '— Select a repository to add —';
        selectEl.appendChild(defaultOpt);

        availableRepos.forEach((r) => {
            const opt = document.createElement('option');
            opt.value       = r.id;
            opt.textContent = r.name ? `${r.name} (${r.id})` : r.id;
            selectEl.appendChild(opt);
        });

        const addBtn = document.createElement('button');
        addBtn.type      = 'button';
        addBtn.className = 'btn btn-primary btn-sm';
        addBtn.textContent = 'Add';

        addRow.appendChild(selectEl);
        addRow.appendChild(addBtn);
        section.appendChild(addRow);

        addBtn.addEventListener('click', async () => {
            const selectedId = selectEl.value;
            if (!selectedId) {
                showToast('Please select a repository to add.', 'error');
                return;
            }

            addBtn.disabled = true;
            addBtn.textContent = 'Adding…';

            try {
                await api.projects.addRepository(projectId, selectedId);
                const label = repoMap.get(selectedId);
                showToast(
                    `Repository "${label ? (label.name || label.id) : selectedId}" added to project.`,
                    'success',
                );
                await onRefresh();
            } catch (err) {
                showToast(err.message || 'Failed to add repository.', 'error');
                addBtn.disabled = false;
                addBtn.textContent = 'Add';
            }
        });
    } else if (allRepos.length > 0) {
        const allAdded = document.createElement('p');
        allAdded.className = 'empty-state-inline text-secondary';
        allAdded.textContent = 'All registered repositories are already in this project.';
        section.appendChild(allAdded);
    }

    return section;
}

/**
 * Build the Workspaces section for a project.
 *
 * Lists workspaces with ID, description, creation date, current branches,
 * a link to the workspace detail view, and a Delete button (disabled for STABLE).
 * Includes an "Add Workspace" form.
 *
 * @param {string}   projectId  - Current project ID.
 * @param {Array<{ id: string, description: string, createdAt: string, initialized: boolean }>} workspaces
 * @param {Record<string, Record<string, Object>|null>} wsStatusMap - Keyed by workspace ID; values are status maps (repoId → GitStatusInfo) or null.
 * @param {Record<string, { healthy: boolean, issues: Array<{ type: string, severity: string, message: string, fixAction: string, repositoryId?: string }> }|null>} wsHealthMap - Keyed by workspace ID; null when health fetch failed or workspace is uninitialized.
 * @param {function(): Promise<void>} onRefresh - Re-renders the entire view.
 * @returns {HTMLElement}
 */
function buildWorkspacesSection(projectId, workspaces, wsStatusMap, wsHealthMap, onRefresh) {
    const section = document.createElement('section');
    section.className = 'project-workspaces-section';

    // ---- Workspace list ----
    if (workspaces.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty-state-inline text-secondary';
        empty.textContent = 'No workspaces yet.';
        section.appendChild(empty);
    } else {
        const table = document.createElement('table');
        table.className = 'data-table workspaces-table';

        const thead = document.createElement('thead');
        const htr   = document.createElement('tr');
        ['ID', 'Description', 'Created', 'Branches', 'Health', 'Actions'].forEach((label) => {
            const th = document.createElement('th');
            th.textContent = label;
            htr.appendChild(th);
        });
        thead.appendChild(htr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');

        workspaces.forEach((ws) => {
            const tr = document.createElement('tr');
            tr.dataset.workspaceId = ws.id;

            // ID + link cell
            const idCell = document.createElement('td');
            const wsLink = document.createElement('a');
            wsLink.href      = `#/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(ws.id)}`;
            wsLink.textContent = ws.id;
            wsLink.className = 'workspace-link';
            if (_router) {
                wsLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    _router.navigate(
                        `#/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(ws.id)}`,
                    );
                });
            }
            idCell.appendChild(wsLink);
            tr.appendChild(idCell);

            // Description cell
            const descCell = document.createElement('td');
            descCell.textContent = ws.description || '—';
            tr.appendChild(descCell);

            // Created-at cell
            const createdCell = document.createElement('td');
            createdCell.className = 'text-muted';
            if (ws.createdAt) {
                try {
                    createdCell.textContent = new Date(ws.createdAt).toLocaleDateString();
                } catch {
                    createdCell.textContent = ws.createdAt;
                }
            } else {
                createdCell.textContent = '—';
            }
            tr.appendChild(createdCell);

            // Branches cell — aggregated current branches across all repos in this workspace
            const branchesCell = document.createElement('td');
            branchesCell.className = 'workspace-branches-cell font-mono text-muted';
            const repoStatuses = wsStatusMap[ws.id];
            if (repoStatuses && typeof repoStatuses === 'object') {
                const branches = Object.values(repoStatuses)
                    .map((s) => s && s.currentBranch)
                    .filter(Boolean);
                const unique = [...new Set(branches)];
                branchesCell.textContent = unique.length > 0 ? unique.join(', ') : '—';
            } else {
                branchesCell.textContent = '—';
            }
            tr.appendChild(branchesCell);

            // Health cell — badge shown only for initialized workspaces with issues.
            // Uninitialized workspaces and healthy workspaces render an empty cell.
            const healthCell = document.createElement('td');
            healthCell.className = 'workspace-health-cell';
            if (ws.initialized) {
                const healthReport = wsHealthMap[ws.id];
                if (
                    healthReport &&
                    !healthReport.healthy &&
                    Array.isArray(healthReport.issues) &&
                    healthReport.issues.length > 0
                ) {
                    const badge = document.createElement('span');
                    badge.className = 'health-badge';

                    const icon = document.createElement('span');
                    icon.setAttribute('aria-hidden', 'true');
                    icon.textContent = '\u26a0';
                    badge.appendChild(icon);

                    const label = document.createElement('span');
                    const n = healthReport.issues.length;
                    label.textContent = `${n} ${n === 1 ? 'issue' : 'issues'}`;
                    badge.appendChild(label);

                    healthCell.appendChild(badge);
                }
            }
            tr.appendChild(healthCell);

            // Actions cell
            const actCell = document.createElement('td');
            actCell.className = 'workspace-actions-cell';

            const isStable = ws.id === STABLE_WS_ID;

            if (!isStable) {
                const deleteBtn = document.createElement('button');
                deleteBtn.type      = 'button';
                deleteBtn.className = 'btn btn-danger btn-sm';
                deleteBtn.textContent = 'Delete';

                deleteBtn.addEventListener('click', async () => {
                    try {
                        await showConfirm(
                            'Delete Workspace',
                            `Delete workspace "${ws.id}"? All cloned repositories in this workspace will be permanently removed. This action cannot be undone.`,
                        );
                    } catch {
                        return;
                    }

                    deleteBtn.disabled    = true;
                    deleteBtn.textContent = 'Deleting…';

                    try {
                        await api.workspaces.delete(projectId, ws.id);
                        showToast(`Workspace "${ws.id}" deleted.`, 'success');
                        await onRefresh();
                    } catch (err) {
                        showToast(err.message || 'Failed to delete workspace.', 'error');
                        deleteBtn.disabled    = false;
                        deleteBtn.textContent = 'Delete';
                    }
                });

                actCell.appendChild(deleteBtn);
            }
            tr.appendChild(actCell);

            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        section.appendChild(table);
    }

    // ---- Add Workspace form ----
    const addSection = buildAddWorkspaceForm(projectId, onRefresh);
    section.appendChild(addSection);

    return section;
}

/**
 * Build the "Add Workspace" collapsible form.
 *
 * Workspace ID must match /^[A-Z]{2,10}$/ (2-10 uppercase letters).
 *
 * @param {string}   projectId
 * @param {function(): Promise<void>} onSuccess
 * @returns {HTMLElement}
 */
function buildAddWorkspaceForm(projectId, onSuccess) {
    const wrapper = document.createElement('div');
    wrapper.className = 'add-workspace-wrapper';

    const toggleBtn = document.createElement('button');
    toggleBtn.type      = 'button';
    toggleBtn.className = 'btn btn-secondary btn-sm';
    toggleBtn.textContent = '+ Add Workspace';
    wrapper.appendChild(toggleBtn);

    const formWrapper = document.createElement('div');
    formWrapper.className = 'add-workspace-form-wrapper';
    formWrapper.hidden = true;
    wrapper.appendChild(formWrapper);

    const form = document.createElement('form');
    form.className = 'add-workspace-form card';
    form.noValidate = true;

    const formTitle = document.createElement('h4');
    formTitle.className = 'form-section-title';
    formTitle.textContent = 'New Workspace';
    form.appendChild(formTitle);

    const wsIdField = createFormField('Workspace ID', 'text', 'workspaceId', {
        required: true,
        placeholder: 'e.g. DEV or FEATURE',
        hint: 'Must be 2–10 uppercase letters (A-Z only).',
    });
    form.appendChild(wsIdField);

    const descField = createFormField('Description', 'textarea', 'description', {
        placeholder: 'Optional — short description.',
        rows: 2,
    });
    form.appendChild(descField);

    // Inline validation error area for workspaceId format
    const wsIdInput = wsIdField.querySelector('[name="workspaceId"]');
    const wsIdErrorEl = wsIdField.querySelector('.field-error');

    const actions = document.createElement('div');
    actions.className = 'form-actions';

    const submitBtn = document.createElement('button');
    submitBtn.type      = 'submit';
    submitBtn.className = 'btn btn-primary btn-sm';
    submitBtn.textContent = 'Create';

    const cancelBtn = document.createElement('button');
    cancelBtn.type      = 'button';
    cancelBtn.className = 'btn btn-secondary btn-sm';
    cancelBtn.textContent = 'Cancel';

    actions.appendChild(submitBtn);
    actions.appendChild(cancelBtn);
    form.appendChild(actions);
    formWrapper.appendChild(form);

    // ---- Behaviour ----

    toggleBtn.addEventListener('click', () => {
        formWrapper.hidden = !formWrapper.hidden;
        if (!formWrapper.hidden && wsIdInput) wsIdInput.focus();
    });

    cancelBtn.addEventListener('click', () => {
        form.reset();
        formWrapper.hidden = true;
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!validateRequired(form, ['workspaceId'])) return;

        const workspaceId = wsIdInput ? wsIdInput.value.trim() : '';

        // Validate format: 2-10 uppercase A-Z only
        if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
            if (wsIdErrorEl) {
                wsIdErrorEl.textContent = 'Must be 2–10 uppercase letters (A-Z only).';
                wsIdErrorEl.hidden = false;
            }
            if (wsIdInput) {
                wsIdInput.classList.add('error');
                wsIdInput.setAttribute('aria-invalid', 'true');
                wsIdInput.focus();
            }
            return;
        }

        const description = form.querySelector('[name="description"]').value.trim();

        submitBtn.disabled = true;
        submitBtn.textContent = 'Creating…';

        try {
            await api.workspaces.create(projectId, {
                workspaceId,
                description: description || undefined,
            });
            showToast(`Workspace "${workspaceId}" created.`, 'success');
            form.reset();
            formWrapper.hidden = true;
            await onSuccess();
        } catch (err) {
            showToast(err.message || 'Failed to create workspace.', 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Create';
        }
    });

    return wrapper;
}

/**
 * Build the "Rename Project" action section.
 *
 * Shows a text input for the new ID plus a confirmation dialog explaining
 * the consequences (filesystem rename).  On success, navigates to the new URL.
 *
 * @param {{ id: string, name: string }} project
 * @returns {HTMLElement}
 */
function buildRenameSection(project) {
    const section = document.createElement('section');
    section.className = 'project-rename-section card danger-zone-section';

    const heading = document.createElement('h3');
    heading.className = 'section-title danger-title';
    heading.textContent = 'Rename Project';
    section.appendChild(heading);

    const desc = document.createElement('p');
    desc.className = 'text-secondary';
    desc.textContent =
        'Changing the project ID renames the underlying directory on the filesystem and updates all references. ' +
        'Existing workspace links will stop working until updated.';
    section.appendChild(desc);

    const row = document.createElement('div');
    row.className = 'rename-row';

    const newIdInput = document.createElement('input');
    newIdInput.type        = 'text';
    newIdInput.className   = 'form-input rename-input';
    newIdInput.placeholder = 'New project ID';
    newIdInput.setAttribute('aria-label', 'New project ID');
    row.appendChild(newIdInput);

    const renameBtn = document.createElement('button');
    renameBtn.type      = 'button';
    renameBtn.className = 'btn btn-warning';
    renameBtn.textContent = 'Rename…';
    row.appendChild(renameBtn);

    section.appendChild(row);

    renameBtn.addEventListener('click', async () => {
        const newId = newIdInput.value.trim();
        if (!newId) {
            newIdInput.focus();
            showToast('Please enter a new project ID.', 'error');
            return;
        }

        if (newId === project.id) {
            showToast('The new ID is the same as the current ID.', 'error');
            return;
        }

        try {
            await showConfirm(
                'Rename Project',
                `Rename project "${project.id}" to "${newId}"? ` +
                `This renames the directory on disk and changes the URL. ` +
                `All existing workspace links will use the new project ID.`,
            );
        } catch {
            return;
        }

        renameBtn.disabled = true;
        renameBtn.textContent = 'Renaming…';

        try {
            await api.projects.rename(project.id, newId);
            showToast(`Project renamed to "${newId}".`, 'success');
            if (_router) {
                _router.navigate(`#/projects/${encodeURIComponent(newId)}`);
            }
        } catch (err) {
            showToast(err.message || 'Failed to rename project.', 'error');
            renameBtn.disabled = false;
            renameBtn.textContent = 'Rename…';
        }
    });

    return section;
}

/**
 * Build the "Delete Project" action section.
 *
 * Shows a strong warning and confirmation dialog before deletion.
 * On success, navigates back to the dashboard (#/).
 *
 * @param {{ id: string, name: string }} project
 * @returns {HTMLElement}
 */
function buildDeleteSection(project) {
    const section = document.createElement('section');
    section.className = 'project-delete-section card danger-zone-section';

    const heading = document.createElement('h3');
    heading.className = 'section-title danger-title';
    heading.textContent = 'Delete Project';
    section.appendChild(heading);

    const desc = document.createElement('p');
    desc.className = 'text-secondary';
    desc.textContent =
        'Permanently deletes this project and all its workspaces from the filesystem. ' +
        'This action cannot be undone.';
    section.appendChild(desc);

    const deleteBtn = document.createElement('button');
    deleteBtn.type      = 'button';
    deleteBtn.className = 'btn btn-danger';
    deleteBtn.textContent = 'Delete Project…';
    section.appendChild(deleteBtn);

    deleteBtn.addEventListener('click', async () => {
        try {
            await showConfirm(
                'Delete Project',
                `Permanently delete project "${project.name || project.id}"? ` +
                `All workspaces and cloned repositories will be removed from disk. ` +
                `This action cannot be undone.`,
            );
        } catch {
            return;
        }

        deleteBtn.disabled = true;
        deleteBtn.textContent = 'Deleting…';

        try {
            await api.projects.delete(project.id);
            showToast(`Project "${project.name || project.id}" deleted.`, 'success');
            if (_router) {
                _router.navigate('#/');
            }
        } catch (err) {
            showToast(err.message || 'Failed to delete project.', 'error');
            deleteBtn.disabled = false;
            deleteBtn.textContent = 'Delete Project…';
        }
    });

    return section;
}

// ---------------------------------------------------------------------------
// Public export — view function
// ---------------------------------------------------------------------------

/**
 * Render the Project Detail view.
 *
 * @param {HTMLElement} container - The `#app` root element.
 * @param {Object}      params    - Route params — expects `params.id`.
 */
export async function renderProjectDetail(container, params) {
    const projectId = decodeURIComponent(params.id || '');

    // -----------------------------------------------------------------------
    // Show loading state while fetching data
    // -----------------------------------------------------------------------
    showLoading(container, 'Loading project…');

    // -----------------------------------------------------------------------
    // Data fetching — all three in parallel
    // -----------------------------------------------------------------------
    let project, workspaces, allRepos;
    try {
        [project, workspaces, allRepos] = await Promise.all([
            api.projects.get(projectId),
            api.workspaces.list(projectId),
            api.repositories.list(),
        ]);
    } catch (err) {
        container.innerHTML = '';
        const errMsg = document.createElement('div');
        errMsg.className = 'empty-state error-state';
        errMsg.textContent = `Failed to load project: ${err.message}`;
        container.appendChild(errMsg);
        showToast(err.message || 'Failed to load project.', 'error');
        return;
    }

    const normProject    = normaliseProject(project);
    document.title = `${normProject.name || projectId} - ${APP_NAME_SHORT}`;
    const normWorkspaces = Array.isArray(workspaces)
        ? workspaces.map(normaliseWorkspace)
        : [];
    const normAllRepos   = Array.isArray(allRepos)
        ? allRepos.map(normaliseRepo)
        : [];

    // -----------------------------------------------------------------------
    // Fetch workspace statuses for the branches column (best-effort)
    // -----------------------------------------------------------------------
    /** @type {Record<string, Record<string, Object>|null>} */
    const wsStatusMap = {};
    /** @type {Record<string, { healthy: boolean, issues: Array }|null>} */
    const wsHealthMap = {};
    const initializedWs = normWorkspaces.filter((ws) => ws.initialized);
    if (initializedWs.length > 0) {
        const [statusResults, healthResults] = await Promise.all([
            Promise.allSettled(
                initializedWs.map((ws) => api.status.get(projectId, ws.id)),
            ),
            Promise.allSettled(
                initializedWs.map((ws) => api.workspaces.health(projectId, ws.id)),
            ),
        ]);
        initializedWs.forEach((ws, i) => {
            wsStatusMap[ws.id] = statusResults[i].status === 'fulfilled'
                ? statusResults[i].value
                : null;
            wsHealthMap[ws.id] = healthResults[i].status === 'fulfilled'
                ? healthResults[i].value
                : null;
        });
    }

    // -----------------------------------------------------------------------
    // Re-render helper — re-fetches all data and re-renders the view
    // -----------------------------------------------------------------------
    async function refresh() {
        container.innerHTML = '';
        await renderProjectDetail(container, params);
    }

    // -----------------------------------------------------------------------
    // Clear loading state; build the real UI
    // -----------------------------------------------------------------------
    container.innerHTML = '';

    // ---- Page header (back link only — name is in the meta section) ----
    const backLink = document.createElement('a');
    backLink.href      = '#/';
    backLink.className = 'back-link text-muted';
    backLink.textContent = '← Projects';
    if (_router) {
        backLink.addEventListener('click', (e) => {
            e.preventDefault();
            _router.navigate('#/');
        });
    }
    container.appendChild(backLink);

    // ---- Metadata section ----
    container.appendChild(buildMetaSection(normProject));

    // ---- Tab navigation ----
    const tabNav = document.createElement('nav');
    tabNav.className = 'tab-nav';
    tabNav.setAttribute('role', 'tablist');

    const tabs = [
        { id: 'workspaces', label: 'Workspaces' },
        { id: 'repositories', label: 'Repositories' },
        { id: 'danger', label: 'Danger Zone' },
    ];

    const panels = {};

    tabs.forEach((tab, index) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tab-btn' + (index === 0 ? ' active' : '');
        btn.textContent = tab.label;
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
        btn.setAttribute('aria-controls', `tab-panel-${tab.id}`);
        btn.dataset.tab = tab.id;
        tabNav.appendChild(btn);

        const panel = document.createElement('div');
        panel.id = `tab-panel-${tab.id}`;
        panel.className = 'tab-panel' + (index === 0 ? ' active' : '');
        panel.setAttribute('role', 'tabpanel');
        panels[tab.id] = panel;
    });

    tabNav.addEventListener('click', (e) => {
        const btn = e.target.closest('.tab-btn');
        if (!btn) return;
        const tabId = btn.dataset.tab;

        tabNav.querySelectorAll('.tab-btn').forEach((b) => {
            b.classList.remove('active');
            b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');

        Object.values(panels).forEach((p) => p.classList.remove('active'));
        panels[tabId].classList.add('active');
    });

    container.appendChild(tabNav);

    // ---- Repositories panel ----
    panels.repositories.appendChild(
        buildRepositoriesSection(
            normProject.id,
            normProject.repositories,
            normAllRepos,
            refresh,
        ),
    );
    container.appendChild(panels.repositories);

    // ---- Workspaces panel ----
    panels.workspaces.appendChild(
        buildWorkspacesSection(normProject.id, normWorkspaces, wsStatusMap, wsHealthMap, refresh),
    );
    container.appendChild(panels.workspaces);

    // ---- Danger zone panel ----
    const dangerZone = document.createElement('div');
    dangerZone.className = 'danger-zone';

    dangerZone.appendChild(buildRenameSection(normProject));
    dangerZone.appendChild(buildDeleteSection(normProject));

    panels.danger.appendChild(dangerZone);
    container.appendChild(panels.danger);
}

```
###  Path: `/gui/public/js/views/repositories.js`

```js
/**
 * Repositories View — Repo Parallelizer GUI.
 *
 * Renders a full CRUD management page for all registered repositories:
 *   - Table listing all repositories (ID, Name, URL).
 *   - "Add Repository" inline form (URL required, Name optional, ID optional).
 *   - Inline edit for repository Name per row.
 *   - Delete per row with a confirmation dialog.
 *
 * @param {HTMLElement} container - The `#app` root element supplied by the router.
 * @param {Object}      _params   - Route params (none for this route).
 */

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { showConfirm } from '../components/confirm-dialog.js';
import { createFormField, validateRequired } from '../components/form-helpers.js';
import { normaliseRepo } from '../utils/normalise.js';
import { clearElement } from '../utils/dom.js';
import { APP_NAME_SHORT } from '../utils/constants.js';

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

/**
 * Build the `<thead>` element for the repository table.
 *
 * @returns {HTMLElement}
 */
function buildTableHead() {
    const thead = document.createElement('thead');
    const tr    = document.createElement('tr');

    ['ID', 'Name', 'URL', 'Actions'].forEach((label) => {
        const th = document.createElement('th');
        th.textContent = label;
        tr.appendChild(th);
    });

    thead.appendChild(tr);
    return thead;
}

/**
 * Build a single `<tr>` for one repository.
 *
 * The row starts in read mode.  The Name cell renders as a clickable `<a>`
 * link navigating to `#/repositories/:id`.  Clicking Edit switches the Name
 * cell to an inline `<input>` and replaces the action buttons with Save / Cancel.
 * Clicking Delete shows a confirmation dialog and calls the API on confirm.
 *
 * @param {{ id: string, name: string, url: string }} repo
 * @param {function(): void} onDeleted - Callback to refresh the table after deletion.
 * @returns {HTMLTableRowElement}
 */
function buildRepoRow(repo, onDeleted) {
    const tr = document.createElement('tr');
    tr.dataset.repoId = repo.id;

    // ---- ID cell (read-only) ----
    const idCell = document.createElement('td');
    idCell.className = 'repo-id-cell text-muted';
    idCell.textContent = repo.id;
    tr.appendChild(idCell);

    // ---- Name cell (editable) ----
    const nameCell = document.createElement('td');
    nameCell.className = 'repo-name-cell';

    const nameLink = document.createElement('a');
    nameLink.className = 'repo-name-display repo-name-link';
    nameLink.href      = `#/repositories/${encodeURIComponent(repo.id)}`;
    nameLink.textContent = repo.name || '—';
    nameCell.appendChild(nameLink);

    // Inline edit input (hidden initially)
    const nameInput = document.createElement('input');
    nameInput.type       = 'text';
    nameInput.className  = 'form-input repo-name-input';
    nameInput.value      = repo.name;
    nameInput.hidden     = true;
    nameInput.setAttribute('aria-label', `Name for repository ${repo.id}`);
    nameCell.appendChild(nameInput);

    tr.appendChild(nameCell);

    // ---- URL cell (read-only) ----
    const urlCell = document.createElement('td');
    urlCell.className = 'repo-url-cell';
    const urlLink = document.createElement('a');
    urlLink.href      = repo.url;
    urlLink.textContent = repo.url;
    urlLink.target    = '_blank';
    urlLink.rel       = 'noopener noreferrer';
    urlLink.className = 'repo-url-link';
    urlCell.appendChild(urlLink);
    tr.appendChild(urlCell);

    // ---- Actions cell ----
    const actionsCell = document.createElement('td');
    actionsCell.className = 'repo-actions-cell';

    // Read-mode buttons
    const editBtn = document.createElement('button');
    editBtn.type      = 'button';
    editBtn.className = 'btn btn-secondary btn-sm';
    editBtn.textContent = 'Edit';

    const deleteBtn = document.createElement('button');
    deleteBtn.type      = 'button';
    deleteBtn.className = 'btn btn-danger btn-sm';
    deleteBtn.textContent = 'Delete';

    // Edit-mode buttons (hidden initially)
    const saveBtn = document.createElement('button');
    saveBtn.type      = 'button';
    saveBtn.className = 'btn btn-primary btn-sm';
    saveBtn.textContent = 'Save';
    saveBtn.hidden    = true;

    const cancelEditBtn = document.createElement('button');
    cancelEditBtn.type      = 'button';
    cancelEditBtn.className = 'btn btn-secondary btn-sm';
    cancelEditBtn.textContent = 'Cancel';
    cancelEditBtn.hidden    = true;

    actionsCell.appendChild(editBtn);
    actionsCell.appendChild(deleteBtn);
    actionsCell.appendChild(saveBtn);
    actionsCell.appendChild(cancelEditBtn);
    tr.appendChild(actionsCell);

    // -------------------------------------------------------------------------
    // Behaviour
    // -------------------------------------------------------------------------

    // Enter edit mode
    editBtn.addEventListener('click', () => {
        nameLink.hidden  = true;
        nameInput.hidden = false;
        nameInput.value  = repo.name;
        nameInput.focus();
        nameInput.select();

        editBtn.hidden   = true;
        deleteBtn.hidden = true;
        saveBtn.hidden   = false;
        cancelEditBtn.hidden = false;
    });

    // Cancel edit mode
    cancelEditBtn.addEventListener('click', () => {
        nameInput.hidden = true;
        nameLink.hidden  = false;

        editBtn.hidden   = false;
        deleteBtn.hidden = false;
        saveBtn.hidden   = true;
        cancelEditBtn.hidden = true;
    });

    // Save name change
    saveBtn.addEventListener('click', async () => {
        const newName = nameInput.value.trim();
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';

        try {
            await api.repositories.update(repo.id, { name: newName });
            repo.name = newName;
            nameLink.textContent = newName || '—';
            showToast(`Repository "${repo.id}" updated.`, 'success');

            // Return to read mode
            nameInput.hidden = true;
            nameLink.hidden  = false;
            editBtn.hidden   = false;
            deleteBtn.hidden = false;
            saveBtn.hidden   = true;
            cancelEditBtn.hidden = true;
        } catch (err) {
            showToast(err.message || 'Failed to update repository.', 'error');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save';
        }
    });

    // Allow pressing Enter in the name input to save
    nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveBtn.click();
        } else if (e.key === 'Escape') {
            cancelEditBtn.click();
        }
    });

    // Delete with confirmation
    deleteBtn.addEventListener('click', async () => {
        try {
            await showConfirm(
                'Delete Repository',
                `Delete "${repo.name || repo.id}"? This repository will be removed from all projects. This action cannot be undone.`,
            );
        } catch {
            // User cancelled — do nothing.
            return;
        }

        deleteBtn.disabled = true;
        deleteBtn.textContent = 'Deleting…';

        try {
            await api.repositories.delete(repo.id);
            showToast(`Repository "${repo.name || repo.id}" deleted.`, 'success');
            onDeleted();
        } catch (err) {
            showToast(err.message || 'Failed to delete repository.', 'error');
            deleteBtn.disabled = false;
            deleteBtn.textContent = 'Delete';
        }
    });

    return tr;
}

// ---------------------------------------------------------------------------
// Repository list rendering
// ---------------------------------------------------------------------------

/**
 * Render a loading indicator into `tableContainer`.
 *
 * @param {HTMLElement} tableContainer
 */
function showLoading(tableContainer) {
    tableContainer.innerHTML = `
        <div class="loading-indicator" aria-live="polite" aria-label="Loading repositories…">
            <span class="spinner" aria-hidden="true"></span>
            <span>Loading repositories…</span>
        </div>
    `;
}

/**
 * Fetch all repositories and render them into `tableContainer`.
 * On success renders a `<table>`; on failure shows an error state.
 *
 * @param {HTMLElement} tableContainer - Element to render the table into.
 */
async function renderRepoTable(tableContainer) {
    showLoading(tableContainer);

    let repos;
    try {
        repos = await api.repositories.list();
    } catch (err) {
        clearElement(tableContainer);
        const errMsg = document.createElement('div');
        errMsg.className = 'empty-state error-state';
        errMsg.textContent = `Failed to load repositories: ${err.message}`;
        tableContainer.appendChild(errMsg);
        showToast(err.message || 'Failed to load repositories.', 'error');
        return;
    }

    clearElement(tableContainer);

    if (!Array.isArray(repos) || repos.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No repositories registered. Use the "Add Repository" button to add one.';
        tableContainer.appendChild(empty);
        return;
    }

    const table = document.createElement('table');
    table.className = 'data-table repositories-table';
    table.appendChild(buildTableHead());

    const tbody = document.createElement('tbody');
    repos.forEach((raw) => {
        const repo = normaliseRepo(raw);
        tbody.appendChild(buildRepoRow(repo, () => renderRepoTable(tableContainer)));
    });

    table.appendChild(tbody);
    tableContainer.appendChild(table);
}

// ---------------------------------------------------------------------------
// Add Repository form
// ---------------------------------------------------------------------------

/**
 * Build and return the "Add Repository" inline form section.
 * On success, `onSuccess` is called so the caller can re-render the table.
 *
 * @param {function(): void} onSuccess
 * @returns {HTMLElement}
 */
function buildAddRepoSection(onSuccess) {
    const section = document.createElement('section');
    section.className = 'add-repo-section';

    // Toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn btn-primary';
    toggleBtn.textContent = '+ Add Repository';
    section.appendChild(toggleBtn);

    // Collapsible form wrapper (hidden by default)
    const formWrapper = document.createElement('div');
    formWrapper.className = 'add-repo-form-wrapper';
    formWrapper.hidden = true;
    section.appendChild(formWrapper);

    // Form
    const form = document.createElement('form');
    form.className = 'add-repo-form card';
    form.noValidate = true;

    const formTitle = document.createElement('h3');
    formTitle.className = 'form-section-title';
    formTitle.textContent = 'New Repository';
    form.appendChild(formTitle);

    const urlField = createFormField('URL', 'url', 'url', {
        required: true,
        placeholder: 'https://github.com/org/repo.git',
    });
    form.appendChild(urlField);

    const nameField = createFormField('Name', 'text', 'name', {
        placeholder: 'Optional — human-readable name.',
    });
    form.appendChild(nameField);

    const idField = createFormField('ID', 'text', 'id', {
        placeholder: 'Optional — auto-inferred from URL when left blank.',
        hint: 'Leave blank to auto-infer from the repository URL.',
    });
    form.appendChild(idField);

    // Action row
    const actions = document.createElement('div');
    actions.className = 'form-actions';

    const submitBtn = document.createElement('button');
    submitBtn.type      = 'submit';
    submitBtn.className = 'btn btn-primary';
    submitBtn.textContent = 'Add';

    const cancelBtn = document.createElement('button');
    cancelBtn.type      = 'button';
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = 'Cancel';

    actions.appendChild(submitBtn);
    actions.appendChild(cancelBtn);
    form.appendChild(actions);

    formWrapper.appendChild(form);

    // -------------------------------------------------------------------------
    // Behaviour
    // -------------------------------------------------------------------------

    toggleBtn.addEventListener('click', () => {
        formWrapper.hidden = !formWrapper.hidden;
        if (!formWrapper.hidden) {
            const urlInput = form.querySelector('[name="url"]');
            if (urlInput) urlInput.focus();
        }
    });

    cancelBtn.addEventListener('click', () => {
        form.reset();
        formWrapper.hidden = true;
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!validateRequired(form, ['url'])) return;

        const url  = form.querySelector('[name="url"]').value.trim();
        const name = form.querySelector('[name="name"]').value.trim();
        const id   = form.querySelector('[name="id"]').value.trim();

        submitBtn.disabled = true;
        submitBtn.textContent = 'Adding…';

        try {
            await api.repositories.create({
                url,
                name: name || undefined,
                id:   id   || undefined,
            });
            showToast('Repository added successfully.', 'success');
            form.reset();
            formWrapper.hidden = true;
            onSuccess();
        } catch (err) {
            showToast(err.message || 'Failed to add repository.', 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Add';
        }
    });

    return section;
}

// ---------------------------------------------------------------------------
// Public export — view function
// ---------------------------------------------------------------------------

/**
 * Render the Repositories view.
 *
 * @param {HTMLElement} container - The `#app` root element.
 * @param {Object}      _params   - Route params (unused).
 */
export async function renderRepositories(container, _params) {
    document.title = 'Repositories - ' + APP_NAME_SHORT;

    // -----------------------------------------------------------------------
    // Page header
    // -----------------------------------------------------------------------
    const header = document.createElement('div');
    header.className = 'page-header';

    const title = document.createElement('h1');
    title.textContent = 'Repositories';
    header.appendChild(title);

    container.appendChild(header);

    // -----------------------------------------------------------------------
    // Table container
    // -----------------------------------------------------------------------
    const tableContainer = document.createElement('div');
    tableContainer.className = 'repositories-table-container';
    container.appendChild(tableContainer);

    // -----------------------------------------------------------------------
    // Add Repository section
    // -----------------------------------------------------------------------
    const addSection = buildAddRepoSection(() => {
        renderRepoTable(tableContainer);
    });
    container.appendChild(addSection);

    // -----------------------------------------------------------------------
    // Initial load
    // -----------------------------------------------------------------------
    await renderRepoTable(tableContainer);
}

```
###  Path: `/gui/public/js/views/repository-detail.js`

```js
/**
 * Repository Detail View — Repo Parallelizer GUI.
 *
 * Renders the Repository Overview page at `#/repositories/:id`, showing a
 * table of every workspace across every project that contains the given
 * repository. Each row displays contextual Project and Workspace columns
 * alongside the shared Branch, Status, and Actions cells.
 *
 * ## Data loading flow
 *
 * 1. `api.repositories.get(id)`  — fetch repository metadata (name, URL).
 * 2. `api.projects.list()`       — fetch all projects.
 * 3. Per project: `api.projects.get(pid)` — filter to those containing repoId.
 * 4. Per matching project: `api.workspaces.list(pid)` — list workspaces.
 * 5. Per workspace: `api.status.get(pid, wid)` — extract the single repo's status.
 * 6. `api.config.webserverUrl.get()` — fetch webserver URL once.
 *
 * Steps 2–5 use `Promise.allSettled` so individual project/workspace fetch
 * failures do not abort the entire load. Failed fetches are silently skipped;
 * when at least one fetch failed but others succeeded a warning toast is shown.
 *
 * ## Router injection
 *
 * Exports `setRouter(router)` so that `app.js` can inject the router for
 * programmatic navigation. The `_router` variable is null-guarded everywhere.
 *
 * ## No polling
 *
 * This view does not auto-poll (refreshing all workspaces across all projects
 * on a timer would be too expensive). A manual "Refresh" button force-fetches
 * all status data and updates rows in-place.
 *
 * @module repository-detail
 */

import { api }               from '../api.js';
import { showToast }         from '../components/toast.js';
import { buildRepoStatusCells, updateRepoStatusCells } from '../components/repo-status-cells.js';
import { normaliseRepo, normaliseProject, normaliseWorkspace } from '../utils/normalise.js';
import { STABLE_WS_ID, APP_NAME_SHORT } from '../utils/constants.js';
import { clearElement } from '../utils/dom.js';

// ---------------------------------------------------------------------------
// Router reference — injected from app.js via setRouter()
// ---------------------------------------------------------------------------

/** @type {import('../router.js').Router|null} */
let _router = null;

/**
 * Inject the router instance so repository-detail can navigate programmatically.
 * Called from `app.js` before the router starts.
 *
 * @param {import('../router.js').Router} router
 */
export function setRouter(router) {
    _router = router;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Loading helper
// ---------------------------------------------------------------------------

/**
 * Render a loading spinner into `el`.
 *
 * @param {HTMLElement} el
 * @param {string} [label]
 */
function showLoading(el, label = 'Loading…') {
    clearElement(el);
    const wrapper = document.createElement('div');
    wrapper.className = 'loading-indicator';
    wrapper.setAttribute('aria-live', 'polite');

    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    wrapper.appendChild(spinner);

    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    wrapper.appendChild(labelEl);

    el.appendChild(wrapper);
}

// ---------------------------------------------------------------------------
// Row descriptor type
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} WorkspaceRowDescriptor
 * @property {string}      pid           - Project ID.
 * @property {string}      projectName   - Human-readable project name.
 * @property {string}      wid           - Workspace ID.
 * @property {boolean}     isStable      - Whether this is the STABLE workspace.
 * @property {boolean}     initialized   - Whether the workspace has been set up.
 * @property {Object|null} statusInfo    - Git status for this repo in this workspace.
 */

// ---------------------------------------------------------------------------
// Data loading helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all workspaces for matching projects and collect status data for the
 * given repository. Uses `Promise.allSettled` at each fan-out level so that
 * individual fetch failures do not abort the entire load.
 *
 * @param {string}   repoId       - The repository ID to look for.
 * @param {Object[]} allProjects  - Raw project list from `api.projects.list()`.
 * @returns {Promise<{ rows: WorkspaceRowDescriptor[], anyFailed: boolean }>}
 */
async function loadWorkspaceRows(repoId, allProjects) {
    let anyFailed = false;

    // Step 1: Fetch full project data for all projects in parallel.
    const projectResults = await Promise.allSettled(
        allProjects.map((p) => {
            const pid = p.Id || p.id || '';
            return api.projects.get(pid).then((full) => ({ pid, full }));
        }),
    );

    // Step 2: Filter projects that contain this repo.
    const matchingProjects = [];
    for (const result of projectResults) {
        if (result.status === 'rejected') {
            anyFailed = true;
            continue;
        }
        const { pid, full } = result.value;
        const project = normaliseProject(full);
        const contains = project.repositories.some((r) => {
            const rid = (typeof r === 'string') ? r : (r.Id || r.id || r.RepositoryId || r.repositoryId || '');
            return rid === repoId;
        });
        if (contains) {
            matchingProjects.push({ pid, project });
        }
    }

    // Step 3: Fetch workspaces for each matching project in parallel.
    const workspaceResults = await Promise.allSettled(
        matchingProjects.map(({ pid }) =>
            api.workspaces.list(pid).then((wsList) => ({ pid, wsList })),
        ),
    );

    // Step 4: Fetch status per workspace in parallel.
    const statusFetchTasks = [];
    for (const result of workspaceResults) {
        if (result.status === 'rejected') {
            anyFailed = true;
            continue;
        }
        const { pid, wsList } = result.value;
        const projectName = matchingProjects.find((mp) => mp.pid === pid)?.project.name || pid;

        for (const rawWs of (wsList || [])) {
            const ws = normaliseWorkspace(rawWs);
            const wid = ws.id;
            if (!wid) continue;

            statusFetchTasks.push(
                api.status.get(pid, wid)
                    .then((statusMap) => ({
                        pid,
                        projectName,
                        wid,
                        isStable:    wid === STABLE_WS_ID,
                        initialized: ws.initialized,
                        statusInfo:  (statusMap && statusMap[repoId]) ? statusMap[repoId] : null,
                    }))
                    .catch(() => {
                        // Status fetch failed — include the row but without status data.
                        return {
                            pid,
                            projectName,
                            wid,
                            isStable:    wid === STABLE_WS_ID,
                            initialized: ws.initialized,
                            statusInfo:  null,
                        };
                    }),
            );
        }
    }

    const statusResults = await Promise.allSettled(statusFetchTasks);

    const rows = [];
    for (const result of statusResults) {
        if (result.status === 'rejected') {
            anyFailed = true;
            continue;
        }
        rows.push(result.value);
    }

    return { rows, anyFailed };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format a Date as a human-readable relative string.
 * e.g. "just now", "3 minutes ago", "2 hours ago", "1 day ago".
 *
 * @param {Date} date
 * @returns {string}
 */
function formatRelativeTime(date) {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
}

// ---------------------------------------------------------------------------
// DOM builders
// ---------------------------------------------------------------------------

/**
 * Build the page header section.
 *
 * Contains:
 *   - A back link to `#/repositories`.
 *   - The repository name as the page title.
 *   - Repository ID and URL (URL as an external `<a>`).
 *   - A "Refresh" button (wired by the caller after construction).
 *
 * @param {{ id: string, name: string, url: string }} repo
 * @returns {{ header: HTMLElement, refreshBtn: HTMLButtonElement }}
 */
function buildHeader(repo) {
    const header = document.createElement('div');
    header.className = 'repository-detail-header';

    // Back link
    const backNav = document.createElement('nav');
    backNav.className = 'breadcrumb back-link text-muted';
    backNav.setAttribute('aria-label', 'Breadcrumb');

    const backLink = document.createElement('a');
    backLink.href      = '#/repositories';
    backLink.className = 'breadcrumb-link';
    backLink.textContent = '← Repositories';
    if (_router) {
        backLink.addEventListener('click', (e) => {
            e.preventDefault();
            _router.navigate('#/repositories');
        });
    }
    backNav.appendChild(backLink);
    header.appendChild(backNav);

    // Title row
    const titleRow = document.createElement('div');
    titleRow.className = 'repository-meta-top-row';

    const titleEl = document.createElement('h1');
    titleEl.className   = 'project-meta-name';
    titleEl.textContent = repo.name || repo.id;
    titleRow.appendChild(titleEl);

    // ID hint (only when name differs from id)
    if (repo.name && repo.name !== repo.id) {
        const idHint = document.createElement('span');
        idHint.className   = 'project-meta-id text-muted';
        idHint.textContent = repo.id;
        titleRow.appendChild(idHint);
    }

    header.appendChild(titleRow);

    // URL row
    if (repo.url) {
        const urlRow = document.createElement('div');
        urlRow.className = 'repository-url-row';

        const urlLabel = document.createElement('span');
        urlLabel.className   = 'text-muted';
        urlLabel.textContent = 'URL: ';

        const urlLink = document.createElement('a');
        urlLink.href      = repo.url;
        urlLink.textContent = repo.url;
        urlLink.target    = '_blank';
        urlLink.rel       = 'noopener noreferrer';
        urlLink.className = 'repo-url-link';

        urlRow.appendChild(urlLabel);
        urlRow.appendChild(urlLink);
        header.appendChild(urlRow);
    }

    // Refresh button + last-refreshed label
    const refreshBtn = document.createElement('button');
    refreshBtn.type      = 'button';
    refreshBtn.className = 'btn btn-primary';
    refreshBtn.textContent = 'Refresh';
    refreshBtn.title = 'Re-fetch status for all workspaces containing this repository.';

    const lastRefreshedEl = document.createElement('span');
    lastRefreshedEl.className = 'repository-last-refreshed text-muted';

    const actionsRow = document.createElement('div');
    actionsRow.className = 'repository-detail-actions';
    actionsRow.style.marginTop = '1rem';
    actionsRow.style.marginBottom = '1rem';
    actionsRow.appendChild(refreshBtn);
    actionsRow.appendChild(lastRefreshedEl);
    header.appendChild(actionsRow);

    return { header, refreshBtn, lastRefreshedEl };
}

/**
 * Build a single `<tr>` for one workspace row.
 *
 * @param {WorkspaceRowDescriptor} rowDesc
 * @param {string}      repoId       - Repository ID (for `buildRepoStatusCells`).
 * @param {string}      repoName     - Human-readable repository name.
 * @param {string|null} webserverUrl - Webserver base URL for the Browse button.
 * @param {function(HTMLElement, string, string): void} onBranchCellClick
 * @returns {HTMLTableRowElement}
 */
function buildWorkspaceRow(rowDesc, repoId, repoName, webserverUrl, onBranchCellClick) {
    const { pid, projectName, wid, isStable, initialized, statusInfo } = rowDesc;

    const tr = document.createElement('tr');
    tr.dataset.repoId = repoId;
    tr.dataset.pid    = pid;
    tr.dataset.wid    = wid;

    // Project cell — link to #/projects/:pid
    const projectCell = document.createElement('td');
    projectCell.className = 'repo-detail-project-cell';

    const projectLink = document.createElement('a');
    projectLink.href      = `#/projects/${encodeURIComponent(pid)}`;
    projectLink.textContent = projectName || pid;
    projectLink.className = 'project-link';
    if (_router) {
        projectLink.addEventListener('click', (e) => {
            e.preventDefault();
            _router.navigate(`#/projects/${encodeURIComponent(pid)}`);
        });
    }
    projectCell.appendChild(projectLink);
    tr.appendChild(projectCell);

    // Workspace cell — link to #/projects/:pid/workspaces/:wid
    const wsCell = document.createElement('td');
    wsCell.className = 'repo-detail-workspace-cell';

    const wsLink = document.createElement('a');
    wsLink.href      = `#/projects/${encodeURIComponent(pid)}/workspaces/${encodeURIComponent(wid)}`;
    wsLink.textContent = wid;
    wsLink.className = 'workspace-link';
    if (_router) {
        wsLink.addEventListener('click', (e) => {
            e.preventDefault();
            _router.navigate(`#/projects/${encodeURIComponent(pid)}/workspaces/${encodeURIComponent(wid)}`);
        });
    }
    wsCell.appendChild(wsLink);

    // Uninitialized badge
    if (!initialized) {
        const badge = document.createElement('span');
        badge.className   = 'badge badge-muted ws-not-initialized-badge';
        badge.textContent = 'not initialized';
        wsCell.appendChild(badge);
    }

    tr.appendChild(wsCell);

    // Branch, Status, Actions cells — delegated to shared component.
    // For uninitialized workspaces, render empty placeholder cells.
    if (!initialized) {
        ['repo-branch-cell', 'repo-badge-cell', 'repo-actions-cell'].forEach((cls) => {
            const td = document.createElement('td');
            td.className = cls;
            tr.appendChild(td);
        });
    } else {
        const { branchCell, badgeCell, actionsCell } = buildRepoStatusCells({
            repoId,
            repoName,
            statusInfo,
            projectId:      pid,
            wid,
            isStable,
            onBranchCellClick: isStable ? undefined : onBranchCellClick,
            webserverUrl,
            onError: (msg) => showToast(msg, 'error'),
        });
        tr.appendChild(branchCell);
        tr.appendChild(badgeCell);
        tr.appendChild(actionsCell);
    }

    return tr;
}

/**
 * Build the status table section from a list of workspace rows.
 *
 * @param {WorkspaceRowDescriptor[]} rows
 * @param {string}      repoId
 * @param {string}      repoName
 * @param {string|null} webserverUrl
 * @param {function(HTMLElement, string, string): void} onBranchCellClick
 * @returns {{ section: HTMLElement, tbody: HTMLTableSectionElement|null }}
 */
function buildStatusSection(rows, repoId, repoName, webserverUrl, onBranchCellClick) {
    const section = document.createElement('section');
    section.className = 'repository-detail-status-section';

    if (rows.length === 0) {
        const empty = document.createElement('p');
        empty.className   = 'empty-state-inline text-secondary';
        empty.textContent = 'No projects contain this repository.';
        section.appendChild(empty);
        return { section, tbody: null };
    }

    const table = document.createElement('table');
    table.className = 'data-table repository-detail-table';

    const thead = document.createElement('thead');
    const htr   = document.createElement('tr');
    ['Project', 'Workspace', 'Branch', 'Status', 'Actions'].forEach((label) => {
        const th = document.createElement('th');
        th.textContent = label;
        htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach((rowDesc) => {
        tbody.appendChild(buildWorkspaceRow(rowDesc, repoId, repoName, webserverUrl, onBranchCellClick));
    });

    table.appendChild(tbody);
    section.appendChild(table);

    return { section, tbody };
}

/**
 * Update existing rows in-place after a refresh.
 *
 * Locates each `<tr>` by `data-pid` + `data-wid` and calls
 * `updateRepoStatusCells` on initialized workspace rows.
 *
 * @param {HTMLTableSectionElement}      tbody
 * @param {string}                       repoId       - The repository ID being viewed.
 * @param {WorkspaceRowDescriptor[]}     freshRows
 * @param {function(HTMLElement, string, string): void} onBranchCellClick
 */
function updateStatusTable(tbody, repoId, freshRows, onBranchCellClick) {
    for (const rowDesc of freshRows) {
        const { pid, wid, isStable, initialized, statusInfo } = rowDesc;
        const tr = tbody.querySelector(`tr[data-pid="${CSS.escape(pid)}"][data-wid="${CSS.escape(wid)}"]`);
        if (!tr) continue;
        if (!initialized) continue;
        updateRepoStatusCells(tr, repoId, statusInfo, isStable, isStable ? undefined : onBranchCellClick);
    }
}

// ---------------------------------------------------------------------------
// Public view entry point
// ---------------------------------------------------------------------------

/**
 * Render the Repository Detail view.
 *
 * Fetches repository metadata, all projects, workspaces, and Git status in
 * parallel. Then renders the header and status table. The Refresh button
 * re-fetches all status data and updates existing rows in-place.
 *
 * @param {HTMLElement}     container - The `#app` DOM element provided by the router.
 * @param {{ id: string }}  params    - Route parameters.
 */
export function renderRepositoryDetail(container, params) {
    const repoId = params.id;

    // Show loading state immediately.
    showLoading(container, 'Loading repository overview…');

    // Fetch repository metadata, all projects, and webserver URL in parallel.
    Promise.all([
        api.repositories.get(repoId),
        api.projects.list(),
        api.config.webserverUrl.get().catch(() => null),
    ]).then(async ([rawRepo, allProjects, webserverUrlConfig]) => {
        if (!container.isConnected) return;

        const repo = normaliseRepo(rawRepo);
        document.title = `${repo.name || repoId} - ${APP_NAME_SHORT}`;

        // Resolve webserver URL (null when not configured or fetch failed).
        const webserverUrl = (
            webserverUrlConfig &&
            typeof webserverUrlConfig.webserverUrl === 'string' &&
            webserverUrlConfig.webserverUrl !== ''
        )
            ? webserverUrlConfig.webserverUrl
            : null;

        // Load workspace rows (fan-out across projects and workspaces).
        const { rows, anyFailed } = await loadWorkspaceRows(repoId, allProjects || []);

        if (!container.isConnected) return;

        // Wire branch-click handler — dynamically imports the branch quick-switch
        // component to avoid loading it when all workspaces are STABLE.
        /**
         * Handle a click on a branch-switch trigger cell.
         *
         * Reads `tr.dataset.pid` and `tr.dataset.wid` from the nearest ancestor `<tr>`
         * to determine which project and workspace the clicked branch cell belongs to.
         * These attributes are guaranteed to be set on every row built by
         * `buildWorkspaceRow()`, so the lookup is always safe for initialized rows.
         *
         * @param {HTMLElement} anchorEl      - The branch trigger element that was clicked.
         * @param {string}      clickedRepoId - The repository ID for this row.
         * @param {string}      currentBranch - The currently checked-out branch name.
         */
        function onBranchCellClick(anchorEl, clickedRepoId, currentBranch) {
            // Find the row context to extract pid and wid.
            const tr = anchorEl.closest('tr');
            const pid = tr ? tr.dataset.pid : '';
            const wid = tr ? tr.dataset.wid : '';
            import('../components/branch-quick-switch.js')
                .then(({ showBranchQuickSwitch }) =>
                    showBranchQuickSwitch({ anchorEl, projectId: pid, wid, repoId: clickedRepoId, currentBranch }),
                )
                .then((result) => {
                    if (result.switched) doRefresh();
                })
                .catch(() => { showToast('Failed to load branch switcher.', 'error'); });
        }

        // Keep a local copy of rows so the refresh handler can re-use row metadata.
        let currentRows = rows;

        // Build DOM.
        clearElement(container);

        const { header, refreshBtn, lastRefreshedEl } = buildHeader(repo);
        let { section: statusSection, tbody } = buildStatusSection(
            currentRows, repoId, repo.name || repoId, webserverUrl, onBranchCellClick,
        );

        // Refresh handler — re-discovers projects/workspaces and updates the table.
        // Uses force-refresh for status on existing rows; newly discovered rows are
        // added to the table and removed rows are dropped. Protected by a mutex.
        let refreshInProgress = false;

        async function doRefresh() {
            if (refreshInProgress) return;
            refreshInProgress   = true;
            refreshBtn.disabled = true;
            refreshBtn.textContent = 'Refreshing…';

            try {
                // Re-discover the full project/workspace set so that workspaces added
                // since the initial load become visible without a page reload.
                const freshProjects = await api.projects.list().catch(() => null);
                if (!container.isConnected) return;

                const { rows: discoveredRows, anyFailed } = await loadWorkspaceRows(
                    repoId, freshProjects || [],
                );
                if (!container.isConnected) return;

                // Force-refresh status for existing initialized rows.
                const existingKeySet = new Set(currentRows.map((r) => `${r.pid}::${r.wid}`));
                const statusRefreshTasks = discoveredRows
                    .filter((r) => r.initialized && existingKeySet.has(`${r.pid}::${r.wid}`))
                    .map((r) =>
                        api.status.refresh(r.pid, r.wid)
                            .then((statusMap) => ({
                                ...r,
                                statusInfo: (statusMap && statusMap[repoId]) ? statusMap[repoId] : null,
                            }))
                            .catch(() => ({ ...r })),
                    );

                const refreshed = await Promise.allSettled(statusRefreshTasks);
                if (!container.isConnected) return;

                // Merge refreshed statuses into the discovered row set.
                const refreshedMap = new Map();
                for (const res of refreshed) {
                    if (res.status === 'fulfilled') {
                        const r = res.value;
                        refreshedMap.set(`${r.pid}::${r.wid}`, r);
                    }
                }
                const finalRows = discoveredRows.map((r) => {
                    const key = `${r.pid}::${r.wid}`;
                    return refreshedMap.has(key) ? refreshedMap.get(key) : r;
                });

                if (!tbody && finalRows.length > 0) {
                    // Table did not exist before (was empty); rebuild the section.
                    const { section: newSection, tbody: newTbody } = buildStatusSection(
                        finalRows, repoId, repo.name || repoId, webserverUrl, onBranchCellClick,
                    );
                    container.replaceChild(newSection, statusSection);
                    statusSection = newSection;
                    tbody = newTbody;
                } else if (tbody) {
                    const newKeySet = new Set(finalRows.map((r) => `${r.pid}::${r.wid}`));

                    // Remove rows that no longer exist.
                    for (const r of currentRows) {
                        const key = `${r.pid}::${r.wid}`;
                        if (!newKeySet.has(key)) {
                            const tr = tbody.querySelector(`tr[data-pid="${CSS.escape(r.pid)}"][data-wid="${CSS.escape(r.wid)}"]`);
                            if (tr) tr.remove();
                        }
                    }

                    // Append newly discovered rows.
                    for (const r of finalRows) {
                        const key = `${r.pid}::${r.wid}`;
                        if (!existingKeySet.has(key)) {
                            tbody.appendChild(buildWorkspaceRow(
                                r, repoId, repo.name || repoId, webserverUrl, onBranchCellClick,
                            ));
                        }
                    }

                    // Update status for rows present in both old and new sets.
                    updateStatusTable(
                        tbody, repoId,
                        finalRows.filter((r) => existingKeySet.has(`${r.pid}::${r.wid}`)),
                        onBranchCellClick,
                    );
                }

                currentRows = finalRows;

                if (anyFailed && finalRows.length > 0) {
                    showToast('Some workspace data could not be loaded. Results may be incomplete.', 'warning');
                }

                // Persist the refresh timestamp to the server and update the label.
                const updated = await api.repositories.touchRefreshTimestamp(repoId).catch(() => null);
                if (!container.isConnected) return;
                const ts = updated && updated.LastRefreshedAt ? new Date(updated.LastRefreshedAt) : new Date();
                lastRefreshedEl.textContent = `Last refreshed: ${formatRelativeTime(ts)}`;
            } finally {
                refreshInProgress      = false;
                refreshBtn.disabled    = false;
                refreshBtn.textContent = 'Refresh';
            }
        }

        refreshBtn.addEventListener('click', doRefresh);

        // Set initial timestamp from persisted value if available, otherwise show "Never".
        lastRefreshedEl.textContent = repo.LastRefreshedAt
            ? `Last refreshed: ${formatRelativeTime(new Date(repo.LastRefreshedAt))}`
            : 'Last refreshed: Never';

        container.appendChild(header);
        container.appendChild(statusSection);

        // Show a warning toast if some fetches failed (partial data).
        if (anyFailed && rows.length > 0) {
            showToast('Some workspace data could not be loaded. Results may be incomplete.', 'warning');
        }
    }).catch((err) => {
        if (!container.isConnected) return;
        clearElement(container);

        if (err.status === 404) {
            const notFoundEl = document.createElement('div');
            notFoundEl.className = 'empty-state';

            const msgEl = document.createElement('p');
            msgEl.className   = 'empty-state-inline text-secondary';
            msgEl.textContent = `Repository '${repoId}' was not found. It may have been deleted.`;
            notFoundEl.appendChild(msgEl);

            const backLink = document.createElement('a');
            backLink.href      = '#/repositories';
            backLink.className = 'btn btn-secondary';
            backLink.textContent = '← Back to Repositories';
            if (_router) {
                backLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    _router.navigate('#/repositories');
                });
            }
            notFoundEl.appendChild(backLink);

            container.appendChild(notFoundEl);
        } else {
            const errorEl = document.createElement('p');
            errorEl.className   = 'empty-state-inline text-secondary';
            errorEl.textContent = err.message || 'Failed to load repository overview.';
            container.appendChild(errorEl);
        }
    });
}

```
###  Path: `/gui/public/js/views/settings.js`

```js
/**
 * Settings View — Repo Parallelizer GUI.
 *
 * Renders four settings sections:
 *   1. **Git Credentials** — table of per-host PATs with add/delete controls.
 *   2. **Repositories Refresh Delay** — number input for `gitPollingIntervalSeconds`
 *      with client-side validation (min 10) and save/feedback.
 *   3. **Webserver URL** — text input for the base URL of the local webserver
 *      that serves the workspace repositories, enabling the "Browse" button in
 *      the workspace-detail view.
 *   4. **Notes Display** — number inputs for card height (px) and column count
 *      with client-side range validation and save/feedback.
 *
 * This view has no side-effects (no polling), so it returns no cleanup function.
 *
 * @param {HTMLElement} container - The `#app` root element supplied by the router.
 * @param {Object}      _params   - Route params (none for this route).
 */

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { showConfirm } from '../components/confirm-dialog.js';
import { APP_NAME_SHORT } from '../utils/constants.js';
import { createFormField, validateRequired } from '../components/form-helpers.js';
import { clearElement } from '../utils/dom.js';

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

/**
 * Build the `<thead>` for the credentials table.
 *
 * @returns {HTMLElement}
 */
function buildTableHead() {
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');

    ['Host', 'Token', 'Actions'].forEach((label) => {
        const th = document.createElement('th');
        th.textContent = label;
        tr.appendChild(th);
    });

    thead.appendChild(tr);
    return thead;
}

/**
 * Build a single `<tr>` for one credential entry.
 *
 * @param {string}            host       - The hostname key.
 * @param {string}            maskedToken - The masked token string (e.g. `****abc1`).
 * @param {function(): void}  onDeleted  - Callback to refresh the table after deletion.
 * @returns {HTMLTableRowElement}
 */
function buildCredentialRow(host, maskedToken, onDeleted) {
    const tr = document.createElement('tr');
    tr.dataset.credHost = host;

    // ---- Host cell (read-only) ----
    const hostCell = document.createElement('td');
    hostCell.className = 'cred-host-cell';
    hostCell.textContent = host;
    tr.appendChild(hostCell);

    // ---- Masked token cell (read-only) ----
    const tokenCell = document.createElement('td');
    tokenCell.className = 'cred-token-cell text-muted';
    tokenCell.textContent = maskedToken;
    tr.appendChild(tokenCell);

    // ---- Actions cell ----
    const actionsCell = document.createElement('td');
    actionsCell.className = 'cred-actions-cell';

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-danger btn-sm';
    deleteBtn.textContent = 'Delete';

    actionsCell.appendChild(deleteBtn);
    tr.appendChild(actionsCell);

    // ---- Behaviour ----

    deleteBtn.addEventListener('click', async () => {
        try {
            await showConfirm(
                'Delete Credential',
                `Remove the credential for "${host}"? This action cannot be undone.`,
            );
        } catch {
            // User cancelled — do nothing.
            return;
        }

        deleteBtn.disabled = true;
        deleteBtn.textContent = 'Deleting…';

        try {
            await api.config.credentials.delete(host);
            showToast(`Credential for "${host}" deleted.`, 'success');
            onDeleted();
        } catch (err) {
            showToast(err.message || 'Failed to delete credential.', 'error');
            deleteBtn.disabled = false;
            deleteBtn.textContent = 'Delete';
        }
    });

    return tr;
}

// ---------------------------------------------------------------------------
// Credentials table rendering
// ---------------------------------------------------------------------------

/**
 * Render a loading indicator into `tableContainer`.
 *
 * @param {HTMLElement} tableContainer
 */
function showLoading(tableContainer) {
    tableContainer.innerHTML = `
        <div class="loading-indicator" aria-live="polite" aria-label="Loading credentials…">
            <span class="spinner" aria-hidden="true"></span>
            <span>Loading credentials…</span>
        </div>
    `;
}

/**
 * Fetch all credentials and render them into `tableContainer`.
 *
 * @param {HTMLElement} tableContainer
 */
async function renderCredentialsTable(tableContainer) {
    showLoading(tableContainer);

    let credentials;
    try {
        credentials = await api.config.credentials.list();
    } catch (err) {
        clearElement(tableContainer);
        const errorP = document.createElement('p');
        errorP.className = 'error-message';
        errorP.setAttribute('role', 'alert');
        errorP.textContent = `Failed to load credentials: ${err.message || 'Unknown error'}`;
        tableContainer.appendChild(errorP);
        return;
    }

    const entries = Object.entries(credentials || {});

    if (entries.length === 0) {
        tableContainer.innerHTML = `
            <p class="empty-state">No credentials configured. Use the form below to add one.</p>
        `;
        return;
    }

    const table = document.createElement('table');
    table.className = 'credentials-table';
    table.setAttribute('role', 'table');
    table.setAttribute('aria-label', 'Git credentials');

    table.appendChild(buildTableHead());

    const tbody = document.createElement('tbody');

    for (const [host, maskedToken] of entries) {
        tbody.appendChild(buildCredentialRow(host, maskedToken, () => {
            renderCredentialsTable(tableContainer);
        }));
    }

    table.appendChild(tbody);
    clearElement(tableContainer);
    tableContainer.appendChild(table);
}

// ---------------------------------------------------------------------------
// Add / Update credential form
// ---------------------------------------------------------------------------

/**
 * Build the "Add / Update Credential" section with a toggle button and inline form.
 *
 * @param {HTMLElement} tableContainer - Used to trigger a refresh after a successful save.
 * @returns {HTMLElement} The wrapper element containing the toggle button and form.
 */
function buildAddCredentialForm(tableContainer) {
    const section = document.createElement('div');
    section.className = 'add-credential-section';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'btn btn-primary';
    toggleBtn.textContent = 'Add / Update Credential';

    const formWrapper = document.createElement('div');
    formWrapper.className = 'form-wrapper';
    formWrapper.hidden = true;

    const form = document.createElement('form');
    form.noValidate = true;

    form.appendChild(createFormField('Host', 'text', 'host', {
        placeholder: 'e.g. github.com',
        required: true,
    }));

    form.appendChild(createFormField('Token', 'password', 'token', {
        placeholder: 'Personal access token',
        required: true,
    }));

    const actions = document.createElement('div');
    actions.className = 'form-actions';

    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'btn btn-primary';
    submitBtn.textContent = 'Save';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = 'Cancel';

    actions.appendChild(submitBtn);
    actions.appendChild(cancelBtn);
    form.appendChild(actions);
    formWrapper.appendChild(form);

    section.appendChild(toggleBtn);
    section.appendChild(formWrapper);

    // ---- Behaviour ----

    toggleBtn.addEventListener('click', () => {
        formWrapper.hidden = !formWrapper.hidden;
        if (!formWrapper.hidden) {
            const hostInput = form.querySelector('[name="host"]');
            if (hostInput) hostInput.focus();
        }
    });

    cancelBtn.addEventListener('click', () => {
        form.reset();
        formWrapper.hidden = true;
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!validateRequired(form, ['host', 'token'])) return;

        const host  = form.querySelector('[name="host"]').value.trim();
        const token = form.querySelector('[name="token"]').value.trim();

        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving…';

        try {
            await api.config.credentials.set({ host, token });
            showToast(`Credential for "${host}" saved.`, 'success');
            form.reset();
            formWrapper.hidden = true;
            renderCredentialsTable(tableContainer);
        } catch (err) {
            showToast(err.message || 'Failed to save credential.', 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Save';
        }
    });

    return section;
}

// ---------------------------------------------------------------------------
// Repositories Refresh Delay section
// ---------------------------------------------------------------------------

/**
 * Build the "Repositories Refresh Delay" section.
 *
 * Fetches the current server-side `gitPollingIntervalSeconds` value on mount,
 * populates a number input, and exposes a `save()` function for the shared
 * settings footer button.
 *
 * @returns {{ element: HTMLElement, save: () => Promise<boolean> }}
 */
function buildRefreshDelaySection() {
    const section = document.createElement('section');
    section.className = 'settings-section refresh-delay-section';

    const heading = document.createElement('h2');
    heading.textContent = 'Repositories Refresh Delay';
    section.appendChild(heading);

    const description = document.createElement('p');
    description.textContent =
        'How often (in seconds) the server polls remote repositories for new commits. ' +
        'Changes take effect immediately — the current polling cycle is restarted with the new interval. ' +
        'Minimum value is 10 seconds.';
    section.appendChild(description);

    // ---- Input row ----
    const inputRow = document.createElement('div');
    inputRow.className = 'refresh-delay-input-row';

    const label = document.createElement('label');
    label.htmlFor = 'refresh-delay-input';
    label.textContent = 'Interval';
    label.className = 'refresh-delay-label';

    const input = document.createElement('input');
    input.type = 'number';
    input.id = 'refresh-delay-input';
    input.name = 'refreshDelay';
    input.className = 'form-input refresh-delay-input';
    input.min = '10';
    // Maximum matches server-side MAX_POLLING_INTERVAL_SECONDS in src/config/config.constants.ts
    input.max = '86400';
    input.step = '1';
    input.placeholder = '30';
    input.setAttribute('aria-label', 'Polling interval in seconds');

    const unitLabel = document.createElement('span');
    unitLabel.className = 'refresh-delay-unit';
    unitLabel.textContent = 'seconds';

    inputRow.appendChild(label);
    inputRow.appendChild(input);
    inputRow.appendChild(unitLabel);
    section.appendChild(inputRow);

    // ---- Inline error message ----
    const errorMsg = document.createElement('p');
    errorMsg.className = 'error-message';
    errorMsg.setAttribute('role', 'alert');
    errorMsg.hidden = true;
    section.appendChild(errorMsg);

    // ---- Populate current value on mount ----
    (async () => {
        try {
            const cfg = await api.config.polling.get();
            if (cfg && typeof cfg.gitPollingIntervalSeconds === 'number') {
                input.value = String(cfg.gitPollingIntervalSeconds);
            }
        } catch {
            // Non-fatal — leave the placeholder in place.
        }
    })();

    // ---- Save function (called by the shared footer button) ----
    async function save() {
        const raw   = input.value.trim();
        const value = Number(raw);

        if (!raw || !Number.isFinite(value) || !Number.isInteger(value) || value < 10) {
            errorMsg.textContent = 'Please enter a whole number of 10 or more.';
            errorMsg.hidden = false;
            input.focus();
            return false;
        }

        if (value > 86400) {
            errorMsg.textContent = 'Please enter a value of 86400 or less (24 hours maximum).';
            errorMsg.hidden = false;
            input.focus();
            return false;
        }

        errorMsg.hidden = true;

        try {
            await api.config.polling.set(value);
            return true;
        } catch (err) {
            showToast(err.message || 'Failed to save refresh delay.', 'error');
            return false;
        }
    }

    return { element: section, save };
}

// ---------------------------------------------------------------------------
// Webserver URL section
// ---------------------------------------------------------------------------

/**
 * Build the "Webserver URL" section.
 *
 * Fetches the current server-side `webserverUrl` value on mount, populates a
 * text input, and exposes a `save()` function for the shared settings footer
 * button.
 *
 * @returns {{ element: HTMLElement, save: () => Promise<boolean> }}
 */
function buildWebserverUrlSection() {
    const section = document.createElement('section');
    section.className = 'settings-section webserver-url-section';

    const heading = document.createElement('h2');
    heading.textContent = 'Webserver URL';
    section.appendChild(heading);

    const description = document.createElement('p');
    description.textContent =
        'Base URL of the local webserver serving your workspace repositories. ' +
        'When set, a "Browse" button appears in the workspace-detail view for each ' +
        'repository. The URL should point to the root of your projects folder ' +
        '(e.g. http://localhost:8080). Leave empty to hide the Browse button.';
    section.appendChild(description);

    // ---- Input row ----
    const inputRow = document.createElement('div');
    inputRow.className = 'webserver-url-input-row';

    const label = document.createElement('label');
    label.htmlFor = 'webserver-url-input';
    label.textContent = 'URL';
    label.className = 'webserver-url-label';

    const input = document.createElement('input');
    input.type = 'url';
    input.id = 'webserver-url-input';
    input.name = 'webserverUrl';
    input.className = 'form-input webserver-url-input';
    input.placeholder = 'http://localhost:8080';
    input.setAttribute('aria-label', 'Webserver base URL');

    inputRow.appendChild(label);
    inputRow.appendChild(input);
    section.appendChild(inputRow);

    // ---- Inline error message ----
    const errorMsg = document.createElement('p');
    errorMsg.className = 'error-message';
    errorMsg.setAttribute('role', 'alert');
    errorMsg.hidden = true;
    section.appendChild(errorMsg);

    // ---- Populate current value on mount ----
    (async () => {
        try {
            const cfg = await api.config.webserverUrl.get();
            if (cfg && typeof cfg.webserverUrl === 'string') {
                input.value = cfg.webserverUrl;
            }
        } catch {
            // Non-fatal — leave the placeholder in place.
        }
    })();

    // ---- Save function (called by the shared footer button) ----
    async function save() {
        errorMsg.hidden = true;

        try {
            await api.config.webserverUrl.set(input.value.trim());
            return true;
        } catch (err) {
            showToast(err.message || 'Failed to save webserver URL.', 'error');
            return false;
        }
    }

    return { element: section, save };
}

// ---------------------------------------------------------------------------
// Notes Display section
// ---------------------------------------------------------------------------

/**
 * Build the "Notes Display" section.
 *
 * Fetches the current `notesCardHeight` and `notesColumns` values from
 * GET /api/config/notes-display on mount, populates number inputs, and
 * exposes a `save()` function for the shared settings footer button.
 *
 * Card height range : 120–800 px (step 10, default 220).
 * Columns range     : 1–6 (step 1, default 2).
 *
 * @returns {{ element: HTMLElement, save: () => Promise<boolean> }}
 */
function buildNotesDisplaySection() {
    const section = document.createElement('section');
    section.className = 'settings-section notes-display-section';

    const heading = document.createElement('h2');
    heading.textContent = 'Notes Display';
    section.appendChild(heading);

    const description = document.createElement('p');
    description.textContent =
        'Control how notes are presented in the Notes view. ' +
        'Card Height sets the pixel height of each note card; ' +
        'Columns sets how many cards appear side-by-side in the grid.';
    section.appendChild(description);

    // ---- Card Height input row ----
    const cardHeightRow = document.createElement('div');
    cardHeightRow.className = 'notes-display-input-row';

    const cardHeightLabel = document.createElement('label');
    cardHeightLabel.htmlFor = 'notes-card-height-input';
    cardHeightLabel.textContent = 'Card Height';
    cardHeightLabel.className = 'notes-display-label';

    const cardHeightInput = document.createElement('input');
    cardHeightInput.type = 'number';
    cardHeightInput.id = 'notes-card-height-input';
    cardHeightInput.name = 'notesCardHeight';
    cardHeightInput.className = 'form-input notes-display-input';
    cardHeightInput.min = '120';
    cardHeightInput.max = '800';
    cardHeightInput.step = '10';
    cardHeightInput.placeholder = '220';
    cardHeightInput.setAttribute('aria-label', 'Note card height in pixels');

    const cardHeightUnit = document.createElement('span');
    cardHeightUnit.className = 'notes-display-unit';
    cardHeightUnit.textContent = 'px';

    cardHeightRow.appendChild(cardHeightLabel);
    cardHeightRow.appendChild(cardHeightInput);
    cardHeightRow.appendChild(cardHeightUnit);
    section.appendChild(cardHeightRow);

    // ---- Card Height inline error ----
    const cardHeightError = document.createElement('p');
    cardHeightError.className = 'error-message';
    cardHeightError.setAttribute('role', 'alert');
    cardHeightError.hidden = true;
    section.appendChild(cardHeightError);

    // ---- Columns input row ----
    const columnsRow = document.createElement('div');
    columnsRow.className = 'notes-display-input-row';

    const columnsLabel = document.createElement('label');
    columnsLabel.htmlFor = 'notes-columns-input';
    columnsLabel.textContent = 'Columns';
    columnsLabel.className = 'notes-display-label';

    const columnsInput = document.createElement('input');
    columnsInput.type = 'number';
    columnsInput.id = 'notes-columns-input';
    columnsInput.name = 'notesColumns';
    columnsInput.className = 'form-input notes-display-input';
    columnsInput.min = '1';
    columnsInput.max = '6';
    columnsInput.step = '1';
    columnsInput.placeholder = '2';
    columnsInput.setAttribute('aria-label', 'Number of columns in the notes grid');

    columnsRow.appendChild(columnsLabel);
    columnsRow.appendChild(columnsInput);
    section.appendChild(columnsRow);

    // ---- Columns inline error ----
    const columnsError = document.createElement('p');
    columnsError.className = 'error-message';
    columnsError.setAttribute('role', 'alert');
    columnsError.hidden = true;
    section.appendChild(columnsError);

    // ---- Populate current values on mount ----
    (async () => {
        try {
            const cfg = await api.config.notesDisplay.get();
            if (cfg && typeof cfg.notesCardHeight === 'number') {
                cardHeightInput.value = String(cfg.notesCardHeight);
            }
            if (cfg && typeof cfg.notesColumns === 'number') {
                columnsInput.value = String(cfg.notesColumns);
            }
        } catch {
            // Non-fatal — leave the placeholders in place.
        }
    })();

    // ---- Save function (called by the shared footer button) ----
    async function save() {
        let valid = true;

        // Validate card height
        const rawHeight  = cardHeightInput.value.trim();
        const heightVal  = Number(rawHeight);

        if (!rawHeight || !Number.isFinite(heightVal) || !Number.isInteger(heightVal) ||
            heightVal < 120 || heightVal > 800) {
            cardHeightError.textContent = 'Please enter a whole number between 120 and 800.';
            cardHeightError.hidden = false;
            valid = false;
        } else {
            cardHeightError.hidden = true;
        }

        // Validate columns
        const rawColumns = columnsInput.value.trim();
        const columnsVal = Number(rawColumns);

        if (!rawColumns || !Number.isFinite(columnsVal) || !Number.isInteger(columnsVal) ||
            columnsVal < 1 || columnsVal > 6) {
            columnsError.textContent = 'Please enter a whole number between 1 and 6.';
            columnsError.hidden = false;
            valid = false;
        } else {
            columnsError.hidden = true;
        }

        if (!valid) {
            // Focus the first invalid field
            if (!cardHeightError.hidden) {
                cardHeightInput.focus();
            } else {
                columnsInput.focus();
            }
            return false;
        }

        try {
            await api.config.notesDisplay.set({
                notesCardHeight: heightVal,
                notesColumns: columnsVal,
            });
            return true;
        } catch (err) {
            showToast(err.message || 'Failed to save notes display settings.', 'error');
            return false;
        }
    }

    return { element: section, save };
}

// ---------------------------------------------------------------------------
// View entry point
// ---------------------------------------------------------------------------

/**
 * Render the Settings view into `container`.
 *
 * No cleanup function is returned because this view has no side-effects:
 * it does not start polling, install global event listeners, or hold any
 * external resources. The router does not need to call a teardown. This
 * is consistent with the `repositories` view, which follows the same pattern.
 *
 * @param {HTMLElement} container - The `#app` root element supplied by the router.
 * @param {Object}      _params   - Route params (none for this route).
 * @returns {void}
 */
export function renderSettings(container, _params) {
    document.title = 'Settings - ' + APP_NAME_SHORT;
    clearElement(container);

    // Page heading
    const heading = document.createElement('h1');
    heading.textContent = 'Settings';
    container.appendChild(heading);

    // Credentials section
    const credSection = document.createElement('section');
    credSection.className = 'settings-section';

    const credHeading = document.createElement('h2');
    credHeading.textContent = 'Git Credentials';
    credSection.appendChild(credHeading);

    const credDescription = document.createElement('p');
    credDescription.textContent =
        'Manage per-host personal access tokens used for authenticating with private repositories. Tokens are stored masked — only the last 4 characters are visible.';
    credSection.appendChild(credDescription);

    const tableContainer = document.createElement('div');
    tableContainer.className = 'credentials-table-container';
    credSection.appendChild(tableContainer);

    credSection.appendChild(buildAddCredentialForm(tableContainer));
    container.appendChild(credSection);

    // Initial data load
    renderCredentialsTable(tableContainer);

    // ---- Remaining sections ----
    const refreshDelay = buildRefreshDelaySection();
    container.appendChild(refreshDelay.element);

    const webserverUrl = buildWebserverUrlSection();
    container.appendChild(webserverUrl.element);

    const notesDisplay = buildNotesDisplaySection();
    container.appendChild(notesDisplay.element);

    // ---- Form footer ----
    const footer = document.createElement('footer');
    footer.className = 'settings-footer';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = 'Save Settings';
    footer.appendChild(saveBtn);
    container.appendChild(footer);

    saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';

        try {
            const results = await Promise.all([
                refreshDelay.save(),
                webserverUrl.save(),
                notesDisplay.save(),
            ]);

            if (results.every(Boolean)) {
                showToast('Settings saved.', 'success');
            }
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Settings';
        }
    });
}

```
###  Path: `/gui/public/js/views/workspace-detail.js`

```js
/**
 * Workspace Detail View — Repo Parallelizer GUI.
 *
 * Renders the full detail page for a single workspace inside a project:
 *   - Workspace header: ID, description, breadcrumb link back to the project.
 *   - Repository status table: one row per repository, showing current branch,
 *     a color-coded Git status badge, an error/loading indicator for repos
 *     with no status data yet, and an Actions column containing an "Open"
 *     button that opens the repository in GitHub Desktop via
 *     `api.workspaces.launch.githubDesktop(projectId, wid, repoId)`.
 *   - Live polling: status badges refresh in-place via a 1-second countdown
 *     interval that triggers a poll every 10 seconds. A visible countdown
 *     label and a "Refresh Now" button provide user control. The interval
 *     is cleared via the cleanup function returned from
 *     `renderWorkspaceDetail`, which the router calls before navigating
 *     away.
 *   - Actions: "Open in VS Code" button (shown only when workspace is
 *     initialised, dynamically added after a successful Setup — calls
 *     `api.workspaces.launch.vscode`), "Switch Branches" navigation button,
 *     "Rename Workspace" (disabled for STABLE), "Delete Workspace" (disabled
 *     for STABLE).
 *
 * ## Router integration
 *
 * The view uses the same router-injection pattern as `project-detail.js`:
 * `app.js` calls `setRouter(router)` before `router.start()`. The `_router`
 * variable is null-guarded at every navigation site so the view remains
 * functional in test contexts.
 *
 * ## Cleanup contract
 *
 * `renderWorkspaceDetail` returns a cleanup function. The router's `_render`
 * method already stores and calls any function returned by a view. No changes
 * to `router.js` are needed.
 *
 * @module workspace-detail
 */

import { api }               from '../api.js';
import { showToast }         from '../components/toast.js';
import { showConfirm }       from '../components/confirm-dialog.js';
import { buildRepoStatusCells, makeBranchTrigger, updateRepoStatusCells } from '../components/repo-status-cells.js';
import { createFormField, validateRequired, WORKSPACE_ID_PATTERN } from '../components/form-helpers.js';
import { normaliseProject, normaliseWorkspace } from '../utils/normalise.js';
import { STABLE_WS_ID, APP_NAME_SHORT } from '../utils/constants.js';
import { clearElement } from '../utils/dom.js';

// ---------------------------------------------------------------------------
// Router reference — injected from app.js via setRouter()
// ---------------------------------------------------------------------------

/** @type {import('../router.js').Router|null} */
let _router = null;

/**
 * Inject the router instance so workspace-detail can navigate on rename/delete.
 * Called from app.js before the router starts.
 *
 * @param {import('../router.js').Router} router
 */
export function setRouter(router) {
    _router = router;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default polling interval in milliseconds (fallback when config fetch fails). */
const DEFAULT_POLL_INTERVAL_MS = 10_000;



// ---------------------------------------------------------------------------
// Normalisation helpers — imported from utils/normalise.js
// extractRepoId and extractRepoName remain local (workspace-detail only).
// ---------------------------------------------------------------------------

/**
 * Extract a repository's ID from either a plain string or an object.
 * The backend may return Repositories as an array of strings, an array of
 * objects with `Id`/`id`, or an array of objects with `repositoryId`.
 *
 * @param {string|Object} repo
 * @returns {string}
 */
function extractRepoId(repo) {
    if (typeof repo === 'string') return repo;
    return repo.Id || repo.id || repo.RepositoryId || repo.repositoryId || '';
}

/**
 * Extract a human-readable repository name from a repository entry.
 * Falls back to the ID when no name is available.
 *
 * @param {string|Object} repo
 * @returns {string}
 */
function extractRepoName(repo) {
    if (typeof repo === 'string') return repo;
    return repo.Name || repo.name || extractRepoId(repo);
}

// ---------------------------------------------------------------------------
// Loading helper
// ---------------------------------------------------------------------------

/**
 * Render a loading spinner into `el`.
 *
 * @param {HTMLElement} el
 * @param {string} [label]
 */
function showLoading(el, label = 'Loading…') {
    clearElement(el);
    const wrapper = document.createElement('div');
    wrapper.className = 'loading-indicator';
    wrapper.setAttribute('aria-live', 'polite');

    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    spinner.setAttribute('aria-hidden', 'true');
    wrapper.appendChild(spinner);

    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    wrapper.appendChild(labelEl);

    el.appendChild(wrapper);
}

// ---------------------------------------------------------------------------
// Setup helper
// ---------------------------------------------------------------------------

/**
 * Run workspace setup and show appropriate toast notification.
 *
 * @param {string} projectId
 * @param {string} workspaceId
 * @param {string} successMessage - Toast message shown when all repos succeed.
 * @returns {Promise<Object>} The setup result from the API.
 * @throws {Error} Re-throws API errors for the caller to handle.
 */
async function runSetup(projectId, workspaceId, successMessage) {
    const result = await api.workspaces.setup(projectId, workspaceId);
    const failures = (result && result.results || []).filter((r) => !r.success);
    if (failures.length > 0) {
        const names = failures.map((f) => f.repositoryId).join(', ');
        showToast(`Setup complete with errors. Failed to clone: ${names}`, 'warning', 8000);
    } else {
        showToast(successMessage, 'success');
    }
    return result;
}

// ---------------------------------------------------------------------------
// Status table helpers
// ---------------------------------------------------------------------------

/**
 * Build the status `<tbody>` row for a single repository.
 *
 * Constructs only the name `<td>` locally; delegates the branch, badge, and
 * actions cells to {@link buildRepoStatusCells} in `repo-status-cells.js`.
 * That shared component sets `data-repo-id` on the badge wrapper so that
 * {@link updateRepoStatusCells} can locate and replace badge contents in-place
 * without touching the rest of the row.
 *
 * @param {Object} opts
 * @param {string} opts.repoId      - Unique repository identifier (e.g. `"my-repo"`).
 * @param {string} opts.repoName    - Human-readable display name; falls back to
 *                                    `repoId` when no name is available.
 * @param {Object|null} opts.statusInfo - GitStatusInfo object from the API, or
 *                                    `null` when status data is not yet available.
 * @param {string} opts.projectId   - ID of the parent project.
 * @param {string} opts.wid         - ID of the parent workspace.
 * @param {boolean} [opts.isStable] - When `true`, the branch cell is rendered as
 *                                    plain text (no clickable trigger).
 * @param {function(HTMLElement, string, string): void} [opts.onBranchCellClick]
 *                                  - Callback invoked with `(anchorEl, repoId,
 *                                    currentBranch)` when the branch cell trigger is
 *                                    clicked. Only wired when `!isStable`.
 * @param {string|null} [opts.webserverUrl] - Base URL of the local webserver. When
 *                                    truthy, a "Browse" button is prepended before
 *                                    the "Git GUI" button.
 * @returns {HTMLTableRowElement}
 */
function buildRepoStatusRow({ repoId, repoName, statusInfo, projectId, wid, isStable, onBranchCellClick, webserverUrl }) {
    const tr = document.createElement('tr');
    tr.dataset.repoId   = repoId;
    tr.dataset.repoName = repoName;

    // Repository name / ID
    const nameCell = document.createElement('td');
    nameCell.className = 'repo-name-cell';
    const nameEl = document.createElement('span');
    nameEl.className = 'repo-name';
    nameEl.textContent = repoName;
    if (repoName !== repoId) {
        const idHint = document.createElement('span');
        idHint.className = 'text-muted repo-id-hint';
        idHint.textContent = ` (${repoId})`;
        nameEl.appendChild(idHint);
    }
    nameCell.appendChild(nameEl);
    tr.appendChild(nameCell);

    // Branch, badge, and actions cells — delegated to shared component.
    const { branchCell, badgeCell, actionsCell } = buildRepoStatusCells({
        repoId,
        repoName,
        statusInfo,
        projectId,
        wid,
        isStable,
        onBranchCellClick,
        webserverUrl,
        onError: (msg) => showToast(msg, 'error'),
    });
    tr.appendChild(branchCell);
    tr.appendChild(badgeCell);
    tr.appendChild(actionsCell);

    return tr;
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

/**
 * Build the rename workspace inline form and wire up its event handlers.
 *
 * @param {string} projectId
 * @param {{ id: string }} workspace
 * @param {HTMLButtonElement} renameBtn - The "Rename" button that toggles form visibility.
 * @returns {HTMLElement}
 */
function buildRenameForm(projectId, workspace, renameBtn) {
    const wrapper = document.createElement('div');
    wrapper.className = 'rename-workspace-form-wrapper card';
    wrapper.hidden = true;

    const formTitle = document.createElement('h4');
    formTitle.className   = 'form-section-title';
    formTitle.textContent = 'Rename Workspace';
    wrapper.appendChild(formTitle);

    const newIdField = createFormField('New Workspace ID', 'text', 'newWorkspaceId', {
        required:    true,
        placeholder: 'e.g. DEV or FEATURE',
        hint:        'Must be 2–10 uppercase letters (A-Z only).',
    });
    wrapper.appendChild(newIdField);

    const newIdInput   = newIdField.querySelector('[name="newWorkspaceId"]');
    const newIdErrorEl = newIdField.querySelector('.field-error');

    const formActions = document.createElement('div');
    formActions.className = 'form-actions';

    const saveBtn = document.createElement('button');
    saveBtn.type      = 'button';
    saveBtn.className = 'btn btn-primary btn-sm';
    saveBtn.textContent = 'Save';

    const cancelFormBtn = document.createElement('button');
    cancelFormBtn.type      = 'button';
    cancelFormBtn.className = 'btn btn-secondary btn-sm';
    cancelFormBtn.textContent = 'Cancel';

    formActions.appendChild(saveBtn);
    formActions.appendChild(cancelFormBtn);
    wrapper.appendChild(formActions);

    // Behaviour
    renameBtn.addEventListener('click', () => {
        wrapper.hidden = false;
        if (newIdInput) newIdInput.focus();
    });

    cancelFormBtn.addEventListener('click', () => {
        wrapper.hidden = true;
        if (newIdInput) newIdInput.value = '';
        if (newIdErrorEl) newIdErrorEl.hidden = true;
    });

    saveBtn.addEventListener('click', async () => {
        if (newIdErrorEl) newIdErrorEl.hidden = true;
        if (newIdInput) {
            newIdInput.classList.remove('error');
            newIdInput.removeAttribute('aria-invalid');
        }

        if (!validateRequired(wrapper, ['newWorkspaceId'])) return;

        const newId = newIdInput ? newIdInput.value.trim() : '';

        if (!WORKSPACE_ID_PATTERN.test(newId)) {
            if (newIdErrorEl) {
                newIdErrorEl.textContent = 'Must be 2–10 uppercase letters (A-Z only).';
                newIdErrorEl.hidden      = false;
            }
            if (newIdInput) {
                newIdInput.classList.add('error');
                newIdInput.setAttribute('aria-invalid', 'true');
                newIdInput.focus();
            }
            return;
        }

        try {
            await showConfirm(
                'Rename Workspace',
                `Rename workspace "${workspace.id}" to "${newId}"? The page will navigate to the new workspace URL.`,
            );
        } catch {
            return;
        }

        saveBtn.disabled    = true;
        saveBtn.textContent = 'Saving…';

        try {
            await api.workspaces.rename(projectId, workspace.id, newId);
            showToast(`Workspace renamed to "${newId}".`, 'success');
            const target = `#/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(newId)}`;
            if (_router) {
                _router.navigate(target);
            } else {
                location.hash = target;
            }
        } catch (err) {
            showToast(err.message || 'Failed to rename workspace.', 'error');
            saveBtn.disabled    = false;
            saveBtn.textContent = 'Save';
        }
    });

    return wrapper;
}

/**
 * Build the "Open in VS Code" button and wire its click handler.
 *
 * The button calls `api.workspaces.launch.vscode` and shows a success or error
 * toast based on the API response. It is only rendered when the workspace is
 * initialised (`workspace.initialized === true`).
 *
 * @param {string} projectId
 * @param {string} workspaceId
 * @returns {HTMLButtonElement}
 */
function buildOpenVscodeButton(projectId, workspaceId) {
    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'btn btn-secondary btn-sm';
    btn.textContent = 'Open in VS Code';
    btn.title = 'Open this workspace folder in Visual Studio Code.';

    btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Opening…';

        try {
            await api.workspaces.launch.vscode(projectId, workspaceId);
            showToast('VS Code launched for this workspace.', 'success');
        } catch (err) {
            showToast(err.message || 'Failed to open VS Code.', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Open in VS Code';
        }
    });

    return btn;
}

/**
 * Build the workspace header section — compact layout with breadcrumb,
 * workspace name, and a meta card for description + management actions.
 *
 * @param {string} projectId
 * @param {{ id: string, description: string, initialized: boolean, folderPath: string }} workspace
 * @param {boolean} isStable
 * @param {function(): void} [onSetupSuccess] - Called after a successful workspace setup, *after* the
 *   DOM mutation is complete (setupBtn removed from mgmtRow, vscodeBtn inserted before renameBtn,
 *   and `workspace.initialized` set to `true`). Intended to trigger a status refresh in the caller.
 * @returns {HTMLElement}
 */
function buildHeaderSection(projectId, workspace, isStable, onSetupSuccess) {
    const wrapper = document.createElement('div');
    wrapper.className = 'workspace-detail-header';

    // Breadcrumb
    const breadcrumb = document.createElement('nav');
    breadcrumb.className = 'breadcrumb back-link text-muted';
    breadcrumb.setAttribute('aria-label', 'Breadcrumb');

    const projectLink = document.createElement('a');
    projectLink.href      = `#/projects/${encodeURIComponent(projectId)}`;
    projectLink.textContent = `← ${projectId}`;
    projectLink.className = 'breadcrumb-link';
    if (_router) {
        projectLink.addEventListener('click', (e) => {
            e.preventDefault();
            _router.navigate(`#/projects/${encodeURIComponent(projectId)}`);
        });
    }
    breadcrumb.appendChild(projectLink);
    wrapper.appendChild(breadcrumb);

    // Title row: workspace ID
    const titleRow = document.createElement('div');
    titleRow.className = 'workspace-meta-top-row';

    const titleEl = document.createElement('h1');
    titleEl.className   = 'project-meta-name';
    titleEl.textContent = workspace.id;
    titleRow.appendChild(titleEl);

    // Description (inline, muted)
    if (workspace.description) {
        const descEl = document.createElement('span');
        descEl.className   = 'project-meta-id text-muted';
        descEl.textContent = workspace.description;
        titleRow.appendChild(descEl);
    }

    wrapper.appendChild(titleRow);

    // Folder path row (shown when path is available)
    if (workspace.folderPath) {
        const pathRow = document.createElement('div');
        pathRow.className = 'workspace-folder-path-row';

        const pathLabel = document.createElement('span');
        pathLabel.className = 'text-muted';
        pathLabel.textContent = 'Path: ';

        const pathValue = document.createElement('code');
        pathValue.className = 'workspace-folder-path font-mono';
        pathValue.textContent = workspace.folderPath;

        pathRow.appendChild(pathLabel);
        pathRow.appendChild(pathValue);
        wrapper.appendChild(pathRow);
    }

    // Management row: rename, delete, setup
    const mgmtRow = document.createElement('div');
    mgmtRow.className = 'workspace-mgmt-row';

    // Rename button — declared early so the setupBtn click handler can reference
    // it without a forward reference. Appended to mgmtRow after conditional buttons
    // (Setup / VS Code) so the visual order is: [Setup|VS Code] → Rename → Delete.
    const renameBtn = document.createElement('button');
    renameBtn.type      = 'button';
    renameBtn.className = 'btn btn-secondary btn-sm';
    renameBtn.textContent = 'Rename';

    if (isStable) {
        renameBtn.disabled = true;
        renameBtn.title    = 'The STABLE workspace cannot be renamed.';
    }

    // Setup button (if not initialized)
    if (!workspace.initialized) {
        const setupBtn = document.createElement('button');
        setupBtn.type      = 'button';
        setupBtn.className = 'btn btn-primary btn-sm';
        setupBtn.textContent = 'Setup Workspace';
        setupBtn.title = 'Initialize workspace on disk (create folder, clone repos).';

        setupBtn.addEventListener('click', async () => {
            setupBtn.disabled = true;
            setupBtn.textContent = 'Setting up…';

            try {
                await runSetup(projectId, workspace.id,
                    `Workspace "${workspace.id}" set up successfully.`);

                // Update DOM in-place — remove setup button, insert "Open in VS Code",
                // update state flag, and notify caller.
                setupBtn.remove();
                workspace.initialized = true;
                const vscodeBtn = buildOpenVscodeButton(projectId, workspace.id);
                mgmtRow.insertBefore(vscodeBtn, renameBtn);
                if (onSetupSuccess) onSetupSuccess();
            } catch (err) {
                showToast(err.message || 'Failed to set up workspace.', 'error');
                setupBtn.disabled = false;
                setupBtn.textContent = 'Setup Workspace';
            }
        });
        mgmtRow.appendChild(setupBtn);
    }

    // "Open in VS Code" button — shown only when the workspace is initialized
    if (workspace.initialized) {
        mgmtRow.appendChild(buildOpenVscodeButton(projectId, workspace.id));
    }

    mgmtRow.appendChild(renameBtn);

    // Delete button (disabled for STABLE)
    const deleteBtn = document.createElement('button');
    deleteBtn.type      = 'button';
    deleteBtn.className = 'btn btn-danger btn-sm';
    deleteBtn.textContent = 'Delete';

    if (isStable) {
        deleteBtn.disabled = true;
        deleteBtn.title    = 'The STABLE workspace cannot be deleted.';
    }
    mgmtRow.appendChild(deleteBtn);

    wrapper.appendChild(mgmtRow);

    // Rename inline form + delete handler (non-STABLE only)
    if (!isStable) {
        wrapper.appendChild(buildRenameForm(projectId, workspace, renameBtn));

        deleteBtn.addEventListener('click', async () => {
            try {
                await showConfirm(
                    'Delete Workspace',
                    `Delete workspace "${workspace.id}"? All cloned repositories in this workspace will be permanently removed. This action cannot be undone.`,
                );
            } catch {
                return;
            }

            deleteBtn.disabled    = true;
            deleteBtn.textContent = 'Deleting…';

            try {
                await api.workspaces.delete(projectId, workspace.id);
                showToast(`Workspace "${workspace.id}" deleted.`, 'success');
                if (_router) {
                    _router.navigate(`#/projects/${encodeURIComponent(projectId)}`);
                } else {
                    location.hash = `#/projects/${encodeURIComponent(projectId)}`;
                }
            } catch (err) {
                showToast(err.message || 'Failed to delete workspace.', 'error');
                deleteBtn.disabled    = false;
                deleteBtn.textContent = 'Delete';
            }
        });
    }

    return wrapper;
}

/**
 * Build the repository status table section.
 *
 * @param {Array<{ repoId: string, repoName: string }>} repos
 * @param {Record<string, Object|null>} statusMap
 * @param {string} projectId - Project ID, threaded to each row's "Open" button.
 * @param {string} wid - Workspace ID, threaded to each row's "Open" button.
 * @param {boolean} [isStable] - When `true`, branch cells render as plain text.
 * @param {function(HTMLElement, string, string): void} [onBranchCellClick]
 *   Callback forwarded to each `buildRepoStatusRow()` call.
 * @param {string|null} [webserverUrl] - Base URL for the Browse button. When
 *   truthy, each row gains a "Browse" button before the "Git GUI" button.
 * @returns {{ section: HTMLElement, tbody: HTMLTableSectionElement }}
 */
function buildStatusTableSection(repos, statusMap, projectId, wid, isStable, onBranchCellClick, webserverUrl) {
    const section = document.createElement('section');
    section.className = 'workspace-status-section';

    if (repos.length === 0) {
        const empty = document.createElement('p');
        empty.className   = 'empty-state-inline text-secondary';
        empty.textContent = 'No repositories in this project.';
        section.appendChild(empty);
        return { section, tbody: null };
    }

    const table = document.createElement('table');
    table.className = 'data-table workspace-status-table';

    const thead = document.createElement('thead');
    const htr   = document.createElement('tr');
    ['Repository', 'Branch', 'Status', 'Actions'].forEach((label) => {
        const th = document.createElement('th');
        th.textContent = label;
        htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    repos.forEach(({ repoId, repoName }) => {
        const statusInfo = statusMap[repoId] ?? null;
        tbody.appendChild(buildRepoStatusRow({ repoId, repoName, statusInfo, projectId, wid, isStable, onBranchCellClick, webserverUrl }));
    });

    table.appendChild(tbody);
    section.appendChild(table);

    return { section, tbody };
}

/**
 * Build the Switch Branches button.
 *
 * @param {string} projectId
 * @param {string} wid        - Workspace ID.
 * @returns {HTMLElement}
 */
function buildSwitchBranchesButton(projectId, wid) {
    const switchBtn = document.createElement('button');
    switchBtn.type      = 'button';
    switchBtn.className = 'btn btn-primary';
    switchBtn.textContent = 'Switch Branches';
    switchBtn.addEventListener('click', () => {
        const target = `#/projects/${encodeURIComponent(projectId)}/workspaces/${encodeURIComponent(wid)}/branch-switch`;
        if (_router) {
            _router.navigate(target);
        } else {
            location.hash = target;
        }
    });
    return switchBtn;
}

/**
 * Build the refresh toolbar row with progress bar and "Refresh Now" button.
 *
 * @returns {HTMLElement}
 */
function buildRefreshToolbar() {
    const toolbar = document.createElement('div');
    toolbar.className = 'workspace-refresh-toolbar';

    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'btn btn-secondary btn-sm refresh-now-btn';
    btn.textContent = 'Refresh Now';
    toolbar.appendChild(btn);

    const track = document.createElement('div');
    track.className = 'refresh-progress-track';
    const bar = document.createElement('div');
    bar.className = 'refresh-progress-bar';
    track.appendChild(bar);
    toolbar.appendChild(track);

    return toolbar;
}

// ---------------------------------------------------------------------------
// Health alert section
// ---------------------------------------------------------------------------

/**
 * Build a health alert section element from a workspace health report.
 * Returns `null` when the workspace is healthy (no issues to display).
 *
 * Fix-action buttons are wired via the `callbacks` argument so the
 * caller can inject async handlers that match the surrounding view's
 * closure state (project/workspace IDs, toast helper, etc.).
 *
 * @param {{ healthy: boolean, issues: Array<{ type: string, severity: string, message: string, fixAction: string, repositoryId?: string }> }|null} healthReport
 * @param {{ onRegenerate: function(): Promise<void>, onSetup: function(): Promise<void> }} callbacks
 * @returns {HTMLElement|null}
 */
function buildHealthAlertSection(healthReport, callbacks) {
    if (
        !healthReport ||
        healthReport.healthy ||
        !Array.isArray(healthReport.issues) ||
        healthReport.issues.length === 0
    ) {
        return null;
    }

    const section = document.createElement('div');
    section.className = 'health-alert';

    const title = document.createElement('div');
    title.className = 'health-alert-title';
    title.textContent = 'Workspace health issues detected';
    section.appendChild(title);

    for (const issue of healthReport.issues) {
        const row = document.createElement('div');
        row.className = 'health-alert-issue';

        const msg = document.createElement('span');
        msg.className = 'health-alert-issue__message';
        msg.textContent = issue.message;
        row.appendChild(msg);

        if (issue.fixAction === 'regenerate-workspace-file') {
            const actionWrap = document.createElement('span');
            actionWrap.className = 'health-alert-issue__action';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-secondary btn-sm';
            btn.textContent = 'Regenerate File';
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                btn.textContent = 'Regenerating\u2026';
                try {
                    await callbacks.onRegenerate();
                } finally {
                    btn.disabled = false;
                    btn.textContent = 'Regenerate File';
                }
            });
            actionWrap.appendChild(btn);
            row.appendChild(actionWrap);
        } else if (issue.fixAction === 'setup-workspace') {
            const actionWrap = document.createElement('span');
            actionWrap.className = 'health-alert-issue__action';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-secondary btn-sm';
            btn.textContent = 'Fix Setup';
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                btn.textContent = 'Setting up\u2026';
                try {
                    await callbacks.onSetup();
                } finally {
                    btn.disabled = false;
                    btn.textContent = 'Fix Setup';
                }
            });
            actionWrap.appendChild(btn);
            row.appendChild(actionWrap);
        }
        // Issues with an unknown fixAction render the message row without a button.

        section.appendChild(row);
    }

    return section;
}

// ---------------------------------------------------------------------------
// Notes section builder
// ---------------------------------------------------------------------------

/**
 * Build the Notes textarea section with debounced auto-save and status indicator.
 *
 * @param {string} initialNotes - Pre-populated notes value from the workspace.
 * @param {function(string): Promise<void>} onSave - Called with the current
 *   textarea value after the 1000 ms debounce; should persist the notes.
 * @returns {HTMLElement}
 */
function buildNotesSection(initialNotes, onSave) {
    const section = document.createElement('section');
    section.className = 'workspace-notes-section';

    const label = document.createElement('label');
    label.htmlFor = 'workspace-notes-textarea';
    label.className = 'workspace-notes-label';
    label.textContent = 'Notes';
    section.appendChild(label);

    const textarea = document.createElement('textarea');
    textarea.id = 'workspace-notes-textarea';
    textarea.className = 'workspace-notes-textarea';
    textarea.value = initialNotes;
    section.appendChild(textarea);

    const statusEl = document.createElement('span');
    statusEl.className = 'workspace-notes-status';
    statusEl.setAttribute('aria-live', 'polite');
    statusEl.hidden = true;
    section.appendChild(statusEl);

    let debounceTimer = null;

    textarea.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
            statusEl.textContent = 'Saving\u2026';
            statusEl.hidden = false;
            try {
                await onSave(textarea.value);
                statusEl.textContent = 'Saved';
                setTimeout(() => { statusEl.hidden = true; }, 3000);
            } catch {
                statusEl.textContent = 'Save failed.';
            }
        }, 1000);
    });

    return section;
}

// ---------------------------------------------------------------------------
// Public view entry point
// ---------------------------------------------------------------------------

/**
 * Render the workspace detail view.
 *
 * Fetches workspace metadata, project (for the repositories list), polling
 * configuration, and initial Git status in parallel. Then starts a polling
 * interval that updates badges in-place using the server-configured interval
 * (falls back to {@link DEFAULT_POLL_INTERVAL_MS} if the config fetch fails).
 *
 * @param {HTMLElement} container - The `#app` DOM element provided by the router.
 * @param {{ id: string, wid: string }} params - Route parameters.
 * @returns {function(): void} Cleanup function — clears the polling interval.
 *   The router stores and calls this before rendering the next view.
 */
export function renderWorkspaceDetail(container, params) {
    const projectId = params.id;
    const wid       = params.wid;

    let countdownInterval = null;

    // Return the cleanup function immediately so the router can register it
    // even if the async bootstrap hasn't resolved yet.
    const cleanup = () => {
        if (countdownInterval !== null) {
            clearInterval(countdownInterval);
            countdownInterval = null;
        }
    };

    // Show loading state immediately.
    showLoading(container, 'Loading workspace…');

    // Kick off parallel data fetch.
    Promise.all([
        api.workspaces.get(projectId, wid),
        api.projects.get(projectId),
        api.status.refresh(projectId, wid).catch(() => null),
        api.config.polling.get().catch(() => null),
        api.workspaces.health(projectId, wid).catch(() => null),
        api.config.webserverUrl.get().catch(() => null),
    ]).then((results) => {
        const [rawWorkspace, rawProject, statusMap, pollingConfig, healthReport, webserverUrlConfig] = results;
        // Guard: if the container was cleared by navigation before we resolved,
        // do nothing and let the cleanup function handle the interval.
        if (!container.isConnected) return;

        const workspace = normaliseWorkspace(rawWorkspace);
        const project   = normaliseProject(rawProject);
        document.title = `${project.name || projectId} ${wid} - ${APP_NAME_SHORT}`;

        // Build repo list: [{ repoId, repoName }, …]
        const repos = project.repositories.map((r) => ({
            repoId:   extractRepoId(r),
            repoName: extractRepoName(r),
        })).filter((r) => r.repoId !== '');

        // Render the view.
        clearElement(container);

        const isStable = wid === STABLE_WS_ID;

        // Resolve the effective poll interval from server config, with fallback.
        const pollIntervalMs = (
            pollingConfig &&
            typeof pollingConfig.gitPollingIntervalSeconds === 'number' &&
            Number.isFinite(pollingConfig.gitPollingIntervalSeconds) &&
            pollingConfig.gitPollingIntervalSeconds > 0
        )
            ? pollingConfig.gitPollingIntervalSeconds * 1000
            : DEFAULT_POLL_INTERVAL_MS;

        // Resolve webserver URL (null when not configured or fetch failed).
        const webserverUrl = (
            webserverUrlConfig &&
            typeof webserverUrlConfig.webserverUrl === 'string' &&
            webserverUrlConfig.webserverUrl !== ''
        )
            ? webserverUrlConfig.webserverUrl
            : null;

        // Build status table first to obtain tbody reference for helpers.
        const { section: statusSection, tbody } = buildStatusTableSection(repos, statusMap || {}, projectId, wid, isStable, onBranchCellClick, webserverUrl);

        // -------------------------------------------------------------------
        // Refresh helpers (referenced by toolbar, polling, and setup)
        // -------------------------------------------------------------------

        let remainingSeconds = pollIntervalMs / 1000;
        let refreshInProgress = false;

        // Retry row reference — kept so polling can update/hide it.
        let retryRow = null;
        let retryHint = null;

        // Toolbar elements — built now, wired after helpers are defined.
        const toolbar = buildRefreshToolbar();
        const progressBar = toolbar.querySelector('.refresh-progress-bar');
        const refreshNowBtn = toolbar.querySelector('.refresh-now-btn');

        // Health section container — always in DOM between header and toolbar;
        // empty when the workspace is healthy.
        const healthContainerEl = document.createElement('div');

        // Latest health report — kept in sync by renderHealthSection so that
        // updateMissingReposRow can exclude repos already covered by health alerts.
        let currentHealthReport = healthReport;

        /**
         * Re-evaluate missing repos after a status update and hide/update
         * the retry row accordingly.
         *
         * Repos flagged by a `repository-not-cloned` health alert (fixAction:
         * `setup-workspace`) are excluded from the missing-repos count here
         * because the health alert already surfaces a fix button for them.
         * This row is therefore reserved for the transient polling-lag case
         * where `.git/` is present but status data has not arrived yet.
         */
        function updateMissingReposRow(freshStatusMap) {
            const notClonedIds = new Set(
                (currentHealthReport && Array.isArray(currentHealthReport.issues)
                    ? currentHealthReport.issues : [])
                    .filter((i) => i.fixAction === 'setup-workspace' && i.repositoryId)
                    .map((i) => i.repositoryId),
            );
            const currentMissing = repos.filter(
                (r) => !freshStatusMap[r.repoId] && !notClonedIds.has(r.repoId),
            );
            if (currentMissing.length === 0) {
                if (retryRow) {
                    retryRow.remove();
                    retryRow = null;
                    retryHint = null;
                }
            } else if (retryHint) {
                retryHint.textContent = `${currentMissing.length} ${currentMissing.length === 1 ? 'repository has' : 'repositories have'} no data \u2014 clone may have failed.`;
            }
        }

        /**
         * Rebuild the health alert container from the given health report.
         * Updates `currentHealthReport` first so subsequent
         * `updateMissingReposRow` calls reflect the latest health state.
         *
         * @param {{ healthy: boolean, issues: Array }|null} report
         */
        function renderHealthSection(report) {
            currentHealthReport = report;
            clearElement(healthContainerEl);
            const el = buildHealthAlertSection(report, {
                onRegenerate: async () => {
                    try {
                        await api.workspaces.regenerateFile(projectId, wid);
                        showToast('Workspace file regenerated.', 'success');
                        await fetchAndRenderHealth();
                    } catch (err) {
                        showToast(err.message || 'Failed to regenerate workspace file.', 'error');
                    }
                },
                onSetup: async () => {
                    try {
                        await runSetup(projectId, wid, 'Workspace setup complete.');
                        doRefresh();
                        await fetchAndRenderHealth();
                    } catch (err) {
                        showToast(err.message || 'Failed to set up workspace.', 'error');
                    }
                },
            });
            if (el) {
                healthContainerEl.appendChild(el);
            }
        }

        /**
         * Fetch the latest health report from the API and re-render the
         * health alert section in-place. Silently ignores network errors.
         */
        async function fetchAndRenderHealth() {
            try {
                const fresh = await api.workspaces.health(projectId, wid);
                if (container.isConnected) {
                    renderHealthSection(fresh);
                }
            } catch {
                // Silently ignore health fetch errors — stale UI remains.
            }
        }

        /**
         * Automatic poll — uses cached status endpoint.
         */
        async function doPoll() {
            if (refreshInProgress) return;
            refreshInProgress = true;
            try {
                const [fresh, freshHealth] = await Promise.all([
                    api.status.get(projectId, wid),
                    api.workspaces.health(projectId, wid).catch(() => null),
                ]);
                if (container.isConnected) {
                    renderHealthSection(freshHealth);
                    if (fresh) {
                        for (const [repoId, statusInfo] of Object.entries(fresh)) {
                            const row = tbody.querySelector(`tr[data-repo-id="${CSS.escape(repoId)}"]`);
                            if (!row) continue;
                            updateRepoStatusCells(row, repoId, statusInfo, isStable, onBranchCellClick);
                        }
                        updateMissingReposRow(fresh);
                    }
                }
            } catch {
                // Silently ignore polling errors — stale badges remain.
            } finally {
                refreshInProgress = false;
                remainingSeconds = pollIntervalMs / 1000;
                progressBar.classList.remove('refreshing');
                progressBar.style.width = '0%';
            }
        }

        /**
         * Manual force-refresh — calls the live git-fetch endpoint.
         */
        async function doRefresh() {
            if (refreshInProgress) return;
            refreshInProgress = true;
            refreshNowBtn.disabled = true;
            progressBar.classList.add('refreshing');
            try {
                const [fresh, freshHealth] = await Promise.all([
                    api.status.refresh(projectId, wid),
                    api.workspaces.health(projectId, wid).catch(() => null),
                ]);
                if (container.isConnected) {
                    renderHealthSection(freshHealth);
                    if (fresh) {
                        for (const [repoId, statusInfo] of Object.entries(fresh)) {
                            const row = tbody.querySelector(`tr[data-repo-id="${CSS.escape(repoId)}"]`);
                            if (!row) continue;
                            updateRepoStatusCells(row, repoId, statusInfo, isStable, onBranchCellClick);
                        }
                        updateMissingReposRow(fresh);
                    }
                }
            } catch {
                // Silently ignore — stale badges remain.
            } finally {
                refreshInProgress = false;
                refreshNowBtn.disabled = false;
                remainingSeconds = pollIntervalMs / 1000;
                progressBar.classList.remove('refreshing');
                progressBar.style.width = '0%';
            }
        }

        /**
         * Start the 1-second countdown interval.
         */
        function startCountdown() {
            if (countdownInterval) return;
            countdownInterval = setInterval(() => {
                if (!container.isConnected) {
                    cleanup();
                    return;
                }
                remainingSeconds--;
                if (remainingSeconds <= 0) {
                    progressBar.classList.add('refreshing');
                    doPoll();
                } else {
                    const totalSeconds = pollIntervalMs / 1000;
                    const pct = ((totalSeconds - remainingSeconds) / totalSeconds) * 100;
                    progressBar.style.width = `${pct}%`;
                }
            }, 1000);
        }

        refreshNowBtn.addEventListener('click', doRefresh);

        /**
         * Handle a click on a branch cell trigger in the status table.
         *
         * Dynamically imports the branch-quick-switch component (avoiding
         * loading it in STABLE workspaces or on initial page load), shows the
         * popover anchored below `anchorEl`, then triggers a status refresh on
         * a successful switch.
         *
         * @param {HTMLElement} anchorEl      - The clicked trigger button.
         * @param {string}      repoId        - Repository ID to switch.
         * @param {string}      currentBranch - Currently checked-out branch name.
         */
        function onBranchCellClick(anchorEl, repoId, currentBranch) {
            import('../components/branch-quick-switch.js')
                .then(({ showBranchQuickSwitch }) =>
                    showBranchQuickSwitch({ anchorEl, projectId, wid, repoId, currentBranch }),
                )
                .then((result) => { if (result.switched) doRefresh(); })
                .catch(() => { showToast('Failed to load branch switcher.', 'error'); });
        }

        // Setup success callback — hides setup button, triggers refresh.
        const onSetupSuccess = () => {
            doRefresh();
            if (!countdownInterval && tbody && repos.length > 0) {
                startCountdown();
            }
        };

        // -------------------------------------------------------------------
        // Assemble DOM
        // -------------------------------------------------------------------

        container.appendChild(buildHeaderSection(projectId, workspace, isStable, onSetupSuccess));

        // Health alert section — sits between the header and the refresh toolbar.
        // Populated by renderHealthSection(); empty div when workspace is healthy.
        container.appendChild(healthContainerEl);
        renderHealthSection(healthReport);

        // Refresh toolbar (between header and status table)
        if (repos.length > 0) {
            container.appendChild(toolbar);
        }

        container.appendChild(statusSection);

        // Show "Retry Setup" when the workspace is initialized but some repos
        // have no status data AND are not already covered by a health alert.
        // Health alerts handle the missing-.git/ case (fixAction: setup-workspace);
        // this block targets the transient polling-lag case where .git/ is present
        // but the background status sweep hasn't returned data yet.
        const safeStatusMap = statusMap || {};
        const notClonedRepoIds = new Set(
            (healthReport && Array.isArray(healthReport.issues) ? healthReport.issues : [])
                .filter((i) => i.fixAction === 'setup-workspace' && i.repositoryId)
                .map((i) => i.repositoryId),
        );
        const missingRepos = repos.filter(
            (r) => !safeStatusMap[r.repoId] && !notClonedRepoIds.has(r.repoId),
        );
        if (workspace.initialized && missingRepos.length > 0) {
            retryRow = document.createElement('div');
            retryRow.className = 'workspace-mgmt-row';

            retryHint = document.createElement('span');
            retryHint.className = 'text-secondary text-sm';
            retryHint.textContent = `${missingRepos.length} ${missingRepos.length === 1 ? 'repository has' : 'repositories have'} no data \u2014 clone may have failed.`;
            retryRow.appendChild(retryHint);

            const retryBtn = document.createElement('button');
            retryBtn.type      = 'button';
            retryBtn.className = 'btn btn-secondary btn-sm';
            retryBtn.textContent = 'Retry Setup';
            retryBtn.title = 'Re-run workspace setup to clone missing repositories.';

            retryBtn.addEventListener('click', async () => {
                retryBtn.disabled = true;
                retryBtn.textContent = 'Setting up\u2026';

                try {
                    await runSetup(projectId, workspace.id,
                        'All repositories cloned successfully.');

                    // Trigger immediate refresh to update the status table.
                    doRefresh();
                } catch (err) {
                    showToast(err.message || 'Failed to set up workspace.', 'error');
                    retryBtn.disabled = false;
                    retryBtn.textContent = 'Retry Setup';
                }
            });

            retryRow.appendChild(retryBtn);
            container.appendChild(retryRow);
        }

        if (!isStable) {
            container.appendChild(buildSwitchBranchesButton(projectId, wid));
        }

        // Notes section — always shown below the status table.
        container.appendChild(buildNotesSection(workspace.notes, async (notes) => {
            await api.workspaces.update(projectId, wid, { notes });
        }));

        // Start polling countdown when there are repos to update.
        if (tbody && repos.length > 0) {
            startCountdown();
        }
    }).catch((err) => {
        if (!container.isConnected) return;
        clearElement(container);
        const errEl = document.createElement('div');
        errEl.className = 'empty-state';

        const errTitle = document.createElement('h2');
        errTitle.textContent = 'Failed to load workspace';
        errEl.appendChild(errTitle);

        const errMsg = document.createElement('p');
        errMsg.className   = 'text-secondary';
        errMsg.textContent = err.message || 'An unexpected error occurred.';
        errEl.appendChild(errMsg);

        const backLink = document.createElement('a');
        backLink.href      = `#/projects/${encodeURIComponent(projectId)}`;
        backLink.className = 'btn btn-secondary';
        backLink.textContent = '← Back to Project';
        if (_router) {
            backLink.addEventListener('click', (e) => {
                e.preventDefault();
                _router.navigate(`#/projects/${encodeURIComponent(projectId)}`);
            });
        }
        errEl.appendChild(backLink);

        container.appendChild(errEl);
    });

    // Return cleanup so the router can call it on navigation away.
    return cleanup;
}

```
---
**File Statistics**
- **Size**: 241.83 KB
- **Lines**: 6674
File: `modules/gui/architecture-views.md`
