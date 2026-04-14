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
