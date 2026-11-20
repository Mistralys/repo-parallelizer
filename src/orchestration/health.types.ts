/**
 * Generic health-check issue and report shapes shared across every health
 * report producer in the orchestration layer (e.g. workspace health,
 * repository-info sync health). Keeping a single shape here avoids the GUI
 * health-alert component and the documentation diverging across multiple
 * near-identical per-domain types.
 */
export interface HealthIssue {
    type: string;
    severity: 'error' | 'warning';
    message: string;
    fixAction: string;
    repositoryId?: string;
}

export interface HealthReport {
    healthy: boolean;
    issues: HealthIssue[];
}
