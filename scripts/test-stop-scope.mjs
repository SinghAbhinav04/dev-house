#!/usr/bin/env node

/**
 * What pressing Stop is allowed to reach.
 *
 * Stop used to be `pkill -f "claude.*--output-format.*stream-json"`, which
 * matches every headless Claude Code process on the machine rather than the
 * ones this app started. These checks spawn real processes and prove the
 * replacement signals the run's own process group and nothing else.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── The tripwire, before anything is stopped ─────────────────────────
//
// First on purpose. Everything below calls the real stopPipelineRun(); if a
// machine-wide kill ever comes back, running these checks would itself take
// down unrelated sessions. So that is refused by reading the source, before a
// single process is signalled.
const source = readFileSync(join(repoRoot, 'src', 'lib', 'pipeline-control.ts'), 'utf8');
const code = source
  .split('\n')
  .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
  .join('\n');
assert.ok(!/\bpkill\b|\bkillall\b/.test(code), 'stop must not find its targets by matching command lines');

// ~/Builds is read from the home directory when the module loads.
const tempRoot = mkdtempSync(join(tmpdir(), 'hackeroom-stop-'));
process.env.HOME = join(tempRoot, 'home');
process.env.HACKEROOM_HOME = join(tempRoot, 'hackeroom');

const {
  isOrchestratorGroup,
  orchestratorPidPath,
  readOrchestratorPid,
  recordOrchestratorPid,
  stopPipelineRun,
  trackDirectTurn,
} = await import('../src/lib/pipeline-control.ts');

const projectDir = join(process.env.HOME, 'Builds', 'stop-project');
const eventsFile = join(projectDir, 'pipeline-events.json');
mkdirSync(projectDir, { recursive: true });

function writeRunningState() {
  writeFileSync(
    eventsFile,
    JSON.stringify({ currentPhase: 'coding', pipelineStatus: 'running', activeAgent: 'reacty', agentStatus: { reacty: 'active' }, events: [] })
  );
}

const IDLE = 'setInterval(() => {}, 1000)';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(50);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** Resolves when the child has exited and been reaped. */
function exited(child) {
  return new Promise((done) => child.once('exit', done));
}

const spawned = [];

/**
 * A stand-in for `npx tsx pipeline/orchestrator.ts`: detached, so it leads its
 * own process group, with a child of its own standing in for a member turn.
 * The extra argv is only there so its command line reads like the real one.
 */
function spawnOrchestratorStandIn() {
  const memberPidFile = join(tempRoot, `member-${spawned.length}.pid`);
  const script = join(tempRoot, 'stand-in.mjs');
  writeFileSync(
    script,
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      `const member = spawn(process.execPath, ['-e', ${JSON.stringify(IDLE)}], { stdio: 'ignore' });`,
      'writeFileSync(process.argv[3], String(member.pid));',
      IDLE,
    ].join('\n')
  );

  const child = spawn(process.execPath, [script, 'orchestrator.ts', memberPidFile], { detached: true, stdio: 'ignore' });
  spawned.push(child);
  return { child, memberPidFile };
}

/** Exactly what the old pattern matched, and nothing to do with this run. */
function spawnUnrelatedSession() {
  const child = spawn(process.execPath, ['-e', IDLE, 'claude', '--output-format', 'stream-json'], {
    detached: true,
    stdio: 'ignore',
  });
  spawned.push(child);
  return child;
}

try {
  // ── The pid record ─────────────────────────────────────────────────

  assert.equal(readOrchestratorPid(projectDir), null, 'no record before a run');
  recordOrchestratorPid(projectDir, 4321);
  assert.equal(readOrchestratorPid(projectDir), 4321);
  assert.ok(orchestratorPidPath(projectDir).includes(`${join('.claude', 'orchestrator.pid')}`), 'kept where no member can write');

  for (const junk of ['0', '1', '-1', '-4321', 'abc', '12.5', '']) {
    writeFileSync(orchestratorPidPath(projectDir), junk);
    assert.equal(readOrchestratorPid(projectDir), null, `"${junk}" is not a group id to signal`);
  }
  rmSync(orchestratorPidPath(projectDir), { force: true });

  // ── Stop reaches the run, and only the run ─────────────────────────

  const unrelated = spawnUnrelatedSession();
  const { child: orchestrator, memberPidFile } = spawnOrchestratorStandIn();
  const orchestratorExit = exited(orchestrator);

  await waitFor(() => existsSync(memberPidFile), 'the stand-in to start its member turn');
  const memberPid = Number(readFileSync(memberPidFile, 'utf8'));
  assert.ok(isAlive(memberPid), 'the member turn is running');

  assert.equal(isOrchestratorGroup(orchestrator.pid), true, 'a group containing the orchestrator is recognised');
  assert.equal(isOrchestratorGroup(unrelated.pid), false, "a group of somebody else's sessions is not");

  recordOrchestratorPid(projectDir, orchestrator.pid);
  writeRunningState();

  const result = stopPipelineRun(projectDir);
  assert.equal(result.success, true);
  assert.equal(result.projectDir, projectDir);

  await orchestratorExit;
  await waitFor(() => !isAlive(memberPid), 'the member turn to die with its orchestrator');
  assert.equal(isOrchestratorGroup(orchestrator.pid), false, 'a group that has gone is not an orchestrator');

  assert.ok(isAlive(unrelated.pid), 'a Claude session this app did not start is left alone');
  assert.ok(!existsSync(orchestratorPidPath(projectDir)), 'the record is cleared once used');

  const stopped = JSON.parse(readFileSync(eventsFile, 'utf8'));
  assert.equal(stopped.pipelineStatus, 'paused');
  assert.equal(stopped.agentStatus.reacty, 'idle');
  assert.equal(stopped.events.at(-1).text, 'Pipeline stopped by user');

  // ── A stale record signals nobody ──────────────────────────────────
  //
  // The id of a live group that is not an orchestrator: what a reused pid
  // looks like after the run it belonged to has gone.
  recordOrchestratorPid(projectDir, unrelated.pid);
  writeRunningState();
  stopPipelineRun(projectDir);
  await sleep(300);
  assert.ok(isAlive(unrelated.pid), 'a recorded id that no longer names an orchestrator is not signalled');
  assert.ok(!existsSync(orchestratorPidPath(projectDir)), 'and the stale record is dropped');

  // ── No record at all ───────────────────────────────────────────────

  writeRunningState();
  assert.equal(stopPipelineRun().success, true, 'stopping with nothing recorded still pauses the run');
  assert.equal(JSON.parse(readFileSync(eventsFile, 'utf8')).pipelineStatus, 'paused');
  assert.ok(isAlive(unrelated.pid));

  // ── Direct chat turns ──────────────────────────────────────────────

  const turn = trackDirectTurn(spawn(process.execPath, ['-e', IDLE], { stdio: 'ignore' }));
  spawned.push(turn);
  const turnExit = exited(turn);

  const finished = trackDirectTurn(spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }));
  await new Promise((done) => finished.once('close', done));

  stopPipelineRun(projectDir);
  await turnExit;
  assert.equal(turn.signalCode, 'SIGTERM', 'a tracked chat turn is ended by handle');
  assert.ok(isAlive(unrelated.pid), 'and still nothing else is');

  console.log('stop scope checks passed');
} finally {
  for (const child of spawned) {
    try {
      // The group for detached stand-ins, so their own children go too.
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
    try {
      child.kill('SIGKILL');
    } catch {}
  }
  rmSync(tempRoot, { recursive: true, force: true });
}
