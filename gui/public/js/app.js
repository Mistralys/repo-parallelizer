/**
 * Application bootstrap for Repo Parallelizer GUI.
 *
 * Instantiates the hash-based router, registers all view routes, and starts
 * listening for navigation events.
 *
 * Route registry:
 *   #/                                           → Dashboard           (WP-013)
 *   #/repositories                               → Repositories        (WP-015)
 *   #/repositories/:id                           → Repository Detail   (WP-003)
 *   #/projects/:id                               → Project Detail      (WP-014)
 *   #/projects/:id/workspaces/:wid               → Workspace Detail    (WP-016)
 *   #/projects/:id/workspaces/:wid/branch-switch → Branch Switch       (WP-017)
 *   #/settings                                   → Settings            (WP-009)
 *   #/error-log                                  → Error Log           (WP-011)
 */

import { Router }                                        from './router.js';
import { renderDashboard, setRouter }                    from './views/dashboard.js';
import { renderRepositories }                            from './views/repositories.js';
import { renderRepositoryDetail, setRouter as setRepositoryDetailRouter } from './views/repository-detail.js';
import { renderProjectDetail, setRouter as setProjectDetailRouter } from './views/project-detail.js';
import { renderWorkspaceDetail, setRouter as setWorkspaceDetailRouter } from './views/workspace-detail.js';
import { renderBranchSwitch, setRouter as setBranchSwitchRouter } from './views/branch-switch.js';
import { renderSettings }                                from './views/settings.js';
import { renderErrorLog }                                from './views/error-log.js';
import { createThemeToggle }                             from './components/theme-toggle.js';
import { initNavHighlight }                              from './utils/nav-highlight.js';
import { initNavBadge }                                  from './components/nav-badge.js';
import { api }                                           from './api.js';

// ---------------------------------------------------------------------------
// Router instantiation & route registration
// ---------------------------------------------------------------------------

const router = new Router();

// Inject router into views that need programmatic navigation.
setRouter(router);
setRepositoryDetailRouter(router);
setProjectDetailRouter(router);
setWorkspaceDetailRouter(router);
setBranchSwitchRouter(router);

// Dashboard (WP-013)
router.register('#/', renderDashboard);

// Repositories list (WP-015)
router.register('#/repositories', renderRepositories);

// Repository detail (WP-003)
router.register('#/repositories/:id', renderRepositoryDetail);

// Project detail (WP-014)
router.register('#/projects/:id', renderProjectDetail);

// Workspace detail (WP-016)
router.register('#/projects/:id/workspaces/:wid', renderWorkspaceDetail);

// Branch switch (WP-017)
router.register('#/projects/:id/workspaces/:wid/branch-switch', renderBranchSwitch);

// Settings (WP-009)
router.register('#/settings', renderSettings);

// Error Log (WP-011)
router.register('#/error-log', renderErrorLog);

// ---------------------------------------------------------------------------
// Theme toggle — apply saved theme before first render to avoid flash
// ---------------------------------------------------------------------------

const themeToggleContainer = document.getElementById('theme-toggle-container');
if (themeToggleContainer) {
    themeToggleContainer.appendChild(createThemeToggle());
}

// ---------------------------------------------------------------------------
// Start the router — must be called after all routes are registered
// ---------------------------------------------------------------------------

router.start();

// ---------------------------------------------------------------------------
// Active nav-link highlighting
// ---------------------------------------------------------------------------

initNavHighlight();

// ---------------------------------------------------------------------------
// Error log nav badge — poll for error count and update the badge
// ---------------------------------------------------------------------------

initNavBadge();

// ---------------------------------------------------------------------------
// Footer version — fetch from server and inject into the footer spans
// ---------------------------------------------------------------------------

api.version.get().then(({ appVersion, guiVersion }) => {
    const appEl = document.getElementById('footer-app-version');
    const guiEl = document.getElementById('footer-gui-version');
    if (appEl) appEl.textContent = `v${appVersion}`;
    if (guiEl) guiEl.textContent = `GUI v${guiVersion}`;
}).catch(() => { /* non-critical — footer stays empty on failure */ });
