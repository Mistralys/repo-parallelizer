/**
 * Hash-based client-side router for the Repo Parallelizer SPA.
 *
 * Supports named parameters in patterns (e.g., `#/projects/:id`).
 * Views are functions called with `(container, params)` where container
 * is the `#app` DOM element and params is an object of extracted route
 * parameters.
 *
 * @example
 *   const router = new Router();
 *   router.register('#/', dashboardView);
 *   router.register('#/projects/:id', projectDetailView);
 *   router.start();
 */

import { APP_NAME_SHORT } from './utils/constants.js';

/**
 * @typedef {Object} Route
 * @property {string}   pattern  - The raw hash pattern (e.g., '#/projects/:id').
 * @property {RegExp}   regex    - Compiled regex for matching.
 * @property {string[]} paramNames - Ordered list of parameter names.
 * @property {function(HTMLElement, Object): (void|Promise<void>)} view
 */

export class Router {
    constructor() {
        /** @type {Route[]} */
        this._routes = [];

        /** @type {HTMLElement|null} */
        this._container = null;

        /** @type {function|null} Current view's cleanup callback. */
        this._cleanup = null;

        // Bind once so we can add/remove the event listener cleanly.
        this._onHashChange = this._onHashChange.bind(this);
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    /**
     * Register a route.
     *
     * @param {string}   hashPattern - Hash pattern, e.g., '#/projects/:id'.
     * @param {function(HTMLElement, Object): (void|Promise<void>)} viewFunction
     *   Called with (container, params). May return a cleanup function that
     *   will be called before navigating away from this view.
     */
    register(hashPattern, viewFunction) {
        const { regex, paramNames } = this._compilePattern(hashPattern);
        this._routes.push({
            pattern: hashPattern,
            regex,
            paramNames,
            view: viewFunction,
        });
    }

    /**
     * Programmatic navigation — sets `location.hash` which triggers `hashchange`.
     *
     * @param {string} hash - Target hash, e.g., '#/projects/my-proj'.
     */
    navigate(hash) {
        location.hash = hash;
    }

    /**
     * Start listening for hash changes and render the current hash.
     * Must be called after all routes have been registered.
     */
    start() {
        this._container = document.getElementById('app');
        if (!this._container) {
            throw new Error('Router: #app container element not found in the DOM.');
        }
        window.addEventListener('hashchange', this._onHashChange);

        // Render the current hash (or default to #/).
        if (!location.hash || location.hash === '#') {
            location.hash = '#/';
        } else {
            this._resolve(location.hash);
        }
    }

    /**
     * Stop listening and clean up (useful for testing / teardown).
     */
    stop() {
        window.removeEventListener('hashchange', this._onHashChange);
        this._runCleanup();
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    /**
     * Compile a hash pattern into a regex and extract parameter names.
     *
     * '#/projects/:id/workspaces/:wid'
     *   → regex: /^#\/projects\/([^/]+)\/workspaces\/([^/]+)$/
     *   → paramNames: ['id', 'wid']
     *
     * **Trailing-slash behaviour:** Each `:param` segment is compiled to the
     * capture group `([^/]+)`, which requires **at least one non-slash
     * character**. This means a trailing-slash URL such as `#/projects/` will
     * **NOT** match a pattern like `#/projects/:id` — the empty string after
     * the final slash fails the `[^/]+` requirement. View authors should
     * ensure navigation links never append a bare trailing slash when a param
     * value is expected (e.g. use `#/projects/my-proj`, not `#/projects/`).
     *
     * @param {string} pattern
     * @returns {{ regex: RegExp, paramNames: string[] }}
     */
    _compilePattern(pattern) {
        const paramNames = [];
        const regexStr = pattern.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name) => {
            paramNames.push(name);
            return '([^/]+)';
        });
        // Escape remaining forward slashes and anchor.
        const regex = new RegExp('^' + regexStr.replace(/\//g, '\\/') + '$');
        return { regex, paramNames };
    }

    /**
     * Match the current hash against registered routes and render.
     *
     * @param {string} hash
     */
    _resolve(hash) {
        // Normalise: empty hash → '#/'
        if (!hash || hash === '#') {
            hash = '#/';
        }

        for (const route of this._routes) {
            const match = hash.match(route.regex);
            if (match) {
                // Extract named params.
                const params = {};
                route.paramNames.forEach((name, i) => {
                    params[name] = decodeURIComponent(match[i + 1]);
                });
                this._render(route.view, params);
                return;
            }
        }

        // No route matched — show a simple 404.
        this._runCleanup();
        if (this._container) {
            this._container.innerHTML = '';
            const msg = document.createElement('div');
            msg.className = 'empty-state';
            msg.textContent = `Page not found: ${hash}`;
            this._container.appendChild(msg);
        }
    }

    /**
     * Clear the container, run the previous view's cleanup, and render
     * the matched view.
     *
     * @param {function} viewFn
     * @param {Object}   params
     */
    _render(viewFn, params) {
        this._runCleanup();
        if (this._container) {
            document.title = APP_NAME_SHORT;
            this._container.innerHTML = '';
            const result = viewFn(this._container, params);
            // If the view returns a function, store it as cleanup.
            if (typeof result === 'function') {
                this._cleanup = result;
            }
        }
    }

    /** Run and discard the current cleanup callback. */
    _runCleanup() {
        if (this._cleanup) {
            try {
                this._cleanup();
            } catch (_e) {
                // Swallow cleanup errors — don't block navigation.
            }
            this._cleanup = null;
        }
    }

    /** hashchange handler */
    _onHashChange() {
        this._resolve(location.hash);
    }
}
