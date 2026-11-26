'use client';

import { useEffect, useMemo, useState } from 'react';

import {
  BOARD_COLUMNS,
  TICKET_STATUS_LABELS,
  childBugs,
  findTicket,
  isClosed,
  type Ticket,
  type TicketOpInput,
  type TicketType,
  ticketTimes,
} from '@/lib/tickets';
import { MarkdownText } from '@/components/shared/MarkdownText';

export interface BoardPerson {
  id: string;
  name: string;
  color?: string;
}

export interface TicketBoardProps {
  tickets: readonly Ticket[];
  people: readonly BoardPerson[];
  /** Comment / reject / reopen. Omitted for a read-only board. */
  onOp?: (op: TicketOpInput) => Promise<{ ok: boolean; error?: string; queued?: boolean }>;
  /** Fill the parent's height (modal tab) rather than the page's. */
  compact?: boolean;
}

const TYPE_STYLE: Record<TicketType, { label: string; color: string }> = {
  story: { label: 'Story', color: '#8fae60' },
  task: { label: 'Task', color: '#7fa8c9' },
  bug: { label: 'Bug', color: '#cf6c5a' },
  security: { label: 'Security', color: '#d9a441' },
};

const PRIORITY_STYLE: Record<string, string> = { p1: '#cf6c5a', p2: '#d9a441', p3: '#8a7a6b' };

/** How long a ticket that just changed stays highlighted. */
const FRESH_MS = 6000;

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** 1h 05m, 12m, 40s — for estimates and time spent. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

function clock(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function timeAgo(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function TicketBoard({ tickets, people, onOp, compact = false }: TicketBoardProps) {
  const now = useNow(1000);
  const [assignee, setAssignee] = useState<string>('all');
  const [types, setTypes] = useState<Set<TicketType>>(() => new Set(['story', 'task', 'bug', 'security']));
  const [openId, setOpenId] = useState<string | null>(null);

  const person = useMemo(() => {
    const byId = new Map(people.map((p) => [p.id, p]));
    return (id: string | null | undefined): BoardPerson => {
      if (!id) return { id: '', name: 'Unassigned', color: '#5c5046' };
      if (id === 'user') return { id, name: 'You', color: '#f4ece2' };
      if (id === 'system') return { id, name: 'System', color: '#8a7a6b' };
      return byId.get(id) ?? { id, name: id, color: '#8a7a6b' };
    };
  }, [people]);

  const visible = tickets.filter(
    (t) => types.has(t.type) && (assignee === 'all' || (assignee === 'none' ? !t.assignee : t.assignee === assignee)),
  );
  const assignees = [...new Set(tickets.map((t) => t.assignee).filter((a): a is string => Boolean(a)))];
  const open = openId ? findTicket(tickets, openId) : undefined;

  const doneCount = tickets.filter((t) => t.status === 'done').length;
  const bugCount = tickets.filter((t) => t.type === 'bug' && !isClosed(t.status)).length;

  return (
    <div className={`relative flex ${compact ? 'h-full' : 'h-[calc(100vh-7rem)]'} min-h-0 flex-col gap-3 text-[#f4ece2]`}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-2 font-mono text-[11px] text-[#8a7a6b]">
          <span className="font-bold text-[#f4ece2]">{tickets.length}</span> tickets ·{' '}
          <span className="font-bold text-[#8fae60]">{doneCount}</span> done ·{' '}
          <span className="font-bold text-[#cf6c5a]">{bugCount}</span> open bugs
        </div>
        <select
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          aria-label="Filter by assignee"
          className="rounded-lg border border-[rgba(244,236,226,0.12)] bg-[#1e1915] px-2 py-1 font-mono text-[11px] text-[#f4ece2]"
        >
          <option value="all">Everyone</option>
          {assignees.map((id) => (
            <option key={id} value={id}>
              {person(id).name}
            </option>
          ))}
          <option value="none">Unassigned</option>
        </select>
        {(Object.keys(TYPE_STYLE) as TicketType[]).map((type) => {
          const on = types.has(type);
          return (
            <button
              key={type}
              type="button"
              aria-pressed={on}
              onClick={() =>
                setTypes((prev) => {
                  const next = new Set(prev);
                  if (next.has(type)) next.delete(type);
                  else next.add(type);
                  return next;
                })
              }
              className="rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider transition-opacity"
              style={{
                borderColor: `${TYPE_STYLE[type].color}66`,
                color: TYPE_STYLE[type].color,
                background: on ? `${TYPE_STYLE[type].color}22` : 'transparent',
                opacity: on ? 1 : 0.45,
              }}
            >
              {TYPE_STYLE[type].label}
            </button>
          );
        })}
      </div>

      {tickets.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-[rgba(244,236,226,0.12)] p-8 text-center text-sm text-[#8a7a6b]">
          No tickets yet. Write a brief on the whiteboard and submit it — the planner turns the approved plan into tickets here.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 gap-2.5 overflow-x-auto pb-1">
          {BOARD_COLUMNS.map((column) => {
            const cards = visible.filter((t) => column.statuses.includes(t.status));
            return (
              <section
                key={column.id}
                aria-label={column.label}
                className={`flex flex-col rounded-xl min-w-[9.5rem] flex-1 basis-0 border border-[rgba(244,236,226,0.08)] bg-[#1a1612]`}
              >
                <header className="flex items-center justify-between border-b border-[rgba(244,236,226,0.06)] px-3 py-2">
                  <span className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] text-[#c9b8a6]">{column.label}</span>
                  <span className="rounded-md bg-[#262019] px-1.5 font-mono text-[10px] text-[#8a7a6b]">{cards.length}</span>
                </header>
                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
                  {cards.map((ticket) => {
                    const owner = person(ticket.assignee);
                    const fresh = now - Date.parse(ticket.updatedAt) < FRESH_MS;
                    const bugs = childBugs(tickets, ticket.id).filter((b) => !isClosed(b.status)).length;
                    return (
                      <button
                        key={ticket.id}
                        type="button"
                        onClick={() => setOpenId(ticket.id)}
                        className={`group rounded-lg border bg-[#221c17] p-2.5 text-left transition-all hover:border-[#d98b4d]/60 hover:bg-[#2a221b] ${
                          fresh ? 'border-[#d98b4d] shadow-[0_0_0_2px_rgba(217,139,77,0.25)]' : 'border-[rgba(244,236,226,0.08)]'
                        }`}
                      >
                        <div className="mb-1.5 flex items-center gap-1.5">
                          <span
                            className="rounded px-1 font-mono text-[9px] font-bold uppercase"
                            style={{ color: TYPE_STYLE[ticket.type].color, background: `${TYPE_STYLE[ticket.type].color}1f` }}
                          >
                            {TYPE_STYLE[ticket.type].label}
                          </span>
                          <span className="font-mono text-[10px] text-[#8a7a6b]">{ticket.id}</span>
                          <span
                            className="ml-auto font-mono text-[9px] font-bold uppercase"
                            style={{ color: PRIORITY_STYLE[ticket.priority] }}
                            title="Priority"
                          >
                            {ticket.priority}
                          </span>
                        </div>
                        <p className="line-clamp-3 text-[12px] leading-snug text-[#f4ece2]">{ticket.title}</p>
                        <div className="mt-2 flex items-center gap-1.5">
                          <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: owner.color }} />
                          <span className="truncate font-mono text-[10px] text-[#c9b8a6]">{owner.name}</span>
                          {ticket.status === 'rejected' || ticket.status === 'blocked' ? (
                            <span className="ml-auto font-mono text-[9px] font-bold uppercase text-[#cf6c5a]">
                              {TICKET_STATUS_LABELS[ticket.status]}
                            </span>
                          ) : bugs > 0 ? (
                            <span className="ml-auto font-mono text-[9px] font-bold text-[#cf6c5a]" title="Open bugs">
                              {bugs} bug{bugs === 1 ? '' : 's'}
                            </span>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {open && (
        <TicketDrawer
          key={open.id}
          ticket={open}
          tickets={tickets}
          person={person}
          now={now}
          onOp={onOp}
          onOpen={setOpenId}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}

function TicketDrawer({
  ticket,
  tickets,
  person,
  now,
  onOp,
  onOpen,
  onClose,
}: {
  ticket: Ticket;
  tickets: readonly Ticket[];
  person: (id: string | null | undefined) => BoardPerson;
  now: number;
  onOp?: TicketBoardProps['onOp'];
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const parent = ticket.parentId ? findTicket(tickets, ticket.parentId) : undefined;
  const bugs = childBugs(tickets, ticket.id);

  useEffect(() => {
    // Capture phase, and stop it there: Esc closes this drawer, not the
    // modal the board may be sitting in.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const run = async (op: TicketOpInput, success: string) => {
    if (!onOp) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await onOp(op);
      if (result.ok) {
        setMessage({ ok: true, text: result.queued ? `${success} — the team will pick it up in a moment.` : success });
        if (op.kind === 'comment') setDraft('');
      } else {
        setMessage({ ok: false, text: result.error || 'That did not go through.' });
      }
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const timeline = [
    ...ticket.history.map((h) => ({ kind: 'history' as const, time: h.time, entry: h })),
    ...ticket.comments.map((c) => ({ kind: 'comment' as const, time: c.time, entry: c })),
  ].sort((a, b) => a.time.localeCompare(b.time));

  return (
    <div className="absolute inset-0 z-20 flex justify-end" role="dialog" aria-label={`${ticket.id} details`}>
      <button type="button" aria-label="Close details" onClick={onClose} className="flex-1 cursor-default bg-black/40" />
      <aside className="flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-[rgba(244,236,226,0.12)] bg-[#17130f] shadow-2xl">
        <header className="flex items-start gap-3 border-b border-[rgba(244,236,226,0.08)] p-4">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2 font-mono text-[10px]">
              <span style={{ color: TYPE_STYLE[ticket.type].color }} className="font-bold uppercase">
                {TYPE_STYLE[ticket.type].label}
              </span>
              <span className="text-[#8a7a6b]">{ticket.id}</span>
              <span className="rounded bg-[#262019] px-1.5 py-0.5 font-bold uppercase text-[#d98b4d]">
                {TICKET_STATUS_LABELS[ticket.status]}
              </span>
            </div>
            <h3 className="text-sm font-bold leading-snug">{ticket.title}</h3>
            <p className="mt-1 font-mono text-[10px] text-[#8a7a6b]">updated {timeAgo(ticket.updatedAt, now)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-[rgba(244,236,226,0.1)] text-[#8a7a6b] hover:text-[#f4ece2]"
            title="Close (Esc)"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto p-4 text-[12px]">
          <TicketDetails ticket={ticket} person={person} now={now} />

          {ticket.description && (
            <section>
              <h4 className="mb-1 font-mono text-[10px] font-bold uppercase tracking-wider text-[#8a7a6b]">Description</h4>
              <MarkdownText className="text-[12px] text-[#e8dccd]">{ticket.description}</MarkdownText>
            </section>
          )}

          {ticket.acceptance.length > 0 && (
            <section>
              <h4 className="mb-1 font-mono text-[10px] font-bold uppercase tracking-wider text-[#8a7a6b]">Acceptance criteria</h4>
              <ul className="list-disc space-y-0.5 pl-4 text-[#e8dccd]">
                {ticket.acceptance.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </section>
          )}

          {(parent || bugs.length > 0) && (
            <section>
              <h4 className="mb-1 font-mono text-[10px] font-bold uppercase tracking-wider text-[#8a7a6b]">Linked</h4>
              <div className="space-y-1">
                {parent && (
                  <button type="button" onClick={() => onOpen(parent.id)} className="block text-left text-[#7fa8c9] hover:underline">
                    Parent {parent.id}: {parent.title}
                  </button>
                )}
                {bugs.map((bug) => (
                  <button key={bug.id} type="button" onClick={() => onOpen(bug.id)} className="block text-left text-[#cf6c5a] hover:underline">
                    {bug.id} ({TICKET_STATUS_LABELS[bug.status]}): {bug.title}
                  </button>
                ))}
              </div>
            </section>
          )}

          <section>
            <h4 className="mb-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-[#8a7a6b]">Activity</h4>
            <ol className="space-y-2 border-l border-[rgba(244,236,226,0.1)] pl-3">
              {timeline.map((item, i) => (
                <li key={i} className="text-[11px] leading-snug">
                  <span className="font-mono text-[10px] text-[#8a7a6b]">{timeAgo(item.time, now)} · </span>
                  <span className="font-bold text-[#c9b8a6]">{person(item.entry.by).name}</span>{' '}
                  {item.kind === 'comment' ? (
                    <span className="text-[#e8dccd]">commented: {item.entry.text}</span>
                  ) : item.entry.from && item.entry.from !== item.entry.to ? (
                    <span className="text-[#e8dccd]">
                      moved {TICKET_STATUS_LABELS[item.entry.from]} → <b>{TICKET_STATUS_LABELS[item.entry.to]}</b>
                      {item.entry.note ? <span className="text-[#8a7a6b]"> — {item.entry.note}</span> : null}
                    </span>
                  ) : item.entry.from ? (
                    <span className="text-[#e8dccd]">{item.entry.note || 'updated the ticket'}</span>
                  ) : (
                    <span className="text-[#e8dccd]">created it in {TICKET_STATUS_LABELS[item.entry.to]}</span>
                  )}
                </li>
              ))}
            </ol>
          </section>
        </div>

        {onOp && (
          <footer className="space-y-2 border-t border-[rgba(244,236,226,0.08)] p-4">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              placeholder="Add a comment for the team…"
              className="w-full resize-none rounded-lg border border-[rgba(244,236,226,0.12)] bg-[#0d0a08] p-2 text-[12px] text-[#f4ece2] placeholder-[#8a7a6b]/60 focus:border-[#d98b4d] focus:outline-none"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy || !draft.trim()}
                onClick={() => run({ kind: 'comment', ticketId: ticket.id, text: draft.trim() }, 'Comment added')}
                className="rounded-lg bg-[#d98b4d] px-3 py-1.5 font-mono text-[11px] font-bold text-[#17130f] disabled:opacity-40"
              >
                Comment
              </button>
              {!isClosed(ticket.status) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run({ kind: 'reject', ticketId: ticket.id, note: draft.trim() || undefined }, 'Rejected')}
                  className="rounded-lg border border-[#cf6c5a]/50 px-3 py-1.5 font-mono text-[11px] font-bold text-[#cf6c5a] hover:bg-[#cf6c5a]/10 disabled:opacity-40"
                >
                  Reject
                </button>
              )}
              {isClosed(ticket.status) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => run({ kind: 'reopen', ticketId: ticket.id, note: draft.trim() || undefined }, 'Reopened')}
                  className="rounded-lg border border-[#8fae60]/50 px-3 py-1.5 font-mono text-[11px] font-bold text-[#8fae60] hover:bg-[#8fae60]/10 disabled:opacity-40"
                >
                  Reopen
                </button>
              )}
              {message && (
                <span role="status" className={`font-mono text-[10px] ${message.ok ? 'text-[#8fae60]' : 'text-[#cf6c5a]'}`}>
                  {message.text}
                </span>
              )}
            </div>
          </footer>
        )}
      </aside>
    </div>
  );
}

const FIELD_LABEL = 'font-mono text-[9px] font-bold uppercase tracking-wider text-[#8a7a6b]';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className={FIELD_LABEL}>{label}</div>
      <div className="mt-0.5 truncate text-[12px] text-[#f4ece2]">{children}</div>
    </div>
  );
}

function PersonChip({ who }: { who: BoardPerson }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: who.color }} />
      {who.name}
    </span>
  );
}

/** The Azure DevOps-style fields: who, when, how big, where the code is. */
function TicketDetails({
  ticket,
  person,
  now,
}: {
  ticket: Ticket;
  person: (id: string | null | undefined) => BoardPerson;
  now: number;
}) {
  const times = ticketTimes(ticket, now);
  const [ide, setIde] = useState<{ ok: boolean; text: string } | null>(null);
  const overdue = times.eta && Date.parse(times.eta) < now;
  const branch = ticket.branch;

  const openIde = async () => {
    setIde(null);
    try {
      const res = await fetch(`/api/tickets/${encodeURIComponent(ticket.id)}/open`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; editor?: string; path?: string };
      setIde(res.ok && body.ok ? { ok: true, text: `Opened in ${body.editor}` } : { ok: false, text: body.error || 'Could not open an editor' });
    } catch (err) {
      setIde({ ok: false, text: (err as Error).message });
    }
  };

  return (
    <>
      <section className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-[rgba(244,236,226,0.08)] bg-[#1e1915] p-3 sm:grid-cols-3">
        <Field label="State">
          <span className="font-bold text-[#d98b4d]">{TICKET_STATUS_LABELS[ticket.status]}</span>
        </Field>
        <Field label="Assigned to">
          <PersonChip who={person(ticket.assignee)} />
        </Field>
        <Field label="Dev owner">
          <PersonChip who={person(ticket.owner ?? ticket.assignee)} />
        </Field>
        <Field label="Priority">
          <span style={{ color: PRIORITY_STYLE[ticket.priority] }} className="font-bold">
            {ticket.priority.toUpperCase()}
          </span>
        </Field>
        <Field label="Reporter">
          <PersonChip who={person(ticket.reporter)} />
        </Field>
        <Field label="Original estimate">{ticket.estimateMinutes ? formatDuration(ticket.estimateMinutes * 60_000) : '—'}</Field>
        <Field label="Created">{clock(times.createdAt)}</Field>
        <Field label="Started">{clock(times.startedAt)}</Field>
        <Field label={times.completedAt ? 'Completed' : 'ETA'}>
          {times.completedAt ? (
            clock(times.completedAt)
          ) : times.eta ? (
            <span className={overdue ? 'text-[#cf6c5a]' : ''}>
              {clock(times.eta)}
              {overdue ? ' (late)' : ''}
            </span>
          ) : (
            '—'
          )}
        </Field>
        <Field label="Time in progress">{times.activeMs > 0 ? formatDuration(times.activeMs) : '—'}</Field>
        <Field label="Cycle time">{times.cycleMs !== undefined ? formatDuration(times.cycleMs) : '—'}</Field>
        <Field label="Review">
          {ticket.review ? (
            <span className={ticket.review.verdict === 'approved' ? 'text-[#8fae60]' : 'text-[#cf6c5a]'}>
              {ticket.review.verdict === 'approved' ? 'Approved' : 'Changes requested'} · {person(ticket.review.by).name}
            </span>
          ) : (
            '—'
          )}
        </Field>
      </section>

      {(ticket.tags ?? []).length > 0 && (
        <section className="flex flex-wrap gap-1.5">
          {(ticket.tags ?? []).map((tag) => (
            <span key={tag} className="rounded-full border border-[#7fa8c9]/40 bg-[#7fa8c9]/10 px-2 py-0.5 font-mono text-[10px] text-[#a9c7df]">
              {tag}
            </span>
          ))}
        </section>
      )}

      <section>
        <h4 className="mb-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-[#8a7a6b]">Development</h4>
        {branch ? (
          <div className="space-y-2 rounded-xl border border-[rgba(244,236,226,0.08)] bg-[#1e1915] p-3">
            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
              <span className="text-[#8a7a6b]">⑂</span>
              <a href={`/review/${encodeURIComponent(ticket.id)}`} target="_blank" rel="noreferrer" className="font-bold text-[#7fa8c9] hover:underline">
                {branch.name}
              </a>
              <span className="text-[#8a7a6b]">{branch.merged ? 'merged' : branch.head ? 'open' : 'in progress'}</span>
              {branch.files !== undefined && (
                <span className="ml-auto">
                  <span className="text-[#c9b8a6]">{branch.files} file{branch.files === 1 ? '' : 's'} </span>
                  <span className="text-[#8fae60]">+{branch.additions ?? 0}</span> <span className="text-[#cf6c5a]">−{branch.deletions ?? 0}</span>
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={`/review/${encodeURIComponent(ticket.id)}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg bg-[#7fa8c9] px-3 py-1.5 font-mono text-[11px] font-bold text-[#17130f]"
              >
                View changes
              </a>
              <button
                type="button"
                onClick={openIde}
                className="rounded-lg border border-[rgba(244,236,226,0.16)] px-3 py-1.5 font-mono text-[11px] font-bold text-[#f4ece2] hover:bg-[#262019]"
              >
                Open in IDE
              </button>
              {ide && <span className={`font-mono text-[10px] ${ide.ok ? 'text-[#8fae60]' : 'text-[#cf6c5a]'}`}>{ide.text}</span>}
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-[#8a7a6b]">No branch yet — one is created when work starts.</p>
        )}
      </section>
    </>
  );
}
