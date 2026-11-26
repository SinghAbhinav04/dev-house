'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { TICKET_STATUS_LABELS, type Ticket } from '@/lib/tickets';
import type { FileDiff } from '@/lib/ticket-git';
import { useTeam } from '@/lib/use-team';

interface DiffResponse {
  ok: boolean;
  error?: string;
  note?: string;
  ticket?: Ticket;
  files?: FileDiff[];
  truncated?: boolean;
}

interface Row {
  kind: 'hunk' | 'add' | 'del' | 'ctx';
  text: string;
  oldNo?: number;
  newNo?: number;
}

/** Unified hunks → rows with old/new line numbers. */
function rowsOf(patch: string): Row[] {
  const rows: Row[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of patch.split('\n')) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      rows.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1), newNo: newNo++ });
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ });
    } else if (line.startsWith('\\')) {
      continue;
    } else {
      rows.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return rows;
}

const ROW_STYLE: Record<Row['kind'], string> = {
  hunk: 'bg-[#1d2a3a] text-[#93c5fd]',
  add: 'bg-[#16301c] text-[#d6f5d6]',
  del: 'bg-[#3a1a17] text-[#f6d4cf]',
  ctx: 'text-[#c9b8a6]',
};

const STATUS_BADGE: Record<FileDiff['status'], string> = {
  added: 'text-[#8fae60]',
  deleted: 'text-[#cf6c5a]',
  modified: 'text-[#d9a441]',
  renamed: 'text-[#7fa8c9]',
};

/**
 * A ticket's branch as a pull request: what changed, file by file, and the
 * buttons to open it in your editor, approve it, or send it back.
 */
export default function ReviewPage() {
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(params.id ?? '');
  const [data, setData] = useState<DiffResponse | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { team } = useTeam();
  const nameOf = useCallback(
    (memberId?: string | null) => (memberId === 'user' ? 'You' : team.roster.members.find((m) => m.id === memberId)?.name ?? memberId ?? '—'),
    [team.roster.members],
  );

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/tickets/${encodeURIComponent(id)}/diff`, { cache: 'no-store' });
      setData((await res.json()) as DiffResponse);
    } catch (err) {
      setData({ ok: false, error: (err as Error).message });
    }
  }, [id]);

  useEffect(() => {
    // Initial load, then follow the branch while the team is still on it.
    let alive = true;
    const tick = () => {
      if (alive) void load();
    };
    tick();
    const timer = window.setInterval(tick, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [load]);

  const files = useMemo(() => data?.files ?? [], [data?.files]);
  const shown = files.find((f) => f.path === active) ?? files[0];
  const ticket = data?.ticket;
  const branch = ticket?.branch;
  const totals = files.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 });

  const act = async (path: string, body?: unknown, done?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; editor?: string; queued?: boolean };
      if (res.ok && out.ok) {
        setMessage({ ok: true, text: out.editor ? `Opened in ${out.editor}` : done ?? 'Done' });
        if (body) setNote('');
        void load();
      } else {
        setMessage({ ok: false, text: out.error || 'That did not go through' });
      }
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#0f0c0a] px-4 py-4 text-[#f4ece2] sm:px-6">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <Link href="/board" className="font-mono text-[11px] text-[#8a7a6b] hover:text-[#f4ece2]">
          ← Board
        </Link>
        <h1 className="font-mono text-sm font-bold uppercase tracking-[0.2em]">Review</h1>
      </header>

      {!data ? (
        <p className="text-sm text-[#8a7a6b]">Loading {id}…</p>
      ) : !data.ok || !ticket ? (
        <p className="text-sm text-[#cf6c5a]">{data.error || `Could not load ${id}`}</p>
      ) : (
        <>
          <section className="mb-4 rounded-xl border border-[rgba(244,236,226,0.1)] bg-[#17130f] p-4">
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex flex-wrap items-center gap-2 font-mono text-[11px]">
                  <span className="text-[#8a7a6b]">{ticket.id}</span>
                  <span className="rounded bg-[#262019] px-1.5 py-0.5 font-bold uppercase text-[#d98b4d]">{TICKET_STATUS_LABELS[ticket.status]}</span>
                  {ticket.review && (
                    <span className={ticket.review.verdict === 'approved' ? 'text-[#8fae60]' : 'text-[#cf6c5a]'}>
                      {ticket.review.verdict === 'approved' ? '✓ Approved' : '✗ Changes requested'} by {nameOf(ticket.review.by)}
                    </span>
                  )}
                </div>
                <h2 className="text-lg font-bold leading-snug">{ticket.title}</h2>
                {branch ? (
                  <p className="mt-1 break-all font-mono text-[11px] text-[#c9b8a6]">
                    <span className="text-[#7fa8c9]">{branch.name}</span> · {branch.base.slice(0, 7)} → {(branch.head ?? 'working tree').slice(0, 7)} ·{' '}
                    {branch.merged ? 'merged' : branch.head ? 'open' : 'in progress'} · by {nameOf(ticket.owner ?? ticket.assignee)}
                  </p>
                ) : (
                  <p className="mt-1 text-[12px] text-[#8a7a6b]">{data.note}</p>
                )}
              </div>
              {branch && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[12px]">
                    {files.length} file{files.length === 1 ? '' : 's'} <span className="text-[#8fae60]">+{totals.add}</span>{' '}
                    <span className="text-[#cf6c5a]">−{totals.del}</span>
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => act(`/api/tickets/${encodeURIComponent(ticket.id)}/open`)}
                    className="rounded-lg border border-[rgba(244,236,226,0.16)] px-3 py-1.5 font-mono text-[11px] font-bold hover:bg-[#262019] disabled:opacity-50"
                  >
                    Open in IDE
                  </button>
                </div>
              )}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Review comment (optional for approve)…"
                aria-label="Review comment"
                className="min-w-[14rem] flex-1 rounded-lg border border-[rgba(244,236,226,0.12)] bg-[#0d0a08] px-3 py-1.5 text-[12px] placeholder-[#8a7a6b]/60 focus:border-[#d98b4d] focus:outline-none"
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => act('/api/tickets', { kind: 'comment', ticketId: ticket.id, text: `Approved${note.trim() ? ` — ${note.trim()}` : ''}` }, 'Approval posted')}
                className="rounded-lg bg-[#8fae60] px-3 py-1.5 font-mono text-[11px] font-bold text-[#17130f] disabled:opacity-50"
              >
                Approve
              </button>
              <button
                type="button"
                disabled={busy || !note.trim()}
                title={note.trim() ? '' : 'Say what needs to change'}
                onClick={() => act('/api/tickets', { kind: 'reject', ticketId: ticket.id, note: note.trim() }, 'Sent back with your comment')}
                className="rounded-lg border border-[#cf6c5a]/60 px-3 py-1.5 font-mono text-[11px] font-bold text-[#cf6c5a] hover:bg-[#cf6c5a]/10 disabled:opacity-40"
              >
                Request changes
              </button>
              {message && (
                <span role="status" className={`font-mono text-[11px] ${message.ok ? 'text-[#8fae60]' : 'text-[#cf6c5a]'}`}>
                  {message.text}
                </span>
              )}
            </div>
          </section>

          {branch && files.length === 0 && <p className="text-sm text-[#8a7a6b]">No changes on this branch yet.</p>}

          {files.length > 0 && (
            <div className="flex flex-col gap-3 lg:flex-row">
              <nav aria-label="Changed files" className="flex-shrink-0 rounded-xl border border-[rgba(244,236,226,0.08)] bg-[#17130f] p-2 lg:w-64">
                {files.map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => setActive(f.path)}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[11px] ${
                      shown?.path === f.path ? 'bg-[#262019]' : 'hover:bg-[#1e1915]'
                    }`}
                  >
                    <span className={`w-3 font-bold ${STATUS_BADGE[f.status]}`}>{f.status[0].toUpperCase()}</span>
                    <span className="min-w-0 flex-1 truncate" title={f.path}>
                      {f.path}
                    </span>
                    <span className="text-[#8fae60]">+{f.additions}</span>
                    <span className="text-[#cf6c5a]">−{f.deletions}</span>
                  </button>
                ))}
                {data.truncated && <p className="px-2 pt-2 text-[10px] text-[#d9a441]">Diff too large — showing the start. Open in IDE for the rest.</p>}
              </nav>

              {shown && (
                <section className="min-w-0 flex-1 overflow-hidden rounded-xl border border-[rgba(244,236,226,0.08)] bg-[#120f0d]">
                  <header className="border-b border-[rgba(244,236,226,0.08)] px-3 py-2 font-mono text-[12px]">
                    {shown.oldPath ? `${shown.oldPath} → ` : ''}
                    {shown.path}
                  </header>
                  {shown.binary ? (
                    <p className="p-4 text-[12px] text-[#8a7a6b]">Binary file changed.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse font-mono text-[12px] leading-5">
                        <tbody>
                          {rowsOf(shown.patch).map((row, i) => (
                            <tr key={i} className={ROW_STYLE[row.kind]}>
                              <td className="w-10 select-none border-r border-[rgba(244,236,226,0.06)] px-2 text-right text-[#5c5046]">{row.oldNo ?? ''}</td>
                              <td className="w-10 select-none border-r border-[rgba(244,236,226,0.06)] px-2 text-right text-[#5c5046]">{row.newNo ?? ''}</td>
                              <td className="w-4 select-none pl-2 text-[#8a7a6b]">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}</td>
                              <td className="whitespace-pre px-2">{row.text}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              )}
            </div>
          )}
        </>
      )}
    </main>
  );
}
