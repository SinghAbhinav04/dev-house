/**
 * File-backed pieces of the ticket and whiteboard workflow.
 *
 * The orchestrator rewrites `pipeline-events.json` whole on every event, so
 * nothing else may read-modify-write it while a run is live: the edit would
 * be lost on the next event. User actions on tickets go instead into a queue
 * directory, one file per op, which the orchestrator drains on each flush.
 * One file per op means a writer and the drainer never touch the same file,
 * so no op is lost or applied twice.
 *
 * The queue lives under `.claude/`, which no member can write, so an agent
 * cannot forge a "user rejected this" op.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { applyTicketOp, isTicketOp, normalizeTickets, type Ticket, type TicketOp } from './tickets.ts';

export function ticketOpsDir(projectDir: string): string {
  return join(projectDir, '.claude', 'ticket-ops');
}

export function queueTicketOp(projectDir: string, op: TicketOp): void {
  const dir = ticketOpsDir(projectDir);
  mkdirSync(dir, { recursive: true });
  // Sortable by time, unique by uuid: ops drain in the order they were made.
  const name = `${Date.now().toString().padStart(15, '0')}-${randomUUID()}.json`;
  writeFileSync(join(dir, name), JSON.stringify(op));
}

/** Read and remove every queued op, oldest first. Malformed files are dropped. */
export function drainTicketOps(projectDir: string): TicketOp[] {
  const dir = ticketOpsDir(projectDir);
  if (!existsSync(dir)) return [];

  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }

  const ops: TicketOp[] = [];
  for (const name of names) {
    const file = join(dir, name);
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (isTicketOp(parsed)) ops.push(parsed);
    } catch {
      // A file caught half-written is retried next drain rather than lost.
      continue;
    }
    try {
      unlinkSync(file);
    } catch {}
  }
  return ops;
}

export function applyTicketOps(tickets: unknown, ops: readonly TicketOp[]): Ticket[] {
  let next = normalizeTickets(tickets);
  for (const op of ops) next = applyTicketOp(next, op);
  return next;
}
