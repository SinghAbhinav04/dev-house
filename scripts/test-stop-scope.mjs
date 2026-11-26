#!/usr/bin/env node

/**
 * What pressing Stop is allowed to reach.
 *
 * Stop used to be `pkill -f "claude.*--output-format.*stream-json"`, which
 * matches every headless Claude Code process on the machine rather than the
 * ones this app started. These checks spawn real processes and prove the
 * replacement stops the run's own process tree and nothing else — on Windows,
 * macOS and Linux alike.
 *
 * Identity is a run token: the server records it with the pid, the
 * orchestrator writes it to a heartbeat. See src/lib/orchestrator-liveness.ts.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WINDOWS = process.platform === 'win32';

// ── The tripwire, before anything is stopped ─────────────────────────
//
// First on purpose. Everything below calls the real stopPipelineRun(); if a
// machine-wide kill ever comes back, running these checks would itself take
// down unrelated sessions. So that is refused by reading the source, before a
// single process is signalled.
for (const file of ['src/lib/pipeline-control.ts', 'src/lib/platform.ts']) {
  const code = readFileSync(join(repoRoot, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
    .join('\n');
  assert.ok(!/\bpkill\b|\bkillall\b|\/IM\b/.test(code), `${file}: stop must not find its targets by matching names`);
}

// ~/Builds is read from the home directory when the module loads.
const tempRoot = mkdtempSync(join(tmpdir(), 'hackeroom-stop-'));
process.env.HOME = join(tempRoot, 'home');
process.env.HACKEROOM_HOME = join(tempRoot, 'hackeroom');

const {
  orchestratorPidPath,
  readOrchestratorPid,
  recordOrchestratorPid,
  signalOrchestratorGroup,
  stopPipelineRun,
  trackDirectTurn,
} = await import('../src/lib/pipeline-control.ts');
const { heartbeatPath, orchestratorLiveness, STARTUP_GRACE_MS, HEARTBEAT_STALE_MS } = await import(
  '../src/lib/orchestrator-liveness.ts'
);

const projectDir = join(process.env.HOME, 'Builds', 'stop-project');
const eventsFile = join(projectDir, 'pipeline-events.json');
mkdirSync(join(projectDir, '.claude'), { recursive: true });

function writeRunningState() {
  writeFileSync(
    eventsFile,
    JSON.stringify({ currentPhase: 'coding', pipelineStatus: 'running', activeAgent: 'reacty', agentStatus: { reacty: 'active' }, events: [] })
  );
}

const IDLE = 'setInterval(() => {}, 1000)';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Running - as opposed to dead and not yet collected.
 *
 * On POSIX a killed process stays in the table as a zombie until its parent
 * reaps it, and `kill(pid, 0)` still succeeds on one; the member turn here is
 * an orphan once its orchestrator dies, and in a container with no init it is
 * reaped by nobody. Windows has no zombies.
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (IS_WINDOWS) return true;
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return state !== '' && !state.startsWith('Z');
}

async function waitFor(condition, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(50);
  }
  assert.fail(`timed out waiting for ${what}`);
}

function exited(child) {
  return new Promise((done) => child.once('exit', done));
}

const spawned = [];

/**
 * A stand-in for the orchestrator: detached, with a child of its own standing
 * in for a member turn, and — unless told not to — writing the heartbeat the
 * real one writes.
 */
function spawnOrchestratorStandIn({ token, heartbeat = true } = {}) {
  const memberPidFile = join(tempRoot, `member-${spawned.length}.pid`);
  const script = join(tempRoot, 'stand-in.mjs');
  writeFileSync(
    script,
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      `const member = spawn(process.execPath, ['-e', ${JSON.stringify(IDLE)}], { stdio: 'ignore' });`,
      'writeFileSync(process.argv[2], String(member.pid));',
      'const [beatFile, token] = [process.argv[3], process.argv[4]];',
      "const beat = () => writeFileSync(beatFile, JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() }));",
      "if (token) { beat(); setInterval(beat, 500); }",
      IDLE,
    ].join('\n')
  );

  const child = spawn(process.execPath, [script, memberPidFile, heartbeatPath(projectDir), heartbeat ? token : ''], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  spawned.push(child);
  return { child, memberPidFile };
}

/** Exactly what the old pattern matched, and nothing to do with this run. */
function spawnUnrelatedSession() {
  const child = spawn(process.execPath, ['-e', IDLE, 'claude', '--output-format', 'stream-json'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  spawned.push(child);
  return child;
}

function writeRecord(record) {
  writeFileSync(orchestratorPidPath(projectDir), JSON.stringify(record));
}

try {
  // ── The pid record ─────────────────────────────────────────────────

  assert.equal(readOrchestratorPid(projectDir), null, 'no record before a run');
  recordOrchestratorPid(projectDir, 4321, 'tok');
  assert.equal(readOrchestratorPid(projectDir), 4321);
  assert.ok(orchestratorPidPath(projectDir).includes(`${join('.claude', 'orchestrator.pid')}`), 'kept where no member can write');

  for (const junk of ['0', '1', '-1', '-4321', 'abc', '12.5', '', '{"pid":0}', '{"pid":"-5"}', '{}']) {
    writeFileSync(orchestratorPidPath(projectDir), junk);
    assert.equal(readOrchestratorPid(projectDir), null, `"${junk}" is not a pid to signal`);
  }
  rmSync(orchestratorPidPath(projectDir), { force: true });

  // ── Stop reaches the run, and only the run ─────────────────────────

  const unrelated = spawnUnrelatedSession();
  const { child: orchestrator, memberPidFile } = spawnOrchestratorStandIn({ token: 'run-1' });
  const orchestratorExit = exited(orchestrator);

  await waitFor(() => existsSync(memberPidFile) && existsSync(heartbeatPath(projectDir)), 'the stand-in to start');
  const memberPid = Number(readFileSync(memberPidFile, 'utf8'));
  assert.ok(isAlive(memberPid), 'the member turn is running');

  recordOrchestratorPid(projectDir, orchestrator.pid, 'run-1');
  assert.equal(orchestratorLiveness(projectDir), 'running', 'a live pid with a fresh, matching heartbeat is the run');
  writeRunningState();

  const result = stopPipelineRun(projectDir);
  assert.equal(result.success, true);
  assert.equal(result.projectDir, projectDir);
  assert.equal(result.warning, undefined, 'a clean stop carries no warning');

  await orchestratorExit;
  await waitFor(() => !isAlive(memberPid), 'the member turn to die with its orchestrator');
  assert.ok(isAlive(unrelated.pid), 'a Claude session this app did not start is left alone');
  assert.ok(!existsSync(orchestratorPidPath(projectDir)), 'the record is cleared once used');

  const stopped = JSON.parse(readFileSync(eventsFile, 'utf8'));
  assert.equal(stopped.pipelineStatus, 'paused');
  assert.equal(stopped.agentStatus.reacty, 'idle');
  assert.equal(stopped.events.at(-1).text, 'Pipeline stopped by user');

  // ── A process that has already gone ────────────────────────────────

  const gone = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore', windowsHide: true });
  await exited(gone);
  assert.equal(signalOrchestratorGroup(gone.pid), false, 'stopping something that has gone is not an error');

  // ── A reused pid signals nobody ────────────────────────────────────
  //
  // The pid of a live process that is not our orchestrator: what a reused pid
  // looks like after the run it belonged to has gone. Its heartbeat (if any)
  // carries some other token, and the record is past the startup grace.
  rmSync(heartbeatPath(projectDir), { force: true });
  writeRecord({ pid: unrelated.pid, token: 'run-2', startedAt: new Date(Date.now() - STARTUP_GRACE_MS - 5_000).toISOString() });
  assert.equal(orchestratorLiveness(projectDir), 'gone', 'no heartbeat and past the grace: not ours');
  writeRunningState();
  stopPipelineRun(projectDir);
  await sleep(300);
  assert.ok(isAlive(unrelated.pid), 'a recorded pid that no longer names the run is not signalled');
  assert.ok(!existsSync(orchestratorPidPath(projectDir)), 'and the stale record is dropped');

  writeFileSync(heartbeatPath(projectDir), JSON.stringify({ token: 'someone-else', pid: unrelated.pid }));
  writeRecord({ pid: unrelated.pid, token: 'run-3', startedAt: new Date().toISOString() });
  assert.equal(orchestratorLiveness(projectDir), 'gone', 'a heartbeat with another token is not ours, grace or not');
  rmSync(heartbeatPath(projectDir), { force: true });

  // A heartbeat that matches but has stopped beating: the run died, its pid
  // was reused.
  writeFileSync(heartbeatPath(projectDir), JSON.stringify({ token: 'run-3', pid: unrelated.pid }));
  assert.equal(orchestratorLiveness(projectDir, Date.now() + HEARTBEAT_STALE_MS + 5_000), 'gone', 'a stale heartbeat is not a live run');
  rmSync(heartbeatPath(projectDir), { force: true });
  rmSync(orchestratorPidPath(projectDir), { force: true });

  // ── Stop pressed before the first heartbeat ────────────────────────
  //
  // tsx takes a moment to start the orchestrator. A Stop in that window must
  // still reach it rather than orphan the run.
  const { child: starting } = spawnOrchestratorStandIn({ token: 'run-4', heartbeat: false });
  const startingExit = exited(starting);
  recordOrchestratorPid(projectDir, starting.pid, 'run-4');
  assert.equal(orchestratorLiveness(projectDir), 'running', 'a pid recorded moments ago is the run starting up');
  writeRunningState();
  assert.equal(stopPipelineRun(projectDir).warning, undefined);
  await startingExit;

  // ── A record from an older version ─────────────────────────────────
  //
  // A bare pid with no token can be neither confirmed nor ruled out. It is not
  // signalled, the user is told, the record is kept, and the run is paused.
  const { child: legacy } = spawnOrchestratorStandIn({ heartbeat: false });
  writeFileSync(orchestratorPidPath(projectDir), `${legacy.pid}\n`);
  writeRunningState();
  const blind = stopPipelineRun(projectDir);
  assert.equal(blind.success, true, 'Stop still returns');
  assert.match(blind.warning, /older version/, 'and says what it could not do');
  const blindState = JSON.parse(readFileSync(eventsFile, 'utf8'));
  assert.equal(blindState.pipelineStatus, 'paused', 'the run is paused regardless');
  assert.equal(blindState.events.at(-1).type, 'failure', 'the run log carries the warning');
  assert.match(blindState.events.at(-1).text, /may still be running/);
  assert.ok(isAlive(legacy.pid), 'a process that could not be verified is not signalled');
  assert.equal(readOrchestratorPid(projectDir), legacy.pid, 'and its record is kept');
  rmSync(orchestratorPidPath(projectDir), { force: true });

  // ── No record at all ───────────────────────────────────────────────

  writeRunningState();
  assert.equal(stopPipelineRun().success, true, 'stopping with nothing recorded still pauses the run');
  assert.equal(JSON.parse(readFileSync(eventsFile, 'utf8')).pipelineStatus, 'paused');
  assert.ok(isAlive(unrelated.pid));

  // ── Direct chat turns ──────────────────────────────────────────────

  const turn = trackDirectTurn(spawn(process.execPath, ['-e', IDLE], { stdio: 'ignore', windowsHide: true }));
  spawned.push(turn);
  const turnExit = exited(turn);

  const finished = trackDirectTurn(spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true }));
  await new Promise((done) => finished.once('close', done));

  stopPipelineRun(projectDir);
  await turnExit;
  assert.ok(!isAlive(turn.pid), 'a tracked chat turn is ended by handle');
  assert.ok(isAlive(unrelated.pid), 'and still nothing else is');

  console.log('stop scope checks passed');
} finally {
  for (const child of spawned) {
    try {
      if (IS_WINDOWS) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-child.pid, 'SIGKILL');
    } catch {}
    try {
      child.kill('SIGKILL');
    } catch {}
  }
  rmSync(tempRoot, { recursive: true, force: true });
}
