import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderWorkspaceReadme, renderWorkspaceAgents, type WorkspaceIndexContext } from '../orchestration/workspace-index.js';
import { CONTEXT_A, CONTEXT_B, CONTEXT_C, CONTEXT_A_TWO, CONTEXT_B_TWO, CONTEXT_C_TWO } from './fixtures/workspace-index-contexts.js';
import * as postB from './fixtures/workspace-index-postB.js';
import { BASELINE_README_A, BASELINE_README_B, BASELINE_README_C } from './fixtures/workspace-index-baseline.js';

// T-01: README output is byte-identical to the captured baseline.
test('baseline README unchanged', () => {
    assert.strictEqual(renderWorkspaceReadme(CONTEXT_A), BASELINE_README_A);
    assert.strictEqual(renderWorkspaceReadme(CONTEXT_B), BASELINE_README_B);
    assert.strictEqual(renderWorkspaceReadme(CONTEXT_C), BASELINE_README_C);
});

// T-02: the sibling workspaces never reach the README.
test('baseline README unchanged for two-workspace contexts', () => {
    assert.strictEqual(renderWorkspaceReadme(CONTEXT_A_TWO), BASELINE_README_A);
    assert.strictEqual(renderWorkspaceReadme(CONTEXT_B_TWO), BASELINE_README_B);
    assert.strictEqual(renderWorkspaceReadme(CONTEXT_C_TWO), BASELINE_README_C);
});

// T-27: undefined, [] and {} for the new fields leave the output byte-identical to the post-B golden.
const EMPTY_VARIANTS: Array<Partial<WorkspaceIndexContext>> = [
    {},
    { projectDirectives: [], workspaceDirectives: [] },
];

test('post-B golden unchanged with undefined / empty directives and no roles', () => {
    const cases: Array<[WorkspaceIndexContext, string, string]> = [
        [CONTEXT_A, postB.POSTB_README_A, postB.POSTB_AGENTS_A],
        [CONTEXT_B, postB.POSTB_README_B, postB.POSTB_AGENTS_B],
        [CONTEXT_C, postB.POSTB_README_C, postB.POSTB_AGENTS_C],
        [CONTEXT_A_TWO, postB.POSTB_README_A_TWO, postB.POSTB_AGENTS_A_TWO],
        [CONTEXT_B_TWO, postB.POSTB_README_B_TWO, postB.POSTB_AGENTS_B_TWO],
        [CONTEXT_C_TWO, postB.POSTB_README_C_TWO, postB.POSTB_AGENTS_C_TWO],
    ];
    for (const [base, readme, agents] of cases) {
        for (const variant of EMPTY_VARIANTS) {
            const ctx: WorkspaceIndexContext = {
                ...base,
                ...variant,
                repositories: base.repositories.map((repo) => ({ ...repo, role: variant.projectDirectives ? '' : undefined })),
            };
            assert.strictEqual(renderWorkspaceReadme(ctx), readme);
            assert.strictEqual(renderWorkspaceAgents(ctx), agents);
        }
    }
});
