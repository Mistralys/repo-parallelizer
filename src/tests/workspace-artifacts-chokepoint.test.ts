import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'node:path';

/**
 * Source-level guard for the `WorkspaceArtifactsOrchestrator` choke-point
 * (see `src/orchestration/workspace-artifacts.ts`): every module that needs
 * to create, refresh, or remove a workspace's on-disk artefact set is meant
 * to go through the orchestrator rather than calling the lower-level
 * generator/remover functions directly.
 *
 * This test statically scans production source files (excluding tests) for
 * `import { ... }` clauses naming any of the four raw functions, and fails
 * if any such import exists outside the choke-point module itself or the
 * documented, temporary exception below.
 *
 * `__dirname` is used (rather than `import.meta.url`) because this project
 * compiles to CommonJS — see the note in `src/index.ts`. Tests run from
 * `dist/tests/`, which mirrors `src/tests/` one-to-one (see `tsconfig.json`'s
 * `rootDir`/`outDir`), so the real `.ts` sources are resolved by walking back
 * up to the project root and back down into `src/`.
 */

const projectRoot = path.resolve(__dirname, '..', '..');
const srcRoot = path.join(projectRoot, 'src');

const GUARDED_IDENTIFIERS = [
    'generateWorkspaceFile',
    'removeWorkspaceFile',
    'writeWorkspaceIndexFiles',
    'removeWorkspaceIndexFiles',
];

/**
 * Module specifiers (matched by substring, so relative-path prefixes like
 * `../orchestration/` or `./` don't need to be enumerated) that a production
 * module outside the choke point must never reference, regardless of which
 * import form is used to reach them.
 */
const GUARDED_MODULE_SPECIFIERS = ['workspace-index.js', 'vscode-workspace.js'];

/** The one module allowed to import these identifiers directly. */
const CHOKE_POINT_MODULE = path.join(srcRoot, 'orchestration', 'workspace-artifacts.ts');

/**
 * Temporary, explicitly documented exceptions to the choke-point rule.
 *
 * This allowlist exists for a future intentionally-incomplete migration: a
 * production module may be added here only while it is being migrated onto
 * `WorkspaceArtifactsOrchestrator`, and only when both of the following hold:
 *
 * 1. The file still exists in the source tree.
 * 2. The file still actually imports at least one of `GUARDED_IDENTIFIERS`
 *    directly (verified mechanically by the second test below, not merely
 *    asserted by comment).
 *
 * It is currently empty by design — the one prior exception
 * (`src/server/routes/workspaces.ts`) has since migrated onto the
 * orchestrator and no longer imports any guarded identifier, so it was
 * removed from this set rather than left to go stale. Add an entry here only
 * when a new, real, temporary exception exists, and remove it again the
 * moment the corresponding migration lands.
 */
const TEMPORARY_EXCEPTIONS = new Set<string>([]);

function listSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            // Skip test directories — importing the raw functions in tests
            // that exercise `vscode-workspace.ts` / `workspace-index.ts`
            // directly is expected and not a choke-point violation.
            if (entry.name === 'tests' || entry.name === '__tests__') continue;
            listSourceFiles(full, out);
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
            out.push(full);
        }
    }
    return out;
}

/**
 * Extracts every named-import clause (`import { ... } from '...'`, possibly
 * multi-line) from `content`. Used only to enrich the offender message with
 * the specific guarded identifier being imported, where one is present —
 * the assertion itself is gated exclusively by {@link referencesGuardedModule}.
 */
function extractNamedImportBlocks(content: string): string[] {
    return content.match(/import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"]/gs) ?? [];
}

/**
 * Which of `identifiers` are named-imported by `content`, for use in offender
 * messages only. Uses a word-boundary match so e.g. `removeWorkspaceFileSomething`
 * doesn't false-positive, and only looks inside actual named-import clauses —
 * a plain-text mention of the identifier (e.g. in a comment) does not count.
 */
function namedGuardedIdentifiers(content: string, identifiers: readonly string[]): string[] {
    const found = new Set<string>();
    for (const block of extractNamedImportBlocks(content)) {
        for (const identifier of identifiers) {
            if (new RegExp(`\\b${identifier}\\b`).test(block)) found.add(identifier);
        }
    }
    return [...found];
}

/**
 * Whether `content` reaches into a guarded module via any import form —
 * static named/namespace/default/side-effect import, dynamic `import()`, or
 * `require()`. This is the single function gating both the main scan and the
 * allowlist-entry validity check below — there is no second copy of the
 * specifier-matching logic.
 *
 * The two families of import shape are treated differently, deliberately:
 *
 * - A static named-import clause (`import { a, b } from 'x'`) is the only
 *   form where the source text names exactly which exports are pulled in.
 *   Production code legitimately named-imports *other*, non-guarded exports
 *   from these same module files (e.g. `getWorkspaceFilePath`), so a named
 *   clause only counts as a violation when one of `GUARDED_IDENTIFIERS`
 *   actually appears inside it.
 * - Namespace, default, side-effect, dynamic `import()`, and `require()`
 *   forms all conceal which member ends up used — behind a namespace object,
 *   an arbitrarily-named default binding, a side effect, or a runtime value
 *   — so there is no statically-visible identifier left to filter on. Any
 *   reference to a guarded module's specifier through one of these opaque
 *   forms is therefore treated as a violation outright.
 */
function referencesGuardedModule(content: string): boolean {
    for (const block of extractNamedImportBlocks(content)) {
        if (GUARDED_IDENTIFIERS.some((identifier) => new RegExp(`\\b${identifier}\\b`).test(block))) {
            return true;
        }
    }

    const opaqueImportPatterns = [
        /import\s*\*\s*as\s+[\w$]+\s*from\s*['"]([^'"]+)['"]/gs, // namespace import
        /import\s+[\w$]+\s*from\s*['"]([^'"]+)['"]/gs,           // default import
        /import\s*['"]([^'"]+)['"]/g,                            // side-effect import
        /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,                  // dynamic import()
        /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,                 // require()
    ];

    for (const re of opaqueImportPatterns) {
        let match: RegExpExecArray | null;
        while ((match = re.exec(content)) !== null) {
            const specifier = match[1];
            if (GUARDED_MODULE_SPECIFIERS.some((guarded) => specifier.includes(guarded))) {
                return true;
            }
        }
    }
    return false;
}

test('no production module outside the choke-point imports the raw workspace-artifact generator/remover functions', () => {
    const offenders: string[] = [];

    for (const file of listSourceFiles(srcRoot)) {
        if (file === CHOKE_POINT_MODULE) continue;
        if (TEMPORARY_EXCEPTIONS.has(file)) continue;

        const content = fs.readFileSync(file, 'utf8');

        if (referencesGuardedModule(content)) {
            const identifiers = namedGuardedIdentifiers(content, GUARDED_IDENTIFIERS);
            const detail = identifiers.length > 0
                ? `imports "${identifiers.join('", "')}"`
                : 'references a guarded module';
            offenders.push(`${path.relative(srcRoot, file)}: ${detail}`);
        }
    }

    assert.deepStrictEqual(
        offenders,
        [],
        `Expected no production module outside workspace-artifacts.ts to import the raw generator/remover ` +
        `functions directly, but found:\n${offenders.join('\n')}`,
    );
});

test('the temporary exception allowlist only contains files that exist and still import a guarded identifier', () => {
    for (const exception of TEMPORARY_EXCEPTIONS) {
        assert.ok(
            fs.existsSync(exception),
            `Exception entry "${path.relative(srcRoot, exception)}" no longer exists — remove it from the allowlist.`,
        );

        const content = fs.readFileSync(exception, 'utf8');
        assert.ok(
            referencesGuardedModule(content),
            `Exception entry "${path.relative(srcRoot, exception)}" no longer references a guarded module ` +
            `— its migration has landed, so remove it from the allowlist.`,
        );
    }
});

// ---------------------------------------------------------------------------
// Direct coverage of the allowlist-entry validity check, so the assertion
// mechanism itself is proven to fail on a stale entry rather than only being
// exercised (vacuously) against the currently-empty real allowlist.
// ---------------------------------------------------------------------------

test('allowlist-entry check: fails for a file that exists but references no guarded module', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-chokepoint-test-'));
    try {
        const stalePath = path.join(tmpDir, 'stale-entry.ts');
        fs.writeFileSync(stalePath, `import { somethingElse } from './other.js';\n`, 'utf8');

        assert.ok(fs.existsSync(stalePath), 'sanity check: file should exist');
        assert.equal(
            referencesGuardedModule(fs.readFileSync(stalePath, 'utf8')),
            false,
            'a file that imports an unrelated module should not be treated as a valid allowlist entry',
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('allowlist-entry check: passes for a file that exists and references a guarded module', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-chokepoint-test-'));
    try {
        const validPath = path.join(tmpDir, 'valid-entry.ts');
        fs.writeFileSync(validPath, `import { generateWorkspaceFile } from '../orchestration/vscode-workspace.js';\n`, 'utf8');

        assert.ok(fs.existsSync(validPath), 'sanity check: file should exist');
        assert.equal(
            referencesGuardedModule(fs.readFileSync(validPath, 'utf8')),
            true,
            'a file that imports a guarded module should be treated as a valid allowlist entry',
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Focused unit coverage of the shared detection function itself, with
// synthetic fixture files covering every import shape it must catch — each
// registers a `process.on('exit')` handler so its temp directory is removed
// even on crash or `SIGINT`, per this project's test-isolation convention.
// ---------------------------------------------------------------------------

function withSyntheticFixture(fileName: string, contents: string, run: (content: string) => void): void {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paralizer-chokepoint-test-'));
    process.on('exit', () => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    try {
        const filePath = path.join(tmpDir, fileName);
        fs.writeFileSync(filePath, contents, 'utf8');
        run(fs.readFileSync(filePath, 'utf8'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

test('referencesGuardedModule() matches a static named import of a guarded module', () => {
    withSyntheticFixture(
        'named-import.ts',
        `import { writeWorkspaceIndexFiles } from '../orchestration/workspace-index.js';\n`,
        (content) => assert.equal(referencesGuardedModule(content), true),
    );
});

test('referencesGuardedModule() matches a namespace import of a guarded module', () => {
    withSyntheticFixture(
        'namespace-import.ts',
        `import * as workspaceIndex from '../orchestration/workspace-index.js';\n`,
        (content) => assert.equal(referencesGuardedModule(content), true),
    );
});

test('referencesGuardedModule() matches a default import of a guarded module', () => {
    withSyntheticFixture(
        'default-import.ts',
        `import vscodeWorkspace from '../orchestration/vscode-workspace.js';\n`,
        (content) => assert.equal(referencesGuardedModule(content), true),
    );
});

test('referencesGuardedModule() matches a side-effect import of a guarded module', () => {
    withSyntheticFixture(
        'side-effect-import.ts',
        `import '../orchestration/vscode-workspace.js';\n`,
        (content) => assert.equal(referencesGuardedModule(content), true),
    );
});

test('referencesGuardedModule() matches a dynamic import() of a guarded module', () => {
    withSyntheticFixture(
        'dynamic-import.ts',
        `async function load() {\n    const idx = await import('../orchestration/workspace-index.js');\n    return idx;\n}\n`,
        (content) => assert.equal(referencesGuardedModule(content), true),
    );
});

test('referencesGuardedModule() matches a require() of a guarded module', () => {
    withSyntheticFixture(
        'require-import.ts',
        `const { removeWorkspaceFile } = require('../orchestration/vscode-workspace.js');\n`,
        (content) => assert.equal(referencesGuardedModule(content), true),
    );
});

test('referencesGuardedModule() does not match an import of an unrelated module', () => {
    withSyntheticFixture(
        'unrelated-import.ts',
        `import { somethingUnrelated } from './unrelated.js';\n`,
        (content) => assert.equal(referencesGuardedModule(content), false),
    );
});

test('namedGuardedIdentifiers() matches a named import of a guarded identifier', () => {
    const content = `import { writeWorkspaceIndexFiles } from '../orchestration/workspace-index.js';`;
    assert.deepStrictEqual(namedGuardedIdentifiers(content, GUARDED_IDENTIFIERS), ['writeWorkspaceIndexFiles']);
});

test('namedGuardedIdentifiers() does not match a comment merely mentioning the identifier', () => {
    const content = `// TODO: consider calling writeWorkspaceIndexFiles() here eventually.\nimport { somethingUnrelated } from './unrelated.js';`;
    assert.deepStrictEqual(namedGuardedIdentifiers(content, GUARDED_IDENTIFIERS), []);
});
