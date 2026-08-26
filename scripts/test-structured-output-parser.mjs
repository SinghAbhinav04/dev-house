import assert from 'node:assert/strict';

import {
  UNPARSEABLE_STATUS,
  extractFirstJsonObject,
  extractStructuredSignal,
  isPositiveSignal,
  isUnparseableSignal,
  parseStructuredSignal,
  parseTextSignal,
} from '../src/lib/pipeline-signal.ts';

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

assert.equal(
  parseStructuredSignal({ result: { body: { status: 'approved' } } }),
  null,
  'does not descend into arbitrary nested values — a `status` the member merely quoted is not the run\'s verdict',
);

// ── The text fallback fails closed ───────────────────────────────────
//
// Every one of these used to come back as `{ status: 'approved' }`, which is
// how a killed auditor certified a build as clean.

assert.deepEqual(
  parseTextSignal(''),
  { status: UNPARSEABLE_STATUS },
  'an empty result — what a SIGTERMed turn produces — is not an approval',
);

assert.deepEqual(
  parseTextSignal('   \n  '),
  { status: UNPARSEABLE_STATUS },
  'nor is whitespace',
);

assert.deepEqual(
  parseTextSignal('This pattern is generally approved by OWASP, but see the findings below.'),
  { status: UNPARSEABLE_STATUS },
  'prose containing the word "approved" is not an approval',
);

assert.deepEqual(
  parseTextSignal('All tests passed except the two below.'),
  { status: UNPARSEABLE_STATUS },
  'nor is prose containing "tests passed"',
);

assert.deepEqual(
  parseTextSignal('null'),
  { status: UNPARSEABLE_STATUS },
  'valid JSON that is not an object does not crash the gate',
);

assert.deepEqual(
  parseTextSignal('"approved"'),
  { status: UNPARSEABLE_STATUS },
  'a bare JSON string is not a signal record',
);

assert.deepEqual(
  parseTextSignal('{"status":"approved"}'),
  { status: 'approved' },
  'a real verdict still parses',
);

assert.deepEqual(
  parseTextSignal('Here is my verdict:\n{"status":"issues","issues":["missing validation"]}\nThanks.'),
  { status: 'issues', issues: ['missing validation'] },
  'a verdict embedded in prose still parses',
);

assert.deepEqual(
  parseTextSignal('{"status":"issues","issues":["the handler returns } on empty body"]}'),
  { status: 'issues', issues: ['the handler returns } on empty body'] },
  'a brace inside a string value does not truncate the slice',
);

assert.equal(
  extractFirstJsonObject('no object here'),
  null,
  'text with no object yields nothing rather than a bad slice',
);

// ── Verdict classification ───────────────────────────────────────────

assert.equal(isPositiveSignal({ status: 'approved' }), true);
assert.equal(isPositiveSignal({ status: 'passed' }), true);
assert.equal(isPositiveSignal({ status: 'PASSED' }), true, 'case does not change a verdict');
assert.equal(isPositiveSignal({ status: 'issues' }), false);
assert.equal(isPositiveSignal({ status: UNPARSEABLE_STATUS }), false, 'unreadable is never a pass');
assert.equal(isPositiveSignal(null), false, 'null does not throw reading .status');
assert.equal(isPositiveSignal('approved'), false, 'a bare string is not a verdict record');

assert.equal(isUnparseableSignal(null), true);
assert.equal(isUnparseableSignal({ status: UNPARSEABLE_STATUS }), true);
assert.equal(isUnparseableSignal({ status: 'issues' }), false, 'a real rejection is readable, not unparseable');

console.log('Structured output parser checks passed');
