import assert from 'node:assert/strict';

import { buildSupervisorSnapshot, getExecutionPathStatus, getSupervisorUpdate } from '../src/lib/pipeline-supervisor.ts';

const pausedSnapshot = buildSupervisorSnapshot(
  {
    concept: 'Tiny hello page',
    currentPhase: 'plan-review',
    pipelineStatus: 'paused',
    securityMode: 'fast',
    runGoal: 'plan-only',
    stopAfterPhase: 'plan-review',
    activeAgent: '',
    buildComplete: false,
    agentStatus: { A: 'idle', B: 'done', C: 'idle', D: 'idle', S: 'idle' },
    runtime: { activeTurn: null },
    events: [{ time: '2026-04-02T00:00:00.000Z', agent: 'B', phase: 'plan-review', type: 'approval', text: 'PLAN APPROVED' }],
  },
  null
);

assert.match(pausedSnapshot, /Run goal: plan-only/);
assert.match(pausedSnapshot, /Pipeline status: paused/);
assert.match(pausedSnapshot, /Supervisor update:/i);
assert.match(pausedSnapshot, /Planning is done/i);
assert.match(pausedSnapshot, /Recommended supervisor action:/i);
assert.match(pausedSnapshot, /Plan approved, waiting on you/i);
assert.match(pausedSnapshot, /try: "continue build"/i);

const stalledSnapshot = buildSupervisorSnapshot(
  {
    concept: 'Tiny hello page',
    currentPhase: 'planning',
    pipelineStatus: 'running',
    securityMode: 'fast',
    runGoal: 'full-build',
    stopAfterPhase: 'none',
    activeAgent: 'A',
    buildComplete: false,
    agentStatus: { A: 'active', B: 'idle', C: 'idle', D: 'idle', S: 'idle' },
    runtime: {
      activeTurn: {
        agent: 'A',
        phase: 'planning',
        status: 'stalled',
        lastEventAt: '2026-04-02T00:00:00.000Z',
        promptSummary: 'Write plan.md',
        autoResumeCount: 1,
      },
    },
    events: [{ time: '2026-04-02T00:00:00.000Z', agent: 'system', phase: 'planning', type: 'status', text: 'The planner appears stalled.' }],
  },
  null
);

assert.match(stalledSnapshot, /Active turn: A \/ planning \/ stalled/);
assert.match(stalledSnapshot, /A planning turn looks recoverable/i);
assert.match(stalledSnapshot, /Recoverable A stall/i);
assert.match(stalledSnapshot, /try: "resume stalled run"/i);

const idleFailureSnapshot = buildSupervisorSnapshot(
  {
    concept: '',
    currentPhase: 'concept',
    pipelineStatus: 'idle',
    securityMode: 'fast',
    runGoal: 'full-build',
    stopAfterPhase: 'none',
    activeAgent: '',
    buildComplete: false,
    agentStatus: { A: 'idle', B: 'idle', C: 'idle', D: 'idle', S: 'idle' },
    runtime: { activeTurn: null },
    events: [{ time: '2026-04-02T00:00:00.000Z', agent: 'S', phase: 'concept', type: 'failure', text: 'No build concept found yet.' }],
  },
  null
);

assert.match(idleFailureSnapshot, /Tell S what to build/i);
assert.doesNotMatch(idleFailureSnapshot, /Something needs attention/i);

const codingUpdate = getSupervisorUpdate(
  {
    concept: 'Tiny hello page',
    currentPhase: 'coding',
    pipelineStatus: 'running',
    securityMode: 'fast',
    runGoal: 'full-build',
    stopAfterPhase: 'none',
    activeAgent: 'C',
    buildComplete: false,
    agentStatus: { A: 'done', B: 'done', C: 'active', D: 'idle', S: 'idle' },
    runtime: {
      activeTurn: {
        agent: 'C',
        phase: 'coding',
        status: 'running',
        lastEventAt: '2026-04-02T00:00:00.000Z',
        promptSummary: 'Build the app',
        autoResumeCount: 0,
      },
    },
    events: [{ time: '2026-04-02T00:00:00.000Z', agent: 'C', phase: 'coding', type: 'status', text: 'Coder is implementing the approved plan.' }],
  },
  null
);

assert.equal(codingUpdate.title, 'The coder is implementing the approved plan');
assert.match(codingUpdate.summary, /locked plan/i);
assert.match(codingUpdate.ask || '', /no action needed/i);

const fallbackUpdate = getSupervisorUpdate(
  {
    concept: 'Tiny hello page',
    currentPhase: 'coding',
    pipelineStatus: 'running',
    securityMode: 'fast',
    runGoal: 'full-build',
    stopAfterPhase: 'none',
    activeAgent: 'C',
    buildComplete: false,
    agentStatus: { A: 'done', B: 'done', C: 'active', D: 'idle', S: 'idle' },
    runtime: {
      activeTurn: {
        agent: 'C',
        phase: 'coding',
        status: 'running',
        lastEventAt: '2026-04-02T00:00:00.000Z',
        promptSummary: 'Build the app',
        autoResumeCount: 0,
      },
    },
    events: [
      { time: '2026-04-02T00:00:00.000Z', agent: 'system', phase: 'coding', type: 'status', text: 'Isolated coder auth is unavailable. Retrying on the host.' },
    ],
  },
  null
);

assert.equal(fallbackUpdate.title, 'An isolated worker fell back to host');
assert.match(fallbackUpdate.summary, /subscription auth/i);
assert.match(fallbackUpdate.ask || '', /graceful fallback/i);

const executionFallback = getExecutionPathStatus({
  pipelineStatus: 'running',
  events: [
    { time: '2026-04-02T00:00:00.000Z', agent: 'system', phase: 'coding', type: 'status', text: 'Isolated coder auth is unavailable. Retrying on the host.' },
  ],
});

assert.equal(executionFallback.label, 'HOST FALLBACK');
assert.match(executionFallback.detail, /Docker architecture is built/i);

const executionIsolated = getExecutionPathStatus({
  pipelineStatus: 'running',
  events: [
    { time: '2026-04-02T00:00:00.000Z', agent: 'system', phase: 'coding', type: 'status', text: 'Running coder in isolated Docker worker.' },
  ],
});

assert.equal(executionIsolated.label, 'ISOLATED ALPHA');
assert.match(executionIsolated.detail, /isolated.*worker/i);

const auditOnSnapshot = buildSupervisorSnapshot(
  {
    concept: 'Tiny hello page',
    currentPhase: 'security-audit',
    pipelineStatus: 'running',
    securityMode: 'fast',
    runGoal: 'full-build',
    runFinalAudit: true,
    stopAfterPhase: 'none',
    activeAgent: 'E',
    buildComplete: false,
    agentStatus: { A: 'done', B: 'done', C: 'done', D: 'done', E: 'active', S: 'idle' },
    runtime: { activeTurn: null },
    events: [{ time: '2026-04-17T00:00:00.000Z', agent: 'E', phase: 'security-audit', type: 'status', text: 'Auditing for OWASP Top 10...' }],
  },
  null
);

assert.match(auditOnSnapshot, /Final security audit: enabled/);
assert.match(auditOnSnapshot, /auditor is doing the initial security pass/i);

const auditOffSnapshot = buildSupervisorSnapshot(
  {
    concept: 'Tiny hello page',
    currentPhase: 'testing',
    pipelineStatus: 'running',
    securityMode: 'fast',
    runGoal: 'full-build',
    runFinalAudit: false,
    stopAfterPhase: 'none',
    activeAgent: 'D',
    buildComplete: false,
    agentStatus: { A: 'done', B: 'done', C: 'done', D: 'active', E: 'idle', S: 'idle' },
    runtime: { activeTurn: null },
    events: [],
  },
  null
);

assert.match(auditOffSnapshot, /Final security audit: disabled/);

// Awaiting-audit-decision with findings — supervisor should describe the review gate, not the auto-loop.
const awaitingDecisionSnapshot = buildSupervisorSnapshot(
  {
    concept: 'Login form',
    currentPhase: 'security-audit',
    pipelineStatus: 'awaiting-audit-decision',
    securityMode: 'fast',
    runGoal: 'full-build',
    runFinalAudit: true,
    stopAfterPhase: 'none',
    activeAgent: '',
    buildComplete: false,
    agentStatus: { A: 'done', B: 'done', C: 'done', D: 'done', E: 'done', S: 'idle' },
    runtime: { activeTurn: null },
    events: [],
    auditFindings: [
      { id: 'finding-aaa', severity: 'critical', text: '[src/api/auth.ts:42] SQL injection', status: 'open' },
      { id: 'finding-bbb', severity: 'high', text: '[src/forms.tsx:18] XSS', status: 'open' },
      { id: 'finding-ccc', severity: 'low', text: '[src/util.ts:7] hardening', status: 'dismissed' },
    ],
    auditDeployPending: true,
    auditActionInFlight: false,
  },
  null
);

assert.match(awaitingDecisionSnapshot, /Audit findings: 3 \(1 critical, 1 high, 1 low\)/);
assert.match(awaitingDecisionSnapshot, /Audit action in flight: no/);
assert.match(awaitingDecisionSnapshot, /findings are waiting on your review/i);
assert.match(awaitingDecisionSnapshot, /Send to C to fix, or Dismiss/);

// In-flight fix pass — supervisor should describe the scoped fix in progress.
const inFlightSnapshot = buildSupervisorSnapshot(
  {
    concept: 'Login form',
    currentPhase: 'security-audit',
    pipelineStatus: 'awaiting-audit-decision',
    securityMode: 'fast',
    runGoal: 'full-build',
    runFinalAudit: true,
    stopAfterPhase: 'none',
    activeAgent: 'C',
    buildComplete: false,
    agentStatus: { A: 'done', B: 'done', C: 'active', D: 'idle', E: 'idle', S: 'idle' },
    runtime: { activeTurn: null },
    events: [],
    auditFindings: [
      { id: 'finding-aaa', severity: 'critical', text: '[src/api/auth.ts:42] SQL injection', status: 'sent-to-c' },
    ],
    auditDeployPending: true,
    auditActionInFlight: true,
  },
  null
);

assert.match(inFlightSnapshot, /Audit action in flight: yes/);
assert.match(inFlightSnapshot, /scoped security fix is running/i);

// Clean audit, awaiting deploy.
const cleanAuditSnapshot = buildSupervisorSnapshot(
  {
    concept: 'Static hello',
    currentPhase: 'security-audit',
    pipelineStatus: 'awaiting-audit-decision',
    securityMode: 'fast',
    runGoal: 'full-build',
    runFinalAudit: true,
    stopAfterPhase: 'none',
    activeAgent: '',
    buildComplete: false,
    agentStatus: { A: 'done', B: 'done', C: 'done', D: 'done', E: 'done', S: 'idle' },
    runtime: { activeTurn: null },
    events: [],
    auditFindings: [],
    auditDeployPending: true,
    auditActionInFlight: false,
  },
  null
);

assert.match(cleanAuditSnapshot, /Audit is clean/i);
assert.match(cleanAuditSnapshot, /Deploy now/i);

console.log('supervisor snapshot checks passed');
