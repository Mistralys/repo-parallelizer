# Contributing

## Development setup

```bash
npm install
npm run build
```

## TypeScript module resolution — `.js` extensions required

This project uses `"module": "Node16"` and `"moduleResolution": "Node16"`. Under these settings **every relative import must include the `.js` file extension** in the TypeScript source:

```typescript
// Correct
import { MyClass } from './my-module.js';

// Wrong — TypeScript compiler error + runtime failure
import { MyClass } from './my-module';
```

TypeScript maps the `.js` extension in source to the `.ts` source file at compile time and emits the `.js` reference unchanged in the output directory. Node.js then resolves it at runtime. This is a strict requirement of Node16 module resolution — there are no exceptions for relative imports.

## Running locally

After building, use one of:

```bash
# Run via node
node dist/index.js

# Install as a global CLI (recommended for development)
npm link
paralizer
```

`dist/index.js` does not carry the executable bit after `tsc` compilation. `npm link` handles this automatically; `node dist/index.js` works without it.

## Build

```bash
npm run build   # one-shot compile
npm run dev     # watch mode
```

Compiled output goes to `dist/`. Source maps are generated alongside each file.

## Running tests

```bash
npm test   # compiles TypeScript then runs all test files under dist/tests/
```

## Test Cleanup Requirements

All tests that create temporary files or directories **must** register a `process.on('exit')` cleanup
handler in addition to any `afterAll` or similar teardown:

```typescript
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-test-'));

process.on('exit', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

**Why `process.on('exit')` and not only `afterAll`?**  `afterAll` does not run when the test runner
is interrupted with `SIGINT` or crashes.  The `'exit'` event fires in both scenarios and guarantees
cleanup on every exit path.

Note: `process.on('exit')` handlers must be synchronous — `fs.rmSync` is correct here;
`fs.promises.rm` would not be awaited.

## Network-Dependent Tests

The following test files contain tests that require outbound internet access:

| File | Test(s) |
|------|---------|
| `src/tests/git-clone.test.ts` | `cloneRepository clones a real public repository...` |

To skip network-dependent tests in CI or offline environments, set the `SKIP_NETWORK_TESTS`
environment variable to `1`:

```bash
SKIP_NETWORK_TESTS=1 npm test
```

The real-clone test checks `process.env.SKIP_NETWORK_TESTS` and skips itself when it is set.

## GUI Frontend — Writing New Views

The GUI uses a hash-based SPA router (`gui/public/js/router.js`). Views are plain ES-module functions registered in `gui/public/js/app.js`.

### Registering a route

```js
// app.js
import { renderMyView, setRouter as setMyViewRouter } from './views/my-view.js';

// Inject the router before router.start()
setMyViewRouter(router);

// Register the route
router.register('#/my-route', renderMyView);
```

A view function receives `(container: HTMLElement, params: Object)` and is responsible for building and appending its DOM to `container`.

### Router injection pattern (`setRouter`)

Views that need to call `router.navigate()` (e.g. to link to another view on click) **must not** import `router.js` directly — doing so creates a circular dependency:

```
app.js → my-view.js → router.js → app.js   ✗
```

Instead, follow the **dependency injection** pattern used in `dashboard.js`, `project-detail.js`, and `workspace-detail.js`:

1. Declare a module-level `_router` variable initialised to `null`.
2. Export a `setRouter(router)` function that assigns it.
3. `app.js` calls `setRouter(router)` **before** `router.start()`.

```js
// my-view.js
import { api } from '../api.js';

/** @type {import('../router.js').Router|null} */
let _router = null;

/**
 * Inject the router instance so this view can call router.navigate().
 * Called from app.js before the router starts.
 * @param {import('../router.js').Router} router
 */
export function setRouter(router) {
    _router = router;
}

export function renderMyView(container, params) {
    // ...
    link.addEventListener('click', (e) => {
        e.preventDefault();
        if (_router) _router.navigate('#/other-route');
    });
}
```

If a view has no need for programmatic navigation it does **not** need to export `setRouter`.

### Cleanup contract (returning a cleanup function)

Views that start side-effects on mount (e.g. `setInterval` polling, event subscriptions) **must** return a cleanup function from their view entry-point:

```js
export function renderMyView(container, params) {
    const intervalId = setInterval(() => { /* poll */ }, 10_000);

    // Return cleanup BEFORE the async bootstrap resolves,
    // so the router can register it immediately.
    const cleanup = () => {
        clearInterval(intervalId);
    };

    // ... async data load + DOM build ...

    return cleanup;
}
```

The router's `_render()` method stores and calls any function returned by a view before rendering the next one. Views with no side-effects do **not** need to return anything.

See `workspace-detail.js` for a complete example: the cleanup is returned synchronously before `Promise.all` resolves so the router can register it even if the user navigates away before the data fetch completes.

## Type-Audit Acceptance Criterion

Any work package that adds or modifies exported types must include the following acceptance criterion:

> **Type audit:** Exported types match the plan specification — verify that each new/modified
> interface property name, type, and optionality align with the plan before marking the WP complete.

QA work packages that follow implementation WPs should cross-check type signatures against the plan,
paying particular attention to optional (`?`) vs. required properties and union types.
