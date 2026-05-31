'use client';

import { useState } from 'react';
import { AutoGrowTextarea } from '@/components/shared/AutoGrowTextarea';
import { MarkdownText } from '@/components/shared/MarkdownText';
import type { AuditFinding, AuditFindingStatus, PipelineEvent } from '@/lib/use-pipeline';

const SEVERITY_ORDER: AuditFinding['severity'][] = ['critical', 'high', 'medium', 'low'];

const SEVERITY_STYLES: Record<AuditFinding['severity'], { label: string; ring: string; dot: string; text: string }> = {
  critical: { label: 'CRIT', ring: 'border-signal-bad/50', dot: 'bg-signal-bad', text: 'text-signal-bad' },
  high:     { label: 'HIGH', ring: 'border-signal-warn/40', dot: 'bg-signal-warn', text: 'text-signal-warn' },
  medium:   { label: 'MED',  ring: 'border-signal-warn/40', dot: 'bg-signal-warn', text: 'text-signal-warn' },
  low:      { label: 'LOW',  ring: 'border-accent-cool/30', dot: 'bg-accent-cool', text: 'text-accent-cool' },
};

const STATUS_LABELS: Record<AuditFindingStatus, string> = {
  'open':         'Open',
  'sent-to-c':    'Sent to C',
  're-auditing':  'Re-auditing',
  'resolved':     'Resolved ✓',
  'still-open':   'Still Open',
  'dismissed':    'Dismissed',
};

const STATUS_COLORS: Record<AuditFindingStatus, string> = {
  'open':         'text-ink-soft',
  'sent-to-c':    'text-signal-warn',
  're-auditing':  'text-signal-warn',
  'resolved':     'text-signal-ok',
  'still-open':   'text-signal-bad',
  'dismissed':    'text-ink-faint',
};

interface Props {
  findings: AuditFinding[];
  chatEvents: PipelineEvent[];
  auditActionInFlight: boolean;
  pipelineStatus: string;
  currentPhase: string;
  buildComplete: boolean;
  isSelected: boolean;
  isSending: boolean;
  onSelect: () => void;
  onSendToC: (findingId: string) => void;
  onDismiss: (findingId: string) => void;
  onDeploy: () => void;
  onSendChat: (msg: string) => void;
}

function severityRank(finding: AuditFinding): number {
  const idx = SEVERITY_ORDER.indexOf(finding.severity);
  return idx === -1 ? 99 : idx;
}

function formatSummary(findings: AuditFinding[]): string {
  if (findings.length === 0) return '0 findings · audit clean';
  const counts: Record<string, number> = {};
  findings.forEach((f) => { counts[f.severity] = (counts[f.severity] || 0) + 1; });
  const parts = SEVERITY_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`);
  return `${findings.length} findings · ${parts.join(', ')}`;
}

export function SecurityAuditPanel({
  findings,
  chatEvents,
  auditActionInFlight,
  pipelineStatus,
  currentPhase,
  buildComplete,
  isSelected,
  isSending,
  onSelect,
  onSendToC,
  onDismiss,
  onDeploy,
  onSendChat,
}: Props) {
  const [chatInput, setChatInput] = useState('');
  const [showDeployConfirm, setShowDeployConfirm] = useState(false);

  const sortedFindings = [...findings].sort((a, b) => {
    const rank = severityRank(a) - severityRank(b);
    if (rank !== 0) return rank;
    return a.createdAt.localeCompare(b.createdAt);
  });

  const openOrInFlight = findings.filter(
    (f) => f.status === 'open' || f.status === 'still-open' || f.status === 'sent-to-c' || f.status === 're-auditing'
  );
  const unresolvedCount = openOrInFlight.length;

  const headerStatus = buildComplete
    ? 'deployed'
    : pipelineStatus === 'awaiting-audit-decision'
    ? 'waiting'
    : currentPhase === 'security-audit'
    ? 'auditing'
    : 'done';

  function handleChatSubmit() {
    const msg = chatInput.trim();
    if (!msg || isSending) return;
    onSendChat(msg);
    setChatInput('');
  }

  function handleDeployClick() {
    setShowDeployConfirm(true);
  }

  function handleDeployConfirm() {
    setShowDeployConfirm(false);
    onDeploy();
  }

  return (
    <div
      onClick={onSelect}
      className={`flex cursor-pointer flex-col overflow-hidden transition-colors ${
        isSelected ? 'bg-[var(--surface-sunken)]' : 'bg-[var(--surface-sunken)] hover:bg-[var(--surface-sunken)]'
      }`}
      style={{ gridRow: '1 / -1' }}
    >
      {/* Header */}
      <div className={`flex items-center gap-3 border-b-2 px-3.5 py-2.5 ${
        isSelected ? 'border-signal-bad' : 'border-[var(--surface-raised)]'
      }`}>
        <div className="flex h-9 w-9 items-center justify-center rounded-[10px] border-2 border-signal-bad text-sm font-bold text-signal-bad shadow-[0_0_16px_rgba(244,63,94,0.25)]" style={{ background: 'var(--surface)' }}>
          E
        </div>
        <div className="flex-1">
          <div className="text-[13px] font-semibold text-[var(--ink-soft)]">Security Auditor</div>
          <div className="text-[10px] text-[var(--ink-faint)]">{formatSummary(findings)}</div>
        </div>
        <div className="text-[9px] uppercase tracking-wider text-signal-bad">
          {headerStatus}
        </div>
      </div>

      {/* Findings list */}
      <div
        className="flex-1 min-h-0 overflow-y-auto border-b border-[var(--surface-raised)] px-2 py-1.5 [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-sm [&::-webkit-scrollbar-thumb]:bg-[var(--surface-overlay)] [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-[3px]"
        onClick={(e) => e.stopPropagation()}
      >
        {sortedFindings.length === 0 && (
          <div className="py-8 text-center text-[11px] text-[var(--ink-faint)]">
            {currentPhase === 'security-audit' ? 'No findings yet — E is auditing...' : 'Audit clean — no findings.'}
          </div>
        )}
        <div className="space-y-1.5">
          {sortedFindings.map((f) => {
            const sev = SEVERITY_STYLES[f.severity];
            const status = STATUS_LABELS[f.status];
            const statusColor = STATUS_COLORS[f.status];
            const inFlight = f.status === 'sent-to-c' || f.status === 're-auditing';
            const canAct = (f.status === 'open' || f.status === 'still-open') && !auditActionInFlight;
            return (
              <div
                key={f.id}
                className={`rounded-md border ${sev.ring} bg-[var(--surface)] px-2 py-1.5`}
              >
                <div className="flex items-center gap-2">
                  <span className={`inline-flex h-1.5 w-1.5 rounded-full ${sev.dot}`} />
                  <span className={`text-[9px] font-bold uppercase tracking-wider ${sev.text}`}>{sev.label}</span>
                  <span className={`ml-auto text-[9px] uppercase tracking-wider ${statusColor}`}>{status}</span>
                </div>
                <div className="mt-1 text-[11px] leading-relaxed text-ink-soft">
                  <MarkdownText>{f.text}</MarkdownText>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <button
                    onClick={() => onSendToC(f.id)}
                    disabled={!canAct}
                    className="rounded-md bg-accent-cool px-2 py-0.5 text-[10px] font-semibold text-ink transition hover:bg-accent-cool disabled:cursor-not-allowed disabled:bg-[var(--surface-overlay)] disabled:text-[var(--ink-faint)]"
                  >
                    Send to C
                  </button>
                  <button
                    onClick={() => onDismiss(f.id)}
                    disabled={!canAct}
                    className="rounded-md border border-[var(--surface-overlay)] bg-[var(--surface)] px-2 py-0.5 text-[10px] text-ink-soft transition hover:border-[var(--line)] hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Dismiss
                  </button>
                  {inFlight && (
                    <span className="text-[9px] italic text-signal-warn">working...</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Chat with E */}
      <div
        className="min-h-0 max-h-[40%] overflow-y-auto border-b border-[var(--surface-raised)] px-2.5 py-1.5 [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-sm [&::-webkit-scrollbar-thumb]:bg-[var(--surface-overlay)] [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:w-[3px]"
        onClick={(e) => e.stopPropagation()}
      >
        {chatEvents.length === 0 && (
          <p className="py-4 text-center text-[11px] text-ink-faint">Ask E about a finding or its severity.</p>
        )}
        <div className="space-y-px">
          {chatEvents.map((e, i) => (
            <div key={i} className={`rounded px-2 py-1 text-[11px] leading-relaxed ${
              e.type === 'approval' ? 'font-bold text-signal-ok' :
              e.type === 'issue' || e.type === 'failure' ? 'text-signal-bad' :
              e.type === 'tool_call' ? 'italic text-[var(--ink-faint)]' :
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

      {/* Input + Deploy */}
      <div className="flex-shrink-0 px-2.5 py-2" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-end gap-1.5">
          <AutoGrowTextarea
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleChatSubmit();
              }
            }}
            placeholder="Ask E about a finding..."
            disabled={isSending}
            className="max-h-24 flex-1 rounded-md border border-[var(--surface-overlay)] bg-[var(--surface)] px-2.5 py-1.5 text-xs text-ink placeholder-[var(--ink-faint)] focus:border-signal-bad focus:outline-none disabled:opacity-30"
          />
          <button
            onClick={handleChatSubmit}
            disabled={isSending || !chatInput.trim()}
            className="rounded-md bg-accent-cool px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-accent-cool disabled:opacity-30"
          >
            Send
          </button>
        </div>
        {!buildComplete && (
          <div className="mt-2 flex justify-end">
            <button
              onClick={handleDeployClick}
              disabled={pipelineStatus !== 'awaiting-audit-decision' || auditActionInFlight}
              className="rounded-md bg-signal-ok px-3 py-1.5 text-xs font-bold text-ink transition hover:bg-signal-ok disabled:cursor-not-allowed disabled:bg-[var(--surface-overlay)] disabled:text-[var(--ink-faint)]"
            >
              Deploy now →
            </button>
          </div>
        )}
      </div>

      {/* Deploy confirmation modal */}
      {showDeployConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-surface-sunken/70"
          onClick={(e) => { e.stopPropagation(); setShowDeployConfirm(false); }}
        >
          <div
            className="w-[90%] max-w-[380px] rounded-lg border border-line bg-[var(--surface)] p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-semibold text-ink">Ready to deploy?</div>
            <p className="mt-2 text-[12px] leading-relaxed text-ink-soft">
              The build will finalize — git commit and open the output file.
            </p>
            {unresolvedCount > 0 && (
              <p className="mt-2 text-[12px] leading-relaxed text-signal-warn">
                Warning: {unresolvedCount} finding{unresolvedCount === 1 ? '' : 's'} {unresolvedCount === 1 ? 'is' : 'are'} not resolved or dismissed. They will remain in the codebase.
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setShowDeployConfirm(false)}
                className="rounded-md border border-[var(--surface-overlay)] bg-[var(--surface)] px-3 py-1.5 text-xs text-ink-soft transition hover:bg-[var(--surface-raised)]"
              >
                Cancel
              </button>
              <button
                onClick={handleDeployConfirm}
                className="rounded-md bg-signal-ok px-3 py-1.5 text-xs font-bold text-ink transition hover:bg-signal-ok"
              >
                Deploy
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
