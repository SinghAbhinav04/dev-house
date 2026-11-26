import assert from 'node:assert/strict';

import {
  BREAKDOWN_SCHEMA,
  MAX_BREAKDOWN_TICKETS,
  assign,
  briefForPlanner,
  bugTitle,
  buildQaAnswersPrompt,
  buildTicketPrompt,
  fallbackBreakdown,
  fileBugs,
  move,
  openTicket,
  parseAnswers,
  parseBreakdown,
  parseQuestions,
  qaBriefing,
  securityStatusFor,
  setBoardPlan,
  workQueue,
} from '../src/lib/workflow.ts';
import { decodeWorkflowDetail } from '../src/lib/tickets.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function makeHost() {
  const events = [];
  const host = {
    tickets: [],
    board: {},
    phase: () => 'coding',
    emit: (agent, phase, type, text, detail) => events.push({ agent, phase, type, text, detail }),
  };
  return { host, events };
}

test('opening, assigning and moving a ticket narrates each step for the scene', () => {
  const { host, events } = makeHost();
  const t = openTicket(host, { type: 'story', title: 'Login form', reporter: 'pat', status: 'todo' });
  assign(host, t.id, 'reacty', 'pat', 'Reacty');
  assert.equal(move(host, t.id, 'in-progress', 'reacty'), true);
  assert.equal(move(host, t.id, 'in-progress', 'reacty'), false, 'no event for a no-op move');
  assert.equal(move(host, 'DH-404', 'done', 'reacty'), false);

  assert.deepEqual(events.map((e) => e.type), ['ticket_created', 'ticket_assigned', 'ticket_moved']);
  assert.deepEqual(decodeWorkflowDetail(events[1].detail), { ticketId: 'DH-1', target: 'reacty' });
  assert.deepEqual(decodeWorkflowDetail(events[2].detail), { ticketId: 'DH-1', from: 'todo', to: 'in-progress', target: 'reacty' });
  assert.match(events[2].text, /To Do → In Progress/);
});

test('work queue lists a member’s open stories and tasks in order', () => {
  const { host } = makeHost();
  const a = openTicket(host, { type: 'story', title: 'A', reporter: 'pat', assignee: 'reacty', status: 'todo' });
  openTicket(host, { type: 'bug', title: 'B', reporter: 'tess', assignee: 'reacty', status: 'todo' });
  const c = openTicket(host, { type: 'task', title: 'C', reporter: 'pat', assignee: 'reacty', status: 'todo' });
  openTicket(host, { type: 'story', title: 'D', reporter: 'pat', assignee: 'tess', status: 'todo' });
  move(host, a.id, 'in-progress', 'reacty');
  move(host, a.id, 'done', 'reacty');
  assert.deepEqual(workQueue(host.tickets, 'reacty').map((t) => t.id), [c.id]);
});

test('breakdown parsing is lenient and capped', () => {
  assert.equal(BREAKDOWN_SCHEMA.properties.tickets.maxItems, MAX_BREAKDOWN_TICKETS);
  assert.deepEqual(parseBreakdown(null), []);
  assert.deepEqual(parseBreakdown({ tickets: 'nope' }), []);
  const items = parseBreakdown({
    tickets: [
      { title: '  Board UI ', assignee: 'coder' },
      { title: '', assignee: 'coder' },
      { title: 'Test plan', assignee: 'tester', type: 'task', priority: 'p1', acceptance: ['x', 3] },
      ...Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, assignee: 'wizard' })),
    ],
  });
  assert.equal(items.length, MAX_BREAKDOWN_TICKETS);
  assert.deepEqual(items[0], { title: 'Board UI', description: '', acceptance: [], type: 'story', assignee: 'coder', priority: 'p2', tags: [] });
  assert.deepEqual(items[1].acceptance, ['x']);
  assert.equal(items[1].assignee, 'tester');
  assert.equal(items[2].assignee, 'coder', 'an unknown assignee falls back to the coder');
  assert.equal(fallbackBreakdown('A todo app').length, 1);
});

test('ticket prompts carry the ticket and, first time, the build rules', () => {
  const { host } = makeHost();
  const t = openTicket(host, { type: 'story', title: 'Board UI', description: 'Kanban', acceptance: ['drag works'], reporter: 'pat' });
  const first = buildTicketPrompt(t, '/p/plan.md', true, 2);
  assert.match(first, /Read the approved plan at \/p\/plan\.md/);
  assert.match(first, /DH-1 — Board UI/);
  assert.match(first, /- drag works/);
  assert.match(first, /2 more will follow/);
  const later = buildTicketPrompt(t, '/p/plan.md', false, 0);
  assert.doesNotMatch(later, /Read the approved plan/);
  assert.match(later, /Next ticket: DH-1/);
});

test('QA questions and answers survive sloppy output', () => {
  assert.deepEqual(parseQuestions({ questions: ['  how do I run it? ', '', 7, 'a', 'b', 'c'] }), ['how do I run it?', 'a', 'b']);
  assert.deepEqual(parseQuestions(undefined), []);
  const answers = parseAnswers({ answers: [{ answer: 'npm start' }, { question: 'Edge?', answer: '' }] }, ['How to run?']);
  assert.deepEqual(answers, [{ question: 'How to run?', answer: 'npm start' }]);
  assert.match(qaBriefing(answers), /Q: How to run\?\n {2}A: npm start/);
  assert.equal(qaBriefing([]), '');
  assert.match(buildQaAnswersPrompt(['How to run?'], 'Tess'), /Tess \(QA\) is at your desk/);
});

test('bugs are filed as To Do tickets assigned back to the coder', () => {
  const { host, events } = makeHost();
  const story = openTicket(host, { type: 'story', title: 'S', reporter: 'pat' });
  const bugs = fileBugs(host, ['Clicking save does nothing. The handler is never attached.'], {
    reporter: 'tess', assignee: 'reacty', assigneeName: 'Reacty', parentId: story.id, source: 'QA',
  });
  assert.equal(bugs.length, 1);
  const bug = host.tickets.find((t) => t.id === bugs[0].id);
  assert.equal(bug.type, 'bug');
  assert.equal(bug.status, 'todo');
  assert.equal(bug.assignee, 'reacty');
  assert.equal(bug.parentId, story.id);
  assert.equal(bug.priority, 'p1');
  assert.equal(bug.title, 'Clicking save does nothing.');
  assert.ok(events.some((e) => e.type === 'ticket_assigned' && e.agent === 'tess'));
  assert.ok(bugTitle('x'.repeat(300)).length <= 100);
});

test('the whiteboard mirrors the plan and the brief reaches the planner', () => {
  const { host } = makeHost();
  assert.equal(setBoardPlan(host, '# Plan', 'pat', 'drafting'), true);
  assert.equal(setBoardPlan(host, '# Plan', 'pat', 'drafting'), false, 'unchanged text is not a new write');
  assert.equal(setBoardPlan(host, '# Plan', 'pat', 'final'), true, 'finalising is');
  assert.equal(host.board.plan.status, 'final');
  assert.equal(briefForPlanner({}), '');
  assert.match(briefForPlanner({ brief: { text: 'A kanban app', updatedAt: '' } }), /WHITEBOARD\nA kanban app\nWHITEBOARD/);
});

test('security tickets follow the audit finding', () => {
  assert.equal(securityStatusFor('open'), 'todo');
  assert.equal(securityStatusFor('sent-to-c'), 'in-progress');
  assert.equal(securityStatusFor('re-auditing'), 'in-review');
  assert.equal(securityStatusFor('resolved'), 'done');
  assert.equal(securityStatusFor('dismissed'), 'rejected');
  assert.equal(securityStatusFor('still-open'), 'in-progress');
});

console.log(`\n${passed} workflow tests passed`);
