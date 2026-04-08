# Plan: Pico CSS Integration

## Summary

Add Pico CSS (classless variant) to the GUI frontend as an npm-installed CSS framework, providing improved base element styling and a manual light/dark theme toggle. The integration follows a conservative approach: Pico provides the base styling layer, and the existing `styles.css` remains as an override layer with minimal removals limited to clear duplicates (CSS reset, base typography). A theme toggle control in the top nav allows users to switch between light and dark mode, with the preference persisted in `localStorage`.

## Architectural Context

The GUI is a vanilla JavaScript SPA with no build step, served as static files from `gui/public/` by the built-in HTTP server (`src/server/staticServer.ts`). Key integration points:

- **Static file serving:** `serveStatic()` in `src/server/staticServer.ts` serves files from `gui/public/` with a MIME map supporting `.html`, `.css`, `.js`, `.json`, `.png`, `.svg`, `.ico`. A CSP header `default-src 'self'` is set on HTML responses.
- **Entry point:** `gui/public/index.html` loads `css/styles.css` and bootstraps via `js/app.js`.
- **Styling:** A single `gui/public/css/styles.css` (849 lines) provides all styling via CSS custom properties, CSS reset, base typography, component styles, and utility classes.
- **Nav bar:** Defined inline in `index.html` with class `top-nav`, containing brand link and nav links. Active link highlighting is managed by `app.js`.
- **Zero runtime dependencies:** The project has zero Node.js runtime dependencies. Pico CSS is a browser CSS asset, not a Node.js runtime dependency, so it fits as a `devDependency`.

## Approach / Architecture

```
                    ┌─────────────────────────┐
                    │      index.html          │
                    │                          │
                    │  <link> pico.classless   │  ← base layer (from vendor/)
                    │  <link> styles.css       │  ← override layer (custom)
                    │                          │
                    │  data-theme="light|dark" │  ← on <html>, controls Pico theme
                    └─────────────────────────┘
                              │
        ┌─────────────────────┼──────────────────┐
        │                     │                    │
   theme-toggle.js       app.js              styles.css
   (component)        (integrates            (dark vars in
                       toggle +               :root[data-theme="dark"])
                       localStorage)
```

**Pico CSS delivery pipeline:**
1. `@picocss/pico` installed as devDependency via npm.
2. An npm script (`copy-vendor`) copies `pico.classless.min.css` from `node_modules` to `gui/public/css/vendor/`.
3. A `postinstall` hook calls `copy-vendor` automatically after `npm install`.
4. `gui/public/css/vendor/` is gitignored (generated artifact).
5. `index.html` references the local copy, satisfying the `default-src 'self'` CSP.

**Theme switching:**
- Pico CSS v2 supports `data-theme="light"` / `data-theme="dark"` on the `<html>` element.
- A new `theme-toggle.js` component renders a toggle button in the nav bar.
- `app.js` initializes the theme from `localStorage` on load and wires up the toggle.
- `styles.css` gains a `:root[data-theme="dark"]` block that remaps all `--color-*` custom properties to dark variants.

## Rationale

- **Classless variant:** Chosen because it styles semantic HTML elements directly with zero class requirements — ideal layering under the existing class-based custom CSS. No HTML class attribute changes needed for Pico to take effect.
- **Conservative refactoring:** Minimizes risk of visual regressions. Clear duplicates (CSS reset, base typography) are removed from `styles.css` since Pico handles them better. All component-specific styles (badges, wizard, toast, modal, nav) are kept unchanged.
- **`devDependency` + copy script:** Maintains the "zero runtime dependencies" invariant. The copy script is explicit, auditable, and avoids modifying the static server to serve from `node_modules`.
- **Manual theme switch over auto:** User explicitly requested a manual toggle control rather than automatic `prefers-color-scheme` detection.

## Detailed Steps

### Step 1: Install Pico CSS

Install `@picocss/pico` as a devDependency:
```
npm install --save-dev @picocss/pico
```

### Step 2: Add vendor copy script

Add to `package.json` scripts:
```json
"copy-vendor": "mkdir -p gui/public/css/vendor && cp node_modules/@picocss/pico/css/pico.classless.min.css gui/public/css/vendor/",
"postinstall": "npm run copy-vendor"
```

### Step 3: Update `.gitignore`

Add `gui/public/css/vendor/` to `.gitignore` since it is a generated artifact from `node_modules`.

### Step 4: Update `index.html`

1. Add `data-theme="light"` attribute to the `<html>` element (default theme).
2. Add `<link rel="stylesheet" href="css/vendor/pico.classless.min.css">` **before** the existing `styles.css` link, so custom styles override Pico defaults.
3. Add a `<div>` with a theme toggle button in the `<header>` nav bar area.

Updated `<head>`:
```html
<html lang="en" data-theme="light">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Repo Parallelizer</title>
    <link rel="stylesheet" href="css/vendor/pico.classless.min.css">
    <link rel="stylesheet" href="css/styles.css">
</head>
```

Updated nav (add theme toggle area):
```html
<header class="top-nav">
    <div class="nav-brand">
        <a href="#/">Repo Parallelizer</a>
    </div>
    <nav class="nav-links">
        <a href="#/" class="nav-link">Dashboard</a>
        <a href="#/repositories" class="nav-link">Repositories</a>
    </nav>
    <div id="theme-toggle-container"></div>
</header>
```

### Step 5: Create theme toggle component

**New file:** `gui/public/js/components/theme-toggle.js`

Exports:
- `createThemeToggle(): HTMLButtonElement` — Returns a button element that toggles `data-theme` on `<html>` between `"light"` and `"dark"`. Reads initial state from `localStorage` key `"theme"` (defaulting to `"light"`), applies it to `document.documentElement.dataset.theme`, and persists changes on click.

The button should display a sun icon (☀️) when in dark mode (meaning "click to switch to light") and a moon icon (🌙) when in light mode (meaning "click to switch to dark"). Use Unicode characters — no icon library. The button should use the `btn-icon` class for consistent sizing with existing icon buttons.

### Step 6: Integrate theme toggle into `app.js`

In `app.js`, after existing imports:
1. Import `createThemeToggle` from `./components/theme-toggle.js`.
2. After router setup, create the toggle and append it to `#theme-toggle-container`.
3. Apply the saved theme from `localStorage` to `document.documentElement.dataset.theme` early (before first render) to avoid a flash of wrong theme.

### Step 7: Refactor `styles.css` — remove Pico-duplicated sections

Remove the following sections that Pico classless now handles:

1. **Reset & Base** (lines ~78–98): The `*` box-sizing reset, `html` font-size/line-height, `body` font-family/color/background, and base `a` / `code,pre` styles. Pico provides comprehensive reset and base typography.

Keep everything else: custom properties, nav, layout, page headings, buttons, tables, forms, badges, modal, toast, wizard, spinner, utilities, responsive.

### Step 8: Add dark mode custom properties to `styles.css`

Add a `:root[data-theme="dark"]` block that remaps all `--color-*` custom properties to dark-appropriate values. This ensures all existing component styles that reference `--color-*` variables automatically adapt to dark mode.

Dark values to define:
```css
:root[data-theme="dark"] {
    --color-bg: #1a1a2e;
    --color-surface: #16213e;
    --color-border: #374151;
    --color-border-light: #2d3748;
    --color-text: #e5e7eb;
    --color-text-secondary: #9ca3af;
    --color-text-muted: #6b7280;

    --color-primary: #60a5fa;
    --color-primary-hover: #93bbfd;
    --color-primary-light: #1e3a5f;

    --color-danger: #f87171;
    --color-danger-hover: #fca5a5;
    --color-danger-light: #450a0a;

    --color-success: #4ade80;
    --color-success-light: #052e16;

    --color-warning: #fbbf24;
    --color-warning-light: #451a03;

    --color-info: #22d3ee;
    --color-info-light: #083344;

    /* Badge dark variants */
    --badge-clean: #4ade80;
    --badge-clean-bg: #052e16;
    --badge-modified: #fbbf24;
    --badge-modified-bg: #451a03;
    --badge-ahead: #60a5fa;
    --badge-ahead-bg: #1e3a5f;
    --badge-behind: #c084fc;
    --badge-behind-bg: #3b0764;
    --badge-conflict: #f87171;
    --badge-conflict-bg: #450a0a;
    --badge-error: #f87171;
    --badge-error-bg: #450a0a;

    /* Shadows for dark mode */
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
    --shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.4), 0 2px 4px -2px rgba(0, 0, 0, 0.3);
    --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.4), 0 4px 6px -4px rgba(0, 0, 0, 0.3);
}
```

### Step 9: Adjust existing `styles.css` for Pico coexistence

Pico classless will style bare HTML elements. Some existing component styles may need minor overrides to assert dominance. Specific adjustments:

1. **`body` background and font:** Ensure the existing `body` rule in `:root` custom properties feeds through correctly. If Pico's body styles override, add explicit `body { background: var(--color-bg); color: var(--color-text); }` in the main content section (not the reset section that gets removed).
2. **`.top-nav`:** Ensure the nav bar retains its custom styling. Pico styles `<header>` and `<nav>` elements — the existing class-based selectors should win due to specificity, but verify.
3. **`<table>` styling:** Pico styles tables directly. The existing table styles use both element and class selectors. Verify no visual conflict; add specificity if needed (e.g., `.table-wrapper table`).
4. **`<button>` styling:** Pico styles all `<button>` elements. The existing `.btn` class styles should override due to higher specificity. Verify all buttons have the `.btn` class (or use Pico's base style where acceptable).
5. **`<input>`, `<select>`, `<textarea>`:** Pico applies focus rings, sizing, and colors. The existing `.form-input` / `.form-select` / `.form-textarea` classes should override. Verify form elements without these classes (if any) still look acceptable with Pico defaults.

### Step 10: Update manifest documents

1. **`docs/agents/project-manifest/tech-stack.md`:** Add `@picocss/pico` to dev dependencies table. Add note about `copy-vendor` script.
2. **`docs/agents/project-manifest/file-tree.md`:** Add `gui/public/css/vendor/` directory and `pico.classless.min.css`. Add `gui/public/js/components/theme-toggle.js`.
3. **`docs/agents/project-manifest/gui-frontend.md`:** Add theme toggle component to reusable components table. Update Styling description to mention Pico CSS classless as base layer. Document theme switching mechanism.
4. **`docs/agents/project-manifest/constraints.md`:** Add note about vendor CSS being generated (not committed) and the `copy-vendor` script requirement.

## Dependencies

- `@picocss/pico` npm package (v2.x) — CSS-only, no JavaScript runtime dependency.
- `mkdir` and `cp` shell commands (available on macOS/Linux; Windows would need adaptation if targeting cross-platform npm scripts).

## Required Components

### Existing files to modify
- `package.json` — Add devDependency and scripts.
- `gui/public/index.html` — Add Pico CSS link, `data-theme` attribute, toggle container.
- `gui/public/css/styles.css` — Remove reset/base section, add dark mode variables, adjust specificity where needed.
- `gui/public/js/app.js` — Import and mount theme toggle, initialize theme from localStorage.
- `.gitignore` — Add vendor CSS directory.
- `docs/agents/project-manifest/tech-stack.md` — New dependency.
- `docs/agents/project-manifest/file-tree.md` — New files/directories.
- `docs/agents/project-manifest/gui-frontend.md` — Theme toggle component, Pico CSS docs.
- `docs/agents/project-manifest/constraints.md` — Vendor CSS convention.

### New files to create
- `gui/public/js/components/theme-toggle.js` — Theme toggle component.
- `gui/public/css/vendor/pico.classless.min.css` — Generated by `copy-vendor` script (gitignored).

## Assumptions

- Pico CSS v2.x is the target version (current stable).
- The `copy-vendor` script uses POSIX shell commands (`mkdir -p`, `cp`), which are available on macOS and Linux. If Windows support is needed, a Node.js-based copy script could be used instead, but this is not in scope.
- The CSP `default-src 'self'` policy is compatible with serving vendor CSS from the same origin (`gui/public/css/vendor/`).
- Buttons in views that use the `.btn` class will visually override Pico's base `<button>` styling due to CSS specificity.
- Unicode characters (☀️ / 🌙) are sufficient for the theme toggle — no icon library needed.

## Constraints

- **No build step for frontend:** The copy-vendor script is a simple file copy, not a build pipeline.
- **Zero Node.js runtime dependencies:** Pico CSS is a browser asset installed as a devDependency. No changes to the Node.js runtime dependency count.
- **Conservative refactoring:** Only the CSS reset and base typography sections are removed from `styles.css`. All component-specific styles are preserved.
- **CSP compliance:** Vendor CSS must be served from the same origin. No CDN links.

## Out of Scope

- Refactoring existing views to use more semantic HTML (e.g., `<div class="card">` → `<article>`). This can be done incrementally in future work.
- Removing class-based form/button/table styles in favor of Pico's classless equivalents. The conservative approach keeps both layers.
- Cross-platform `copy-vendor` script (Windows `cmd.exe` compatibility).
- Pico CSS color theme customization beyond light/dark toggle.
- Automated tests for theme switching or visual regression testing.

## Acceptance Criteria

- `npm install` succeeds and the `postinstall` hook copies `pico.classless.min.css` to `gui/public/css/vendor/`.
- The GUI loads without console errors and renders correctly in light mode (default).
- All existing views (Dashboard, Repositories, Project Detail, Workspace Detail, Branch Switch) render without visual regressions in light mode compared to current appearance.
- A theme toggle button is visible in the top navigation bar.
- Clicking the toggle switches between light and dark mode.
- The theme preference persists across page reloads via `localStorage`.
- Dark mode applies appropriate dark colors to all UI elements (nav, cards, tables, forms, badges, modals, toasts, wizard).
- `tsc` compilation succeeds (no TypeScript changes break the build).
- Existing tests pass (no behavioral changes to the backend).

## Testing Strategy

- **Manual visual testing:** Load each view in both light and dark mode and verify no layout breakage, illegible text, or missing styling.
- **Theme persistence:** Reload the page after setting dark mode and verify it persists.
- **CSP check:** Open browser DevTools console and verify no CSP violations when loading the page.
- **Existing test suite:** Run `npm test` to confirm no regressions in backend tests.
- **Build verification:** Run `npm run build` to confirm TypeScript compilation is unaffected.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Pico classless styling conflicts with existing CSS** | Conservative approach: keep all existing class-based styles. Only remove clear duplicates (reset, base). Inspect each view manually. |
| **Dark mode color values don't look good in practice** | The dark color values in the plan are starting points. Visual tuning during implementation is expected. |
| **Some form/button elements lack custom classes and rely on Pico defaults** | Audit all views for bare `<button>`, `<input>`, `<select>` elements during implementation. Add classes if Pico's default styling is insufficient. |
| **`copy-vendor` script fails silently** | The `postinstall` hook will surface errors via npm. If the copy fails, `npm install` output will show the error. |
| **Pico CSS updates break the layout** | Version pinned via `package-lock.json`. Updates are explicit via `npm update`. |
| **POSIX-only copy script** | Documented as out-of-scope for Windows. Can be replaced with a Node.js script if needed later. |
