/**
 * Tickets: the work items a run is broken into, tracked the way a real team
 * tracks them in Jira or Azure DevOps.
 *
 * The orchestrator is the only writer of the state file, so every function
 * here is pure — it takes a ticket list and returns a new one. The UI uses the
 * same functions to label and group, and user actions arrive as queued
 * `TicketOp`s that the orchestrator (or the API, when no run is live) applies
 * with `applyTicketOp`.
 *
 * No imports on purpose: the test suite loads this file directly with
 * `--experimental-strip-types`, and the browser bundle pulls it in too.
 */

export type TicketType = 'story' | 'task' | 'bug' | 'security';

export type TicketStatus =
  | 'backlog'
  | 'todo'
  | 'solutioning'
  | 'in-progress'
  | 'in-review'
  | 'in-qa'
  | 'done'
  | 'rejected'
  | 'blocked';

export type TicketPriority = 'p1' | 'p2' | 'p3';

export interface TicketHistoryEntry {
  time: string;
  /** Member id, 'user' or 'system'. */
  by: string;
  from?: TicketStatus;
  to: TicketStatus;
  note?: string;
}

export interface TicketComment {
  time: string;
  by: string;
  text: string;
}

export interface Ticket {
  /** Human key, `DH-1`, `DH-2`, … unique within a run. */
  id: string;
  type: TicketType;
  title: string;
  description: string;
  acceptance: string[];
  status: TicketStatus;
  priority: TicketPriority;
  /** Member id, or null while unassigned. */
  assignee: string | null;
  reporter: string;
  /** The story a bug was filed against. */
  parentId?: string;
  createdAt: string;
  updatedAt: string;
  history: TicketHistoryEntry[];
  comments: TicketComment[];
}

export const TICKET_PREFIX = 'DH';

export const TICKET_STATUSES: readonly TicketStatus[] = [
  'backlog',
  'todo',
  'solutioning',
  'in-progress',
  'in-review',
  'in-qa',
  'done',
  'rejected',
  'blocked',
];

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  solutioning: 'Solutioning',
  'in-progress': 'In Progress',
  'in-review': 'In Review',
  'in-qa': 'In QA',
  done: 'Done',
  rejected: 'Rejected',
  blocked: 'Blocked',
};

/** Board columns, left to right. Rejected and blocked share the last one. */
export const BOARD_COLUMNS: { id: string; label: string; statuses: TicketStatus[] }[] = [
  { id: 'todo', label: 'To Do', statuses: ['backlog', 'todo'] },
  { id: 'solutioning', label: 'Solutioning', statuses: ['solutioning'] },
  { id: 'in-progress', label: 'In Progress', statuses: ['in-progress'] },
  { id: 'in-review', label: 'In Review', statuses: ['in-review'] },
  { id: 'in-qa', label: 'In QA', statuses: ['in-qa'] },
  { id: 'done', label: 'Done', statuses: ['done'] },
  { id: 'stuck', label: 'Rejected / Blocked', statuses: ['rejected', 'blocked'] },
];

/**
 * Which moves are legal. Anything can be blocked, and a closed ticket can only
 * be reopened back to to-do — that mirrors what a real tracker workflow allows
 * and catches an orchestrator bug that would jump a ticket somewhere absurd.
 */
const TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  backlog: ['todo', 'solutioning', 'in-progress', 'rejected', 'blocked'],
  todo: ['solutioning', 'in-progress', 'rejected', 'blocked', 'backlog'],
  solutioning: ['todo', 'in-progress', 'done', 'rejected', 'blocked'],
  'in-progress': ['in-review', 'in-qa', 'done', 'todo', 'rejected', 'blocked'],
  'in-review': ['in-progress', 'in-qa', 'done', 'rejected', 'blocked'],
  'in-qa': ['in-progress', 'done', 'rejected', 'blocked'],
  done: ['todo', 'in-progress'],
  rejected: ['todo', 'in-progress'],
  blocked: ['todo', 'in-progress', 'rejected'],
};

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return from !== to && TRANSITIONS[from].includes(to);
}

export function isClosed(status: TicketStatus): boolean {
  return status === 'done' || status === 'rejected';
}

export function nextTicketId(tickets: readonly Ticket[]): string {
  let max = 0;
  for (const ticket of tickets) {
    const match = /-(\d+)$/.exec(ticket.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${TICKET_PREFIX}-${max + 1}`;
}

export interface NewTicket {
  type: TicketType;
  title: string;
  description?: string;
  acceptance?: string[];
  priority?: TicketPriority;
  assignee?: string | null;
  reporter: string;
  parentId?: string;
  status?: TicketStatus;
}

const MAX_TITLE = 140;
const MAX_TEXT = 4000;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export function createTicket(
  tickets: readonly Ticket[],
  input: NewTicket,
  now: string = new Date().toISOString(),
): { tickets: Ticket[]; ticket: Ticket } {
  const status = input.status ?? 'backlog';
  const ticket: Ticket = {
    id: nextTicketId(tickets),
    type: input.type,
    title: clip(input.title || 'Untitled', MAX_TITLE),
    description: clip(input.description ?? '', MAX_TEXT),
    acceptance: (input.acceptance ?? []).map((line) => clip(line, 300)).filter(Boolean).slice(0, 12),
    status,
    priority: input.priority ?? 'p2',
    assignee: input.assignee ?? null,
    reporter: input.reporter,
    parentId: input.parentId,
    createdAt: now,
    updatedAt: now,
    history: [{ time: now, by: input.reporter, to: status, note: 'created' }],
    comments: [],
  };
  return { tickets: [...tickets, ticket], ticket };
}

function replace(tickets: readonly Ticket[], id: string, update: (ticket: Ticket) => Ticket | null): Ticket[] {
  let changed = false;
  const next = tickets.map((ticket) => {
    if (ticket.id !== id) return ticket;
    const updated = update(ticket);
    if (!updated) return ticket;
    changed = true;
    return updated;
  });
  return changed ? next : (tickets as Ticket[]);
}

export class TicketTransitionError extends Error {}

/**
 * Move a ticket. An illegal move throws in strict mode (tests, orchestrator
 * bugs) and is ignored otherwise (user ops replayed against stale state).
 */
export function moveTicket(
  tickets: readonly Ticket[],
  id: string,
  to: TicketStatus,
  by: string,
  note?: string,
  options: { now?: string; strict?: boolean } = {},
): Ticket[] {
  const now = options.now ?? new Date().toISOString();
  return replace(tickets, id, (ticket) => {
    if (ticket.status === to) return null;
    if (!canTransition(ticket.status, to)) {
      if (options.strict) throw new TicketTransitionError(`${id}: ${ticket.status} → ${to} is not allowed`);
      return null;
    }
    return {
      ...ticket,
      status: to,
      updatedAt: now,
      history: [...ticket.history, { time: now, by, from: ticket.status, to, note: note ? clip(note, 500) : undefined }],
    };
  });
}

export function assignTicket(
  tickets: readonly Ticket[],
  id: string,
  assignee: string | null,
  by: string,
  now: string = new Date().toISOString(),
): Ticket[] {
  return replace(tickets, id, (ticket) => {
    if (ticket.assignee === assignee) return null;
    return {
      ...ticket,
      assignee,
      updatedAt: now,
      history: [
        ...ticket.history,
        { time: now, by, from: ticket.status, to: ticket.status, note: assignee ? `assigned to ${assignee}` : 'unassigned' },
      ],
    };
  });
}

export function commentTicket(
  tickets: readonly Ticket[],
  id: string,
  by: string,
  text: string,
  now: string = new Date().toISOString(),
): Ticket[] {
  const body = clip(text, MAX_TEXT);
  if (!body) return tickets as Ticket[];
  return replace(tickets, id, (ticket) => ({
    ...ticket,
    updatedAt: now,
    comments: [...ticket.comments, { time: now, by, text: body }],
  }));
}

export function findTicket(tickets: readonly Ticket[] | undefined, id: string): Ticket | undefined {
  return tickets?.find((ticket) => ticket.id === id);
}

export function childBugs(tickets: readonly Ticket[], parentId: string): Ticket[] {
  return tickets.filter((ticket) => ticket.parentId === parentId && ticket.type === 'bug');
}

export function ticketsInColumn(tickets: readonly Ticket[], columnId: string): Ticket[] {
  const column = BOARD_COLUMNS.find((c) => c.id === columnId);
  if (!column) return [];
  return tickets.filter((ticket) => column.statuses.includes(ticket.status));
}

/** The ticket a member is working on right now, if any. */
export function activeTicketFor(tickets: readonly Ticket[] | undefined, memberId: string): Ticket | undefined {
  if (!tickets) return undefined;
  const mine = tickets.filter((t) => t.assignee === memberId && !isClosed(t.status));
  const order: TicketStatus[] = ['in-progress', 'in-qa', 'in-review', 'solutioning', 'todo', 'blocked', 'backlog'];
  for (const status of order) {
    const hit = mine.filter((t) => t.status === status).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (hit) return hit;
  }
  return undefined;
}

// ── User ops ─────────────────────────────────────────────────────────

/**
 * What a person can do to a ticket from the board. They are queued rather than
 * written straight into the state file, because the orchestrator rewrites that
 * file whole on every event and would silently drop a concurrent edit.
 */
export type TicketOp =
  | { kind: 'comment'; ticketId: string; text: string; time: string }
  | { kind: 'reject'; ticketId: string; note?: string; time: string }
  | { kind: 'reopen'; ticketId: string; note?: string; time: string }
  | { kind: 'move'; ticketId: string; to: TicketStatus; note?: string; time: string };

/** An op as the UI sends it; the server stamps `time`. Distributes over the union. */
export type TicketOpInput = TicketOp extends infer Op ? (Op extends TicketOp ? Omit<Op, 'time'> : never) : never;

export function isTicketOp(value: unknown): value is TicketOp {
  if (!value || typeof value !== 'object') return false;
  const op = value as Record<string, unknown>;
  if (typeof op.ticketId !== 'string' || typeof op.time !== 'string') return false;
  switch (op.kind) {
    case 'comment':
      return typeof op.text === 'string' && op.text.trim().length > 0;
    case 'reject':
    case 'reopen':
      return op.note === undefined || typeof op.note === 'string';
    case 'move':
      return typeof op.to === 'string' && (TICKET_STATUSES as readonly string[]).includes(op.to);
    default:
      return false;
  }
}

export function applyTicketOp(tickets: readonly Ticket[], op: TicketOp): Ticket[] {
  switch (op.kind) {
    case 'comment':
      return commentTicket(tickets, op.ticketId, 'user', op.text, op.time);
    case 'reject': {
      const moved = moveTicket(tickets, op.ticketId, 'rejected', 'user', op.note ?? 'rejected from the board', { now: op.time });
      return op.note ? commentTicket(moved, op.ticketId, 'user', op.note, op.time) : moved;
    }
    case 'reopen':
      return moveTicket(tickets, op.ticketId, 'todo', 'user', op.note ?? 'reopened from the board', { now: op.time });
    case 'move':
      return moveTicket(tickets, op.ticketId, op.to, 'user', op.note, { now: op.time });
  }
}

export function normalizeTickets(value: unknown): Ticket[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (t): t is Ticket =>
      !!t &&
      typeof t === 'object' &&
      typeof (t as Ticket).id === 'string' &&
      typeof (t as Ticket).title === 'string' &&
      (TICKET_STATUSES as readonly string[]).includes((t as Ticket).status),
  ).map((t) => ({
    ...t,
    acceptance: Array.isArray(t.acceptance) ? t.acceptance : [],
    history: Array.isArray(t.history) ? t.history : [],
    comments: Array.isArray(t.comments) ? t.comments : [],
    assignee: t.assignee ?? null,
  }));
}

// ── Whiteboard ──────────────────────────────────────────────────────

export interface BoardBrief {
  text: string;
  updatedAt: string;
}

export interface BoardPlan {
  text: string;
  updatedAt: string;
  /** Member id of the author, normally the planner. */
  by: string;
  status: 'drafting' | 'final';
}

export interface BoardState {
  brief?: BoardBrief;
  plan?: BoardPlan;
}

export function normalizeBoard(value: unknown): BoardState {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const board: BoardState = {};
  const brief = raw.brief as BoardBrief | undefined;
  if (brief && typeof brief.text === 'string') board.brief = { text: brief.text, updatedAt: String(brief.updatedAt ?? '') };
  const plan = raw.plan as BoardPlan | undefined;
  if (plan && typeof plan.text === 'string') {
    board.plan = {
      text: plan.text,
      updatedAt: String(plan.updatedAt ?? ''),
      by: String(plan.by ?? ''),
      status: plan.status === 'final' ? 'final' : 'drafting',
    };
  }
  return board;
}

// ── Event payloads ───────────────────────────────────────────────────

/**
 * Structured detail carried on the new workflow events (`ticket_created`,
 * `ticket_moved`, `ticket_assigned`, `call_member`, `qa_question`,
 * `qa_answer`, `board_write`). The 3D director reads these to choreograph who
 * walks where, so they are JSON rather than prose.
 */
export interface WorkflowDetail {
  ticketId?: string;
  from?: string;
  to?: string;
  /** The member being called, asked or answered. */
  target?: string;
}

export function encodeWorkflowDetail(detail: WorkflowDetail): string {
  return JSON.stringify(detail);
}

export function decodeWorkflowDetail(detail: string | undefined): WorkflowDetail {
  if (!detail) return {};
  try {
    const parsed = JSON.parse(detail);
    return parsed && typeof parsed === 'object' ? (parsed as WorkflowDetail) : {};
  } catch {
    return {};
  }
}

export const WORKFLOW_EVENT_TYPES = [
  'ticket_created',
  'ticket_moved',
  'ticket_assigned',
  'board_write',
  'call_member',
  'qa_question',
  'qa_answer',
] as const;
