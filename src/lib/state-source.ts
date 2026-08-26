/**
 * Where the live state lives, and how to read it safely.
 *
 * Shared by the polling endpoint and the SSE stream so both agree on which
 * file is authoritative and what a normalised state looks like.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { EMPTY_RUNTIME, normalizeRuntime } from './pipeline-runtime.ts';
import { emptyBreakdown, normalizeUsage } from './team/usage.ts';

export const BUILDS_DIR = join(homedir(), 'Builds');
export const STAGING_DIR = join(BUILDS_DIR, '.staging');
export const MANUAL_DIR = join(BUILDS_DIR, '.manual');

export const EMPTY_STATE = {
  concept: '',
  projectDir: '',
  currentPhase: 'concept',
  securityMode: 'fast',
  isolationPolicy: 'ask',
  runGoal: 'full-build',
  runFinalAudit: false,
  stopAfterPhase: 'none',
  pipelineStatus: 'idle',
  activeAgent: '',
  agentStatus: {},
  sessions: {},
  buildComplete: false,
  usage: emptyBreakdown(),
  runtime: { ...EMPTY_RUNTIME },
  events: [] as Array<Record<string, unknown>>,
  auditFindings: [],
  auditDeployPending: false,
  auditActionInFlight: false,
};

const VALID_RESUME_ACTIONS = [
  'none',
  'continue-approved-plan',
  'resume-stalled-turn',
  'audit-send-to-c',
  'audit-dismiss',
  'audit-deploy',
] as const;

const VALID_PIPELINE_STATUSES = [
  'idle',
  'running',
  'paused',
  'awaiting-audit-decision',
  'complete',
  'failed',
] as const;

export function normalizeState(data: Record<string, unknown>) {
  return {
    ...EMPTY_STATE,
    ...data,
    securityMode: data.securityMode === 'strict' ? 'strict' : 'fast',
    // Older state files predate the setting; 'ask' is the safe reading of
    // silence, since it stops rather than relocating a member on its own.
    isolationPolicy: data.isolationPolicy === 'required' ? 'required' : 'ask',
    runGoal: data.runGoal === 'plan-only' ? 'plan-only' : 'full-build',
    runFinalAudit: data.runFinalAudit === true,
    stopAfterPhase: data.stopAfterPhase === 'plan-review' ? 'plan-review' : 'none',
    resumeAction: VALID_RESUME_ACTIONS.includes(data.resumeAction as (typeof VALID_RESUME_ACTIONS)[number])
      ? data.resumeAction
      : 'none',
    resumeActionTarget: typeof data.resumeActionTarget === 'string' ? data.resumeActionTarget : undefined,
    pipelineStatus:
      typeof data.pipelineStatus === 'string' &&
      VALID_PIPELINE_STATUSES.includes(data.pipelineStatus as (typeof VALID_PIPELINE_STATUSES)[number])
        ? data.pipelineStatus
        : data.buildComplete
          ? 'complete'
          : data.currentPhase && data.currentPhase !== 'concept'
            ? 'running'
            : 'idle',
    agentStatus: { ...EMPTY_STATE.agentStatus, ...(data.agentStatus as Record<string, string> | undefined) },
    // Accepts the old flat TokenUsage shape and lifts it into the breakdown.
    usage: normalizeUsage(data.usage),
    // Lifts old state files that only had a singular activeTurn.
    runtime: normalizeRuntime(data.runtime),
    events: Array.isArray(data.events) ? data.events : [],
    auditFindings: Array.isArray(data.auditFindings) ? data.auditFindings : [],
    auditDeployPending: data.auditDeployPending === true,
    auditActionInFlight: data.auditActionInFlight === true,
  };
}

export function findLatestProject(): string | null {
  try {
    const dirs = readdirSync(BUILDS_DIR)
      .filter((name) => name !== '.staging' && name !== '.manual')
      .map((name) => join(BUILDS_DIR, name))
      .filter((p) => {
        try {
          return statSync(p).isDirectory() && statSync(join(p, 'pipeline-events.json')).isFile();
        } catch {
          return false;
        }
      })
      .sort(
        (a, b) => statSync(join(b, 'pipeline-events.json')).mtimeMs - statSync(join(a, 'pipeline-events.json')).mtimeMs
      );

    return dirs[0] || null;
  } catch {
    return null;
  }
}

/**
 * The state file backing a mode right now: manual state, the staging area
 * before a run exists, or the most recent project. Null when there is nothing
 * to read yet.
 */
export function resolveStateFile(mode: string): string | null {
  if (mode === 'manual') {
    const file = join(MANUAL_DIR, 'manual-state.json');
    return existsSync(file) ? file : null;
  }

  const staging = join(STAGING_DIR, 'pipeline-events.json');
  if (existsSync(staging)) return staging;

  const projectDir = findLatestProject();
  return projectDir ? join(projectDir, 'pipeline-events.json') : null;
}

/**
 * A finished or idle project is hidden so the viewer does not resurrect an old
 * run when there is nothing active.
 */
function isVisible(state: ReturnType<typeof normalizeState>): boolean {
  return (
    state.pipelineStatus === 'running' ||
    state.pipelineStatus === 'paused' ||
    state.pipelineStatus === 'awaiting-audit-decision' ||
    state.pipelineStatus === 'failed' ||
    state.pipelineStatus === 'complete' ||
    !!state.buildComplete
  );
}

/**
 * The last state that parsed cleanly, per file.
 *
 * Writers go through `writeJsonAtomic` now, so a torn read should not happen.
 * If one does — a truncated file from an older run, a disk error, a writer that
 * did not use the helper — a stale frame is far better than an empty one: this
 * value is pushed over SSE and applied as a wholesale replace, so returning
 * EMPTY_STATE blanked the entire viewer for a frame.
 */
const lastGoodState = new Map<string, ReturnType<typeof normalizeState>>();

export function readCurrentState(mode: string) {
  const file = resolveStateFile(mode);
  if (!file) return EMPTY_STATE;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return lastGoodState.get(file) ?? EMPTY_STATE;
  }

  const state = normalizeState(raw);
  lastGoodState.set(file, state);

  // Manual and staging states are always shown; only real projects are gated.
  if (mode === 'manual' || file.startsWith(STAGING_DIR)) return state;

  return isVisible(state) ? state : EMPTY_STATE;
}

/** Modification time of the backing file, used to skip unchanged SSE frames. */
export function stateFileMtime(mode: string): number {
  const file = resolveStateFile(mode);
  if (!file) return 0;
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
