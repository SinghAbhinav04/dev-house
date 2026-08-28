#!/usr/bin/env node

/**
 * OpenCode gate shim.
 *
 * Translates a `tool.execute.before` call into approval-gate.sh's contract and
 * back. It decides nothing itself: one set of rules, one manifest, one contract
 * suite — a second implementation would be a second thing to drift.
 *
 * Reads a request on stdin and answers on stdout:
 *
 *   in   {"tool":"write","args":{"filePath":"...","content":"..."},"cwd":"..."}
 *   out  {"allow":true}  |  {"allow":false,"reason":"BLOCKED: ..."}
 *
 * The generated plugin calls this and throws when `allow` is false, because
 * throwing is how OpenCode blocks a tool.
 *
 * FAIL CLOSED. The gate reads a path out of the arguments to judge a write; a
 * key that does not exist yields undefined. Everything that would hand the gate
 * a path checks it has one first, so a wrong or renamed key denies the call
 * rather than passing an empty value the gate would resolve to the project root
 * and allow.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'approval-gate.sh');

/** Tools whose verdict needs no argument: the gate decides on the name alone. */
const ARGLESS = new Map([
  ['read', 'Read'],
  ['glob', 'Glob'],
  ['list', 'Glob'],
  ['grep', 'Grep'],
  ['webfetch', 'WebFetch'],
  ['task', 'Agent'],
]);

/** Tools whose verdict depends on a path or a command. */
const PATH_TOOLS = new Map([
  ['write', { canonical: 'Write', key: 'filePath' }],
  ['edit', { canonical: 'Edit', key: 'filePath' }],
  ['patch', { canonical: 'Edit', key: 'filePath' }],
]);

function deny(reason) {
  process.stdout.write(`${JSON.stringify({ allow: false, reason: `BLOCKED: ${reason}` })}\n`);
  process.exit(0);
}

function allow() {
  process.stdout.write(`${JSON.stringify({ allow: true })}\n`);
  process.exit(0);
}

/** Hand a Claude-shaped payload to the gate and translate its verdict back. */
function consultGate(toolName, toolInput, cwd) {
  const payload = JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd });

  let stdout = '';
  let status = 0;
  let stderr = '';

  try {
    stdout = execFileSync('bash', [GATE], { input: payload, encoding: 'utf8', timeout: 20_000 });
  } catch (err) {
    status = err.status ?? 1;
    stdout = err.stdout ?? '';
    stderr = err.stderr ?? '';
  }

  if (status === 2) deny(String(stderr).split('\n')[0].replace(/^BLOCKED:\s*/, '') || 'refused');
  if (status !== 0) deny(`the gate exited unexpectedly (${status})`);

  let decision = '';
  try {
    decision = JSON.parse(stdout).hookSpecificOutput?.permissionDecision ?? '';
  } catch {
    deny('the gate returned no readable verdict');
  }

  if (decision === 'allow') return;
  // OpenCode cannot prompt a human mid-turn, so a request for approval is a
  // refusal here — reported as one so the log says which it was.
  if (decision === 'ask') {
    deny(String(stderr).split('\n')[0] || 'this member needs approval for that, which this CLI cannot ask for');
  }
  deny('the gate returned no readable verdict');
}

function main(request) {
  const tool = typeof request.tool === 'string' ? request.tool : '';
  const args = request.args && typeof request.args === 'object' ? request.args : null;
  const cwd = typeof request.cwd === 'string' && request.cwd ? request.cwd : process.cwd();

  if (!tool) deny('the request named no tool');
  if (!args) deny(`${tool} arrived with no arguments to check`);

  const argless = ARGLESS.get(tool);
  if (argless) {
    consultGate(argless, {}, cwd);
    allow();
  }

  const pathTool = PATH_TOOLS.get(tool);
  if (pathTool) {
    const value = args[pathTool.key];
    // The check this file exists for.
    if (typeof value !== 'string' || !value) {
      deny(`${tool} named no ${pathTool.key}, so there is no path to check`);
    }
    consultGate(pathTool.canonical, { file_path: value }, cwd);
    allow();
  }

  if (tool === 'bash') {
    const command = args.command;
    if (typeof command !== 'string' || !command) {
      deny('bash named no command, so there is nothing to check');
    }
    // Exactly once: the gate's strict-mode grant is consumed on use.
    consultGate('Bash', { command }, cwd);
    allow();
  }

  // Everything else. Refused here rather than reaching the gate under a name it
  // would not recognise.
  deny(`${tool} is not a tool this member may use`);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let request;
  try {
    request = JSON.parse(input);
  } catch {
    deny('the request was not readable JSON');
    return;
  }
  main(request && typeof request === 'object' ? request : {});
});
