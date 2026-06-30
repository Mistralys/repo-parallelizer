# Plan

## Plan Audit Cycles
- Audits: none — Plan Auditor v1.5.0
- Architectural Reviews: none — Plan Architect Reviewer v1.6.0

## Prior Project Context
This is the third and likely final rework cycle in the multi-credential-support trilogy (`multi-credential-support` → `rework-1` → `rework-2`). The rework-2 synthesis closed all high- and medium-priority deferred items. Three low-priority items remain that are small, self-contained, and can be addressed in a single pass without risk to the 933-test baseline.

## Summary
Address the three most defensible deferred items from the `rework-2` synthesis: (1) reorder `parseGitCredentials()` to validate raw field lengths before trimming, restoring spec fidelity; (2) trim the `label` field in legacy-format credential entries for consistency with the new-format path; (3) add manager-level integration tests for the `'audit'` and `'info'` severity values against the actual `ErrorLogManager` storage layer.

## Architectural Context
- **Credential parsing** lives in `src/config/config.ts` in the private `parseGitCredentials()` function, called by `loadConfig()`. It handles two formats: new-format (`GitCredentialEntry[]`) and legacy-format (`Record<string, string>`). Both paths normalize values via `.trim()` and validate field lengths against constants from `src/config/config.constants.ts`.
- **Error log manager** is `src/error-log/error-log.manager.ts` (`ErrorLogManager` class). The `list()` method accepts `ErrorLogListOptions` with an optional `severity` filter that performs exact string matching against `ErrorSeverity` values (`'error' | 'warning' | 'audit' | 'info'`).
- **Existing test files**: `src/tests/config.test.ts` (credential parsing tests at lines 252–530) and `src/tests/error-log.manager.test.ts` (comprehensive `list()` tests but only using `'error'` and `'warning'` severities).
- **Documentation**: `docs/agents/project-manifest/constraints.md` line 48 documents the legacy label behavior as intentional. This must be updated when the behavior changes.

## Approach / Architecture
Three surgical changes with no new abstractions, modules, or dependencies:

1. **Validate-then-trim reorder** (new-format path): In the field-length validation loop at `src/config/config.ts` line ~228, check `(entry[field] as string).length > maxLen` against the **raw** value, then let the existing trim-on-return block (line ~250) handle normalization. This means the length check sees the raw input, and the returned value is still trimmed.

2. **Legacy label trim** (legacy-format path): At `src/config/config.ts` line ~295, change `label: host` to `label: host.trim()` so legacy entries receive the same normalization as new-format entries. Update `docs/agents/project-manifest/constraints.md` to reflect the new behavior.

3. **Manager-level severity tests**: Add test cases in `src/tests/error-log.manager.test.ts` that call `ErrorLogManager.list({ severity: 'audit' })` and `list({ severity: 'info' })` against the real storage layer (not mocked) to give the `rework-2` severity expansion genuine storage-level coverage.

## Rationale
- **Validate-then-trim**: The spec for `parseGitCredentials()` (established in rework-1) states that raw values should be validated before normalization. The current implementation trims first, meaning a 102-character value with 2 characters of whitespace would pass a 100-character limit. The generous limits (100–500 chars) make this a theoretical-only risk, but correcting the order restores spec fidelity and removes a documented contract divergence flagged by three pipeline agents (QA, Security Auditor, Reviewer).
- **Legacy label trim**: The JSDoc on `parseGitCredentials()` describes the untrimmed label as "intentional" for display purposes, but there is no functional reason to display a whitespace-padded hostname. The new-format path already trims all four fields including `label`. Aligning the legacy path removes a cosmetic asymmetry documented in the synthesis.
- **Severity tests**: The `'audit'` and `'info'` values were added in rework-2 WP-001 and are exercised at the route layer via `MockErrorLogManager`, but the actual `ErrorLogManager.list()` filter path has never been tested with these values against real storage. Adding these tests is low-effort and closes a genuine coverage gap.

## Considered Alternatives

| Decision | Chosen Shape | Alternatives Considered | Trade-Off Summary |
|----------|--------------|-------------------------|-------------------|
| Validate raw then trim | Check raw `.length`, trim on return | Keep current trim-then-check (no change) | Current behavior is documented as a spec divergence by three agents; the fix is a one-line change with no behavioral risk for legitimate inputs |
| Legacy label: trim | `label: host.trim()` | Keep raw label for "display fidelity" | No user benefits from whitespace-padded labels; aligning with new-format path removes a documented asymmetry |
| Manager tests: real storage | Test against actual `ErrorLogManager` + temp dir | Skip (route-layer mock tests exist) | The generic filter path is almost certainly correct, but the manager-level test file has zero coverage for the two newest severity values — a 5-minute addition that closes the gap |

## Pattern Alignment
- **Test pattern**: `src/tests/error-log.manager.test.ts` uses `createTempDirTracker()` + `makeTestConfig()` + real `ErrorLogManager` instances. New tests follow this existing pattern exactly.
- **Config test pattern**: `src/tests/config.test.ts` uses `writeConfig()` + `loadConfig()` for credential parsing. Existing length-validation tests at lines 252–300 already test at-limit and over-limit values with untrimmed inputs.
- **Constraints.md convention**: Per `AGENTS.md`, any convention change must update `constraints.md`.

## Detailed Steps

### Step 1 — Reorder validation to check raw field length before trimming
In `src/config/config.ts`, in the new-format field-length validation loop (line ~228), remove the `.trim()` call so the length check operates on the raw value:

**Before:**
```typescript
const fieldValue = (entry[field] as string).trim();
if (fieldValue.length > maxLen) {
```

**After:**
```typescript
const fieldValue = entry[field] as string;
if (fieldValue.length > maxLen) {
```

The error message should report the raw length (which it now will, naturally). The trim-on-return block at line ~250 already handles normalization.

### Step 2 — Trim legacy-format `label` field
In `src/config/config.ts`, in the legacy-format entry construction (line ~295), change:

**Before:**
```typescript
result.push({
    id: candidateId,
    label: host,
    host: host.trim(),
    token: token.trim(),
});
```

**After:**
```typescript
result.push({
    id: candidateId,
    label: host.trim(),
    host: host.trim(),
    token: token.trim(),
});
```

### Step 3 — Update JSDoc on `parseGitCredentials()`
Update the JSDoc comment at `src/config/config.ts` line ~183 to remove the note that legacy `label` preserves the raw untrimmed key. It should state that all fields are trimmed in both formats.

### Step 4 — Update `constraints.md`
In `docs/agents/project-manifest/constraints.md` line 48, update the legacy-format trimming note to state that `label` is now trimmed alongside `host` and `token`.

### Step 5 — Add config test: length validation rejects padded value that would pass trimmed
In `src/tests/config.test.ts`, add a test near the existing length-validation tests (after line ~300) that verifies a value with whitespace padding that exceeds the raw limit is rejected even though its trimmed length would be within bounds:

```
test('loadConfig() rejects GitCredentialEntry field whose raw length exceeds limit even if trimmed value would be within limit')
```

Use a value like `'a'.repeat(MAX_CREDENTIAL_ID_LENGTH) + ' '` (raw = 101, trimmed = 100) and assert it throws.

### Step 6 — Add config test: legacy-format label is trimmed
In `src/tests/config.test.ts`, extend the existing legacy trimming test (line ~502) or add a new test verifying that legacy-format labels with whitespace are trimmed:

```
test('loadConfig() trims label in legacy-format entries')
```

Use a config with `{ '  github.com  ': 'ghp_token' }` and assert `entry.label === 'github.com'`.

### Step 7 — Add manager-level severity filter tests for `'audit'` and `'info'`
In `src/tests/error-log.manager.test.ts`, add two new tests in the severity filter section:

```
test('list filters by severity "audit"')
test('list filters by severity "info"')
```

Each test should: create a manager with a real temp dir, append entries with mixed severities including the target, call `list({ severity: 'audit' })` / `list({ severity: 'info' })`, and assert only matching entries are returned.

### Step 8 — Run full test suite and verify
Run `npm test` to confirm all 933+ existing tests still pass and the new tests pass.

## Dependencies
- None. All three changes are independent and can be implemented in any order.

## Required Components
- `src/config/config.ts` — `parseGitCredentials()` function (existing, modified)
- `src/tests/config.test.ts` — credential parsing tests (existing, extended)
- `src/error-log/error-log.manager.ts` — no code changes, test target only
- `src/tests/error-log.manager.test.ts` — severity filter tests (existing, extended)
- `docs/agents/project-manifest/constraints.md` — legacy label documentation (existing, updated)

## Assumptions
- The existing 933 server tests and 39 GUI tests represent the current green baseline.
- The `ErrorLogManager.list()` generic filter path handles `'audit'` and `'info'` correctly (the tests are confirming, not driving, this behavior).

## Constraints
- No new modules, abstractions, or dependencies.
- No changes to `ErrorSeverity` type or any public API surface.
- The error message format for length violations must remain consistent with the existing pattern (`gitCredentials[N].field must not exceed X characters (got Y)`).

## Out of Scope
- Deferred #3 (exporting `SEVERITY_OPTIONS`): No current consumer exists; speculative.
- Deferred #5 (shared `logCredentialSuccess()` helper): Only two call sites; extraction threshold not met.
- Deferred #6 (`setupFakeGitSuccess()` variant): No new orchestrator tests being added.
- Deferred #7 (`errorLogManager.list()` sort-order contract test): Adds coupling-awareness but no functional safety; the JSDoc comment from rework-2 is sufficient.
- Windows file-permission gap: Explicitly excluded per user direction across all plan cycles.

## Acceptance Criteria
1. `parseGitCredentials()` validates raw (untrimmed) field lengths before trimming — a value whose raw length exceeds the limit is rejected even if its trimmed length would be within bounds.
2. Legacy-format credential entries have their `label` field trimmed, consistent with `host` and `token`.
3. `constraints.md` accurately reflects that all three fields (`label`, `host`, `token`) are trimmed in legacy-format entries.
4. `parseGitCredentials()` JSDoc no longer states that legacy `label` preserves the raw untrimmed key.
5. `ErrorLogManager.list({ severity: 'audit' })` returns only `'audit'` entries when tested against real storage.
6. `ErrorLogManager.list({ severity: 'info' })` returns only `'info'` entries when tested against real storage.
7. All existing tests continue to pass (zero regressions).
8. At least one new config test demonstrates that raw-length validation rejects a padded-but-trimmed-within-bounds value.
9. At least one new config test verifies legacy-format label trimming.

## Testing Strategy
All changes are tested via the existing Node.js built-in test runner (`node --test`). No new test files are created — tests are added to existing test files following established patterns. The full suite is run at the end to confirm zero regressions.

## Test Plan

- `src/tests/config.test.ts` — **New test: raw-length rejection** — Asserts that a credential field with `'a'.repeat(limit) + ' '` (raw exceeds limit, trimmed equals limit) throws the expected error — covers AC 1, 8.
- `src/tests/config.test.ts` — **New test: legacy label trimming** — Asserts that a legacy-format entry with padded hostname key produces a trimmed `label` — covers AC 2, 9.
- `src/tests/config.test.ts` — **Existing test update check** — The existing test at line ~502 (`trims host and token in legacy-format entries`) may need its assertion expanded or a companion test added to verify `label` trimming — covers AC 2.
- `src/tests/error-log.manager.test.ts` — **New test: `list({ severity: 'audit' })`** — Appends entries with mixed severities including `'audit'`, filters, asserts only `'audit'` entries returned — covers AC 5.
- `src/tests/error-log.manager.test.ts` — **New test: `list({ severity: 'info' })`** — Same pattern as above for `'info'` — covers AC 6.

## Documentation Updates

- `docs/agents/project-manifest/constraints.md` line 48 — Update the legacy-format trimming note: replace "label is set to the raw, untrimmed key string" with a statement that `label` is now trimmed like `host` and `token`.
- `src/config/config.ts` — Update `parseGitCredentials()` JSDoc (line ~183) to remove the legacy-label-preserves-raw-key note.
- Re-run `ctx generate` after all code changes to regenerate `.context/` documents.

## Risks & Mitigations
| Risk | Mitigation |
|------|------------|
| **Raw-length check rejects inputs that previously passed** | Only affects values where `raw.length > limit` but `trimmed.length <= limit`. Given limits of 100–500 chars, this requires significant trailing/leading whitespace on an already near-limit value — extremely unlikely in real configs. The change aligns with the documented spec intent. |
| **Legacy label trim changes display values** | Only affects legacy-format configs where hostnames have leading/trailing whitespace. The label is used for display in the GUI credential list — trimmed values are strictly better for display. No functional logic depends on `label` matching the raw key. |
