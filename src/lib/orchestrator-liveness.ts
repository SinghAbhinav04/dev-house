/**
 * Knowing whether a recorded orchestrator is still the one we started.
 *
 * A recorded pid outlives the run it belonged to, and pids are reused.
 * Signalling a stale one would hit whatever unrelated process inherited the
 * number, so before Stop touches anything it must confirm the process is
 * still our orchestrator.
 *
 * That used to be `pgrep -g <pgid> -f orchestrator.ts`, which does not exist
 * on Windows (and is not installed on every Linux). Instead the server mints a
 * random token per run and records it with the pid; the orchestrator writes
 * the same token to a heartbeat file every few seconds and removes it on a
 * clean exit. A process is ours only when the pid is alive, the heartbeat
 * carries the run's token, and the heartbeat is fresh. A reused pid fails
 * the freshness test long before it could be mistaken for the run.
 *
 * Both files live in `.claude/`, which no member can write, so a member cannot
 * point Stop at some other process.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { isProcessAlive } from './platform.ts';

export const ORCHESTRATOR_PID_FILE = 'orchestrator.pid';
export const ORCHESTRATOR_HEARTBEAT_FILE = 'orchestrator.heartbeat';
export const HEARTBEAT_INTERVAL_MS = 5_000;
/** Generous: a heartbeat can be delayed by a long synchronous step. */
export const HEARTBEAT_STALE_MS = 90_000;
export const RUN_TOKEN_ENV = 'HACKEROOM_RUN_TOKEN';

export interface OrchestratorRecord {
  pid: number;
  token: string;
  startedAt: string;
}

export function orchestratorPidPath(projectDir: string): string {
  return join(projectDir, '.claude', ORCHESTRATOR_PID_FILE);
}

export function heartbeatPath(projectDir: string): string {
  return join(projectDir, '.claude', ORCHESTRATOR_HEARTBEAT_FILE);
}

function validPid(value: unknown): number | null {
  const pid = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  // Never 0 or 1 or anything negative: as a group id those mean "my own
  // group" and "everything I am allowed to signal".
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

export function recordOrchestrator(projectDir: string, pid: number, token: string): void {
  mkdirSync(join(projectDir, '.claude'), { recursive: true });
  const record: OrchestratorRecord = { pid, token, startedAt: new Date().toISOString() };
  writeFileSync(orchestratorPidPath(projectDir), `${JSON.stringify(record)}\n`);
}

/** The record, or null. A bare pid from an older run is read with no token. */
export function readOrchestratorRecord(projectDir: string): OrchestratorRecord | null {
  const file = orchestratorPidPath(projectDir);
  if (!existsSync(file)) return null;
  let text: string;
  try {
    text = readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const pid = validPid(parsed.pid);
      if (pid === null) return null;
      return { pid, token: typeof parsed.token === 'string' ? parsed.token : '', startedAt: String(parsed.startedAt ?? '') };
    }
  } catch {}
  const pid = validPid(text);
  return pid === null ? null : { pid, token: '', startedAt: '' };
}

export function clearOrchestratorRecord(projectDir: string): void {
  rmSync(orchestratorPidPath(projectDir), { force: true });
}

// ── The orchestrator's side ──────────────────────────────────────────

export function writeHeartbeat(projectDir: string, token: string, pid: number = process.pid): void {
  try {
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    writeFileSync(heartbeatPath(projectDir), JSON.stringify({ token, pid, at: new Date().toISOString() }));
  } catch {}
}

/**
 * Start beating. Returns a stop function. The timer is unref'd so it never
 * keeps the process alive on its own, and the file is removed on exit so a
 * finished run is never mistaken for a live one.
 */
export function startHeartbeat(projectDir: string, token: string): () => void {
  if (!token) return () => {};
  writeHeartbeat(projectDir, token);
  const timer = setInterval(() => writeHeartbeat(projectDir, token), HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  const stop = () => {
    clearInterval(timer);
    try {
      const current = JSON.parse(readFileSync(heartbeatPath(projectDir), 'utf8'));
      if (current?.token === token) rmSync(heartbeatPath(projectDir), { force: true });
    } catch {}
  };
  process.once('exit', stop);
  return stop;
}

// ── The server's side ────────────────────────────────────────────────

export type LivenessVerdict = 'running' | 'gone' | 'unverified';

/**
 * Whether the recorded orchestrator is still ours.
 *
 * - `running`: pid alive, heartbeat fresh and carrying the run's token.
 * - `gone`: nothing alive at that pid, or alive but not ours.
 * - `unverified`: alive, but recorded by an older version with no token, so
 *   it can be neither confirmed nor ruled out.
 */
export function orchestratorLiveness(projectDir: string, now: number = Date.now()): LivenessVerdict {
  const record = readOrchestratorRecord(projectDir);
  if (!record) return 'gone';
  if (!isProcessAlive(record.pid)) return 'gone';
  if (!record.token) return 'unverified';

  try {
    const beat = JSON.parse(readFileSync(heartbeatPath(projectDir), 'utf8'));
    if (beat?.token !== record.token) return 'gone';
    const age = now - statSync(heartbeatPath(projectDir)).mtimeMs;
    return age <= HEARTBEAT_STALE_MS ? 'running' : 'gone';
  } catch {
    // No heartbeat yet. tsx takes a second or two to start the orchestrator,
    // and a Stop pressed in that window must still reach it rather than
    // orphan the run. A pid recorded moments ago and still alive is that run.
    const started = Date.parse(record.startedAt);
    return Number.isFinite(started) && now - started <= STARTUP_GRACE_MS ? 'running' : 'gone';
  }
}

export const STARTUP_GRACE_MS = 30_000;
