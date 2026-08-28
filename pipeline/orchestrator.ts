#!/usr/bin/env npx tsx

/**
 * Pipeline Build Orchestrator (Streaming)
 *
 * Spawns Claude Code sessions and streams all activity to the viewer.
 * You see every tool call, file read/write, and agent response in real-time.
 *
 * Usage:
 *   npx tsx orchestrator.ts "Your build concept here"
 *
 * Viewer (separate terminal):
 *   npx tsx viewer.ts
 *
 * Then open http://localhost:3456
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import {
  clearApprovedBashGrant,
  clearPendingApproval,
  writeApprovedBashGrant,
  waitForPendingApproval,
  writePendingApproval,
  type ApprovedBashGrant,
  type PendingApproval,
} from '../src/lib/pipeline-approval.ts';
import {
  isPositiveSignal,
  isUnparseableSignal,
  parseTextSignal,
} from '../src/lib/pipeline-signal.ts';
import {
  EMPTY_RUNTIME,
  MAX_AUTO_RESUMES,
  MAX_BASH_APPROVAL_RETRIES,
  MAX_CODE_REVIEW_ROUNDS,
  MAX_REVIEW_ROUNDS,
  MAX_TEST_ROUNDS,
  TURN_IDLE_TIMEOUT_MS,
  buildResumePrompt,
  canAutoResumeTurn,
  shouldMarkTurnStalled,
  summarizePrompt,
  describeCurrentTask,
  normalizeRuntime,
  type PipelineRuntimeState,
} from '../src/lib/pipeline-runtime.ts';
import {
  buildPlanningResearchPrompt,
  buildPlanningResearchResumePrompt,
  extractPlanningResearchSummary,
  hasPlanningWriteStarted,
  buildPlanningSelfReviewPrompt,
  buildPlanningSelfReviewResumePrompt,
  buildPlanningWritePrompt,
  buildPlanningWriteResumePrompt,
  detectPlanningStep,
} from '../src/lib/pipeline-planning.ts';
import { createRunner, isRecoverableDockerAuthFailure } from './runner.ts';
import { readRoster } from '../src/lib/team/roster.ts';
import { buildRunPlan, describeRunPlan } from '../src/lib/team/slots.ts';
import { writeTeamManifest } from '../src/lib/team/manifest.ts';
import { memberSpawnOptions } from '../src/lib/team/spawn.ts';
import {
  buildMemorySelection,
  ensureMemoryDirs,
  ingestInbox,
  shouldSendMemoryDelta,
} from '../src/lib/team/memory.ts';
import { writeJsonAtomic } from '../src/lib/atomic-write.ts';
import type { AgentEvent, ResultEvent } from '../src/lib/cli/decoder.ts';
import { findCli, resolveCli } from '../src/lib/cli/registry.ts';
import { installGates } from '../src/lib/cli/gates.ts';
import type { AgentCli } from '../src/lib/cli/types.ts';
import {
  billableTokens,
  emptyBreakdown,
  normalizeUsage,
  createUsageMeter,
  recordUsage,
  usageFromResultEvent,
  type UsageMeter,
  type UsageBreakdown,
} from '../src/lib/team/usage.ts';
import { SLOT_LABELS, type SlotId, type TeamMember } from '../src/lib/team/types.ts';

// ── Config ──────────────────────────────────────────────────────────

const BUILDUI_DIR = resolve(import.meta.dirname || __dirname);
const BUILDS_DIR = join(homedir(), 'Builds');

/**
 * The team roster. Loaded once at startup: who fills which slot, what model
 * and permission mode each member runs on, and which phases run at all.
 * Nothing below names a member — phases resolve slots against this.
 */
const roster = readRoster();
const runPlan = buildRunPlan(roster);

const runner = createRunner();

/** The member filling a slot, or null when the phase is skipped. */
function memberFor(slot: SlotId): TeamMember | null {
  return runPlan.members[slot];
}

/**
 * The member filling a slot, or a thrown error. Used by phases that have
 * already been gated on runPlan.phases, where a missing member is a bug.
 */
function requireMember(slot: SlotId): TeamMember {
  const member = memberFor(slot);
  if (!member) throw new Error(`No member is filling the ${slot} slot.`);
  return member;
}

function slotLabel(slot: SlotId): string {
  const member = memberFor(slot);
  return member ? member.name : SLOT_LABELS[slot];
}

/**
 * The member id filling a slot, for event tags and status keys.
 *
 * Falls back to the slot name when the slot is unfilled so events stay
 * attributable rather than being tagged with an empty string.
 */
function id(slot: SlotId): string {
  return memberFor(slot)?.id ?? slot;
}

/** The slot a member id occupies, or null if it is not on this run. */
function slotOf(memberId: string): SlotId | null {
  for (const slot of Object.keys(runPlan.members) as SlotId[]) {
    if (runPlan.members[slot]?.id === memberId) return slot;
  }
  return null;
}

/** The saved Claude session for whoever fills a slot. */
function sessionFor(slot: SlotId): string | undefined {
  return state.sessions[id(slot)] || undefined;
}

/**
 * The session to resume for a slot that is expected to have one.
 *
 * Sessions are keyed by member id. This used to be read as `state.sessions.C`
 * and friends, left over from when members were fixed letters — which was
 * silently always undefined, so every turn that meant to continue a
 * conversation started a fresh one and re-read the plan and the code from
 * scratch. The emit is the tripwire: if that ever happens again it says so in
 * the log rather than just costing tokens.
 */
function resumeFor(slot: SlotId, why: string): string | undefined {
  const session = sessionFor(slot);
  if (!session) {
    emit('system', state.currentPhase, 'status', `No saved session for ${slotLabel(slot)} — ${why} starts cold`);
  }
  return session;
}

/** Members already warned about their budget, so it is said once, not per turn. */
const budgetWarned = new Set<string>();

/**
 * Usage meters, one per CLI reporting style, shared across the whole run.
 *
 * Run-scoped rather than per-turn on purpose. A CLI that reports a
 * session-cumulative total sends turn one's tokens again on turn two and again
 * on turn three; a meter that forgot between turns would bank the whole
 * conversation every time one resumed, and a ten-turn coding phase would report
 * several times the tokens actually spent.
 *
 * Seeded from the state file so an orchestrator restart mid-run does not
 * re-bank a conversation that was already counted — every audit action spawns a
 * fresh orchestrator against the same run.
 */
const usageMeters = new Map<string, UsageMeter>();

function meterFor(cli: AgentCli): UsageMeter {
  let meter = usageMeters.get(cli.id);
  if (!meter) {
    meter = createUsageMeter(cli.support.usageReporting, state.runtime.usageHighWater);
    usageMeters.set(cli.id, meter);
  }
  return meter;
}

/**
 * Persist the high-water marks. Session keys are unique per session, so
 * merging every meter's snapshot into one map cannot collide.
 */
function saveUsageHighWater(): void {
  for (const meter of usageMeters.values()) {
    Object.assign(state.runtime.usageHighWater, meter.snapshot());
  }
}

/**
 * Warn when a member passes its token budget.
 *
 * Deliberately a warning rather than a hard stop: killing a run mid-coding
 * would leave a half-written project and no way to finish it. The budget is
 * there to tell you a member is more expensive than you expected — the decision
 * to stop is yours.
 */
function noteBudget(member: TeamMember): void {
  if (!member.tokenBudget || member.tokenBudget <= 0) return;
  if (budgetWarned.has(member.id)) return;

  const usage = state.usage.byMember[member.id];
  if (!usage) return;

  const used = billableTokens(usage);
  if (used < member.tokenBudget) return;

  budgetWarned.add(member.id);
  emit(
    'system',
    state.currentPhase,
    'status',
    `${member.name} has used ${used.toLocaleString()} tokens, past its ${member.tokenBudget.toLocaleString()} budget. The run continues — stop it yourself if that is not what you want.`
  );
  emitSupervisor(
    state.currentPhase,
    `${member.name} is over the token budget you set (${used.toLocaleString()} of ${member.tokenBudget.toLocaleString()}). I have not stopped the run, because halting now would leave the work half-finished, but you may want to.`
  );
}

/**
 * Fold the memory inbox into the shared index and report what landed.
 *
 * Runs between turns rather than during one, so the index has a single writer.
 */
function absorbMemoryInbox(who: string): void {
  try {
    const result = ingestInbox(projectDir);
    if (result.added.length === 0) return;

    for (const entry of result.added) {
      emit('system', state.currentPhase, 'status', `${who} recorded [${entry.id}] ${entry.kind}: ${entry.claim}`);
    }
    if (result.archived > 0) {
      emit('system', state.currentPhase, 'status', `Archived ${result.archived} older memory line(s) to keep the index small.`);
    }
  } catch {
    // Memory is an optimisation, never a reason to fail a run.
  }
}

/**
 * Attach the team-memory block to a prompt, scoped to who is about to read it.
 *
 * Two things decide what goes in:
 *
 * - **The job.** Kinds are weighted by slot, and entries whose files overlap
 *   what the turn is about win outright. Recency is only a tiebreak. The old
 *   behaviour — the whole 120-line index, ranked by nothing but age, on every
 *   turn — spent 3-6k tokens a turn telling a coder about decisions it had no
 *   use for.
 *
 * - **What this session has already seen.** A resumed session replays its
 *   transcript, so anything sent on turn one is still there on turn six. Only
 *   the delta goes into a resumed prompt; a cold session gets the full slice
 *   and its record is reset, because a new transcript has seen nothing.
 *
 * That second rule holds only where resuming actually replays the transcript,
 * which is a property of the CLI and not of the run. On an engine that starts a
 * resumed turn without the prior conversation, sending only the delta would
 * silently drop everything the member was told on turn one — no error, nothing
 * in the log, just a member that has forgotten what the team knows. So the CLI
 * is asked rather than assumed.
 */
function attachMemory(
  slot: SlotId,
  agent: string,
  prompt: string,
  isResume: boolean,
  cli: AgentCli
): string {
  try {
    const carriesHistory = shouldSendMemoryDelta(isResume, cli.support.resumeReplaysTranscript);
    const alreadySent = state.runtime.memoryInjected[agent] ?? [];

    const selection = buildMemorySelection(projectDir, {
      slot,
      phase: state.currentPhase,
      exclude: carriesHistory ? alreadySent : [],
    });

    state.runtime.memoryInjected[agent] = carriesHistory
      ? [...alreadySent, ...selection.ids]
      : selection.ids;

    return selection.block ? `${prompt}\n\n${selection.block}` : prompt;
  } catch {
    // Memory is an optimisation, never a reason to fail a turn.
    return prompt;
  }
}

/** Tool lists already checked, so a long roster does not repeat itself. */
const toolsChecked = new Set<string>();

/**
 * Compare what a CLI says it has against what this build knows how to map.
 *
 * Two directions, and they are not equally serious.
 *
 * A tool the CLI offers that we do not map is fine and expected — Antigravity
 * reports 57 of them, most of which no member should be calling. They reach the
 * gate under their own name and are denied by default, which is the intended
 * outcome. Worth one line in the log, nothing more.
 *
 * A tool *we* map that the CLI no longer offers is the rename signal, and it is
 * the dangerous one: deny-by-default still holds, so nothing unsafe happens,
 * but a coder whose `run_command` became `execute_command` cannot run a single
 * command and will spend ten minutes failing quietly instead of saying so.
 */
function announceTools(cli: AgentCli, offered: string[]): void {
  if (toolsChecked.has(cli.id)) return;
  toolsChecked.add(cli.id);

  const available = new Set(offered);
  const mapped = Object.keys(cli.tools.argKeys);
  const missing = mapped.filter((tool) => !available.has(tool));

  emit('system', state.currentPhase, 'status', `${cli.label} offers ${offered.length} tool(s); ${mapped.length} are mapped.`);

  if (missing.length > 0) {
    emit(
      'system',
      state.currentPhase,
      'failure',
      `${cli.label} no longer offers: ${missing.join(', ')} — the tool map is out of date.`
    );
    emitSupervisor(
      state.currentPhase,
      `${cli.label} has renamed or removed ${missing.join(', ')}. Members on it are still safe — anything unrecognised is refused — but they cannot do the things those tools did, so I would rather say so than let the run look busy while achieving nothing.`
    );
  }
}

/** A fresh idle status map keyed by the members actually on this run. */
function idleStatusForTeam(): Record<string, string> {
  const status: Record<string, string> = {};
  for (const member of roster.members) {
    if (member.enabled) status[member.id] = 'idle';
  }
  return status;
}

// ── CLI Args ────────────────────────────────────────────────────────
//
// Two modes:
//   Standalone:  npx tsx orchestrator.ts "Your build concept here"
//   From viewer: npx tsx orchestrator.ts --project-dir /path --a-session SESSION_ID
//

let concept = '';
let projectDir = '';
let existingASession = '';
let securityMode: 'fast' | 'strict' = process.env.PIPELINE_SECURITY_MODE === 'strict' ? 'strict' : 'fast';
let resumingExistingProject = false;

const args = process.argv.slice(2);
const projectDirIdx = args.indexOf('--project-dir');
const aSessionIdx = args.indexOf('--a-session');

if (projectDirIdx !== -1) {
  projectDir = args[projectDirIdx + 1];
  if (aSessionIdx !== -1) existingASession = args[aSessionIdx + 1];
  // Read concept from existing state
  try {
    const existing = JSON.parse(readFileSync(join(projectDir, 'pipeline-events.json'), 'utf8'));
    concept = existing.concept || 'Build from viewer';
    // Keyed by member id, like every other session. The old `sessions.A`
    // lookup dated from fixed-letter members and never matched a real roster,
    // so a resumed run always threw away the planner's concept-phase session.
    if (!existingASession) existingASession = existing.sessions?.[id('planner')] || '';
    if (existing.securityMode === 'strict') securityMode = 'strict';
    // Only treat as a resume if the state has an explicit resume action
    resumingExistingProject =
      existing.resumeAction === 'continue-approved-plan' ||
      existing.resumeAction === 'resume-stalled-turn' ||
      (typeof existing.resumeAction === 'string' && existing.resumeAction.startsWith('audit-'));
  } catch {
    concept = 'Build from viewer';
  }
} else {
  // Standalone mode
  concept = args.join(' ').trim();
  if (!concept) {
    console.error('Usage: npx tsx orchestrator.ts "Your build concept here"');
    console.error('   or: npx tsx orchestrator.ts --project-dir /path --a-session SESSION_ID');
    process.exit(1);
  }

  const projectName = concept
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

  projectDir = join(BUILDS_DIR, projectName);
}

// ── Project Setup ───────────────────────────────────────────────────

mkdirSync(projectDir, { recursive: true });

if (!existsSync(join(projectDir, 'checklist.md'))) {
  copyFileSync(join(BUILDUI_DIR, 'checklist-template.md'), join(projectDir, 'checklist.md'));
}
if (!existsSync(join(projectDir, 'build-plan-template.md'))) {
  copyFileSync(join(BUILDUI_DIR, 'build-plan-template.md'), join(projectDir, 'build-plan-template.md'));
}

// Copy hooks into project so agents pick them up
mkdirSync(join(projectDir, '.claude', 'hooks'), { recursive: true });
copyFileSync(
  join(BUILDUI_DIR, '.claude', 'settings.json'),
  join(projectDir, '.claude', 'settings.json')
);
copyFileSync(
  join(BUILDUI_DIR, '.claude', 'hooks', 'approval-gate.sh'),
  join(projectDir, '.claude', 'hooks', 'approval-gate.sh')
);
// Ensure executable
try { execFileSync('chmod', ['+x', join(projectDir, '.claude', 'hooks', 'approval-gate.sh')]); } catch {}

// The hook resolves member capabilities from this manifest. Written by the
// orchestrator, never by an agent — .claude/ is unwritable from inside a run.
// It goes first because the gate self-test below is driven against it.
writeTeamManifest(projectDir, roster);

// Install and *verify* a gate for every engine on this run. A member whose
// gate cannot be shown to refuse what it should does not run: copying a file
// into place is not evidence that it works, and the failures that matter here
// — a lost executable bit, a missing jq, an argument key that reads empty —
// all look exactly like success until something writes where it should not
// have been able to.
//
// Deliberately no override. "Run my team with nothing enforcing what they may
// do" is not a choice worth offering in a system whose whole premise is that
// the enforcement is real.
{
  const runClis = [...new Set(roster.members.filter((m) => m.enabled).map((m) => m.cli))]
    .map((id) => findCli(id))
    .filter((cli): cli is AgentCli => cli !== null);

  const selfTestMember = roster.members.find((m) => m.enabled)?.id;
  if (selfTestMember) installGates(projectDir, BUILDUI_DIR, runClis, selfTestMember);
}

// Members drop memory entries into .squad/memory/inbox/; the directory must
// exist before the first turn or the write is rejected as an unknown path.
ensureMemoryDirs(projectDir);

// Git init for the project
if (!existsSync(join(projectDir, '.git'))) {
  try {
    execFileSync('git', ['init'], { cwd: projectDir });
    execFileSync('git', ['add', '.'], { cwd: projectDir });
    execFileSync('git', ['commit', '-m', 'Initial project setup'], { cwd: projectDir });
  } catch {}
}

// ── Event System ────────────────────────────────────────────────────

interface PipelineEvent {
  time: string;
  /** A roster member id, or 'system' for orchestrator-generated events. */
  agent: string;
  phase: string;
  type: string;
  text: string;
  detail?: string;
}

type AuditFindingStatus = 'open' | 'sent-to-c' | 're-auditing' | 'resolved' | 'still-open' | 'dismissed';

interface AuditFindingHistoryEntry {
  time: string;
  action: 'created' | 'sent-to-c' | 'fix-applied' | 'fix-failed-tests' | 're-audit-passed' | 're-audit-failed' | 'dismissed';
  note?: string;
}

interface AuditFinding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  text: string;
  status: AuditFindingStatus;
  createdAt: string;
  history: AuditFindingHistoryEntry[];
}

interface PipelineState {
  concept: string;
  projectDir: string;
  currentPhase: string;
  securityMode: 'fast' | 'strict';
  /**
   * What happens when a member that asked to be isolated cannot be.
   *
   * 'ask'      — pause and let the user decide whether to continue on the host
   * 'required' — fail the run instead; the boundary is not negotiable
   *
   * Never silently: losing isolation changes what a member can reach, which is
   * a safety question rather than an availability one.
   */
  isolationPolicy: 'ask' | 'required';
  runGoal: 'full-build' | 'plan-only';
  runFinalAudit: boolean;
  stopAfterPhase: 'none' | 'plan-review';
  pipelineStatus: 'idle' | 'running' | 'paused' | 'awaiting-audit-decision' | 'complete' | 'failed';
  resumeAction?: 'none' | 'continue-approved-plan' | 'resume-stalled-turn' | 'audit-send-to-c' | 'audit-dismiss' | 'audit-deploy';
  resumeActionTarget?: string;
  activeAgent: string;
  agentStatus: Record<string, string>;
  sessions: Record<string, string>;
  buildComplete: boolean;
  usage: UsageBreakdown;
  runtime: PipelineRuntimeState;
  events: PipelineEvent[];
  auditFindings?: AuditFinding[];
  auditDeployPending?: boolean;
  auditActionInFlight?: boolean;
}

const eventsFile = join(projectDir, 'pipeline-events.json');

let state: PipelineState;
if (resumingExistingProject && existsSync(eventsFile)) {
  // Launched from viewer — load existing state (has Phase 0 events + sessions)
  //
  // Guarded: this runs at module scope, before `run()`, so an unhandled throw
  // here kills the process without reaching the fatal handler at the bottom of
  // the file — leaving `pipelineStatus: 'running'` on disk and a viewer showing
  // a live run forever. A resume that cannot read its own state should say so.
  let existing;
  try {
    existing = JSON.parse(readFileSync(eventsFile, 'utf8'));
  } catch (err) {
    console.error(`\n[FATAL] Could not read ${eventsFile}: ${(err as Error).message}`);
    console.error('The run state is unreadable, so there is nothing to resume from.');
    process.exit(1);
  }
  state = {
    concept: existing.concept || concept,
    projectDir: existing.projectDir || projectDir,
    currentPhase: existing.currentPhase || 'concept',
    securityMode: existing.securityMode === 'strict' ? 'strict' : securityMode,
    isolationPolicy: existing.isolationPolicy === 'required' ? 'required' : 'ask',
    runGoal: existing.runGoal === 'plan-only' ? 'plan-only' : 'full-build',
    runFinalAudit: existing.runFinalAudit === true,
    stopAfterPhase: existing.stopAfterPhase === 'plan-review' ? 'plan-review' : 'none',
    pipelineStatus: existing.pipelineStatus || (existing.buildComplete ? 'complete' : 'idle'),
    resumeAction: (['continue-approved-plan', 'resume-stalled-turn', 'audit-send-to-c', 'audit-dismiss', 'audit-deploy'].includes(existing.resumeAction) ? existing.resumeAction : 'none'),
    resumeActionTarget: typeof existing.resumeActionTarget === 'string' ? existing.resumeActionTarget : undefined,
    activeAgent: existing.activeAgent || '',
    agentStatus: existing.agentStatus || idleStatusForTeam(),
    sessions: existing.sessions || {},
    buildComplete: !!existing.buildComplete,
    usage: normalizeUsage(existing.usage),
    runtime: normalizeRuntime(existing.runtime),
    events: existing.events || [],
    auditFindings: Array.isArray(existing.auditFindings) ? existing.auditFindings : [],
    auditDeployPending: existing.auditDeployPending === true,
    auditActionInFlight: existing.auditActionInFlight === true,
  };
} else {
  // Fresh start — but preserve any existing events (concept-phase conversation)
  let existingEvents: PipelineEvent[] = [];
  let existingSessions: Record<string, string> = {};
  let existingUsage: UsageBreakdown = emptyBreakdown();
  let existingRunGoal = 'full-build';
  let existingStopAfterPhase = 'none';
  let existingRunFinalAudit = false;
  let existingIsolationPolicy: 'ask' | 'required' = 'ask';
  if (existsSync(eventsFile)) {
    try {
      const existing = JSON.parse(readFileSync(eventsFile, 'utf8'));
      existingEvents = existing.events || [];
      existingSessions = existing.sessions || {};
      existingUsage = normalizeUsage(existing.usage);
      existingRunGoal = existing.runGoal || existingRunGoal;
      existingStopAfterPhase = existing.stopAfterPhase || existingStopAfterPhase;
      existingRunFinalAudit = existing.runFinalAudit === true;
      if (existing.isolationPolicy === 'required') existingIsolationPolicy = 'required';
      if (existing.securityMode === 'strict') securityMode = 'strict';
    } catch {}
  }
  state = {
    concept,
    projectDir,
    currentPhase: 'concept',
    securityMode,
    isolationPolicy: existingIsolationPolicy,
    runGoal: existingRunGoal === 'plan-only' ? 'plan-only' : 'full-build',
    runFinalAudit: existingRunFinalAudit,
    stopAfterPhase: existingStopAfterPhase === 'plan-review' ? 'plan-review' : 'none',
    pipelineStatus: 'idle',
    resumeAction: 'none',
    resumeActionTarget: undefined,
    activeAgent: '',
    agentStatus: idleStatusForTeam(),
    sessions: existingSessions,
    buildComplete: false,
    usage: existingUsage,
    runtime: { ...EMPTY_RUNTIME },
    events: existingEvents,
    auditFindings: [],
    auditDeployPending: false,
    auditActionInFlight: false,
  };
}

/**
 * Live events kept in the state file. The whole file is re-serialised on every
 * single event, so an unbounded array means every event costs more than the
 * last — a long run ends up rewriting megabytes per tool call. Older events are
 * rolled into numbered archive files, which the viewer can fetch on demand.
 */
const MAX_LIVE_EVENTS = 600;
const EVENTS_ARCHIVE_CHUNK = 300;

let eventsArchiveCount = 0;

function eventsArchivePath(index: number): string {
  return join(projectDir, `pipeline-events.${index}.json`);
}

/** Roll the oldest events out of the live state file into an archive chunk. */
function rotateEventsIfNeeded() {
  if (state.events.length <= MAX_LIVE_EVENTS) return;

  const chunk = state.events.splice(0, EVENTS_ARCHIVE_CHUNK);

  // Find the next free archive index once, then keep counting.
  while (existsSync(eventsArchivePath(eventsArchiveCount))) eventsArchiveCount++;

  try {
    writeFileSync(eventsArchivePath(eventsArchiveCount), JSON.stringify({ events: chunk }, null, 2));
    eventsArchiveCount++;
  } catch {
    // If the archive cannot be written, keep the events in memory rather than
    // losing them — a large state file beats a hole in the log.
    state.events.unshift(...chunk);
  }
}

function flush() {
  rotateEventsIfNeeded();
  writeJsonAtomic(eventsFile, state);
}

function emit(
  agent: PipelineEvent['agent'],
  phase: string,
  type: string,
  text: string,
  detail?: string
) {
  state.events.push({ time: new Date().toISOString(), agent, phase, type, text, detail });
  flush();

  // Terminal output with color
  const time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const colors: Record<string, string> = {
    status: '\x1b[36m', send: '\x1b[33m', receive: '\x1b[33m',
    question: '\x1b[35m', answer: '\x1b[32m', issue: '\x1b[31m',
    fix: '\x1b[32m', approval: '\x1b[1m\x1b[32m', failure: '\x1b[31m',
    tool_call: '\x1b[90m', tool_result: '\x1b[90m', text: '\x1b[37m',
  };
  const c = colors[type] || '\x1b[0m';
  console.log(`${c}[${time}]   ${agent} | ${text}\x1b[0m`);
}

function emitSupervisor(phase: string, text: string) {
  emit(id('supervisor'), phase, 'text', text);
}

function setAgent(agent: string, status: string) {
  state.agentStatus[agent] = status;
  if (status === 'active') state.activeAgent = agent;
  flush();
}

function setPhase(phase: string) {
  state.currentPhase = phase;
  flush();
}

function setPipelineStatus(status: PipelineState['pipelineStatus']) {
  state.pipelineStatus = status;
  flush();
}

function saveSession(agent: string, sessionId: string) {
  state.sessions[agent] = sessionId;
  if (state.runtime.activeTurn?.agent === agent) {
    state.runtime.activeTurn.sessionId = sessionId;
  }
  flush();
}

function shouldStopAfterPlanReview() {
  // runPlan.runGoal, not state.runGoal: a roster with nobody in the coder slot
  // is plan-only whatever the toggle says.
  return state.stopAfterPhase === 'plan-review' || runPlan.runGoal === 'plan-only';
}

function startActiveTurn(agent: string, prompt: string, autoResumeCount: number, resume?: string) {
  const now = new Date().toISOString();
  const turn = {
    agent,
    phase: state.currentPhase,
    status: 'running' as const,
    startedAt: now,
    lastEventAt: now,
    sessionId: resume || state.sessions[agent] || '',
    promptSummary: summarizePrompt(prompt),
    currentTask: describeCurrentTask(slotOf(agent) ?? '', state.currentPhase),
    autoResumeCount,
  };

  // The cursor and the per-member view are the same object, so activity and
  // stall updates land in both without having to be applied twice.
  state.runtime.activeTurn = turn;
  state.runtime.activeTurns[agent] = turn;
  flush();
}

function noteActiveTurnActivity(agent: string) {
  const activeTurn = state.runtime.activeTurn;
  if (!activeTurn || activeTurn.agent !== agent) return;

  activeTurn.lastEventAt = new Date().toISOString();
  if (activeTurn.status === 'stalled') {
    activeTurn.status = 'running';
    delete activeTurn.stalledAt;
    delete activeTurn.stallReason;
  }
  flush();
}

function markActiveTurnStalled(agent: string, reason: string) {
  const activeTurn = state.runtime.activeTurn;
  if (!activeTurn || activeTurn.agent !== agent || activeTurn.status === 'stalled') return;

  activeTurn.status = 'stalled';
  activeTurn.stalledAt = new Date().toISOString();
  activeTurn.stallReason = reason;
  flush();
}

function clearActiveTurn(agent: string) {
  if (state.runtime.activeTurn?.agent !== agent) return;

  // The cursor clears, but the member's last turn is kept so the team view can
  // still say what they were working on rather than going blank between phases.
  const finished = state.runtime.activeTurns[agent];
  if (finished) finished.status = 'running';

  state.runtime.activeTurn = null;
  flush();
}

// ── Tool Permissions ─────────────────────────────────────────────────
//
// Auto mode handles general safety (no mass deletions, no malicious code).
// Role discipline is enforced by the PreToolUse hook, which reads each
// member's capabilities from <project>/.claude/team-manifest.json — written
// by writeTeamManifest() at run start. Nothing here grants permissions; see
// pipeline/.claude/hooks/approval-gate.sh for the clamps that always apply.
//

// ── Streaming Claude Runner ─────────────────────────────────────────

function buildApprovalDescription(toolInput: Record<string, unknown>): string {
  const command = typeof toolInput.command === 'string' ? toolInput.command.trim() : '';
  if (command) return command;
  return JSON.stringify(toolInput);
}

async function runClaudeTurn(
  slot: SlotId,
  prompt: string,
  opts: {
    resume?: string;
    jsonSchema?: Record<string, unknown>;
    autoResumeCount?: number;
    forceHost?: boolean;
  }
): Promise<{
  result: string;
  sessionId: string;
  structured: Record<string, unknown> | null;
  permissionDenied: { toolName: string; toolInput: Record<string, unknown> } | null;
  interruptedForApproval: boolean;
  stalled: boolean;
  fallbackToHost: boolean;
  fallbackReason?: string;
}> {
  return new Promise((resolve, reject) => {
    const member = requireMember(slot);
    const agent = member.id;
    const cli = resolveCli(member.cli);
    const basePrompt = prompt.startsWith('-') ? 'User says: ' + prompt : prompt;

    // What the team already knows, as one line per fact. Detail stays on disk
    // and is read on demand, so this stays cheap as memory grows.
    //
    // Scoped two ways. By slot and phase, because a coder does not need the
    // architecture debate and a reviewer does. And by what this session has
    // already been told — which depends on whether this member's CLI replays
    // its transcript on resume, so the adapter is passed in rather than
    // assumed.
    const safePrompt = attachMemory(slot, agent, basePrompt, !!opts.resume, cli);

    // Model, effort, permission mode, tool capabilities and attached skills all
    // come from the member record — two members in the same run can differ.
    const runnerOpts = {
      ...memberSpawnOptions(roster, member),
      prompt: safePrompt,
      projectDir,
      pipelineDir: BUILDUI_DIR,
      resume: opts.resume,
      jsonSchema: opts.jsonSchema,
      securityMode: state.securityMode,
      // Only the member that owns the plan needs the planning doctrine.
      templateFiles: slot === 'planner'
        ? [
            join(BUILDUI_DIR, 'build-plan-template.md'),
            join(BUILDUI_DIR, 'checklist-template.md'),
          ]
        : undefined,
      forceHost: opts.forceHost,
      // The runner refuses to relocate a required-isolation member to the host
      // even if something above it asks, so the guarantee does not depend on
      // every caller getting the order of checks right.
      requireIsolation: state.isolationPolicy === 'required',
    };
    const child = runner.spawn(runnerOpts);
    const usedDocker = child.backend === 'docker';
    const canFallbackToHost = usedDocker && runner.supportsHostFallback(runnerOpts);

    startActiveTurn(agent, safePrompt, opts.autoResumeCount || 0, opts.resume);

    if (usedDocker) {
      emit('system', state.currentPhase, 'status', `Running ${member.name} in isolated Docker worker.`);
    } else if (member.capabilities?.preferIsolated) {
      // Only reachable once the user has approved it, but the log should say
      // which side of the boundary each turn actually ran on.
      emit('system', state.currentPhase, 'status', `Running ${member.name} on the host — isolation waived for this turn.`);
    }

    let turnResult: ResultEvent | null = null;
    let currentSessionId = opts.resume || '';
    let structured: Record<string, unknown> | null = null;
    // From the adapter, so the member's own CLI decides how its stream is read.
    const decoder = cli.createDecoder();
    // Kept here rather than in the decoder: this is the input the *approval
    // card* replays back to the user, which is a concern of the run rather
    // than of the wire format.
    const toolInputs = new Map<string, Record<string, unknown>>();
    let permissionDenied: { toolName: string; toolInput: Record<string, unknown> } | null = null;
    let interruptedForApproval = false;
    let stalled = false;
    let settled = false;
    let lastStreamActivityAt = Date.now();
    let bashInFlight = false;
    let diagnosticTail = '';

    function noteDiagnostic(text: string) {
      if (!text) return;
      diagnosticTail = `${diagnosticTail}\n${text}`.slice(-12_000);
    }

    const rl = createInterface({ input: child.stdout });
    const stallWatcher = setInterval(() => {
      if (settled) return;
      if (bashInFlight) { lastStreamActivityAt = Date.now(); return; }
      if (!shouldMarkTurnStalled(lastStreamActivityAt, Date.now(), TURN_IDLE_TIMEOUT_MS)) return;

      // Keyed on the slot, not the member id: the question is whether this job
      // can be picked up again, and member ids are user-authored slugs that
      // never match a slot name.
      const canAutoResume = canAutoResumeTurn(slot, state.currentPhase) && !!currentSessionId;
      const reason = canAutoResume
        ? `Agent ${agent} appears stalled. Preserving the session for resume.`
        : `Agent ${agent} appears stalled. Manual intervention may be needed.`;

      markActiveTurnStalled(agent, reason);
      emit('system', state.currentPhase, 'status', reason);

      // Either way the turn is over. A stalled turn that cannot be auto-resumed
      // still has to settle and still has to kill the child — abandoning the
      // promise here leaves the orchestrator waiting on a wedged session with
      // no timeout behind it. `claude()` turns the un-resumable case into a
      // failed run; that is the caller's decision, not this watcher's.
      stalled = true;
      settled = true;
      clearInterval(stallWatcher);
      rl.close();
      resolve({
        result: '',
        // Reported either way. `claude()` re-checks whether the slot may
        // auto-resume before using it, and a preserved id is what makes a
        // manual "resume stalled run" possible after the run gives up.
        sessionId: currentSessionId,
        structured,
        permissionDenied,
        interruptedForApproval,
        stalled,
        fallbackToHost: false,
      });
      child.kill('SIGTERM');
    }, 5_000);

    /**
     * Act on one decoded event. Returns true when the turn is over and the
     * rest of the batch must not be processed.
     *
     * Parsing lives in the decoder; what to *do* about each event stays here,
     * because only the orchestrator can resolve the turn or kill the child.
     * Shared by the line handler and the drain at close, so a decoder that
     * buffers — as one for a CLI streaming text deltas must — is flushed
     * through exactly the same path rather than a second copy of it.
     */
    function handleEvent(decoded: AgentEvent): boolean {
      if (decoded.kind === 'session') {
        currentSessionId = decoded.sessionId || currentSessionId;
        if (currentSessionId) saveSession(agent, currentSessionId);
        return false;
      }

      if (decoded.kind === 'text') {
        emit(agent, state.currentPhase, 'text', decoded.text);
        return false;
      }

      if (decoded.kind === 'tool_call') {
        if (decoded.callId) toolInputs.set(decoded.callId, decoded.input);
        emit(agent, state.currentPhase, 'tool_call', decoded.description, decoded.detail);
        if (decoded.tool === 'Bash') bashInFlight = true;
        return false;
      }

      if (decoded.kind === 'structured') {
        structured = decoded.value;
        return false;
      }

      if (decoded.kind === 'usage') {
        // Banked as it arrives, so a turn killed before its result still
        // accounts for what it spent. The meter is what makes this safe for a
        // CLI reporting a running total: the same reading twice adds nothing.
        recordUsage(state.usage, meterFor(cli).observe(decoded.sessionKey || agent, decoded.reading), {
          memberId: agent,
          model: runnerOpts.model,
        });
        saveUsageHighWater();
        noteBudget(member);
        return false;
      }

      if (decoded.kind === 'tools') {
        announceTools(cli, decoded.tools);
        return false;
      }

      if (decoded.kind === 'tool_result') {
        if (decoded.tool === 'Bash') bashInFlight = false;

        if (decoded.summary) {
          emit(agent, state.currentPhase, 'tool_result', decoded.summary);
        }

        if (!decoded.isError) return false;

        if (decoded.errorText) {
          emit(agent, state.currentPhase, 'permission_denied', decoded.errorText);
        }

        const strictBashAsk =
          state.securityMode === 'strict' &&
          (agent === id('coder') || agent === id('tester')) &&
          decoded.tool === 'Bash';

        if (strictBashAsk && !settled) {
          permissionDenied = {
            toolName: 'Bash',
            toolInput: toolInputs.get(decoded.callId) || {},
          };
          interruptedForApproval = true;
          settled = true;
          clearActiveTurn(agent);
          resolve({
            result: '',
            sessionId: currentSessionId,
            structured,
            permissionDenied,
            interruptedForApproval,
            stalled,
            fallbackToHost: false,
          });
          clearInterval(stallWatcher);
          rl.close();
          child.kill('SIGTERM');
          return true;
        }

        return false;
      }

      if (decoded.kind === 'result') {
        turnResult = decoded;
        if (decoded.text) noteDiagnostic(decoded.text);
        if (decoded.errorText) noteDiagnostic(decoded.errorText);

        // Through the meter, so a CLI reporting a session-cumulative total
        // contributes only what this reading added. For a `delta` CLI this is
        // the identity and costs nothing.
        const reading = usageFromResultEvent(decoded.raw);
        recordUsage(state.usage, meterFor(cli).observe(decoded.sessionId || agent, reading), {
          memberId: agent,
          model: runnerOpts.model,
        });
        saveUsageHighWater();
        noteBudget(member);
        flush();

        const bashDenial = decoded.denials.find((denial) => denial.toolName === 'Bash');
        if (bashDenial) {
          permissionDenied = { toolName: 'Bash', toolInput: bashDenial.toolInput };
        }
      }

      return false;
    }

    rl.on('line', (line) => {
      if (!line.trim()) return;
      noteDiagnostic(line);
      // Liveness is counted per LINE, before decoding, so a decoder that holds
      // events back to batch them cannot be mistaken for a stalled session.
      lastStreamActivityAt = Date.now();
      noteActiveTurnActivity(agent);

      for (const decoded of decoder.push(line)) {
        if (handleEvent(decoded)) return;
      }
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      noteDiagnostic(text);
      lastStreamActivityAt = Date.now();
    });

    child.on('close', (code) => {
      if (settled) return;
      clearInterval(stallWatcher);
      rl.close();

      // Anything the decoder was still holding. Claude's stream ends with an
      // explicit result event so this is empty for it, but a CLI that buffers
      // text deltas would otherwise lose the tail of every turn.
      for (const decoded of decoder.finish()) {
        if (handleEvent(decoded)) return;
      }

      const combinedFailureText = `${diagnosticTail}\n${stderr}\n${turnResult?.text || ''}`;
      if (canFallbackToHost && isRecoverableDockerAuthFailure(combinedFailureText)) {
        settled = true;
        clearActiveTurn(agent);
        resolve({
          result: '',
          sessionId: currentSessionId,
          structured,
          permissionDenied,
          interruptedForApproval,
          stalled,
          fallbackToHost: true,
          fallbackReason: 'Claude subscription auth is unavailable inside the isolated worker right now.',
        });
        return;
      }

      if (code !== 0 || !turnResult) {
        // Settle on the reject path too. Without this a later 'error' event
        // gets past the `if (settled) return` guard and emits a second failure
        // for the same turn.
        settled = true;
        clearActiveTurn(agent);
        emit('system', state.currentPhase, 'failure', `Agent ${agent} failed (exit ${code})`);
        if (stderr) console.error(stderr.slice(0, 500));
        reject(new Error(`Agent ${agent} failed with exit code ${code}`));
        return;
      }

      settled = true;
      clearActiveTurn(agent);
      resolve({
        // From the decoded event, not from its raw payload. Reading
        // `raw.result` and `raw.session_id` here meant the decoder's job
        // stopped at the last step and Claude's wire keys leaked back out —
        // on any other CLI those keys do not exist and both would silently
        // come back empty.
        result: turnResult.text,
        sessionId: turnResult.sessionId || currentSessionId,
        structured,
        permissionDenied,
        interruptedForApproval,
        stalled,
        fallbackToHost: false,
      });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearInterval(stallWatcher);
      rl.close();
      clearActiveTurn(agent);
      emit('system', state.currentPhase, 'failure', `Failed to spawn agent ${agent}: ${err.message}`);
      reject(err);
    });
  });
}

/**
 * Decide what to do when a member that asked to be isolated cannot be.
 *
 * Returns true only when the user has explicitly accepted running that member
 * on the host. Under `isolationPolicy: 'required'` it never asks — the run
 * fails instead. This used to be a `console.warn` and a retry: availability
 * logic applied to a safety boundary, which quietly widened what the coder and
 * the tester could reach.
 */
async function resolveLostIsolation(agent: string, who: string, why: string): Promise<boolean> {
  if (state.isolationPolicy === 'required') {
    emit('system', state.currentPhase, 'failure', `Isolation unavailable for ${who} — run stopped.`);
    emitSupervisor(
      state.currentPhase,
      `I stopped the run. ${why} This run was started with isolation required, so continuing on the host is not something I can decide for you.`
    );
    return false;
  }

  const pending: PendingApproval = {
    requestId: randomUUID(),
    projectDir,
    agent,
    tool: 'Isolation',
    input: { member: who },
    description: `${why}\n\nContinuing runs ${who} on your machine instead, with the hook still enforcing their capabilities but no container around them.`,
    createdAt: new Date().toISOString(),
    approved: null,
    phase: state.currentPhase,
    reason: `Isolation unavailable for ${who}`,
  };

  writePendingApproval(projectDir, pending);
  setPipelineStatus('paused');
  emit('system', state.currentPhase, 'status', `Paused: isolation unavailable for ${who}`);
  emitSupervisor(
    state.currentPhase,
    `I paused the run rather than quietly moving ${who} onto the host. ${why} Approve to continue on the host, or deny to stop here.`
  );

  const approved = await waitForPendingApproval(projectDir, pending.requestId);
  clearPendingApproval(projectDir, pending.requestId);

  if (approved !== true) {
    emit(
      'system',
      state.currentPhase,
      'failure',
      approved === null ? `Isolation decision expired for ${who}` : `Host fallback denied for ${who}`
    );
    emitSupervisor(
      state.currentPhase,
      approved === null
        ? `Nobody answered the isolation question for ${who}, so I stopped rather than assume it was fine.`
        : `You chose not to run ${who} on the host, so I stopped the run there.`
    );
    return false;
  }

  setPipelineStatus('running');
  emit('system', state.currentPhase, 'approval', `Host fallback approved for ${who}`);
  emitSupervisor(
    state.currentPhase,
    `You approved running ${who} on the host for this turn, so the run continues without a container around that member.`
  );
  return true;
}

async function claude(
  slot: SlotId,
  prompt: string,
  opts: {
    resume?: string;
    jsonSchema?: Record<string, unknown>;
    resumePrompt?: string;
    restartOnStall?: boolean;
  }
): Promise<{ result: string; sessionId: string; structured: Record<string, unknown> | null }> {
  const member = requireMember(slot);
  const agent = member.id;
  const who = member.name;

  let currentPrompt = prompt;
  let currentResume = opts.resume;
  let autoResumeCount = 0;
  let forceHost = false;
  let verdictRetried = false;
  let bashApprovalRounds = 0;

  while (true) {
    // Isolation that was asked for and cannot be given is decided before the
    // session starts, not reported after it is already running on the host.
    if (!forceHost) {
      const isolation = runner.isolationStatus({ capabilities: member.capabilities });
      if (isolation.requested && !isolation.available) {
        const allowed = await resolveLostIsolation(
          agent,
          who,
          `${who} is configured to run isolated, but that is not possible right now. ${isolation.reason}`
        );
        if (!allowed) throw new Error(`Isolation unavailable for ${who}`);
        forceHost = true;
      }
    }

    const turn = await runClaudeTurn(slot, currentPrompt, {
      resume: currentResume,
      jsonSchema: opts.jsonSchema,
      autoResumeCount,
      forceHost,
    });

    if (turn.fallbackToHost && !forceHost) {
      const allowed = await resolveLostIsolation(
        agent,
        who,
        turn.fallbackReason || `Isolation for ${who} failed mid-turn.`
      );
      if (!allowed) throw new Error(`Isolation lost for ${who}`);
      forceHost = true;
      continue;
    }

    if (turn.stalled) {
      if (opts.restartOnStall && autoResumeCount < MAX_AUTO_RESUMES) {
        autoResumeCount += 1;
        currentResume = undefined;
        currentPrompt = opts.resumePrompt || currentPrompt;
        emit('system', state.currentPhase, 'status', `Restarting ${who} with a fresh turn after a stalled session`);
        emitSupervisor(
          state.currentPhase,
          `${who} got stuck in a bad session, so I am restarting the current step from the saved context instead of resuming the same loop.`
        );
        continue;
      }

      if (turn.sessionId && canAutoResumeTurn(slot, state.currentPhase) && autoResumeCount < MAX_AUTO_RESUMES) {
        autoResumeCount += 1;
        currentResume = turn.sessionId;
        currentPrompt = opts.resumePrompt || buildResumePrompt(slot, state.currentPhase);
        emit('system', state.currentPhase, 'status', `Resuming ${who} from the saved session`);
        emitSupervisor(
          state.currentPhase,
          `${who} looked stalled, so I resumed the saved session instead of throwing away the run.`
        );
        continue;
      }

      emit('system', state.currentPhase, 'failure', `${who} is stalled and could not be auto-resumed`);
      throw new Error(`${who} stalled`);
    }

    const denied = turn.permissionDenied;
    const strictBashApproval =
      state.securityMode === 'strict' &&
      (agent === id('coder') || agent === id('tester')) &&
      denied?.toolName === 'Bash' &&
      turn.interruptedForApproval;

    if (!strictBashApproval) {
      // A turn that was asked for a verdict and produced nothing readable gets
      // one more chance to answer the question before the phase gives up.
      // Cheaper than failing the run, and it happens in one place rather than
      // at each of the six gates that consume a verdict.
      if (
        opts.jsonSchema &&
        !verdictRetried &&
        !turn.structured &&
        isUnparseableSignal(parseSignal(turn.result))
      ) {
        verdictRetried = true;
        currentResume = turn.sessionId || currentResume;
        currentPrompt = VERDICT_RETRY_PROMPT;
        emit('system', state.currentPhase, 'status', `${who} did not return a readable verdict — asking again`);
        continue;
      }

      // Fold anything this member recorded into the shared index now, while no
      // session is running — the index has exactly one writer by construction.
      absorbMemoryInbox(who);

      return {
        result: turn.result,
        sessionId: turn.sessionId,
        structured: turn.structured,
      };
    }

    // The grant is matched on the exact command string, so a member that keeps
    // re-asking with slightly different whitespace never satisfies it and
    // raises a fresh card every round — each one blocking the run for up to an
    // hour. Bound it rather than trusting the member to give up.
    bashApprovalRounds += 1;
    if (bashApprovalRounds > MAX_BASH_APPROVAL_RETRIES) {
      emit('system', state.currentPhase, 'failure', `${who} asked for Bash approval ${bashApprovalRounds} times without getting past it`);
      emitSupervisor(
        state.currentPhase,
        `${who} keeps asking to run a command and is not getting anywhere with it, so I stopped rather than keep putting the same question in front of you. Either give that member a wider Bash capability on the Team page, or run the run in fast mode.`
      );
      throw new Error(`${who} exceeded the Bash approval retry limit`);
    }

    const pending: PendingApproval = {
      requestId: randomUUID(),
      projectDir,
      agent,
      tool: denied.toolName,
      input: denied.toolInput,
      description: buildApprovalDescription(denied.toolInput),
      createdAt: new Date().toISOString(),
      approved: null,
      sessionId: turn.sessionId,
      phase: state.currentPhase,
      reason: `Strict mode: Agent ${agent} Bash requires approval`,
    };

    writePendingApproval(projectDir, pending);
    emit('system', state.currentPhase, 'status', `Approval requested for Agent ${agent} Bash`);
    emitSupervisor(
      state.currentPhase,
      `I paused the run because strict mode needs your approval before the ${agent === id('coder') ? 'coder' : 'tester'} can run Bash.`
    );

    const approved = await waitForPendingApproval(projectDir, pending.requestId);
    clearPendingApproval(projectDir, pending.requestId);
    clearApprovedBashGrant(projectDir);

    if (approved === null) {
      emit('system', state.currentPhase, 'failure', `Approval request expired for Agent ${agent}`);
      throw new Error(`Approval request expired for Agent ${agent}`);
    }

    emit(
      'system',
      state.currentPhase,
      approved ? 'approval' : 'status',
      approved ? `Approved Agent ${agent} Bash` : `Denied Agent ${agent} Bash`
    );
    emitSupervisor(
      state.currentPhase,
      approved
        ? `You approved the ${agent === id('coder') ? 'coder' : 'tester'} Bash request, so I am letting the run continue.`
        : `You denied the ${agent === id('coder') ? 'coder' : 'tester'} Bash request. I told the team to continue without that command if possible.`
    );

    currentResume = turn.sessionId;
    if (approved) {
      const grant: ApprovedBashGrant = {
        requestId: pending.requestId,
        projectDir,
        agent,
        command: String(denied.toolInput.command || ''),
        createdAt: new Date().toISOString(),
      };
      writeApprovedBashGrant(projectDir, grant);
      currentPrompt = 'The user approved your previous Bash request. Retry that exact command if it is still needed, then continue your task from where you left off.';
    } else {
      currentPrompt = 'The user denied your previous Bash request. Do not retry that command. Continue without it if possible, or explain exactly what is blocked.';
    }
  }
}

// ── JSON Schemas ────────────────────────────────────────────────────

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['approved', 'questions'] },
    questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['status'],
};

const CODE_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['approved', 'issues'] },
    issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['status'],
};

const TEST_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['passed', 'failed'] },
    failures: { type: 'array', items: { type: 'string' } },
  },
  required: ['status'],
};

const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['approved', 'issues'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          finding: { type: 'string' },
        },
        required: ['severity', 'finding'],
      },
    },
  },
  required: ['status'],
};

// ── Helper ──────────────────────────────────────────────────────────

/**
 * Sent when a turn that owed a verdict answered with something unreadable.
 *
 * Deliberately says nothing about what the answer should be — an unparseable
 * turn is a formatting failure, and a retry prompt that hints at a preferred
 * verdict would turn it into a correctness one.
 */
const VERDICT_RETRY_PROMPT = [
  'Your last message did not contain the JSON verdict this step requires.',
  'Do not redo any work. Do not change your conclusion.',
  'Reply with ONLY the JSON object for the verdict you already reached.',
].join('\n');

/**
 * Read a verdict out of a turn's text output, and say so in the log when there
 * isn't one. The parsing itself lives in `pipeline-signal.ts` so it can be
 * tested without booting an orchestrator.
 */
function parseSignal(result: string): Record<string, unknown> {
  const signal = parseTextSignal(result);
  if (isUnparseableSignal(signal)) {
    emit('system', state.currentPhase, 'status', 'Could not parse a verdict from this turn');
  }
  return signal;
}

/**
 * Stop the run when a gate could not read a verdict.
 *
 * `claude()` already gave the member a second chance to answer in JSON, so
 * reaching here means two turns produced nothing readable. Every alternative
 * is worse: treating it as approval certifies unreviewed work, and treating it
 * as a rejection sends an empty issue list round a loop that cannot converge
 * because there is nothing to fix.
 */
function requireVerdict(signal: unknown, who: string, gate: string): Record<string, unknown> {
  if (!isUnparseableSignal(signal)) return signal as Record<string, unknown>;

  emit('system', state.currentPhase, 'failure', `${who} returned no readable verdict for ${gate}`);
  emitSupervisor(
    state.currentPhase,
    `I stopped the run. ${who} finished the ${gate} step but never gave a verdict I could read, twice. I will not record that as a pass — ask me to resume once you have looked at what they actually said.`
  );
  throw new Error(`${who} returned no readable verdict for ${gate}`);
}

/** Most recent concept-phase turns re-fed to the planner, and per-turn cap. */
const PHASE0_MAX_TURNS = 24;
const PHASE0_MAX_CHARS_PER_TURN = 1_200;

/**
 * The concept conversation, replayed for the planner's first prompt.
 *
 * This is the only place a raw transcript is re-fed into a prompt, and it used
 * to be uncapped — a long back-and-forth about an idea was pasted in whole,
 * every character of it, before any planning had happened. It is now bounded on
 * both axes: the most recent turns only, each individually truncated. The
 * user's own messages are kept at full length, since those are the brief.
 */
function buildPhase0Context() {
  const phase0Events = state.events.filter(
    (event) =>
      event.phase === 'concept' &&
      (
        event.type === 'user_msg' ||
        event.type === 'handoff' ||
        ((event.agent === id('planner') || event.agent === id('supervisor')) && event.type === 'text')
      )
  );
  if (phase0Events.length === 0) return '';

  const recent = phase0Events.slice(-PHASE0_MAX_TURNS);
  const omitted = phase0Events.length - recent.length;

  const lines = recent.map((event) => {
    const isUser = event.type === 'user_msg';
    const text = isUser || event.text.length <= PHASE0_MAX_CHARS_PER_TURN
      ? event.text
      : `${event.text.slice(0, PHASE0_MAX_CHARS_PER_TURN)}… [truncated]`;
    return `${event.agent}: ${text}`;
  });

  const preamble = omitted > 0
    ? `Here is the recent Phase 0 concept conversation (${omitted} earlier turn(s) omitted) about what to build:`
    : 'Here is the Phase 0 concept conversation and supervisor context about what to build:';

  return `${preamble}\n\n${lines.join('\n')}\n\n`;
}

async function runPlanningPhase(aSession: string, options?: { resumeStalled?: boolean }): Promise<string> {
  setPhase('planning');
  setPipelineStatus('running');
  setAgent(id('planner'), 'active');
  const phase0Context = buildPhase0Context();
  const existingPlanPath = join(projectDir, 'plan.md');
  let step = detectPlanningStep(state.events, { planExists: existsSync(existingPlanPath), plannerId: id('planner') });
  const resumeSession = aSession || state.runtime.activeTurn?.sessionId || sessionFor('planner');

  if (options?.resumeStalled) {
    emit('system', 'planning', 'status', 'Supervisor resumed A from the saved planning session');
    emitSupervisor('planning', 'I resumed the planner from the saved session so we do not have to throw away the research and start over.');
  }

  if (step === 'research') {
    emit(id('planner'), 'planning', 'status', options?.resumeStalled ? 'Resuming research pass...' : 'Starting research pass...');
    if (options?.resumeStalled) {
      emitSupervisor('planning', 'The planner is finishing the research pass from the saved session.');
    }

    const researchResult = await claude('planner', buildPlanningResearchPrompt(phase0Context, concept), {
      resume: options?.resumeStalled ? resumeSession : undefined,
      resumePrompt: buildPlanningResearchResumePrompt(),
    });
    aSession = researchResult.sessionId;
    saveSession(id('planner'), aSession);

    step = detectPlanningStep(state.events, { planExists: existsSync(existingPlanPath), plannerId: id('planner') });
    if (step === 'research') step = 'write';
  }

  if (step === 'write') {
    const restartWriteFromSummary =
      options?.resumeStalled &&
      !existsSync(existingPlanPath) &&
      hasPlanningWriteStarted(state.events, id('planner'));
    const researchSummary = restartWriteFromSummary ? extractPlanningResearchSummary(state.events, id('planner')) : null;

    emit(id('planner'), 'planning', 'status', 'Writing plan.md...');
    emitSupervisor(
      'planning',
      restartWriteFromSummary
        ? 'The planner got stuck in the old write session, so I am restarting the write step from the verified research summary instead of looping the same resume again.'
        : 'Research is complete. The planner is drafting plan.md now in a dedicated write step so we do not lose the work between research and output.'
    );

    const writeResult = await claude('planner', buildPlanningWritePrompt(projectDir, researchSummary), {
      resume: restartWriteFromSummary ? undefined : (aSession || (options?.resumeStalled ? resumeSession : undefined)),
      resumePrompt: buildPlanningWriteResumePrompt(projectDir, researchSummary),
      restartOnStall: restartWriteFromSummary,
    });
    aSession = writeResult.sessionId;
    saveSession(id('planner'), aSession);

    if (!existsSync(existingPlanPath)) {
      emit(id('planner'), 'planning', 'failure', 'Did not write plan.md');
      throw new Error('The planner did not write plan.md');
    }

    step = detectPlanningStep(state.events, { planExists: true, plannerId: id('planner') });
    if (step !== 'done') step = 'self-review';
  }

  if (step === 'self-review') {
    emit(id('planner'), 'planning', 'status', 'Self-reviewing plan.md...');
    emitSupervisor(
      'planning',
      'The planner has a draft. It is doing one focused self-review pass before handing the plan to the reviewer.'
    );

    const reviewResult = await claude('planner', buildPlanningSelfReviewPrompt(projectDir), {
      resume: aSession || (options?.resumeStalled ? resumeSession : undefined),
      resumePrompt: buildPlanningSelfReviewResumePrompt(projectDir),
    });
    aSession = reviewResult.sessionId;
    saveSession(id('planner'), aSession);

    emit(id('planner'), 'planning', 'status', 'Plan self-review complete');
  }

  if (!existsSync(existingPlanPath)) {
    emit(id('planner'), 'planning', 'failure', 'Did not write plan.md');
    throw new Error('The planner did not write plan.md');
  }

  emit(id('planner'), 'planning', 'status', 'Plan written to plan.md');
  return aSession;
}

async function runPlanReviewPhase(
  aSession: string,
  options?: {
    resumeStalledSlot?: SlotId;
    bSession?: string;
    emitInitialSend?: boolean;
  }
): Promise<{ aSession: string; bSession?: string; reviewRound: number; paused: boolean }> {
  // With no reviewer on the team there is no external approval gate to wait
  // on. The planner's own self-review pass has already run, so the plan is
  // locked here and the run moves straight to coding.
  if (!runPlan.phases.planReview) {
    setPhase('plan-review');
    setPipelineStatus('running');
    emit('system', 'plan-review', 'status', 'No plan reviewer on this team — locking the plan after the planner’s own review.');
    emitSupervisor(
      'plan-review',
      'There is no reviewer assigned, so nobody is poking holes in this plan before we build. I locked it as-is and we are moving to coding.'
    );
    emit(id('planner'), 'plan-review', 'approval', 'PLAN LOCKED');
    return { aSession, bSession: undefined, reviewRound: 0, paused: shouldStopAfterPlanReview() };
  }

  let bSession = options?.bSession || sessionFor('reviewer') || undefined;
  let planApproved = false;
  let reviewRound = state.events.filter(
    (event) => event.agent === id('reviewer') && event.phase === 'plan-review' && event.type === 'status' && /^Review round \d+/.test(event.text)
  ).length;

  setPhase('plan-review');
  setPipelineStatus('running');
  setAgent(id('planner'), 'idle');
  setAgent(id('reviewer'), 'active');

  if (options?.emitInitialSend !== false) {
    emit(id('planner'), 'plan-review', 'send', 'Sent plan to B for review');
    emitSupervisor('plan-review', 'The planner handed the plan to the reviewer. We are still before coding, so this is the right place to catch gaps.');
  }

  if (options?.resumeStalledSlot === 'planner') {
    setAgent(id('reviewer'), 'idle');
    setAgent(id('planner'), 'active');
    emit('system', 'plan-review', 'status', 'Supervisor resumed A during plan review');
    emitSupervisor('plan-review', 'I resumed the planner during review so the plan can keep moving without resetting the whole run.');

    const aResume = await claude('planner', buildResumePrompt('planner', 'plan-review'), {
      resume: aSession || state.runtime.activeTurn?.sessionId || sessionFor('planner'),
    });
    aSession = aResume.sessionId;
    saveSession(id('planner'), aSession);

    emit(id('planner'), 'plan-review', 'answer', 'Answered questions and updated plan');
    emit(id('planner'), 'plan-review', 'send', 'Sent updated plan to B');
    setAgent(id('planner'), 'idle');
    setAgent(id('reviewer'), 'active');
  }

  let nextBPrompt =
    options?.resumeStalledSlot === 'reviewer'
      ? buildResumePrompt('reviewer', 'plan-review')
      : options?.resumeStalledSlot === 'planner'
      ? [
          'A has answered your questions and updated the plan.',
          `Review the updated plan at ${join(projectDir, 'plan.md')} again.`,
          'If you still have concerns, respond with status "questions" and list them.',
          'If the plan is now bulletproof, respond with status "approved".',
          '',
          'Respond with ONLY a JSON object: {"status": "approved"} or {"status": "questions", "questions": ["..."]}',
        ].join('\n')
      : [
          `Review the plan at ${join(projectDir, 'plan.md')}`,
          'Read the entire plan. Look for gaps, unverified assumptions, incomplete code, or anything the coder would need to guess at.',
          '',
          'Be concise. Do NOT summarize or repeat the plan back. Do NOT list what looks good.',
          'Just give your verdict: approved, or list the specific issues.',
          '',
          'Respond with ONLY a JSON object: {"status": "approved"} or {"status": "questions", "questions": ["..."]}',
        ].join('\n');
  let nextBResume = options?.resumeStalledSlot === 'reviewer'
    ? (state.runtime.activeTurn?.sessionId || bSession)
    : bSession;

  while (!planApproved) {
    reviewRound += 1;
    emit(id('reviewer'), 'plan-review', 'status', `Review round ${reviewRound}...`);

    const bResult = await claude('reviewer', nextBPrompt, {
      resume: nextBResume,
      jsonSchema: REVIEW_SCHEMA,
    });
    bSession = bResult.sessionId;
    saveSession(id('reviewer'), bSession);

    const signal = requireVerdict(
      bResult.structured || parseSignal(bResult.result),
      slotLabel('reviewer'),
      'plan review'
    );

    if (isPositiveSignal(signal)) {
      planApproved = true;
      emit(id('reviewer'), 'plan-review', 'approval', 'PLAN APPROVED');
      emitSupervisor('plan-review', 'The reviewer approved the plan. The build doctrine is locked now, so coding can start from a stable contract.');
      setAgent(id('reviewer'), 'done');
      break;
    }

    const questions = (signal.questions as string[]) || [];
    questions.forEach((question, index) => {
      emit(id('reviewer'), 'plan-review', 'question', `Q${index + 1}: ${question}`);
    });

    emit(id('reviewer'), 'plan-review', 'send', `Sent ${questions.length} question(s) to A`);

    // Not approving on exhaustion. A reviewer and a planner that cannot agree
    // in five rounds are not one round away from agreeing, and the plan is the
    // contract everything downstream is built against.
    if (reviewRound >= MAX_REVIEW_ROUNDS) {
      state.activeAgent = '';
      setPipelineStatus('paused');
      emit('system', 'plan-review', 'failure', `Plan review did not converge after ${reviewRound} rounds`);
      emitSupervisor(
        'plan-review',
        `${slotLabel('reviewer')} and ${slotLabel('planner')} have been round the plan ${reviewRound} times without agreeing, so I paused rather than let it run on. The open questions are: ${questions.join(' | ') || 'not stated'}. Read the plan and tell me whether to continue or change the brief.`
      );
      flush();
      return { aSession, bSession, reviewRound, paused: true };
    }

    setAgent(id('planner'), 'active');
    emit(id('planner'), 'plan-review', 'receive', `Received ${questions.length} question(s) from B`);

    const aFollowup = await claude('planner', [
      'The reviewer has questions about your plan:',
      '',
      ...questions.map((question, index) => `${index + 1}. ${question}`),
      '',
      'Answer each question with verified information.',
      `Update ${join(projectDir, 'plan.md')} with any corrections or additions.`,
      'Do not guess. Verify from source.',
    ].join('\n'), { resume: aSession });
    aSession = aFollowup.sessionId;
    saveSession(id('planner'), aSession);

    emit(id('planner'), 'plan-review', 'answer', 'Answered questions and updated plan');
    emit(id('planner'), 'plan-review', 'send', 'Sent updated plan to B');
    setAgent(id('planner'), 'idle');
    setAgent(id('reviewer'), 'active');

    nextBPrompt = [
      'A has answered your questions and updated the plan.',
      `Review the updated plan at ${join(projectDir, 'plan.md')} again.`,
      'If you still have concerns, respond with status "questions" and list them.',
      'If the plan is now bulletproof, respond with status "approved".',
      '',
      'Respond with ONLY a JSON object: {"status": "approved"} or {"status": "questions", "questions": ["..."]}',
    ].join('\n');
    nextBResume = bSession;
  }

  emit(id('planner'), 'plan-review', 'status', 'Plan locked — final, unmodifiable copy');

  if (shouldStopAfterPlanReview()) {
    state.activeAgent = '';
    setPipelineStatus('paused');
    emitSupervisor(
      'plan-review',
      state.runGoal === 'plan-only'
        ? 'Planning is complete and I paused the team before coding, exactly as requested.'
        : 'I paused the team after approved plan review, so you can decide whether to continue into coding.'
    );
    emit(
      'system',
      'plan-review',
      'status',
      state.runGoal === 'plan-only'
        ? 'Plan-only run complete. Supervisor stopped after approved plan review.'
        : 'Supervisor stopped the pipeline after approved plan review.'
    );
    flush();
    return { aSession, bSession, reviewRound, paused: true };
  }

  return { aSession, bSession, reviewRound, paused: false };
}

async function runSecurityAudit(): Promise<{ paused: boolean }> {
  // The audit runs only when a member actually fills the auditor slot; the
  // old runFinalAudit toggle is now one case of an unstaffed slot.
  if (!runPlan.phases.audit) return { paused: false };

  setPhase('security-audit');
  setPipelineStatus('running');
  setAgent(id('auditor'), 'active');
  emit(id('tester'), 'security-audit', 'send', 'Sent reviewed and tested code to E for security audit');
  emit(id('auditor'), 'security-audit', 'receive', 'Received reviewed and tested code from D');
  emit(id('auditor'), 'security-audit', 'status', 'Auditing for OWASP Top 10, path traversal, ReDoS, missing input validation...');
  emitSupervisor(
    'security-audit',
    'Tests passed. The security auditor is doing a final static pass before we hand the build back to you for review.'
  );

  const auditPrompt = [
    `Read the locked plan at ${join(projectDir, 'plan.md')}.`,
    `Then enumerate and read every code file in ${projectDir} that C produced.`,
    'Audit statically for the OWASP Top 10, path traversal, ReDoS, and missing input validation on public boundaries.',
    'Only flag real, exploitable vulnerabilities you can point to with a file and line.',
    'Rank each finding by severity: critical / high / medium / low. Calibrate by exploitability and prerequisites, not by general code quality.',
    '',
    'Respond with ONLY a JSON object: {"status": "approved"} or {"status": "issues", "issues": [{"severity": "...", "finding": "[file/line] type: description and fix"}]}',
  ].join('\n');

  const auditResult = await claude('auditor', auditPrompt, {
    jsonSchema: AUDIT_SCHEMA,
  });
  saveSession(id('auditor'), auditResult.sessionId);

  // An unreadable audit must never reach the `findings.length === 0` branch
  // below, which announces AUDIT CLEAN. Silence is not a clean bill of health.
  const signal = requireVerdict(
    auditResult.structured || parseSignal(auditResult.result),
    slotLabel('auditor'),
    'the security audit'
  );
  const findings: AuditFinding[] = [];

  if (!isPositiveSignal(signal)) {
    const rawIssues = Array.isArray(signal.issues) ? signal.issues : [];
    const validSeverities: AuditFinding['severity'][] = ['critical', 'high', 'medium', 'low'];
    const nowIso = new Date().toISOString();
    for (const raw of rawIssues) {
      let severity: AuditFinding['severity'] = 'medium';
      let text = '';
      if (typeof raw === 'string') {
        // Defensive: legacy bare-string shape. Default severity to medium.
        text = raw;
      } else if (raw && typeof raw === 'object') {
        const obj = raw as { severity?: unknown; finding?: unknown };
        if (typeof obj.severity === 'string' && validSeverities.includes(obj.severity as AuditFinding['severity'])) {
          severity = obj.severity as AuditFinding['severity'];
        }
        if (typeof obj.finding === 'string') {
          text = obj.finding;
        }
      }
      if (!text) continue;
      findings.push({
        id: `finding-${randomUUID().slice(0, 8)}`,
        severity,
        text,
        status: 'open',
        createdAt: nowIso,
        history: [{ time: nowIso, action: 'created' }],
      });
    }
  }

  state.auditFindings = findings;
  state.auditDeployPending = true;
  setPipelineStatus('awaiting-audit-decision');
  setAgent(id('auditor'), 'done');

  if (findings.length === 0) {
    emit(id('auditor'), 'security-audit', 'approval', 'AUDIT CLEAN — no findings');
    emitSupervisor(
      'security-audit',
      'Audit is clean — no exploitable vulnerabilities found. Click Deploy in the Security Audit panel when you are ready to finish the build.'
    );
  } else {
    findings.forEach((f) => {
      emit(id('auditor'), 'security-audit', 'issue', `[${f.severity}] ${f.text}`);
    });
    const counts = findings.reduce((acc, f) => {
      acc[f.severity] = (acc[f.severity] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    const summaryParts = (['critical', 'high', 'medium', 'low'] as const)
      .filter((s) => counts[s])
      .map((s) => `${counts[s]} ${s}`);
    emitSupervisor(
      'security-audit',
      `Audit found ${findings.length} finding${findings.length === 1 ? '' : 's'} (${summaryParts.join(', ')}). Waiting on your review — decide per finding in the Security Audit panel, then click Deploy.`
    );
  }

  flush();
  return { paused: true };
}

async function runDeployStep(aSession: string): Promise<string> {
  setPhase('deploy');
  setAgent(id('planner'), 'active');
  emit(id('tester'), 'deploy', 'send', 'Sent reviewed + tested code to A');
  emit(id('planner'), 'deploy', 'receive', 'Received final code from D');
  emit(id('planner'), 'deploy', 'status', 'Deploying...');

  const aDeployResult = await claude('planner', [
    'The code has been reviewed and tested by the tester. Everything passed.',
    'Do not use Bash or git. The orchestrator will handle any final commit.',
    'Confirm the build is complete and mention any environment caveats the user should know.',
  ].join('\n'), { resume: aSession });
  aSession = aDeployResult.sessionId;
  saveSession(id('planner'), aSession);

  setAgent(id('planner'), 'done');
  setPhase('complete');
  setPipelineStatus('complete');
  state.buildComplete = true;
  emit(id('planner'), 'deploy', 'approval', 'BUILD COMPLETE');
  emitSupervisor('complete', 'The team finished the build. You can inspect the output now or jump into any specialist chat for follow-up work.');

  try {
    execFileSync('git', ['add', '.'], { cwd: projectDir });
    execFileSync('git', ['commit', '-m', `Build complete: ${concept.slice(0, 50)}`], { cwd: projectDir });
    emit('system', 'complete', 'status', 'Code committed to git');
  } catch {}

  try {
    const files = readdirSync(projectDir);
    const htmlFile = files.find((file) => file === 'index.html') || files.find((file) => file.endsWith('.html'));
    if (htmlFile) {
      execFileSync('open', [join(projectDir, htmlFile)]);
      emit('system', 'complete', 'status', `Opened ${htmlFile}`);
    }
  } catch {}

  return aSession;
}

// ── Audit action handlers (user-initiated fix/dismiss/deploy after audit pause) ──

async function runAuditFixPass(findingId: string): Promise<void> {
  const findings = state.auditFindings || [];
  const finding = findings.find((f) => f.id === findingId);
  if (!finding) {
    emit('system', 'security-audit', 'issue', `Requested fix for unknown finding ${findingId} — ignored.`);
    return;
  }
  if (finding.status === 'resolved' || finding.status === 'dismissed') {
    emit('system', 'security-audit', 'status', `Finding ${findingId} already ${finding.status} — skipping fix.`);
    return;
  }

  const nowIso = () => new Date().toISOString();

  finding.status = 'sent-to-c';
  finding.history.push({ time: nowIso(), action: 'sent-to-c' });
  setPhase('security-audit');
  setAgent(id('coder'), 'active');
  emit(id('auditor'), 'security-audit', 'send', `Finding ${finding.id} sent to C for a scoped fix: ${finding.text}`);
  emitSupervisor('security-audit', `C is applying a scoped fix for finding ${finding.id} (${finding.severity}).`);
  flush();

  // The coder wrote this code. Resuming is what lets it fix the finding
  // instead of rediscovering its own build from the filesystem.
  const cSession = resumeFor('coder', 'the scoped fix');
  const cPrompt = [
    'The auditor flagged a security finding that the user asked you to fix.',
    'Fix ONLY this finding. Do not touch anything else. Do not modify plan.md.',
    'The rest of the codebase has passed review and testing — keep it that way.',
    '',
    `Finding: ${finding.text}`,
    '',
    'When you are done, confirm what you changed in one sentence.',
  ].join('\n');
  const cResult = await claude('coder', cPrompt, { resume: cSession });
  saveSession(id('coder'), cResult.sessionId);
  finding.history.push({ time: nowIso(), action: 'fix-applied' });
  emit(id('coder'), 'security-audit', 'fix', `Applied scoped fix for ${finding.id}`);
  setAgent(id('coder'), 'done');
  flush();

  setAgent(id('tester'), 'active');
  const dSession = resumeFor('tester', 'the regression check');
  const dPrompt = [
    `the coder applied a scoped security fix for this finding: "${finding.text}"`,
    'Run the existing tests. Confirm nothing regressed.',
    '',
    'Respond with ONLY: {"status": "passed"} or {"status": "failed", "failures": ["..."]}',
  ].join('\n');
  const dResult = await claude('tester', dPrompt, { resume: dSession, jsonSchema: TEST_SCHEMA });
  saveSession(id('tester'), dResult.sessionId);
  // No requireVerdict here on purpose. This pass is one-shot and user-driven,
  // so an unreadable verdict already fails closed through the branch below —
  // the finding goes back to Open and the user decides. Throwing instead would
  // abort a fix pass over a formatting problem.
  const dSignal = dResult.structured || parseSignal(dResult.result);
  setAgent(id('tester'), 'done');

  if (!isPositiveSignal(dSignal)) {
    const failures = Array.isArray(dSignal.failures) ? (dSignal.failures as string[]) : [];
    const failureNote = failures.length ? failures.join(' | ') : 'Tests failed without structured failure details.';
    finding.status = 'open';
    finding.history.push({ time: nowIso(), action: 'fix-failed-tests', note: failureNote });
    emit(id('tester'), 'security-audit', 'failure', `Fix for ${finding.id} broke tests: ${failureNote}`);
    emitSupervisor('security-audit', `C's fix for ${finding.id} broke tests. The finding is back to Open — decide whether to retry, dismiss, or ignore.`);
    flush();
    return;
  }

  finding.status = 're-auditing';
  setAgent(id('auditor'), 'active');
  emit(id('tester'), 'security-audit', 'send', `Fix for ${finding.id} passed tests. Sending to E for re-audit.`);
  flush();

  // Unlike the first audit, a re-audit must resume: "is this the same
  // vulnerability I raised" is a question only the session that raised it can
  // answer.
  const eSession = resumeFor('auditor', 're-auditing this finding');
  const ePrompt = [
    'Re-audit ONLY this finding after a scoped fix was applied.',
    `Original finding: ${finding.text}`,
    'Read only the file(s) this finding referenced. Confirm whether the vulnerability is closed.',
    '',
    'Respond with ONLY the same JSON schema: {"status": "approved"} or {"status": "issues", "issues": [{"severity": "...", "finding": "[file/line] type: description and fix"}]}',
  ].join('\n');
  const eResult = await claude('auditor', ePrompt, { resume: eSession, jsonSchema: AUDIT_SCHEMA });
  saveSession(id('auditor'), eResult.sessionId);
  // Same reasoning as the test verdict above: unreadable leaves the finding
  // still-open rather than resolving it, which is the safe direction here.
  const eSignal = eResult.structured || parseSignal(eResult.result);
  setAgent(id('auditor'), 'done');

  if (isPositiveSignal(eSignal)) {
    finding.status = 'resolved';
    finding.history.push({ time: nowIso(), action: 're-audit-passed' });
    emit(id('auditor'), 'security-audit', 'approval', `Finding ${finding.id} resolved ✓`);
    emitSupervisor('security-audit', `Finding ${finding.id} is resolved. Back to your review.`);
  } else {
    const rawIssues = Array.isArray(eSignal.issues) ? eSignal.issues : [];
    const firstIssue = rawIssues[0];
    let newText = finding.text;
    if (firstIssue) {
      if (typeof firstIssue === 'string') {
        newText = firstIssue;
      } else if (typeof firstIssue === 'object' && typeof (firstIssue as { finding?: unknown }).finding === 'string') {
        newText = (firstIssue as { finding: string }).finding;
      }
    }
    finding.status = 'still-open';
    finding.text = newText;
    finding.history.push({ time: nowIso(), action: 're-audit-failed', note: newText });
    emit(id('auditor'), 'security-audit', 'issue', `Finding ${finding.id} still open: ${newText}`);
    emitSupervisor('security-audit', `Finding ${finding.id} is still open after C's fix. Decide whether to retry, dismiss, or ignore.`);
  }
  flush();
}

function dismissAuditFinding(findingId: string): void {
  const finding = (state.auditFindings || []).find((f) => f.id === findingId);
  if (!finding) {
    emit('system', 'security-audit', 'issue', `Requested dismiss for unknown finding ${findingId} — ignored.`);
    return;
  }
  finding.status = 'dismissed';
  finding.history.push({ time: new Date().toISOString(), action: 'dismissed' });
  emit('system', 'security-audit', 'dismissal', `User dismissed finding ${finding.id} (${finding.severity}): ${finding.text}`);
  emitSupervisor('security-audit', `Finding ${finding.id} dismissed.`);
  flush();
}

async function runAuditDeploy(): Promise<void> {
  state.auditDeployPending = false;
  setPipelineStatus('running');
  const findings = state.auditFindings || [];
  const resolved = findings.filter((f) => f.status === 'resolved').length;
  const dismissed = findings.filter((f) => f.status === 'dismissed').length;
  const stillOpen = findings.filter((f) =>
    f.status === 'open' ||
    f.status === 'still-open' ||
    f.status === 'sent-to-c' ||
    f.status === 're-auditing'
  ).length;
  emitSupervisor(
    'security-audit',
    `Deploying. Findings: ${resolved} resolved, ${dismissed} dismissed, ${stillOpen} still open.`
  );

  const aSession = resumeFor('planner', 'the deploy confirmation') || '';
  await runDeployStep(aSession);
}

async function handleAuditAction(): Promise<void> {
  const action = state.resumeAction;
  const targetId = state.resumeActionTarget;

  try {
    switch (action) {
      case 'audit-send-to-c':
        if (targetId) await runAuditFixPass(targetId);
        break;
      case 'audit-dismiss':
        if (targetId) dismissAuditFinding(targetId);
        break;
      case 'audit-deploy':
        await runAuditDeploy();
        break;
    }
  } finally {
    state.resumeAction = 'none';
    state.resumeActionTarget = undefined;
    state.auditActionInFlight = false;
    flush();
  }
}

async function runBuildFromCoding(aSession: string): Promise<{ aSession: string; codeReviewRound: number; testRound: number }> {
  setPhase('coding');
  setPipelineStatus('running');
  setAgent(id('coder'), 'active');
  emit(id('planner'), 'coding', 'send', 'Sent approved plan to C');
  emit(id('coder'), 'coding', 'receive', 'Received approved plan from A');
  emit(id('coder'), 'coding', 'status', 'Building...');
  emitSupervisor('coding', 'The coder is implementing the approved plan now. At this point the goal is execution, not re-deciding the design.');

  const cResult = await claude('coder', [
    `Read the approved plan at ${join(projectDir, 'plan.md')}`,
    'Build exactly what it says. Every file, every modification, every special case.',
    'Do not improvise. Do not interpret. Do not "improve."',
    'Do not modify plan.md — it is locked.',
    'Do NOT use the Agent tool. Do NOT spawn sub-agents. Build everything yourself.',
    '',
    'When you are done, confirm what you built.',
  ].join('\n'), {});
  let cSession = cResult.sessionId;
  saveSession(id('coder'), cSession);

  emit(id('coder'), 'coding', 'status', 'Finished coding');

  // Code review and testing both belong to the tester slot, so an unstaffed or
  // switched-off tester skips both loops and the build goes straight to the
  // auditor or to deploy.
  if (runPlan.phases.codeReview) {
    setPhase('code-review');
    setAgent(id('coder'), 'idle');
    setAgent(id('tester'), 'active');
    emit(id('coder'), 'code-review', 'send', `Sent code to ${slotLabel('tester')} for review`);
    emit(id('tester'), 'code-review', 'receive', `Received code from ${slotLabel('coder')}`);
    emitSupervisor('code-review', 'The tester is reviewing the coder output against the approved plan before we trust the build.');
  } else {
    setAgent(id('coder'), 'idle');
    emit('system', 'coding', 'status', 'No tester on this team — skipping code review and testing.');
    emitSupervisor(
      'coding',
      'There is no tester on this run, so nothing reviewed or exercised the code the coder just wrote. Worth checking it yourself before you ship it.'
    );
  }

  let dSession: string | undefined;
  let codeApproved = !runPlan.phases.codeReview;
  let codeReviewRound = 0;

  while (!codeApproved) {
    codeReviewRound += 1;

    const dPrompt = dSession
      ? [
          'C has applied fixes to the code.',
          `Review the code again against the plan at ${join(projectDir, 'plan.md')}`,
          'Respond with ONLY a JSON object: {"status": "approved"} or {"status": "issues", "issues": ["..."]}',
        ].join('\n')
      : [
          `Read the plan at ${join(projectDir, 'plan.md')}`,
          'Read the code that C wrote.',
          'Check: does the code match the plan? Every item accounted for?',
          '',
          'Respond with ONLY a JSON object: {"status": "approved"} or {"status": "issues", "issues": ["..."]}',
        ].join('\n');

    emit(id('tester'), 'code-review', 'status', `Code review round ${codeReviewRound}...`);

    const dResult = await claude('tester', dPrompt, {
      resume: dSession,
      jsonSchema: CODE_REVIEW_SCHEMA,
    });
    dSession = dResult.sessionId;
    saveSession(id('tester'), dSession);

    const signal = requireVerdict(
      dResult.structured || parseSignal(dResult.result),
      slotLabel('tester'),
      'code review'
    );

    if (isPositiveSignal(signal)) {
      codeApproved = true;
      emit(id('tester'), 'code-review', 'approval', 'CODE APPROVED');
    } else {
      const issues = (signal.issues as string[]) || [];

      issues.forEach((issue, index) => {
        emit(id('tester'), 'code-review', 'issue', `Issue ${index + 1}: ${issue}`);
      });

      emit(id('tester'), 'code-review', 'send', `Sent ${issues.length} issue(s) to C`);

      // Same reasoning as plan review: a loop that has not converged in five
      // rounds is not converging, and there is real code on disk that someone
      // should look at before another automated pass rewrites it again.
      if (codeReviewRound >= MAX_CODE_REVIEW_ROUNDS) {
        state.activeAgent = '';
        setPipelineStatus('paused');
        emit('system', 'code-review', 'failure', `Code review did not converge after ${codeReviewRound} rounds`);
        emitSupervisor(
          'code-review',
          `${slotLabel('tester')} and ${slotLabel('coder')} have been round the code ${codeReviewRound} times without agreeing, so I paused. Still open: ${issues.join(' | ') || 'not stated'}. The code is on disk if you want to look before deciding.`
        );
        flush();
        return { aSession, codeReviewRound, testRound: 0 };
      }

      setAgent(id('coder'), 'active');
      emit(id('coder'), 'code-review', 'receive', `Received ${issues.length} issue(s) from D`);

      const cReviewFollowup = await claude('coder', [
        'The tester found issues with your code:',
        '',
        ...issues.map((issue, index) => `${index + 1}. ${issue}`),
        '',
        'Fix each issue. Do not modify plan.md.',
      ].join('\n'), { resume: cSession });
      cSession = cReviewFollowup.sessionId;
      saveSession(id('coder'), cSession);

      emit(id('coder'), 'code-review', 'fix', 'Applied fixes');
      emit(id('coder'), 'code-review', 'send', 'Sent fixed code to D');
      setAgent(id('coder'), 'idle');
    }
  }

  if (runPlan.phases.testing) {
    setPhase('testing');
    emit(id('tester'), 'testing', 'status', 'Moving to testing...');
    emitSupervisor('testing', 'Code review is done. The tester is now running the build and checking whether it actually behaves the way the plan says it should.');
  }

  let testsPassed = !runPlan.phases.testing;
  let testRound = 0;

  while (!testsPassed) {
    testRound += 1;

    const testPrompt = testRound === 1
      ? [
          'Code review is complete. Now test the code.',
          'Run it. Confirm it actually works — not just that it looks right.',
          `Test all functionality against the plan at ${join(projectDir, 'plan.md')}`,
          '',
          'Respond with ONLY a JSON object: {"status": "passed"} or {"status": "failed", "failures": ["..."]}',
        ].join('\n')
      : [
          'C has applied fixes for the test failures.',
          'Re-test the code.',
          'Respond with ONLY a JSON object: {"status": "passed"} or {"status": "failed", "failures": ["..."]}',
        ].join('\n');

    emit(id('tester'), 'testing', 'status', `Test round ${testRound}...`);

    const testResult = await claude('tester', testPrompt, {
      resume: dSession!,
      jsonSchema: TEST_SCHEMA,
    });
    dSession = testResult.sessionId;
    saveSession(id('tester'), dSession);

    const signal = requireVerdict(
      testResult.structured || parseSignal(testResult.result),
      slotLabel('tester'),
      'testing'
    );

    if (isPositiveSignal(signal)) {
      testsPassed = true;
      emit(id('tester'), 'testing', 'approval', 'ALL TESTS PASSED');
      setAgent(id('tester'), 'done');
    } else {
      const failures = (signal.failures as string[]) || [];

      failures.forEach((failure, index) => {
        emit(id('tester'), 'testing', 'failure', `Failure ${index + 1}: ${failure}`);
      });

      emit(id('tester'), 'testing', 'send', `Sent ${failures.length} failure(s) to C`);

      // Tests that still fail after five fix rounds are telling you something
      // the coder cannot fix by trying harder — a bad assumption in the plan,
      // or a dependency that is not there. Pause and say so.
      if (testRound >= MAX_TEST_ROUNDS) {
        state.activeAgent = '';
        setPipelineStatus('paused');
        emit('system', 'testing', 'failure', `Tests did not pass after ${testRound} rounds`);
        emitSupervisor(
          'testing',
          `${slotLabel('coder')} has had ${testRound} attempts at these failures and they are still failing, so I paused instead of going round again. Still failing: ${failures.join(' | ') || 'not stated'}. This usually means the plan assumed something that is not true.`
        );
        flush();
        return { aSession, codeReviewRound, testRound };
      }

      setAgent(id('coder'), 'active');
      emit(id('coder'), 'testing', 'receive', `Received ${failures.length} failure(s) from D`);

      const cTestFollowup = await claude('coder', [
        'The tester found test failures:',
        '',
        ...failures.map((failure, index) => `${index + 1}. ${failure}`),
        '',
        'Fix each failure. Do not modify plan.md.',
      ].join('\n'), { resume: cSession });
      cSession = cTestFollowup.sessionId;
      saveSession(id('coder'), cSession);

      emit(id('coder'), 'testing', 'fix', 'Applied fixes');
      emit(id('coder'), 'testing', 'send', 'Sent fixed code to D');
      setAgent(id('coder'), 'done');
    }
  }

  const auditOutcome = await runSecurityAudit();
  if (auditOutcome.paused) {
    // Orchestrator exits here. User actions drive the rest via /api/audit-action
    // which spawns a fresh orchestrator that routes through handleAuditAction().
    return { aSession, codeReviewRound, testRound };
  }

  aSession = await runDeployStep(aSession);

  return { aSession, codeReviewRound, testRound };
}

// ════════════════════════════════════════════════════════════════════
//  PIPELINE EXECUTION
// ════════════════════════════════════════════════════════════════════

async function run() {
  console.log('\n\x1b[1m╔══════════════════════════════════════════╗');
  console.log('║     PIPELINE BUILD ORCHESTRATOR (LIVE)     ║');
  console.log('╚══════════════════════════════════════════╝\x1b[0m');
  console.log(`\n  Concept:  ${concept}`);

  if (typeof state.resumeAction === 'string' && state.resumeAction.startsWith('audit-')) {
    console.log(`  Audit action: ${state.resumeAction}${state.resumeActionTarget ? ` (${state.resumeActionTarget})` : ''}\n`);
    await handleAuditAction();
    return;
  }
  console.log(`  Project:  ${projectDir}`);
  console.log(`  Team:     ${describeRunPlan(runPlan)}`);
  console.log(`  Viewer:   http://localhost:3456\n`);

  // A roster that cannot staff the run fails loudly here rather than part-way
  // through a phase with nobody to hand the work to.
  if (!runPlan.ok) {
    for (const error of runPlan.errors) {
      emit('system', state.currentPhase || 'concept', 'failure', error);
      emitSupervisor(state.currentPhase || 'concept', error);
      console.error(`\x1b[31m${error}\x1b[0m`);
    }
    setPipelineStatus('failed');
    return;
  }

  emit('system', state.currentPhase || 'concept', 'status', `Team for this run — ${describeRunPlan(runPlan)}`);

  // Skipped phases are announced up front so the run's shape is visible in the
  // event log rather than being inferred from what never happened.
  for (const note of runPlan.notes) {
    emit('system', state.currentPhase || 'concept', 'status', note);
  }

  let aSession = existingASession;
  let reviewRound = 0;
  let codeReviewRound = 0;
  let testRound = 0;

  if (existingASession && !resumingExistingProject) {
    emit('system', 'concept', 'status', `Build concept: ${concept}`);
    emit('system', 'concept', 'status', 'Starting pipeline...');
  } else if (!resumingExistingProject) {
    setPhase('concept');
    emit('system', 'concept', 'status', `Build concept: ${concept}`);
  } else {
    emit('system', state.currentPhase || 'concept', 'status', 'Resuming existing pipeline state');
    emitSupervisor(state.currentPhase || 'concept', 'I am resuming the existing team state from the last saved checkpoint.');
  }

  const initialPipelineStatus = state.pipelineStatus;
  const initialResumeAction = state.resumeAction || 'none';
  state.resumeAction = 'none';
  flush();
  setPipelineStatus('running');

  const stalledTurn = state.runtime.activeTurn?.status === 'stalled' ? state.runtime.activeTurn : null;

  if (initialResumeAction === 'continue-approved-plan' && state.currentPhase === 'plan-review') {
    emit('system', 'plan-review', 'status', 'Continuing from the approved plan');
    emitSupervisor('plan-review', 'I am continuing from the approved plan and handing the work into coding now.');
  } else if (initialPipelineStatus === 'paused' && state.currentPhase === 'plan-review') {
    emit('system', 'plan-review', 'status', 'Continuing from the approved plan');
    emitSupervisor('plan-review', 'The plan was already approved and paused. I am continuing the build from that checkpoint now.');
  } else if (initialResumeAction === 'resume-stalled-turn' && stalledTurn?.agent === id('planner') && stalledTurn.phase === 'planning') {
    aSession = await runPlanningPhase(aSession, { resumeStalled: true });
    const review = await runPlanReviewPhase(aSession);
    reviewRound = review.reviewRound;
    if (review.paused) return;
    aSession = review.aSession;
  } else if (initialResumeAction === 'resume-stalled-turn' && stalledTurn?.phase === 'plan-review' && (stalledTurn.agent === id('planner') || stalledTurn.agent === id('reviewer'))) {
    const review = await runPlanReviewPhase(aSession, {
      resumeStalledSlot: slotOf(stalledTurn.agent) ?? undefined,
      bSession: sessionFor('reviewer'),
      emitInitialSend: false,
    });
    reviewRound = review.reviewRound;
    if (review.paused) return;
    aSession = review.aSession;
  } else if (stalledTurn?.agent === id('planner') && stalledTurn.phase === 'planning') {
    aSession = await runPlanningPhase(aSession, { resumeStalled: true });
    const review = await runPlanReviewPhase(aSession);
    reviewRound = review.reviewRound;
    if (review.paused) return;
    aSession = review.aSession;
  } else if (stalledTurn?.phase === 'plan-review' && (stalledTurn.agent === id('planner') || stalledTurn.agent === id('reviewer'))) {
    const review = await runPlanReviewPhase(aSession, {
      resumeStalledSlot: slotOf(stalledTurn.agent) ?? undefined,
      bSession: sessionFor('reviewer'),
      emitInitialSend: false,
    });
    reviewRound = review.reviewRound;
    if (review.paused) return;
    aSession = review.aSession;
  } else if (state.currentPhase === 'plan-review' && existsSync(join(projectDir, 'plan.md'))) {
    const review = await runPlanReviewPhase(aSession, {
      bSession: sessionFor('reviewer'),
      emitInitialSend: false,
    });
    reviewRound = review.reviewRound;
    if (review.paused) return;
    aSession = review.aSession;
  } else if (state.currentPhase === 'concept' || state.currentPhase === 'planning') {
    aSession = await runPlanningPhase(aSession, { resumeStalled: false });
    const review = await runPlanReviewPhase(aSession);
    reviewRound = review.reviewRound;
    if (review.paused) return;
    aSession = review.aSession;
  }

  if (!existsSync(join(projectDir, 'plan.md'))) {
    throw new Error('plan.md is missing; cannot continue the build');
  }

  const build = await runBuildFromCoding(aSession);
  aSession = build.aSession;
  codeReviewRound = build.codeReviewRound;
  testRound = build.testRound;

  console.log('\n\x1b[1m╔══════════════════════════════════════════╗');
  console.log('║            BUILD COMPLETE                 ║');
  console.log('╚══════════════════════════════════════════╝\x1b[0m');
  console.log(`\n  Project:       ${projectDir}`);
  console.log(`  Plan:          ${join(projectDir, 'plan.md')}`);
  console.log(`  Review rounds: ${reviewRound}`);
  console.log(`  Code reviews:  ${codeReviewRound}`);
  console.log(`  Test rounds:   ${testRound}`);
  console.log('');
}

run().catch((err) => {
  try {
    setPipelineStatus('failed');
    emitSupervisor(state.currentPhase || 'concept', `The run failed in ${state.currentPhase || 'concept'}. Ask me what happened and I can help decide whether to resume, stop, or reset.`);
  } catch {}
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
