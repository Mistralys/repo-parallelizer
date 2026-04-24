/**
 * Shared browser-globals shim for Node.js-based GUI unit tests.
 *
 * Browser modules reference `document` and `fetch` inside their function
 * bodies. Node.js does not supply these globals, which causes import-time
 * errors when the modules are loaded in a test environment. This utility
 * installs minimal no-op stubs so that test files can import browser modules
 * without triggering those errors.
 *
 * Usage:
 *   import { installBrowserGlobalsShim } from './__tests__/test-setup.mjs';
 *   // or from a sibling test file:
 *   import { installBrowserGlobalsShim } from './test-setup.mjs';
 *
 *   import { before } from 'node:test';
 *   before(installBrowserGlobalsShim);
 *
 * Notes:
 * - Each stub is only installed if the global is not already defined. This
 *   means test files that need a full `fetch` mock (e.g. api.*.test.mjs) can
 *   install their own mock in a subsequent `before()` hook and it will take
 *   precedence.
 * - The `document` stub exposes only the surface needed to prevent import
 *   errors. Tests that exercise DOM rendering should supply a real DOM via
 *   jsdom or a similar library.
 */

/**
 * Install minimal no-op stubs for `globalThis.document` and
 * `globalThis.fetch` if they are not already defined.
 *
 * Safe to call multiple times — subsequent calls are no-ops when the globals
 * are already present.
 */
export function installBrowserGlobalsShim() {
    if (typeof globalThis.document === 'undefined') {
        globalThis.document = {
            createElement() { return {}; },
            querySelector() { return null; },
        };
    }

    if (typeof globalThis.fetch === 'undefined') {
        globalThis.fetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({}),
        });
    }
}
