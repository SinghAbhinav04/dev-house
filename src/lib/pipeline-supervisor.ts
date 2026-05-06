import type { PendingApproval } from '@/lib/pipeline-approval';

interface PipelineEventLike {
  time: string;
  agent: string;
  phase: string;
  type: string;
  text: string;
}

interface RuntimeLike {
  activeTurn?: {
    agent?: string;
    phase?: string;
    status?: string;
    lastEventAt?: string;
    promptSummary?: string;
    autoResumeCount?: number;
  } | null;
}

interface AuditFindingLike {
  id?: string;
  severity?: string;
  text?: string;
  status?: string;
}

interface PipelineStateLike {
  concept?: string;
  currentPhase?: string;
  securityMode?: string;
  runGoal?: string;
  runFinalAudit?: boolean;
  stopAfterPhase?: string;
  pipelineStatus?: string;
  activeAgent?: string;
  buildComplete?: boolean;
  agentStatus?: Record<string, string>;
  runtime?: RuntimeLike;
  events?: PipelineEventLike[];
  auditFindings?: AuditFindingLike[];
  auditDeployPending?: boolean;
  auditActionInFlight?: boolean;
}

function summarizeAuditFindings(findings: AuditFindingLike[] | undefined): {
  total: number;
  severitySummary: string;
  statusBreakdown: { resolved: number; dismissed: number; open: number; inFlight: number };
} {
  const list = Array.isArray(findings) ? findings : [];
  const severities = ['critical', 'high', 'medium', 'low'] as const;
  const counts: Record<string, number> = {};
  let resolved = 0, dismissed = 0, open = 0, inFlight = 0;
  for (const f of list) {
    const sev = typeof f.severity === 'string' ? f.severity : 'unknown';
    counts[sev] = (counts[sev] || 0) + 1;
    const status = typeof f.status === 'string' ? f.status : 'open';
    if (status === 'resolved') resolved += 1;
    else if (status === 'dismissed') dismissed += 1;
    else if (status === 'sent-to-c' || status === 're-auditing') inFlight += 1;
    else open += 1;
  }
  const parts = severities.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`);
  return {
    total: list.length,
    severitySummary: parts.join(', ') || '',
    statusBreakdown: { resolved, dismissed, open, inFlight },
  };
}

export interface SupervisorRecommendation {
  title: string;
  detail: string;
  actionLabel?: string;
  chatCommand?: string;
  severity: 'neutral' | 'info' | 'warning' | 'success';
}

export interface SupervisorUpdate {
  title: string;
  summary: string;
  ask?: string;
  severity: 'neutral' | 'info' | 'warning' | 'success';
}

export interface ExecutionPathStatus {
  label: string;
  detail: string;
  variant: 'success' | 'warning' | 'purple' | 'neutral';
}

function formatAgentStatuses(agentStatus: Record<string, string> | undefined): string {
  const entries = Object.entries(agentStatus || {});
  if (entries.length === 0) return 'no members on the team';
  return entries.map(([member, status]) => `${member}=${status || 'idle'}`).join(', ');
}

function formatRecentEvents(events: PipelineEventLike[] | undefined, limit: number = 8): string {
  if (!events || events.length === 0) return '- No events yet';
  return events
    .slice(-limit)
    .map((event) => `- [${event.agent} | ${event.phase} | ${event.type}] ${event.text}`)
    .join('\n');
}

function findLatestEvent(
  events: PipelineEventLike[] | undefined,
  types: string[]
): PipelineEventLike | null {
  if (!events || events.length === 0) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (types.includes(events[i].type)) return events[i];
  }
  return null;
}

function hasRecentMatchingEvent(
  events: PipelineEventLike[] | undefined,
  predicate: (event: PipelineEventLike) => boolean,
  limit: number = 8
): boolean {
  if (!events || events.length === 0) return false;
  return events.slice(-limit).some(predicate);
}

export function getSupervisorRecommendation(
  state: PipelineStateLike,
  pendingApproval: PendingApproval | null
): SupervisorRecommendation {
  const activeTurn = state.runtime?.activeTurn;
  const latestFailure = findLatestEvent(state.events, ['failure', 'permission_denied', 'issue']);
  const recentHostFallback = hasRecentMatchingEvent(
    state.events,
    (event) => event.type === 'status' && /retrying on the host/i.test(event.text),
  );

  if (pendingApproval?.approved === null) {
    return {
      title: `Approval needed for ${pendingApproval.agent}`,
      detail: `${pendingApproval.tool} is waiting on a decision: ${pendingApproval.description}`,
      actionLabel: 'Review approval card',
      severity: 'warning',
    };
  }

  if (
    state.pipelineStatus === 'paused' &&
    state.currentPhase === 'plan-review' &&
    state.buildComplete !== true
  ) {
    return {
      title: 'Plan approved, waiting on you',
      detail: 'B approved the plan and the run paused cleanly before coding. Continue when you want C to start building.',
      actionLabel: 'Continue build',
      chatCommand: 'continue build',
      severity: 'info',
    };
  }

  if (
    activeTurn?.status === 'stalled' &&
    (activeTurn.phase === 'planning' || activeTurn.phase === 'plan-review')
  ) {
    return {
      title: `Recoverable ${activeTurn.agent} stall`,
      detail: activeTurn.promptSummary
        ? `The ${activeTurn.phase} turn looks stalled. Resume it from the saved session instead of resetting the run.`
        : 'A planning/review turn looks stalled. Resume it from the saved session instead of resetting the run.',
      actionLabel: 'Resume stalled run',
      chatCommand: 'resume stalled run',
      severity: 'warning',
    };
  }

  if (
    recentHostFallback &&
    state.pipelineStatus === 'running'
  ) {
    return {
      title: 'Graceful host fallback is active',
      detail: 'A Docker-isolated worker could not authenticate with Claude on your subscription, so the supervisor retried that turn on the host instead of failing the run.',
      actionLabel: 'Keep watching',
      severity: 'warning',
    };
  }

  if (
    state.pipelineStatus === 'running' &&
    state.runGoal === 'full-build' &&
    (state.currentPhase === 'planning' || state.currentPhase === 'plan-review')
  ) {
    return {
      title: 'Run is moving normally',
      detail: 'The team is still before coding. If you want to pause after B approves the plan, ask S to stop after review.',
      actionLabel: 'Stop after review',
      chatCommand: 'stop after review',
      severity: 'info',
    };
  }

  if (state.buildComplete) {
    return {
      title: 'Build complete',
      detail: 'The team finished successfully. Inspect the output or ask a specialist for follow-up changes.',
      actionLabel: 'Review output',
      severity: 'success',
    };
  }

  if (state.pipelineStatus === 'idle' && state.concept) {
    return {
      title: 'Concept captured',
      detail: 'The idea is staged and ready. Tell S to start planning or start the full build when you are ready.',
      actionLabel: 'Start planning',
      chatCommand: 'start planning',
      severity: 'info',
    };
  }

  if (state.pipelineStatus === 'failed' || (latestFailure && state.pipelineStatus !== 'idle')) {
    return {
      title: 'Something needs attention',
      detail: latestFailure?.text || 'The last run surfaced an issue. Ask S what happened or stop/reset the run if it is wedged.',
      actionLabel: 'Ask S what happened',
      chatCommand: 'What went wrong, and what should we do next?',
      severity: 'warning',
    };
  }

  return {
    title: 'Tell S what to build',
    detail: 'No run is active yet. Describe the build to S, then start planning when the concept looks right.',
    actionLabel: 'Describe concept',
    severity: 'neutral',
  };
}

export function getExecutionPathStatus(state: PipelineStateLike): ExecutionPathStatus {
  const recentHostFallback = hasRecentMatchingEvent(
    state.events,
    (event) => event.type === 'status' && /retrying on the host/i.test(event.text),
    24,
  );
  const recentIsolatedTurn = hasRecentMatchingEvent(
    state.events,
    (event) => event.type === 'status' && /running .*isolated docker worker/i.test(event.text),
    24,
  );

  if (recentHostFallback) {
    return {
      label: 'HOST FALLBACK',
      detail: 'The Docker architecture is built, but this run had to retry an isolated worker on the host because Claude subscription auth inside the container was unavailable.',
      variant: 'warning',
    };
  }

  if (recentIsolatedTurn) {
    return {
      label: 'ISOLATED ALPHA',
      detail: 'This run used the isolated Docker worker path for an eligible turn. The isolated architecture is real, but it is still alpha while subscription auth in containers remains unreliable.',
      variant: 'purple',
    };
  }

  if (state.pipelineStatus && state.pipelineStatus !== 'idle') {
    return {
      label: 'HOST',
      detail: 'Current supported runs still execute on the host by default. Fast and Strict are ready today; isolated Docker remains an in-progress alpha path.',
      variant: 'neutral',
    };
  }

  return {
    label: 'IDLE',
    detail: 'No active run.',
    variant: 'neutral',
  };
}

export function getSupervisorUpdate(
  state: PipelineStateLike,
  pendingApproval: PendingApproval | null
): SupervisorUpdate {
  const activeTurn = state.runtime?.activeTurn;
  const recommendation = getSupervisorRecommendation(state, pendingApproval);
  const recentHostFallback = hasRecentMatchingEvent(
    state.events,
    (event) => event.type === 'status' && /retrying on the host/i.test(event.text),
  );

  if (pendingApproval?.approved === null) {
    return {
      title: 'I am waiting on approval',
      summary: `The team is paused because ${pendingApproval.agent} needs approval for ${pendingApproval.tool}. Nothing is blocked conceptually, just waiting on your decision.`,
      ask: 'Review the approval card when you are ready.',
      severity: 'warning',
    };
  }

  if (
    state.pipelineStatus === 'paused' &&
    state.currentPhase === 'plan-review' &&
    state.buildComplete !== true
  ) {
    return {
      title: 'Planning is done',
      summary: 'The planner and reviewer finished the plan and I paused cleanly before coding. The team is waiting for your go-ahead to hand the work to the coder.',
      ask: 'Tell me to continue when you want implementation to begin.',
      severity: 'info',
    };
  }

  if (
    recentHostFallback &&
    state.pipelineStatus === 'running'
  ) {
    return {
      title: 'An isolated worker fell back to host',
      summary: 'The Docker worker path is in place, but Claude subscription auth was unavailable for that isolated turn. The supervisor retried it on the host so the run could keep moving.',
      ask: 'No action needed unless you want to stop the run. This was a graceful fallback, not a fatal error.',
      severity: 'warning',
    };
  }

  if (
    activeTurn?.status === 'stalled' &&
    (activeTurn.phase === 'planning' || activeTurn.phase === 'plan-review')
  ) {
    return {
      title: 'A planning turn looks recoverable',
      summary: 'The supervisor saved enough session state to recover this without throwing away the whole run. This looks like a stall, not a total failure.',
      ask: 'Resume the stalled run instead of resetting everything.',
      severity: 'warning',
    };
  }

  if (state.pipelineStatus === 'running') {
    if (state.currentPhase === 'planning') {
      return {
        title: 'The planner is shaping the build',
        summary: 'Right now the team is still in the planning phase: research, plan writing, and self-review before the formal review handoff.',
        ask: recommendation.chatCommand ? `If you want a pause before coding, try "${recommendation.chatCommand}".` : undefined,
        severity: 'info',
      };
    }

    if (state.currentPhase === 'plan-review') {
      return {
        title: 'The plan reviewer is pressure-testing the plan',
        summary: 'The team is still locking down the plan before coding starts. This is where missing details should get caught, not later during implementation.',
        ask: recommendation.chatCommand ? `If you want the run to pause after approval, try "${recommendation.chatCommand}".` : undefined,
        severity: 'info',
      };
    }

    if (state.currentPhase === 'coding') {
      return {
        title: 'The coder is implementing the approved plan',
        summary: 'Planning is behind us. The coder is now translating the locked plan into the real project files.',
        ask: 'Usually no action needed unless you want to stop the run or jump into the coder chat directly.',
        severity: 'info',
      };
    }

    if (state.currentPhase === 'code-review' || state.currentPhase === 'testing') {
      return {
        title: 'The tester is validating the build',
        summary: 'The team is checking the implementation against the approved plan and looping on fixes if needed.',
        ask: 'Usually no action needed unless the run stalls or you want to inspect a failure directly.',
        severity: 'info',
      };
    }

    if (state.currentPhase === 'security-audit') {
      if (state.auditActionInFlight) {
        return {
          title: 'A scoped security fix is running',
          summary: 'Per your request, C is applying a scoped fix, then D verifies the tests, then E re-audits just that finding. Other action buttons are disabled until this pass finishes.',
          ask: 'No action needed — wait for the finding card to update.',
          severity: 'info',
        };
      }
      return {
        title: 'The auditor is doing the initial security pass',
        summary: 'Tests passed. The auditor is reading the code statically for OWASP Top 10, path traversal, ReDoS, and missing input validation. When done, the pipeline will pause so you can review findings and decide what to do.',
        ask: 'No action needed yet. You will review findings in the Security Audit panel once E finishes.',
        severity: 'info',
      };
    }
  }

  if (state.pipelineStatus === 'awaiting-audit-decision') {
    const summary = summarizeAuditFindings(state.auditFindings);
    if (state.auditActionInFlight) {
      return {
        title: 'A scoped security fix is running',
        summary: `C is applying a scoped fix, D is verifying tests, and E will re-audit that finding. ${summary.total} finding${summary.total === 1 ? '' : 's'} total.`,
        ask: 'No action needed — the finding card will update when the pass finishes.',
        severity: 'info',
      };
    }
    if (summary.total === 0) {
      return {
        title: 'Audit is clean — waiting on your deploy',
        summary: 'The auditor found no exploitable vulnerabilities. The pipeline is paused before deploy, waiting for your explicit go.',
        ask: 'Click "Deploy now" in the Security Audit panel when you are ready to finish the build.',
        severity: 'success',
      };
    }
    const unresolved = summary.statusBreakdown.open + summary.statusBreakdown.inFlight;
    return {
      title: 'Audit findings are waiting on your review',
      summary: `E reported ${summary.total} finding${summary.total === 1 ? '' : 's'} (${summary.severitySummary}). Resolved: ${summary.statusBreakdown.resolved}. Dismissed: ${summary.statusBreakdown.dismissed}. Open: ${summary.statusBreakdown.open}.`,
      ask: unresolved > 0
        ? 'Decide per finding: Send to C to fix, or Dismiss. When done, click "Deploy now".'
        : 'Everything is handled. Click "Deploy now" when you are ready.',
      severity: unresolved > 0 ? 'warning' : 'info',
    };
  }

  if (state.buildComplete) {
    return {
      title: 'The team finished the build',
      summary: 'The main run completed. You can inspect the output, open the plan, or jump directly into a specialist chat for follow-up work.',
      ask: 'Ask for another pass only if you want changes beyond the approved build.',
      severity: 'success',
    };
  }

  if (state.pipelineStatus === 'idle' && state.concept) {
    return {
      title: 'The concept is captured',
      summary: 'I have the brief and the team is ready. Nothing is running yet because I am waiting for an explicit start from you.',
      ask: recommendation.chatCommand ? `Say "${recommendation.chatCommand}" when you want the team to begin.` : undefined,
      severity: 'info',
    };
  }

  if (state.pipelineStatus === 'failed') {
    return {
      title: 'The run needs a decision',
      summary: 'Something in the run failed hard enough that I do not want to guess the next move for you.',
      ask: recommendation.chatCommand ? `Ask "${recommendation.chatCommand}" or stop/reset the run.` : 'Ask what went wrong or stop/reset the run.',
      severity: 'warning',
    };
  }

  return {
    title: 'The team is waiting on the brief',
    summary: 'No run is active yet. Tell the supervisor what you want to build and I will stage the concept before we start the team.',
    ask: 'Describe the build in plain English to get started.',
    severity: 'neutral',
  };
}

export function buildSupervisorSnapshot(
  state: PipelineStateLike,
  pendingApproval: PendingApproval | null
): string {
  const activeTurn = state.runtime?.activeTurn;
  const recommendation = getSupervisorRecommendation(state, pendingApproval);
  const update = getSupervisorUpdate(state, pendingApproval);
  const executionPath = getExecutionPathStatus(state);

  return [
    '[LIVE TEAM SNAPSHOT]',
    `Concept: ${state.concept || '(not set yet)'}`,
    `Phase: ${state.currentPhase || 'concept'}`,
    `Pipeline status: ${state.pipelineStatus || 'idle'}`,
    `Execution path: ${executionPath.label}`,
    `Security mode: ${state.securityMode || 'fast'}`,
    `Run goal: ${state.runGoal || 'full-build'}`,
    `Final security audit: ${state.runFinalAudit ? 'enabled' : 'disabled'}`,
    (() => {
      if (!state.auditFindings || state.auditFindings.length === 0) return 'Audit findings: none';
      const s = summarizeAuditFindings(state.auditFindings);
      return `Audit findings: ${s.total} (${s.severitySummary}) — resolved ${s.statusBreakdown.resolved}, dismissed ${s.statusBreakdown.dismissed}, open ${s.statusBreakdown.open}, in-flight ${s.statusBreakdown.inFlight}`;
    })(),
    `Audit action in flight: ${state.auditActionInFlight ? 'yes' : 'no'}`,
    `Stop after phase: ${state.stopAfterPhase || 'none'}`,
    `Active agent: ${state.activeAgent || 'none'}`,
    `Build complete: ${state.buildComplete ? 'yes' : 'no'}`,
    `Agent statuses: ${formatAgentStatuses(state.agentStatus)}`,
    activeTurn
      ? `Active turn: ${activeTurn.agent || '?'} / ${activeTurn.phase || '?'} / ${activeTurn.status || 'running'} / idle prompt "${activeTurn.promptSummary || ''}" / auto-resumes ${activeTurn.autoResumeCount || 0}`
      : 'Active turn: none',
    pendingApproval?.approved === null
      ? `Pending approval: ${pendingApproval.agent} ${pendingApproval.tool} — ${pendingApproval.description}`
      : 'Pending approval: none',
    'Recent events:',
    formatRecentEvents(state.events),
    'Supervisor update:',
    `- ${update.title}: ${update.summary}${update.ask ? ` (${update.ask})` : ''}`,
    'Recommended supervisor action:',
    `- ${recommendation.title}: ${recommendation.detail}${recommendation.chatCommand ? ` (try: "${recommendation.chatCommand}")` : ''}`,
    '[END SNAPSHOT]',
  ].join('\n');
}
