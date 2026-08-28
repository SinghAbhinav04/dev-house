import assert from 'node:assert/strict';

import { createClaudeDecoder, describeToolCall } from '../src/lib/cli/decoder.ts';

/** Feed a whole stream and collect everything it decoded, in order. */
function run(lines) {
  const decoder = createClaudeDecoder();
  const events = [];
  for (const line of lines) events.push(...decoder.push(line));
  events.push(...decoder.finish());
  return events;
}

const json = (value) => JSON.stringify(value);

const assistantWith = (...blocks) => json({ type: 'assistant', message: { content: blocks } });
const userWith = (...blocks) => json({ type: 'user', message: { content: blocks } });

// ── Noise is skipped, not fatal ──────────────────────────────────────
//
// The CLI is free to write anything to stdout. A decoder that threw on a
// non-JSON line would take the run down with it.

assert.deepEqual(run(['']), [], 'blank lines decode to nothing');
assert.deepEqual(run(['   ']), [], 'whitespace too');
assert.deepEqual(run(['Loading plugins...']), [], 'plain diagnostics are not events');
assert.deepEqual(run(['{"broken":']), [], 'a truncated line is skipped rather than thrown');
assert.deepEqual(run(['[1,2,3]']), [], 'valid JSON that is not an event object is ignored');
assert.deepEqual(run(['null']), [], 'and null does not crash the null check');

// ── Session capture ──────────────────────────────────────────────────

assert.deepEqual(
  run([json({ type: 'system', session_id: 'sess-1' })]),
  [{ kind: 'session', sessionId: 'sess-1' }],
);
assert.deepEqual(
  run([json({ type: 'system' })]),
  [],
  'a system event with no session id says nothing',
);

// ── Text and tool calls ──────────────────────────────────────────────

assert.deepEqual(
  run([assistantWith({ type: 'text', text: '  hello  ' })]),
  [{ kind: 'text', text: 'hello' }],
  'text is trimmed',
);
assert.deepEqual(
  run([assistantWith({ type: 'text', text: '   ' })]),
  [],
  'whitespace-only text is not an event',
);

const [readCall] = run([
  assistantWith({ type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: '/a/b/plan.md' } }),
]);
assert.equal(readCall.kind, 'tool_call');
assert.equal(readCall.tool, 'Read');
assert.equal(readCall.callId, 'c1');
assert.equal(readCall.description, 'READ plan.md', 'the description is the basename, not the full path');
assert.equal(readCall.detail, '/a/b/plan.md');

assert.deepEqual(
  run([assistantWith({ type: 'tool_use', id: 'c1', name: 'Bash', input: {} })])[0].description,
  'Bash',
  'a call with nothing to describe falls back to the bare tool name',
);

// ── Results are correlated back to their call ────────────────────────
//
// This is the whole reason the decoder is stateful: a tool_result names only
// the id of the call it answers, so the tool is only knowable by having
// watched the call go past. Three copies of this map used to exist.

const correlated = run([
  assistantWith({ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'npm test' } }),
  userWith({ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }),
]);
assert.equal(correlated[1].kind, 'tool_result');
assert.equal(correlated[1].tool, 'Bash', 'the result knows which tool it came from');
assert.equal(correlated[1].isError, false);

const orphan = run([userWith({ type: 'tool_result', tool_use_id: 'never-seen', content: 'x' })]);
assert.equal(orphan[0].tool, '', 'a result for a call we never saw reports no tool rather than guessing');
assert.equal(orphan[0].summary, '', 'and is not summarised as though it were one');

// Each decoder is single-use — correlation must not leak between spawns.
const first = createClaudeDecoder();
first.push(assistantWith({ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'x' } }));
const second = createClaudeDecoder();
assert.equal(
  second.push(userWith({ type: 'tool_result', tool_use_id: 'c1', content: 'x' }))[0].tool,
  '',
  'a fresh decoder does not inherit another spawn\'s call ids',
);

// ── Errors ───────────────────────────────────────────────────────────

const errored = run([
  assistantWith({ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'rm -rf /' } }),
  userWith({ type: 'tool_result', tool_use_id: 'c1', is_error: true, content: 'BLOCKED: nope' }),
]);
assert.equal(errored[1].isError, true);
assert.equal(errored[1].errorText, 'BLOCKED: nope');
assert.equal(errored[1].summary, '', 'a failed call is not summarised as a successful one');

const objectError = run([
  assistantWith({ type: 'tool_use', id: 'c1', name: 'Bash', input: {} }),
  userWith({ type: 'tool_result', tool_use_id: 'c1', is_error: true, content: { reason: 'nope' } }),
]);
assert.equal(
  objectError[1].errorText,
  '{"reason":"nope"}',
  'a non-string error is stringified rather than becoming [object Object]',
);

// ── The verdict channel ──────────────────────────────────────────────

const structured = run([
  assistantWith({ type: 'tool_use', id: 'c1', name: 'StructuredOutput', input: {} }),
  userWith({ type: 'tool_result', tool_use_id: 'c1', content: json({ status: 'approved' }) }),
]);
assert.ok(
  structured.some((e) => e.kind === 'structured' && e.value.status === 'approved'),
  'a StructuredOutput result yields the verdict',
);
assert.ok(
  !structured.some((e) => e.kind === 'tool_result' && e.summary),
  'and is not also echoed into the log as a tool result',
);

const failedStructured = run([
  assistantWith({ type: 'tool_use', id: 'c1', name: 'StructuredOutput', input: {} }),
  userWith({ type: 'tool_result', tool_use_id: 'c1', is_error: true, content: json({ status: 'approved' }) }),
]);
assert.ok(
  !failedStructured.some((e) => e.kind === 'structured'),
  'a FAILED StructuredOutput call carries an error, not a verdict — trusting it would approve on a broken turn',
);

// ── The terminal event ───────────────────────────────────────────────

const [result] = run([
  json({
    type: 'result',
    result: 'all done',
    session_id: 'sess-9',
    usage: { input_tokens: 10, output_tokens: 5 },
    total_cost_usd: 0.01,
  }),
]);
assert.equal(result.kind, 'result');
assert.equal(result.text, 'all done');
assert.equal(result.sessionId, 'sess-9');
assert.equal(result.raw.total_cost_usd, 0.01, 'the raw event survives for usage extraction');

const noSessionOnResult = run([
  json({ type: 'system', session_id: 'sess-earlier' }),
  json({ type: 'result', result: 'done' }),
]);
assert.equal(
  noSessionOnResult[1].sessionId,
  'sess-earlier',
  'a result without its own session id falls back to the one already seen',
);

const denied = run([
  json({
    type: 'result',
    result: '',
    permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'npm i' } }],
  }),
]);
assert.deepEqual(
  denied[0].denials,
  [{ toolName: 'Bash', toolInput: { command: 'npm i' } }],
  'denials are normalised for the strict-mode approval flow',
);
assert.deepEqual(
  run([json({ type: 'result', permission_denials: 'not-an-array' })])[0].denials,
  [],
  'a malformed denials field degrades to none rather than throwing',
);

// ── Descriptions, keyed on the canonical tool name ───────────────────

assert.equal(describeToolCall('Grep', { pattern: 'TODO' }).description, 'GREP TODO');
assert.equal(describeToolCall('Glob', { pattern: '*.ts' }).description, 'GLOB *.ts');
assert.equal(describeToolCall('WebSearch', { query: 'opencode cli' }).description, 'SEARCH opencode cli');
assert.equal(describeToolCall('WebFetch', { url: 'https://x.dev' }).description, 'FETCH https://x.dev');
assert.equal(describeToolCall('Unknown', {}).description, 'Unknown', 'an unmapped tool still reads as itself');

const write = describeToolCall('Write', { file_path: '/p/a.ts', content: 'x'.repeat(900) });
assert.match(write.detail, /content \(1 lines\)/);
assert.ok(write.detail.endsWith('\n...'), 'a long body is truncated with a marker, not silently cut');

const edit = describeToolCall('Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' });
assert.match(edit.detail, /- a\n\+ b/, 'an edit shows both sides');

assert.equal(
  describeToolCall('Read', { file_path: 42 }).description,
  'Read',
  'a non-string path does not become "READ undefined"',
);

console.log('cli decoder checks passed');
