#!/usr/bin/env node

/**
 * Run the gate as it is now and the gate as it was on the same tool calls, and
 * print every call they judge differently.
 *
 * Run manually. It spends nothing and touches nothing outside a temporary
 * HOME, but it is slow (about 2,500 calls through each gate) and its output is
 * for reading, so it is not part of `npm test`.
 *
 *   node scripts/probe-gate-diff.mjs                 the shell gate from before the Node port
 *   node scripts/probe-gate-diff.mjs <rev>           the gate at any commit, e.g. main or HEAD~3
 *   node scripts/probe-gate-diff.mjs <file>          a gate file kept somewhere else
 *
 * Why it exists: the contract suite says what the gate must do in the cases
 * someone thought of. A rewrite, or a change to how paths are resolved, can
 * move the answer in cases nobody thought of, and those are found by asking
 * two versions the same questions. Run against the shell gate after the port
 * to Node, it found a refusal of ".." that join() had normalised away, a
 * backslash read as a separator on POSIX, and a hole the first fix for new
 * directories had itself opened on case-sensitive filesystems.
 *
 * How to read the output. A difference is not a failure: a change to the gate
 * is supposed to change some answers. The section that matters is the first,
 * "refused before, allowed now". Every line in it should be something the
 * change meant to allow. Anything else there is a hole.
 *
 * Needs: git history (the old gate is read with `git show`; a shallow clone
 * may not have it). The shell gate (.sh) also needs bash and jq, so comparing
 * against it works on Linux and macOS only.
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE_DIR = 'pipeline/.claude/hooks';
const newGate = join(repoRoot, GATE_DIR, 'approval-gate.mjs');

/** The last commit that still had the shell gate: the parent of the port to Node. */
const SHELL_GATE = '1da398b^';

function fail(message) {
  console.error(`*** ${message}`);
  process.exit(1);
}

/**
 * The gate to compare against, as a file on disk. A revision is read out of
 * git into `into`; whichever of the two gate files that commit had is used.
 */
function oldGateFile(arg, into) {
  if (/\.(sh|mjs)$/.test(arg)) return resolve(arg);
  for (const name of ['approval-gate.mjs', 'approval-gate.sh']) {
    try {
      const text = execFileSync('git', ['-C', repoRoot, 'show', `${arg}:${GATE_DIR}/${name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const file = join(into, `old-${name}`);
      writeFileSync(file, text, { mode: 0o755 });
      return file;
    } catch {
      // Not at that commit under this name; try the other.
    }
  }
  return fail(`No gate found at "${arg}". It has to be a commit this clone has (a shallow clone may not), or a path to a .sh or .mjs gate.`);
}

function world() {
  const root = mkdtempSync(join(tmpdir(), 'gate-diff-'));
  const home = join(root, 'home');
  const builds = join(home, 'Builds');
  const proj = join(builds, 'proj');
  const sib = join(builds, 'sibling');
  const outside = join(home, 'outside');
  for (const dir of [
    join(proj, '.claude', 'hooks'),
    join(proj, '.squad', 'memory', 'inbox'),
    join(proj, 'src'),
    join(proj, 'Dir With Space'),
    join(sib, '.claude'),
    outside,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  const manifest = {
    version: 1,
    artifacts: { 'plan.md': 'pat' },
    members: {
      cody: { slot: 'coder', write: 'project', bash: 'safe', web: false, denyPhases: ['concept'] },
      allie: { slot: 'coder', write: 'project', bash: 'all', web: true },
      sam: { slot: 'supervisor', write: 'builds', bash: 'approval', web: false },
      rex: { slot: 'reviewer', write: 'none', bash: 'none', web: false },
      pat: { slot: 'planner', write: 'artifact', bash: 'none', web: true },
    },
  };
  writeFileSync(join(proj, '.claude', 'team-manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(proj, 'pipeline-events.json'), JSON.stringify({ currentPhase: 'coding' }));
  writeFileSync(join(sib, 'pipeline-events.json'), JSON.stringify({ currentPhase: 'coding' }));
  writeFileSync(join(proj, 'index.html'), 'x');
  writeFileSync(join(proj, 'plan.md'), 'x');
  writeFileSync(join(proj, 'src', 'a.js'), 'x');
  writeFileSync(join(outside, 'target.txt'), 'x');
  // As in the contract suite: Windows hands out junctions freely but wants a
  // privilege for a true symlink, so the links that stand for directories are
  // junctions there (the type is ignored elsewhere). A link to a file has no
  // such form. Without it those paths are plain missing files, which both
  // gates still judge, just not as links.
  symlinkSync(outside, join(proj, 'outlink'), 'junction');
  symlinkSync(sib, join(proj, 'siblink'), 'junction');
  symlinkSync(join(home, 'nowhere'), join(proj, 'dangling'), 'junction');
  symlinkSync(join(proj, '.claude'), join(proj, 'cfg'), 'junction');
  try {
    symlinkSync(join(outside, 'not-there-yet.txt'), join(proj, 'danglefile'), 'file');
    symlinkSync(join(outside, 'target.txt'), join(proj, 'filelink'), 'file');
    symlinkSync(join(proj, 'index.html'), join(proj, 'innerlink'), 'file');
  } catch (error) {
    if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
    console.error('*** This Windows account cannot create symlinks to files; danglefile, filelink and innerlink are tested as paths that do not exist.');
  }
  return { root, home, builds, proj, sib, outside };
}

/** One tool call through one gate: 'allow', 'ask', 'deny', or what went wrong. */
function run(gate, w, member, mode, payload) {
  return new Promise((done) => {
    const child = spawn(gate.endsWith('.sh') ? 'bash' : process.execPath, [gate], {
      cwd: w.proj,
      env: { PATH: process.env.PATH, HOME: w.home, PIPELINE_AGENT: member, PIPELINE_SECURITY_MODE: mode },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      done(`error:${error.code ?? error.message}`);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      if (signal) return done('TIMEOUT');
      if (status === 2) return done('deny');
      if (status !== 0) return done(`exit${status}`);
      try {
        done(JSON.parse(stdout).hookSpecificOutput.permissionDecision);
      } catch {
        done('unreadable');
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

// ── The two gates ────────────────────────────────────────────────────

const scratch = mkdtempSync(join(tmpdir(), 'gate-diff-old-'));
const oldGate = oldGateFile(process.argv[2] ?? SHELL_GATE, scratch);
if (oldGate.endsWith('.sh')) {
  if (process.platform === 'win32') fail('The shell gate needs bash and jq, so it cannot be compared on Windows. Give a commit that has approval-gate.mjs instead.');
  for (const tool of ['bash', 'jq']) {
    try {
      execFileSync(tool, ['--version'], { stdio: 'ignore' });
    } catch {
      fail(`The shell gate needs ${tool}, which is not on PATH.`);
    }
  }
}
console.error(`old: ${process.argv[2] ?? SHELL_GATE}  (${oldGate.endsWith('.sh') ? 'shell' : 'Node'} gate)`);
console.error(`new: ${GATE_DIR}/approval-gate.mjs as it is in this tree`);

// ── A project to judge them in ───────────────────────────────────────

const w = world();
const P = w.proj;

const paths = [
  // ordinary
  'a.txt', './a.txt', 'src/b.js', 'src//b.js', 'src/./b.js', './src/b.js', 'src/', 'src', '.', '', ' ', 'index.html',
  join(P, 'a.txt'), join(P, 'src', 'b.js'), `${P}//a.txt`, `${P}/./a.txt`, `${P}/`, P, `${P}/src/../a.txt`, '../sibling/x.txt', 'a..b.txt',
  'Dir With Space/x.txt', 'a b.txt', 'tab\there.txt', 'new\nline.txt', 'ünï.txt', '-rf', '~/x.txt', '$HOME/x.txt', '.gitignore', '.env',
  // outside and siblings
  join(w.sib, 'x.txt'), join(w.builds, 'x.txt'), join(w.builds, 'newproj', 'x.txt'), join(w.home, 'x.txt'), join(w.outside, 'x.txt'), '/etc/passwd', '/tmp/x.txt',
  join(w.builds, 'proj2', 'x.txt'), `${w.builds}/projX`, `${w.builds}/proj.txt`, `${P}x/y.txt`,
  join(w.builds.toUpperCase(), 'proj', 'a.txt'), join(P.toUpperCase(), 'a.txt'),
  // symlinks
  'outlink/x.txt', 'siblink/x.txt', 'dangling/x.txt', 'danglefile', 'filelink', 'innerlink', 'cfg/settings.json', 'cfg', 'outlink', 'siblink/pipeline-events.json',
  // config dirs
  '.claude/settings.json', '.claude/hooks/approval-gate.mjs', '.claude', '.CLAUDE/settings.json', '.Claude/x', 'src/.claude/x', '.claudex/x', 'x.claude/y', '.claude.bak/x',
  '.opencode/agent/x.md', '.agents/hooks.json', '.gemini/settings.json', '.OpenCode/x', 'a/.agents', '.agentsx', join(w.sib, '.claude', 'team-manifest.json'),
  // control files
  'pipeline-events.json', 'pipeline-pending.json', 'pipeline-approved-bash.json', 'Pipeline-Approved-Bash.JSON', 'pipeline-events.json.bak', 'pipeline-.json',
  'pipeline-x.json', 'src/pipeline-config.json', 'pipeline.json', 'xpipeline-events.json', 'pipeline-events.jsonl', 'pipeline-events.1.json',
  join(w.sib, 'pipeline-pending.json'), join(w.sib, 'src', 'pipeline-x.json'), join(w.builds, 'pipeline-x.json'),
  // memory inbox
  '.squad/memory/inbox/note.md', '.squad/memory/inbox/note.txt', '.squad/memory/inbox/sub/note.md', '.squad/memory/inbox/.md', '.squad/memory/inbox/a b.md',
  '.squad/memory/inbox', '.squad/memory/index.md', '.squad/memory/inbox/NOTE.MD', '.SQUAD/memory/inbox/note.md', '.squad/memory/inbox/a.md.txt', '.squad/memory/inboxx/a.md',
  join(w.sib, '.squad', 'memory', 'inbox', 'a.md'),
  // artifact
  'plan.md', 'PLAN.md', 'Plan.md', 'src/plan.md', 'plan.md.bak', 'plan2.md', join(w.sib, 'plan.md'),
  // backslashes (an ordinary character in a POSIX name)
  'a\\b.txt', 'src\\b.js', '.claude\\settings.json', `${w.builds}/proj\\evil.txt`, `${w.builds}/proj\\sub/evil.txt`, `${P}\\..\\sibling\\x.txt`,
  '.squad/memory/inbox\\a.md', '.squad\\memory\\inbox\\a.md', 'pipeline-events.json\\x', `${w.builds}/sibling\\..\\proj/a.txt`,
  // .. after a symlink: the text says inside, the filesystem says outside
  'outlink/../x.txt', 'siblink/../x.txt', 'src/../a.txt', './../proj/a.txt', 'outlink/../../etc-x.txt', 'cfg/../a.txt', 'cfg/../.claude/settings.json',
  `${w.builds}/proj\\sub/evil.txt`, `${w.builds}/proj\\.claude/settings.json`,
  // new directories (the fix in pull request 14 changes these on purpose)
  'newdir/x.txt', 'a/b/c/d.txt', 'src/new/x.js', 'newdir/./x.txt', 'index.html/x.js', 'newdir/.claude/x', 'outlink/new/x.txt', join(w.sib, 'new', 'x.txt'),
];

const commands = [
  '', ' ', 'ls', 'ls -la', 'npm test', 'npm run build', 'node index.js', 'echo hello', 'cat index.html', 'git status', 'pwd',
  // config-dir mutation and near misses
  'rm -rf .claude', 'rm -rf .claude/', 'rm .claude/settings.json', 'RM -RF .CLAUDE', 'Rm .Claude/x', 'cat .claude/settings.json', 'ls .claude', 'grep x .claude/y',
  'echo .claude', "python3 -c \"print('.claude')\"", 'mkdir .claude2', 'mkdir -p public/js test && ls -la && cat .claude/hooks/approval-gate.sh', 'touch a; ls .claude',
  'cp a .opencode/x', 'mv a .agents/hooks.json', 'chmod 777 .gemini', 'sed -i s/a/b/ settings.json', 'tee hooks.json', 'echo x > .claude/x', 'echo x >> settings.json',
  'cat < .claude/x', 'sort < opencode.json', 'echo hi > out.txt', 'cat plugin.json', 'rm auth.json', 'rm author.json', 'rm my-settings.json', 'mkdir hooks/', 'mkdir webhooks/',
  'rm approval-gate', 'rm approval-gate.sh', 'rm approval-gate.mjs', 'cat approval-gate.mjs', 'echo ok;rm .claude', 'echo ok&&rm .claude', 'echo ok|tee .claude/x', 'xrm .claude',
  'rmdir .claude', 'chown me team-manifest.json', 'vim .claude/settings.json', 'node -e "require(\'fs\').rmSync(\'.claude\')"', 'rm\t.claude', 'rm\n.claude',
  'echo a\nrm .claude/x', 'echo a\r\nrm .claude/x\r\n', 'rm -rf "$D"/.claude', 'rm x && echo .claude', 'firm .claude', 'rm .claude x', 'rm .claude', 'rm .claudefoo',
  'rm .claude\u0000x', 'rm .cl\u0000aude/x', 'echo \u0000', 'rm .claude x', 'ｒｍ .claude',
  // run files
  'rm pipeline-events.json', 'cat pipeline-events.json', 'jq .currentPhase pipeline-events.json', 'jq . < pipeline-events.json', 'echo {} > pipeline-pending.json',
  'echo {} >pipeline-approved-bash.json', 'echo {} >| pipeline-events.json', 'echo {} >& pipeline-events.json', "echo {} > 'pipeline-events.json'", 'echo {} > "./pipeline-events.json"',
  'cat pipeline-events.json > /tmp/e.json', 'cat pipeline-events.json | jq . > usage.json', 'truncate -s0 pipeline-events.json', 'dd of=pipeline-pending.json', 'rm pipeline-events.1.json',
  'rm src/pipeline-config.json', 'touch pipeline-approved.json', 'RM PIPELINE-EVENTS.JSON', 'python3 -c "open(\'pipeline-pending.json\',\'w\')"', 'echo x 2> pipeline-events.json',
  'echo x > a ; cat pipeline-events.json', 'cp pipeline-events.json /tmp/', 'echo x >\npipeline-events.json', 'echo x > $F',
  // globs on dot-files
  'rm .c*', 'mv .cl* x', 'cp .* /tmp', 'rm *.txt', 'rm a.txt b*', 'rm -rf node_modules/.cache/*', 'ls .c*', 'rm .env', 'mv .env .env.bak', 'cp .gitignore x', 'rm -f .DS_Store',
  'rm -rf ./build', 'rm ./a.txt', 'rm -rf dist', 'echo "rm ."', 'git rm .gitignore', 'npm rm .x', 'rm -- .x', 'rm\t.env', 'RM .env', 'cp a.txt b.txt', 'cp src/*.js out/',
  'mv a.b c*', 'echo cp . then *', 'rm -r a .', 'rm -ra', 'echo mv .\nrm x',
  // links
  'ln -s a b', 'ln a b', 'echo;ln -s a b', 'a&&ln -s a b', 'x|ln -s', '$(ln -s a b)', '`ln -s a b`', 'println hello', 'echo "println "', 'kotlin run', 'lnx a', 'ln\t-s a b',
  'cp -s a b', 'python3 -c "import os; os.symlink(\'/etc\',\'x\')"', 'LN -s a b', '/bin/ln -s a b', 'ln', 'ln\n-s a b', 'ls --ln ', 'mvn clean ',
  // agent CLIs and identity
  'claude -p hi', 'claude --version', 'claude', 'Claude -p hi', 'echo claude - rocks', 'opencode run x', 'opencode -v', 'opencode', 'echo opencode is a word', 'agy -x', 'agy',
  'foggy -day', 'PIPELINE_AGENT=sam ls', 'echo $PIPELINE_AGENT', 'export pipeline_agent=x', 'env | grep PIPELINE', 'npx claude -p', 'claude\t-p', '/usr/local/bin/claude -p x',
  'npx @anthropic-ai/claude-code -p hi', 'echo "opencode  run"', 'OPENCODE RUN',
];

const tools = [
  { tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } },
  { tool_name: 'Glob', tool_input: {} },
  { tool_name: 'Grep', tool_input: {} },
  { tool_name: 'Skill', tool_input: {} },
  { tool_name: 'ToolSearch', tool_input: {} },
  { tool_name: 'StructuredOutput', tool_input: {} },
  { tool_name: 'Agent', tool_input: {} },
  { tool_name: 'Task', tool_input: {} },
  { tool_name: 'WebFetch', tool_input: {} },
  { tool_name: 'WebSearch', tool_input: {} },
  { tool_name: 'Foo', tool_input: {} },
  { tool_name: 'read', tool_input: {} },
  { tool_name: 'READ', tool_input: {} },
  { tool_name: 'Write' },
  { tool_name: 'Write', tool_input: null },
  { tool_name: 'Write', tool_input: 'x' },
  { tool_name: 'Write', tool_input: { file_path: null } },
  { tool_name: 'Write', tool_input: { file_path: 5 } },
  { tool_name: 'Write', tool_input: { file_path: ['a.txt'] } },
  { tool_name: 'Write', tool_input: { path: 'a.txt' } },
  { tool_name: 'Bash' },
  { tool_name: 'Bash', tool_input: {} },
  { tool_name: 'Bash', tool_input: { command: null } },
  { tool_name: 'Bash', tool_input: { command: ['rm', '.claude'] } },
  { tool_name: 'Bash', tool_input: { command: 7 } },
  { tool_name: 'Bash', tool_input: { cmd: 'ls' } },
  { tool_name: '' },
  { tool_name: null },
  { tool_name: 5 },
  { tool_input: {} },
  {},
];

const raw = ['', ' ', 'not json', '[]', 'null', '"Write"', '{"tool_name":"Read"', '{"tool_name":"Read"}\n{"tool_name":"Agent"}'];

const members = ['cody', 'allie', 'sam', 'rex', 'pat', 'ghost', '', '../x', 'CODY'];
const cases = [];

for (const member of ['cody', 'allie', 'sam', 'rex', 'pat']) {
  for (const toolName of ['Write', 'Edit', 'NotebookEdit']) {
    if (toolName === 'NotebookEdit' && member !== 'cody') continue;
    for (const file_path of paths) cases.push({ member, mode: 'fast', label: `${toolName} ${JSON.stringify(file_path)}`, payload: { tool_name: toolName, tool_input: { file_path }, cwd: P } });
  }
}
for (const member of ['cody', 'allie', 'sam', 'rex']) {
  for (const mode of ['fast', 'strict']) {
    if (mode === 'strict' && member !== 'cody') continue;
    for (const command of commands) cases.push({ member, mode, label: `Bash ${JSON.stringify(command)}`, payload: { tool_name: 'Bash', tool_input: { command }, cwd: P } });
  }
}
for (const member of members) {
  for (const tool of tools) cases.push({ member, mode: 'fast', label: `payload ${JSON.stringify(tool)}`, payload: { ...tool, cwd: P } });
}
for (const text of raw) cases.push({ member: 'cody', mode: 'fast', label: `raw ${JSON.stringify(text)}`, payload: text });
// A working directory below the root, and one outside any project.
for (const [cwd, name] of [[join(P, 'src'), 'src'], [w.outside, 'outside'], [w.sib, 'sibling']]) {
  for (const file_path of ['a.txt', '../a.txt', 'x/y.txt', join(P, 'a.txt')]) {
    for (const member of ['cody', 'sam']) cases.push({ member, mode: 'fast', label: `Write ${JSON.stringify(file_path)} from cwd=${name}`, payload: { tool_name: 'Write', tool_input: { file_path }, cwd } });
  }
}

// ── Run both gates, a few calls at a time ────────────────────────────

const results = new Array(cases.length);
let next = 0;
async function worker() {
  while (next < cases.length) {
    const index = next++;
    const c = cases[index];
    const [before, after] = await Promise.all([run(oldGate, w, c.member, c.mode, c.payload), run(newGate, w, c.member, c.mode, c.payload)]);
    results[index] = { ...c, before, after };
    if ((index + 1) % 500 === 0) console.error(`  ${index + 1} of ${cases.length}`);
  }
}
await Promise.all(Array.from({ length: Math.min(8, availableParallelism()) }, worker));

rmSync(w.root, { recursive: true, force: true });
rmSync(scratch, { recursive: true, force: true });

// ── Report ───────────────────────────────────────────────────────────

const differ = results.filter((r) => r.before !== r.after);
const line = (r) => `  [${r.member || "''"}/${r.mode}] ${r.label}`.replaceAll(w.root, '<tmp>');
const section = (title, rows) => {
  console.log(`\n${title}: ${rows.length}`);
  for (const text of rows.map(line).sort()) console.log(text);
};

console.log(`\n${results.length} tool calls: ${results.length - differ.length} judged the same, ${differ.length} differently.`);
const loosened = differ.filter((r) => r.before === 'deny' && r.after !== 'deny');
const tightened = differ.filter((r) => r.after === 'deny' && r.before !== 'deny');
const other = differ.filter((r) => !loosened.includes(r) && !tightened.includes(r));
section('REFUSED BEFORE, ALLOWED NOW - read every line', loosened);
section('Allowed before, refused now', tightened);
if (other.length > 0) {
  console.log(`\nOther differences: ${other.length}`);
  for (const r of other) console.log(`${line(r)}   (${r.before} -> ${r.after})`);
}
