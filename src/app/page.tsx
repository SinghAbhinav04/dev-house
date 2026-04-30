'use client';

import Link from 'next/link';
import { useState, useRef, useEffect } from 'react';
import { Badge } from '@/components/shared/Badge';
import { AutoGrowTextarea } from '@/components/shared/AutoGrowTextarea';
import { MarkdownText } from '@/components/shared/MarkdownText';
import { LunarOfficeScene, type SeatMap } from '@/components/mission/LunarOfficeScene';
import { SecurityAuditPanel } from '@/components/agents/SecurityAuditPanel';
import { canAutoResumeTurn } from '@/lib/pipeline-runtime';
import { getExecutionPathStatus, getSupervisorRecommendation, getSupervisorUpdate } from '@/lib/pipeline-supervisor';
import { usePipelineState, type AgentId, type AppMode, type PendingApproval, type PermissionMode, type RunGoal, type SecurityMode } from '@/lib/use-pipeline';
import { useTeam } from '@/lib/use-team';
import { MODEL_ALIASES, SLOT_LABELS } from '@/lib/team/types';

const PHASE_LABELS: Record<string, string> = {
  concept: 'Concept', planning: 'Planning', 'plan-review': 'Plan Review',
  coding: 'Coding', 'code-review': 'Code Review', testing: 'Testing',
  'security-audit': 'Security Audit',
  deploy: 'Deploy', complete: 'Complete',
};

const PHASE_VARIANTS: Record<string, 'purple' | 'success' | 'warning' | 'danger' | 'neutral'> = {
  concept: 'neutral', planning: 'purple', 'plan-review': 'purple',
  coding: 'warning', 'code-review': 'warning', testing: 'danger',
  'security-audit': 'danger',
  deploy: 'success', complete: 'success',
};

const PHASE_PROGRESS: Record<string, number> = {
  concept: 5, planning: 20, 'plan-review': 35,
  coding: 55, 'code-review': 70, testing: 85,
  'security-audit': 90,
  deploy: 95, complete: 100,
};

const MODEL_OPTIONS = MODEL_ALIASES.map((value) => ({ value, label: value }));

/** Avatar text. Member ids are arbitrary length, so never render one raw. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export default function PipelinePage() {
  const [mode, setMode] = useState<AppMode>('pipeline');
  const [selectedModel, setSelectedModel] = useState('claude-sonnet-4-6');
  const [selectedSecurityMode, setSelectedSecurityMode] = useState<SecurityMode>('fast');
  const [selectedPermissionMode, setSelectedPermissionMode] = useState<PermissionMode>('auto');
  const [selectedRunGoal, setSelectedRunGoal] = useState<RunGoal>('full-build');
  const [selectedRunFinalAudit, setSelectedRunFinalAudit] = useState<boolean>(false);

  const {
    state, sendChat, startPipeline, resumePipeline, stopPipeline, setStopAfterReview, approveBash, getPlan, resetState, agentEvents, agentSpeech,
    sendFindingToC, dismissFinding, deployAfterAudit,
    pendingApproval,
    connected,
  } = usePipelineState({ mode, model: selectedModel });

  // The team is whoever is on the roster; there is no fixed squad to name.
  const { team } = useTeam();
  const members = team.members;

  const memberName = (id: string) =>
    id === 'system' ? 'System' : members.find((m) => m.id === id)?.name || id;

  const memberRole = (id: string) => {
    const member = members.find((m) => m.id === id);
    if (!member) return '';
    return member.title || (member.slot ? SLOT_LABELS[member.slot] : 'Direct chat only');
  };

  const supervisor = members.find((m) => m.slot === 'supervisor');
  const supervisorId = supervisor?.id || '';
  /** Everyone except the supervisor, who gets their own column. */
  const workers = members.filter((m) => m.id !== supervisorId);

  /**
   * Who sits at which desk. The desks are the six workflow slots, so a member
   * takes a desk by filling that slot; members with no slot are chat-only.
   */
  const seats: SeatMap = Object.fromEntries(
    members
      .filter((m) => m.slot)
      .map((m) => [m.slot as keyof SeatMap, { agentId: m.id, name: m.name, color: m.color }])
  );


  const [selectedAgent, setSelectedAgent] = useState<AgentId>('');
  const [chatInput, setChatInput] = useState('');
  const [sendingAgents, setSendingAgents] = useState<Set<AgentId>>(new Set());
  const [pipelineStarted, setPipelineStarted] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const [planContent, setPlanContent] = useState<string | null>(null);
  const [expandedAgent, setExpandedAgent] = useState<AgentId | null>(null);
  const [panelInputs, setPanelInputs] = useState<Record<string, string>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());

  const panelRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const modalRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const prevCounts = useRef<Record<string, number>>({});
  const prevFeedCount = useRef(0);
  const completionNotifiedRef = useRef(false);

  const isPipeline = mode === 'pipeline';
  const hasLivePipelineActivity = Boolean(state.activeAgent || state.runtime?.activeTurn || pendingApproval);
  const pipelineRunning = isPipeline && (state.pipelineStatus === 'running' || (!state.buildComplete && (pipelineStarted || hasLivePipelineActivity)));
  const pipelinePaused = isPipeline && state.pipelineStatus === 'paused';
  const pipelineFailed = isPipeline && state.pipelineStatus === 'failed';

  // Auto-scroll: all panels, expanded modal, and live feed
  useEffect(() => {
    for (const { id } of workers) {
      const events = agentEvents(id);
      if (events.length > (prevCounts.current[id] || 0)) {
        const el = panelRefs.current[id];
        if (el) el.scrollTop = el.scrollHeight;
        if (expandedAgent === id && modalRef.current) {
          modalRef.current.scrollTop = modalRef.current.scrollHeight;
        }
        prevCounts.current[id] = events.length;
      }
    }
    if (supervisorId) {
      const sEvents = agentEvents(supervisorId);
      const sEl = panelRefs.current[supervisorId];
      if (sEl && sEvents.length > (prevCounts.current[supervisorId] || 0)) {
        sEl.scrollTop = sEl.scrollHeight;
        prevCounts.current[supervisorId] = sEvents.length;
      }
    }
    if (state.events.length > prevFeedCount.current && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
      prevFeedCount.current = state.events.length;
    }
  }, [state.events.length, agentEvents, expandedAgent, workers, supervisorId]);

  // Detect pipeline completion (pipeline mode only)
  useEffect(() => {
    if (!isPipeline) return;
    if (state.buildComplete && !completionNotifiedRef.current && (pipelineStarted || !!state.projectDir)) {
      completionNotifiedRef.current = true;
      try {
        const ctx = new AudioContext();
        [523.25, 659.25].forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.15);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.5);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(ctx.currentTime + i * 0.15);
          osc.stop(ctx.currentTime + i * 0.15 + 0.5);
        });
      } catch {}
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('Hackeroom', { body: 'Build complete!' });
      }
    }
  }, [state.buildComplete, isPipeline, pipelineStarted, state.projectDir]);

  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  async function handleSend() {
    if (sendingAgents.has(supervisorId) || !chatInput.trim()) return;
    setSendingAgents(prev => new Set([...prev, supervisorId]));
    await sendChat(supervisorId, chatInput.trim(), isPipeline ? {
      securityMode: selectedSecurityMode,
      permissionMode: selectedPermissionMode,
      runGoal: selectedRunGoal,
      runFinalAudit: selectedRunFinalAudit,
    } : undefined);
    setChatInput('');
    setSendingAgents(prev => { const n = new Set(prev); n.delete(supervisorId); return n; });
  }

  async function handleStartPipeline() {
    completionNotifiedRef.current = false;
    setPipelineStarted(true);
    const res = await startPipeline(selectedSecurityMode, selectedRunGoal, selectedPermissionMode, selectedRunFinalAudit);
    if (!res?.success) {
      setPipelineStarted(false);
      console.error('Pipeline failed to start:', res?.error || 'Unknown error');
    }
  }

  async function handleResumePipeline() {
    completionNotifiedRef.current = false;
    setPipelineStarted(true);
    const res = await resumePipeline();
    if (!res?.success) {
      setPipelineStarted(false);
      console.error('Pipeline failed to resume:', res?.error || 'Unknown error');
    }
  }

  async function handleViewPlan() {
    const content = await getPlan();
    setPlanContent(content);
    setShowPlan(true);
  }

  async function handleReset() {
    if (isPipeline) {
      await fetch('/api/stop-pipeline', { method: 'POST' });
    }
    await resetState();
    setPipelineStarted(false);
    completionNotifiedRef.current = false;
    setSelectedAgent('S');
    setExpandedAgent(null);
    setChatInput('');
    setShowPlan(false);
    setPlanContent(null);
    setPanelInputs({ A: '', B: '', C: '', D: '' });
  }

  async function handlePanelSend(id: AgentId) {
    const msg = panelInputs[id]?.trim();
    if (sendingAgents.has(id) || !msg) return;

    setSendingAgents(prev => new Set([...prev, id]));
    setSelectedAgent(id);
    await sendChat(id, msg, isPipeline ? {
      securityMode: selectedSecurityMode,
      permissionMode: selectedPermissionMode,
      runGoal: selectedRunGoal,
      runFinalAudit: selectedRunFinalAudit,
    } : undefined);
    setPanelInputs(prev => ({ ...prev, [id]: '' }));
    setSendingAgents(prev => { const n = new Set(prev); n.delete(id); return n; });
  }

  async function handleExpandedSend() {
    if (!expandedAgent || sendingAgents.has(expandedAgent) || !chatInput.trim()) return;
    const msg = chatInput.trim();

    setSendingAgents(prev => new Set([...prev, expandedAgent]));
    await sendChat(expandedAgent, msg, isPipeline ? {
      securityMode: selectedSecurityMode,
      permissionMode: selectedPermissionMode,
      runGoal: selectedRunGoal,
      runFinalAudit: selectedRunFinalAudit,
    } : undefined);
    setChatInput('');
    setSendingAgents(prev => { const n = new Set(prev); n.delete(expandedAgent!); return n; });
  }

  async function handleHandoff(fromAgent: AgentId, toAgent: AgentId) {
    const textEvents = state.events.filter(e => e.agent === fromAgent && e.type === 'text');
    if (textEvents.length === 0) return;
    let text = textEvents[textEvents.length - 1].text;
    if (text.length > 2000) text = text.slice(0, 2000) + '...(truncated)';
    const msg = `[HANDOFF:${fromAgent}→${toAgent}] ${text}\n\nReview this and continue the work.`;
    setSendingAgents(prev => new Set([...prev, toAgent]));
    await sendChat(toAgent, msg, isPipeline ? {
      securityMode: selectedSecurityMode,
      permissionMode: selectedPermissionMode,
      runGoal: selectedRunGoal,
      runFinalAudit: selectedRunFinalAudit,
    } : undefined);
    setSendingAgents(prev => { const n = new Set(prev); n.delete(toAgent); return n; });
  }

  const phase = state.currentPhase;
  const progress = PHASE_PROGRESS[phase] || 0;
  const securityModeLocked = isPipeline && (pipelineStarted || pipelineRunning || !!state.projectDir);
  const activeSecurityMode = state.projectDir ? (state.securityMode || 'fast') : selectedSecurityMode;
  const activeRunGoal = state.projectDir ? (state.runGoal || 'full-build') : selectedRunGoal;
  const activeRunFinalAudit = state.projectDir ? !!state.runFinalAudit : selectedRunFinalAudit;

  const auditHasStarted = !!(
    activeRunFinalAudit && (
      state.currentPhase === 'security-audit' ||
      state.pipelineStatus === 'awaiting-audit-decision' ||
      (state.auditFindings && state.auditFindings.length > 0)
    )
  );

  // Derived stats
  const firstEventTime = state.events.length > 0 ? new Date(state.events[0].time).getTime() : 0;
  const lastEventTime = state.events.length > 0 ? new Date(state.events[state.events.length - 1].time).getTime() : 0;
  const elapsedMs = firstEventTime ? lastEventTime - firstEventTime : 0;
  const elapsedMin = Math.floor(elapsedMs / 60000);
  const elapsedSec = Math.floor((elapsedMs % 60000) / 1000);
  const elapsed = elapsedMs > 0 ? `${elapsedMin}m ${elapsedSec}s` : '--';

  const filesModified = new Set(
    state.events
      .filter(e => e.type === 'tool_call' && /\b(Write|Edit|CREATE|WRITE)\b/.test(e.text))
      .map(e => {
        const match = e.text.match(/(?:Write|Edit|CREATE|WRITE)\s+(\S+)/);
        return match ? match[1] : null;
      })
      .filter(Boolean)
  ).size;

  const lastAction = (() => {
    const toolEvents = state.events.filter(e => e.type === 'tool_call');
    if (toolEvents.length === 0) return null;
    const last = toolEvents[toolEvents.length - 1];
    return { agent: last.agent, text: last.text.length > 50 ? last.text.slice(0, 47) + '...' : last.text };
  })();

  const errorCount = state.events.filter(e => e.type === 'issue' || e.type === 'failure').length;
  const activeTurn = state.runtime?.activeTurn || null;
  const activeTurnIdleSeconds = activeTurn
    ? Math.max(0, Math.floor((nowMs - new Date(activeTurn.lastEventAt).getTime()) / 1000))
    : 0;
  const stopAfterReviewArmed = state.stopAfterPhase === 'plan-review' || activeRunGoal === 'plan-only';
  const canResumeStalledTurn = Boolean(
    activeTurn &&
    activeTurn.status === 'stalled' &&
    activeTurn.sessionId &&
    canAutoResumeTurn(activeTurn.agent, activeTurn.phase)
  );
  const canContinueApprovedPlan = pipelinePaused && phase === 'plan-review' && !!state.events.some((event) => event.text.includes('PLAN APPROVED'));
  const supervisorRecommendation = isPipeline ? getSupervisorRecommendation(state, pendingApproval) : null;
  const supervisorUpdate = isPipeline ? getSupervisorUpdate(state, pendingApproval) : null;
  const executionPathStatus = isPipeline ? getExecutionPathStatus(state) : null;
  const modePosture = isPipeline
    ? {
        title: 'Pipeline Guardrails',
        summary: activeSecurityMode === 'strict'
          ? 'Supervisor-led team run. Strict mode asks for approval on every Coder/Tester Bash call.'
          : 'Supervisor-led team run. Fast mode keeps the team moving, but this is still guardrails, not a sandbox.',
        detail: executionPathStatus?.detail || 'Host execution is the default today. Docker isolation is built, but still alpha until subscription auth in containers is reliable.',
        tone: activeSecurityMode === 'strict' ? 'warning' : 'info',
      }
    : {
        title: 'Manual Direct Sessions',
        summary: 'You are driving the team directly. Claude permission prompts still protect each session, but pipeline role guardrails and supervisor automation are not enforcing the flow for you.',
        detail: 'Use manual mode when you want direct specialist access. Use pipeline mode when you want the build doctrine and supervisor controls around the team.',
        tone: 'info',
      };

  return (
    <div className="p-4 space-y-4">
      {/* Hero: Animation + Feed (65%) + Dashboard (35%) */}
      <div className="grid gap-4" style={{ gridTemplateColumns: '65% 1fr' }}>
        {/* Office Scene + Live Feed below it — height driven by dashboard */}
        <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-surface-raised" style={{ height: 0, minHeight: '100%' }}>
          <div className="p-2">
            <LunarOfficeScene
              activePhase={phase}
              agentStatus={state.agentStatus}
              latestSpeech={Object.fromEntries(members.map((m) => [m.id, agentSpeech(m.id)]))}
              runFinalAudit={activeRunFinalAudit}
              seats={seats}
              members={members}
              onAgentClick={(id) => { setSelectedAgent(id); setExpandedAgent(id); }}
            />
          </div>
          {/* Live Feed — fills remaining space below animation */}
          <div className="flex min-h-0 flex-1 flex-col border-t border-line">
            <div className="flex items-center justify-between px-4 py-1.5">
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 animate-pulse rounded-full bg-signal-ok" />
                <span className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">Live Feed</span>
              </div>
              <span className="font-mono text-[10px] text-ink-faint">{state.events.length} events</span>
            </div>
            <div
              ref={feedRef}
              className="flex-1 overflow-y-auto px-4 pb-2 font-mono [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-sm [&::-webkit-scrollbar-thumb]:bg-[var(--surface-overlay)] [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-[3px]"
            >
              {state.events.length === 0 && (
                <p className="py-4 text-center text-xs text-ink-faint">{isPipeline ? 'Waiting for pipeline events...' : 'Waiting for activity...'}</p>
              )}
              {state.events.map((e, i) => (
                <div key={i} className="flex gap-2 py-[2px] text-[11px] leading-relaxed">
                  <span className="flex-shrink-0 text-ink-faint">
                    {new Date(e.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <span className={`flex-shrink-0 w-[18px] font-bold ${
                    e.agent === 'A' ? 'text-accent' :
                    e.agent === 'B' ? 'text-accent-cool' :
                    e.agent === 'C' ? 'text-signal-warn' :
                    e.agent === 'D' ? 'text-signal-bad' :
                    e.agent === 'S' ? 'text-signal-ok' :
                    'text-ink-faint'
                  }`}>{e.agent === 'system' ? '--' : e.agent}</span>
                  <div className={`min-w-0 ${
                    e.type === 'approval' ? 'font-bold text-signal-ok' :
                    e.type === 'question' ? 'text-accent' :
                    e.type === 'issue' || e.type === 'failure' ? 'text-signal-bad' :
                    e.type === 'tool_call' ? 'text-[var(--ink-faint)]' :
                    e.type === 'user_msg' ? 'text-accent-cool' :
                    e.type === 'text' ? 'text-ink-soft' : 'text-[var(--ink-faint)]'
                  }`}><MarkdownText>{e.text}</MarkdownText></div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Dashboard */}
        <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface-raised p-5">
          {/* Title + Mode Toggle */}
          <div>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h1 className="text-xl font-bold uppercase tracking-wider text-ink">Hackeroom</h1>
                <p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-ink-faint">Office View</p>
              </div>
              <div className="flex items-center gap-2">
                <Link
                  href="/team"
                  className="rounded-lg border border-accent/40 bg-accent-soft px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-accent transition hover:bg-accent/20"
                >
                  Manage Team
                </Link>
                <Link
                  href="/squad"
                  className="rounded-lg border border-line bg-surface-raised px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-ink-soft transition hover:border-line-strong hover:bg-surface-raised hover:text-ink"
                >
                  Open Squad View
                </Link>
              </div>
            </div>
            {/* Mode Toggle */}
            <div className="mt-2 flex items-center gap-2">
              <div className="flex rounded-lg border border-line bg-surface-raised">
                <button
                  onClick={() => setMode('pipeline')}
                  className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-all ${isPipeline ? 'bg-accent text-ink' : 'text-[var(--ink-faint)] hover:text-[var(--ink-faint)]'}`}
                  style={{ borderRadius: '7px 0 0 7px' }}
                >Pipeline</button>
                <button
                  onClick={() => setMode('manual')}
                  className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-all ${!isPipeline ? 'bg-accent-cool text-ink' : 'text-[var(--ink-faint)] hover:text-[var(--ink-faint)]'}`}
                  style={{ borderRadius: '0 7px 7px 0' }}
                >Manual</button>
              </div>
              {/* Model Picker — manual mode only */}
              {!isPipeline && (
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="rounded-lg border border-line bg-surface-raised px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-ink-soft focus:border-accent-cool focus:outline-none"
                >
                  {MODEL_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value} className="bg-[var(--surface-raised)]">{opt.label}</option>
                  ))}
                </select>
              )}
            </div>
            <div className={`mt-3 rounded-xl border px-3 py-3 ${
              modePosture.tone === 'warning'
                ? 'border-signal-warn/30 bg-signal-warn/10'
                : 'border-line bg-surface-raised'
            }`}>
              <div className="flex items-center justify-between gap-3">
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-ink-soft">{modePosture.title}</div>
                <Badge variant={isPipeline ? (activeSecurityMode === 'strict' ? 'warning' : 'success') : 'neutral'}>
                  {isPipeline ? 'SUPERVISOR-RUN' : 'YOU-RUN'}
                </Badge>
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-ink">{modePosture.summary}</p>
              <p className="mt-2 text-[11px] leading-relaxed text-ink-soft">{modePosture.detail}</p>
            </div>
            {isPipeline && (
              <div className="mt-3">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-faint">Security Mode</div>
                <div className="flex items-center gap-2">
                  <div className="flex rounded-lg border border-line bg-surface-raised">
                    <button
                      onClick={() => setSelectedSecurityMode('fast')}
                      disabled={securityModeLocked}
                      className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-all disabled:cursor-not-allowed disabled:opacity-50 ${selectedSecurityMode === 'fast' ? 'bg-signal-ok text-ink' : 'text-[var(--ink-faint)] hover:text-[var(--ink-faint)]'}`}
                      style={{ borderRadius: '7px 0 0 7px' }}
                    >Fast</button>
                    <button
                      onClick={() => setSelectedSecurityMode('strict')}
                      disabled={securityModeLocked}
                      className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-all disabled:cursor-not-allowed disabled:opacity-50 ${selectedSecurityMode === 'strict' ? 'bg-signal-warn text-ink' : 'text-[var(--ink-faint)] hover:text-[var(--ink-faint)]'}`}
                      style={{ borderRadius: '0 7px 7px 0' }}
                    >Strict</button>
                  </div>
                  <span className="text-[10px] text-ink-faint">
                    {selectedSecurityMode === 'strict'
                      ? 'Every C/D Bash call needs approval'
                      : 'Safe Bash auto-runs, risky Bash asks'}
                  </span>
                </div>
              </div>
            )}
            {isPipeline && (
              <div className="mt-3">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-faint">Permission Mode</div>
                <div className="flex items-center gap-2">
                  <div className="flex rounded-lg border border-line bg-surface-raised">
                    <button
                      onClick={() => setSelectedPermissionMode('auto')}
                      disabled={securityModeLocked}
                      className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-all disabled:cursor-not-allowed disabled:opacity-50 ${selectedPermissionMode === 'auto' ? 'bg-signal-ok text-ink' : 'text-[var(--ink-faint)] hover:text-[var(--ink-faint)]'}`}
                      style={{ borderRadius: '7px 0 0 7px' }}
                    >Auto</button>
                    <button
                      onClick={() => setSelectedPermissionMode('plan')}
                      disabled={securityModeLocked}
                      className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-all disabled:cursor-not-allowed disabled:opacity-50 ${selectedPermissionMode === 'plan' ? 'bg-accent-cool text-ink' : 'text-[var(--ink-faint)] hover:text-[var(--ink-faint)]'}`}
                    >Plan</button>
                    <button
                      onClick={() => setSelectedPermissionMode('dangerously-skip-permissions')}
                      disabled={securityModeLocked}
                      className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-all disabled:cursor-not-allowed disabled:opacity-50 ${selectedPermissionMode === 'dangerously-skip-permissions' ? 'bg-signal-bad text-ink' : 'text-[var(--ink-faint)] hover:text-[var(--ink-faint)]'}`}
                      style={{ borderRadius: '0 7px 7px 0' }}
                    >Skip</button>
                  </div>
                  <span className="text-[10px] text-ink-faint">
                    {selectedPermissionMode === 'auto'
                      ? 'AI safety classifier (requires auto mode access)'
                      : selectedPermissionMode === 'plan'
                      ? 'Asks before every tool call'
                      : 'No permission checks — wild west'}
                  </span>
                </div>
              </div>
            )}
            {isPipeline && (
              <div className="mt-3">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-faint">Supervisor Goal</div>
                <div className="flex items-center gap-2">
                  <div className="flex rounded-lg border border-line bg-surface-raised">
                    <button
                      onClick={() => setSelectedRunGoal('full-build')}
                      disabled={securityModeLocked}
                      className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-all disabled:cursor-not-allowed disabled:opacity-50 ${selectedRunGoal === 'full-build' ? 'bg-accent-cool text-ink' : 'text-[var(--ink-faint)] hover:text-[var(--ink-faint)]'}`}
                      style={{ borderRadius: '7px 0 0 7px' }}
                    >Full Build</button>
                    <button
                      onClick={() => setSelectedRunGoal('plan-only')}
                      disabled={securityModeLocked}
                      className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-all disabled:cursor-not-allowed disabled:opacity-50 ${selectedRunGoal === 'plan-only' ? 'bg-accent text-ink' : 'text-[var(--ink-faint)] hover:text-[var(--ink-faint)]'}`}
                      style={{ borderRadius: '0 7px 7px 0' }}
                    >Plan Only</button>
                  </div>
                  <span className="text-[10px] text-ink-faint">
                    {selectedRunGoal === 'plan-only'
                      ? 'Stop cleanly after B approves the plan'
                      : 'Run the full team from planning through testing'}
                  </span>
                </div>
              </div>
            )}
            {isPipeline && (
              <div className="mt-3">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-faint">Security Audit</div>
                <div className="flex items-center gap-2">
                  <div className="flex rounded-lg border border-line bg-surface-raised">
                    <button
                      onClick={() => setSelectedRunFinalAudit(false)}
                      disabled={securityModeLocked}
                      className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-all disabled:cursor-not-allowed disabled:opacity-50 ${!selectedRunFinalAudit ? 'bg-surface-overlay text-ink' : 'text-[var(--ink-faint)] hover:text-[var(--ink-faint)]'}`}
                      style={{ borderRadius: '7px 0 0 7px' }}
                    >Off</button>
                    <button
                      onClick={() => setSelectedRunFinalAudit(true)}
                      disabled={securityModeLocked}
                      className={`px-3 py-1 text-[10px] font-bold uppercase tracking-wider transition-all disabled:cursor-not-allowed disabled:opacity-50 ${selectedRunFinalAudit ? 'bg-signal-bad text-ink' : 'text-[var(--ink-faint)] hover:text-[var(--ink-faint)]'}`}
                      style={{ borderRadius: '0 7px 7px 0' }}
                    >On</button>
                  </div>
                  <span className="text-[10px] text-ink-faint">
                    {selectedRunFinalAudit
                      ? 'After tests pass, E reads everything and reports vulnerabilities. Build still completes.'
                      : 'Skip the post-test security audit'}
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Pipeline-only: Phase + Progress */}
          {isPipeline && (
            <>
              <div className="flex items-center gap-2">
                <Badge variant={PHASE_VARIANTS[phase] || 'neutral'}>
                  {PHASE_LABELS[phase] || phase}
                </Badge>
                {state.activeAgent && (
                  <Badge variant="purple">Agent {state.activeAgent}</Badge>
                )}
                {activeTurn?.status === 'stalled' && (
                  <Badge variant="warning">TURN STALLED</Badge>
                )}
                <Badge variant={activeSecurityMode === 'strict' ? 'warning' : 'success'}>
                  {activeSecurityMode === 'strict' ? 'STRICT' : 'FAST'}
                </Badge>
                <Badge variant={activeRunGoal === 'plan-only' ? 'purple' : 'neutral'}>
                  {activeRunGoal === 'plan-only' ? 'PLAN ONLY' : 'FULL BUILD'}
                </Badge>
                {activeRunFinalAudit && (
                  <Badge variant="warning">AUDIT ON</Badge>
                )}
                {executionPathStatus && (
                  <Badge variant={executionPathStatus.variant}>
                    {executionPathStatus.label}
                  </Badge>
                )}
                {state.stopAfterPhase === 'plan-review' && activeRunGoal === 'full-build' && (
                  <Badge variant="warning">STOP AFTER REVIEW</Badge>
                )}
                {pipelinePaused && (
                  <Badge variant="warning">PAUSED</Badge>
                )}
                {pipelineFailed && (
                  <Badge variant="danger">FAILED</Badge>
                )}
                {state.buildComplete && <Badge variant="success">COMPLETE</Badge>}
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-ink-faint">
                  <span>Progress</span>
                  <span>{progress}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-surface-raised">
                  <div className="h-full rounded-full bg-gradient-to-r from-accent to-signal-ok transition-all duration-700" style={{ width: `${progress}%` }} />
                </div>
              </div>
            </>
          )}

          {/* Manual mode: simple label */}
          {!isPipeline && (
            <div className="text-[10px] uppercase tracking-wider text-accent-cool">Manual Mode — direct specialist sessions with Claude permission prompts</div>
          )}

          {/* Agent Status — both modes */}
          <div>
            <div className="mb-2 text-[10px] uppercase tracking-wider text-ink-faint">Agents</div>
            <div className="grid grid-cols-4 gap-2">
              {members.map(({ id }) => {
                const status = state.agentStatus[id] || 'idle';
                const isActive = status === 'active' || status === 'working';
                return (
                  <div key={id} className="flex flex-col items-center gap-1">
                    <div className={`flex h-10 w-10 items-center justify-center rounded-xl border-2 text-sm font-bold transition-all ${
                      isActive
                        ? 'border-signal-ok text-signal-ok shadow-[0_0_12px_rgba(34,197,94,0.3)]'
                        : status === 'done'
                        ? 'border-signal-bad text-signal-bad shadow-[0_0_12px_rgba(239,68,68,0.3)]'
                        : 'border-[var(--surface-overlay)] text-[var(--ink-faint)]'
                    }`} style={{ background: 'var(--surface)' }}>{initials(memberName(id))}</div>
                    <span className="w-full truncate text-center text-[9px] text-ink-faint">{memberName(id)}</span>
                    <span className={`text-[8px] font-bold uppercase ${isActive ? 'text-signal-ok' : status === 'done' ? 'text-signal-bad' : 'text-ink-faint'}`}>{status}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Pipeline-only: Stats, Last Action, Concept */}
          {isPipeline && (
            <>
              <div>
                <div className="mb-2 text-[10px] uppercase tracking-wider text-ink-faint">Pipeline</div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs">
                  <div className="flex justify-between"><span className="text-ink-faint">Elapsed</span><span className="text-ink-soft">{elapsed}</span></div>
                  <div className="flex justify-between"><span className="text-ink-faint">Files</span><span className="text-ink-soft">{filesModified}</span></div>
                  <div className="flex justify-between"><span className="text-ink-faint">Events</span><span className="text-ink-soft">{state.events.length}</span></div>
                  <div className="flex justify-between"><span className="text-ink-faint">Errors</span><span className={errorCount > 0 ? 'text-signal-bad' : 'text-ink-faint'}>{errorCount}</span></div>
                </div>
              </div>

              {executionPathStatus && (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-faint">Execution Path</div>
                  <div className={`rounded-lg border px-3 py-2 text-[11px] ${
                    executionPathStatus.variant === 'warning'
                      ? 'border-signal-warn/40 bg-signal-warn/10 text-signal-warn'
                      : executionPathStatus.variant === 'purple'
                      ? 'border-accent/30 bg-accent/10 text-accent'
                      : executionPathStatus.variant === 'success'
                      ? 'border-signal-ok/30 bg-signal-ok/10 text-signal-ok'
                      : 'border-line bg-surface-raised text-ink-soft'
                  }`}>
                    <div className="font-semibold">{executionPathStatus.label}</div>
                    <p className="mt-1 leading-relaxed">{executionPathStatus.detail}</p>
                  </div>
                </div>
              )}

              {lastAction && (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-faint">Last Action</div>
                  <div className="truncate rounded-lg bg-surface-raised px-3 py-2 font-mono text-[11px]">
                    <span className={`mr-1.5 font-bold ${
                      lastAction.agent === 'A' ? 'text-accent' :
                      lastAction.agent === 'B' ? 'text-accent-cool' :
                      lastAction.agent === 'C' ? 'text-signal-warn' :
                      lastAction.agent === 'D' ? 'text-signal-bad' :
                      'text-signal-ok'
                    }`}>{lastAction.agent}</span>
                    <span className="text-ink-soft">{lastAction.text}</span>
                  </div>
                </div>
              )}

              {activeTurn && (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-faint">Current Turn</div>
                  <div className={`rounded-lg border px-3 py-2 text-[11px] ${
                    activeTurn.status === 'stalled'
                      ? 'border-signal-warn/40 bg-signal-warn/10 text-signal-warn'
                      : 'border-line bg-surface-raised text-ink-soft'
                  }`}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-semibold">
                        Agent {activeTurn.agent} · {PHASE_LABELS[activeTurn.phase] || activeTurn.phase}
                      </span>
                      <span className="font-mono text-[10px] uppercase tracking-wider text-ink-faint">
                        idle {activeTurnIdleSeconds}s
                      </span>
                    </div>
                    <p className="mt-1 leading-relaxed">{activeTurn.promptSummary}</p>
                    {activeTurn.status === 'stalled' && (
                      <p className="mt-2 text-[10px] uppercase tracking-wider text-signal-warn">
                        {activeTurn.stallReason || 'This turn appears stalled.'}
                      </p>
                    )}
                    {activeTurn.autoResumeCount > 0 && (
                      <p className="mt-2 text-[10px] uppercase tracking-wider text-accent">
                        Auto-resume attempts: {activeTurn.autoResumeCount}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {state.concept && (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-faint">Concept</div>
                  <p className="text-xs leading-relaxed text-ink-soft">{state.concept}</p>
                </div>
              )}

              {supervisorUpdate && (
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-faint">Supervisor Update</div>
                  <div className={`rounded-lg border px-3 py-2 text-[11px] ${
                    supervisorUpdate.severity === 'warning'
                      ? 'border-signal-warn/40 bg-signal-warn/10 text-signal-warn'
                      : supervisorUpdate.severity === 'success'
                      ? 'border-signal-ok/30 bg-signal-ok/10 text-signal-ok'
                      : 'border-line bg-surface-raised text-ink-soft'
                  }`}>
                    <div className="font-semibold">{supervisorUpdate.title}</div>
                    <p className="mt-1 leading-relaxed">{supervisorUpdate.summary}</p>
                    {supervisorUpdate.ask && (
                      <p className="mt-2 text-[11px] leading-relaxed text-ink-soft/90">
                        {supervisorUpdate.ask}
                      </p>
                    )}
                    {(supervisorRecommendation?.actionLabel || supervisorRecommendation?.chatCommand) && (
                      <p className="mt-2 text-[10px] uppercase tracking-wider text-ink-soft">
                        {supervisorRecommendation?.actionLabel || 'Suggested action'}
                        {supervisorRecommendation?.chatCommand ? ` · try "${supervisorRecommendation.chatCommand}"` : ''}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Controls */}
          <div>
            {isPipeline && (
              <div className="mb-2 text-[10px] uppercase tracking-wider text-ink-faint">
                Ask <span className="font-semibold text-signal-ok">S</span> to start, pause, continue, resume, or stop. Buttons are fallback controls, not the main workflow.
              </div>
            )}
            <div className="flex gap-2">
            {isPipeline && !pipelineRunning && !pipelinePaused && (!state.projectDir || state.currentPhase === 'concept' || state.buildComplete) && (
              <button onClick={handleStartPipeline} className="rounded-lg bg-signal-ok px-4 py-2 text-sm font-bold text-black transition hover:bg-signal-ok">
                {selectedRunGoal === 'plan-only' ? 'START PLAN ONLY' : 'START FULL BUILD'}
              </button>
            )}
            {isPipeline && pipelineRunning && (phase === 'planning' || phase === 'plan-review') && activeRunGoal === 'full-build' && (
              <button
                onClick={() => { void setStopAfterReview(!stopAfterReviewArmed); }}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-bold text-ink transition hover:bg-accent"
              >
                {stopAfterReviewArmed ? 'KEEP RUNNING AFTER REVIEW' : 'STOP AFTER REVIEW'}
              </button>
            )}
            {isPipeline && canContinueApprovedPlan && (
              <button onClick={handleResumePipeline} className="rounded-lg bg-accent-cool px-4 py-2 text-sm font-bold text-ink transition hover:bg-accent-cool">
                CONTINUE BUILD
              </button>
            )}
            {isPipeline && canResumeStalledTurn && (
              <button onClick={handleResumePipeline} className="rounded-lg bg-signal-warn px-4 py-2 text-sm font-bold text-black transition hover:bg-signal-warn">
                RESUME STALLED RUN
              </button>
            )}
            <button onClick={() => { setPipelineStarted(false); completionNotifiedRef.current = false; stopPipeline(); setSendingAgents(new Set()); }} className="rounded-lg bg-signal-bad px-4 py-2 text-sm font-bold text-ink transition hover:bg-signal-bad">
              STOP
            </button>
            {isPipeline && state.events.some(e => e.text?.includes('plan.md')) && (
              <button onClick={handleViewPlan} className="rounded-lg border border-line bg-surface-raised px-4 py-2 text-sm text-ink hover:bg-surface-raised">
                View Plan
              </button>
            )}
            <button onClick={handleReset} className="rounded-lg border border-line bg-surface-raised px-4 py-2 text-sm text-ink-soft transition hover:bg-signal-bad/10 hover:text-signal-bad hover:border-signal-bad/20">
              Reset
            </button>
          </div>
          </div>
        </div>
      </div>

      {/* Agent-panel grid: S spans left column. A/B/C/D fill the center quadrants.
          When the security audit starts, E is added on the right (same size as S)
          and the center columns squish to accommodate. */}
      <div
        className="grid gap-px overflow-hidden rounded-xl border border-line bg-[var(--surface-raised)]"
        style={{
          gridTemplateColumns: auditHasStarted ? '25% 1fr 1fr 25%' : '30% 1fr 1fr',
          gridTemplateRows: '1fr 1fr',
          height: '100vh',
        }}
      >
        {/* S — Supervisor, spans both rows */}
          <div className="flex cursor-pointer flex-col overflow-hidden bg-[var(--surface-sunken)]" style={{ gridRow: '1 / -1' }} onClick={() => setSelectedAgent('S')}>
            <div className="flex items-center gap-3 border-b-2 border-signal-ok px-3.5 py-2.5">
            <div className={`flex h-9 w-9 items-center justify-center rounded-[10px] border-2 text-sm font-bold transition-all ${
              (state.agentStatus.S === 'active' || state.agentStatus.S === 'working')
                ? 'border-signal-ok text-signal-ok shadow-[0_0_16px_rgba(34,197,94,0.25)]'
                : 'border-[var(--surface-overlay)] text-[var(--ink-faint)]'
            }`} style={{ background: 'var(--surface)' }}>S</div>
            <div>
              <div className="text-[13px] font-semibold text-[var(--ink-soft)]">Supervisor</div>
              <div className="text-[10px] text-[var(--ink-faint)]">{isPipeline ? 'Recommended front door. Direct specialist chat still works.' : 'Oversight & diagnostics'}</div>
            </div>
            {isPipeline && state.events.some(e => e.text?.includes('plan.md')) && (
              <button onClick={handleViewPlan} className="ml-auto rounded border border-line bg-surface-raised px-2.5 py-0.5 text-[11px] text-ink hover:bg-surface-raised">
                View Plan
              </button>
            )}
          </div>
          <div
            ref={(el) => { panelRefs.current.S = el; }}
            className="flex-1 space-y-px overflow-y-auto px-2.5 py-1.5 [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-sm [&::-webkit-scrollbar-thumb]:bg-[var(--surface-overlay)] [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-[3px]"
          >
            {isPipeline && supervisorUpdate && (
              <div className={`mb-2 rounded border px-2 py-1.5 text-[11px] ${
                supervisorUpdate.severity === 'warning'
                  ? 'border-signal-warn/30 bg-signal-warn/10 text-signal-warn'
                  : supervisorUpdate.severity === 'success'
                  ? 'border-signal-ok/30 bg-signal-ok/10 text-signal-ok'
                  : 'border-line bg-surface-raised text-ink-soft'
              }`}>
                <div className="font-semibold">{supervisorUpdate.title}</div>
                <p className="mt-1 leading-relaxed">{supervisorUpdate.summary}</p>
                {supervisorUpdate.ask && (
                  <p className="mt-2 text-[10px] uppercase tracking-wider text-ink-soft">{supervisorUpdate.ask}</p>
                )}
              </div>
            )}
            {agentEvents('S').length === 0 && (
              <p className="pt-16 text-center text-xs tracking-wider text-ink-faint">{isPipeline ? 'Ask S to manage the run, or message any specialist directly.' : 'Chat with any specialist directly. Claude permission prompts still apply in manual mode.'}</p>
            )}
            {agentEvents('S').map((e, i) => (
              <div key={i} className={`rounded px-2 py-1 text-[11px] leading-relaxed ${
                e.type === 'approval' ? 'font-bold text-signal-ok' :
                e.type === 'question' ? 'text-accent' :
                e.type === 'issue' || e.type === 'failure' ? 'text-signal-bad' :
                e.type === 'tool_call' ? 'italic text-[var(--ink-faint)]' :
                e.type === 'handoff' ? 'font-semibold text-accent-cool italic' :
                    e.type === 'user_msg' ? 'font-semibold text-accent-cool' :
                e.type === 'text' ? 'text-ink-soft' : 'text-[var(--ink-faint)]'
              }`}>
                <span className="mr-1.5 text-[9px] text-ink-faint">
                  {new Date(e.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <MarkdownText>{e.text}</MarkdownText>
              </div>
            ))}
          </div>
          <div className="flex-shrink-0 border-t border-[var(--surface-raised)] px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1.5 text-[10px] text-[var(--ink-faint)]">
              Recommended: <span className="font-semibold text-signal-ok">Supervisor first</span>
            </div>
            <div className="flex items-end gap-2">
              <AutoGrowTextarea
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder={isPipeline
                  ? (supervisorRecommendation?.chatCommand
                      ? `Ask the supervisor anything, or try "${supervisorRecommendation.chatCommand}"`
                      : 'Ask the supervisor anything, or chat with any specialist directly...')
                  : 'Chat with the Supervisor'}
                disabled={sendingAgents.has(supervisorId)}
                className="max-h-40 flex-1 rounded-lg border border-[var(--surface-overlay)] bg-[var(--surface)] px-3 py-2 text-sm text-ink placeholder-[var(--ink-faint)] focus:border-signal-ok focus:outline-none disabled:opacity-30"
              />
              <button onClick={handleSend} disabled={sendingAgents.has(supervisorId) || !chatInput.trim()} className="rounded-lg bg-signal-ok px-4 py-2 text-sm font-semibold text-ink hover:bg-signal-ok disabled:opacity-30">
                Send
              </button>
            </div>
          </div>
        </div>

        {/* A, B, C, D panels */}
        {workers.map(({ id }) => {
          const events = agentEvents(id);
          const status = state.agentStatus[id] || 'idle';
          const isSelected = selectedAgent === id;
          const isSending = sendingAgents.has(id);
          const hasTextEvents = events.some(e => e.type === 'text');
          return (
            <div
              key={id}
              onClick={() => { setSelectedAgent(id); setExpandedAgent(id); }}
              className={`flex cursor-pointer flex-col overflow-hidden transition-colors ${
                isSelected ? 'bg-[var(--surface-sunken)]' : 'bg-[var(--surface-sunken)] hover:bg-[var(--surface-sunken)]'
              }`}
            >
              <div className={`flex items-center gap-3 border-b-2 px-3.5 py-2.5 ${
                isSelected ? 'border-accent-cool' : 'border-[var(--surface-raised)]'
              }`}>
                <div className={`flex h-9 w-9 items-center justify-center rounded-[10px] border-2 text-sm font-bold ${
                  status === 'active' || status === 'working'
                    ? 'border-signal-ok text-signal-ok shadow-[0_0_16px_rgba(34,197,94,0.25)]'
                    : status === 'done'
                    ? 'border-[var(--surface-raised)] text-ink-faint opacity-50'
                    : 'border-[var(--surface-overlay)] text-[var(--ink-faint)]'
                }`} style={{ background: 'var(--surface)' }}>{initials(memberName(id))}</div>
                {/* min-w-0 is what lets the truncate below actually take effect
                    inside a flex row — without it the name pushes the row wide. */}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold text-[var(--ink-soft)]">{memberName(id)}</div>
                  <div className="truncate text-[10px] text-[var(--ink-faint)]">{memberRole(id)}</div>
                </div>
                <div className="flex items-center gap-2">
                  {/* Handoff dropdown — manual mode only, only if agent has text output */}
                  {!isPipeline && hasTextEvents && (
                    <select
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => { if (e.target.value) { handleHandoff(id, e.target.value as AgentId); e.target.value = ''; } }}
                      defaultValue=""
                      disabled={sendingAgents.size > 0}
                      className="rounded border border-line bg-surface-raised px-1.5 py-0.5 text-[9px] text-accent-cool focus:outline-none disabled:opacity-30"
                    >
                      <option value="" disabled>Send to →</option>
                      {workers.filter((x) => x.id !== id).map(({ id: target }) => (
                        <option key={target} value={target} className="bg-[var(--surface-raised)]">→ {memberName(target)}</option>
                      ))}
                    </select>
                  )}
                  {events.length > 0 && (
                    <span className="text-[10px] text-ink-faint">{events.length} events</span>
                  )}
                </div>
              </div>
              {/* Events */}
              <div
                ref={(el) => { panelRefs.current[id] = el; }}
                className="min-h-0 flex-1 overflow-y-auto px-2.5 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
                {events.length === 0 && (
                  <p className="pt-8 text-center text-xs tracking-wider text-ink-faint">
                    {isPipeline ? (memberRole(id) === 'Planning' ? `Tell ${memberName(id)} what you want to build` : 'IDLE') : `Chat with ${memberName(id)}`}
                  </p>
                )}
                <div className="space-y-px">
                  {events.map((e, i) => (
                    <div key={i} className={`rounded px-2 py-1 text-[11px] leading-relaxed ${
                      e.type === 'approval' ? 'font-bold text-signal-ok' :
                      e.type === 'question' ? 'text-accent' :
                      e.type === 'issue' || e.type === 'failure' ? 'text-signal-bad' :
                      e.type === 'tool_call' ? 'italic text-[var(--ink-faint)]' :
                      e.type === 'handoff' ? 'font-semibold text-accent-cool italic' :
                    e.type === 'user_msg' ? 'font-semibold text-accent-cool' :
                      e.type === 'text' ? 'text-ink-soft' : 'text-[var(--ink-faint)]'
                    }`}>
                      <span className="mr-1.5 text-[9px] text-ink-faint">
                        {new Date(e.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                      <MarkdownText>{e.text}</MarkdownText>
                    </div>
                  ))}
                </div>
              </div>
              {/* Chat input */}
              <div className="flex-shrink-0 border-t border-[var(--surface-raised)] px-2.5 py-2" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-end gap-1.5">
                  <AutoGrowTextarea
                    value={panelInputs[id] || ''}
                    onChange={(e) => setPanelInputs(prev => ({ ...prev, [id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void handlePanelSend(id);
                      }
                    }}
                    placeholder={`Message ${memberName(id)}...`}
                    disabled={isSending}
                    className="max-h-32 flex-1 rounded-md border border-[var(--surface-overlay)] bg-[var(--surface)] px-2.5 py-1.5 text-xs text-ink placeholder-[var(--ink-faint)] focus:border-accent-cool focus:outline-none disabled:opacity-30"
                  />
                  <button onClick={() => handlePanelSend(id)} disabled={isSending || !panelInputs[id]?.trim()} className="rounded-md bg-accent-cool px-3 py-1.5 text-xs font-semibold text-ink hover:bg-accent-cool disabled:opacity-30">
                    Send
                  </button>
                </div>
              </div>
            </div>
          );
        })}

        {/* E — Security Auditor, spans both rows in the rightmost column. Only rendered once the audit has started. */}
        {auditHasStarted && (
          <SecurityAuditPanel
            findings={state.auditFindings || []}
            chatEvents={agentEvents('E' as AgentId)}
            auditActionInFlight={!!state.auditActionInFlight}
            pipelineStatus={state.pipelineStatus}
            currentPhase={state.currentPhase}
            buildComplete={!!state.buildComplete}
            isSelected={selectedAgent === 'E'}
            isSending={sendingAgents.has('E' as AgentId)}
            onSelect={() => { setSelectedAgent('E' as AgentId); setExpandedAgent('E' as AgentId); }}
            onSendToC={(id) => { void sendFindingToC(id); }}
            onDismiss={(id) => { void dismissFinding(id); }}
            onDeploy={() => { void deployAfterAudit(); }}
            onSendChat={(msg) => {
              setSendingAgents((prev) => new Set([...prev, 'E' as AgentId]));
              void sendChat('E' as AgentId, msg, isPipeline ? {
                securityMode: selectedSecurityMode,
                permissionMode: selectedPermissionMode,
                runGoal: selectedRunGoal,
                runFinalAudit: selectedRunFinalAudit,
              } : undefined).finally(() => {
                setSendingAgents((prev) => { const n = new Set(prev); n.delete('E' as AgentId); return n; });
              });
            }}
          />
        )}
      </div>

      {/* Agent Detail Modal */}
      {expandedAgent && expandedAgent !== 'S' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-sunken/70" onClick={() => setExpandedAgent(null)}>
          <div className="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-[var(--surface)]" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 border-b border-line px-6 py-4">
              <div className={`flex h-10 w-10 items-center justify-center rounded-xl border-2 text-sm font-bold ${
                (state.agentStatus[expandedAgent] === 'active' || state.agentStatus[expandedAgent] === 'working')
                  ? 'border-signal-ok text-signal-ok shadow-[0_0_16px_rgba(34,197,94,0.25)]'
                  : 'border-[var(--surface-overlay)] text-[var(--ink-faint)]'
              }`} style={{ background: 'var(--surface)' }}>{initials(memberName(expandedAgent))}</div>
              <div className="flex-1">
                <div className="text-sm font-semibold text-ink">{memberName(expandedAgent)}</div>
                <div className="text-xs text-ink-faint">{agentEvents(expandedAgent).length} events</div>
              </div>
              <button onClick={() => setExpandedAgent(null)} className="text-2xl text-ink-faint hover:text-ink">&times;</button>
            </div>
            <div ref={modalRef} className="flex-1 space-y-px overflow-y-auto px-6 py-3 [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-sm [&::-webkit-scrollbar-thumb]:bg-[var(--surface-overlay)] [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-[3px]">
              {agentEvents(expandedAgent).map((e, i) => (
                <div key={i} className={`rounded px-3 py-1.5 text-xs leading-relaxed ${
                  e.type === 'approval' ? 'font-bold text-signal-ok' :
                  e.type === 'question' ? 'text-accent' :
                  e.type === 'issue' || e.type === 'failure' ? 'text-signal-bad' :
                  e.type === 'tool_call' ? 'italic text-[var(--ink-faint)]' :
                  e.type === 'handoff' ? 'font-semibold text-accent-cool italic' :
                    e.type === 'user_msg' ? 'font-semibold text-accent-cool' :
                  e.type === 'text' ? 'text-ink-soft' : 'text-[var(--ink-faint)]'
                }`}>
                  <span className="mr-2 text-[10px] text-[var(--ink-faint)]">
                    {new Date(e.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                  <MarkdownText>{e.text}</MarkdownText>
                </div>
              ))}
            </div>
            {/* Modal chat — sends to expanded agent, not S */}
            <div className="flex-shrink-0 border-t border-line px-6 py-4">
              <div className="flex items-end gap-2">
                <AutoGrowTextarea
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void handleExpandedSend();
                    }
                  }}
                  placeholder={`Message ${memberName(expandedAgent)}...`}
                  disabled={sendingAgents.has(expandedAgent)}
                  className="max-h-40 flex-1 rounded-lg border border-[var(--surface-overlay)] bg-[var(--surface)] px-3 py-2 text-sm text-ink placeholder-[var(--ink-faint)] focus:border-accent-cool focus:outline-none disabled:opacity-30"
                />
                <button onClick={handleExpandedSend} disabled={sendingAgents.has(expandedAgent) || !chatInput.trim()} className="rounded-lg bg-accent-cool px-5 py-2 text-sm font-semibold text-ink hover:bg-accent-cool disabled:opacity-30">
                  Send
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Plan Modal */}
      {showPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-sunken/70" onClick={() => setShowPlan(false)}>
          <div className="max-h-[80vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-line bg-[var(--surface)] p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-ink">plan.md</h2>
              <button onClick={() => setShowPlan(false)} className="text-2xl text-ink-faint hover:text-ink">&times;</button>
            </div>
            <pre className="mt-4 whitespace-pre-wrap font-mono text-xs leading-relaxed text-ink-soft">{planContent || 'No plan yet.'}</pre>
          </div>
        </div>
      )}

      {/* Approval Banner — pipeline only */}
      {isPipeline && pendingApproval && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-xl border-2 border-signal-warn bg-[var(--surface-raised)] px-6 py-4 shadow-[0_0_30px_rgba(245,158,11,0.2)]">
          <p className="text-xs font-bold uppercase tracking-wider text-signal-warn">
            {activeSecurityMode === 'strict' ? 'Strict Mode' : (pendingApproval.tool as string)} — Approval Required
          </p>
          <p className="mt-2 max-w-md break-all font-mono text-sm text-signal-warn">
            {pendingApproval.description || JSON.stringify(pendingApproval.input)}
          </p>
          <p className="mt-2 text-[11px] uppercase tracking-wider text-signal-warn">
            Agent {pendingApproval.agent} · {pendingApproval.phase || state.currentPhase}
          </p>
          <div className="mt-3 flex gap-3">
            <button onClick={() => approveBash(true, pendingApproval)} className="rounded-lg bg-signal-ok px-5 py-2 text-sm font-bold text-black hover:bg-signal-ok">APPROVE</button>
            <button onClick={() => approveBash(false, pendingApproval)} className="rounded-lg bg-signal-bad px-5 py-2 text-sm font-bold text-ink hover:bg-signal-bad">DENY</button>
          </div>
        </div>
      )}
    </div>
  );
}
