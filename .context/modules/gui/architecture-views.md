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
                └── project-detail.js
                └── repositories.js
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

import { api }      from '../api.js';
import { showToast } from '../components/toast.js';

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

        stepContent.innerHTML = '';

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
        stepContent.innerHTML = '';

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
    stepContent.innerHTML = '';

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
    stepContent.innerHTML = '';

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
        stepContent.innerHTML = '';

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
    container.innerHTML = '';

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

    stats.appendChild(repoStat);
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
    el.innerHTML = `
        <div class="loading-indicator" aria-live="polite" aria-label="Loading projects…">
            <span class="spinner" aria-hidden="true"></span>
            <span>Loading projects…</span>
        </div>
    `;
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
// Project list
// ---------------------------------------------------------------------------

/**
 * Fetch and render the project list into `listContainer`.
 *
 * Workspace counts are fetched in parallel for each project.  If a workspace
 * fetch fails the count is shown as "0 workspaces" rather than breaking the whole list.
 *
 * @param {HTMLElement} listContainer - Element to render the list into.
 */
async function renderProjectList(listContainer) {
    showLoading(listContainer);

    let projects;
    try {
        projects = await api.projects.list();
    } catch (err) {
        listContainer.innerHTML = '';
        const errMsg = document.createElement('div');
        errMsg.className = 'empty-state error-state';
        errMsg.textContent = `Failed to load projects: ${err.message}`;
        listContainer.appendChild(errMsg);
        showToast(err.message || 'Failed to load projects.', 'error');
        return;
    }

    listContainer.innerHTML = '';

    if (!Array.isArray(projects) || projects.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.textContent = 'No projects yet. Use the "Create Project" button to add one.';
        listContainer.appendChild(empty);
        return;
    }

    // Fetch workspace counts in parallel; failures degrade gracefully.
    const workspaceCounts = await Promise.all(
        projects.map(async (project) => {
            const id = project.Id || project.id || '';
            try {
                const workspaces = await api.workspaces.list(id);
                return Array.isArray(workspaces) ? workspaces.length : 0;
            } catch (_err) {
                return 0;
            }
        }),
    );

    const grid = document.createElement('div');
    grid.className = 'project-grid';

    projects.forEach((project, index) => {
        grid.appendChild(buildProjectCard(project, workspaceCounts[index]));
    });

    listContainer.appendChild(grid);
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
    // Project list section
    // -----------------------------------------------------------------------
    const listContainer = document.createElement('div');
    listContainer.className = 'project-list-container';
    container.appendChild(listContainer);

    // -----------------------------------------------------------------------
    // Create Project section
    // -----------------------------------------------------------------------
    const createSection = buildCreateProjectSection(() => {
        // Re-render the project list after a successful creation.
        renderProjectList(listContainer);
    });
    container.appendChild(createSection);

    // -----------------------------------------------------------------------
    // Initial load
    // -----------------------------------------------------------------------
    await renderProjectList(listContainer);
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
 * Description is editable inline: clicking Edit shows a textarea; Save calls
 * `api.projects.update()`.
 *
 * @param {{ id: string, name: string, description: string }} project
 * @returns {HTMLElement}
 */
function buildMetaSection(project) {
    const section = document.createElement('section');
    section.className = 'project-meta-section card';

    // Project ID + Name
    const idRow = document.createElement('div');
    idRow.className = 'project-meta-id-row';

    const idLabel = document.createElement('span');
    idLabel.className = 'project-meta-id text-muted';
    idLabel.textContent = `ID: ${project.id}`;

    const nameEl = document.createElement('h2');
    nameEl.className = 'project-meta-name';
    nameEl.textContent = project.name || project.id;

    idRow.appendChild(nameEl);
    idRow.appendChild(idLabel);
    section.appendChild(idRow);

    // Description — read-mode
    const descRow = document.createElement('div');
    descRow.className = 'project-meta-desc-row';

    const descDisplay = document.createElement('p');
    descDisplay.className = 'project-meta-description text-secondary';
    descDisplay.textContent = project.description || 'No description.';

    const editDescBtn = document.createElement('button');
    editDescBtn.type      = 'button';
    editDescBtn.className = 'btn btn-secondary btn-sm';
    editDescBtn.textContent = 'Edit Description';

    descRow.appendChild(descDisplay);
    descRow.appendChild(editDescBtn);
    section.appendChild(descRow);

    // Description — edit-mode (hidden initially)
    const editRow = document.createElement('div');
    editRow.className = 'project-meta-edit-row';
    editRow.hidden = true;

    const descTextarea = document.createElement('textarea');
    descTextarea.className = 'form-textarea';
    descTextarea.rows  = 3;
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

    editDescBtn.addEventListener('click', () => {
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

    const heading = document.createElement('h3');
    heading.className = 'section-title';
    heading.textContent = 'Repositories';
    section.appendChild(heading);

    // Build a map for quick lookup: repoId → { id, name, url }
    const repoMap = new Map(allRepos.map((r) => [r.id, r]));

    // ---- Repo list ----
    if (projectRepoIds.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty-state-inline text-secondary';
        empty.textContent = 'No repositories in this project yet.';
        section.appendChild(empty);
    } else {
        const list = document.createElement('ul');
        list.className = 'repo-list';

        projectRepoIds.forEach((repoId) => {
            const repo = repoMap.get(repoId);
            const li   = document.createElement('li');
            li.className = 'repo-list-item';

            const repoInfo = document.createElement('span');
            repoInfo.className = 'repo-list-info';
            repoInfo.textContent = repo ? `${repo.name || repo.id} (${repo.id})` : repoId;

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

            li.appendChild(repoInfo);
            li.appendChild(removeBtn);
            list.appendChild(li);
        });

        section.appendChild(list);
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
 * Lists workspaces with ID, description, creation date, a link to the
 * workspace detail view, and a Delete button (disabled for STABLE).
 * Includes an "Add Workspace" form.
 *
 * @param {string}   projectId  - Current project ID.
 * @param {Array<{ id: string, description: string, createdAt: string }>} workspaces
 * @param {function(): Promise<void>} onRefresh - Re-renders the entire view.
 * @returns {HTMLElement}
 */
function buildWorkspacesSection(projectId, workspaces, onRefresh) {
    const section = document.createElement('section');
    section.className = 'project-workspaces-section';

    const heading = document.createElement('h3');
    heading.className = 'section-title';
    heading.textContent = 'Workspaces';
    section.appendChild(heading);

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
        ['ID', 'Description', 'Created', 'Actions'].forEach((label) => {
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

            // Actions cell
            const actCell = document.createElement('td');
            actCell.className = 'workspace-actions-cell';

            const isStable = ws.id === 'STABLE';

            const deleteBtn = document.createElement('button');
            deleteBtn.type      = 'button';
            deleteBtn.className = 'btn btn-danger btn-sm';
            deleteBtn.textContent = 'Delete';

            if (isStable) {
                deleteBtn.disabled = true;
                deleteBtn.title    = 'The STABLE workspace cannot be deleted.';
                deleteBtn.classList.add('btn-disabled');
            } else {
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
            }

            actCell.appendChild(deleteBtn);
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
 * Workspace ID must match /^[A-Z]{2,6}$/ (2-6 uppercase letters).
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
        hint: 'Must be 2–6 uppercase letters (A-Z only).',
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

        // Validate format: 2-6 uppercase A-Z only
        if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
            if (wsIdErrorEl) {
                wsIdErrorEl.textContent = 'Must be 2–6 uppercase letters (A-Z only).';
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
    const normWorkspaces = Array.isArray(workspaces)
        ? workspaces.map(normaliseWorkspace)
        : [];
    const normAllRepos   = Array.isArray(allRepos)
        ? allRepos.map(normaliseRepo)
        : [];

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

    // ---- Page header ----
    const header = document.createElement('div');
    header.className = 'page-header';

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
    header.appendChild(backLink);

    const title = document.createElement('h1');
    title.className = 'page-title';
    title.textContent = normProject.name || normProject.id;
    header.appendChild(title);

    container.appendChild(header);

    // ---- Metadata section ----
    container.appendChild(buildMetaSection(normProject));

    // ---- Repositories section ----
    container.appendChild(
        buildRepositoriesSection(
            normProject.id,
            normProject.repositories,
            normAllRepos,
            refresh,
        ),
    );

    // ---- Workspaces section ----
    container.appendChild(
        buildWorkspacesSection(normProject.id, normWorkspaces, refresh),
    );

    // ---- Danger zone ----
    const dangerZone = document.createElement('div');
    dangerZone.className = 'danger-zone';

    const dangerHeading = document.createElement('h3');
    dangerHeading.className = 'section-title';
    dangerHeading.textContent = 'Danger Zone';
    dangerZone.appendChild(dangerHeading);

    dangerZone.appendChild(buildRenameSection(normProject));
    dangerZone.appendChild(buildDeleteSection(normProject));

    container.appendChild(dangerZone);
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
 * The row starts in read mode.  Clicking Edit switches the Name cell to an
 * inline `<input>` and replaces the action buttons with Save / Cancel.
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

    const nameSpan = document.createElement('span');
    nameSpan.className = 'repo-name-display';
    nameSpan.textContent = repo.name || '—';
    nameCell.appendChild(nameSpan);

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
        nameSpan.hidden  = true;
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
        nameSpan.hidden  = false;

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
            nameSpan.textContent = newName || '—';
            showToast(`Repository "${repo.id}" updated.`, 'success');

            // Return to read mode
            nameInput.hidden = true;
            nameSpan.hidden  = false;
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
        tableContainer.innerHTML = '';
        const errMsg = document.createElement('div');
        errMsg.className = 'empty-state error-state';
        errMsg.textContent = `Failed to load repositories: ${err.message}`;
        tableContainer.appendChild(errMsg);
        showToast(err.message || 'Failed to load repositories.', 'error');
        return;
    }

    tableContainer.innerHTML = '';

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
###  Path: `/gui/public/js/views/workspace-detail.js`

```js
/**
 * Workspace Detail View — Repo Parallelizer GUI.
 *
 * Renders the full detail page for a single workspace inside a project:
 *   - Workspace header: ID, description, breadcrumb link back to the project.
 *   - Repository status table: one row per repository, showing current branch,
 *     a color-coded Git status badge, and an error/loading indicator for repos
 *     with no status data yet.
 *   - Live polling: status badges refresh in-place every 10 seconds via
 *     `setInterval`. The interval is cleared via the cleanup function returned
 *     from `renderWorkspaceDetail`, which the router calls before navigating
 *     away.
 *   - Actions: "Switch Branches" navigation button, "Rename Workspace" (disabled
 *     for STABLE), "Delete Workspace" (disabled for STABLE).
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
import { createStatusBadge } from '../components/status-badge.js';
import { createFormField, validateRequired, WORKSPACE_ID_PATTERN } from '../components/form-helpers.js';
import { normaliseProject, normaliseWorkspace } from '../utils/normalise.js';

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

/** Polling interval in milliseconds. */
const POLL_INTERVAL_MS = 10_000;

/** The workspace ID that cannot be renamed or deleted. */
const STABLE_WS_ID = 'STABLE';

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
    el.innerHTML = `
        <div class="loading-indicator" aria-live="polite">
            <span class="spinner" aria-hidden="true"></span>
            <span>${label}</span>
        </div>
    `;
}

// ---------------------------------------------------------------------------
// Status table helpers
// ---------------------------------------------------------------------------

/**
 * Build the status `<tbody>` row for a single repository.
 *
 * The row uses `data-repo-id` on the badge container so the polling update
 * can locate and replace badge contents in-place.
 *
 * @param {string} repoId
 * @param {string} repoName
 * @param {Object|null} statusInfo - GitStatusInfo or null.
 * @returns {HTMLTableRowElement}
 */
function buildRepoStatusRow(repoId, repoName, statusInfo) {
    const tr = document.createElement('tr');
    tr.dataset.repoId = repoId;

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

    // Branch name
    const branchCell = document.createElement('td');
    branchCell.className = 'repo-branch-cell';
    branchCell.textContent = (statusInfo && statusInfo.currentBranch)
        ? statusInfo.currentBranch
        : '—';
    tr.appendChild(branchCell);

    // Status badge cell
    const badgeCell = document.createElement('td');
    badgeCell.className = 'repo-badge-cell';

    const badgeWrapper = document.createElement('div');
    badgeWrapper.dataset.repoId = repoId;
    badgeWrapper.appendChild(createStatusBadge(statusInfo || null));
    badgeCell.appendChild(badgeWrapper);
    tr.appendChild(badgeCell);

    return tr;
}

/**
 * Update an existing status table in-place by replacing badge contents and
 * branch text for each repository whose status has changed.
 *
 * Rows are located via `[data-repo-id]` on both the `<tr>` and the badge
 * wrapper `<div>` inside it. No full re-render of the table is performed.
 *
 * @param {HTMLElement}           tableBody - The `<tbody>` to update.
 * @param {Record<string, Object|null>} statusMap - Keyed by repository ID.
 */
function updateStatusTable(tableBody, statusMap) {
    for (const [repoId, statusInfo] of Object.entries(statusMap)) {
        const row = tableBody.querySelector(`tr[data-repo-id="${CSS.escape(repoId)}"]`);
        if (!row) continue;

        // Update branch cell (second cell)
        const branchCell = row.cells[1];
        if (branchCell) {
            branchCell.textContent = (statusInfo && statusInfo.currentBranch)
                ? statusInfo.currentBranch
                : '—';
        }

        // Update badge wrapper (third cell → div[data-repo-id])
        const badgeWrapper = row.querySelector(`div[data-repo-id="${CSS.escape(repoId)}"]`);
        if (badgeWrapper) {
            badgeWrapper.innerHTML = '';
            badgeWrapper.appendChild(createStatusBadge(statusInfo || null));
        }
    }
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

/**
 * Build the workspace header section.
 *
 * @param {string} projectId
 * @param {{ id: string, description: string }} workspace
 * @returns {HTMLElement}
 */
function buildHeaderSection(projectId, workspace) {
    const header = document.createElement('div');
    header.className = 'page-header workspace-detail-header';

    // Breadcrumb
    const breadcrumb = document.createElement('nav');
    breadcrumb.className = 'breadcrumb';
    breadcrumb.setAttribute('aria-label', 'Breadcrumb');

    const projectLink = document.createElement('a');
    projectLink.href      = `#/projects/${encodeURIComponent(projectId)}`;
    projectLink.textContent = projectId;
    projectLink.className = 'breadcrumb-link';
    if (_router) {
        projectLink.addEventListener('click', (e) => {
            e.preventDefault();
            _router.navigate(`#/projects/${encodeURIComponent(projectId)}`);
        });
    }

    const separator = document.createElement('span');
    separator.className   = 'breadcrumb-sep';
    separator.textContent = ' / ';
    separator.setAttribute('aria-hidden', 'true');

    const currentPage = document.createElement('span');
    currentPage.className   = 'breadcrumb-current';
    currentPage.textContent = workspace.id;
    currentPage.setAttribute('aria-current', 'page');

    breadcrumb.appendChild(projectLink);
    breadcrumb.appendChild(separator);
    breadcrumb.appendChild(currentPage);
    header.appendChild(breadcrumb);

    // Title
    const titleEl = document.createElement('h1');
    titleEl.className   = 'workspace-detail-title';
    titleEl.textContent = `Workspace: ${workspace.id}`;
    header.appendChild(titleEl);

    // Description
    if (workspace.description) {
        const descEl = document.createElement('p');
        descEl.className   = 'workspace-detail-description text-secondary';
        descEl.textContent = workspace.description;
        header.appendChild(descEl);
    }

    return header;
}

/**
 * Build the repository status table section.
 *
 * @param {Array<{ repoId: string, repoName: string }>} repos
 * @param {Record<string, Object|null>} statusMap
 * @returns {{ section: HTMLElement, tbody: HTMLTableSectionElement }}
 */
function buildStatusTableSection(repos, statusMap) {
    const section = document.createElement('section');
    section.className = 'workspace-status-section';

    const heading = document.createElement('h2');
    heading.className   = 'section-title';
    heading.textContent = 'Repository Status';
    section.appendChild(heading);

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
    ['Repository', 'Branch', 'Status'].forEach((label) => {
        const th = document.createElement('th');
        th.textContent = label;
        htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    repos.forEach(({ repoId, repoName }) => {
        const statusInfo = statusMap[repoId] ?? null;
        tbody.appendChild(buildRepoStatusRow(repoId, repoName, statusInfo));
    });

    table.appendChild(tbody);
    section.appendChild(table);

    return { section, tbody };
}

/**
 * Build the actions section.
 *
 * @param {string} projectId
 * @param {string} wid        - Workspace ID.
 * @param {boolean} isStable  - Whether this is the STABLE workspace.
 * @returns {HTMLElement}
 */
function buildActionsSection(projectId, wid, isStable) {
    const section = document.createElement('section');
    section.className = 'workspace-actions-section';

    const heading = document.createElement('h2');
    heading.className   = 'section-title';
    heading.textContent = 'Actions';
    section.appendChild(heading);

    const actionsRow = document.createElement('div');
    actionsRow.className = 'workspace-actions-row';

    // ---- Switch Branches button ----
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
    actionsRow.appendChild(switchBtn);

    // ---- Rename Workspace ----
    const renameWrapper = buildRenameWorkspaceAction(projectId, wid, isStable);
    actionsRow.appendChild(renameWrapper);

    // ---- Delete Workspace button ----
    const deleteBtn = document.createElement('button');
    deleteBtn.type      = 'button';
    deleteBtn.className = 'btn btn-danger';
    deleteBtn.textContent = 'Delete Workspace';

    if (isStable) {
        deleteBtn.disabled = true;
        deleteBtn.title    = 'The STABLE workspace cannot be deleted.';
        deleteBtn.classList.add('btn-disabled');
    } else {
        deleteBtn.addEventListener('click', async () => {
            try {
                await showConfirm(
                    'Delete Workspace',
                    `Delete workspace "${wid}"? All cloned repositories in this workspace will be permanently removed. This action cannot be undone.`,
                );
            } catch {
                return; // User cancelled.
            }

            deleteBtn.disabled    = true;
            deleteBtn.textContent = 'Deleting…';

            try {
                await api.workspaces.delete(projectId, wid);
                showToast(`Workspace "${wid}" deleted.`, 'success');
                if (_router) {
                    _router.navigate(`#/projects/${encodeURIComponent(projectId)}`);
                } else {
                    location.hash = `#/projects/${encodeURIComponent(projectId)}`;
                }
            } catch (err) {
                showToast(err.message || 'Failed to delete workspace.', 'error');
                deleteBtn.disabled    = false;
                deleteBtn.textContent = 'Delete Workspace';
            }
        });
    }

    actionsRow.appendChild(deleteBtn);
    section.appendChild(actionsRow);

    return section;
}

/**
 * Build the Rename Workspace inline action.
 *
 * Returns a wrapper `<div>` containing the "Rename Workspace" button and a
 * hidden inline form. When shown, the form accepts a new workspace ID and
 * calls `api.workspaces.rename()` on submit.
 *
 * @param {string}  projectId
 * @param {string}  wid       - Current workspace ID.
 * @param {boolean} isStable
 * @returns {HTMLElement}
 */
function buildRenameWorkspaceAction(projectId, wid, isStable) {
    const wrapper = document.createElement('div');
    wrapper.className = 'rename-workspace-wrapper';

    // ---- Toggle button ----
    const renameBtn = document.createElement('button');
    renameBtn.type      = 'button';
    renameBtn.className = 'btn btn-secondary';
    renameBtn.textContent = 'Rename Workspace';

    if (isStable) {
        renameBtn.disabled = true;
        renameBtn.title    = 'The STABLE workspace cannot be renamed.';
        renameBtn.classList.add('btn-disabled');
        wrapper.appendChild(renameBtn);
        return wrapper;
    }

    wrapper.appendChild(renameBtn);

    // ---- Inline form (hidden initially) ----
    const formWrapper = document.createElement('div');
    formWrapper.className = 'rename-workspace-form-wrapper card';
    formWrapper.hidden = true;
    wrapper.appendChild(formWrapper);

    const formTitle = document.createElement('h4');
    formTitle.className   = 'form-section-title';
    formTitle.textContent = 'Rename Workspace';
    formWrapper.appendChild(formTitle);

    const newIdField = createFormField('New Workspace ID', 'text', 'newWorkspaceId', {
        required:    true,
        placeholder: 'e.g. DEV or FEATURE',
        hint:        'Must be 2–6 uppercase letters (A-Z only).',
    });
    formWrapper.appendChild(newIdField);

    const newIdInput   = newIdField.querySelector('[name="newWorkspaceId"]');
    const newIdErrorEl = newIdField.querySelector('.field-error');

    const formActions = document.createElement('div');
    formActions.className = 'form-actions';

    const saveBtn = document.createElement('button');
    saveBtn.type      = 'button';
    saveBtn.className = 'btn btn-primary btn-sm';
    saveBtn.textContent = 'Save';

    const cancelBtn = document.createElement('button');
    cancelBtn.type      = 'button';
    cancelBtn.className = 'btn btn-secondary btn-sm';
    cancelBtn.textContent = 'Cancel';

    formActions.appendChild(saveBtn);
    formActions.appendChild(cancelBtn);
    formWrapper.appendChild(formActions);

    // ---- Behaviour ----

    renameBtn.addEventListener('click', () => {
        formWrapper.hidden = false;
        renameBtn.hidden   = true;
        if (newIdInput) newIdInput.focus();
    });

    cancelBtn.addEventListener('click', () => {
        formWrapper.hidden = true;
        renameBtn.hidden   = false;
        if (newIdInput) newIdInput.value = '';
        if (newIdErrorEl) newIdErrorEl.hidden = true;
    });

    saveBtn.addEventListener('click', async () => {
        // Clear previous validation errors.
        if (newIdErrorEl) newIdErrorEl.hidden = true;
        if (newIdInput) {
            newIdInput.classList.remove('error');
            newIdInput.removeAttribute('aria-invalid');
        }

        if (!validateRequired(formWrapper, ['newWorkspaceId'])) return;

        const newId = newIdInput ? newIdInput.value.trim() : '';

        if (!WORKSPACE_ID_PATTERN.test(newId)) {
            if (newIdErrorEl) {
                newIdErrorEl.textContent = 'Must be 2–6 uppercase letters (A-Z only).';
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
                `Rename workspace "${wid}" to "${newId}"? The page will navigate to the new workspace URL.`,
            );
        } catch {
            return; // User cancelled.
        }

        saveBtn.disabled    = true;
        saveBtn.textContent = 'Saving…';

        try {
            await api.workspaces.rename(projectId, wid, newId);
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

// ---------------------------------------------------------------------------
// Public view entry point
// ---------------------------------------------------------------------------

/**
 * Render the workspace detail view.
 *
 * Fetches workspace metadata, project (for the repositories list), and
 * initial Git status in parallel. Then starts a polling interval that
 * updates badges in-place every {@link POLL_INTERVAL_MS} milliseconds.
 *
 * @param {HTMLElement} container - The `#app` DOM element provided by the router.
 * @param {{ id: string, wid: string }} params - Route parameters.
 * @returns {function(): void} Cleanup function — clears the polling interval.
 *   The router stores and calls this before rendering the next view.
 */
export function renderWorkspaceDetail(container, params) {
    const projectId = params.id;
    const wid       = params.wid;

    let pollingInterval = null;

    // Return the cleanup function immediately so the router can register it
    // even if the async bootstrap hasn't resolved yet.
    const cleanup = () => {
        if (pollingInterval !== null) {
            clearInterval(pollingInterval);
            pollingInterval = null;
        }
    };

    // Show loading state immediately.
    showLoading(container, 'Loading workspace…');

    // Kick off parallel data fetch.
    Promise.all([
        api.workspaces.get(projectId, wid),
        api.projects.get(projectId),
        api.status.get(projectId, wid),
    ]).then(([rawWorkspace, rawProject, statusMap]) => {
        // Guard: if the container was cleared by navigation before we resolved,
        // do nothing and let the cleanup function handle the interval.
        if (!container.isConnected) return;

        const workspace = normaliseWorkspace(rawWorkspace);
        const project   = normaliseProject(rawProject);

        // Build repo list: [{ repoId, repoName }, …]
        const repos = project.repositories.map((r) => ({
            repoId:   extractRepoId(r),
            repoName: extractRepoName(r),
        })).filter((r) => r.repoId !== '');

        // Render the view.
        container.innerHTML = '';

        const isStable = wid === STABLE_WS_ID;

        container.appendChild(buildHeaderSection(projectId, workspace));
        const { section: statusSection, tbody } = buildStatusTableSection(repos, statusMap || {});
        container.appendChild(statusSection);
        container.appendChild(buildActionsSection(projectId, wid, isStable));

        // Start polling only when there are repos to update.
        if (tbody && repos.length > 0) {
            pollingInterval = setInterval(async () => {
                // Stop polling if the container is no longer in the DOM.
                if (!container.isConnected) {
                    cleanup();
                    return;
                }
                try {
                    const fresh = await api.status.get(projectId, wid);
                    if (container.isConnected && fresh) {
                        updateStatusTable(tbody, fresh);
                    }
                } catch {
                    // Silently ignore polling errors — the stale badges remain.
                }
            }, POLL_INTERVAL_MS);
        }
    }).catch((err) => {
        if (!container.isConnected) return;
        container.innerHTML = '';
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
- **Size**: 114.3 KB
- **Lines**: 3305
File: `modules/gui/architecture-views.md`
