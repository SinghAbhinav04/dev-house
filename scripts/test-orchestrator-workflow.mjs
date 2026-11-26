// Drives the real orchestrator end to end against a stub `claude` CLI and
// checks the team workflow it produces: the whiteboard brief reaching the
// planner, the plan drafted onto the board, the ticket breakdown and hand-offs,
// per-ticket coding, a code-review bug, the dev↔QA huddle, a QA rejection and
// fix, and an audit finding filed as a security ticket.
//
// No tokens: the stub answers each turn from what the prompt and schema ask.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'hackeroom-wf-'));
const home = join(root, 'home');
const bin = join(root, 'bin');
const stubState = join(root, 'stub');
const projectDir = join(home, 'Builds', 'kanban-demo');
for (const dir of [home, bin, stubState, projectDir]) mkdirSync(dir, { recursive: true });

// ── The stub CLI ─────────────────────────────────────────────────────

const STUB = readFileSync(join(repo, 'scripts', 'fixtures', 'stub-claude.cjs'), 'utf8');
writeFileSync(join(bin, 'stub-claude.js'), STUB);
if (process.platform === 'win32') {
  // npm-style shim, which the runner sees through to `node stub-claude.js`.
  writeFileSync(join(bin, 'claude.cmd'), '@ECHO off\r\n"%_prog%" "%dp0%\\stub-claude.js" %*\r\n');
} else {
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node\n${STUB}`);
  chmodSync(join(bin, 'claude'), 0o755);
}

// ── A team and a staged run with a whiteboard brief ──────────────────

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  HACKEROOM_HOME: join(root, 'hackeroom'),
  HACKEROOM_SCENE_GAP_MS: '0',
  STUB_STATE: stubState,
  PATH: `${bin}${delimiter}${process.env.PATH || process.env.Path || ''}`,
};
delete env.Path;

execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(repo, 'scripts', 'team.mjs'), 'starter'], {
  env,
  stdio: 'ignore',
});

// Run every member on the host: CI has no Docker, and isolation has its own
// tests (test-runner.mjs).
{
  const teamFile = join(env.HACKEROOM_HOME, 'team.json');
  const team = JSON.parse(readFileSync(teamFile, 'utf8'));
  for (const member of team.members) member.capabilities = { ...member.capabilities, preferIsolated: false };
  writeFileSync(teamFile, JSON.stringify(team, null, 2));
}

const BRIEF = 'A kanban board with drag and drop.\nKeep it to plain HTML and JS.';
writeFileSync(
  join(projectDir, 'pipeline-events.json'),
  JSON.stringify({
    concept: 'A kanban board with drag and drop.',
    projectDir,
    pipelineStatus: 'running',
    events: [],
    sessions: {},
    tickets: [],
    board: { brief: { text: BRIEF, updatedAt: new Date().toISOString() } },
  }),
);

// ── Run it ───────────────────────────────────────────────────────────

const tsx = join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs');
let output = '';

async function runOrchestrator() {
  const child = spawn(process.execPath, [tsx, join(repo, 'pipeline', 'orchestrator.ts'), '--project-dir', projectDir], {
    cwd: repo,
    env,
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill();
      resolveExit('timeout');
    }, 120_000);
    child.on('exit', (exitCode) => {
      clearTimeout(timer);
      resolveExit(exitCode);
    });
  });
}

const readState = () => JSON.parse(readFileSync(join(projectDir, 'pipeline-events.json'), 'utf8'));
const code = await runOrchestrator();

const state = readState();
const prompts = readFileSync(join(stubState, 'prompts.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

let passed = 0;
function test(name, fn) {
  try {
    fn();
  } catch (err) {
    console.error(output.split('\n').slice(-40).join('\n'));
    throw err;
  }
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const events = state.events;
const ofType = (type) => events.filter((e) => e.type === type);
const tickets = state.tickets;
const byTitle = (title) => tickets.find((t) => t.title === title);
// Status changes only; an assignment is also a history entry, with from === to.
const statuses = (t) => t.history.filter((h) => h.from !== h.to).map((h) => h.to);

test('the run ends waiting on the audit decision, not failed', () => {
  assert.equal(code, 0, `orchestrator exited ${code}`);
  assert.equal(state.pipelineStatus, 'awaiting-audit-decision');
});

test('the planner reads the whiteboard brief first', () => {
  assert.match(prompts[0].prompt, /The user wrote this brief on the studio whiteboard/);
  assert.match(prompts[0].prompt, /Keep it to plain HTML and JS\./);
  assert.ok(prompts.some((p) => /outline/.test(p.prompt)), 'the write step asks for an outline first');
  assert.equal(state.board.brief.text, BRIEF, 'the brief is still on the board');
});

test('the plan is drafted onto the whiteboard, then finalised', () => {
  const writes = ofType('board_write').map((e) => e.text);
  assert.ok(writes.some((t) => /Writing the plan on the whiteboard \(6 sections\)/.test(t)), `outline mirrored: ${writes}`);
  assert.ok(writes.some((t) => /Final plan/.test(t)));
  assert.equal(state.board.plan.status, 'final');
  assert.match(state.board.plan.text, /## Tests/);
});

test('the planner is shown the real team and plans who does what', () => {
  const write = prompts.find((p) => /Write the full build plan/.test(p.prompt));
  assert.match(write.prompt, /Your team for this run:/);
  assert.match(write.prompt, /- coder: /);
  assert.match(write.prompt, /Team and tasks/);
  assert.match(state.board.plan.text, /## Team and tasks/);
  const breakdown = prompts.find((p) => /Break it into tickets/.test(p.prompt));
  assert.match(breakdown.prompt, /only members with a seat can be given work/);
});

test('tickets carry estimates, tags and a dev owner', () => {
  const story = byTitle('Board columns and cards');
  assert.equal(story.estimateMinutes, 25);
  assert.deepEqual(story.tags, ['ui', 'storage']);
  assert.equal(story.owner, 'coder');
});

test('each story is built on its own branch, committed by the coder and merged', () => {
  const first = byTitle('Board columns and cards').branch;
  const second = byTitle('Drag cards between columns').branch;
  assert.equal(first.name, 'dh-2-board-columns-and-cards');
  assert.equal(first.merged, true);
  assert.equal(first.files, 3, 'index.html, styles.css, board.js — no run state');
  assert.equal(second.files, 1, 'only board.js changed for drag and drop');
  assert.ok(second.additions > 0);
  const log = spawnSync('git', ['log', '--format=%an|%s', first.head, '-1'], { cwd: projectDir, encoding: 'utf8' }).stdout.trim();
  assert.match(log, /\|DH-2: Board columns and cards$/);
  assert.doesNotMatch(log, /^Hackeroom\|/, 'authored by the teammate, not a generic bot');
});

test('bug fixes get their own branch too, and the review verdicts are recorded', () => {
  const reviewBug = byTitle('The card count badge is never updated.');
  assert.match(reviewBug.branch.name, /^dh-\d+-the-card-count-badge/);
  assert.equal(reviewBug.branch.files, 1);
  const qaBug = byTitle('Dropping a card on an empty column does nothing.');
  assert.equal(qaBug.branch.merged, true);
  const story = byTitle('Drag cards between columns');
  assert.equal(story.review.verdict, 'approved');
  assert.equal(story.review.by, 'tester');
});

test('the plan is a story that went Solutioning → Done', () => {
  const plan = tickets.find((t) => t.title.startsWith('Plan: '));
  assert.ok(plan);
  assert.equal(plan.status, 'done');
  assert.deepEqual(statuses(plan), ['solutioning', 'done']);
});

test('the planner breaks the plan down and calls each owner over once', () => {
  const calls = ofType('call_member').filter((e) => e.agent === 'planner');
  assert.deepEqual(calls.map((e) => JSON.parse(e.detail).target), ['coder', 'tester']);
  assert.equal(byTitle('Board columns and cards').assignee, 'coder');
  assert.equal(byTitle('Write the test plan').assignee, 'tester');
  assert.equal(ofType('ticket_assigned').filter((e) => e.agent === 'planner').length, 3);
});

test('the coder works ticket by ticket', () => {
  const ticketPrompts = prompts.filter((p) => /DH-\d+ — /.test(p.prompt) && p.props.length === 0);
  assert.equal(ticketPrompts.length, 2, 'one turn per coder ticket');
  assert.match(ticketPrompts[0].prompt, /Read the approved plan/);
  assert.match(ticketPrompts[1].prompt, /Next ticket/);
});

test('a code-review issue becomes a bug that is fixed and closed', () => {
  const bug = byTitle('The card count badge is never updated.');
  assert.ok(bug, 'review bug filed');
  assert.equal(bug.type, 'bug');
  assert.equal(bug.reporter, 'tester');
  assert.deepEqual(statuses(bug), ['todo', 'in-progress', 'in-review', 'done']);
});

test('QA asks the coder questions and the coder answers before testing', () => {
  assert.deepEqual(ofType('qa_question').map((e) => e.text), ['How do I start it?', 'Anything you are unsure about?']);
  assert.equal(ofType('qa_answer').length, 2);
  assert.equal(ofType('qa_answer')[0].agent, 'coder');
  const firstTest = prompts.find((p) => /test the code/i.test(p.prompt));
  assert.match(firstTest.prompt, /Open index\.html — no build step\./, 'answers reach the test pass');
});

test('a QA failure rejects the stories and files a bug; the retest closes everything', () => {
  const story = byTitle('Drag cards between columns');
  assert.deepEqual(statuses(story), ['backlog', 'todo', 'in-progress', 'in-review', 'in-qa', 'rejected', 'in-progress', 'in-qa', 'done']);
  const bug = byTitle('Dropping a card on an empty column does nothing.');
  assert.equal(bug.priority, 'p1');
  assert.equal(bug.status, 'done');
  assert.equal(byTitle('Write the test plan').status, 'done');
});

test('the audit finding is a security ticket in To Do', () => {
  const sec = tickets.find((t) => t.type === 'security');
  assert.ok(sec);
  assert.equal(sec.status, 'todo');
  assert.equal(sec.priority, 'p1');
  assert.equal(state.auditFindings[0].ticketId, sec.id);
});

test('ticket ids are unique and sequential', () => {
  assert.deepEqual(tickets.map((t) => t.id), tickets.map((_, i) => `DH-${i + 1}`));
});

// ── The user sends the finding to the coder: a fresh orchestrator ────

{
  const before = readState();
  before.resumeAction = 'audit-send-to-c';
  before.resumeActionTarget = before.auditFindings[0].id;
  writeFileSync(join(projectDir, 'pipeline-events.json'), JSON.stringify(before));
  const fixCode = await runOrchestrator();
  const after = readState();

  test('the security ticket follows its finding through the fix and re-audit', () => {
    assert.equal(fixCode, 0, `audit fix pass exited ${fixCode}`);
    const finding = after.auditFindings[0];
    // The stub's auditor never accepts a fix, so the finding stays open and
    // the ticket goes back to the developer.
    assert.equal(finding.status, 'still-open');
    const sec = after.tickets.find((t) => t.id === finding.ticketId);
    assert.deepEqual(statuses(sec), ['todo', 'in-progress', 'in-review', 'in-progress']);
    assert.equal(after.tickets.filter((t) => t.type === 'security').length, 1, 'the re-audit does not file a duplicate');
  });
}

rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} orchestrator workflow checks passed`);
