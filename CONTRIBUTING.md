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
