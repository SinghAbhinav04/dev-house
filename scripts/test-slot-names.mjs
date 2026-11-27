/**
 * Text about the team names the member in a seat, never the letter of the old
 * fixed team.
 *
 * Hackeroom began with six agents called S, A, B, C, D and E, and sentences
 * such as "Ask S to start" and "Sent plan to B for review" outlived them. With
 * a roster the user defines, those letters appear nowhere else on screen.
 *
 * Three parts: the naming rule itself, the supervisor's text given a roster and
 * given none, and a read of the sources that print such text, so a letter does
 * not come back by way of a new sentence.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSupervisorSnapshot, getSupervisorRecommendation, getSupervisorUpdate } from '../src/lib/pipeline-supervisor.ts';
import { buildSupervisorConceptReply } from '../src/lib/supervisor-concept.ts';
import { SEAT_LABELS, slotNames } from '../src/lib/team/slot-names.ts';
import { SLOT_IDS, SLOT_LABELS } from '../src/lib/team/types.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(repoRoot, path), 'utf8');

// ── The rule ─────────────────────────────────────────────────────────

const team = { planner: 'Priya', reviewer: 'Ravi', coder: 'Chen', tester: 'Dana', auditor: 'Eve', supervisor: 'Sam' };
const named = slotNames((slot) => team[slot]);
assert.deepEqual(named, team, 'a filled seat is called by its member');

assert.deepEqual(slotNames(() => null), SLOT_LABELS, 'an empty seat keeps its label');
assert.deepEqual(SEAT_LABELS, SLOT_LABELS, 'and the labels are what a caller with no roster gets');

const partial = slotNames((slot) => ({ coder: 'Chen', tester: '   ', auditor: undefined })[slot]);
assert.equal(partial.coder, 'Chen');
assert.equal(partial.tester, SLOT_LABELS.tester, 'a blank name is no name');
assert.equal(partial.auditor, SLOT_LABELS.auditor);
assert.deepEqual(Object.keys(partial).sort(), [...SLOT_IDS].sort(), 'every seat has something to be called');
assert.equal(slotNames(() => '  Sam  ').supervisor, 'Sam', 'names are trimmed');

// ── The supervisor's text ────────────────────────────────────────────

const base = {
  concept: 'Tiny hello page',
  securityMode: 'fast',
  runGoal: 'full-build',
  stopAfterPhase: 'none',
  activeAgent: '',
  buildComplete: false,
  runtime: { activeTurn: null },
  events: [],
};

/** Every state whose text used to carry a letter. */
const states = {
  idle: { ...base, concept: '', currentPhase: 'concept', pipelineStatus: 'idle' },
  conceptCaptured: { ...base, currentPhase: 'concept', pipelineStatus: 'idle' },
  failed: { ...base, currentPhase: 'coding', pipelineStatus: 'failed' },
  planning: { ...base, currentPhase: 'planning', pipelineStatus: 'running' },
  pausedAfterReview: { ...base, currentPhase: 'plan-review', pipelineStatus: 'paused', runGoal: 'plan-only' },
  auditing: { ...base, currentPhase: 'security-audit', pipelineStatus: 'running' },
  auditFixRunning: { ...base, currentPhase: 'security-audit', pipelineStatus: 'running', auditActionInFlight: true },
  auditDecision: {
    ...base,
    currentPhase: 'security-audit',
    pipelineStatus: 'awaiting-audit-decision',
    auditFindings: [{ id: 'F1', severity: 'high', text: 'x', status: 'open' }],
  },
  auditDecisionFixRunning: {
    ...base,
    currentPhase: 'security-audit',
    pipelineStatus: 'awaiting-audit-decision',
    auditActionInFlight: true,
    auditFindings: [{ id: 'F1', severity: 'high', text: 'x', status: 'sent-to-c' }],
  },
};

/** A seat's old letter standing as a word of its own: "ask S to", "C's fix", "once E finishes". */
const LETTER =
  /(?<![A-Za-z0-9_'-])(?:[B-ES]\b(?!['’]?[a-rt-z])(?![-+])|A (?:is|will|has|plans?|approved|answers?|directly)\b)|\b(?:[Tt]o|[Ff]rom|[Aa]sk|[Tt]ell|[Mm]essage|resumed|[Oo]nce|[Aa]fter) A\b(?! (?:new|run|team|member|role|turn|planner|coder|planning)\b)/;

function everyText(state, names) {
  const recommendation = getSupervisorRecommendation(state, null, names);
  const update = getSupervisorUpdate(state, null, names);
  return [
    recommendation.title,
    recommendation.detail,
    recommendation.actionLabel,
    update.title,
    update.summary,
    update.ask || '',
    buildSupervisorSnapshot(state, null, names).split('Recent events:')[0],
  ];
}

for (const [label, state] of Object.entries(states)) {
  for (const [which, names] of [['with a roster', named], ['with no roster', undefined]]) {
    for (const text of everyText(state, names)) {
      // "A planning turn", "A scoped security fix": the article, not the planner.
      const sentence = text.replace(/\bA (?=planning|scoped|Docker|pipeline|run\b)/g, 'One ');
      const seatLetter = sentence.match(/(?<![A-Za-z0-9_'-])[B-ES](?![A-Za-z0-9_-])(?!\+)/);
      const isName = seatLetter && Object.values(names ?? {}).includes(seatLetter[0]);
      assert.ok(!seatLetter || isName, `${label}, ${which}: "${text}" names a seat by its old letter`);
    }
  }
}

assert.equal(getSupervisorRecommendation(states.idle, null, named).title, 'Tell Sam what to build');
assert.equal(getSupervisorRecommendation(states.idle, null).title, 'Tell Supervisor what to build', 'the label, when no roster is given');
assert.match(getSupervisorRecommendation(states.pausedAfterReview, null, named).detail, /^Ravi approved the plan .* want Chen to start building\.$/);
assert.match(getSupervisorRecommendation(states.planning, null, named).detail, /after Ravi approves the plan, ask Sam to stop after review/);
assert.match(getSupervisorRecommendation(states.failed, null, named).actionLabel, /^Ask Sam what happened$/);
assert.match(getSupervisorUpdate(states.auditFixRunning, null, named).summary, /Chen is applying a scoped fix, then Dana verifies the tests, then Eve re-audits/);
assert.match(getSupervisorUpdate(states.auditing, null, named).ask, /once Eve finishes/);
assert.match(getSupervisorUpdate(states.auditDecision, null, named).summary, /^Eve reported 1 finding /);
assert.match(getSupervisorUpdate(states.auditDecision, null, named).ask, /Send to Chen to fix/);
assert.match(getSupervisorUpdate(states.auditDecisionFixRunning, null, named).summary, /^Chen is applying a scoped fix, Dana is verifying tests, and Eve will re-audit/);
assert.match(buildSupervisorSnapshot(states.idle, null, named), /Tell Sam what to build/, 'the snapshot the supervisor reads carries the names too');

assert.match(buildSupervisorConceptReply('A page', true, named), /message Priya directly/);
assert.match(buildSupervisorConceptReply('A page', false, named), /talk directly to Priya, Ravi, Chen, or Dana whenever/);
assert.match(buildSupervisorConceptReply('A page', false), /talk directly to Planner, Plan Reviewer, Coder, or Tester whenever/);

// ── The sources ──────────────────────────────────────────────────────
//
// Text only: comments are prose about the code, and identifiers such as
// `onSendToC` and the stored status 'sent-to-c' name nothing on screen.

/** String literals, template text and JSX text of a source file, one per line. */
function visibleText(source) {
  const noComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  const literals = [...noComments.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`|>([^<>{}\n]+)</g)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? match[4] ?? '',
  );
  // What a template interpolates is code, not text.
  return literals.map((text) => text.replace(/\$\{[^}]*\}/g, 'X')).filter((text) => /[a-z] [A-Za-z]|[A-Za-z] [a-z]/.test(text));
}

const sources = [
  'pipeline/orchestrator.ts',
  'src/lib/pipeline-supervisor.ts',
  'src/lib/supervisor-concept.ts',
  'src/app/api/chat/route.ts',
  'src/app/page.tsx',
  'src/app/squad/page.tsx',
  'src/components/agents/SecurityAuditPanel.tsx',
  'src/components/mission/LunarOfficeScene.tsx',
];

for (const path of sources) {
  for (const text of visibleText(read(path))) {
    assert.ok(!LETTER.test(text), `${path}: "${text.slice(0, 90)}" names a seat by its old letter`);
  }
}

// The rule above has to be able to see what it is looking for.
for (const old of [
  'Sent plan to B for review',
  'Ask S what happened',
  "is still open after C's fix. Decide",
  'You will review findings once E finishes.',
  'Supervisor resumed A from the saved planning session',
  'You can still talk directly to A, B, C, or D whenever you want.',
  'Received 3 issue(s) from D',
  'A will plan, B will review',
]) {
  assert.ok(LETTER.test(old), `the sweep recognises "${old}"`);
}
for (const fine of [
  'A planning turn looks recoverable',
  'A run is in progress. Stop it before writing a new brief.',
  'Sent code to X for review',
  'Tell X what to build',
  'Send to X to fix, or Dismiss.',
  "X's fix for F1 broke tests.",
]) {
  assert.ok(!LETTER.test(fine), `and leaves "${fine}" alone`);
}

// The role templates are what a member is told about its teammates. They are
// prose, and a template cannot know who will fill a seat, so they say "the
// coder" and "the tester"; the roster each run is given says who that is.
const rolesDir = join(repoRoot, 'templates', 'roles');
const roleFiles = readdirSync(rolesDir).filter((name) => name.endsWith('.md'));
assert.ok(roleFiles.length >= 6, 'the role templates are where they were');
for (const name of roleFiles) {
  for (const [index, line] of readFileSync(join(rolesDir, name), 'utf8').split('\n').entries()) {
    assert.ok(!/`[A-ES]`/.test(line), `templates/roles/${name}:${index + 1} names a teammate by a letter in backticks`);
    assert.ok(!/\b[A-ES] \((?:Planner|Plan Reviewer|Reviewer|Coder|Tester|Code Reviewer|Security Auditor)/.test(line), `templates/roles/${name}:${index + 1} labels a teammate with a letter`);
    assert.ok(!LETTER.test(line), `templates/roles/${name}:${index + 1} names a teammate by its old letter: "${line.slice(0, 80)}"`);
  }
}

// Each caller hands over the names it has.
const page = read('src/app/page.tsx');
const squad = read('src/app/squad/page.tsx');
const chat = read('src/app/api/chat/route.ts');
for (const [name, source] of [['the office page', page], ['the squad page', squad]]) {
  assert.match(source, /const names = slotNames\(\(slot\) => members\.find\(\(m\) => m\.slot === slot && m\.enabled\)\?\.name\);/, `${name} reads the names from its members`);
  assert.match(source, /getSupervisorRecommendation\(state, \w+, names\)/, `${name} names the team in the recommendation`);
  assert.match(source, /getSupervisorUpdate\(state, \w+, names\)/, `${name} and in the update`);
}
assert.match(page, /auditorName=\{names\.auditor\}\s*\n\s*coderName=\{names\.coder\}/, 'the audit panel is told who the auditor and the coder are');
assert.match(chat, /return slotNames\(\(slot\) => resolveSlot\(roster, slot\)\?\.name\);/, 'the server asks the roster who fills each seat');
assert.equal(chat.match(/seatNames\(readRoster\(\)\)/g)?.length, 4, 'and every text it writes about the team uses that');

const orchestrator = read('pipeline/orchestrator.ts');
assert.match(orchestrator, /function slotLabel\(slot: SlotId\): string \{\s*\n\s*const member = memberFor\(slot\);\s*\n\s*return member \? member\.name : SLOT_LABELS\[slot\];/, 'the orchestrator names a seat the same way');

console.log('slot name checks passed');
