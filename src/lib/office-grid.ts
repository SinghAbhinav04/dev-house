/**
 * The member grid on the office page, and when the audit panel belongs in it.
 *
 * Both were written for the fixed team this app started with - a supervisor,
 * four workers A-D and an optional auditor E - and both broke with a roster
 * the user defines:
 *
 * - The Security Audit panel, which holds the only Deploy button, was shown
 *   only if a "Security Audit" switch on the page was on. The orchestrator
 *   stopped reading that switch when the roster arrived: the audit runs
 *   whenever a member fills the auditor slot (buildRunPlan in
 *   src/lib/team/slots.ts). With the starter roster and the switch at its
 *   default, a run paused for a decision the page never offered.
 * - The grid had exactly two rows. A fifth worker landed in a third row the
 *   grid did not declare; that row took the height of its content, and the
 *   two declared rows, sized `1fr`, were left with nothing. Every other
 *   panel, the supervisor's chat box included, collapsed to zero height.
 *
 * Plain functions with no imports, so the suite can run them.
 */

export type AuditRunState = {
  currentPhase: string;
  pipelineStatus: string;
  findingCount: number;
};

/**
 * Whether the Security Audit panel is due on screen.
 *
 * Decided by what the run has done, never by what it was configured to do:
 * if the run is auditing, is waiting on the audit decision, or has findings,
 * the panel that answers it has to be there.
 */
export function auditPanelDue(run: AuditRunState): boolean {
  return (
    run.currentPhase === 'security-audit' ||
    run.pipelineStatus === 'awaiting-audit-decision' ||
    run.findingCount > 0
  );
}

export type OfficeGrid = {
  /** grid-template-columns */
  columns: string;
  /** grid-template-rows */
  rows: string;
  /** How many worker rows there are; the supervisor and audit panels span them all. */
  rowCount: number;
  /** grid-column for the supervisor's panel. */
  supervisorColumn: string;
  /** grid-column for the audit panel. */
  auditColumn: string;
};

/**
 * Lay the grid out for however many worker panels there are.
 *
 * Workers fill the two centre columns, so they need half as many rows as
 * there are workers, and every row is declared: `minmax(0, 1fr)` shares the
 * height equally and lets a panel scroll inside its share instead of growing.
 *
 * The supervisor and the audit panel are pinned to the first and last column.
 * Left to auto-placement, the audit panel - which spans every row, and so is
 * placed before the workers - took the second column rather than the last.
 */
export function officeGrid(workerPanels: number, auditPanel: boolean): OfficeGrid {
  const rowCount = Math.max(2, Math.ceil(workerPanels / 2));
  const centre = 'minmax(0, 1fr) minmax(0, 1fr)';
  return {
    columns: auditPanel ? `25% ${centre} 25%` : `30% ${centre}`,
    rows: `repeat(${rowCount}, minmax(0, 1fr))`,
    rowCount,
    supervisorColumn: '1 / 2',
    auditColumn: '-2 / -1',
  };
}
