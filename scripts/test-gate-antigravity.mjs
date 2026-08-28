#!/usr/bin/env node

/**
 * Contract tests for the Antigravity gate shim.
 *
 * These cover translation, fail-closed behaviour and verdict encoding, and
 * deliberately NOT the gate's own rules. Those have 69 assertions of their own
 * in test-hook-contract.mjs, and re-testing them here would give two suites
 * that could disagree about what the rules are.
 *
 * What is being proved: that agy's dialect reaches the gate intact, that a
 * missing or unknown argument refuses rather than passing an empty value, and
 * that a refusal comes back in the form agy actually reads.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hooksSrc = join(repoRoot, 'pipeline', '.claude', 'hooks');

const tempRoot = mkdtempSync(join(tmpdir(), 'hackeroom-agy-gate-'));
const home = join(tempRoot, 'home');
const projectDir = join(home, 'Builds', 'agy-project');
const hooksDir = join(projectDir, '.claude', 'hooks');

mkdirSync(hooksDir, { recursive: true });
mkdirSync(join(projectDir, '.agents'), { recursive: true });

// The gate finds the project by walking up from cwd looking for this.
writeFileSync(join(projectDir, 'pipeline-events.json'), JSON.stringify({ currentPhase: 'coding' }));
writeFileSync(join(projectDir, 'plan.md'), '# plan\n');
writeFileSync(join(projectDir, 'app.ts'), 'export const x = 1;\n');

writeFileSync(
  join(projectDir, '.claude', 'team-manifest.json'),
  JSON.stringify({
    version: 1,
    artifacts: { 'plan.md': 'pat' },
    members: {
      pat: { slot: 'planner', write: 'artifact', bash: 'none', web: true, denyPhases: [] },
      reacty: { slot: 'coder', write: 'project', bash: 'safe', web: false, denyPhases: [] },
      rex: { slot: 'reviewer', write: 'none', bash: 'none', web: true, denyPhases: [] },
    },
  })
);

// Both scripts, since the shim invokes the gate as its sibling.
for (const file of ['approval-gate.sh', 'gate-antigravity.sh']) {
  writeFileSync(join(hooksDir, file), readFileSync(join(hooksSrc, file), 'utf8'), { mode: 0o755 });
}

const shim = join(hooksDir, 'gate-antigravity.sh');

/** Drive the shim exactly as agy would. */
function invoke({ tool, args = {}, member = 'reacty', securityMode = 'fast' }) {
  const payload = {
    toolCall: { name: tool, args },
    conversationId: 'conv-1',
    stepIdx: 3,
    workspacePaths: [projectDir],
  };

  const result = spawnSync('bash', [shim], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    // agy runs the hook from <project>/.agents, not the project root.
    cwd: join(projectDir, '.agents'),
    env: { ...process.env, HOME: home, PIPELINE_AGENT: member, PIPELINE_SECURITY_MODE: securityMode },
  });

  let decision = null;
  try {
    decision = JSON.parse(result.stdout.trim()).decision ?? null;
  } catch {
    // No JSON on stdout means "proceed" in agy's contract.
  }

  return { decision, status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// ── The verdict encoding ─────────────────────────────────────────────
//
// agy reads a refusal from stdout JSON. A non-zero exit is an undefined hook
// failure that may be treated as "carry on", so the shim must always exit 0
// and say what it means in the payload.

check('an allowed tool produces no denial', () => {
  const out = invoke({ tool: 'view_file', args: { AbsolutePath: join(projectDir, 'app.ts') } });
  assert.equal(out.decision, null, 'silence is consent in this protocol');
  assert.equal(out.status, 0);
});

check('a denial is JSON on stdout, and still exits 0', () => {
  const out = invoke({ tool: 'run_command', args: { CommandLine: 'ls' }, member: 'pat' });
  assert.equal(out.decision, 'deny', 'pat has bash:none');
  assert.equal(out.status, 0, 'a non-zero exit is an undefined hook failure and may fail open');
});

check('a denial carries the gate\'s own reason', () => {
  const out = invoke({ tool: 'run_command', args: { CommandLine: 'ls' }, member: 'pat' });
  const reason = JSON.parse(out.stdout).reason;
  assert.match(reason, /cannot run commands/, 'the member is told why, in the gate\'s words');
});

check('the reason also reaches stderr for the run log', () => {
  const out = invoke({ tool: 'run_command', args: { CommandLine: 'ls' }, member: 'pat' });
  assert.match(out.stderr, /BLOCKED:/, 'the marker the decoder looks for to replay a denial');
});

// ── The fail-closed rule ─────────────────────────────────────────────
//
// The reason this file exists. The gate reads a path out of the arguments; a
// key that does not exist yields an empty string, an empty path resolves to the
// working directory, and the working directory is inside the project root,
// which the gate ALLOWS. Every one of these must refuse rather than pass an
// empty value through.

check('a write with no TargetFile is refused', () => {
  const out = invoke({ tool: 'write_to_file', args: {} });
  assert.equal(out.decision, 'deny');
  assert.match(JSON.parse(out.stdout).reason, /named no TargetFile/);
});

check('a write with an empty TargetFile is refused', () => {
  assert.equal(invoke({ tool: 'write_to_file', args: { TargetFile: '' } }).decision, 'deny');
});

check('a write naming the WRONG key is refused', () => {
  // What a plausible guess would have produced. It must not read as a write to
  // the project root.
  const out = invoke({ tool: 'write_to_file', args: { file_path: join(projectDir, 'x.ts') } });
  assert.equal(out.decision, 'deny', 'the snake_case key agy does not use buys nothing');
});

check('an edit with no TargetFile is refused', () => {
  assert.equal(invoke({ tool: 'replace_file_content', args: { Instruction: 'change it' } }).decision, 'deny');
});

check('a command with no CommandLine is refused', () => {
  const out = invoke({ tool: 'run_command', args: { Cwd: projectDir } });
  assert.equal(out.decision, 'deny');
  assert.match(JSON.parse(out.stdout).reason, /named no CommandLine/);
});

check('a payload naming no tool is refused', () => {
  const result = spawnSync('bash', [shim], {
    input: JSON.stringify({ toolCall: { args: {} }, conversationId: 'c' }),
    encoding: 'utf8',
    cwd: join(projectDir, '.agents'),
    env: { ...process.env, HOME: home, PIPELINE_AGENT: 'reacty' },
  });
  assert.equal(JSON.parse(result.stdout).decision, 'deny');
});

check('an unparseable payload is refused', () => {
  const result = spawnSync('bash', [shim], {
    input: 'this is not json',
    encoding: 'utf8',
    cwd: join(projectDir, '.agents'),
    env: { ...process.env, HOME: home, PIPELINE_AGENT: 'reacty' },
  });
  assert.equal(JSON.parse(result.stdout).decision, 'deny');
});

check('a member with no identity is refused', () => {
  const result = spawnSync('bash', [shim], {
    input: JSON.stringify({ toolCall: { name: 'view_file', args: { AbsolutePath: join(projectDir, 'app.ts') } } }),
    encoding: 'utf8',
    cwd: join(projectDir, '.agents'),
    env: { ...process.env, HOME: home },
  });
  assert.equal(JSON.parse(result.stdout).decision, 'deny', 'the gate refuses a member it cannot name');
});

// ── Unknown tools ────────────────────────────────────────────────────
//
// agy offers 57 tools. Everything not explicitly translated is refused here
// rather than reaching the gate under a name it would not recognise.

check('an unmapped tool is refused', () => {
  assert.equal(invoke({ tool: 'browser_press_key', args: { Key: 'a' } }).decision, 'deny');
});

check('a tool invented by a later version is refused', () => {
  assert.equal(invoke({ tool: 'some_new_tool_v2', args: {} }).decision, 'deny');
});

check('write-capable tools with unprobed argument keys stay refused', () => {
  // These can all write. Their key names have never been observed, so mapping
  // them on a guess is exactly the silent fail-open this shim exists to stop.
  for (const tool of ['sed_file', 'notebook_edit', 'multi_replace_file_content']) {
    assert.equal(invoke({ tool, args: { TargetFile: join(projectDir, 'app.ts') } }).decision, 'deny', tool);
  }
});

// ── Translation reaches the gate intact ──────────────────────────────

check('a write inside the project is allowed for the coder', () => {
  assert.equal(invoke({ tool: 'write_to_file', args: { TargetFile: join(projectDir, 'new.ts') } }).decision, null);
});

check('a write outside the project is refused', () => {
  assert.equal(invoke({ tool: 'write_to_file', args: { TargetFile: join(home, 'escape.txt') } }).decision, 'deny');
});

check('the locked artifact is refused to everyone but its owner', () => {
  assert.equal(invoke({ tool: 'write_to_file', args: { TargetFile: join(projectDir, 'plan.md') } }).decision, 'deny');
  assert.equal(
    invoke({ tool: 'write_to_file', args: { TargetFile: join(projectDir, 'plan.md') }, member: 'pat' }).decision,
    null,
    'the planner owns it',
  );
});

check('no member can write another CLI\'s config', () => {
  for (const target of ['.claude/settings.json', '.agents/hooks.json', '.opencode/opencode.json']) {
    assert.equal(invoke({ tool: 'write_to_file', args: { TargetFile: join(projectDir, target) } }).decision, 'deny', target);
  }
});

check('a read-only member cannot write', () => {
  assert.equal(
    invoke({ tool: 'write_to_file', args: { TargetFile: join(projectDir, 'x.ts') }, member: 'rex' }).decision,
    'deny',
  );
});

check('reads are allowed without any argument being inspected', () => {
  for (const tool of ['view_file', 'list_dir', 'find_by_name', 'grep_search']) {
    assert.equal(invoke({ tool, args: {} }).decision, null, `${tool} needs no path to be permitted`);
  }
});

check('web tools follow the member\'s web capability', () => {
  assert.equal(invoke({ tool: 'search_web', args: {}, member: 'pat' }).decision, null, 'pat may use the web');
  assert.equal(invoke({ tool: 'search_web', args: {}, member: 'reacty' }).decision, 'deny', 'the coder may not');
  assert.equal(invoke({ tool: 'read_url_content', args: {}, member: 'reacty' }).decision, 'deny');
});

check('every subagent tool is refused, including the undocumented fourth', () => {
  for (const tool of ['invoke_subagent', 'define_subagent', 'manage_subagents', 'browser_subagent']) {
    assert.equal(invoke({ tool, args: {} }).decision, 'deny', tool);
  }
});

check('a command that would rewrite the gate is refused', () => {
  assert.equal(invoke({ tool: 'run_command', args: { CommandLine: 'rm .claude/hooks/approval-gate.sh' } }).decision, 'deny');
});

check('a command that would spawn another agent is refused', () => {
  assert.equal(invoke({ tool: 'run_command', args: { CommandLine: 'agy -p "do anything"' } }).decision, 'deny');
});

check('an ordinary command is allowed for a member with bash', () => {
  assert.equal(invoke({ tool: 'run_command', args: { CommandLine: 'npm test' } }).decision, null);
});

// ── ask has no equivalent on this CLI ────────────────────────────────

check('a request for approval becomes a refusal, and says so', () => {
  // Strict mode escalates the coder's bash to "ask". agy cannot prompt a human
  // mid-turn, so the shim refuses rather than leaving the gate's answer
  // untranslated.
  const out = invoke({ tool: 'run_command', args: { CommandLine: 'npm test' }, securityMode: 'strict' });
  assert.equal(out.decision, 'deny');
  assert.match(JSON.parse(out.stdout).reason, /approval/i, 'the reason distinguishes this from an outright block');
});

let failures = 0;
for (const { name, fn } of checks) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}`);
    console.error(`  ${err.message.split('\n')[0]}`);
  }
}

rmSync(tempRoot, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\nAntigravity gate shim failed: ${failures} check(s).`);
  process.exit(1);
}

console.log(`\nAntigravity gate shim passed: ${checks.length} check(s).`);
