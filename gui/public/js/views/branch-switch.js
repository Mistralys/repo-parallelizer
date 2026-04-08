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
