import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(repoRoot, 'scripts', 'fixtures');

const { createOpencodeDecoder } = await import(join(repoRoot, 'src/lib/cli/opencode-decoder.ts'));
const { openCodeCli } = await import(join(repoRoot, 'src/lib/cli/opencode.ts'));
const { OPENCODE_TOOLS, toCanonicalArgs, isMappedOpencodeTool, OPENCODE_ARG_SENSITIVE_TOOLS } =
  await import(join(repoRoot, 'src/lib/cli/opencode-tools.ts'));

function decodeAll(lines) {
  const decoder = createOpencodeDecoder();
  const events = [];
  for (const line of lines) events.push(...decoder.push(line));
  events.push(...decoder.finish());
  return events;
}

const json = (v) => JSON.stringify(v);

// ── Against the real captured stream ─────────────────────────────────

const captured = readFileSync(join(fixtures, 'opencode-stream.ndjson'), 'utf8')
  .split('\n')
  .filter((l) => l.trim());

const decoded = decodeAll(captured);
const kinds = decoded.map((e) => e.kind);

assert.equal(kinds[0], 'session', 'the session id comes out first, for --session');
assert.ok(kinds.includes('tool_call'));
assert.ok(kinds.includes('tool_result'));
assert.ok(kinds.includes('usage'));
assert.equal(kinds[kinds.length - 1], 'result', 'finish() synthesises the terminal event OpenCode never sends');

// A tool_use event carries the call and its result together, so both are
// emitted and in that order — every caller's bookkeeping assumes it.
const firstCall = kinds.indexOf('tool_call');
assert.equal(kinds[firstCall + 1], 'tool_result', 'a call is immediately followed by its result');

const byTool = new Map(decoded.filter((e) => e.kind === 'tool_call').map((e) => [e.tool, e]));
assert.ok(byTool.has('Read'), 'read maps to Read');
assert.ok(byTool.has('Write'), 'write maps to Write');
assert.ok(byTool.has('Bash'), 'bash maps to Bash');
assert.match(byTool.get('Read').input.file_path, /notes\.txt$/, 'filePath becomes file_path');
assert.match(byTool.get('Read').description, /^READ notes\.txt$/);

// ── The reply is NOT in the stream ───────────────────────────────────
//
// Verified by probe on a tool-using turn and a plain one, on free and paid
// models. Combined with no --json-schema, that leaves no verdict in the stream
// at all — which is why the adapter fetches it afterwards.

const result = decoded[decoded.length - 1];
assert.equal(result.text, '', 'the terminal event carries no text, because the stream never had any');
assert.ok(result.sessionId.length > 0, 'but it does carry the session, which is how the reply is fetched');
assert.equal(typeof openCodeCli.fetchReplyText, 'function', 'so the adapter must provide a way to fetch it');
assert.equal(openCodeCli.support.structuredOutput, 'prompted', 'and there is no schema to fall back on');

// ── Usage is per step, except `total`, which is not ──────────────────

const readings = decoded.filter((e) => e.kind === 'usage').map((e) => e.reading);
assert.ok(readings.length >= 2, 'the captured turn reported usage more than once');
assert.equal(openCodeCli.support.usageReporting, 'delta', 'input/output/cache are per step');

// Observed: step 1 input=11026, step 2 input=280 while total climbed to 13014.
// Reading `total` would have counted the first step again.
assert.ok(
  readings[1].inputTokens < readings[0].inputTokens,
  'the second step really is a delta, not a running total',
);
assert.ok(readings[0].cacheReadTokens >= 0);
assert.ok(readings.some((r) => r.cacheWriteTokens >= 0), 'unlike Antigravity, cache writes are reported');

// ── Noise and edges ──────────────────────────────────────────────────

assert.deepEqual(decodeAll([]).length, 1, 'even an empty stream yields a terminal event');
assert.equal(decodeAll([]).at(-1).outcome, 'error', 'a turn that produced nothing at all is a failure');
assert.deepEqual(decodeAll(['not json']).at(-1).outcome, 'error');
assert.equal(
  decodeAll([json({ type: 'step_start', sessionID: 'ses_1', part: {} })]).at(-1).outcome,
  'ok',
  'a session id alone is enough to say the turn ran',
);

// A denial has to reach the result, or the strict-mode approval flow never
// sees it — OpenCode has no denials array of its own.
const denied = decodeAll([
  json({
    type: 'tool_use',
    sessionID: 'ses_1',
    part: {
      type: 'tool',
      tool: 'bash',
      callID: 'c1',
      state: { status: 'error', input: { command: 'rm -rf /' }, error: 'BLOCKED: Member pat cannot run commands' },
    },
  }),
]);
assert.deepEqual(
  denied.at(-1).denials,
  [{ toolName: 'Bash', toolInput: { command: 'rm -rf /' } }],
  'a gate denial is replayed on the result',
);
assert.deepEqual(
  decodeAll([
    json({
      type: 'tool_use',
      sessionID: 'ses_1',
      part: { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'error', input: { command: 'npm test' }, error: 'exit 1' } },
    }),
  ]).at(-1).denials,
  [],
  'a command that merely failed is not a denial',
);

// ── The vocabulary ───────────────────────────────────────────────────

assert.equal(OPENCODE_TOOLS.toCanonical('bash'), 'Bash');
assert.equal(OPENCODE_TOOLS.toCanonical('task'), 'Agent', 'the sub-agent tool is blocked for everyone');
assert.equal(OPENCODE_TOOLS.toCanonical('something_new'), 'something_new', 'unmapped keeps its name, so the gate denies it');

assert.equal(OPENCODE_TOOLS.argKeys.read.path, 'filePath', 'camelCase here, not Claude\'s file_path');
assert.equal(OPENCODE_TOOLS.argKeys.write.path, 'filePath');
assert.equal(OPENCODE_TOOLS.argKeys.bash.command, 'command');

for (const tool of OPENCODE_ARG_SENSITIVE_TOOLS) {
  assert.ok(OPENCODE_TOOLS.argKeys[tool], `${tool} has argument keys`);
  assert.ok(isMappedOpencodeTool(tool), `${tool} is mapped`);
}

assert.deepEqual(
  toCanonicalArgs('bash', { command: 'ls', description: 'noise' }),
  { command: 'ls' },
  'only what the gate and the log read is carried across',
);
assert.deepEqual(toCanonicalArgs('write', {}), {}, 'a call with none of its keys yields nothing to forward');

// ── The command line ─────────────────────────────────────────────────

const argv = openCodeCli.buildArgs(
  {
    prompt: 'do the thing',
    projectDir: '/p',
    model: 'openrouter/x',
    effort: 'high',
    permissionMode: 'acceptEdits',
    pipelineAgent: 'pat',
  },
  { pluginDirs: [], roleFile: '/home/me/.hackeroom/members/pat/role.md' },
);

assert.equal(argv[0], 'run');
assert.equal(argv[1], 'do the thing', 'the prompt is a positional');
assert.ok(
  !argv.includes('-p'),
  'never -p: on this CLI that is --password, so copying Claude\'s flag would send the prompt as a credential',
);
assert.ok(!argv.includes('--pure'), 'never --pure: it runs without plugins, and the gate IS a plugin');
assert.ok(!argv.includes('--attach'), 'never --attach: it severs the environment carrying the member identity');
assert.equal(argv[argv.indexOf('--format') + 1], 'json');
assert.equal(argv[argv.indexOf('--dir') + 1], '/p');
assert.equal(argv[argv.indexOf('--model') + 1], 'openrouter/x');

// ── --agent takes a NAME, never a path ───────────────────────────────
//
// This one hung the process. `opencode run --agent /abs/path/role.md` does not
// error and does not exit — it waits forever with no output, so a member
// looked stuck rather than misconfigured. The name is the member id; the
// definition it refers to is written by prepare().

assert.equal(argv[argv.indexOf('--agent') + 1], 'pat', 'the agent is named by member id');

const agentValue = argv[argv.indexOf('--agent') + 1];
assert.ok(!agentValue.startsWith('/'), 'the agent value is not a path');
assert.ok(!agentValue.endsWith('.md'), 'nor a markdown file');

const noMember = openCodeCli.buildArgs(
  { prompt: 'x', projectDir: '/p', model: 'openrouter/x' },
  { pluginDirs: [], roleFile: '/some/role.md' },
);
assert.ok(
  !noMember.includes('--agent'),
  'with no member to name, --agent is omitted rather than handed the role file path',
);

// prepare() is what makes that name resolve to anything.
assert.equal(typeof openCodeCli.prepare, 'function', 'the definition has to be written before the spawn');

const resumed = openCodeCli.buildArgs(
  { prompt: 'carry on', projectDir: '/p', model: 'openrouter/x', resume: 'ses_9' },
  { pluginDirs: [] },
);
assert.equal(resumed[resumed.indexOf('--session') + 1], 'ses_9', 'OpenCode resumes by --session');

// ── The gate shim ────────────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), 'hackeroom-oc-gate-'));
const home = join(root, 'home');
const projectDir = join(home, 'Builds', 'p');
const hooksDir = join(projectDir, '.claude', 'hooks');
mkdirSync(hooksDir, { recursive: true });

writeFileSync(join(projectDir, 'pipeline-events.json'), JSON.stringify({ currentPhase: 'coding' }));
writeFileSync(join(projectDir, 'plan.md'), '# plan\n');
writeFileSync(
  join(projectDir, '.claude', 'team-manifest.json'),
  JSON.stringify({
    version: 1,
    artifacts: { 'plan.md': 'pat' },
    members: {
      pat: { slot: 'planner', write: 'artifact', bash: 'none', web: true, denyPhases: [] },
      reacty: { slot: 'coder', write: 'project', bash: 'safe', web: false, denyPhases: [] },
    },
  })
);
for (const file of ['approval-gate.sh', 'gate-opencode.mjs']) {
  writeFileSync(join(hooksDir, file), readFileSync(join(repoRoot, 'pipeline', '.claude', 'hooks', file), 'utf8'), { mode: 0o755 });
}

const shim = join(hooksDir, 'gate-opencode.mjs');

function ask({ tool, args = {}, member = 'reacty', securityMode = 'fast' }) {
  const out = spawnSync('node', [shim], {
    input: JSON.stringify({ tool, args, cwd: projectDir }),
    encoding: 'utf8',
    cwd: projectDir,
    env: { ...process.env, HOME: home, PIPELINE_AGENT: member, PIPELINE_SECURITY_MODE: securityMode },
  });
  try {
    return JSON.parse(out.stdout.trim());
  } catch {
    return { allow: null, raw: out.stdout, stderr: out.stderr };
  }
}

const gateChecks = [
  ['an ordinary read is permitted', () => assert.equal(ask({ tool: 'read', args: { filePath: join(projectDir, 'plan.md') } }).allow, true)],
  ['a write inside the project is permitted', () => assert.equal(ask({ tool: 'write', args: { filePath: join(projectDir, 'x.ts') } }).allow, true)],
  ['a write outside the project is refused', () => assert.equal(ask({ tool: 'write', args: { filePath: join(home, 'escape.txt') } }).allow, false)],
  ['a write to the gate itself is refused', () => assert.equal(ask({ tool: 'write', args: { filePath: join(projectDir, '.claude', 'settings.json') } }).allow, false)],
  ['the locked artifact is refused to others', () => assert.equal(ask({ tool: 'write', args: { filePath: join(projectDir, 'plan.md') } }).allow, false)],
  // The check the shim exists for: a missing or renamed key must deny rather
  // than hand the gate an empty path it would resolve inside the project.
  ['a write with no filePath is refused', () => assert.equal(ask({ tool: 'write', args: {} }).allow, false)],
  ['a write naming Claude\'s key instead is refused', () => assert.equal(ask({ tool: 'write', args: { file_path: join(projectDir, 'x.ts') } }).allow, false)],
  ['bash with no command is refused', () => assert.equal(ask({ tool: 'bash', args: {} }).allow, false)],
  ['an unmapped tool is refused', () => assert.equal(ask({ tool: 'browser_click', args: {} }).allow, false)],
  ['the sub-agent tool is refused', () => assert.equal(ask({ tool: 'task', args: {} }).allow, false)],
  ['spawning another agent via bash is refused', () => assert.equal(ask({ tool: 'bash', args: { command: 'opencode run "anything"' } }).allow, false)],
  ['an ordinary command is permitted', () => assert.equal(ask({ tool: 'bash', args: { command: 'npm test' } }).allow, true)],
  ['a member with no bash is refused', () => assert.equal(ask({ tool: 'bash', args: { command: 'ls' }, member: 'pat' }).allow, false)],
  ['a request for approval becomes a refusal', () => {
    const answer = ask({ tool: 'bash', args: { command: 'npm test' }, securityMode: 'strict' });
    assert.equal(answer.allow, false);
    assert.match(answer.reason, /approval/i);
  }],
];

let failures = 0;
for (const [name, fn] of gateChecks) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${err.message.split('\n')[0]}`);
  }
}

rmSync(root, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\nOpenCode checks failed: ${failures}`);
  process.exit(1);
}

console.log(`\nopencode checks passed (${gateChecks.length} gate checks)`);
