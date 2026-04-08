/**
 * Timeout applied to `cloneRepository()` calls in orchestrators.
 * Generous default to accommodate large repositories on slow connections.
 * Extract to `AppConfig` in a future phase if user-configurability is needed.
 */
export const CLONE_TIMEOUT_MS = 120_000;

/**
 * Timeout applied to `fetchAndGetStatus()` calls in orchestrators.
 * Shorter than clone timeout because fetches are incremental.
 */
export const FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Orchestration result types
// ---------------------------------------------------------------------------

/**
 * Per-repository outcome of a clone operation performed by an orchestrator.
 */
export interface OrchestrationRepoResult {
    /** The repository ID this outcome pertains to. */
    repositoryId: string;

    /** True when the operation completed without error. */
    success: boolean;

    /** Human-readable error description when `success` is false. */
    error?: string;
}

/**
 * Aggregate result returned by orchestration operations that act on
 * multiple repositories (e.g. workspace creation, addRepositoryToProject).
 */
export interface OrchestrationResult {
    /** Per-repository outcomes, one entry per repository processed. */
    results: OrchestrationRepoResult[];
}

// ---------------------------------------------------------------------------
// Repository orchestration result types
// ---------------------------------------------------------------------------

/**
 * Per-workspace clone outcome produced by `RepositoryOrchestrator.addRepositoryToProject()`.
 */
export interface WorkspaceCloneResult {
    /** The workspace ID this outcome pertains to. */
    workspaceId: string;

    /** True when the clone operation completed without error. */
    success: boolean;

    /** Human-readable error description when `success` is false. */
    error?: string;
}

/**
 * Aggregate result returned by `RepositoryOrchestrator.addRepositoryToProject()`.
 */
export interface AddRepositoryResult {
    /** Per-workspace clone outcomes, one entry per workspace processed. */
    workspaceResults: WorkspaceCloneResult[];
}

// ---------------------------------------------------------------------------
// Branch switch result types
// ---------------------------------------------------------------------------

/**
 * Per-repository outcome of a branch-switch operation.
 */
export interface BranchSwitchRepoResult {
    /** True when the branch switch completed without error. */
    success: boolean;

    /** True when the operation encountered a merge conflict. */
    conflict: boolean;

    /** Human-readable error description when `success` is false. */
    error?: string;
}

/**
 * Aggregate result returned by `BranchOrchestrator.switchBranches()`.
 * Keyed by repository ID so callers can look up individual outcomes directly.
 */
export interface BranchSwitchResult {
    /**
     * Per-repository branch-switch outcomes, keyed by repository ID.
     * Every repository included in `branchAssignments` will have an entry here.
     */
    results: Record<string, BranchSwitchRepoResult>;
}
