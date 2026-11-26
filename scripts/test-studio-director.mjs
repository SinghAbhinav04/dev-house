import assert from 'node:assert/strict';

import { MAX_QUEUE, SAY_MAX, createDirector, directionsFor, ingest, nextDirection } from '../src/lib/studio-director.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const team = new Set(['planner', 'coder', 'tester']);
const isMember = (id) => team.has(id);
let clock = 0;
const ev = (agent, type, text, extra = {}) => ({ time: new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)).toISOString(), agent, type, text, ...extra });
const to = (target) => JSON.stringify({ target });

test('history on first look is not replayed', () => {
  let state = createDirector();
  state = ingest(state, [ev('planner', 'board_write', 'Writing the plan')], isMember);
  assert.equal(nextDirection(state, 'planner').direction, undefined);
  state = ingest(state, [ev('planner', 'board_write', 'Writing the plan (3 sections)')], isMember);
  assert.equal(nextDirection(state, 'planner').direction.spot.kind, 'board');
});

test('an empty run still arms the director', () => {
  let state = ingest(createDirector(), [], isMember);
  state = ingest(state, [ev('planner', 'board_write', 'Writing')], isMember);
  assert.ok(nextDirection(state, 'planner').direction);
});

test('the same event is staged once', () => {
  let state = ingest(createDirector(), [], isMember);
  const e = ev('planner', 'board_write', 'x');
  state = ingest(state, [e], isMember);
  state = ingest(state, [e], isMember);
  assert.equal(state.queues.planner.length, 1);
});

test('a hand-off: called over, told, and back to the desk', () => {
  let state = ingest(createDirector(), [], isMember);
  state = ingest(
    state,
    [
      ev('planner', 'call_member', 'Planner calls Coder over', { detail: to('coder') }),
      ev('planner', 'text', 'DH-2 is yours, Coder: Board UI', { detail: to('coder') }),
      ev('coder', 'text', 'On it — DH-2.', { detail: to('planner') }),
    ],
    isMember,
  );
  assert.deepEqual(state.queues.coder.map((d) => d.spot?.kind ?? 'say'), ['member', 'say', 'desk']);
  assert.equal(state.queues.coder[0].spot.memberId, 'planner');
  assert.equal(state.queues.planner[1].waitFor, 'coder', 'the hand-off waits for the coder to arrive');
  assert.equal(state.queues.planner.length, 2);
});

test('QA walks over to the coder; the coder stays put', () => {
  const dirs = directionsFor(
    ev('tester', 'call_member', 'Tester heads over', { detail: JSON.stringify({ target: 'coder', visit: true }) }),
    isMember,
  );
  assert.equal(dirs.length, 1);
  assert.equal(dirs[0].actor, 'tester');
  assert.deepEqual(dirs[0].spot, { kind: 'member', memberId: 'coder' });
  const q = directionsFor(ev('tester', 'qa_question', 'How do I run it?'), isMember);
  assert.equal(q[0].say, 'How do I run it?');
  assert.equal(q[0].spot, undefined);
});

test('free-form thinking does not get a bubble; strangers are ignored', () => {
  assert.deepEqual(directionsFor(ev('coder', 'text', 'Let me look at the files'), isMember), []);
  assert.deepEqual(directionsFor(ev('user', 'board_write', 'Wrote the brief'), isMember), []);
  assert.deepEqual(directionsFor(ev('system', 'call_member', 'x', { detail: to('coder') }), isMember), []);
});

test('bugs filed in review and QA are announced, breakdown tickets are not', () => {
  assert.equal(directionsFor(ev('tester', 'ticket_created', 'DH-5 created: Badge never updates', { phase: 'testing' }), isMember).length, 1);
  assert.equal(directionsFor(ev('planner', 'ticket_created', 'DH-2 created: Board UI', { phase: 'coding' }), isMember).length, 0);
});

test('a queue that falls behind keeps only the latest steps', () => {
  let state = ingest(createDirector(), [], isMember);
  const burst = Array.from({ length: 10 }, (_, i) => ev('planner', 'board_write', `w${i}`));
  state = ingest(state, burst, isMember);
  assert.equal(state.queues.planner.length, MAX_QUEUE);
  assert.match(state.queues.planner.at(-1).say, /w9/);
});

test('speech is clipped', () => {
  const dirs = directionsFor(ev('tester', 'qa_question', 'x'.repeat(300)), isMember);
  assert.ok(dirs[0].say.length <= SAY_MAX);
});

console.log(`\n${passed} studio director tests passed`);
