import assert from 'node:assert/strict';

import {
  buildPlanningSelfReviewResumePrompt,
  buildPlanningWritePrompt,
  buildPlanningWriteResumePrompt,
  detectPlanningStep,
  extractPlanningResearchSummary,
  hasPlanningWriteStarted,
} from '../src/lib/pipeline-planning.ts';

assert.equal(detectPlanningStep([], { planExists: false, plannerId: 'pat' }), 'research');

assert.equal(
  detectPlanningStep(
    [{ agent: 'pat', phase: 'planning', type: 'text', text: 'Research is complete. Writing plan.md now.' }],
    { planExists: false, plannerId: 'pat' }
  ),
  'write'
);

assert.equal(detectPlanningStep([], { planExists: true, plannerId: 'pat' }), 'self-review');

assert.equal(
  detectPlanningStep(
    [{ agent: 'pat', phase: 'planning', type: 'status', text: 'Plan self-review complete' }],
    { planExists: true, plannerId: 'pat' }
  ),
  'done'
);

assert.match(buildPlanningWriteResumePrompt('/tmp/demo'), /Use the Write tool/i);
assert.match(buildPlanningSelfReviewResumePrompt('/tmp/demo'), /stalled during the self-review step/i);
assert.equal(
  hasPlanningWriteStarted([
    { agent: 'pat', phase: 'planning', type: 'status', text: 'Writing plan.md...' },
  ], 'pat'),
  true
);

const researchSummary = extractPlanningResearchSummary([
  { agent: 'pat', phase: 'planning', type: 'text', text: 'Short note' },
  { agent: 'pat', phase: 'planning', type: 'text', text: 'A'.repeat(220) },
  { agent: 'pat', phase: 'planning', type: 'status', text: 'Writing plan.md...' },
], 'pat');
assert.equal(researchSummary, 'A'.repeat(220));
assert.match(buildPlanningWritePrompt('/tmp/demo', 'Verified summary block'), /Verified summary block/);
assert.match(buildPlanningWriteResumePrompt('/tmp/demo', 'Verified summary block'), /Verified summary block/);

console.log('pipeline-planning checks passed');
