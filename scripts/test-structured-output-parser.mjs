import assert from 'node:assert/strict';

import { extractStructuredSignal, parseStructuredSignal } from '../src/lib/pipeline-signal.ts';

assert.deepEqual(
  parseStructuredSignal({ status: 'approved' }),
  { status: 'approved' },
  'parses direct signal objects'
);

assert.deepEqual(
  parseStructuredSignal('{"status":"passed","failures":[]}'),
  { status: 'passed', failures: [] },
  'parses JSON strings'
);

assert.deepEqual(
  parseStructuredSignal([{ type: 'text', text: '{"status":"approved"}' }]),
  { status: 'approved' },
  'parses text content blocks'
);

assert.deepEqual(
  parseStructuredSignal({ input: { status: 'approved', questions: [] } }),
  { status: 'approved', questions: [] },
  'parses tool-wrapper input payloads'
);

assert.deepEqual(
  extractStructuredSignal(undefined, { status: 'approved' }),
  { status: 'approved' },
  'prefers result-level structured_output payloads'
);

assert.deepEqual(
  extractStructuredSignal(undefined, '{"status":"approved","issues":[]}'),
  { status: 'approved', issues: [] },
  'falls back to result text when it is valid JSON'
);

assert.equal(
  parseStructuredSignal('Plan approved'),
  null,
  'ignores non-JSON plain text'
);

console.log('Structured output parser checks passed');
