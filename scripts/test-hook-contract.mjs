#!/usr/bin/env node

/**
 * Contract test for pipeline/.claude/hooks/approval-gate.sh.
 *
 * The hook is the security boundary, so this spawns the real shell script
 * against a temp $HOME/Builds tree rather than testing a reimplementation.
 *
 * Since v3 the hook resolves identity through <project>/.claude/team-manifest.json
 * instead of a hardcoded agent-letter regex, so the fixture below is a
 * user-shaped roster: arbitrary member ids filling slots.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const hookPath = join(repoRoot, 'pipeline', '.claude', 'hooks', 'approval-gate.sh');

const tempRoot = mkdtempSync(join(tmpdir(), 'hackeroom-hook-'));
const tempHome = join(tempRoot, 'home');
const buildsDir = join(tempHome, 'Builds');
const projectDir = join(buildsDir, 'contract-project');
const siblingDir = join(buildsDir, 'sibling-project');
// A project with no manifest at all, to prove the hook fails closed.
const bareDir = join(buildsDir, 'bare-project');
const approvedBashGrantFile = join(projectDir, 'pipeline-approved-bash.json');
const manifestFile = join(projectDir, '.claude', 'team-manifest.json');
const eventsFile = join(projectDir, 'pipeline-events.json');
const memoryInbox = join(projectDir, '.squad', 'memory', 'inbox');

mkdirSync(projectDir, { recursive: true });
mkdirSync(siblingDir, { recursive: true });
mkdirSync(bareDir, { recursive: true });
mkdirSync(join(projectDir, '.claude', 'hooks'), { recursive: true });
mkdirSync(join(memoryInbox, 'nested'), { recursive: true });
mkdirSync(join(projectDir, '.squad', 'memory', 'entries'), { recursive: true });

writeFileSync(eventsFile, JSON.stringify({ currentPhase: 'planning' }, null, 2));
writeFileSync(join(bareDir, 'pipeline-events.json'), JSON.stringify({ currentPhase: 'planning' }, null, 2));
writeFileSync(join(projectDir, 'plan.md'), '# plan\n');
writeFileSync(join(projectDir, 'index.html'), '<!doctype html>\n');
writeFileSync(join(projectDir, '.claude', 'settings.json'), '{}\n');
writeFileSync(join(siblingDir, 'other.txt'), 'hello\n');

/**
 * A deliberately un-alphabetic roster: nothing here would pass the old
 * ^[ABCDES]$ identity check.
 */
const manifest = {
  version: 1,
  artifacts: { 'plan.md': 'pat' },
  members: {
    pat: { slot: 'planner', write: 'artifact', bash: 'none', web: true, denyPhases: ['concept'] },
    rex: { slot: 'reviewer', write: 'none', bash: 'none', web: true, denyPhases: [] },
    reacty: { slot: 'coder', write: 'project', bash: 'safe', web: false, denyPhases: [] },
    tess: { slot: 'tester', write: 'none', bash: 'safe', web: false, denyPhases: [] },
    aud: { slot: 'auditor', write: 'none', bash: 'none', web: false, denyPhases: [] },
    sam: { slot: 'supervisor', write: 'builds', bash: 'safe', web: true, denyPhases: [] },
    // Capability edges that only exist in the roster world.
    trusted: { slot: '', write: 'project', bash: 'all', web: false, denyPhases: [] },
    cautious: { slot: '', write: 'project', bash: 'approval', web: false, denyPhases: [] },
    // A member whose manifest entry is nonsense; must not read as permissive.
    broken: { slot: '', write: 'everything', bash: 'all', web: true, denyPhases: [] },
  },
};

function writeManifest(data = manifest) {
  writeFileSync(manifestFile, JSON.stringify(data, null, 2));
}

function setPhase(phase) {
  writeFileSync(eventsFile, JSON.stringify({ currentPhase: phase }, null, 2));
}

writeManifest();

function invokeHook({ agent, toolName, toolInput = {}, cwd = projectDir, securityMode = 'fast' }) {
  const payload = JSON.stringify({
    tool_name: toolName,
    tool_input: toolInput,
    cwd,
  });

  const env = { ...process.env, HOME: tempHome, PIPELINE_SECURITY_MODE: securityMode };
  if (agent === undefined) {
    delete env.PIPELINE_AGENT;
  } else {
    env.PIPELINE_AGENT = agent;
  }

  const result = spawnSync('bash', [hookPath], { input: payload, encoding: 'utf8', env });

  return {
    status: result.status ?? -1,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function getDecision(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout)?.hookSpecificOutput?.permissionDecision ?? null;
  } catch {
    return null;
  }
}

function formatResult(result) {
  const parts = [];
  if (result.stdout) parts.push(`stdout=${JSON.stringify(result.stdout)}`);
  if (result.stderr) parts.push(`stderr=${JSON.stringify(result.stderr)}`);
  parts.push(`status=${result.status}`);
  return parts.join(' ');
}

function writeApprovedBashGrant(agent, command) {
  writeFileSync(
    approvedBashGrantFile,
    JSON.stringify(
      { requestId: 'test-grant', projectDir, agent, command, createdAt: new Date().toISOString() },
      null,
      2
    )
  );
}

const checks = [
  // ── Identity resolution ────────────────────────────────────────────
  {
    name: 'unknown member id is denied',
    expect: 'deny',
    run: () => invokeHook({ agent: 'ghost', toolName: 'Read', toolInput: { file_path: 'plan.md' } }),
  },
  {
    name: 'uppercase member id is rejected as malformed',
    expect: 'deny',
    run: () => invokeHook({ agent: 'Reacty', toolName: 'Read', toolInput: { file_path: 'plan.md' } }),
  },
  {
    name: 'path-traversal member id is rejected as malformed',
    expect: 'deny',
    run: () => invokeHook({ agent: '../../etc', toolName: 'Read', toolInput: { file_path: 'plan.md' } }),
  },
  {
    name: 'missing PIPELINE_AGENT is denied',
    expect: 'deny',
    run: () => invokeHook({ agent: undefined, toolName: 'Read', toolInput: { file_path: 'plan.md' } }),
  },
  {
    name: 'legacy single-letter agent is no longer trusted',
    expect: 'deny',
    run: () => invokeHook({ agent: 'c', toolName: 'Write', toolInput: { file_path: 'index.html', content: 'x' } }),
  },
  {
    name: 'project without a manifest fails closed',
    expect: 'deny',
    run: () => invokeHook({ agent: 'reacty', toolName: 'Read', toolInput: { file_path: 'x' }, cwd: bareDir }),
  },
  {
    name: 'unrecognised write level in manifest is denied, not treated as permissive',
    expect: 'deny',
    run: () => invokeHook({ agent: 'broken', toolName: 'Write', toolInput: { file_path: 'index.html', content: 'x' } }),
  },

  // ── Read-only tools ────────────────────────────────────────────────
  {
    name: 'planner can read plan.md',
    expect: 'allow',
    run: () => invokeHook({ agent: 'pat', toolName: 'Read', toolInput: { file_path: 'plan.md' } }),
  },
  {
    name: 'auditor can Glob',
    expect: 'allow',
    run: () => invokeHook({ agent: 'aud', toolName: 'Glob', toolInput: { pattern: '**/*.ts' } }),
  },
  {
    name: 'auditor can Grep',
    expect: 'allow',
    run: () => invokeHook({ agent: 'aud', toolName: 'Grep', toolInput: { pattern: 'eval' } }),
  },
  // Attaching a skill to a member did nothing while this was missing: the
  // fallthrough denies by default, so every member on every engine was refused
  // its own attached documentation. A real turn answered "the request was
  // blocked due to permission restrictions" rather than reading the skill.
  {
    name: 'a member can load an attached skill',
    expect: 'allow',
    run: () => invokeHook({ agent: 'pat', toolName: 'Skill', toolInput: { command: 'squad-pat:house-style' } }),
  },
  {
    name: 'even a read-only member can, because loading one grants nothing',
    expect: 'allow',
    run: () => invokeHook({ agent: 'aud', toolName: 'Skill', toolInput: { command: 'squad-aud:audit-checklist' } }),
  },
  {
    name: 'reviewer can use StructuredOutput',
    expect: 'allow',
    run: () => invokeHook({ agent: 'rex', toolName: 'StructuredOutput', toolInput: {} }),
  },

  // ── Web gating ─────────────────────────────────────────────────────
  {
    name: 'planner (web:true) can use WebSearch',
    expect: 'allow',
    run: () => invokeHook({ agent: 'pat', toolName: 'WebSearch', toolInput: { query: 'mdn canvas api' } }),
  },
  {
    name: 'reviewer (web:true) can use WebFetch',
    expect: 'allow',
    run: () => invokeHook({ agent: 'rex', toolName: 'WebFetch', toolInput: { url: 'https://example.com/' } }),
  },
  {
    name: 'coder (web:false) cannot use WebSearch',
    expect: 'deny',
    run: () => invokeHook({ agent: 'reacty', toolName: 'WebSearch', toolInput: { query: 'x' } }),
  },
  {
    name: 'auditor (web:false) cannot use WebFetch',
    expect: 'deny',
    run: () => invokeHook({ agent: 'aud', toolName: 'WebFetch', toolInput: { url: 'https://example.com/' } }),
  },

  // ── Write levels ───────────────────────────────────────────────────
  {
    name: 'planner can write the artifact it owns',
    expect: 'allow',
    run: () => invokeHook({ agent: 'pat', toolName: 'Write', toolInput: { file_path: 'plan.md', content: '# plan\n' } }),
  },
  {
    name: 'planner (write:artifact) cannot write other files',
    expect: 'deny',
    run: () => invokeHook({ agent: 'pat', toolName: 'Write', toolInput: { file_path: 'index.html', content: 'nope' } }),
  },
  {
    name: 'planner cannot write during a denied phase',
    expect: 'deny',
    run: () => {
      setPhase('concept');
      const result = invokeHook({ agent: 'pat', toolName: 'Write', toolInput: { file_path: 'plan.md', content: 'x' } });
      setPhase('planning');
      return result;
    },
  },
  {
    name: 'coder can write code in the project',
    expect: 'allow',
    run: () => invokeHook({ agent: 'reacty', toolName: 'Write', toolInput: { file_path: 'index.html', content: '<!doctype html>' } }),
  },
  {
    name: 'coder cannot write an artifact owned by another member',
    expect: 'deny',
    run: () => invokeHook({ agent: 'reacty', toolName: 'Write', toolInput: { file_path: 'plan.md', content: 'nope' } }),
  },
  {
    name: 'reviewer (write:none) cannot write files',
    expect: 'deny',
    run: () => invokeHook({ agent: 'rex', toolName: 'Write', toolInput: { file_path: 'index.html', content: 'nope' } }),
  },
  {
    name: 'tester (write:none) cannot edit files',
    expect: 'deny',
    run: () => invokeHook({ agent: 'tess', toolName: 'Edit', toolInput: { file_path: 'index.html', old_string: 'a', new_string: 'b' } }),
  },
  {
    name: 'auditor (write:none) cannot write files',
    expect: 'deny',
    run: () => invokeHook({ agent: 'aud', toolName: 'Write', toolInput: { file_path: 'index.html', content: 'nope' } }),
  },

  // ── The jail ───────────────────────────────────────────────────────
  {
    name: 'coder cannot write to a sibling project',
    expect: 'deny',
    run: () => invokeHook({ agent: 'reacty', toolName: 'Write', toolInput: { file_path: join(siblingDir, 'other.txt'), content: 'nope' } }),
  },
  {
    name: 'supervisor (write:builds) can write to a sibling project',
    expect: 'allow',
    run: () => invokeHook({ agent: 'sam', toolName: 'Write', toolInput: { file_path: join(siblingDir, 'other.txt'), content: 'ok' } }),
  },
  {
    name: 'supervisor cannot write outside ~/Builds',
    expect: 'deny',
    run: () => invokeHook({ agent: 'sam', toolName: 'Write', toolInput: { file_path: join(tempHome, 'escape.txt'), content: 'nope' } }),
  },
  {
    name: 'project-write member cannot touch .claude/',
    expect: 'deny',
    run: () => invokeHook({ agent: 'reacty', toolName: 'Write', toolInput: { file_path: join(projectDir, '.claude', 'settings.json'), content: '{}' } }),
  },
  {
    name: 'no member can rewrite the team manifest',
    expect: 'deny',
    run: () => invokeHook({ agent: 'sam', toolName: 'Write', toolInput: { file_path: manifestFile, content: '{}' } }),
  },
  {
    name: 'no member can rewrite the hook itself',
    expect: 'deny',
    run: () => invokeHook({ agent: 'reacty', toolName: 'Write', toolInput: { file_path: join(projectDir, '.claude', 'hooks', 'approval-gate.sh'), content: '#!/bin/bash\nexit 0' } }),
  },

  // ── Shared-memory inbox ────────────────────────────────────────────
  {
    name: 'a read-only member can drop a memory entry',
    expect: 'allow',
    run: () =>
      invokeHook({
        agent: 'rex',
        toolName: 'Write',
        toolInput: { file_path: join(memoryInbox, 'rex-1234.md'), content: '---\nclaim: x\n---\n' },
      }),
  },
  {
    name: 'the coder can drop a memory entry too',
    expect: 'allow',
    run: () =>
      invokeHook({
        agent: 'reacty',
        toolName: 'Write',
        toolInput: { file_path: join(memoryInbox, 'reacty-1234.md'), content: 'x' },
      }),
  },
  {
    name: 'memory entries cannot be Edited, only written',
    expect: 'deny',
    run: () =>
      invokeHook({
        agent: 'rex',
        toolName: 'Edit',
        toolInput: { file_path: join(memoryInbox, 'rex-1234.md'), old_string: 'a', new_string: 'b' },
      }),
  },
  {
    name: 'the memory inbox rejects non-markdown files',
    expect: 'deny',
    run: () =>
      invokeHook({
        agent: 'rex',
        toolName: 'Write',
        toolInput: { file_path: join(memoryInbox, 'payload.sh'), content: '#!/bin/bash' },
      }),
  },
  {
    name: 'the memory inbox rejects nested paths',
    expect: 'deny',
    run: () =>
      invokeHook({
        agent: 'rex',
        toolName: 'Write',
        toolInput: { file_path: join(memoryInbox, 'nested', 'deep.md'), content: 'x' },
      }),
  },
  {
    name: 'the memory index itself is not writable by members',
    expect: 'deny',
    run: () =>
      invokeHook({
        agent: 'rex',
        toolName: 'Write',
        toolInput: { file_path: join(projectDir, '.squad', 'memory', 'index.md'), content: 'forged' },
      }),
  },
  {
    name: 'a read-only member still cannot write outside the inbox',
    expect: 'deny',
    run: () => invokeHook({ agent: 'rex', toolName: 'Write', toolInput: { file_path: 'index.html', content: 'nope' } }),
  },

  // ── Bash levels ────────────────────────────────────────────────────
  {
    name: 'planner (bash:none) cannot run commands',
    expect: 'deny',
    run: () => invokeHook({ agent: 'pat', toolName: 'Bash', toolInput: { command: 'pwd' } }),
  },
  {
    name: 'reviewer (bash:none) cannot run commands',
    expect: 'deny',
    run: () => invokeHook({ agent: 'rex', toolName: 'Bash', toolInput: { command: 'pwd' } }),
  },
  {
    name: 'auditor (bash:none) cannot run commands',
    expect: 'deny',
    run: () => invokeHook({ agent: 'aud', toolName: 'Bash', toolInput: { command: 'pwd' } }),
  },
  {
    name: 'coder (bash:safe) can run Bash in fast mode',
    expect: 'allow',
    run: () => invokeHook({ agent: 'reacty', toolName: 'Bash', toolInput: { command: 'pwd' }, securityMode: 'fast' }),
  },
  {
    name: 'coder (bash:safe) escalates to ask in strict mode',
    expect: 'ask',
    run: () => invokeHook({ agent: 'reacty', toolName: 'Bash', toolInput: { command: 'pwd' }, securityMode: 'strict' }),
  },
  {
    name: 'approved Bash grant runs once in strict mode',
    expect: 'allow',
    run: () => {
      writeApprovedBashGrant('reacty', 'pwd');
      return invokeHook({ agent: 'reacty', toolName: 'Bash', toolInput: { command: 'pwd' }, securityMode: 'strict' });
    },
  },
  {
    name: 'approved Bash grant is consumed after one use',
    expect: 'ask',
    run: () => invokeHook({ agent: 'reacty', toolName: 'Bash', toolInput: { command: 'pwd' }, securityMode: 'strict' }),
  },
  {
    name: 'a grant issued to another member is not honoured',
    expect: 'ask',
    run: () => {
      writeApprovedBashGrant('tess', 'pwd');
      const result = invokeHook({ agent: 'reacty', toolName: 'Bash', toolInput: { command: 'pwd' }, securityMode: 'strict' });
      rmSync(approvedBashGrantFile, { force: true });
      return result;
    },
  },
  {
    name: 'bash:approval asks even in fast mode',
    expect: 'ask',
    run: () => invokeHook({ agent: 'cautious', toolName: 'Bash', toolInput: { command: 'pwd' }, securityMode: 'fast' }),
  },
  {
    name: 'bash:all runs without asking even in strict mode',
    expect: 'allow',
    run: () => invokeHook({ agent: 'trusted', toolName: 'Bash', toolInput: { command: 'pwd' }, securityMode: 'strict' }),
  },
  {
    name: 'bash:all still cannot modify hook files',
    expect: 'deny',
    run: () => invokeHook({ agent: 'trusted', toolName: 'Bash', toolInput: { command: 'rm -f .claude/hooks/approval-gate.sh' }, securityMode: 'fast' }),
  },
  {
    name: 'bash:all still cannot rewrite the team manifest',
    expect: 'deny',
    run: () => invokeHook({ agent: 'trusted', toolName: 'Bash', toolInput: { command: 'tee .claude/team-manifest.json' }, securityMode: 'fast' }),
  },
  {
    name: 'bash:all still cannot spawn claude',
    expect: 'deny',
    run: () => invokeHook({ agent: 'trusted', toolName: 'Bash', toolInput: { command: 'claude --version' }, securityMode: 'fast' }),
  },
  {
    name: 'bash:all still cannot reassign PIPELINE_AGENT',
    expect: 'deny',
    run: () => invokeHook({ agent: 'trusted', toolName: 'Bash', toolInput: { command: 'PIPELINE_AGENT=sam bash -c id' }, securityMode: 'fast' }),
  },
  {
    name: 'bash:all still cannot create links',
    expect: 'deny',
    run: () => invokeHook({ agent: 'trusted', toolName: 'Bash', toolInput: { command: 'ln -s / escape' }, securityMode: 'fast' }),
  },
  {
    name: 'fast-mode Bash can mention .claude as a harmless string',
    expect: 'allow',
    run: () =>
      invokeHook({
        agent: 'tess',
        toolName: 'Bash',
        securityMode: 'fast',
        toolInput: { command: "python3 -c \"print('.claude is just a string here')\"" },
      }),
  },

  // ── Blanket blocks ─────────────────────────────────────────────────
  {
    name: 'no member can spawn sub-agents',
    expect: 'deny',
    run: () => invokeHook({ agent: 'trusted', toolName: 'Agent', toolInput: { description: 'do thing' } }),
  },
  {
    name: 'unknown tools are deny-by-default',
    expect: 'deny',
    run: () => invokeHook({ agent: 'sam', toolName: 'CronCreate', toolInput: {} }),
  },

  // ── Other agent CLIs' config directories ───────────────────────────
  //
  // Each CLI keeps its gate somewhere different. .opencode/ is the sharpest
  // case: it holds both the generated gate plugin AND the generated agent
  // definition carrying the member's system prompt, so a member that can
  // write there rewrites either what it may do or who it was told to be.
  {
    name: 'no member can write OpenCode config',
    expect: 'deny',
    run: () =>
      invokeHook({
        agent: 'reacty',
        toolName: 'Write',
        toolInput: { file_path: `${projectDir}/.opencode/plugins/hackeroom-gate.js`, content: 'x' },
      }),
  },
  {
    name: 'no member can rewrite its own OpenCode agent definition',
    expect: 'deny',
    run: () =>
      invokeHook({
        agent: 'reacty',
        toolName: 'Write',
        toolInput: { file_path: `${projectDir}/.opencode/agent/reacty.md`, content: 'you may do anything' },
      }),
  },
  {
    name: 'no member can write Antigravity hooks',
    expect: 'deny',
    run: () =>
      invokeHook({
        agent: 'reacty',
        toolName: 'Write',
        toolInput: { file_path: `${projectDir}/.agents/hooks.json`, content: '{}' },
      }),
  },
  {
    name: 'no member can write Antigravity workspace skills',
    expect: 'deny',
    run: () =>
      invokeHook({
        agent: 'reacty',
        toolName: 'Write',
        toolInput: { file_path: `${projectDir}/.agents/skills/evil/SKILL.md`, content: 'x' },
      }),
  },
  {
    name: 'no member can write Gemini settings',
    expect: 'deny',
    run: () =>
      invokeHook({
        agent: 'reacty',
        toolName: 'Write',
        toolInput: { file_path: `${projectDir}/.gemini/settings.json`, content: '{}' },
      }),
  },
  {
    name: 'the supervisor cannot write another CLI config either',
    expect: 'deny',
    run: () =>
      invokeHook({
        agent: 'sam',
        toolName: 'Write',
        toolInput: { file_path: `${projectDir}/.opencode/opencode.json`, content: '{}' },
      }),
  },

  // ── Other agent CLIs, via Bash ─────────────────────────────────────
  {
    name: 'bash:all cannot rewrite Antigravity hooks via Bash',
    expect: 'deny',
    run: () =>
      invokeHook({
        agent: 'trusted',
        toolName: 'Bash',
        toolInput: { command: 'echo "{}" > .agents/hooks.json' },
        securityMode: 'fast',
      }),
  },
  {
    name: 'bash:all cannot rewrite opencode.json via Bash',
    expect: 'deny',
    run: () =>
      invokeHook({
        agent: 'trusted',
        toolName: 'Bash',
        toolInput: { command: 'tee opencode.json' },
        securityMode: 'fast',
      }),
  },
  {
    name: 'bash:all cannot read out a CLI auth file',
    expect: 'deny',
    run: () =>
      invokeHook({
        agent: 'trusted',
        toolName: 'Bash',
        toolInput: { command: 'cp auth.json /tmp/stolen' },
        securityMode: 'fast',
      }),
  },

  // A member that spawns its own agent session escapes the gate outright:
  // the new process is not the one the manifest describes. Blocking only
  // `claude` would have left that hole open the moment a second CLI landed.
  {
    name: 'bash:all cannot spawn opencode',
    expect: 'deny',
    run: () =>
      invokeHook({
        agent: 'trusted',
        toolName: 'Bash',
        toolInput: { command: 'opencode run "do whatever you like"' },
        securityMode: 'fast',
      }),
  },
  {
    name: 'bash:all cannot spawn agy',
    expect: 'deny',
    run: () =>
      invokeHook({
        agent: 'trusted',
        toolName: 'Bash',
        toolInput: { command: 'agy -p "do whatever you like"' },
        securityMode: 'fast',
      }),
  },
  {
    name: 'bash:all cannot spawn agy with --dangerously-skip-permissions',
    expect: 'deny',
    run: () =>
      invokeHook({
        agent: 'trusted',
        toolName: 'Bash',
        toolInput: { command: 'agy --dangerously-skip-permissions -p x' },
        securityMode: 'fast',
      }),
  },

  // The widened patterns must not start blocking ordinary work. These are
  // the false positives the clamp is deliberately narrow to avoid.
  {
    name: 'fast-mode Bash can still mention opencode as a harmless string',
    expect: 'allow',
    run: () =>
      invokeHook({
        agent: 'tess',
        toolName: 'Bash',
        securityMode: 'fast',
        toolInput: { command: "python3 -c \"print('opencode and agy are just words')\"" },
      }),
  },
  {
    name: 'fast-mode Bash can still run a normal build',
    expect: 'allow',
    run: () =>
      invokeHook({
        agent: 'tess',
        toolName: 'Bash',
        securityMode: 'fast',
        toolInput: { command: 'npm run build' },
      }),
  },
  {
    name: 'a member can still write an ordinary dotfile',
    expect: 'allow',
    run: () =>
      invokeHook({
        agent: 'reacty',
        toolName: 'Write',
        toolInput: { file_path: `${projectDir}/.gitignore`, content: 'node_modules\n' },
      }),
  },
];

let failures = 0;

for (const check of checks) {
  const result = check.run();
  const decision = getDecision(result.stdout);

  let passed = false;
  if (check.expect === 'allow') passed = decision === 'allow';
  if (check.expect === 'ask') passed = decision === 'ask';
  if (check.expect === 'deny') passed = result.status === 2;

  if (passed) {
    console.log(`PASS ${check.name}`);
  } else {
    failures++;
    console.error(`FAIL ${check.name}`);
    console.error(`  expected=${check.expect} actualDecision=${decision ?? 'none'} ${formatResult(result)}`);
  }
}

rmSync(tempRoot, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\nHook contract failed: ${failures} check(s) failed.`);
  process.exit(1);
}

console.log(`\nHook contract passed: ${checks.length} check(s).`);
