#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempHome = mkdtempSync(join(tmpdir(), 'hackeroom-roster-'));
process.env.HACKEROOM_HOME = tempHome;

const {
  clampCapabilities,
  createMember,
  getMember,
  listMemberSkills,
  memberPluginDir,
  memberRolePath,
  normalizeRoster,
  readMemberRole,
  readRoster,
  removeMember,
  removeMemberSkill,
  resolveModel,
  updateMember,
  writeMemberSkill,
  writeRoster,
} = await import('../src/lib/team/roster.ts');

const { EMPTY_ROSTER, defaultCapabilitiesForSlot } = await import('../src/lib/team/types.ts');

// ── normalizeRoster ──────────────────────────────────────────────────

assert.deepEqual(normalizeRoster(null).members, [], 'null normalises to an empty roster');
assert.equal(normalizeRoster(null).version, 2);
assert.equal(normalizeRoster(undefined).teamModel, 'sonnet', 'falls back to the default team model');

const messy = normalizeRoster({
  members: [
    { id: 'Reacty', name: 'Reacty' },
    { id: 'ok-one', name: 'Fine' },
    { id: 'ok-one', name: 'Duplicate' },
    { id: '../evil', name: 'Traversal' },
    { id: '', name: 'Empty' },
    'not-an-object',
  ],
});
assert.deepEqual(
  messy.members.map((m) => m.id),
  ['reacty', 'ok-one'],
  'ids are normalised to lowercase; traversal, empty, duplicate and non-object members are dropped'
);

const defaulted = normalizeRoster({ members: [{ id: 'x' }] }).members[0];
assert.equal(defaulted.name, 'x', 'name falls back to the id');
assert.equal(defaulted.permissionMode, 'auto');
assert.equal(defaulted.effort, 'high');
assert.equal(defaulted.enabled, true);
assert.equal(defaulted.slot, null);
assert.deepEqual(defaulted.skills, []);

const badEnums = normalizeRoster({
  members: [{ id: 'y', slot: 'wizard', permissionMode: 'yolo', effort: 'infinite' }],
}).members[0];
assert.equal(badEnums.slot, null, 'unknown slot becomes null');
assert.equal(badEnums.permissionMode, 'auto', 'unknown permission mode falls back');
assert.equal(badEnums.effort, 'high', 'unknown effort falls back');

// ── Which CLI a member runs on ───────────────────────────────────────
//
// Every roster on disk predates members having a choice of engine, so the
// absent field has to read as the engine they were already running. This is
// the whole migration — there is no version bump and no rewrite step.

assert.equal(defaulted.cli, 'claude', 'a member with no cli field runs where it always ran');

assert.equal(
  normalizeRoster({ members: [{ id: 'z', cli: 'opencode' }] }).members[0].cli,
  'opencode',
  'an explicit choice is kept',
);
assert.equal(
  normalizeRoster({ members: [{ id: 'z', cli: 'gpt-cli' }] }).members[0].cli,
  'claude',
  'an unrecognised engine falls back rather than reaching the runner',
);
assert.equal(
  normalizeRoster({ members: [{ id: 'z', cli: 42 }] }).members[0].cli,
  'claude',
  'and a non-string does not throw on the way',
);

// ── clampCapabilities ────────────────────────────────────────────────

assert.equal(
  clampCapabilities({ write: 'builds' }, 'coder').write,
  'project',
  'only the supervisor slot may write across ~/Builds'
);
assert.equal(clampCapabilities({ write: 'builds' }, 'supervisor').write, 'builds');
assert.equal(clampCapabilities({ write: 'builds' }, null).write, 'project');
assert.equal(clampCapabilities({ write: 'nonsense' }, 'coder').write, 'project', 'invalid write level falls back to the slot default');
assert.equal(clampCapabilities({ bash: 'nonsense' }, 'coder').bash, 'safe');
assert.equal(clampCapabilities({}, 'reviewer').write, 'none', 'reviewer defaults to read-only');
assert.equal(clampCapabilities({}, 'planner').write, 'artifact', 'planner defaults to its own artifact');
assert.equal(clampCapabilities({}, null).write, 'none', 'unslotted members default to read-only');

// ── createMember ─────────────────────────────────────────────────────

let roster = readRoster();
assert.deepEqual(roster.members, [], 'starts empty — there is no built-in squad');

({ roster } = createMember(roster, { id: 'reacty', name: 'Reacty', title: 'Frontend', slot: 'coder', model: 'sonnet' }));

const reacty = getMember(roster, 'reacty');
assert.ok(reacty, 'member was created');
assert.equal(reacty.slot, 'coder');
assert.deepEqual(reacty.capabilities, defaultCapabilitiesForSlot('coder'), 'gets the slot capability defaults');
assert.ok(existsSync(memberRolePath('reacty')), 'a role.md is laid down');
assert.ok(existsSync(join(memberPluginDir('reacty'), '.claude-plugin', 'plugin.json')), 'a plugin manifest is laid down');
assert.match(readMemberRole('reacty'), /coder/, 'the placeholder role names the slot');

assert.equal(roster.workflow.slots.coder.members[0], 'reacty', 'assignment flows into the workflow');

assert.throws(() => createMember(roster, { id: 'reacty' }), /already exists/, 'ids are unique');
assert.throws(
  () => createMember(roster, { id: ' Reacty ' }),
  /already exists/,
  'ids are trimmed and lowercased before the uniqueness check'
);
assert.throws(() => createMember(roster, { id: 'has space' }), /Invalid member id/, 'ids are validated');
assert.throws(() => createMember(roster, { id: '-leading' }), /Invalid member id/, 'ids cannot start with a dash');
assert.throws(() => createMember(roster, { id: 'a'.repeat(33) }), /Invalid member id/, 'ids are length-capped');

// A member cannot grant itself supervisor-level write scope.
({ roster } = createMember(roster, { id: 'sneaky', slot: 'coder', capabilities: { write: 'builds' } }));
assert.equal(getMember(roster, 'sneaky').capabilities.write, 'project', 'escalation is clamped at creation');

// ── updateMember ─────────────────────────────────────────────────────

roster = updateMember(roster, 'reacty', { model: 'haiku', effort: 'max' });
assert.equal(getMember(roster, 'reacty').model, 'haiku');
assert.equal(getMember(roster, 'reacty').effort, 'max');

roster = updateMember(roster, 'reacty', { id: 'renamed' });
assert.ok(getMember(roster, 'reacty'), 'the id is not patchable — it names the on-disk directory');
assert.equal(getMember(roster, 'renamed'), null);

assert.throws(() => updateMember(roster, 'nobody', { model: 'opus' }), /No member/);

// ── resolveModel ─────────────────────────────────────────────────────

assert.equal(resolveModel(roster, getMember(roster, 'reacty')), 'haiku', 'member model wins');
roster = updateMember(roster, 'reacty', { model: '' });
assert.equal(resolveModel(roster, getMember(roster, 'reacty')), roster.teamModel, 'falls back to the team model');
roster = writeRoster({ ...roster, teamModel: 'opus' });
assert.equal(resolveModel(roster, getMember(roster, 'reacty')), 'opus', 'the team-wide model applies');

// ── Skills ───────────────────────────────────────────────────────────

assert.deepEqual(listMemberSkills('reacty'), [], 'no skills to start');

const slug = writeMemberSkill('reacty', {
  name: 'UI Docs',
  description: 'House style for buttons, spacing and colour.',
  body: '# UI docs\n\nUse 8px spacing.',
});
assert.equal(slug, 'ui-docs', 'skill names are slugified');
assert.deepEqual(listMemberSkills('reacty'), ['ui-docs']);

const skillText = readFileSync(join(memberPluginDir('reacty'), 'skills', 'ui-docs', 'SKILL.md'), 'utf8');
assert.match(skillText, /^---\nname: ui-docs\n/, 'frontmatter carries the name');
assert.match(skillText, /description: House style/, 'frontmatter carries the description');
assert.match(skillText, /Use 8px spacing\./, 'body is preserved');

removeMemberSkill('reacty', 'ui-docs');
assert.deepEqual(listMemberSkills('reacty'), [], 'skills can be detached');

// ── removeMember ─────────────────────────────────────────────────────

roster = removeMember(roster, 'sneaky');
assert.equal(getMember(roster, 'sneaky'), null);
assert.ok(!roster.workflow.slots.coder.members.includes('sneaky'), 'removal clears slot assignments');

// ── Persistence round-trip ───────────────────────────────────────────

const reloaded = readRoster();
assert.deepEqual(
  reloaded.members.map((m) => m.id),
  roster.members.map((m) => m.id),
  'the roster survives a round-trip through disk'
);
assert.equal(reloaded.teamModel, 'opus');

// A corrupt team.json must not throw — it degrades to an empty roster.
const { writeFileSync } = await import('node:fs');
writeFileSync(join(tempHome, 'team.json'), '{ not json');
assert.deepEqual(readRoster().members, [], 'corrupt roster reads as empty rather than throwing');

rmSync(tempHome, { recursive: true, force: true });

console.log('roster checks passed');
