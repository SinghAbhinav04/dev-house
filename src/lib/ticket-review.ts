import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { resolveStateFile } from './state-source';
import { hackeroomHome } from './team/roster';
import { findTicket, normalizeTickets, type Ticket } from './tickets';

/** The current run's folder and one of its tickets, for the review routes. */
export function loadTicket(id: string): { ok: true; projectDir: string; ticket: Ticket; concept: string } | { ok: false; status: number; error: string } {
  const file = resolveStateFile('pipeline');
  if (!file) return { ok: false, status: 404, error: 'No run yet' };
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, status: 500, error: 'Could not read the run state' };
  }
  const ticket = findTicket(normalizeTickets(state.tickets), id);
  if (!ticket) return { ok: false, status: 404, error: `No ticket ${id} in this run` };
  return { ok: true, projectDir: dirname(file), ticket, concept: typeof state.concept === 'string' ? state.concept : '' };
}

/** Where review checkouts of a project's branches live: outside Builds, so they never look like a run. */
export function reviewRoot(projectDir: string): string {
  return join(hackeroomHome(), 'review', basename(projectDir));
}
