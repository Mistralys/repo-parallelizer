/**
 * Branch Quick Switch Component.
 *
 * Shows an inline popover anchored below a branch cell, letting the user pick
 * an existing local branch or type a new name, then switch that single
 * repository immediately — without navigating to the full branch-switch wizard.
 *
 * Usage:
 *   import { showBranchQuickSwitch } from './components/branch-quick-switch.js';
 *
 *   const result = await showBranchQuickSwitch({
 *     anchorEl: triggerButton,
 *     projectId: 'my-project',
 *     wid: 'DEV',
 *     repoId: 'my-repo',
 *     currentBranch: 'main',
 *   });
 *   if (result.switched) doRefresh();
 *
 * @module branch-quick-switch
 */

import { api }       from '../api.js';
import { showToast } from './toast.js';
import { clearElement } from '../utils/dom.js';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Show the branch quick-switch popover anchored below `anchorEl`.
 *
 * Fetches available branches for the workspace via `api.branches.list()`,
 * renders a filterable list with an editable input, and calls
 * `api.branches.switch()` when the user confirms.
 *
 * @param {object}      options
 * @param {HTMLElement} options.anchorEl      - Element below which the popover is anchored.
 * @param {string}      options.projectId     - Parent project ID.
 * @param {string}      options.wid           - Workspace ID.
 * @param {string}      options.repoId        - Repository ID to switch.
 * @param {string}      options.currentBranch - Currently checked-out branch name.
 * @returns {Promise<{ switched: boolean, newBranch?: string }>}
 *   Resolves with `{ switched: true, newBranch }` on a successful switch,
 *   or `{ switched: false }` when cancelled or on error.
 */
export function showBranchQuickSwitch({ anchorEl, projectId, wid, repoId, currentBranch }) {
    return new Promise((resolve) => {
        // ------------------------------------------------------------------
        // Backdrop — transparent fixed overlay that catches outside clicks
        // ------------------------------------------------------------------
        const backdrop = document.createElement('div');
        backdrop.className = 'branch-quick-switch-backdrop';

        // ------------------------------------------------------------------
        // Popover container
        // ------------------------------------------------------------------
        const popover = document.createElement('div');
        popover.className = 'branch-quick-switch';
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-modal', 'true');
        popover.setAttribute('aria-label', 'Quick branch switch');

        document.body.appendChild(backdrop);
        document.body.appendChild(popover);

        // Reposition on scroll (any ancestor) and window resize.
        window.addEventListener('scroll', positionPopover, { capture: true, passive: true });
        window.addEventListener('resize', positionPopover, { passive: true });

        // Position below anchor immediately (re-positioned after content loads)
        positionPopover();

        // Show loading spinner while branch data is fetched
        const loadingSpinner = document.createElement('span');
        loadingSpinner.className = 'spinner';
        loadingSpinner.setAttribute('aria-hidden', 'true');
        popover.appendChild(loadingSpinner);

        // ------------------------------------------------------------------
        // Helpers
        // ------------------------------------------------------------------

        /**
         * Position the popover below the anchor element.
         * Flips above when there is not enough space below the viewport.
         */
        function positionPopover() {
            const rect        = anchorEl.getBoundingClientRect();
            const scrollY     = window.scrollY || document.documentElement.scrollTop;
            const scrollX     = window.scrollX || document.documentElement.scrollLeft;
            const popoverH    = popover.offsetHeight || 280; // estimate before content
            const spaceBelow  = window.innerHeight - rect.bottom;

            if (spaceBelow < popoverH + 8 && rect.top > popoverH + 8) {
                // Flip above anchor
                popover.style.top = `${rect.top + scrollY - popoverH - 4}px`;
            } else {
                popover.style.top = `${rect.bottom + scrollY + 4}px`;
            }
            popover.style.left = `${rect.left + scrollX}px`;
        }

        /** Remove popover and backdrop from the DOM; detach global listeners. */
        function cleanup() {
            document.removeEventListener('keydown', onKeydown);
            window.removeEventListener('scroll', positionPopover, { capture: true });
            window.removeEventListener('resize', positionPopover);
            if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
            if (popover.parentNode) popover.parentNode.removeChild(popover);
        }

        /** Dismiss without switching. */
        function dismiss() {
            cleanup();
            resolve({ switched: false });
        }

        function onKeydown(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                dismiss();
                return;
            }
            // Tab focus trap — keep focus cycling within the popover.
            if (e.key === 'Tab') {
                const focusable = Array.from(
                    popover.querySelectorAll('button:not([disabled]), input:not([disabled])'),
                );
                if (focusable.length === 0) return;
                const first = focusable[0];
                const last  = focusable[focusable.length - 1];
                if (e.shiftKey) {
                    if (document.activeElement === first) {
                        e.preventDefault();
                        last.focus();
                    }
                } else {
                    if (document.activeElement === last) {
                        e.preventDefault();
                        first.focus();
                    }
                }
            }
        }

        backdrop.addEventListener('click', dismiss);
        document.addEventListener('keydown', onKeydown);

        // ------------------------------------------------------------------
        // Fetch available branches
        // ------------------------------------------------------------------
        api.branches.list(projectId, wid).then((branchData) => {
            // Clear loading spinner
            clearElement(popover);

            // Only show local branches in the list; typing still allows any name.
            const allBranches   = (branchData && branchData.branches && branchData.branches[repoId]) || [];
            const localBranches = allBranches.filter((b) => !b.isRemote);

            // ---- Text input (pre-filled with current branch) ----
            const input = document.createElement('input');
            input.type  = 'text';
            input.className = 'form-input';
            input.value = currentBranch;
            input.setAttribute('spellcheck', 'false');
            input.setAttribute('autocomplete', 'off');
            input.setAttribute('aria-label', 'Branch name');

            // ---- Filterable branch list ----
            const list = document.createElement('ul');
            list.className = 'branch-quick-switch-list';
            list.setAttribute('aria-label', 'Available branches');

            /**
             * Re-render the branch list applying a case-insensitive substring
             * filter. Shows all branches when `filter` is empty.
             *
             * @param {string} filter
             */
            function renderList(filter) {
                clearElement(list);
                const f       = filter.toLowerCase();
                const visible = f
                    ? localBranches.filter((b) => b.name.toLowerCase().includes(f))
                    : localBranches;

                visible.forEach((branch) => {
                    const li = document.createElement('li');
                    if (branch.name === currentBranch) {
                        li.className = 'current';
                    }

                    const nameSpan = document.createElement('span');
                    nameSpan.textContent = branch.name;
                    li.appendChild(nameSpan);

                    if (branch.name === currentBranch) {
                        const hint = document.createElement('span');
                        hint.className   = 'branch-current-hint';
                        hint.textContent = ' (current)';
                        li.appendChild(hint);
                    }

                    // Clicking a list item populates the input
                    li.addEventListener('click', () => {
                        input.value = branch.name;
                        input.focus();
                    });

                    list.appendChild(li);
                });
            }

            renderList('');

            // Keep list in sync with typed input
            input.addEventListener('input', () => renderList(input.value));

            // ---- Inline error message ----
            const errorEl = document.createElement('div');
            errorEl.className = 'form-error';
            errorEl.setAttribute('aria-live', 'polite');
            errorEl.hidden = true;

            // ---- Action buttons ----
            const actions   = document.createElement('div');
            actions.className = 'form-actions';

            const switchBtn = document.createElement('button');
            switchBtn.type      = 'button';
            switchBtn.className = 'btn btn-primary btn-sm';
            switchBtn.textContent = 'Switch';

            const cancelBtn = document.createElement('button');
            cancelBtn.type      = 'button';
            cancelBtn.className = 'btn btn-secondary btn-sm';
            cancelBtn.textContent = 'Cancel';

            actions.appendChild(switchBtn);
            actions.appendChild(cancelBtn);

            // Assemble popover content
            popover.appendChild(input);
            popover.appendChild(list);
            popover.appendChild(errorEl);
            popover.appendChild(actions);

            // Re-position now that the full height is known
            requestAnimationFrame(positionPopover);

            input.focus();
            input.select();

            cancelBtn.addEventListener('click', dismiss);

            // ---- Switch handler ----
            switchBtn.addEventListener('click', async () => {
                errorEl.hidden = true;

                const newBranch = input.value.trim();
                if (!newBranch) {
                    errorEl.textContent = 'Branch name is required.';
                    errorEl.hidden = false;
                    return;
                }

                switchBtn.disabled    = true;
                cancelBtn.disabled    = true;
                switchBtn.textContent = 'Switching\u2026';

                try {
                    const result     = await api.branches.switch(projectId, wid, { [repoId]: newBranch });
                    const repoResult = result && result.results && result.results[repoId];

                    if (repoResult && repoResult.success) {
                        if (repoResult.conflict) {
                            showToast(`Switched to "${newBranch}" (conflicts detected).`, 'warning');
                        } else {
                            showToast(`Switched to "${newBranch}".`, 'success');
                        }
                        cleanup();
                        resolve({ switched: true, newBranch });
                    } else {
                        const msg = (repoResult && repoResult.error) || 'Failed to switch branch.';
                        showToast(msg, 'error');
                        cleanup();
                        resolve({ switched: false });
                    }
                } catch (err) {
                    showToast(err.message || 'Failed to switch branch.', 'error');
                    cleanup();
                    resolve({ switched: false });
                }
            });
        }).catch((err) => {
            // Show error state inside the popover
            clearElement(popover);

            const errMsg = document.createElement('p');
            errMsg.className   = 'text-secondary text-sm';
            errMsg.textContent = err.message || 'Failed to load branches.';
            popover.appendChild(errMsg);

            const closeBtn = document.createElement('button');
            closeBtn.type       = 'button';
            closeBtn.className  = 'btn btn-secondary btn-sm';
            closeBtn.textContent = 'Close';
            closeBtn.addEventListener('click', dismiss);
            popover.appendChild(closeBtn);

            requestAnimationFrame(positionPopover);
        });
    });
}
