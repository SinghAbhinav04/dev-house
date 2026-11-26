// Play a whole team run into the studio without spending a token.
//
//   npm run dev            (in one terminal)
//   npm run demo:replay    (in another)
//
// The real orchestrator runs against a stub CLI (scripts/fixtures/stub-claude.cjs)
// that answers every turn plausibly and takes its time about it, so you can
// watch the planner read the brief and draft the plan on the whiteboard, hand
// out tickets, the coder work them, QA quiz the coder, file a bug, and the
// board move to Done. The run lands in ~/Builds like any other, and the viewer
// picks it up as the latest project.
//
// Your team is copied, never modified: same member ids and names, so they sit
// at their own desks, but every one of them answers from the stub.
//
//   --fast         no thinking time (a run takes seconds)
//   --with-audit   keep the security auditor; the run then waits on you in the
//                  audit panel, and anything you click there uses your REAL CLIs

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { buildsDir, killProcessTree, userHome } from '../src/lib/platform.ts';
import { RUN_TOKEN_ENV, clearOrchestratorRecord, recordOrchestrator } from '../src/lib/orchestrator-liveness.ts';

const flags = new Set(process.argv.slice(2));
const fast = flags.has('--fast');
const withAudit = flags.has('--with-audit');

const repo = resolve(import.meta.dirname, '..');
const realTeamHome = process.env.HACKEROOM_HOME ? resolve(process.env.HACKEROOM_HOME) : join(userHome(), '.hackeroom');
const realTeamFile = join(realTeamHome, 'team.json');

let team;
try {
  team = JSON.parse(readFileSync(realTeamFile, 'utf8'));
} catch {
  team = null;
}
if (!team || !Array.isArray(team.members) || team.members.length === 0) {
  console.error(`No team found at ${realTeamFile}.`);
  console.error('Create one first:  npm run team -- starter');
  process.exit(1);
}

// ── A sandboxed copy of the team, every member answering from the stub ──

const sandbox = mkdtempSync(join(tmpdir(), 'hackeroom-demo-'));
const teamHome = join(sandbox, 'hackeroom');
const bin = join(sandbox, 'bin');
const stubState = join(sandbox, 'stub');
cpSync(realTeamHome, teamHome, { recursive: true });
mkdirSync(bin, { recursive: true });
mkdirSync(stubState, { recursive: true });

for (const member of team.members) {
  member.cli = 'claude';
  member.capabilities = { ...member.capabilities, preferIsolated: false };
}
// The auditor's seat stays filled (they still sit at their desk); the audit
// phase is switched off, so the demo ends at Done instead of waiting on you.
if (!withAudit && team.workflow?.slots?.auditor) team.workflow.slots.auditor.enabled = false;
writeFileSync(join(teamHome, 'team.json'), JSON.stringify(team, null, 2));

const stub = readFileSync(join(repo, 'scripts', 'fixtures', 'stub-claude.cjs'), 'utf8');
writeFileSync(join(bin, 'stub-claude.js'), stub);
if (process.platform === 'win32') {
  writeFileSync(join(bin, 'claude.cmd'), '@ECHO off\r\n"%_prog%" "%dp0%\\stub-claude.js" %*\r\n');
} else {
  writeFileSync(join(bin, 'claude'), `#!/usr/bin/env node\n${stub}`);
  chmodSync(join(bin, 'claude'), 0o755);
}

// ── A staged run with a brief on the whiteboard ──────────────────────

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const projectDir = join(buildsDir(), `demo-kanban-${stamp}`);
mkdirSync(projectDir, { recursive: true });

const brief = [
  'A kanban board with drag and drop.',
  'Three columns: To Do, Doing, Done.',
  'Plain HTML and JS — no build step.',
].join('\n');

writeFileSync(
  join(projectDir, 'pipeline-events.json'),
  JSON.stringify({
    concept: 'A kanban board with drag and drop',
    projectDir,
    pipelineStatus: 'running',
    events: [
      { time: new Date().toISOString(), agent: 'user', phase: 'concept', type: 'board_write', text: 'Wrote the brief on the whiteboard' },
    ],
    sessions: {},
    tickets: [],
    board: { brief: { text: brief, updatedAt: new Date().toISOString() } },
  }),
);

// ── Run the real orchestrator ────────────────────────────────────────

const token = randomUUID();
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
const env = {
  ...process.env,
  HACKEROOM_HOME: teamHome,
  STUB_STATE: stubState,
  STUB_DELAY_MS: fast ? '0' : process.env.STUB_DELAY_MS || '4000',
  HACKEROOM_SCENE_GAP_MS: fast ? '0' : process.env.HACKEROOM_SCENE_GAP_MS || '2500',
  [RUN_TOKEN_ENV]: token,
};
env[pathKey] = `${bin}${delimiter}${process.env[pathKey] || ''}`;

console.log(`\nDemo run: ${projectDir}`);
console.log(`Team:     ${team.members.filter((m) => m.enabled !== false).map((m) => m.name).join(', ')} (all answering from the stub)`);
console.log('Open the studio (npm run dev) to watch. Ctrl+C stops the demo.\n');

const tsx = join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs');
if (!existsSync(tsx)) {
  console.error('tsx is not installed — run pnpm install first.');
  process.exit(1);
}
const child = spawn(process.execPath, [tsx, join(repo, 'pipeline', 'orchestrator.ts'), '--project-dir', projectDir], {
  cwd: repo,
  env,
  stdio: 'inherit',
  windowsHide: true,
});
// Recorded like a real run, so the viewer's Stop button works on the demo too.
recordOrchestrator(projectDir, child.pid, token);

const cleanUp = () => {
  clearOrchestratorRecord(projectDir);
  rmSync(sandbox, { recursive: true, force: true });
};

process.on('SIGINT', () => {
  killProcessTree(child.pid);
});

child.on('exit', (code) => {
  cleanUp();
  console.log(code === 0 ? `\nDemo finished. The run stays in ${projectDir}` : `\nDemo stopped (exit ${code}).`);
  process.exit(code ?? 0);
});
