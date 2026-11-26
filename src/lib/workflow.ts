/**
 * The team workflow the orchestrator runs on top of its phases: the way a real
 * team works a Jira or Azure DevOps board.
 *
 *   1. The user writes a brief on the whiteboard. The planner reads it first.
 *   2. The planner drafts the plan on the board as it thinks (plan.md is
 *      mirrored onto the board while it is being written).
 *   3. The plan is a story in Solutioning while the reviewer questions it.
 *   4. Once approved, the planner breaks it into tickets and calls each
 *      teammate over to assign them their work.
 *   5. The coder works ticket by ticket: To Do → In Progress → In Review.
 *   6. Before testing, QA asks the coder what it needs to know, and gets real
 *      answers from the coder's own session.
 *   7. QA tests. Each failure is a bug ticket assigned back to the coder; a
 *      story that fails QA is rejected back to In Progress. Passing moves
 *      everything to Done.
 *
 * Everything here is pure or works through a small `WorkflowHost`, so the
 * orchestrator keeps its control flow and this file holds the rules. Tested in
 * scripts/test-workflow.mjs.
 */

import {
  assignTicket,
  commentTicket,
  createTicket,
  encodeWorkflowDetail,
  findTicket,
  isClosed,
  moveTicket,
  TICKET_STATUS_LABELS,
  type BoardState,
  type NewTicket,
  type Ticket,
  type TicketPriority,
  type TicketStatus,
  type TicketType,
  cleanTags,
} from './tickets.ts';

export interface WorkflowHost {
  tickets: Ticket[];
  board: BoardState;
  emit(agent: string, phase: string, type: string, text: string, detail?: string): void;
  phase(): string;
}

// ── Ticket operations that narrate themselves ─────────────────────────

export function openTicket(host: WorkflowHost, input: NewTicket): Ticket {
  const { tickets, ticket } = createTicket(host.tickets, input);
  host.tickets = tickets;
  host.emit(
    input.reporter,
    host.phase(),
    'ticket_created',
    `${ticket.id} created: ${ticket.title}`,
    encodeWorkflowDetail({ ticketId: ticket.id, to: ticket.status, target: ticket.assignee ?? undefined }),
  );
  return ticket;
}

export function move(host: WorkflowHost, ticketId: string, to: TicketStatus, by: string, note?: string): boolean {
  const before = findTicket(host.tickets, ticketId);
  if (!before || before.status === to) return false;
  const next = moveTicket(host.tickets, ticketId, to, by, note);
  if (next === host.tickets) return false;
  host.tickets = next;
  host.emit(
    by,
    host.phase(),
    'ticket_moved',
    `${ticketId}: ${statusWords(before.status)} → ${statusWords(to)}${note ? ` (${note})` : ''}`,
    encodeWorkflowDetail({ ticketId, from: before.status, to, target: before.assignee ?? undefined }),
  );
  return true;
}

export function assign(host: WorkflowHost, ticketId: string, assignee: string, by: string, assigneeName: string): void {
  const next = assignTicket(host.tickets, ticketId, assignee, by);
  if (next === host.tickets) return;
  host.tickets = next;
  const ticket = findTicket(host.tickets, ticketId);
  host.emit(
    by,
    host.phase(),
    'ticket_assigned',
    `${ticketId} assigned to ${assigneeName}${ticket ? `: ${ticket.title}` : ''}`,
    encodeWorkflowDetail({ ticketId, target: assignee }),
  );
}

export function comment(host: WorkflowHost, ticketId: string, by: string, text: string): void {
  host.tickets = commentTicket(host.tickets, ticketId, by, text);
}

function statusWords(status: TicketStatus): string {
  return TICKET_STATUS_LABELS[status] ?? status;
}

/** The open tickets assigned to a member, in the order they were created. */
export function workQueue(tickets: readonly Ticket[], memberId: string, types: TicketType[] = ['story', 'task']): Ticket[] {
  return tickets.filter((t) => t.assignee === memberId && types.includes(t.type) && !isClosed(t.status));
}

// ── The whiteboard ───────────────────────────────────────────────────

/** Cap on how much of the plan is mirrored onto the board per update. */
export const BOARD_PLAN_MAX = 12_000;

export function setBoardPlan(host: WorkflowHost, text: string, by: string, status: 'drafting' | 'final'): boolean {
  const clipped = text.length > BOARD_PLAN_MAX ? `${text.slice(0, BOARD_PLAN_MAX)}\n…` : text;
  const current = host.board.plan;
  if (current && current.text === clipped && current.status === status) return false;
  host.board = { ...host.board, plan: { text: clipped, updatedAt: new Date().toISOString(), by, status } };
  return true;
}

/** How the whiteboard brief is put in front of the planner. */
export function briefForPlanner(board: BoardState | undefined): string {
  const brief = board?.brief?.text?.trim();
  if (!brief) return '';
  return [
    'The user wrote this brief on the studio whiteboard. Read it first — it is what they want built, in their own words:',
    '',
    '<<<WHITEBOARD',
    brief,
    'WHITEBOARD>>>',
    '',
  ].join('\n');
}

/**
 * Added to the planner's write step so the plan appears on the board while it
 * is being thought through, the way a person sketches an outline on a
 * whiteboard before filling it in — not all at once at the end.
 */
export const OUTLINE_FIRST_INSTRUCTION = [
  'Your plan is shown live on the team whiteboard while you write it, so work the way you would at a whiteboard:',
  '1. First, Write plan.md with just the outline: a title, the goal in one line, and every section heading with one line saying what it will cover.',
  '2. Then fill in the sections one at a time with Edit, most important first.',
].join('\n');

// ── The team, as the planner sees it ─────────────────────────────────

export interface TeamSeat {
  slot: string;
  /** Null when nobody fills the seat this run. */
  name: string | null;
  title?: string;
  model?: string;
}

const SEAT_DUTIES: Record<string, string> = {
  planner: 'writes the plan and breaks it into tickets',
  reviewer: "reviews the plan, then reviews each ticket's branch like a pull request",
  coder: 'builds the tickets, one branch per ticket',
  tester: 'asks the coder how to run it, tests every ticket and files bugs',
  auditor: 'audits the build for security issues',
  supervisor: 'watches the run and reports to the user',
};

/** The roster as a short markdown list, empty seats included, so the plan fits the team that exists. */
export function describeTeam(seats: readonly TeamSeat[]): string {
  return seats
    .map((seat) => {
      const duty = SEAT_DUTIES[seat.slot] ?? '';
      if (!seat.name) return `- ${seat.slot}: nobody this run — that step is skipped`;
      const who = [seat.name, seat.title, seat.model].filter(Boolean).join(', ');
      return `- ${seat.slot}: ${who} — ${duty}`;
    })
    .join('\n');
}

/** Asked of the plan: who on the team does what, in order, with estimates. */
export function teamSectionInstruction(team: string): string {
  return [
    'Your team for this run:',
    team,
    '',
    'plan.md must have a "## Team and tasks" section after the goal: for each member above who has a seat, the tasks they own in build order, each with a rough estimate in minutes of agent time and its priority (P1–P3). Building goes to the coder; dedicated test work (a test plan, a harness) to the tester. Say what the reviewer and auditor will check. Nobody without a seat gets work.',
  ].join('\n');
}

// ── Breakdown: plan → tickets ────────────────────────────────────────

export const MAX_BREAKDOWN_TICKETS = 8;

// Every schema carries a `status`, like the gate verdicts: the structured
// output channel, the text fallback and the one-shot retry for an unreadable
// answer all key on it (src/lib/pipeline-signal.ts).

export const BREAKDOWN_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ready'] },
    tickets: {
      type: 'array',
      maxItems: MAX_BREAKDOWN_TICKETS,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          acceptance: { type: 'array', items: { type: 'string' } },
          type: { type: 'string', enum: ['story', 'task'] },
          assignee: { type: 'string', enum: ['coder', 'tester'] },
          priority: { type: 'string', enum: ['p1', 'p2', 'p3'] },
          estimateMinutes: { type: 'number' },
          tags: { type: 'array', items: { type: 'string' }, maxItems: 4 },
        },
        required: ['title', 'assignee'],
      },
    },
  },
  required: ['status', 'tickets'],
};

export interface BreakdownItem {
  title: string;
  description: string;
  acceptance: string[];
  type: 'story' | 'task';
  assignee: 'coder' | 'tester';
  priority: TicketPriority;
  estimateMinutes?: number;
  tags: string[];
}

export function buildBreakdownPrompt(planPath: string, team?: string): string {
  return [
    `The plan at ${planPath} is approved. Break it into tickets for the team, the way a lead would on an Azure DevOps board.`,
    '',
    ...(team ? ['The team (only members with a seat can be given work):', team, ''] : []),
    `- At most ${MAX_BREAKDOWN_TICKETS} tickets, in the order they should be built.`,
    '- Each is a piece of work someone can finish and show: a story for user-visible behaviour, a task for setup or plumbing.',
    '- "assignee" is "coder" for building and "tester" only for dedicated test work (a test harness, a test plan).',
    '- Follow the "Team and tasks" section of the plan when it has one.',
    '- Give each 1–4 acceptance criteria a tester could check, an estimate in minutes of agent time, and 1–4 short tags ("ui", "storage", "drag-drop").',
    '- The description says what to build and where, in a few sentences; markdown is fine.',
    '- Do not change plan.md.',
    '',
    'Respond with ONLY a JSON object: {"status": "ready", "tickets": [{"title": "...", "description": "...", "acceptance": ["..."], "type": "story", "assignee": "coder", "priority": "p1", "estimateMinutes": 20, "tags": ["ui"]}]}',
  ].join('\n');
}

/** Read a breakdown leniently; an unusable one yields [] and the caller falls back. */
export function parseBreakdown(value: unknown): BreakdownItem[] {
  const raw = value && typeof value === 'object' ? (value as { tickets?: unknown }).tickets : undefined;
  if (!Array.isArray(raw)) return [];
  const items: BreakdownItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const title = typeof e.title === 'string' ? e.title.trim() : '';
    if (!title) continue;
    items.push({
      title,
      description: typeof e.description === 'string' ? e.description : '',
      acceptance: Array.isArray(e.acceptance) ? e.acceptance.filter((a): a is string => typeof a === 'string') : [],
      type: e.type === 'task' ? 'task' : 'story',
      assignee: e.assignee === 'tester' ? 'tester' : 'coder',
      priority: e.priority === 'p1' || e.priority === 'p3' ? e.priority : 'p2',
      ...(typeof e.estimateMinutes === 'number' && e.estimateMinutes > 0
        ? { estimateMinutes: Math.min(Math.round(e.estimateMinutes), 24 * 60) }
        : {}),
      tags: Array.isArray(e.tags) ? cleanTags(e.tags) : [],
    });
    if (items.length >= MAX_BREAKDOWN_TICKETS) break;
  }
  return items;
}

export function fallbackBreakdown(concept: string): BreakdownItem[] {
  return [
    {
      title: `Implement the approved plan${concept ? `: ${concept.slice(0, 80)}` : ''}`,
      description: 'Build everything plan.md describes.',
      acceptance: ['Every file and behaviour in plan.md exists and works'],
      type: 'story',
      assignee: 'coder',
      priority: 'p1',
      tags: [],
    },
  ];
}

// ── Coding, ticket by ticket ─────────────────────────────────────────

export function buildTicketPrompt(ticket: Ticket, planPath: string, first: boolean, remaining: number): string {
  const lines = first
    ? [
        `Read the approved plan at ${planPath}`,
        'Build exactly what it says. Do not improvise, do not "improve", do not modify plan.md — it is locked.',
        'Do NOT use the Agent tool. Do NOT spawn sub-agents. Build everything yourself.',
        '',
        `The work is split into tickets. You are on ${ticket.id} now${remaining > 0 ? `; ${remaining} more will follow` : ''}.`,
      ]
    : [`Next ticket: ${ticket.id}. Keep everything you built for earlier tickets working.`];
  return [
    ...lines,
    '',
    `${ticket.id} — ${ticket.title}`,
    ticket.description ? `\n${ticket.description}` : '',
    ticket.acceptance.length ? `\nAcceptance criteria:\n${ticket.acceptance.map((a) => `- ${a}`).join('\n')}` : '',
    '',
    `When ${ticket.id} is done, say what you built for it in two or three sentences.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

// ── Dev ↔ QA ─────────────────────────────────────────────────────────

export const MAX_QA_QUESTIONS = 3;

export const QA_QUESTIONS_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['asked', 'none'] },
    questions: { type: 'array', maxItems: MAX_QA_QUESTIONS, items: { type: 'string' } },
  },
  required: ['status', 'questions'],
};

export const QA_ANSWERS_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['answered'] },
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: { question: { type: 'string' }, answer: { type: 'string' } },
        required: ['question', 'answer'],
      },
    },
  },
  required: ['status', 'answers'],
};

export function buildQaQuestionsPrompt(planPath: string, tickets: readonly Ticket[]): string {
  return [
    'You are about to test the build. Before you start, walk over to the coder and ask what you need to know — the way QA does with a dev before a test pass.',
    `The plan is at ${planPath}. The tickets in this build are:`,
    ...tickets.map((t) => `- ${t.id}: ${t.title}`),
    '',
    `Ask at most ${MAX_QA_QUESTIONS} short, specific questions: how to run or serve it, what changed, edge cases or known gaps they are worried about.`,
    'Ask nothing you can answer by reading the plan yourself. If you need nothing, return an empty list.',
    '',
    'Respond with ONLY a JSON object: {"status": "asked", "questions": ["..."]}, or {"status": "none", "questions": []} if you need nothing.',
  ].join('\n');
}

export function buildQaAnswersPrompt(questions: readonly string[], testerName: string): string {
  return [
    `${testerName} (QA) is at your desk before testing your work and asks:`,
    '',
    ...questions.map((q, i) => `${i + 1}. ${q}`),
    '',
    'Answer each one briefly and truthfully from what you actually built. If something is not done or not working, say so — QA will find it anyway.',
    'Do not change any code in this turn.',
    '',
    'Respond with ONLY a JSON object: {"status": "answered", "answers": [{"question": "...", "answer": "..."}]}',
  ].join('\n');
}

export function parseQuestions(value: unknown): string[] {
  const raw = value && typeof value === 'object' ? (value as { questions?: unknown }).questions : undefined;
  if (!Array.isArray(raw)) return [];
  return raw.filter((q): q is string => typeof q === 'string' && q.trim().length > 0).map((q) => q.trim()).slice(0, MAX_QA_QUESTIONS);
}

export function parseAnswers(value: unknown, questions: readonly string[]): { question: string; answer: string }[] {
  const raw = value && typeof value === 'object' ? (value as { answers?: unknown }).answers : undefined;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry, index) => {
      const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
      return {
        question: typeof e.question === 'string' && e.question.trim() ? e.question.trim() : questions[index] ?? '',
        answer: typeof e.answer === 'string' ? e.answer.trim() : '',
      };
    })
    .filter((qa) => qa.answer.length > 0);
}

export function qaBriefing(answers: readonly { question: string; answer: string }[]): string {
  if (answers.length === 0) return '';
  return [
    'Before this test pass you asked the coder some questions. Their answers:',
    ...answers.map((qa) => `- Q: ${qa.question}\n  A: ${qa.answer}`),
    '',
  ].join('\n');
}

// ── Bugs ─────────────────────────────────────────────────────────────

/** Short ticket title from a free-text finding. */
export function bugTitle(text: string): string {
  const firstSentence = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] ?? text;
  return firstSentence.length > 100 ? `${firstSentence.slice(0, 99)}…` : firstSentence;
}

export function fileBugs(
  host: WorkflowHost,
  findings: readonly string[],
  opts: { reporter: string; assignee: string; assigneeName: string; parentId?: string; source: 'code review' | 'QA' },
): Ticket[] {
  const filed: Ticket[] = [];
  for (const finding of findings) {
    const ticket = openTicket(host, {
      type: 'bug',
      title: bugTitle(finding),
      description: `Found in ${opts.source}:\n\n${finding}`,
      reporter: opts.reporter,
      parentId: opts.parentId,
      priority: opts.source === 'QA' ? 'p1' : 'p2',
      status: 'todo',
    });
    assign(host, ticket.id, opts.assignee, opts.reporter, opts.assigneeName);
    filed.push(ticket);
  }
  return filed;
}

// ── Security findings ────────────────────────────────────────────────

const SEVERITY_PRIORITY: Record<string, TicketPriority> = { critical: 'p1', high: 'p1', medium: 'p2', low: 'p3' };

export function securityPriority(severity: string): TicketPriority {
  return SEVERITY_PRIORITY[severity] ?? 'p2';
}

/** Where a security ticket belongs for each audit finding status. */
export function securityStatusFor(findingStatus: string): TicketStatus {
  switch (findingStatus) {
    case 'sent-to-c':
      return 'in-progress';
    case 're-auditing':
      return 'in-review';
    // A fix the re-audit did not accept goes back to the developer.
    case 'still-open':
      return 'in-progress';
    case 'resolved':
      return 'done';
    case 'dismissed':
      return 'rejected';
    default:
      return 'todo';
  }
}
