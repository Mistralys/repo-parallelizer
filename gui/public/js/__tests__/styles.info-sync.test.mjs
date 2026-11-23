/**
 * Static stylesheet checks for the repository info-sync CSS (plan step 18,
 * AC-17d).
 *
 * The GUI test suites are jsdom-only and no browser tooling is configured
 * (`package.json`), so there is no in-run way to render `styles.css` and
 * measure contrast, reflow or reduced-motion behaviour. This test instead
 * reads `styles.css` as plain text and asserts the string-level rules that
 * *are* mechanically checkable:
 *   - the new sync-related rule blocks use only `var(--…)` colours (no hex /
 *     `rgb(` / `hsl(` literals) and never remove the focus outline;
 *   - the action row wraps (`flex-wrap: wrap`) and paths/diff values wrap at
 *     any character (`overflow-wrap: anywhere`);
 *   - the existing `@media (max-width: 768px)` block carries the stacked
 *     import-diff-row rule and a >=16px input/textarea font size;
 *   - any new `animation`/`@keyframes` selector in the touched rules also
 *     appears in the existing `@media (prefers-reduced-motion: reduce)`
 *     block.
 *
 * The real browser walkthrough (measured contrast, 320px/200% zoom reflow,
 * keyboard flows, both themes) is Human Action 4 in the plan — out of scope
 * here.
 *
 * Run individually with:
 *   node --test 'gui/public/js/__tests__/styles.info-sync.test.mjs'
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STYLES_PATH = path.join(__dirname, '..', '..', 'css', 'styles.css');
const css = readFileSync(STYLES_PATH, 'utf8');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Finds the first `{`/`}`-delimited block whose opening brace follows
 * `searchFrom`, and returns its *inner* content (braces excluded). Handles
 * one level of nesting (enough for a top-level `@media { selector { … } }`
 * block; plain rule blocks have no nesting at all).
 *
 * @param {string} text
 * @param {number} searchFrom - Index to start looking for the opening `{` from.
 * @returns {string}
 */
function extractBraceBlock(text, searchFrom) {
    const openIdx = text.indexOf('{', searchFrom);
    assert.ok(openIdx !== -1, 'Expected an opening brace after the given index.');

    let depth = 0;
    for (let i = openIdx; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
            depth--;
            if (depth === 0) {
                return text.slice(openIdx + 1, i);
            }
        }
    }
    throw new Error('Unbalanced braces: no matching closing brace found.');
}

/**
 * Extracts the inner content of a top-level rule block anchored on a marker
 * string that appears inside its selector (e.g. a class name).
 *
 * @param {string} text
 * @param {string} selectorMarker
 * @returns {string}
 */
function extractRuleBlock(text, selectorMarker) {
    const markerIdx = text.indexOf(selectorMarker);
    assert.ok(markerIdx !== -1, `Expected to find selector marker "${selectorMarker}" in styles.css.`);
    return extractBraceBlock(text, markerIdx);
}

// ---------------------------------------------------------------------------
// Isolate the new rule sections
// ---------------------------------------------------------------------------

// All of WP-015's new selectors were appended as one contiguous run at the
// tail of the file (Repository Info Sync section through the Info Commit
// Dialog pending-files list), anchored on this section's opening comment.
const SYNC_SECTION_MARKER = 'Repository Info Sync — section, state pill, pending files, action row';
const syncSectionStart = css.indexOf(SYNC_SECTION_MARKER);
assert.ok(syncSectionStart !== -1, 'Expected the Repository Info Sync CSS section comment in styles.css.');
const newSyncCss = css.slice(syncSectionStart);

// The first existing `@media (max-width: 768px)` block ("Responsive Basics"),
// which now also carries the mobile-specific info-sync rules.
const firstMobileMediaIdx = css.indexOf('@media (max-width: 768px)');
assert.ok(firstMobileMediaIdx !== -1, 'Expected an existing @media (max-width: 768px) block in styles.css.');
const firstMobileMediaBlock = extractBraceBlock(css, firstMobileMediaIdx);

// The existing reduced-motion block.
const reducedMotionIdx = css.indexOf('@media (prefers-reduced-motion: reduce)');
assert.ok(reducedMotionIdx !== -1, 'Expected an existing @media (prefers-reduced-motion: reduce) block in styles.css.');
const reducedMotionBlock = extractBraceBlock(css, reducedMotionIdx);

// ---------------------------------------------------------------------------
// No colour literals, no outline removal
// ---------------------------------------------------------------------------

test('new sync-related CSS uses only var(--…) colours, no hex/rgb()/hsl() literals', () => {
    // Strip CSS comments first so prose like "e.g. #abc" in a doc comment
    // (none currently present, but defensive) never produces a false positive.
    const withoutComments = newSyncCss.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(withoutComments, /#[0-9a-fA-F]{3,8}\b/, 'Found a hex colour literal.');
    assert.doesNotMatch(withoutComments, /\brgb\(/, 'Found an rgb() colour literal.');
    assert.doesNotMatch(withoutComments, /\bhsl\(/, 'Found an hsl() colour literal.');
});

test('new sync-related CSS never removes the focus outline', () => {
    assert.doesNotMatch(newSyncCss, /outline\s*:\s*none/, 'Found "outline: none".');
    assert.doesNotMatch(newSyncCss, /outline\s*:\s*0\b/, 'Found "outline: 0".');
});

// ---------------------------------------------------------------------------
// Action row wraps; paths and diff values wrap at any character
// ---------------------------------------------------------------------------

test('.info-sync-action-row wraps buttons (flex-wrap: wrap)', () => {
    const block = extractRuleBlock(newSyncCss, '.info-sync-action-row {');
    assert.match(block, /flex-wrap\s*:\s*wrap/, 'Expected flex-wrap: wrap on .info-sync-action-row.');
});

test('.info-sync-main-folder-path wraps at any character (overflow-wrap: anywhere)', () => {
    const block = extractRuleBlock(newSyncCss, '.info-sync-main-folder-path {');
    assert.match(block, /overflow-wrap\s*:\s*anywhere/);
});

test('.info-import-value__text (diff values) wraps at any character (overflow-wrap: anywhere)', () => {
    const block = extractRuleBlock(newSyncCss, '.info-import-value__text {');
    assert.match(block, /overflow-wrap\s*:\s*anywhere/);
});

// ---------------------------------------------------------------------------
// Existing @media (max-width: 768px) block — stacked diff rows + 16px font
// ---------------------------------------------------------------------------

test('@media (max-width: 768px) stacks the import diff rows', () => {
    assert.match(
        firstMobileMediaBlock,
        /\.info-import-value\s*\{[^}]*flex-basis\s*:\s*100%/,
        'Expected .info-import-value to stack to full width inside the 768px media block.',
    );
});

test('@media (max-width: 768px) sets input/textarea font-size to at least 16px', () => {
    // Find every `font-size: <n>px` declaration inside the media block and
    // require at least one selector list mentioning form-textarea/form-input
    // to carry a value >= 16px.
    const formControlRuleMatch = firstMobileMediaBlock.match(
        /\.form-input,[\s\S]*?\.form-textarea\s*\{([^}]*)\}/,
    );
    assert.ok(formControlRuleMatch, 'Expected a form-input/form-textarea rule inside the 768px media block.');

    const fontSizeMatch = formControlRuleMatch[1].match(/font-size\s*:\s*(\d+(?:\.\d+)?)px/);
    assert.ok(fontSizeMatch, 'Expected a px font-size declaration for form controls inside the 768px media block.');
    assert.ok(Number(fontSizeMatch[1]) >= 16, 'Expected the form control font-size to be at least 16px.');
});

// ---------------------------------------------------------------------------
// No animation outside the prefers-reduced-motion block
// ---------------------------------------------------------------------------

test('new sync-related CSS adds no animation outside the prefers-reduced-motion block', () => {
    const animationNames = [...newSyncCss.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    const animationDeclarations = [...newSyncCss.matchAll(/animation(?:-name)?\s*:\s*([\w-]+)/g)].map((m) => m[1]);
    const allNewAnimationNames = [...new Set([...animationNames, ...animationDeclarations])];

    if (allNewAnimationNames.length === 0) {
        // No new animation was introduced — the floor is satisfied trivially.
        assert.ok(true);
        return;
    }

    for (const name of allNewAnimationNames) {
        assert.ok(
            reducedMotionBlock.includes(name),
            `New animation "${name}" must also be registered in the ` +
            '@media (prefers-reduced-motion: reduce) block.',
        );
    }
});
