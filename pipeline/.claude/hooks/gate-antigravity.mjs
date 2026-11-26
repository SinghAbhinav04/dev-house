#!/usr/bin/env node
//
// Antigravity PreToolUse shim.
//
// Translates what `agy` hands a hook into what approval-gate.mjs expects, and
// translates the answer back. It decides nothing itself: there is one gate, one
// manifest and one set of contract tests, and a second implementation would be
// a second thing to drift.
//
// This replaces gate-antigravity.sh, which needed bash and jq and so could not
// run on Windows at all.
//
// agy sends:
//   {"toolCall":{"name":"run_command","args":{"CommandLine":"...","Cwd":"..."}},
//    "conversationId":"...","stepIdx":19,"workspacePaths":[...]}
//
// and reads a denial from stdout:
//   {"decision":"deny","reason":"..."}
//
// FAIL CLOSED, and specifically about argument keys. The gate reads a path out
// of the arguments to decide whether a write is allowed. agy's keys are
// PascalCase and inconsistent between tools (`view_file` says AbsolutePath,
// `write_to_file` says TargetFile), and a missing key yields an empty string.
// An empty path resolves to the working directory, which is inside the project
// root, which the gate ALLOWS. So a wrong or missing key is not a loud failure,
// it is a silent permit. Every branch that would hand the gate a path checks
// first that it actually has one.
//
// Keys were observed by running the binary, not read from the docs. See
// scripts/probe-antigravity.mjs.

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), 'approval-gate.mjs');

// Deny, in agy's dialect. Always exit 0: agy's contract is that a refusal comes
// from this JSON, and a non-zero exit is an undefined hook failure that may well
// be treated as "carry on". The stderr copy is what reaches tool_info.error, so
// the decoder can recognise a gate denial and replay it to the approval flow.
function deny(reason = 'Denied') {
  process.stderr.write(`BLOCKED: ${reason}\n`);
  process.stdout.write(`${JSON.stringify({ decision: 'deny', reason: `BLOCKED: ${reason}` })}\n`);
  process.exit(0);
}

function allow() {
  process.exit(0);
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Hand a Claude-shaped payload to the gate and translate its verdict back. */
function consultGate(toolName, toolInput, workspace) {
  const payload = JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd: workspace });

  let stdout = '';
  let stderr = '';
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, [GATE], { input: payload, encoding: 'utf8', timeout: 20_000, windowsHide: true });
  } catch (err) {
    status = err.status ?? 1;
    stdout = String(err.stdout ?? '');
    stderr = String(err.stderr ?? '');
  }

  const reason = stderr.split('\n')[0] ?? '';
  if (status === 2) deny(reason.replace(/^BLOCKED:\s*/, '') || 'refused');
  if (status !== 0) deny(`the gate exited unexpectedly (${status})`);

  let verdict;
  try {
    verdict = JSON.parse(stdout).hookSpecificOutput ?? {};
  } catch {
    deny('the gate returned no readable verdict');
  }

  if (verdict.permissionDecision === 'allow') return;
  // agy has no way to ask the user mid-turn, so a request for approval is a
  // refusal here, reported as one so the run log says why.
  if (verdict.permissionDecision === 'ask') {
    deny(verdict.permissionDecisionReason || reason || 'this member needs approval for that, which this CLI cannot ask for');
  }
  deny('the gate returned no readable verdict');
}

/** Tools the gate judges on name and capabilities alone; arguments are never read. */
const ARGLESS = new Map([
  ['view_file', 'Read'],
  ['grep_search', 'Grep'],
  ['list_dir', 'Glob'],
  ['find_by_name', 'Glob'],
  ['read_url_content', 'WebFetch'],
  ['search_web', 'WebSearch'],
  // Four, where the docs describe three: browser_subagent only appears in the
  // live tool list. All map onto the Agent block, which refuses everyone.
  ['invoke_subagent', 'Agent'],
  ['define_subagent', 'Agent'],
  ['manage_subagents', 'Agent'],
  ['browser_subagent', 'Agent'],
]);

function main(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    deny('hook payload was not readable JSON');
  }

  const nativeTool = typeof input?.toolCall?.name === 'string' ? input.toolCall.name : '';
  const args = input?.toolCall?.args && typeof input.toolCall.args === 'object' ? input.toolCall.args : {};
  if (!nativeTool) deny('the hook payload named no tool');

  // The hook's own working directory is <project>/.agents, not the project
  // root — observed, not assumed. The gate walks up from cwd looking for
  // pipeline-events.json, so handing it the parent is correct and enough.
  let workspace = Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === 'string' ? input.workspacePaths[0] : '';
  if (!workspace || !isDir(workspace)) workspace = resolve(process.cwd(), '..');

  const arg = (key) => (typeof args[key] === 'string' ? args[key] : '');

  const argless = ARGLESS.get(nativeTool);
  if (argless) {
    consultGate(argless, {}, workspace);
    allow();
  }

  if (nativeTool === 'write_to_file' || nativeTool === 'replace_file_content') {
    const target = arg('TargetFile');
    // The check this whole file exists for.
    if (!target) deny(`${nativeTool} named no TargetFile, so there is no path to check`);
    consultGate(nativeTool === 'replace_file_content' ? 'Edit' : 'Write', { file_path: target }, workspace);
    allow();
  }

  if (nativeTool === 'run_command') {
    const command = arg('CommandLine');
    if (!command) deny('run_command named no CommandLine, so there is no command to check');
    // Exactly once: the strict-mode approval grant is consumed on use.
    consultGate('Bash', { command }, workspace);
    allow();
  }

  // agy offers 57 tools. Anything not named above — including sed_file and
  // multi_replace_file_content, whose argument keys have not been observed —
  // is refused rather than passed through under a name the gate would not
  // recognise.
  deny(`${nativeTool} is not a tool this member may use`);
}

if (!existsSync(GATE)) deny('the capability gate is missing');

// Same bounded first-byte wait as the gate. A timeout here denies: this shim
// is only ever invoked with a tool call to judge.
const chunks = [];
let gotFirst = false;
const timer = setTimeout(() => {
  if (!gotFirst) deny('no tool call was received on stdin');
}, 5_000);
process.stdin.on('data', (chunk) => {
  if (!gotFirst && chunk.length > 0) {
    gotFirst = true;
    clearTimeout(timer);
  }
  chunks.push(chunk);
});
process.stdin.on('end', () => {
  clearTimeout(timer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) deny('no tool call was received on stdin');
  main(raw);
});
process.stdin.on('error', () => deny('no tool call was received on stdin'));
