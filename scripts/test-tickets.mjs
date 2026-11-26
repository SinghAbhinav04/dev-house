import assert from 'node:assert/strict';

import {
  BOARD_COLUMNS,
  TICKET_STATUSES,
  TicketTransitionError,
  activeTicketFor,
  applyTicketOp,
  assignTicket,
  canTransition,
  childBugs,
  commentTicket,
  createTicket,
  decodeWorkflowDetail,
  encodeWorkflowDetail,
  isTicketOp,
  moveTicket,
  nextTicketId,
  normalizeBoard,
  normalizeTickets,
  ticketsInColumn,
} from '../src/lib/tickets.ts';

const T0 = '2026-11-26T10:00:00.000Z';
const T1 = '2026-11-26T10:05:00.000Z';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test('ids increase and survive gaps', () => {
  assert.equal(nextTicketId([]), 'DH-1');
  let { tickets } = createTicket([], { type: 'story', title: 'A', reporter: 'planner' }, T0);
  ({ tickets } = createTicket(tickets, { type: 'story', title: 'B', reporter: 'planner' }, T0));
  assert.deepEqual(tickets.map((t) => t.id), ['DH-1', 'DH-2']);
  const gapped = [{ ...tickets[0], id: 'DH-7' }];
  assert.equal(nextTicketId(gapped), 'DH-8');
});

test('create records a history entry and clips long input', () => {
  const { ticket } = createTicket([], {
    type: 'bug',
    title: 'x'.repeat(500),
    reporter: 'tester',
    status: 'todo',
    assignee: 'coder',
    acceptance: ['one', '', 'two'],
  }, T0);
  assert.equal(ticket.status, 'todo');
  assert.equal(ticket.assignee, 'coder');
  assert.ok(ticket.title.length <= 140);
  assert.deepEqual(ticket.acceptance, ['one', 'two']);
  assert.deepEqual(ticket.history, [{ time: T0, by: 'tester', to: 'todo', note: 'created' }]);
});

test('legal moves append history; illegal ones are ignored or thrown', () => {
  let { tickets } = createTicket([], { type: 'story', title: 'A', reporter: 'planner', status: 'todo' }, T0);
  tickets = moveTicket(tickets, 'DH-1', 'in-progress', 'coder', 'starting', { now: T1 });
  assert.equal(tickets[0].status, 'in-progress');
  assert.deepEqual(tickets[0].history.at(-1), { time: T1, by: 'coder', from: 'todo', to: 'in-progress', note: 'starting' });

  tickets = moveTicket(tickets, 'DH-1', 'done', 'tester', undefined, { now: T1 });
  const before = tickets;
  // done → in-qa is not a legal move.
  tickets = moveTicket(tickets, 'DH-1', 'in-qa', 'tester', undefined, { now: T1 });
  assert.equal(tickets, before, 'an ignored move returns the same array');
  assert.throws(
    () => moveTicket(tickets, 'DH-1', 'in-qa', 'tester', undefined, { strict: true }),
    TicketTransitionError,
  );
  // Moving to the current status is a no-op, not an error.
  assert.equal(moveTicket(tickets, 'DH-1', 'done', 'x', undefined, { strict: true }), tickets);
});

test('every status has a column and transitions never self-loop', () => {
  for (const status of TICKET_STATUSES) {
    assert.ok(BOARD_COLUMNS.some((c) => c.statuses.includes(status)), `${status} has a column`);
    assert.equal(canTransition(status, status), false);
  }
});

test('assign and comment', () => {
  let { tickets } = createTicket([], { type: 'task', title: 'A', reporter: 'planner' }, T0);
  tickets = assignTicket(tickets, 'DH-1', 'coder', 'planner', T1);
  assert.equal(tickets[0].assignee, 'coder');
  assert.equal(tickets[0].history.at(-1).note, 'assigned to coder');
  assert.equal(assignTicket(tickets, 'DH-1', 'coder', 'planner', T1), tickets, 'same assignee is a no-op');
  tickets = commentTicket(tickets, 'DH-1', 'user', '  looks good  ', T1);
  assert.deepEqual(tickets[0].comments, [{ time: T1, by: 'user', text: 'looks good' }]);
  assert.equal(commentTicket(tickets, 'DH-1', 'user', '   ', T1), tickets, 'empty comment is dropped');
});

test('bugs link to stories and columns group statuses', () => {
  let { tickets } = createTicket([], { type: 'story', title: 'S', reporter: 'planner', status: 'in-qa' }, T0);
  ({ tickets } = createTicket(tickets, { type: 'bug', title: 'B', reporter: 'tester', parentId: 'DH-1', status: 'todo' }, T0));
  ({ tickets } = createTicket(tickets, { type: 'bug', title: 'B2', reporter: 'tester', parentId: 'DH-1', status: 'blocked' }, T0));
  assert.deepEqual(childBugs(tickets, 'DH-1').map((t) => t.id), ['DH-2', 'DH-3']);
  assert.deepEqual(ticketsInColumn(tickets, 'todo').map((t) => t.id), ['DH-2']);
  assert.deepEqual(ticketsInColumn(tickets, 'stuck').map((t) => t.id), ['DH-3']);
  assert.deepEqual(ticketsInColumn(tickets, 'nope'), []);
});

test('active ticket prefers in-progress work', () => {
  let { tickets } = createTicket([], { type: 'story', title: 'A', reporter: 'p', assignee: 'coder', status: 'todo' }, T0);
  ({ tickets } = createTicket(tickets, { type: 'story', title: 'B', reporter: 'p', assignee: 'coder', status: 'in-progress' }, T0));
  ({ tickets } = createTicket(tickets, { type: 'story', title: 'C', reporter: 'p', assignee: 'coder', status: 'done' }, T0));
  assert.equal(activeTicketFor(tickets, 'coder')?.id, 'DH-2');
  assert.equal(activeTicketFor(tickets, 'tester'), undefined);
  assert.equal(activeTicketFor(undefined, 'coder'), undefined);
});

test('user ops validate and apply', () => {
  assert.equal(isTicketOp({ kind: 'comment', ticketId: 'DH-1', text: 'hi', time: T1 }), true);
  assert.equal(isTicketOp({ kind: 'comment', ticketId: 'DH-1', text: '  ', time: T1 }), false);
  assert.equal(isTicketOp({ kind: 'move', ticketId: 'DH-1', to: 'nowhere', time: T1 }), false);
  assert.equal(isTicketOp({ kind: 'delete', ticketId: 'DH-1', time: T1 }), false);
  assert.equal(isTicketOp(null), false);

  let { tickets } = createTicket([], { type: 'story', title: 'A', reporter: 'p', status: 'in-qa' }, T0);
  tickets = applyTicketOp(tickets, { kind: 'reject', ticketId: 'DH-1', note: 'wrong colour', time: T1 });
  assert.equal(tickets[0].status, 'rejected');
  assert.equal(tickets[0].history.at(-1).by, 'user');
  assert.equal(tickets[0].comments.at(-1).text, 'wrong colour');
  tickets = applyTicketOp(tickets, { kind: 'reopen', ticketId: 'DH-1', time: T1 });
  assert.equal(tickets[0].status, 'todo');
  // An op against a ticket that no longer exists is harmless.
  assert.equal(applyTicketOp(tickets, { kind: 'reopen', ticketId: 'DH-99', time: T1 }), tickets);
});

test('normalisers tolerate junk from disk', () => {
  assert.deepEqual(normalizeTickets(undefined), []);
  assert.deepEqual(normalizeTickets([null, { id: 'DH-1' }, { id: 'DH-2', title: 'x', status: 'bogus' }]), []);
  const ok = normalizeTickets([{ id: 'DH-1', title: 'x', status: 'todo' }]);
  assert.deepEqual(ok[0].history, []);
  assert.equal(ok[0].assignee, null);

  assert.deepEqual(normalizeBoard(null), {});
  assert.deepEqual(normalizeBoard({ brief: { text: 'hi', updatedAt: T0 }, plan: { text: 'p', status: 'weird' } }), {
    brief: { text: 'hi', updatedAt: T0 },
    plan: { text: 'p', updatedAt: '', by: '', status: 'drafting' },
  });
});

test('workflow detail round-trips and tolerates prose', () => {
  assert.deepEqual(decodeWorkflowDetail(encodeWorkflowDetail({ ticketId: 'DH-1', target: 'coder' })), { ticketId: 'DH-1', target: 'coder' });
  assert.deepEqual(decodeWorkflowDetail('not json'), {});
  assert.deepEqual(decodeWorkflowDetail(undefined), {});
});

console.log(`\n${passed} ticket tests passed`);
