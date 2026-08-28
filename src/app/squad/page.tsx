'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/shared/Badge';
import { AutoGrowTextarea } from '@/components/shared/AutoGrowTextarea';
import { MarkdownText } from '@/components/shared/MarkdownText';
import { ArtifactCard, PlanMarkdown, documentTitle, isLongForm } from '@/components/plan/PlanViewer';
import { getExecutionPathStatus, getSupervisorRecommendation, getSupervisorUpdate } from '@/lib/pipeline-supervisor';
import { usePipelineState, type AgentId, type AppMode, type IsolationPolicy, type RunGoal, type SecurityMode } from '@/lib/use-pipeline';
import { useTeam } from '@/lib/use-team';
import { TerminalPane } from '@/components/terminal/TerminalPane';
import { MODEL_ALIASES, SLOT_LABELS } from '@/lib/team/types';

const PHASE_LABELS: Record<string, string> = {
  concept: 'Concept',
  planning: 'Planning',
  'plan-review': 'Plan Review',
  coding: 'Coding',
  'code-review': 'Code Review',
  testing: 'Testing',
  'security-audit': 'Security Audit',
  deploy: 'Deploy',
  complete: 'Complete',
};

const MODEL_OPTIONS = MODEL_ALIASES.map((value) => ({ value, label: value }));

function cardTone(tone: 'neutral' | 'info' | 'warning' | 'success') {
  if (tone === 'warning') return 'border-signal-warn/30 bg-signal-warn/10 text-signal-warn';
  if (tone === 'success') return 'border-signal-ok/30 bg-signal-ok/10 text-signal-ok';
  return 'border-line bg-surface-raised text-ink';
}

function segmentClass(active: boolean) {
  return `flex-1 rounded-md px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider transition ${
    active ? 'text-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]' : 'text-ink-soft hover:text-ink'
  }`;
}

function eventLabel(type: string) {
  return type.replace(/_/g, ' ');
}

export default function SquadPage() {
  const [mode, setMode] = useState<AppMode>('pipeline');
  const [selectedAgent, setSelectedAgent] = useState<AgentId>('');
  const [rightTab, setRightTab] = useState<'next' | 'activity' | 'controls'>('next');
  /** A long message opened out of the feed, or null. */
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState('claude-sonnet-4-6');
  const [selectedSecurityMode, setSelectedSecurityMode] = useState<SecurityMode>('fast');
  const [selectedRunGoal, setSelectedRunGoal] = useState<RunGoal>('full-build');
  const [selectedRunFinalAudit, setSelectedRunFinalAudit] = useState<boolean>(false);
  const [selectedIsolationPolicy, setSelectedIsolationPolicy] = useState<IsolationPolicy>('ask');
  const [chatInput, setChatInput] = useState('');
  const [sendingAgents, setSendingAgents] = useState<Set<AgentId>>(new Set());

  const {
    state,
    sendChat,
    startPipeline,
    resumePipeline,
    stopPipeline,
    setStopAfterReview,
    approveBash,
    resetState,
    agentEvents,
    // Approvals arrive on the same stream as state — no separate poll.
    pendingApproval,
    connected,
  } = usePipelineState({ mode, model: selectedModel });

  // The team is whoever is on the roster — there is no fixed squad to name.
  const { team } = useTeam();
  const members = team.members;

  const memberName = (id: string) =>
    id === 'system' ? 'System' : members.find((m) => m.id === id)?.name || id;

  const memberDescription = (id: string) => {
    const member = members.find((m) => m.id === id);
    if (!member) return '';
    if (member.title) return member.title;
    return member.slot ? SLOT_LABELS[member.slot] : 'Direct chat only';
  };

  const supervisor = members.find((m) => m.slot === 'supervisor');

  /**
   * The member the UI is actually talking to.
   *
   * Derived rather than synced into state: the roster arrives asynchronously,
   * and writing the default back during an effect causes a second render pass
   * for something that is just a fallback.
   */
  const activeAgentId =
    selectedAgent && members.some((m) => m.id === selectedAgent)
      ? selectedAgent
      : supervisor?.id || members[0]?.id || '';

  const isSupervisor = Boolean(supervisor && activeAgentId === supervisor.id);

  const terminalMembers = useMemo(
    () => members.map((m) => ({ id: m.id, name: m.name, color: m.color })),
    [members]
  );

  const isPipeline = mode === 'pipeline';
  const pipelineRunning = isPipeline && state.pipelineStatus === 'running';
  const pipelinePaused = isPipeline && state.pipelineStatus === 'paused';
  const activeSecurityMode = state.projectDir ? (state.securityMode || 'fast') : selectedSecurityMode;
  const activeRunGoal = state.projectDir ? (state.runGoal || 'full-build') : selectedRunGoal;
  const activeRunFinalAudit = state.projectDir ? !!state.runFinalAudit : selectedRunFinalAudit;
  const displayedIsolationPolicy = state.projectDir ? (state.isolationPolicy || 'ask') : selectedIsolationPolicy;
  const securityModeLocked = isPipeline && (pipelineRunning || pipelinePaused || !!state.projectDir);
  const displayedSecurityMode = securityModeLocked ? activeSecurityMode : selectedSecurityMode;
  const displayedRunGoal = securityModeLocked ? activeRunGoal : selectedRunGoal;
  const displayedRunFinalAudit = securityModeLocked ? activeRunFinalAudit : selectedRunFinalAudit;
  const stopAfterReviewArmed = state.stopAfterPhase === 'plan-review' || activeRunGoal === 'plan-only';
  const canContinueApprovedPlan = pipelinePaused && state.currentPhase === 'plan-review';

  const visiblePendingApproval = isPipeline ? pendingApproval : null;
  const supervisorRecommendation = isPipeline ? getSupervisorRecommendation(state, visiblePendingApproval) : null;
  const supervisorUpdate = isPipeline ? getSupervisorUpdate(state, visiblePendingApproval) : null;
  const executionPathStatus = isPipeline ? getExecutionPathStatus(state) : null;

  const modePosture = isPipeline
    ? {
        title: 'Supervisor-Run Build',
        summary: activeSecurityMode === 'strict'
          ? 'Strict mode is active. Every Coder/Tester Bash call pauses for approval.'
          : 'Fast mode is active. The team stays moving under guardrails, but this is still not a sandbox.',
        detail: executionPathStatus?.detail || 'Host execution is still the normal path. Docker isolation is built, but still alpha.',
      }
    : {
        title: 'Direct Specialist Sessions',
        summary: 'You are talking to the team directly. Claude permission prompts still apply, but pipeline guardrails are not enforcing the build flow for you.',
        detail: 'Use this when you want normal Claude-style back-and-forth with one specialist at a time.',
      };

  const timeline = useMemo(() => state.events.slice(-24), [state.events]);
  const selectedEvents = agentEvents(activeAgentId);

  async function handleSend() {
    const message = chatInput.trim();
    if (!message || sendingAgents.has(activeAgentId)) return;
    setSendingAgents((prev) => new Set(prev).add(activeAgentId));
    await sendChat(activeAgentId, message, isPipeline ? {
      securityMode: selectedSecurityMode,
      runGoal: selectedRunGoal,
      runFinalAudit: selectedRunFinalAudit,
    } : undefined);
    setChatInput('');
    setSendingAgents((prev) => {
      const next = new Set(prev);
      next.delete(activeAgentId);
      return next;
    });
  }

  async function handleStart() {
    await startPipeline(selectedSecurityMode, selectedRunGoal, undefined, selectedRunFinalAudit, selectedIsolationPolicy);
    setSelectedAgent(supervisor?.id || members[0]?.id || '');
  }

  async function handleReset() {
    if (isPipeline) {
      await fetch('/api/stop-pipeline', { method: 'POST' });
    }
    await resetState();
    setChatInput('');
    setSelectedAgent(supervisor?.id || members[0]?.id || '');
  }

  return (
    <div className="h-screen overflow-hidden bg-surface p-4 text-ink">
      <div className="mx-auto flex h-full max-w-7xl flex-col gap-4">
        <div className="shrink-0 rounded-2xl border border-line bg-surface-raised px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-[0.22em] text-ink-faint">Squad View</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h1 className="text-lg font-semibold text-ink">Supervisor-first dev team</h1>
                <span className="text-xs text-ink-soft">Same runtime, less chrome.</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Link
                href="/team"
                className="rounded-lg border border-accent/40 bg-accent-soft px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-accent transition hover:bg-accent/20"
              >
                Manage Team
              </Link>
              <Link
                href="/"
                className="rounded-lg border border-line bg-surface-raised px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-ink-soft transition hover:border-line-strong hover:bg-surface-raised hover:text-ink"
              >
                Open Office View
              </Link>
            </div>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[220px_minmax(0,1fr)_250px]">
          <aside className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface-raised p-3">
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
              <div>
                <div className="mb-1.5 text-[9px] uppercase tracking-[0.18em] text-ink-faint">Mode</div>
                <div className="flex rounded-lg border border-line bg-surface-raised p-1">
                  <button
                    onClick={() => setMode('pipeline')}
                    className={segmentClass(isPipeline)}
                    style={isPipeline ? { background: 'var(--accent)' } : undefined}
                  >
                    Pipeline
                  </button>
                  <button
                    onClick={() => setMode('manual')}
                    className={segmentClass(!isPipeline)}
                    style={!isPipeline ? { background: 'var(--accent-cool)' } : undefined}
                  >
                    Manual
                  </button>
                </div>
              </div>

              {!isPipeline && (
                <div>
                  <div className="mb-1.5 text-[9px] uppercase tracking-[0.18em] text-ink-faint">Model</div>
                  <select
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    className="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-xs text-ink focus:border-accent-cool focus:outline-none"
                  >
                    {MODEL_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value} className="bg-[var(--surface)]">
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {isPipeline && (
                <>
                  <div>
                    <div className="mb-1.5 text-[9px] uppercase tracking-[0.18em] text-ink-faint">Security</div>
                    <div className="flex rounded-lg border border-line bg-surface-raised p-1">
                      <button
                        onClick={() => setSelectedSecurityMode('fast')}
                        disabled={securityModeLocked}
                        className={`${segmentClass(displayedSecurityMode === 'fast')} disabled:opacity-40`}
                        style={displayedSecurityMode === 'fast' ? { background: 'var(--signal-ok)' } : undefined}
                      >
                        Fast
                      </button>
                      <button
                        onClick={() => setSelectedSecurityMode('strict')}
                        disabled={securityModeLocked}
                        className={`${segmentClass(displayedSecurityMode === 'strict')} disabled:opacity-40`}
                        style={displayedSecurityMode === 'strict' ? { background: 'var(--signal-warn)' } : undefined}
                      >
                        Strict
                      </button>
                    </div>
                  </div>

                  <div>
                    <div className="mb-1.5 text-[9px] uppercase tracking-[0.18em] text-ink-faint">Goal</div>
                    <div className="flex rounded-lg border border-line bg-surface-raised p-1">
                      <button
                        onClick={() => setSelectedRunGoal('full-build')}
                        disabled={securityModeLocked}
                        className={`${segmentClass(displayedRunGoal === 'full-build')} disabled:opacity-40`}
                        style={displayedRunGoal === 'full-build' ? { background: 'var(--accent-cool)' } : undefined}
                      >
                        Full
                      </button>
                      <button
                        onClick={() => setSelectedRunGoal('plan-only')}
                        disabled={securityModeLocked}
                        className={`${segmentClass(displayedRunGoal === 'plan-only')} disabled:opacity-40`}
                        style={displayedRunGoal === 'plan-only' ? { background: 'var(--accent)' } : undefined}
                      >
                        Plan Only
                      </button>
                    </div>
                  </div>

                  <div>
                    <div className="mb-1.5 text-[9px] uppercase tracking-[0.18em] text-ink-faint">If Isolation Is Lost</div>
                    <div className="flex rounded-lg border border-line bg-surface-raised p-1">
                      <button
                        onClick={() => setSelectedIsolationPolicy('ask')}
                        disabled={securityModeLocked}
                        className={`${segmentClass(displayedIsolationPolicy === 'ask')} disabled:opacity-40`}
                        style={displayedIsolationPolicy === 'ask' ? { background: 'var(--signal-warn)' } : undefined}
                      >
                        Ask
                      </button>
                      <button
                        onClick={() => setSelectedIsolationPolicy('required')}
                        disabled={securityModeLocked}
                        className={`${segmentClass(displayedIsolationPolicy === 'required')} disabled:opacity-40`}
                        style={displayedIsolationPolicy === 'required' ? { background: 'var(--signal-bad)' } : undefined}
                      >
                        Required
                      </button>
                    </div>
                    <p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint">
                      {displayedIsolationPolicy === 'required'
                        ? 'Stop the run rather than continue on the host.'
                        : 'Pause and ask before continuing on the host.'}
                    </p>
                  </div>

                  <div>
                    <div className="mb-1.5 text-[9px] uppercase tracking-[0.18em] text-ink-faint">Security Audit</div>
                    <div className="flex rounded-lg border border-line bg-surface-raised p-1">
                      <button
                        onClick={() => setSelectedRunFinalAudit(false)}
                        disabled={securityModeLocked}
                        className={`${segmentClass(!displayedRunFinalAudit)} disabled:opacity-40`}
                        style={!displayedRunFinalAudit ? { background: 'var(--ink-faint)' } : undefined}
                      >
                        Off
                      </button>
                      <button
                        onClick={() => setSelectedRunFinalAudit(true)}
                        disabled={securityModeLocked}
                        className={`${segmentClass(displayedRunFinalAudit)} disabled:opacity-40`}
                        style={displayedRunFinalAudit ? { background: 'var(--signal-bad)' } : undefined}
                      >
                        On
                      </button>
                    </div>
                  </div>
                </>
              )}

              <div className="rounded-xl border border-line bg-surface-raised px-3 py-2.5">
                <div className="mb-1 text-[9px] uppercase tracking-[0.18em] text-ink-faint">Posture</div>
                <p className="text-xs leading-relaxed text-ink-soft">{modePosture.summary}</p>
              </div>

              <div>
                <div className="mb-1.5 text-[9px] uppercase tracking-[0.18em] text-ink-faint">Team</div>
                <div className="space-y-2">
                  {members.map(({ id: agent }) => (
                    <button
                      key={agent}
                      onClick={() => setSelectedAgent(agent)}
                      className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
                        activeAgentId === agent
                          ? 'border-accent/40 bg-accent/10'
                          : 'border-line bg-surface-raised hover:border-line-strong hover:bg-surface-raised'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-ink">{memberName(agent)}</div>
                          <div className="mt-0.5 text-[11px] leading-relaxed text-ink-soft">{memberDescription(agent)}</div>
                        </div>
                        <Badge variant={(state.agentStatus[agent] === 'active' || state.agentStatus[agent] === 'working') ? 'success' : 'neutral'}>
                          {state.agentStatus[agent] || 'idle'}
                        </Badge>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </aside>

          <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface-raised">
            <div className="shrink-0 border-b border-line px-4 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-ink-faint">{isPipeline ? 'Supervisor-led team run' : 'Direct specialist session'}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <h2 className="text-lg font-semibold text-ink">{memberName(activeAgentId)}</h2>
                    <p className="text-xs text-ink-soft">{memberDescription(activeAgentId)}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {isPipeline && (
                    <>
                      <Badge variant={activeSecurityMode === 'strict' ? 'warning' : 'success'}>
                        {activeSecurityMode === 'strict' ? 'STRICT' : 'FAST'}
                      </Badge>
                      <Badge variant={activeRunGoal === 'plan-only' ? 'purple' : 'neutral'}>
                        {activeRunGoal === 'plan-only' ? 'PLAN ONLY' : 'FULL BUILD'}
                      </Badge>
                      {activeRunFinalAudit && (
                        <Badge variant="warning">AUDIT ON</Badge>
                      )}
                    </>
                  )}
                  {executionPathStatus && (
                    <Badge variant={executionPathStatus.variant}>{executionPathStatus.label}</Badge>
                  )}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-soft">
                <span className="font-semibold text-ink">{modePosture.title}</span>
                <span className="text-ink-faint">•</span>
                <span>{PHASE_LABELS[state.currentPhase] || 'Concept'}</span>
                <span className="text-ink-faint">•</span>
                <span>{state.pipelineStatus || 'idle'}</span>
                {isPipeline && (
                  <>
                    <span className="text-ink-faint">•</span>
                    <span>{activeSecurityMode === 'strict' ? 'Strict approvals' : 'Fast guardrails'}</span>
                  </>
                )}
                {executionPathStatus && (
                  <>
                    <span className="text-ink-faint">•</span>
                    <span>{executionPathStatus.label}</span>
                  </>
                )}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto bg-surface-sunken/70 px-4 py-3">
              {isSupervisor && supervisorUpdate && isPipeline && (
                <div className={`mb-3 border-l-2 px-3 py-2 ${supervisorUpdate.severity === 'warning'
                  ? 'border-signal-warn/70 bg-signal-warn/5'
                  : supervisorUpdate.severity === 'success'
                  ? 'border-signal-ok/70 bg-signal-ok/5'
                  : 'border-accent/60 bg-surface-raised'
                }`}>
                  <div className="text-[10px] uppercase tracking-[0.18em] text-ink-faint">Supervisor Update</div>
                  <div className="mt-1 text-sm font-medium text-ink">{supervisorUpdate.title}</div>
                  <p className="mt-1 text-sm leading-relaxed text-ink-soft">{supervisorUpdate.summary}</p>
                  {supervisorUpdate.ask && <p className="mt-2 text-[11px] uppercase tracking-wider text-ink-soft">{supervisorUpdate.ask}</p>}
                </div>
              )}

              {selectedEvents.length === 0 ? (
                <div className="flex h-full items-center justify-center">
                  <p className="max-w-md text-center text-sm leading-relaxed text-ink-faint">
                    {isSupervisor
                      ? 'Start with the Supervisor. Describe what you want to build, then ask it to start planning or the full build.'
                      : `No messages with ${memberName(activeAgentId)} yet. Jump in here whenever you want direct specialist context.`}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {selectedEvents.map((event, index) => {
                    const isUser = event.type === 'user_msg';
                    const isFailure = event.type === 'failure' || event.type === 'issue';
                    const isTool = event.type === 'tool_call';
                    const isStatus = event.type === 'status';
                    const bodyClass = isUser
                      ? 'border-accent-cool/20 bg-accent-cool/[0.08] text-accent-cool'
                      : isFailure
                      ? 'border-signal-bad/25 bg-signal-bad/[0.08] text-signal-bad'
                      : isTool
                      ? 'border-line bg-surface-sunken/70 text-ink'
                      : isStatus
                      ? 'border-accent/15 bg-accent/[0.06] text-ink'
                      : 'border-line bg-surface-raised text-ink';
                    return (
                      <div
                        key={`${event.time}-${index}`}
                        className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
                      >
                        <div className={`w-full max-w-[88%] ${isUser ? 'items-end' : 'items-start'} flex flex-col gap-1`}>
                          <div className={`flex w-full items-center gap-2 text-[10px] uppercase tracking-[0.18em] ${isUser ? 'justify-end' : 'justify-start'} text-ink-faint`}>
                            {!isUser && <span>{eventLabel(event.type)}</span>}
                            <span className="font-mono tracking-[0.12em]">
                              {new Date(event.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                            </span>
                            {isUser && <span>{eventLabel(event.type)}</span>}
                          </div>
                          <div className={`w-full rounded-lg border px-3 py-2.5 text-[15px] leading-7 ${bodyClass}`}>
                            {/* The same rule as every other feed: a long answer
                                is a document, not a chat message. */}
                            {isLongForm(event) ? (
                              <ArtifactCard
                                title={documentTitle(event.text)}
                                subtitle={`${event.text.split('\n').length} lines`}
                                onOpen={() => setOpenDoc(event.text)}
                              />
                            ) : (
                              <MarkdownText className="[&_p]:leading-7">{event.text}</MarkdownText>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="shrink-0 border-t border-line px-4 py-3">
              <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-ink-faint">
                {isSupervisor
                  ? 'Recommended: talk to the Supervisor first'
                  : `Direct ${memberName(activeAgentId)} chat`}
              </div>
              <div className="flex items-end gap-3">
                <AutoGrowTextarea
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void handleSend();
                    }
                  }}
                  placeholder={isSupervisor
                    ? (isPipeline && supervisorRecommendation?.chatCommand
                      ? `Ask the supervisor anything, or try "${supervisorRecommendation.chatCommand}"`
                      : 'Ask the supervisor what to build, what is blocked, or what to do next...')
                    : `Message ${memberName(activeAgentId)} directly...`}
                  disabled={sendingAgents.has(activeAgentId)}
                  className="max-h-36 flex-1 rounded-xl border border-line bg-surface-raised px-4 py-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none disabled:opacity-40"
                />
                <button
                  onClick={() => void handleSend()}
                  disabled={sendingAgents.has(activeAgentId) || !chatInput.trim()}
                  className="rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-ink transition hover:bg-accent disabled:opacity-40"
                >
                  Send
                </button>
              </div>
            </div>
          </section>

          <aside className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface-raised p-3">
            <div className="mb-3 flex rounded-lg border border-line bg-surface-raised p-1">
              {[
                ['next', 'Next'],
                ['activity', 'Activity'],
                ['controls', 'Controls'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setRightTab(value as 'next' | 'activity' | 'controls')}
                  className={`flex-1 rounded-md px-3 py-2 text-[10px] font-bold uppercase tracking-wider transition ${
                    rightTab === value ? 'bg-accent text-ink' : 'text-ink-soft'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              {rightTab === 'next' && (
                <div className="space-y-4">
                  {isPipeline && supervisorRecommendation && (
                    <div className={`rounded-xl border px-3 py-3 ${cardTone(supervisorRecommendation.severity)}`}>
                      <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-ink-soft">Suggested Next Action</div>
                      <div className="mt-2 text-sm font-semibold">{supervisorRecommendation.title}</div>
                      <p className="mt-2 text-sm leading-relaxed">{supervisorRecommendation.detail}</p>
                      {supervisorRecommendation.chatCommand && (
                        <p className="mt-2 text-xs uppercase tracking-wider text-ink-soft/80">Try: &quot;{supervisorRecommendation.chatCommand}&quot;</p>
                      )}
                    </div>
                  )}

                  <div className="rounded-xl border border-line bg-surface-raised px-3 py-3">
                    <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-ink-soft">Run Summary</div>
                    <dl className="mt-3 space-y-2 text-sm">
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-ink-faint">Phase</dt>
                        <dd className="text-right text-ink">{PHASE_LABELS[state.currentPhase] || 'Concept'}</dd>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-ink-faint">Status</dt>
                        <dd className="text-right text-ink">{state.pipelineStatus || 'idle'}</dd>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-ink-faint">Active</dt>
                        <dd className="text-right text-ink">{state.activeAgent || 'None'}</dd>
                      </div>
                      <div className="flex items-start justify-between gap-3">
                        <dt className="text-ink-faint">Project</dt>
                        <dd className="max-w-[170px] text-right text-ink">{state.projectDir ? state.projectDir.split('/').pop() : 'Not started'}</dd>
                      </div>
                    </dl>
                  </div>
                </div>
              )}

              {rightTab === 'activity' && (
                <TerminalPane
                  className="h-[560px]"
                  title={state.projectDir ? state.projectDir.split('/').pop() || 'session' : 'session'}
                  events={state.events}
                  members={terminalMembers}
                  activeIds={state.activeAgent ? [state.activeAgent] : []}
                  connected={connected}
                  defaultTarget={activeAgentId}
                  onSubmit={(memberId, message) => sendChat(memberId, message)}
                />
              )}

              {rightTab === 'controls' && (
                <div className="space-y-4">
                  {visiblePendingApproval && (
                    <div className="rounded-xl border border-signal-warn/40 bg-signal-warn/10 px-3 py-3 text-signal-warn">
                      <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-signal-warn">
                        {visiblePendingApproval.tool === 'Isolation' ? 'Isolation Unavailable' : 'Approval Required'}
                      </div>
                      <p className="mt-2 whitespace-pre-line text-sm leading-relaxed">{visiblePendingApproval.description}</p>
                      <p className="mt-2 text-xs uppercase tracking-wider text-signal-warn">
                        {memberName(visiblePendingApproval.agent)} · {visiblePendingApproval.phase || state.currentPhase}
                      </p>
                      <div className="mt-3 flex gap-2">
                        <button onClick={() => void approveBash(true, visiblePendingApproval)} className="flex-1 rounded-lg bg-signal-ok px-3 py-2 text-sm font-semibold text-black">
                          {visiblePendingApproval.tool === 'Isolation' ? 'Continue on host' : 'Approve'}
                        </button>
                        <button onClick={() => void approveBash(false, visiblePendingApproval)} className="flex-1 rounded-lg bg-signal-bad px-3 py-2 text-sm font-semibold text-ink">
                          {visiblePendingApproval.tool === 'Isolation' ? 'Stop the run' : 'Deny'}
                        </button>
                      </div>
                    </div>
                  )}

                  {isPipeline && (
                    <div className="rounded-xl border border-line bg-surface-raised px-3 py-3">
                      <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-ink-soft">Run Controls</div>
                      <div className="mt-3 space-y-2">
                        {!pipelineRunning && !pipelinePaused && (!state.projectDir || state.currentPhase === 'concept' || state.buildComplete) && (
                          <button onClick={() => void handleStart()} className="w-full rounded-lg bg-signal-ok px-4 py-2 text-sm font-semibold text-black transition hover:bg-signal-ok">
                            {selectedRunGoal === 'plan-only' ? 'Start Plan Only' : 'Start Full Build'}
                          </button>
                        )}
                        {pipelineRunning && (state.currentPhase === 'planning' || state.currentPhase === 'plan-review') && activeRunGoal === 'full-build' && (
                          <button
                            onClick={() => { void setStopAfterReview(!stopAfterReviewArmed); }}
                            className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink transition hover:bg-accent"
                          >
                            {stopAfterReviewArmed ? 'Keep Running After Review' : 'Stop After Review'}
                          </button>
                        )}
                        {canContinueApprovedPlan && (
                          <button onClick={() => void resumePipeline()} className="w-full rounded-lg bg-accent-cool px-4 py-2 text-sm font-semibold text-ink transition hover:bg-accent-cool">
                            Continue Build
                          </button>
                        )}
                        <button onClick={() => void stopPipeline()} className="w-full rounded-lg bg-signal-bad px-4 py-2 text-sm font-semibold text-ink transition hover:bg-signal-bad">
                          Stop
                        </button>
                        <button onClick={() => void handleReset()} className="w-full rounded-lg border border-line bg-surface-raised px-4 py-2 text-sm font-semibold text-ink-soft transition hover:bg-surface-raised">
                          Reset
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>

      {/* The same viewer the office uses, so a document reads identically
          wherever it was opened from. */}
      {openDoc !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-surface-sunken/70 p-4"
          onClick={() => setOpenDoc(null)}
        >
          <div
            className="max-h-[85vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-line bg-[var(--surface)] p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-ink">{documentTitle(openDoc)}</h2>
              <button onClick={() => setOpenDoc(null)} className="text-2xl text-ink-faint hover:text-ink">
                &times;
              </button>
            </div>
            <div className="mt-4">
              <PlanMarkdown content={openDoc} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
