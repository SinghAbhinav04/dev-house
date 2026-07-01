#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempHome = mkdtempSync(join(tmpdir(), 'hackeroom-slots-'));
process.env.HACKEROOM_HOME = tempHome;

const { normalizeRoster } = await import('../src/lib/team/roster.ts');
const { artifactOwners, activeMembers, buildRunPlan, describeRunPlan, extraMembersFor, resolveSlot } = await import(
  '../src/lib/team/slots.ts'
);
const { buildTeamManifest } = await import('../src/lib/team/manifest.ts');

/** Build a roster from a compact {slot: memberId | memberId[]} description. */
function rosterOf(assignments, overrides = {}) {
  const members = [];
  for (const [slot, value] of Object.entries(assignments)) {
    for (const id of Array.isArray(value) ? value : [value]) {
      members.push({ id, name: id, slot, ...(overrides.members?.[id] ?? {}) });
    }
  }
  return normalizeRoster({ members, workflow: overrides.workflow });
}

const full = {
  planner: 'pat',
  reviewer: 'rex',
  coder: 'reacty',
  tester: 'tess',
  auditor: 'aud',
  supervisor: 'sam',
};

// ── resolveSlot ──────────────────────────────────────────────────────

const complete = rosterOf(full);
assert.equal(resolveSlot(complete, 'coder').id, 'reacty');
assert.equal(resolveSlot(complete, 'auditor').id, 'aud');
assert.equal(resolveSlot(rosterOf({ coder: 'reacty' }), 'tester'), null, 'an unassigned slot resolves to null');

const disabledSlot = rosterOf(full, { workflow: { slots: { tester: { enabled: false } } } });
assert.equal(resolveSlot(disabledSlot, 'tester'), null, 'a disabled slot resolves to null even when assigned');
assert.equal(resolveSlot(disabledSlot, 'coder').id, 'reacty', 'disabling one slot leaves the others alone');

const disabledMember = rosterOf(full, { members: { tess: { enabled: false } } });
assert.equal(resolveSlot(disabledMember, 'tester'), null, 'a disabled member does not fill its slot');

// ── Multi-fill ───────────────────────────────────────────────────────

const twoCoders = rosterOf({ ...full, coder: ['reacty', 'apiguy'] });
assert.equal(resolveSlot(twoCoders, 'coder').id, 'reacty', 'the first eligible member runs');
assert.deepEqual(
  extraMembersFor(twoCoders, 'coder').map((m) => m.id),
  ['apiguy'],
  'the rest are reported as ignored'
);
assert.ok(
  buildRunPlan(twoCoders).notes.some((n) => n.includes('apiguy')),
  'the run plan warns about ignored assignments rather than silently dropping them'
);

// ── activeMembers ────────────────────────────────────────────────────

assert.deepEqual(
  activeMembers(complete).map((m) => m.id).sort(),
  ['aud', 'pat', 'reacty', 'rex', 'sam', 'tess'],
  'every filled slot contributes a member'
);

// ── Artifact ownership ───────────────────────────────────────────────

assert.deepEqual(artifactOwners(complete), { 'plan.md': 'pat' }, 'the planner owns plan.md');
assert.deepEqual(artifactOwners(rosterOf({ coder: 'reacty' })), {}, 'no planner means no owned artifact');

// ── Run plan: the happy path ─────────────────────────────────────────

const fullPlan = buildRunPlan(complete);
assert.equal(fullPlan.ok, true);
assert.deepEqual(fullPlan.errors, []);
assert.deepEqual(fullPlan.phases, {
  planning: true,
  planReview: true,
  coding: true,
  codeReview: true,
  testing: true,
  audit: true,
  deploy: true,
});
assert.equal(fullPlan.runGoal, 'full-build');
assert.match(describeRunPlan(fullPlan), /Coder: reacty/);

// ── Run plan: no planner is fatal ────────────────────────────────────

const noPlanner = buildRunPlan(rosterOf({ coder: 'reacty', tester: 'tess' }));
assert.equal(noPlanner.ok, false, 'a run without a planner cannot start');
assert.match(noPlanner.errors[0], /planner/i);
assert.equal(noPlanner.phases.planning, false);

// ── Run plan: no tester skips both review and testing ────────────────
// This is the "frontend job, skip the tester" case.

const noTester = buildRunPlan(rosterOf({ planner: 'pat', reviewer: 'rex', coder: 'reacty' }));
assert.equal(noTester.ok, true);
assert.equal(noTester.phases.codeReview, false, 'code review belongs to the tester and is skipped');
assert.equal(noTester.phases.testing, false, 'testing is skipped');
assert.equal(noTester.phases.coding, true, 'coding still runs');
assert.equal(noTester.phases.deploy, true, 'deploy still runs');
assert.ok(noTester.notes.some((n) => /tester/i.test(n)), 'the skip is reported');

// Disabling the tester slot must behave identically to having no tester.
const testerOff = buildRunPlan(rosterOf(full, { workflow: { slots: { tester: { enabled: false } } } }));
assert.equal(testerOff.phases.codeReview, false);
assert.equal(testerOff.phases.testing, false);

// ── Run plan: no reviewer locks the plan immediately ─────────────────

const noReviewer = buildRunPlan(rosterOf({ planner: 'pat', coder: 'reacty', tester: 'tess' }));
assert.equal(noReviewer.ok, true);
assert.equal(noReviewer.phases.planning, true);
assert.equal(noReviewer.phases.planReview, false, 'with no reviewer there is no external approval gate');
assert.equal(noReviewer.phases.coding, true, 'the run proceeds straight to coding');
assert.ok(noReviewer.notes.some((n) => /reviewer/i.test(n)));

// ── Run plan: no coder forces plan-only ──────────────────────────────

const noCoder = buildRunPlan(rosterOf({ planner: 'pat', reviewer: 'rex', tester: 'tess' }));
assert.equal(noCoder.runGoal, 'plan-only', 'a full-build with nobody to code is downgraded');
assert.equal(noCoder.phases.coding, false);
assert.equal(noCoder.phases.testing, false, 'testing has nothing to test');
assert.equal(noCoder.phases.deploy, false);
assert.equal(noCoder.phases.planReview, true, 'planning and review still run');

// ── Run plan: plan-only stops after review ───────────────────────────

const planOnly = buildRunPlan(rosterOf(full, { workflow: { runGoal: 'plan-only' } }));
assert.equal(planOnly.runGoal, 'plan-only');
assert.equal(planOnly.phases.planReview, true);
assert.equal(planOnly.phases.coding, false);
assert.equal(planOnly.phases.audit, false);

// ── Run plan: no auditor skips the audit ─────────────────────────────

const noAuditor = buildRunPlan(rosterOf({ planner: 'pat', reviewer: 'rex', coder: 'reacty', tester: 'tess' }));
assert.equal(noAuditor.phases.audit, false, 'the audit phase is opt-in via an assigned auditor');
assert.equal(noAuditor.phases.deploy, true);

// ── Manifest generation ──────────────────────────────────────────────

const manifest = buildTeamManifest(complete);
assert.equal(manifest.version, 1);
assert.deepEqual(manifest.artifacts, { 'plan.md': 'pat' });
assert.deepEqual(Object.keys(manifest.members).sort(), ['aud', 'pat', 'reacty', 'rex', 'sam', 'tess']);

assert.equal(manifest.members.pat.write, 'artifact', 'the planner writes only its artifact');
assert.deepEqual(manifest.members.pat.denyPhases, ['concept'], 'the planner cannot write before the concept is captured');
assert.equal(manifest.members.rex.write, 'none', 'the reviewer is read-only');
assert.equal(manifest.members.rex.bash, 'none');
assert.equal(manifest.members.reacty.write, 'project');
assert.equal(manifest.members.aud.web, false, 'the auditor has no egress');
assert.equal(manifest.members.sam.write, 'builds', 'only the supervisor roams ~/Builds');

// An unslotted member still needs an entry or the hook would deny it everything.
const withHelper = normalizeRoster({
  members: [
    { id: 'pat', name: 'pat', slot: 'planner' },
    { id: 'helper', name: 'helper', slot: null },
  ],
});
assert.ok(buildTeamManifest(withHelper).members.helper, 'unslotted members appear in the manifest');
assert.equal(buildTeamManifest(withHelper).members.helper.write, 'none', 'and default to read-only');

// A disabled member must not appear at all.
const withDisabled = normalizeRoster({
  members: [
    { id: 'pat', name: 'pat', slot: 'planner' },
    { id: 'gone', name: 'gone', slot: null, enabled: false },
  ],
});
assert.equal(buildTeamManifest(withDisabled).members.gone, undefined, 'disabled members are absent, so the hook denies them');

rmSync(tempHome, { recursive: true, force: true });

console.log('slot checks passed');
