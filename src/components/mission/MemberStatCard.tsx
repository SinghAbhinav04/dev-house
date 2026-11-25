'use client';

import { shortModelLabel } from '@/lib/team/types';

/** The slice of a roster member needed to describe them in stat cards and tooltips. */
export interface OfficeMember {
  id: string;
  name: string;
  color: string;
  model: string;
  billable: number;
  usage: { totalCostUsd: number };
  tokenBudget?: number;
  currentTask: string;
  startedAt: string;
}

/** Uptime on the current turn. Idle members have none to report. */
export function uptimeLabel(startedAt: string, now: number, isActive: boolean): string {
  if (!isActive || !startedAt) return '—';
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return '—';

  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Energy is budget headroom. With no budget there is nothing to deplete, so it
 * says so rather than showing a full bar that never moves.
 */
export function energyLabel(stats: OfficeMember): { text: string; pct: number | null } {
  if (!stats.tokenBudget || stats.tokenBudget <= 0) return { text: 'unlimited', pct: null };
  const left = Math.max(0, stats.tokenBudget - stats.billable);
  const pct = Math.round((left / stats.tokenBudget) * 100);
  return { text: `${pct}%`, pct };
}

export function compactTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/**
 * Reusable stat card for team members.
 * Used by both the 2D office scene and the 3D studio view.
 */
export function MemberStatCard({
  stats,
  x,
  y,
  maxX = 1024,
  isActive,
  now,
  pinned = false,
  offsetY = -132,
}: {
  stats: OfficeMember;
  x: number;
  y: number;
  maxX?: number;
  isActive: boolean;
  now: number;
  /** Opened by a tap/pin rather than a hover, so it prompts how to get to the chat. */
  pinned?: boolean;
  offsetY?: number;
}) {
  const energy = energyLabel(stats);
  // Ensure the card stays comfortably within the container boundaries
  const left = Math.min(Math.max(x, 104), maxX - 104);

  return (
    <div
      className="pointer-events-none absolute z-[60] w-[200px] -translate-x-1/2 rounded-lg border border-line bg-surface-raised/95 p-2.5 shadow-xl backdrop-blur-sm"
      style={{ left, top: y + offsetY }}
      role="tooltip"
    >
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: stats.color }} />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-ink">{stats.name}</span>
        <span
          className="shrink-0 text-[9px] uppercase tracking-wider text-ink-faint"
          title={stats.model || undefined}
        >
          {shortModelLabel(stats.model) || 'team'}
        </span>
      </div>

      <p className="mt-1.5 line-clamp-2 text-[10px] leading-snug text-ink-soft">
        {isActive && stats.currentTask ? stats.currentTask : stats.currentTask ? `Last: ${stats.currentTask}` : '—'}
      </p>

      <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1.5 border-t border-line pt-2">
        <div>
          <dt className="text-[8px] uppercase tracking-wider text-ink-faint">Uptime</dt>
          <dd className="font-mono text-[10px] text-ink">{uptimeLabel(stats.startedAt, now, isActive)}</dd>
        </div>
        <div>
          <dt className="text-[8px] uppercase tracking-wider text-ink-faint">Tokens</dt>
          <dd className="font-mono text-[10px] text-ink">{compactTokens(stats.billable)}</dd>
        </div>
        <div>
          <dt className="text-[8px] uppercase tracking-wider text-ink-faint">Cost</dt>
          <dd className="font-mono text-[10px] text-ink">${stats.usage.totalCostUsd.toFixed(3)}</dd>
        </div>
        <div>
          <dt className="text-[8px] uppercase tracking-wider text-ink-faint">Energy</dt>
          <dd className="font-mono text-[10px] text-ink">{energy.text}</dd>
          {energy.pct !== null && (
            <dd className="mt-0.5 h-0.5 overflow-hidden rounded-full bg-surface-overlay">
              <span
                className={`block h-full ${energy.pct > 25 ? 'bg-signal-ok' : 'bg-signal-warn'}`}
                style={{ width: `${energy.pct}%` }}
              />
            </dd>
          )}
        </div>
      </dl>

      {pinned && (
        <p className="mt-2 text-center text-[9px] uppercase tracking-wider text-ink-faint">Tap again to open the chat</p>
      )}
    </div>
  );
}
