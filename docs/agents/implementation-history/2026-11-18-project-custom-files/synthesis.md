
## Synthesis

### Completion Status
- Date: 2026-11-18
- Status: COMPLETE
- Completed by: Web GUI Specialist Agent
- Research brief: none found
- Archived in Ledger: 2026-11-18

### Outcome Summary

Projects can now define "Custom Files" in a new tab after "Repositories": each has a workspace-relative directory, file name, label, description and plain-text content, plus an AGENTS.md toggle (default off). The files are written into every workspace of the project, kept in sync on add/save and on every existing artefact-regeneration trigger, and deleted from all workspaces when removed or moved. Flagged files appear in a "Custom Files" table (path, label, description) in each workspace's generated AGENTS.md.

### Interface Implementation Summary
- **Custom Files tab** (`gui/public/js/views/project-custom-files.js`, wired into `project-detail.js`): list with label/description, path, AGENTS.md state, Edit/Delete; one shared add/edit form with a monospace textarea editor, an AGENTS.md switch, a live "will be written to … / marked executable" summary, an "Unsaved changes" indicator, inline server-error display, and confirmations for discard and delete (the delete dialog states that copies are removed from all workspaces).
- **Tab persistence:** the project view remembers the active tab per project across its full re-render, so saving or deleting a custom file keeps the user on the tab.
- **Backend:** `CustomFiles` on the project record (optional field, no schema bump); validation module `custom-file.ts`; writer/remover `custom-files.ts` reusing the existing path-guard chain with the workspace folder as the containment root; four REST endpoints under `/api/projects/:id/custom-files`; sync through the existing `WorkspaceArtifactsOrchestrator` choke-point.
- **Behaviour:** local edits to copies are overwritten silently; executable bit set automatically for shell scripts on POSIX (extension or shebang); `.bat`/`.cmd` written CRLF, shell scripts LF; paths cannot escape the workspace, cannot target generated index files or repository folders, and must be unique case-insensitively; UTF-8 text only with a size cap.

### Documentation Updates
- `docs/agents/project-manifest/api-surface.md`: `CustomFile` types, validation/policy functions, new `ProjectManager` methods, `custom-files.ts`, orchestrator additions.
- `docs/agents/project-manifest/rest-api.md`: the four custom-file endpoints and their validation rules.
- `docs/agents/project-manifest/gui-frontend.md`: new tab, view module, keyboard behaviour, tab persistence.
- `docs/agents/project-manifest/data-flows.md`: custom-files sync flow.
- `docs/agents/project-manifest/constraints.md`: custom-file conventions (overwrite semantics, containment, reserved names, line endings, no schema bump).
- `.context/project-folder-structure.md` (CTX-generated) and `CHANGELOG.md` (curated from history by the changelog curator) were not touched; `ctx generate` should be re-run to pick up the new source files.

### Verification Summary
- Browser checks: headless Chrome driven over the DevTools protocol against an isolated server instance (temporary storage and workspace folders, separate port; the user's running instance and real storage were never used). Walked: open tab, empty/populated list, add (including AGENTS.md toggle), edit, rejected save (`../` directory shown inline), successful save keeping the Custom Files tab active, delete confirmation text, Tab/Escape handling in the textarea. Viewports: 1280px desktop, 640px (≈200% zoom equivalent), 375px mobile; light and dark theme.
- Accessibility and responsive audit: keyboard — Tab inserts a tab in the textarea, Escape then Tab moves on (no trap), Shift+Tab unaffected (the existing modal shell supplies the dialog focus trap and Escape handling; not re-verified here); labelled controls, `role="switch"`, `role="alert"` error, polite live summary, action buttons with descriptive `aria-label`s, table caption and column scopes; reused existing colour tokens and focus styles (no new colours); `prefers-reduced-motion` emulated — the feature adds no animation or transition; narrow screens — tab bar wraps and the table scrolls inside its own container. No automated contrast measurement was run, and no real assistive technology was used.
- Tests run: `npm test` (tsc build + backend suites, including new `custom-files.test.ts`); `npm run test:gui` (including new `project-custom-files.test.mjs`). End-to-end API walk with `curl` on the isolated instance: create, validation rejections, move (old copy and empty folder removed), toggle off (section removed from AGENTS.md), delete, repeat delete (404); file modes and CRLF verified on disk.
- Static analysis run: `tsc` (strict) via the build. No separate frontend linter is configured in the project.
- Result: PASS. Known pre-existing issue observed, not fixed: the global top navigation overflows horizontally at 375px (see Follow-Up Items).

### Interface Insights

#### Implementation Decisions
- [MEDIUM] (decision) `gui/public/js/views/project-detail.js`: The view re-renders fully after every mutation, which reset the active tab to "Workspaces". Added a per-project `_activeTab` so saving/deleting a custom file keeps the user on its tab; this also fixes the same bounce for Repositories mutations. The tab bar now wraps on narrow screens because four tabs overflow 375px.
- [MEDIUM] (decision) `src/orchestration/custom-files.ts`: Deletion relies on the stored definition rather than a separate "written files" ledger: on delete/move the previous definition's path is removed from every workspace under the same containment/symlink guards as the index files, and only regular files/symlinks are removed. Simpler than tracking, and it cannot delete anything outside a path the project itself defined.
- [MEDIUM] (decision) `src/models/project/custom-file.ts`: Line-ending policy — `.bat`/`.cmd` written CRLF, shell scripts (`.sh/.bash/.zsh/.ksh/.command` or `#!` shebang) LF (CRLF breaks shebangs), everything else as typed. Executable bit = shell extension or shebang; `chmod` is skipped on win32 where scripts run by extension.

#### Follow-Up Items
- [MEDIUM] (visual-bug) `gui/public/css/styles.css` (`.nav-links`, project header): Pre-existing — at 375px the global top nav and the project-header action button overflow the viewport (~259px horizontal page scroll) on every project tab, independent of this feature. Wrap or collapse the nav on narrow screens.
- [LOW] (accessibility-gap) `gui/public/js/views/project-detail.js` (tab-nav): The existing tab list lacks roving tabindex/arrow-key navigation and `aria-labelledby` on panels (the `tablist` pattern is only partially implemented). Not changed here; the new tab follows the existing pattern.
- [LOW] (improvement) `src/server/routes/projects.ts`: `DELETE /api/projects/:id` removes generated index files per workspace, but custom-file copies (like repository clones) stay on disk. If project deletion should also clean custom files, call `removeCustomFileCopies` before `projectManager.remove()`.
- [LOW] (improvement) `src/server/routes/projects.ts`: The custom-file routes are covered only indirectly (manager, writer, renderer unit tests plus a manual API walk); an HTTP-level route test for the 400 vs 404 status mapping would round out coverage.
- [LOW] (improvement) `gui/public/js/views/project-custom-files.js`: Tab-inserts-tab with the Esc-then-Tab escape hatch was added for script authoring. If users find it surprising, make Tab capture opt-in. Rich editing (line numbers, syntax highlighting) was deliberately left out of scope.

### Additional Comments
- The plan folder was created through the ad-hoc entry path; `plan.md` is unchanged since implementation began.
- Custom files are only written to workspaces whose folder exists; a not-yet-set-up workspace receives them when setup runs (setup regenerates the artefact set).
- A custom file overwrites any existing file at its target path, including hand-written ones, by design (silent overwrite was the agreed behaviour).
