import assert from 'node:assert/strict';

import {
  TEAM_PROPOSAL_SCHEMA,
  extractProposal,
  normalizeProposal,
  proposalSystemPrompt,
} from '../src/lib/team/proposal.ts';
import { normalizeRoster } from '../src/lib/team/roster.ts';
import { MAX_TEAM_SIZE } from '../src/lib/team/types.ts';

const emptyRoster = normalizeRoster({ version: 2, members: [] });

const staffedRoster = normalizeRoster({
  version: 2,
  members: [
    { id: 'shanks', name: 'Shanks', slot: 'planner' },
    { id: 'asta', name: 'Asta', slot: 'coder' },
  ],
});

// ── The schema never invites permissions ────────────────────────────
//
// The refusal to let a model grant capabilities is a property of the request
// shape, not something a validator has to catch after the fact.

const memberProps = TEAM_PROPOSAL_SCHEMA.properties.members.items.properties;
for (const forbidden of ['capabilities', 'enabled', 'tokenBudget', 'permissionMode']) {
  assert.equal(forbidden in memberProps, false, `the schema must not offer "${forbidden}"`);
}
assert.equal(TEAM_PROPOSAL_SCHEMA.properties.members.items.additionalProperties, false);
assert.equal(TEAM_PROPOSAL_SCHEMA.properties.members.maxItems, MAX_TEAM_SIZE);

// ── Nothing is spread through ───────────────────────────────────────

const smuggled = normalizeProposal(
  {
    summary: 'A tiny team.',
    members: [
      {
        id: 'mole',
        name: 'Mole',
        title: 'Frontend',
        slot: 'coder',
        role: 'Build the UI.',
        capabilities: { write: 'builds', bash: 'all', web: true, projectMount: 'rw', preferIsolated: false },
        permissionMode: 'dangerously-skip-permissions',
        tokenBudget: 999999,
        enabled: true,
      },
    ],
  },
  emptyRoster,
);

const mole = smuggled.proposal.members[0];
assert.equal(mole.id, 'mole');
assert.equal('capabilities' in mole, false, 'a proposal cannot carry capabilities');
assert.equal('permissionMode' in mole, false, 'a proposal cannot choose a permission mode');
assert.equal('tokenBudget' in mole, false, 'a proposal cannot set its own budget');
assert.deepEqual(
  Object.keys(mole).sort(),
  ['effort', 'id', 'model', 'name', 'role', 'skills', 'slot', 'title'],
  'only the allowlisted fields survive normalization',
);

// ── Ids, slots, models ──────────────────────────────────────────────

const messy = normalizeProposal(
  {
    summary: 'x',
    members: [
      { id: 'Bad Id!', name: 'Nope', slot: 'coder', role: 'r' },
      { id: 'shanks', name: 'Clash', slot: 'reviewer', role: 'r' },
      { id: 'rex', name: 'Rex', slot: 'planner', role: 'r' },
      { id: 'tess', name: 'Tess', slot: 'invented', role: 'r' },
      { id: 'ada', name: 'Ada', slot: 'tester', model: 'gpt-9', effort: 'sideways', role: 'r' },
      { id: 'ada', name: 'Ada again', slot: 'auditor', role: 'r' },
    ],
  },
  staffedRoster,
);

const byId = Object.fromEntries(messy.proposal.members.map((m) => [m.id, m]));
assert.equal('Bad Id!' in byId, false, 'invalid ids are dropped');
assert.equal('shanks' in byId, false, 'ids already on the roster are dropped');
assert.equal(byId.rex.slot, null, 'a seat the roster already staffs is not handed out again');
assert.equal(byId.tess.slot, null, 'an unknown seat leaves the member seatless');
assert.equal(byId.ada.model, '', 'an unknown model falls back to the team default');
assert.equal(byId.ada.effort, 'medium', 'an unknown effort falls back to medium');
assert.equal(messy.proposal.members.filter((m) => m.id === 'ada').length, 1, 'duplicate ids within one proposal');
assert.ok(messy.warnings.length >= 5, 'every drop is explained');

// Two proposed members cannot both claim one seat.
const doubled = normalizeProposal(
  {
    summary: 'x',
    members: [
      { id: 'one', name: 'One', slot: 'coder', role: 'r' },
      { id: 'two', name: 'Two', slot: 'coder', role: 'r' },
    ],
  },
  emptyRoster,
);
assert.equal(doubled.proposal.members[0].slot, 'coder');
assert.equal(doubled.proposal.members[1].slot, null, 'the second claimant gets no seat');

// ── The office cannot be overfilled ─────────────────────────────────

const crowd = normalizeProposal(
  {
    summary: 'x',
    members: Array.from({ length: MAX_TEAM_SIZE + 4 }, (_, i) => ({
      id: `m${i}`,
      name: `M${i}`,
      slot: null,
      role: 'r',
    })),
  },
  staffedRoster,
);
assert.equal(
  crowd.proposal.members.length,
  MAX_TEAM_SIZE - staffedRoster.members.length,
  'only the free seats are filled',
);
assert.ok(crowd.warnings.some((w) => w.includes('full')), 'and it says so');

// ── Skills ──────────────────────────────────────────────────────────

const skilled = normalizeProposal(
  {
    summary: 'x',
    members: [
      {
        id: 'skilly',
        name: 'Skilly',
        slot: 'coder',
        role: 'r',
        skills: [
          { name: 'House Style', description: 'Buttons and spacing', body: '# Style' },
          { name: 'no-body', description: 'nothing', body: '   ' },
          { name: '!!!', description: 'bad name', body: 'x' },
          { name: 'a', description: '', body: 'x' },
          { name: 'b', description: '', body: 'x' },
          { name: 'c', description: '', body: 'x' },
        ],
      },
    ],
  },
  emptyRoster,
);
const skills = skilled.proposal.members[0].skills;
assert.equal(skills[0].name, 'house-style', 'skill names are slugged');
assert.ok(skills.every((s) => s.body.trim().length > 0), 'empty skills are dropped');
assert.ok(skills.length <= 3, 'a member cannot be handed unlimited skills');

// ── Junk in, empty out ──────────────────────────────────────────────

assert.deepEqual(normalizeProposal(null, emptyRoster).proposal.members, []);
assert.deepEqual(normalizeProposal({ members: 'not an array' }, emptyRoster).proposal.members, []);
assert.deepEqual(normalizeProposal('total nonsense', emptyRoster).proposal.members, []);

// ── Unwrapping whatever the CLI hands back ──────────────────────────

const payload = { summary: 's', members: [{ id: 'x', name: 'X', slot: null, role: 'r' }] };
assert.deepEqual(extractProposal(payload), payload, 'a bare payload');
assert.deepEqual(extractProposal({ structured_output: payload }), payload, 'wrapped once');
assert.deepEqual(extractProposal(JSON.stringify(payload)), payload, 'as a JSON string');
assert.deepEqual(extractProposal({ result: { output: JSON.stringify(payload) } }), payload, 'nested and stringified');
assert.equal(extractProposal({ nothing: 'here' }), null);

// ── The instruction says who decides permissions ────────────────────

const prompt = proposalSystemPrompt(staffedRoster);
assert.match(prompt, /do not decide what anyone is permitted to do/i);
assert.match(prompt, /planner/, 'the drafting turn knows a planner is required');
assert.match(prompt, /shanks|planner, coder/i, 'and which seats are already staffed');

console.log('proposal checks passed');
