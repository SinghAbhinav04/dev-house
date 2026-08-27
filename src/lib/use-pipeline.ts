'use client';

import { useEffect, useState, useCallback } from 'react';
import type { PipelineRuntimeState } from '@/lib/pipeline-runtime';

/**
 * A roster member id. Members are user-authored, so this is any slug — the
 * fixed A–E squad no longer exists.
 */
export type AgentId = string;
export type Phase = 'concept' | 'planning' | 'plan-review' | 'coding' | 'code-review' | 'testing' | 'security-audit' | 'deploy' | 'complete';
export type AppMode = 'pipeline' | 'manual';
export type SecurityMode = 'fast' | 'strict';
export type PermissionMode = 'auto' | 'plan' | 'dangerously-skip-permissions';
export type RunGoal = 'full-build' | 'plan-only';
/**
 * What a run does when a member that asked to be isolated cannot be: pause and
 * ask, or refuse to continue at all. There is no silent option — that was the
 * bug this setting exists to close.
 */
export type IsolationPolicy = 'ask' | 'required';
export type StopAfterPhase = 'none' | 'plan-review';
export type PipelineStatus = 'idle' | 'running' | 'paused' | 'awaiting-audit-decision' | 'complete' | 'failed';
export type ResumeAction = 'none' | 'continue-approved-plan' | 'resume-stalled-turn' | 'audit-send-to-c' | 'audit-dismiss' | 'audit-deploy';

export type AuditFindingStatus = 'open' | 'sent-to-c' | 're-auditing' | 'resolved' | 'still-open' | 'dismissed';

export interface AuditFindingHistoryEntry {
  time: string;
  action: 'created' | 'sent-to-c' | 'fix-applied' | 'fix-failed-tests' | 're-audit-passed' | 're-audit-failed' | 'dismissed';
  note?: string;
}

export interface AuditFinding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  text: string;
  status: AuditFindingStatus;
  createdAt: string;
  history: AuditFindingHistoryEntry[];
}

export interface PipelineEvent {
  time: string;
  agent: AgentId | 'system';
  phase: string;
  type: string;
  text: string;
  detail?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCostUsd: number;
}

/**
 * Usage as the state file actually stores it: a total plus the same numbers
 * attributed per member and per model. The client type said `TokenUsage`, so
 * anything reading a per-member figure had to go around it.
 */
export interface UsageBreakdown {
  total: TokenUsage;
  byMember: Record<string, TokenUsage>;
  byModel: Record<string, TokenUsage>;
}

export interface PipelineState {
  concept: string;
  projectDir: string;
  currentPhase: Phase;
  securityMode: SecurityMode;
  isolationPolicy: IsolationPolicy;
  runGoal: RunGoal;
  runFinalAudit: boolean;
  stopAfterPhase: StopAfterPhase;
  pipelineStatus: PipelineStatus;
  resumeAction?: ResumeAction;
  resumeActionTarget?: string;
  activeAgent: string;
  agentStatus: Record<AgentId, string>;
  sessions: Record<string, string>;
  buildComplete: boolean;
  usage: UsageBreakdown;
  runtime?: PipelineRuntimeState;
  events: PipelineEvent[];
  auditFindings?: AuditFinding[];
  auditDeployPending?: boolean;
  auditActionInFlight?: boolean;
}

export interface PendingApproval {
  requestId: string;
  projectDir: string;
  agent: AgentId | string;
  tool: string;
  input: Record<string, unknown>;
  description: string;
  createdAt: string;
  approved: boolean | null;
  sessionId?: string;
  phase?: string;
  reason?: string;
}

const EMPTY_STATE: PipelineState = {
  concept: '',
  projectDir: '',
  currentPhase: 'concept',
  securityMode: 'fast',
  isolationPolicy: 'ask',
  runGoal: 'full-build',
  runFinalAudit: false,
  stopAfterPhase: 'none',
  pipelineStatus: 'idle',
  resumeAction: 'none',
  resumeActionTarget: undefined,
  activeAgent: '',
  agentStatus: {},
  sessions: {},
  buildComplete: false,
  usage: {
    total: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCostUsd: 0 },
    byMember: {},
    byModel: {},
  },
  runtime: { activeTurn: null, activeTurns: {}, memoryInjected: {} },
  events: [],
  auditFindings: [],
  auditDeployPending: false,
  auditActionInFlight: false,
};

interface UsePipelineOptions {
  pollInterval?: number;
  mode: AppMode;
  model: string;
}

interface SendChatOptions {
  securityMode?: SecurityMode;
  permissionMode?: PermissionMode;
  runGoal?: RunGoal;
  runFinalAudit?: boolean;
}

export function usePipelineState({ pollInterval = 1500, mode, model }: UsePipelineOptions) {
  const [state, setState] = useState<PipelineState>(EMPTY_STATE);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let source: EventSource | null = null;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;

    /** Fallback used only if the stream cannot be established. */
    async function poll() {
      try {
        const res = await fetch(`/api/state?mode=${mode}&_=${Date.now()}`);
        if (!res.ok) return;
        const data = await res.json();
        if (active) {
          setState(data);
          setError(null);
        }
      } catch (err) {
        if (active) setError(String(err));
      }
    }

    function startFallbackPolling() {
      if (fallbackTimer || !active) return;
      poll();
      fallbackTimer = setInterval(poll, pollInterval);
    }

    try {
      source = new EventSource(`/api/stream?mode=${mode}`);

      source.addEventListener('state', (event) => {
        if (!active) return;
        try {
          setState(JSON.parse((event as MessageEvent).data));
          setError(null);
          setConnected(true);
        } catch {}
      });

      source.addEventListener('pending', (event) => {
        if (!active) return;
        try {
          setPendingApproval(JSON.parse((event as MessageEvent).data));
        } catch {}
      });

      source.onopen = () => {
        if (!active) return;
        setConnected(true);
        // The browser reconnects EventSource by itself, so once the stream is
        // healthy the fallback timer is pure waste.
        if (fallbackTimer) {
          clearInterval(fallbackTimer);
          fallbackTimer = null;
        }
      };

      source.onerror = () => {
        if (!active) return;
        setConnected(false);
        // EventSource retries on its own; polling covers the gap in case the
        // endpoint is unreachable rather than merely interrupted.
        startFallbackPolling();
      };
    } catch {
      startFallbackPolling();
    }

    return () => {
      active = false;
      source?.close();
      if (fallbackTimer) clearInterval(fallbackTimer);
    };
  }, [pollInterval, mode]);

  const sendChat = useCallback(async (agent: AgentId, message: string, options?: SendChatOptions) => {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent,
        message,
        mode,
        model,
        securityMode: options?.securityMode,
        permissionMode: options?.permissionMode,
        runGoal: options?.runGoal,
        runFinalAudit: options?.runFinalAudit,
      }),
    });
    return res.json();
  }, [mode, model]);

  const startPipeline = useCallback(async (
    securityMode: SecurityMode,
    runGoal: RunGoal,
    permissionMode?: PermissionMode,
    runFinalAudit?: boolean,
    isolationPolicy?: IsolationPolicy,
  ) => {
    const res = await fetch('/api/start-pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        securityMode,
        permissionMode,
        runGoal,
        runFinalAudit: runFinalAudit === true,
        isolationPolicy: isolationPolicy === 'required' ? 'required' : 'ask',
      }),
    });
    return res.json();
  }, []);

  const resumePipeline = useCallback(async () => {
    const res = await fetch('/api/resume-pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    return res.json();
  }, []);

  const sendFindingToC = useCallback(async (findingId: string) => {
    const res = await fetch('/api/audit-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'send-to-c', findingId }),
    });
    return res.json();
  }, []);

  const dismissFinding = useCallback(async (findingId: string) => {
    const res = await fetch('/api/audit-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss', findingId }),
    });
    return res.json();
  }, []);

  const deployAfterAudit = useCallback(async () => {
    const res = await fetch('/api/audit-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'deploy' }),
    });
    return res.json();
  }, []);

  const setStopAfterReview = useCallback(async (enabled: boolean) => {
    const res = await fetch('/api/pipeline-control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: enabled ? 'stop-after-review' : 'clear-stop-after-review',
      }),
    });
    return res.json();
  }, []);

  const stopPipeline = useCallback(async () => {
    const res = await fetch('/api/stop-pipeline', { method: 'POST' });
    return res.json();
  }, []);

  const approveBash = useCallback(async (approved: boolean, pending?: PendingApproval | null) => {
    const res = await fetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        approved,
        requestId: pending?.requestId,
        projectDir: pending?.projectDir,
      }),
    });
    return res.json();
  }, []);

  const getPlan = useCallback(async () => {
    const res = await fetch('/api/plan');
    if (!res.ok) return null;
    const data = await res.json();
    return data.content as string | null;
  }, []);

  const resetState = useCallback(async () => {
    const res = await fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    const data = await res.json();
    if (data?.ok) {
      setState(EMPTY_STATE);
      setError(null);
    }
    return data;
  }, [mode]);

  // Get events for a specific agent
  const agentEvents = useCallback((agent: AgentId) => {
    return state.events.filter(e => e.agent === agent);
  }, [state.events]);

  // Get latest speech for an agent (for bubble display)
  const agentSpeech = useCallback((agent: AgentId): string | null => {
    const events = state.events.filter(e => e.agent === agent && (e.type === 'text' || e.type === 'status' || e.type === 'tool_call'));
    if (events.length === 0) return null;
    const last = events[events.length - 1];
    return last.text.length > 80 ? last.text.slice(0, 77) + '...' : last.text;
  }, [state.events]);

  return {
    state,
    /** Pending bash approval, pushed on the same stream as state. */
    pendingApproval,
    /** Whether the event stream is live, as opposed to fallback polling. */
    connected,
    error,
    sendChat,
    startPipeline,
    resumePipeline,
    stopPipeline,
    setStopAfterReview,
    approveBash,
    getPlan,
    resetState,
    agentEvents,
    agentSpeech,
    sendFindingToC,
    dismissFinding,
    deployAfterAudit,
  };
}
