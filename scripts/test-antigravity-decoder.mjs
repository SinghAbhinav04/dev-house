import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { createAntigravityDecoder } from '../src/lib/cli/antigravity-decoder.ts';
import {
  ANTIGRAVITY_ARG_SENSITIVE_TOOLS,
  ANTIGRAVITY_TOOLS,
  isMappedAntigravityTool,
  toCanonicalArgs,
} from '../src/lib/cli/antigravity-tools.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Decode a whole stream, exactly as a caller would. */
function decodeAll(lines) {
  const decoder = createAntigravityDecoder();
  const events = [];
  for (const line of lines) events.push(...decoder.push(line));
  events.push(...decoder.finish());
  return events;
}

const json = (value) => JSON.stringify(value);

// ── Against the real captured stream ─────────────────────────────────
//
// Not a stream someone imagined: this is what agy 1.1.22 actually emitted,
// frozen by scripts/probe-antigravity.mjs. If a later version changes shape,
// re-run the probe and these fail rather than the gate silently misreading.

const captured = readFileSync(join(fixtures, 'antigravity-stream.ndjson'), 'utf8')
  .split('\n')
  .filter((line) => line.trim());

const decoded = decodeAll(captured);
const kinds = decoded.map((e) => e.kind);

assert.ok(captured.length > 10, 'the fixture has a real turn in it');
assert.equal(kinds[0], 'session', 'the conversation id is the first thing out');
assert.equal(decoded[0].sessionId.length > 0, true);
assert.ok(kinds.includes('tools'), 'init.tools is surfaced');
assert.ok(kinds.includes('tool_call'), 'tool calls are decoded');
assert.ok(kinds.includes('tool_result'), 'so are their results');
assert.ok(kinds.includes('usage'), 'usage arrives during the turn, not only at the end');
assert.equal(kinds[kinds.length - 1], 'result', 'the terminal event is last');

const toolsEvent = decoded.find((e) => e.kind === 'tools');
assert.ok(toolsEvent.tools.length > 40, 'agy reports dozens of tools, not the handful the docs list');
assert.ok(toolsEvent.tools.includes('run_command'));
assert.ok(toolsEvent.tools.includes('invoke_subagent'));

// Calls come before their results, which is what the caller's bookkeeping
// (bashInFlight, the approval input map) depends on.
const firstCall = kinds.indexOf('tool_call');
const firstResult = kinds.indexOf('tool_result');
assert.ok(firstCall < firstResult, 'a call is announced before its result');

// Every result correlates back to a call, without any tool_use_id existing.
const callIds = new Set(decoded.filter((e) => e.kind === 'tool_call').map((e) => e.callId));
for (const result of decoded.filter((e) => e.kind === 'tool_result')) {
  assert.ok(callIds.has(result.callId), `result ${result.callId} matches a call`);
  assert.ok(result.tool, 'and knows which tool it was');
}

// One announcement per call, however many updates that call produced.
const callsById = decoded.filter((e) => e.kind === 'tool_call').map((e) => e.callId);
assert.equal(new Set(callsById).size, callsById.length, 'a call is announced once, not once per update');

// ── Names and arguments, as observed ─────────────────────────────────

const byTool = new Map(decoded.filter((e) => e.kind === 'tool_call').map((e) => [e.tool, e]));

assert.ok(byTool.has('Read'), 'view_file reads as Read');
assert.ok(byTool.has('Glob'), 'list_dir reads as Glob');
assert.ok(byTool.has('Grep'), 'grep_search reads as Grep');
assert.ok(byTool.has('Write'), 'write_to_file reads as Write');

assert.match(byTool.get('Read').input.file_path, /notes\.txt$/, 'AbsolutePath becomes file_path');
assert.match(byTool.get('Write').input.file_path, /probe-output\.txt$/, 'TargetFile becomes file_path too');
assert.equal(byTool.get('Grep').input.pattern, 'interesting', 'Query becomes pattern');

// The descriptions the office and the terminal pane show.
assert.match(byTool.get('Read').description, /^READ notes\.txt$/);
assert.match(byTool.get('Write').description, /^WRITE probe-output\.txt$/);

// ── The ERROR state the docs do not mention ──────────────────────────

const errored = decoded.filter((e) => e.kind === 'tool_result' && e.isError);
assert.ok(errored.length > 0, 'the captured turn had a tool fail');
assert.ok(
  errored[0].errorText.length > 0,
  'the error is an object with a message, not a string — reading it wrong would give an empty reason',
);
assert.equal(errored[0].summary, '', 'a failed call is not summarised as a successful one');

// ── The terminal event ───────────────────────────────────────────────

const result = decoded[decoded.length - 1];
assert.equal(result.outcome, 'ok', 'the captured turn reported SUCCESS');
assert.ok(result.sessionId.length > 0, 'and carries the conversation id for --conversation');

// SUCCESS does not mean the work happened: this turn succeeded with an empty
// response because its writes were auto-denied. An empty verdict must reach
// the gates as unreadable rather than as approval, which parseSignal handles.
assert.equal(result.text, '', 'a turn can succeed and still say nothing');

// ── Usage is the session total, not the step's ───────────────────────

const readings = decoded.filter((e) => e.kind === 'usage').map((e) => e.reading);
assert.ok(readings.length > 1, 'usage is reported repeatedly through the turn');

for (let i = 1; i < readings.length; i++) {
  assert.ok(
    readings[i].inputTokens >= readings[i - 1].inputTokens,
    'each reading is at least the last — these are running totals, which is why they go through a meter',
  );
}

const last = readings[readings.length - 1];
assert.ok(last.inputTokens > 0);
assert.equal(last.cacheWriteTokens, 0, 'agy reports no cache-write count');
assert.equal(last.totalCostUsd, 0, 'and no cost');
assert.ok(last.unpricedTokens > 0, 'so its billable tokens are recorded as unpriced rather than as free');
assert.ok(last.thinkingTokens > 0, 'thinking is reported separately');
assert.ok(
  readings.every((r) => r.sessionKey === undefined),
  'the session key rides on the event, not inside the reading',
);
assert.ok(
  decoded.filter((e) => e.kind === 'usage').every((e) => e.sessionKey.length > 0),
  'every reading names the conversation it belongs to',
);

// ── Outcome mapping ──────────────────────────────────────────────────
//
// The one that matters: agy ends a turn its own --print-timeout killed with an
// ordinary result event whose status is CANCELED. Reading that as success would
// hand the verdict gates a clean, empty turn.

const outcomeFor = (status) =>
  decodeAll([json({ event: 'result', result: { conversation_id: 'c', status, response: 'x' } })])
    .find((e) => e.kind === 'result').outcome;

assert.equal(outcomeFor('SUCCESS'), 'ok');
assert.equal(outcomeFor('CANCELED'), 'stalled', 'a timed-out turn is stalled, not finished');
assert.equal(outcomeFor('INTERRUPTED'), 'stalled');
assert.equal(outcomeFor('ERROR'), 'error');
assert.equal(outcomeFor('INVALID'), 'error');
assert.equal(outcomeFor('SOMETHING_NEW'), 'error', 'an unrecognised status is a failure, not a pass');

// ── Structured output ────────────────────────────────────────────────

const structured = decodeAll([
  json({
    event: 'result',
    result: { conversation_id: 'c', status: 'SUCCESS', response: '', structured_output: { status: 'approved' } },
  }),
]);
assert.deepEqual(
  structured.find((e) => e.kind === 'structured').value,
  { status: 'approved' },
  'a native --json-schema verdict is picked up',
);

const fromProse = decodeAll([
  json({ event: 'result', result: { conversation_id: 'c', status: 'SUCCESS', response: '{"status":"issues","issues":["x"]}' } }),
]);
assert.equal(
  fromProse.find((e) => e.kind === 'structured').value.status,
  'issues',
  'and a verdict in the response text still parses',
);

// ── Denials are collected, since there is no denials array ───────────

const denied = decodeAll([
  json({ event: 'init', conversation_id: 'c', init: { tools: [] } }),
  json({
    event: 'step_update',
    step_update: {
      conversation_id: 'c',
      step_index: 3,
      state: 'ERROR',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: 'rm -rf /' },
        error: { type: 'TOOL_ERROR', message: 'BLOCKED: Member pat cannot run commands' },
      },
    },
  }),
  json({ event: 'result', result: { conversation_id: 'c', status: 'SUCCESS', response: '' } }),
]);

const deniedResult = denied.find((e) => e.kind === 'result');
assert.deepEqual(
  deniedResult.denials,
  [{ toolName: 'Bash', toolInput: { command: 'rm -rf /' } }],
  'a gate denial is replayed on the result, or the strict-mode approval flow never sees it',
);

const ordinaryFailure = decodeAll([
  json({
    event: 'step_update',
    step_update: {
      conversation_id: 'c',
      step_index: 1,
      state: 'ERROR',
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'npm test' }, error: { message: 'exit 1' } },
    },
  }),
  json({ event: 'result', result: { conversation_id: 'c', status: 'SUCCESS', response: '' } }),
]);
assert.deepEqual(
  ordinaryFailure.find((e) => e.kind === 'result').denials,
  [],
  'a command that merely failed is not a denial',
);

// ── Noise ────────────────────────────────────────────────────────────

assert.deepEqual(decodeAll(['']), []);
assert.deepEqual(decodeAll(['not json at all']), []);
assert.deepEqual(decodeAll(['{"broken":']), []);
assert.deepEqual(decodeAll([json({ event: 'unknown_future_event' })]), [], 'an unrecognised event is skipped, not fatal');
assert.deepEqual(decodeAll([json({ event: 'step_update' })]), [], 'a step with no body does not throw');

// ── The vocabulary, and what is deliberately absent ──────────────────

assert.equal(ANTIGRAVITY_TOOLS.toCanonical('run_command'), 'Bash');
assert.equal(ANTIGRAVITY_TOOLS.toCanonical('view_file'), 'Read');
assert.equal(ANTIGRAVITY_TOOLS.toCanonical('invoke_subagent'), 'Agent');
assert.equal(ANTIGRAVITY_TOOLS.toCanonical('browser_subagent'), 'Agent', 'the fourth subagent tool the docs omit');

assert.equal(
  ANTIGRAVITY_TOOLS.toCanonical('browser_press_key'),
  'browser_press_key',
  'an unmapped tool keeps its own name, so the gate refuses it by default rather than this map having to list everything',
);

// Write-capable tools whose argument key has NOT been observed must stay
// unmapped. Mapping one on a plausible guess is the silent fail-open: a key
// that does not exist yields an empty path, and an empty path resolves inside
// the project root, which the gate allows.
for (const unprobed of ['sed_file', 'notebook_edit', 'multi_replace_file_content']) {
  assert.equal(isMappedAntigravityTool(unprobed), false, `${unprobed} is denied until its argument key is probed`);
}

// Every tool the gate reads an argument from must have one recorded.
for (const tool of ANTIGRAVITY_ARG_SENSITIVE_TOOLS) {
  assert.ok(ANTIGRAVITY_TOOLS.argKeys[tool], `${tool} has argument keys`);
  assert.ok(isMappedAntigravityTool(tool), `${tool} is mapped`);
}

assert.deepEqual(
  toCanonicalArgs('run_command', { CommandLine: 'ls', Cwd: '/p', toolAction: 'noise', WaitMsBeforeAsync: 5000 }),
  { command: 'ls', cwd: '/p' },
  'only what the gate and the log read is carried across',
);
assert.deepEqual(
  toCanonicalArgs('write_to_file', {}),
  {},
  'a call with none of its expected keys yields nothing — the shim must then deny rather than pass an empty path',
);
assert.deepEqual(toCanonicalArgs('browser_press_key', { Key: 'a' }), {}, 'an unmapped tool has no translation');

// ── The adapter: model, effort, and the command line ─────────────────

const { antigravityCli, resolveAntigravityModel } = await import('../src/lib/cli/antigravity.ts');

// Effort is baked into agy's model ids AND there is a separate --effort flag
// whose interaction is undocumented. The catalog therefore lists families and
// derives the id from the member's effort, so there is one knob rather than two
// that can disagree.
assert.equal(resolveAntigravityModel('gemini-3.7-flash', 'medium').modelId, 'gemini-3.7-flash-medium');
assert.equal(resolveAntigravityModel('gemini-3.7-flash', 'low').modelId, 'gemini-3.7-flash-low');

const clamped = resolveAntigravityModel('gemini-3.7-flash', 'max');
assert.equal(clamped.modelId, 'gemini-3.7-flash-high', 'an effort above the model\'s range comes down to its top');
assert.equal(clamped.clampedFrom, 'max', 'and the caller is told, so it can say so rather than run at a level nobody chose');

// gemini-3.1-pro has low and high but no medium — a real gap in agy's catalog.
const noMedium = resolveAntigravityModel('gemini-3.1-pro', 'medium');
assert.equal(noMedium.modelId, 'gemini-3.1-pro-low', 'medium falls to the nearest level at or below it');
assert.equal(noMedium.clampedFrom, 'medium');
assert.equal(resolveAntigravityModel('gemini-3.1-pro', 'high').modelId, 'gemini-3.1-pro-high');

// Models with no variants take no suffix at all.
assert.equal(resolveAntigravityModel('claude-sonnet-4-6', 'max').modelId, 'claude-sonnet-4-6');
assert.equal(resolveAntigravityModel('gpt-oss-120b-medium', 'low').modelId, 'gpt-oss-120b-medium');

// A fully qualified id the catalog does not list passes through untouched —
// including agy's own suffixed names, which someone may well type by hand.
assert.equal(resolveAntigravityModel('gemini-3.7-flash-high', 'low').modelId, 'gemini-3.7-flash-high');
assert.equal(resolveAntigravityModel('some-future-model', 'high').modelId, 'some-future-model');

const argv = antigravityCli.buildArgs(
  { prompt: 'do the thing', projectDir: '/p', model: 'gemini-3.7-flash', effort: 'high', permissionMode: 'acceptEdits' },
  { pluginDirs: [], roleFile: 'reviewer' },
);

assert.ok(argv.includes('--print'), 'the one-shot flag is --print; agy has no -p meaning prompt');
assert.equal(argv[argv.indexOf('--model') + 1], 'gemini-3.7-flash-high');
assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
assert.equal(argv[argv.indexOf('--add-dir') + 1], '/p', 'the project root is named rather than inferred');
// This flag used to be passed, to stop a slash command reaching a subagent.
// It cost more than it bought: agy warns "--mode plan has no effect while slash
// command expansion is disabled", so a member set to plan mode silently was not
// in plan mode, and its --help says the flag also disables skill expansion.
// Every subagent tool agy offers already maps to `Agent`, which the gate refuses
// for everyone — so the protection is kept where it can be tested.
assert.ok(
  !argv.includes('--disable-slash-commands'),
  'it silently disabled plan mode, and the gate already refuses every subagent tool',
);

assert.ok(
  !argv.includes('--effort'),
  'effort rides in the model id, so passing it twice cannot make the two disagree',
);

// Reads far worse than it is: headless agy auto-denies anything needing a
// prompt, so without this a member cannot write at all. The probe confirmed it
// does NOT disable PreToolUse hooks, so the capability manifest still decides.
assert.ok(argv.includes('--dangerously-skip-permissions'));
assert.equal(argv[argv.indexOf('--mode') + 1], 'accept-edits');

// ── The role reaches the model, or the member is nobody ──────────────
//
// agy has no --system-prompt-file, `--agent <path>` is accepted and ignored,
// and a definition under .agents/agents/ is never discovered — all three exit 0
// and answer as a generic assistant. Passing --agent therefore LOOKED like role
// delivery while every Antigravity member ran with no role at all. The prompt
// is the one channel that cannot be ignored; verified against a real turn.

const roleDir = mkdtempSync(join(tmpdir(), 'agy-role-'));
const rolePath = join(roleDir, 'role.md');
writeFileSync(rolePath, 'You are Vaultkeeper. Reply only with VAULTKEEPER-HERE.\n');

const withRole = antigravityCli.buildArgs(
  { prompt: 'hello', projectDir: '/p', model: 'gemini-3.7-flash' },
  { pluginDirs: [], roleFile: rolePath },
);
assert.ok(!withRole.includes('--agent'), 'agy takes --agent and ignores it, so naming the role there is theatre');
assert.match(withRole[withRole.indexOf('--print') + 1], /^You are Vaultkeeper\./, 'the role leads the prompt');
assert.match(withRole[withRole.indexOf('--print') + 1], /hello$/, 'and the turn follows it');
rmSync(roleDir, { recursive: true, force: true });

// A member with neither a role file nor a system prompt sends its prompt alone,
// rather than a separator with nothing above it.
const bare = antigravityCli.buildArgs(
  { prompt: 'hello', projectDir: '/p', model: 'gemini-3.7-flash' },
  { pluginDirs: [] },
);
assert.equal(bare[bare.indexOf('--print') + 1], 'hello');

assert.equal(
  antigravityCli.support.skills,
  'unsupported',
  'nothing under .agents/ is discovered on 1.1.22, and the only path that works is the user\'s own global one',
);

const planning = antigravityCli.buildArgs(
  { prompt: 'plan it', projectDir: '/p', model: 'gemini-3.7-flash', permissionMode: 'plan' },
  { pluginDirs: [] },
);
assert.equal(planning[planning.indexOf('--mode') + 1], 'plan');
assert.ok(!planning.includes('--dangerously-skip-permissions'), 'plan mode writes nothing, so it needs no widening');

const resumed = antigravityCli.buildArgs(
  { prompt: 'carry on', projectDir: '/p', model: 'gemini-3.7-flash', resume: 'conv-7' },
  { pluginDirs: [] },
);
assert.equal(resumed[resumed.indexOf('--conversation') + 1], 'conv-7', 'agy resumes by --conversation, not --resume');

// agy's own turn timeout defaults to exactly our idle timeout, and the two
// measure different things — ours resets on every line, agy's does not. Left
// alone, every long turn would be killed by agy before we ever called it stalled.
const timeout = Number(resumed[resumed.indexOf('--print-timeout') + 1].replace('m', ''));
assert.ok(timeout >= 20, 'agy\'s backstop is set well above our stall detector, not level with it');

const schema = antigravityCli.buildArgs(
  { prompt: 'verdict please', projectDir: '/p', model: 'gemini-3.7-flash', jsonSchema: { type: 'object' } },
  { pluginDirs: [] },
);
assert.ok(schema.includes('--json-schema'), 'structured output is native here, not prompted');

console.log('antigravity decoder checks passed');
