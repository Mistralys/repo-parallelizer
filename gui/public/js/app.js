/**
 * Application bootstrap for Repo Parallelizer GUI.
 *
 * Instantiates the hash-based router, registers all view routes, and starts
 * listening for navigation events.
 *
 * Route registry:
 *   #/                                           → Dashboard        (WP-013)
 *   #/repositories                               → Repositories     (WP-015)
 *   #/projects/:id                               → Project Detail   (WP-014)
 *   #/projects/:id/workspaces/:wid               → Workspace Detail (WP-016)
 *   #/projects/:id/workspaces/:wid/branch-switch → Branch Switch    (WP-017)
 */

import { Router }                                        from './router.js';
import { renderDashboard, setRouter }                    from './views/dashboard.js';
import { renderRepositories }                            from './views/repositories.js';
import { renderProjectDetail, setRouter as setProjectDetailRouter } from './views/project-detail.js';
import { renderWorkspaceDetail, setRouter as setWorkspaceDetailRouter } from './views/workspace-detail.js';
import { renderBranchSwitch, setRouter as setBranchSwitchRouter } from './views/branch-switch.js';

// ---------------------------------------------------------------------------
// Router instantiation & route registration
// ---------------------------------------------------------------------------

const router = new Router();

// Inject router into views that need programmatic navigation.
setRouter(router);
setProjectDetailRouter(router);
setWorkspaceDetailRouter(router);
setBranchSwitchRouter(router);

// Dashboard (WP-013)
router.register('#/', renderDashboard);

// Repositories list (WP-015)
router.register('#/repositories', renderRepositories);

// Project detail (WP-014)
router.register('#/projects/:id', renderProjectDetail);

// Workspace detail (WP-016)
router.register('#/projects/:id/workspaces/:wid', renderWorkspaceDetail);

// Branch switch (WP-017)
router.register('#/projects/:id/workspaces/:wid/branch-switch', renderBranchSwitch);

// ---------------------------------------------------------------------------
// Start the router — must be called after all routes are registered
// ---------------------------------------------------------------------------

router.start();
