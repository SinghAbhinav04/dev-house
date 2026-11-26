import { readFileSync } from 'fs';
import { dirname } from 'path';
import { NextRequest, NextResponse } from 'next/server';

import { writeJsonAtomic } from '@/lib/atomic-write';
import { resolveStateFile, STAGING_DIR } from '@/lib/state-source';
import { isTicketOp, type TicketOp } from '@/lib/tickets';
import { applyTicketOps, queueTicketOp } from '@/lib/workflow-store';

/**
 * A user action on a ticket from the board: comment, reject, reopen or move.
 *
 * While a run is live the op is queued for the orchestrator, which owns the
 * state file. Otherwise nothing else is writing, so it is applied directly.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be JSON' }, { status: 400 });
  }

  const op = { ...body, time: new Date().toISOString() } as unknown;
  if (!isTicketOp(op)) {
    return NextResponse.json({ ok: false, error: 'Not a valid ticket action' }, { status: 400 });
  }

  const file = resolveStateFile('pipeline');
  if (!file) return NextResponse.json({ ok: false, error: 'No run to act on yet' }, { status: 404 });

  let state: Record<string, unknown>;
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return NextResponse.json({ ok: false, error: 'Could not read the run state' }, { status: 500 });
  }

  const tickets = Array.isArray(state.tickets) ? (state.tickets as Array<{ id: string }>) : [];
  if (!tickets.some((t) => t.id === (op as TicketOp).ticketId)) {
    return NextResponse.json({ ok: false, error: `No ticket ${(op as TicketOp).ticketId}` }, { status: 404 });
  }

  const projectDir = dirname(file);
  if (state.pipelineStatus === 'running' && projectDir !== STAGING_DIR) {
    queueTicketOp(projectDir, op as TicketOp);
    return NextResponse.json({ ok: true, queued: true });
  }

  state.tickets = applyTicketOps(state.tickets, [op as TicketOp]);
  writeJsonAtomic(file, state);
  return NextResponse.json({ ok: true, queued: false });
}
