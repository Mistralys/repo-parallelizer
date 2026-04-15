# Contributing

For detailed architecture, API surface, data flows, and conventions, see the [project manifest](docs/agents/project-manifest/README.md).

## Development Setup

```bash
npm install
npm run build
```

## Running Locally

```bash
# Run via node
node dist/index.js

# Install as a global CLI (recommended for development)
npm link
paralizer
```

`dist/index.js` does not carry the executable bit after `tsc`. `npm link` handles this; `node dist/index.js` works without it.

## Build

```bash
npm run build   # one-shot compile
npm run dev     # watch mode
```

Compiled output goes to `dist/`. Source maps are generated alongside each file.

## TypeScript Imports

All relative imports **must** include the `.js` extension — this is a strict requirement of `Node16` module resolution:

```typescript
import { MyClass } from './my-module.js';   // ✓
import { MyClass } from './my-module';       // ✗ compile + runtime error
```

## Running Tests

```bash
npm test   # compiles TypeScript then runs all tests
```

### Test cleanup

Tests that create temporary files **must** register a `process.on('exit')` cleanup handler (synchronous) in addition to `afterAll`, because `afterAll` does not run on `SIGINT` or crash:

```typescript
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'my-test-'));
process.on('exit', () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
```

### Network-dependent tests

Skip tests requiring internet access with:

```bash
SKIP_NETWORK_TESTS=1 npm test
```

| File | Test(s) |
|------|---------|
| `src/tests/git-clone.test.ts` | `cloneRepository clones a real public repository...` |

## GUI Frontend

The GUI is a vanilla-JS SPA. For architecture details, router patterns, and component conventions, see the [GUI frontend manifest](docs/agents/project-manifest/gui-frontend.md).

### GUI-Layer Unit Tests

The `gui/public/js/` directory contains co-located unit test files (`.test.mjs`) for the API client. These run directly under Node's built-in test runner — no build step required.

**Run a single GUI test file:**

```bash
node --test gui/public/js/api.errorLog.test.mjs
```

**Run all GUI test files:**

```bash
node --test gui/public/js/*.test.mjs
```

**Naming convention:** GUI test files are named `<module>.test.mjs` and placed alongside the module they test (e.g. `api.errorLog.test.mjs` next to `api.js`). They use a `mockFetch()` helper to stub `globalThis.fetch` and assert against the URL and options passed to it, without making real HTTP requests.

## API Client Architecture Notes (`api.js`)

### `api.workspaces` namespace growth

The `api.workspaces` namespace has a nested `api.workspaces.launch` sub-namespace for external-application launchers, following the same pattern as `api.config.credentials` and `api.config.polling`. This keeps the top-level namespace from becoming unwieldy as more launcher types are added.

**Convention:** All external-app launcher methods live under `api.workspaces.launch` — never as flat methods on `api.workspaces` directly. If future work packages add more launch-related endpoints (e.g. opening a terminal, launching a diff tool), add them as methods on `api.workspaces.launch`.

**Current launch methods (`api.workspaces.launch`):**
- `vscode(projectId, wid)` — opens VS Code with the workspace's `.code-workspace` file.
- `githubDesktop(projectId, wid, repoId)` — opens GitHub Desktop for a specific repository clone.
