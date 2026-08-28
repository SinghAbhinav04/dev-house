import { readFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { NextRequest, NextResponse } from 'next/server';
import {
  createRunner,
  isRecoverableDockerAuthFailure,
  type PipelineAgentId,
  type RunnerOptions,
} from '../../../../pipeline/runner.ts';
import { EMPTY_RUNTIME } from '@/lib/pipeline-runtime';
import { writeJsonAtomic } from '@/lib/atomic-write';
import { readPendingApproval } from '@/lib/pipeline-approval';
import { buildSupervisorSnapshot, getSupervisorRecommendation } from '@/lib/pipeline-supervisor';
import { buildSupervisorConceptReply, looksLikeStatusQuestion } from '@/lib/supervisor-concept';
import {
  appendPipelineEvent,
  resumePipelineRun,
  setStopAfterReview,
  startPipelineRun,
  stopPipelineRun,
  type PermissionMode,
  type RunGoal,
  type SecurityMode,
} from '@/lib/pipeline-control';
import { parseSupervisorIntent } from '@/lib/supervisor-intents';
import type { AgentEvent } from '@/lib/cli/decoder';
import { resolveCli } from '@/lib/cli/registry';

import { getMember, readRoster } from '@/lib/team/roster';
import { resolveSlot } from '@/lib/team/slots';
import { memberSpawnOptions } from '@/lib/team/spawn';
import { SLOT_LABELS, type Roster, type TeamMember } from '@/lib/team/types';
import {
  emptyBreakdown,
  normalizeUsage,
  recordUsage,
  usageFromResultEvent,
  type UsageBreakdown,
} from '@/lib/team/usage';

const BUILDUI_DIR = resolve(process.cwd(), 'pipeline');
const BUILDS_DIR = join(homedir(), 'Builds');
const STAGING_DIR = join(BUILDS_DIR, '.staging');
const MANUAL_DIR = join(BUILDS_DIR, '.manual');
/**
 * Concept-phase prompt for whoever fills the planner slot. Before a project
 * exists the planner is discussing an idea, not writing a plan, so it gets a
 * different system prompt from its own role.md.
 */
const PLANNER_CONCEPT_ROLE = resolve(process.cwd(), 'templates', 'roles', 'planner-concept.md');

const runner = createRunner();

/** The member a chat request is addressed to, resolved from the live roster. */
function resolveChatMember(roster: Roster, agent: string): TeamMember | null {
  return getMember(roster, agent);
}

/** The member filling the supervisor slot, if the team has one. */
function supervisorId(roster: Roster): string {
  return resolveSlot(roster, 'supervisor')?.id ?? 'supervisor';
}

function roleLabel(roster: Roster, agent: string): string {
  const member = getMember(roster, agent);
  if (!member) return agent;
  return member.slot ? SLOT_LABELS[member.slot].toLowerCase() : member.title || member.name;
}

/** A fresh idle status map keyed by the members currently on the team. */
function idleStatusForRoster(roster: Roster): Record<string, string> {
  const status: Record<string, string> = {};
  for (const member of roster.members) {
    if (member.enabled) status[member.id] = 'idle';
  }
  return status;
}

/**
 * Manual mode deliberately does not use a member's full role file — sessions
 * there are loose and user-directed. A one-line prompt derived from the
 * member's slot and speciality is enough to give it a lane.
 */
function manualSystemPrompt(roster: Roster, agent: string): string {
  const member = getMember(roster, agent);
  if (!member) return 'You are a helpful engineering collaborator.';

  const speciality = member.title || (member.slot ? SLOT_LABELS[member.slot] : '');
  return speciality
    ? `You are ${member.name}. You specialize in ${speciality}.`
    : `You are ${member.name}, an engineering collaborator.`;
}

function getManualState(): Record<string, unknown> {
  const eventsFile = join(MANUAL_DIR, 'manual-state.json');
  if (existsSync(eventsFile)) {
    try { return JSON.parse(readFileSync(eventsFile, 'utf8')); } catch {}
  }
  mkdirSync(MANUAL_DIR, { recursive: true });
  const fresh: Record<string, unknown> = {
    concept: '',
    projectDir: MANUAL_DIR,
    currentPhase: 'concept',
    securityMode: 'fast',
    activeAgent: '',
    agentStatus: idleStatusForRoster(readRoster()),
    sessions: {},
    buildComplete: false,
    usage: emptyBreakdown(),
    runtime: { ...EMPTY_RUNTIME },
    events: [],
  };
  writeJsonAtomic(eventsFile, fresh);
  return fresh;
}

function getStagingState(): Record<string, unknown> {
  const eventsFile = join(STAGING_DIR, 'pipeline-events.json');
  if (existsSync(eventsFile)) {
    try { return JSON.parse(readFileSync(eventsFile, 'utf8')); } catch {}
  }
  mkdirSync(STAGING_DIR, { recursive: true });
  const fresh: Record<string, unknown> = {
    concept: '',
    projectDir: '',
    currentPhase: 'concept',
    securityMode: 'fast',
    activeAgent: '',
    agentStatus: idleStatusForRoster(readRoster()),
    sessions: {},
    buildComplete: false,
    usage: emptyBreakdown(),
    runtime: { ...EMPTY_RUNTIME },
    events: [],
  };
  writeJsonAtomic(eventsFile, fresh);
  return fresh;
}

function findLatestProject(): string | null {
  try {
    const dirs = readdirSync(BUILDS_DIR)
      .filter((name: string) => name !== '.staging' && name !== '.manual')
      .map((name: string) => join(BUILDS_DIR, name))
      .filter((p: string) => {
        try { return statSync(p).isDirectory() && statSync(join(p, 'pipeline-events.json')).isFile(); }
        catch { return false; }
      })
      .sort((a: string, b: string) => statSync(join(b, 'pipeline-events.json')).mtimeMs - statSync(join(a, 'pipeline-events.json')).mtimeMs);
    return dirs[0] || null;
  } catch { return null; }
}

function writeState(file: string, state: Record<string, unknown>) {
  writeJsonAtomic(file, state);
}

function appendUserEvent(state: Record<string, unknown>, agent: string, message: string) {
  const events = (state.events as Array<Record<string, unknown>>) || [];
  events.push({
    time: new Date().toISOString(),
    agent,
    phase: state.currentPhase || 'concept',
    type: 'user_msg',
    text: `You: ${message}`,
  });
  state.events = events;
}

function appendSupervisorFailureAndGuidance(
  state: Record<string, unknown>,
  file: string,
  errorText: string
) {
  const events = (state.events as Array<Record<string, unknown>>) || [];
  events.push({
    time: new Date().toISOString(),
    agent: supervisorId(readRoster()),
    phase: state.currentPhase || 'concept',
    type: 'failure',
    text: errorText,
  });

  const recommendation = getSupervisorRecommendation(state, null);
  events.push({
    time: new Date().toISOString(),
    agent: supervisorId(readRoster()),
    phase: state.currentPhase || 'concept',
    type: 'text',
    text: `${recommendation.title}: ${recommendation.detail}${recommendation.chatCommand ? ` Try: "${recommendation.chatCommand}".` : ''}`,
  });
  state.events = events;
  writeState(file, state);
}

// ── Shared: stream claude output into a state file ──────────────────

/**
 * Append one event to a state file.
 *
 * Every call is a read-modify-write of the whole file. That is what the
 * orchestrator does too, and it is only safe because a single member runs at a
 * time — see the note on multi-fill in team/slots.ts.
 */
function appendEvent(eventsFile: string, agent: string, type: string, text: string, detail?: string) {
  try {
    const s = JSON.parse(readFileSync(eventsFile, 'utf8'));
    if (!Array.isArray(s.events)) s.events = [];
    s.events.push({
      time: new Date().toISOString(),
      agent,
      phase: s.currentPhase || 'concept',
      type,
      text,
      ...(detail ? { detail } : {}),
    });
    writeJsonAtomic(eventsFile, s);
  } catch {}
}

function streamClaude(
  opts: RunnerOptions,
  eventsFile: string,
  agent: string,
  sessionId: string,
): Promise<NextResponse> {
  return new Promise<NextResponse>((resolveResponse) => {
    // From the adapter, so the member's own CLI decides how its stream is read.
    const decoder = resolveCli(opts.cli).createDecoder();
    const child = runner.spawn(opts);
    const canFallbackToHost = child.backend === 'docker' && runner.supportsHostFallback(opts);

    if (child.backend === 'docker') {
      try {
        const s = JSON.parse(readFileSync(eventsFile, 'utf8'));
        const phase = s.currentPhase || 'concept';
        s.events.push({
          time: new Date().toISOString(),
          agent: 'system',
          phase,
          type: 'status',
          text: `Running ${roleLabel(readRoster(), agent)} in isolated Docker worker.`,
        });
        writeJsonAtomic(eventsFile, s);
      } catch {}
    }

    const rl = createInterface({ input: child.stdout });
    let newSessionId = sessionId;
    let lastResultText = '';
    let stderr = '';
    let diagnosticTail = '';

    function noteDiagnostic(text: string) {
      if (!text) return;
      diagnosticTail = `${diagnosticTail}\n${text}`.slice(-12_000);
    }

    /**
     * Act on one decoded event. Shared by the line handler and the drain at
     * close, so a decoder that buffers events is flushed through the same
     * path rather than a second copy of it.
     */
    function handleEvent(decoded: AgentEvent) {
      if (decoded.kind === 'session') {
        newSessionId = decoded.sessionId;
        try {
          const s = JSON.parse(readFileSync(eventsFile, 'utf8'));
          if (!s.sessions) s.sessions = {};
          s.sessions[agent] = decoded.sessionId;
          writeJsonAtomic(eventsFile, s);
        } catch {}
        return;
      }

      if (decoded.kind === 'tool_call') {
        appendEvent(eventsFile, agent, 'tool_call', decoded.description, decoded.detail);
        return;
      }

      if (decoded.kind === 'text') {
        appendEvent(eventsFile, agent, 'text', decoded.text);
        return;
      }

      // Tool results, so a terminal view has something between a call and
      // the next message rather than a silent gap.
      if (decoded.kind === 'tool_result') {
        if (decoded.summary) appendEvent(eventsFile, agent, 'tool_result', decoded.summary);
        return;
      }

      if (decoded.kind === 'result') {
        newSessionId = decoded.sessionId || sessionId;
        lastResultText = decoded.text;
        try {
          const s = JSON.parse(readFileSync(eventsFile, 'utf8'));
          if (!s.sessions) s.sessions = {};
          s.sessions[agent] = newSessionId;
          // Attribute the spend to the member that ran, not just the total.
          s.usage = normalizeUsage(s.usage);
          recordUsage(s.usage as UsageBreakdown, usageFromResultEvent(decoded.raw), {
            memberId: agent,
            model: opts.model,
          });
          writeJsonAtomic(eventsFile, s);
        } catch {}
      }
    }

    rl.on('line', (line) => {
      if (!line.trim()) return;
      noteDiagnostic(line);
      for (const decoded of decoder.push(line)) handleEvent(decoded);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      noteDiagnostic(text);
    });

    child.on('close', async () => {
      // Anything the decoder was still holding back.
      for (const decoded of decoder.finish()) handleEvent(decoded);

      if (canFallbackToHost && isRecoverableDockerAuthFailure(`${diagnosticTail}\n${stderr}\n${lastResultText}`)) {
        try {
          const s = JSON.parse(readFileSync(eventsFile, 'utf8'));
          const phase = s.currentPhase || 'concept';
          s.events.push({
            time: new Date().toISOString(),
            agent: 'system',
            phase,
            type: 'status',
            text: `Isolated ${roleLabel(readRoster(), agent)} auth is unavailable. Retrying on the host.`,
          });
          s.events.push({
            time: new Date().toISOString(),
            agent: supervisorId(readRoster()),
            phase,
            type: 'text',
            text: `I could not keep the ${roleLabel(readRoster(), agent)} isolated for this turn because Claude subscription auth is unavailable in Docker right now, so I am retrying it on the host instead of failing the run.`,
          });
          writeJsonAtomic(eventsFile, s);
        } catch {}

        resolveResponse(await streamClaude(
          { ...opts, forceHost: true },
          eventsFile,
          agent,
          sessionId,
        ));
        return;
      }

      // Set agent back to idle
      try {
        const s = JSON.parse(readFileSync(eventsFile, 'utf8'));
        if (s.agentStatus) s.agentStatus[agent] = 'idle';
        writeJsonAtomic(eventsFile, s);
      } catch {}
      resolveResponse(NextResponse.json({ success: true, sessionId: newSessionId }));
    });
    child.on('error', () => {
      resolveResponse(NextResponse.json({ success: false }, { status: 500 }));
    });
  });
}

// ── Manual mode ─────────────────────────────────────────────────────

function handleManual(agent: string, message: string, model: string) {
  const eventsFile = join(MANUAL_DIR, 'manual-state.json');
  const state = getManualState();
  const sessions = (state.sessions as Record<string, string>) || {};
  const sessionId = sessions[agent] || '';

  // Set agent active
  const agentStatus = (state.agentStatus as Record<string, string>) || {};
  agentStatus[agent] = 'active';
  state.agentStatus = agentStatus;

  // Append event — detect handoffs vs regular user messages
  const events = (state.events as Array<Record<string, unknown>>) || [];
  const handoffMatch = message.match(/^\[HANDOFF:(\w)→(\w)\]\s/);
  if (handoffMatch) {
    const fromAgent = handoffMatch[1];
    const handoffText = message.replace(/^\[HANDOFF:\w→\w\]\s/, '').replace(/\n\nReview this and continue the work\.$/, '');
    events.push({ time: new Date().toISOString(), agent: fromAgent, phase: 'concept', type: 'handoff', text: `→ ${agent}: ${handoffText}` });
  } else {
    events.push({ time: new Date().toISOString(), agent, phase: 'concept', type: 'user_msg', text: `You: ${message}` });
  }
  state.events = events;
  writeJsonAtomic(eventsFile, state);

  const safeMessage = message.startsWith('-') ? 'User says: ' + message : message;

  return streamClaude(
    {
      prompt: safeMessage,
      projectDir: MANUAL_DIR,
      model,
      resume: sessionId || undefined,
      systemPrompt: sessionId ? undefined : manualSystemPrompt(readRoster(), agent),
    },
    eventsFile,
    agent,
    sessionId
  );
}

// ── Pipeline mode ───────────────────────────────────────────────────

function handlePipeline(
  agent: string,
  message: string,
  defaults?: { securityMode?: SecurityMode; permissionMode?: PermissionMode; runGoal?: RunGoal; runFinalAudit?: boolean }
) {
  let projectDir: string;
  let eventsFile: string;

  const stagingEvents = join(STAGING_DIR, 'pipeline-events.json');
  const activeProject = findLatestProject();

  if (existsSync(stagingEvents)) {
    projectDir = STAGING_DIR;
    eventsFile = stagingEvents;
  } else if (activeProject) {
    const projState = JSON.parse(readFileSync(join(activeProject, 'pipeline-events.json'), 'utf8'));
    const phase = projState.currentPhase as string;
    const isActive = phase && phase !== 'concept' && !projState.buildComplete;
    const isDone = !!projState.buildComplete;
    if (isActive || isDone) {
      projectDir = activeProject;
      eventsFile = join(activeProject, 'pipeline-events.json');
    } else {
      projectDir = STAGING_DIR;
      eventsFile = stagingEvents;
      getStagingState();
    }
  } else {
    projectDir = STAGING_DIR;
    eventsFile = stagingEvents;
    getStagingState();
  }

  let state: Record<string, unknown> = {};
  try { state = JSON.parse(readFileSync(eventsFile, 'utf8')); } catch {}
  const securityMode = state.securityMode === 'strict' ? 'strict' : 'fast';
  const sessions = (state.sessions as Record<string, string>) || {};
  const sessionId = sessions[agent] || '';

  // Chat is addressed to a member, not a fixed agent letter. An unknown id
  // means the roster changed underneath the UI.
  const roster = readRoster();
  const member = resolveChatMember(roster, agent);
  if (!member) {
    return NextResponse.json(
      { success: false, error: `No team member with id "${agent}". Check the roster on the Team page.` },
      { status: 404 }
    );
  }

  if (member.slot === 'supervisor') {
    const intent = parseSupervisorIntent(message);
    if (intent) {
      let controlProjectDir = projectDir;
      let controlEventsFile = eventsFile;
      let controlState = state;

      if (intent.action === 'start-run') {
        controlProjectDir = STAGING_DIR;
        controlEventsFile = join(STAGING_DIR, 'pipeline-events.json');
        controlState = getStagingState();

        if (!controlState.concept && typeof intent.concept === 'string' && intent.concept.trim()) {
          controlState.concept = intent.concept.trim();
        }
      }

      appendUserEvent(controlState, agent, message);
      writeState(controlEventsFile, controlState);

      if (intent.action === 'start-run') {
        const effectiveSecurityMode = defaults?.securityMode || (controlState.securityMode === 'strict' ? 'strict' : 'fast');
        const effectiveRunGoal = defaults?.runGoal || 'full-build';
        const effectivePermissionMode = defaults?.permissionMode || 'auto';
        const effectiveRunFinalAudit = defaults?.runFinalAudit === true || controlState.runFinalAudit === true;
        const result = startPipelineRun({
          securityMode: effectiveSecurityMode,
          permissionMode: effectivePermissionMode as 'auto' | 'plan' | 'dangerously-skip-permissions',
          runGoal: effectiveRunGoal,
          runFinalAudit: effectiveRunFinalAudit,
        });

        if (!result.success) {
          appendSupervisorFailureAndGuidance(
            controlState,
            controlEventsFile,
            result.error || 'Supervisor could not start the run'
          );
          return NextResponse.json({ success: false, error: result.error || 'Could not start pipeline' });
        }

        appendPipelineEvent(result.projectDir!, {
          agent: supervisorId(readRoster()),
          phase: 'concept',
          type: 'status',
          text:
            result.runGoal === 'plan-only'
              ? `Supervisor started plan-only mode in ${result.securityMode} mode. A will plan, B will review, then the run will pause.`
              : `Supervisor started the full build in ${result.securityMode} mode.`,
        });

        return NextResponse.json({
          success: true,
          controlAction: 'start-run',
          projectDir: result.projectDir,
          runGoal: result.runGoal,
          securityMode: result.securityMode,
        });
      }

      if (intent.action === 'set-stop-after-review') {
        const result = setStopAfterReview(intent.enabled, controlProjectDir === STAGING_DIR ? undefined : controlProjectDir);
        if (!result.success) {
          appendSupervisorFailureAndGuidance(
            controlState,
            controlEventsFile,
            result.error || 'Supervisor could not update stop-after-review'
          );
          return NextResponse.json({ success: false, error: result.error || 'Could not update supervisor control' });
        }

        return NextResponse.json({
          success: true,
          controlAction: 'set-stop-after-review',
          stopAfterPhase: result.stopAfterPhase,
          projectDir: result.projectDir,
        });
      }

      if (intent.action === 'resume-run') {
        const result = resumePipelineRun(controlProjectDir === STAGING_DIR ? undefined : controlProjectDir);
        if (!result.success) {
          appendSupervisorFailureAndGuidance(
            controlState,
            controlEventsFile,
            result.error || 'Supervisor could not resume the run'
          );
          return NextResponse.json({ success: false, error: result.error || 'Could not resume pipeline' });
        }

        return NextResponse.json({
          success: true,
          controlAction: result.action || 'resume-run',
          projectDir: result.projectDir,
        });
      }

      if (intent.action === 'stop-run') {
        const result = stopPipelineRun(controlProjectDir === STAGING_DIR ? undefined : controlProjectDir);
        appendPipelineEvent(result.projectDir || controlProjectDir, {
          agent: supervisorId(readRoster()),
          phase: String(controlState.currentPhase || 'concept'),
          type: 'status',
          text: 'Supervisor stopped the run',
        });
        return NextResponse.json({ success: true, controlAction: 'stop-run', projectDir: result.projectDir });
      }
    }

    const isConceptPhase =
      projectDir === STAGING_DIR &&
      (!state.currentPhase || state.currentPhase === 'concept') &&
      !state.buildComplete;

    if (isConceptPhase) {
      // First message — no concept yet. Capture it with a canned reply.
      if (!state.concept) {
        state.concept = message.trim();
        appendUserEvent(state, agent, message);
        const reply = buildSupervisorConceptReply(String(state.concept), true);
        const events = (state.events as Array<Record<string, unknown>>) || [];
        events.push({
          time: new Date().toISOString(),
          agent: supervisorId(readRoster()),
          phase: state.currentPhase || 'concept',
          type: 'text',
          text: reply,
        });
        state.events = events;
        writeState(eventsFile, state);

        return NextResponse.json({
          success: true,
          conceptCaptured: true,
          concept: state.concept,
        });
      }

      // Concept exists — stream everything to Claude so S can think.
      appendUserEvent(state, agent, message);
      writeState(eventsFile, state);

      const conceptContext = [
        `[CONCEPT PHASE — no pipeline running yet]`,
        `Current concept: ${state.concept}`,
        '',
        'The user is exploring this idea with you before starting the team.',
        'Engage naturally — give your honest opinion, ask clarifying questions, suggest improvements.',
        'If the user refines or changes the concept, acknowledge it conversationally.',
        'When they seem ready, remind them they can say `start planning`, `start plan only`, or `start full build`.',
        '',
        message,
      ].join('\n');

      return streamClaude(
        {
          ...memberSpawnOptions(roster, member),
          prompt: conceptContext,
          projectDir,
          pipelineDir: BUILDUI_DIR,
          resume: sessionId || undefined,
          securityMode,
        },
        eventsFile,
        agent,
        sessionId
      );
    }
  }

  if (!state.concept && message) {
    state.concept = message;
    writeState(eventsFile, state);
  }

  const currentPhase = state.currentPhase as string;
  const isPhase0 = !currentPhase || currentPhase === 'concept';

  const safeMessage = message.startsWith('-') ? 'User says: ' + message : message;
  const buildComplete = !!state.buildComplete;
  let finalMessage = safeMessage;
  if (member.slot === 'supervisor') {
    const pendingApproval = projectDir !== STAGING_DIR ? readPendingApproval(projectDir) : null;
    finalMessage = [
      buildSupervisorSnapshot(state, pendingApproval),
      '',
      'Use the live snapshot above as the source of truth for the team state.',
      'Answer as the supervisor/operator for the dev team.',
      'Lead with one concrete recommendation when the user asks what to do next.',
      '',
      safeMessage,
    ].join('\n');
  }
  if (buildComplete) {
    finalMessage = '[The build pipeline has completed. The user is chatting with you directly for post-build work — reviewing, fixing, or modifying the project.]\n\n' + finalMessage;
  }

  appendUserEvent(state, agent, message);
  writeState(eventsFile, state);

  return streamClaude(
    {
      ...memberSpawnOptions(roster, member),
      prompt: finalMessage,
      projectDir,
      pipelineDir: BUILDUI_DIR,
      // The planner discusses the idea before a project exists, so it gets the
      // concept prompt instead of its own role.md for that phase.
      ...(member.slot === 'planner' && isPhase0 ? { roleFile: PLANNER_CONCEPT_ROLE, systemPrompt: undefined } : {}),
      resume: sessionId || undefined,
      securityMode,
    },
    eventsFile,
    agent,
    sessionId
  );
}

// ── Route handler ───────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { agent, message, mode, model, securityMode, permissionMode, runGoal, runFinalAudit } = await req.json();

  if (mode === 'manual') {
    return handleManual(agent, message, model || 'claude-sonnet-4-6');
  }
  return handlePipeline(agent, message, {
    securityMode: securityMode === 'strict' ? 'strict' : 'fast',
    permissionMode: permissionMode === 'plan' ? 'plan' : permissionMode === 'dangerously-skip-permissions' ? 'dangerously-skip-permissions' : 'auto',
    runGoal: runGoal === 'plan-only' ? 'plan-only' : 'full-build',
    runFinalAudit: runFinalAudit === true,
  });
}
