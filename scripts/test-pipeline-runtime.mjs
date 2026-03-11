import assert from 'node:assert/strict';

import {
  MAX_AUTO_RESUMES,
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

assert.equal(shouldMarkTurnStalled(0, TURN_IDLE_TIMEOUT_MS - 1), false);
assert.equal(shouldMarkTurnStalled(0, TURN_IDLE_TIMEOUT_MS), true);

assert.match(buildResumePrompt('planner', 'planning'), /Do not repeat research/i);
assert.match(buildResumePrompt('reviewer', 'plan-review'), /Output your verdict immediately/i);
assert.match(buildResumePrompt('auditor', 'security-audit'), /Output your verdict immediately/i);
assert.equal(MAX_AUTO_RESUMES, 3);

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
