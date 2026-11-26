import { NextRequest, NextResponse } from 'next/server';

import { ticketDiff } from '@/lib/ticket-git';
import { loadTicket } from '@/lib/ticket-review';

/** A ticket's changes, file by file, for the review page. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const found = loadTicket(id);
  if (!found.ok) return NextResponse.json({ ok: false, error: found.error }, { status: found.status });
  const { ticket, projectDir } = found;
  if (!ticket.branch) {
    return NextResponse.json({ ok: true, ticket, files: [], truncated: false, note: 'No branch yet — one is created when work starts.' });
  }
  const diff = ticketDiff(projectDir, ticket.branch);
  return NextResponse.json({ ok: true, ticket, ...diff });
}
