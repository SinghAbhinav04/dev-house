#!/usr/bin/env node

/**
 * The office page's member grid, and the audit panel that holds Deploy.
 *
 * Found on the first real run, with the starter roster: the run paused at
 * "awaiting-audit-decision" and the page offered no way to answer, and below
 * the office scene there was one panel where there should have been seven.
 *
 * - The audit panel was shown only if a switch on the page was on. The
 *   orchestrator runs the audit whenever a member fills the auditor slot and
 *   had stopped reading the switch. So the panel is now due whenever the run
 *   says it is, and the page learns whether the audit will run from the
 *   roster, as the orchestrator does.
 * - The grid declared two rows. A fifth worker made a third, which took all
 *   the height. The grid now declares as many rows as its workers need.
 *
 * The rules are plain functions and are tested here; the page is read to
 * check it uses them and that the switch is gone.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(repoRoot, path), 'utf8');

const { auditPanelDue, officeGrid } = await import('../src/lib/office-grid.ts');

// ── When the audit panel is due ─────────────────────────────────────

const idle = { currentPhase: 'concept', pipelineStatus: 'idle', findingCount: 0 };

assert.ok(!auditPanelDue(idle), 'not before a run');
assert.ok(!auditPanelDue({ ...idle, currentPhase: 'testing', pipelineStatus: 'running' }), 'not while the tester is still at work');
assert.ok(auditPanelDue({ ...idle, currentPhase: 'security-audit', pipelineStatus: 'running' }), 'as soon as the audit starts');
assert.ok(
  auditPanelDue({ currentPhase: 'security-audit', pipelineStatus: 'awaiting-audit-decision', findingCount: 0 }),
  'while the run waits on the decision - a clean audit still needs its Deploy button'
);
assert.ok(
  auditPanelDue({ currentPhase: 'coding', pipelineStatus: 'awaiting-audit-decision', findingCount: 0 }),
  'the waiting status alone is enough, whatever phase is recorded'
);
assert.ok(
  auditPanelDue({ currentPhase: 'complete', pipelineStatus: 'complete', findingCount: 2 }),
  'and afterwards, for as long as there are findings to read'
);

// It takes exactly these three facts about the run and nothing about how the
// run was configured: that was the bug.
assert.equal(auditPanelDue.length, 1, 'one argument: the run state');
assert.ok(
  auditPanelDue({ currentPhase: 'security-audit', pipelineStatus: 'awaiting-audit-decision', findingCount: 0, runFinalAudit: false }),
  'a run recorded with the old switch off is still answered'
);

// ── The grid ────────────────────────────────────────────────────────

const rowsOf = (workers, audit = false) => officeGrid(workers, audit).rowCount;

assert.equal(rowsOf(4), 2, 'four workers: the two-by-two the page was drawn for');
assert.equal(rowsOf(5), 3, 'five workers (the starter roster before the audit): a third row, declared');
assert.equal(rowsOf(6), 3, 'six fill it');
assert.equal(rowsOf(7), 4, 'seven start a fourth');
assert.equal(rowsOf(0), 2, 'no workers: still two rows, so the supervisor panel keeps its shape');
assert.equal(rowsOf(1), 2, 'one worker likewise');

for (const workers of [0, 1, 4, 5, 9, 12]) {
  for (const audit of [false, true]) {
    const grid = officeGrid(workers, audit);
    assert.equal(grid.rows, `repeat(${grid.rowCount}, minmax(0, 1fr))`, 'every row is declared, and none can grow past its share');
    assert.ok(grid.rowCount * 2 >= workers, `${workers} workers fit in ${grid.rowCount} rows of two: none spills into a row of its own making`);
    assert.ok(!/(^|\s)1fr(\s|$)/.test(grid.columns), 'no bare 1fr column either: a long line must not widen one');
  }
}

const plain = officeGrid(4, false);
const audited = officeGrid(4, true);
assert.equal(plain.columns.split(/\s(?![^(]*\))/).length, 3, 'three columns without the audit panel');
assert.equal(audited.columns.split(/\s(?![^(]*\))/).length, 4, 'four with it');
assert.ok(plain.columns.startsWith('30% '), 'the supervisor has 30% on its own');
assert.ok(audited.columns.startsWith('25% ') && audited.columns.endsWith(' 25%'), 'and shares evenly with the audit panel');
assert.equal(audited.supervisorColumn, '1 / 2', 'the supervisor is pinned to the first column');
assert.equal(audited.auditColumn, '-2 / -1', 'the audit panel to the last, not wherever auto-placement puts it');

// ── The page uses them ──────────────────────────────────────────────

const page = read('src/app/page.tsx');
const panel = read('src/components/agents/SecurityAuditPanel.tsx');

assert.match(page, /import \{ auditPanelDue, officeGrid \} from '@\/lib\/office-grid'/, 'the page imports both');
assert.match(page, /const auditHasStarted = auditPanelDue\(\{/, 'the panel is shown by the run state');
assert.ok(!/auditHasStarted = !!\(\s*activeRunFinalAudit/.test(page), 'and no longer by a setting');
assert.ok(!page.includes('selectedRunFinalAudit'), 'the switch the orchestrator ignored is gone');
assert.match(page, /const auditStaffed = !!auditorId;/, 'whether the audit will run is read from the roster');
assert.equal(page.match(/runFinalAudit: auditStaffed,/g)?.length, 6, 'and that is what every request is told');
assert.match(page, /gridTemplateColumns: grid\.columns,\s*\n\s*gridTemplateRows: grid\.rows,/, 'the grid takes its tracks from officeGrid');
assert.ok(!page.includes("gridTemplateRows: '1fr 1fr'"), 'the fixed two rows are gone');
assert.match(page, /officeGrid\(panelWorkers\.length, /, 'sized by the panels actually drawn');
assert.match(page, /\{panelWorkers\.map\(/, 'which are the ones it then draws');
assert.match(page, /gridColumn: grid\.supervisorColumn/, 'the supervisor panel is pinned');
assert.match(page, /gridColumn=\{grid\.auditColumn\}/, 'and the audit panel is told its column');
assert.match(panel, /style=\{\{ gridRow: '1 \/ -1', gridColumn \}\}/, 'which it applies');

// The orchestrator still decides the audit from the roster. If that ever
// changes, the page's auditStaffed has to change with it.
const slots = read('src/lib/team/slots.ts');
assert.match(slots, /no auditor\s+→ the audit phase is skipped/, 'buildRunPlan: the audit follows the auditor slot');
const orchestrator = read('pipeline/orchestrator.ts');
assert.match(orchestrator, /if \(!runPlan\.phases\.audit\) return \{ paused: false \};/, 'and the orchestrator asks the run plan, nothing else');

console.log('office grid checks passed');
