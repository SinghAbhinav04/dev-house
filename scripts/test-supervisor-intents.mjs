import assert from 'node:assert/strict';

import { parseSupervisorIntent } from '../src/lib/supervisor-intents.ts';

assert.deepEqual(parseSupervisorIntent('start planning'), {
  action: 'start-run',
  runGoal: 'plan-only',
});

assert.deepEqual(parseSupervisorIntent('Kick off the planner for a snake game'), {
  action: 'start-run',
  runGoal: 'plan-only',
  concept: 'a snake game',
});

assert.deepEqual(parseSupervisorIntent('start strict full build for a todo app'), {
  action: 'start-run',
  runGoal: 'full-build',
  securityMode: 'strict',
  concept: 'a todo app',
});

assert.deepEqual(parseSupervisorIntent('stop after review'), {
  action: 'set-stop-after-review',
  enabled: true,
});

assert.deepEqual(parseSupervisorIntent('keep running after review'), {
  action: 'set-stop-after-review',
  enabled: false,
});

assert.deepEqual(parseSupervisorIntent('continue build'), {
  action: 'resume-run',
});

assert.deepEqual(parseSupervisorIntent('resume the stalled planner'), {
  action: 'resume-run',
});

assert.deepEqual(parseSupervisorIntent('stop'), {
  action: 'stop-run',
});

assert.equal(parseSupervisorIntent('What should we do next?'), null);
assert.equal(parseSupervisorIntent('I want to build a snake game'), null);

console.log('supervisor intent checks passed');
