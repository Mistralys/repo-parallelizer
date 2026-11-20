/**
 * Health Alert Component — Repo Parallelizer GUI.
 *
 * Renders a `HealthReport` as a list of issue rows, each with an optional
 * fix-action button. Originally private to `workspace-detail.js`
 * (`buildHealthAlertSection()`), extracted so a second health-reporting view
 * (the repository info-sync section) can reuse the same rendering logic
 * instead of duplicating the markup and the `fixAction` dispatch.
 *
 * ## Action registry
 *
 * Callers no longer branch on `fixAction` with an if-chain. Instead they pass
 * an `actions` map keyed by `fixAction` string; each entry supplies the
 * button's idle `label` and an `onClick(issue)` handler. An issue whose
 * `fixAction` has no matching registry entry (including the explicit `'none'`
 * sentinel) renders as a message-only row with no button — this covers both
 * genuinely non-actionable issues and any `fixAction` the caller does not yet
 * recognise.
 *
 * `onClick` may return a `Promise`; the button is disabled and its label
 * swapped to `loadingLabel` (falling back to `label` when not supplied) for
 * the duration, then restored — mirroring the per-action loading text the
 * original if-chain hardcoded for each branch.
 *
 * @module components/health-alert
 */

/**
 * @typedef {Object} HealthAlertAction
 * @property {string} label - Button text shown while idle.
 * @property {string} [loadingLabel] - Button text shown while `onClick` is
 *   in flight. Falls back to `label` when omitted.
 * @property {function(Object): (void|Promise<void>)} onClick - Invoked with
 *   the full issue object when the button is clicked.
 */

/**
 * Build a health alert section element from a `HealthReport`.
 * Returns `null` when the report is absent, healthy, or carries no issues.
 *
 * @param {{ healthy: boolean, issues: Array<{ type: string, severity: string, message: string, fixAction: string, repositoryId?: string }> }|null} report
 * @param {Object} [options]
 * @param {string} [options.title] - Title text shown above the issue rows.
 *   Defaults to `'Workspace health issues detected'` to reproduce the
 *   original `workspace-detail.js` copy verbatim.
 * @param {Record<string, HealthAlertAction>} [options.actions] - Registry
 *   mapping a `fixAction` string to its button definition. An issue whose
 *   `fixAction` is absent from this map (including `'none'`) renders without
 *   a button.
 * @returns {HTMLElement|null}
 */
export function buildHealthAlert(report, options = {}) {
    if (
        !report ||
        report.healthy ||
        !Array.isArray(report.issues) ||
        report.issues.length === 0
    ) {
        return null;
    }

    const { title = 'Workspace health issues detected', actions = {} } = options;

    const section = document.createElement('div');
    section.className = 'health-alert';

    const titleEl = document.createElement('div');
    titleEl.className = 'health-alert-title';
    titleEl.textContent = title;
    section.appendChild(titleEl);

    for (const issue of report.issues) {
        section.appendChild(buildIssueRow(issue, actions));
    }

    return section;
}

/**
 * Build a single `.health-alert-issue` row for one issue.
 *
 * @param {{ message: string, fixAction: string }} issue
 * @param {Record<string, HealthAlertAction>} actions
 * @returns {HTMLElement}
 */
function buildIssueRow(issue, actions) {
    const row = document.createElement('div');
    row.className = 'health-alert-issue';

    const msg = document.createElement('span');
    msg.className = 'health-alert-issue__message';
    msg.textContent = issue.message;
    row.appendChild(msg);

    const action = actions[issue.fixAction];
    if (action) {
        row.appendChild(buildActionCell(issue, action));
    }
    // Issues with no registry entry for their fixAction (including the
    // explicit 'none' sentinel and any fixAction the caller does not
    // recognise) render the message row without a button.

    return row;
}

/**
 * Build the `.health-alert-issue__action` wrapper and its fix button.
 *
 * @param {Object} issue - Full issue object, forwarded to `onClick`.
 * @param {HealthAlertAction} action
 * @returns {HTMLElement}
 */
function buildActionCell(issue, action) {
    const actionWrap = document.createElement('span');
    actionWrap.className = 'health-alert-issue__action';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary btn-sm';
    btn.textContent = action.label;

    btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = action.loadingLabel || action.label;
        try {
            await action.onClick(issue);
        } finally {
            btn.disabled = false;
            btn.textContent = action.label;
        }
    });

    actionWrap.appendChild(btn);
    return actionWrap;
}
