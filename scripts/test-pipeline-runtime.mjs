import assert from 'node:assert/strict';

import {
  MAX_AUTO_RESUMES,
  MAX_BASH_APPROVAL_RETRIES,
  MAX_CODE_REVIEW_ROUNDS,
  MAX_REVIEW_ROUNDS,
  MAX_TEST_ROUNDS,
  TURN_IDLE_TIMEOUT_MS,
  buildResumePrompt,
  describeCurrentTask,
  normalizeRuntime,
  canAutoResumeTurn,
  shouldMarkTurnStalled,
  summarizePrompt,
} from '../src/lib/pipeline-runtime.ts';

assert.equal(summarizePrompt('short prompt'), 'short prompt');
assert.equal(
  summarizePrompt('This is a deliberately long prompt that should be trimmed down for runtime display in the dashboard.', 40),
  'This is a deliberately long prompt th...'
);

assert.equal(canAutoResumeTurn('planner', 'planning'), true);
assert.equal(canAutoResumeTurn('planner', 'plan-review'), true);
assert.equal(canAutoResumeTurn('reviewer', 'plan-review'), true);
assert.equal(canAutoResumeTurn('coder', 'coding'), false);
assert.equal(canAutoResumeTurn('auditor', 'security-audit'), true);
assert.equal(canAutoResumeTurn('auditor', 'planning'), false);

// This takes a SLOT, never a member id. The orchestrator's stall watcher used
// to pass `member.id` — a user-authored slug that matches no slot name — so
// the answer was always false, and the watcher's non-resumable branch then
// abandoned the turn without resolving it or killing the child. A wedged
// session hung the whole run with no timeout behind it.
assert.equal(
  canAutoResumeTurn('reacty', 'plan-review'),
  false,
  'a member id is not a slot, so passing one silently disables auto-resume',
);
assert.equal(
  canAutoResumeTurn('pat', 'planning'),
  false,
  'the same trap for the planner slot',
);

assert.equal(shouldMarkTurnStalled(0, TURN_IDLE_TIMEOUT_MS - 1), false);
assert.equal(shouldMarkTurnStalled(0, TURN_IDLE_TIMEOUT_MS), true);

assert.match(buildResumePrompt('planner', 'planning'), /Do not repeat research/i);
assert.match(buildResumePrompt('reviewer', 'plan-review'), /Output your verdict immediately/i);
assert.match(buildResumePrompt('auditor', 'security-audit'), /Output your verdict immediately/i);
assert.equal(MAX_AUTO_RESUMES, 3);

// ── Loop budgets ─────────────────────────────────────────────────────
//
// Plan review, code review and testing are `while (!approved)` loops. They ran
// with no cap, no wall clock and no no-progress detector, so a reviewer and a
// planner that could not agree burned two full turns per round forever. The
// only things that ever ended a divergent loop were accidents: an unparseable
// verdict being read as approval, or the user hitting Stop.
for (const [name, cap] of [
  ['MAX_REVIEW_ROUNDS', MAX_REVIEW_ROUNDS],
  ['MAX_CODE_REVIEW_ROUNDS', MAX_CODE_REVIEW_ROUNDS],
  ['MAX_TEST_ROUNDS', MAX_TEST_ROUNDS],
  ['MAX_BASH_APPROVAL_RETRIES', MAX_BASH_APPROVAL_RETRIES],
]) {
  assert.equal(typeof cap, 'number', `${name} is defined`);
  assert.ok(cap > 0 && Number.isFinite(cap), `${name} is a real bound, not Infinity`);
}

// ── What each member is working on ───────────────────────────────────

assert.equal(describeCurrentTask('planner', 'planning'), 'Researching and writing the build plan');
assert.equal(describeCurrentTask('reviewer', 'plan-review'), 'Poking holes in the plan');
assert.equal(
  describeCurrentTask('planner', 'plan-review'),
  'Answering review questions',
  'the same phase reads differently depending on the slot',
);
assert.equal(describeCurrentTask('tester', 'testing'), 'Running the build and testing it');
assert.equal(describeCurrentTask('coder', 'testing'), 'Fixing failing tests');
assert.match(describeCurrentTask('coder', 'some-new-phase'), /some-new-phase/, 'an unknown phase still says something');

// ── Runtime migration ────────────────────────────────────────────────

const fresh = normalizeRuntime(null);
assert.equal(fresh.activeTurn, null);
assert.deepEqual(fresh.activeTurns, {});

const legacyTurn = {
  agent: 'reacty',
  phase: 'coding',
  status: 'running',
  startedAt: 't',
  lastEventAt: 't',
  sessionId: 's',
  promptSummary: 'p',
  currentTask: '',
  autoResumeCount: 0,
};

const migrated = normalizeRuntime({ activeTurn: legacyTurn });
assert.equal(migrated.activeTurn.agent, 'reacty');
assert.deepEqual(
  Object.keys(migrated.activeTurns),
  ['reacty'],
  'an old state file with only a cursor seeds the per-member map, so the team view is not blank',
);

const modern = normalizeRuntime({ activeTurn: null, activeTurns: { pat: legacyTurn } });
assert.equal(modern.activeTurn, null);
assert.equal(modern.activeTurns.pat.agent, 'reacty', 'an explicit map is preserved as-is');

assert.deepEqual(normalizeRuntime({ activeTurn: null }).activeTurns, {}, 'no cursor means nothing to seed from');

console.log('pipeline-runtime checks passed');
