#!/usr/bin/env node
//
// Team Role Guardrails (Hardened v4 — manifest driven, cross-platform)
//
// Per-member permission enforcement with DENY-BY-DEFAULT.
//
// This is the Node port of approval-gate.sh. The shell version needed bash,
// jq, readlink -f and GNU grep, so on Windows it failed closed on every call
// ("jq: command not found" → "Could not parse tool name") and no member could
// do anything at all. Node is already on every machine that can run the app,
// so the rules now live here and behave identically on Windows, macOS and
// Linux. The rule set is unchanged; scripts/test-hook-contract.mjs drives this
// file with the same checks the shell version passed.
//
// Members are user-authored, so there is no fixed set of agent letters to
// match against. Instead the server writes a capability manifest to
// <project>/.claude/team-manifest.json at run start and this hook looks the
// member up in it. The manifest is data the hook *consults*; it is not a grant
// of authority. These clamps are unconditional and no manifest value can
// unlock them:
//
//   - a call with nothing on stdin is denied; the gate never permits what it
//     could not read
//   - writes to .claude/ (and every other CLI's config dir) are denied for
//     every member — that is what stops an agent editing this hook or its own
//     permissions
//   - writes to the run's control files (pipeline-*.json in a project root)
//     are denied for every member, so nobody can approve their own Bash command
//   - every member whose write level is not "builds" is jailed to the active
//     project root
//   - the Agent tool is blocked for everyone (no recursive spawning)
//   - Bash cannot mutate hooks/settings, create links, spawn agent CLIs, or
//     touch PIPELINE_AGENT
//   - any tool not explicitly handled is denied
//   - a member absent from the manifest is denied outright
//
// Manifest schema:
//   { "version": 1,
//     "artifacts": { "plan.md": "<member-id>" },
//     "members": { "<member-id>": { "slot": "coder", "write": "none|artifact|project|builds",
//                                   "bash": "none|approval|safe|all", "web": true|false,
//                                   "denyPhases": ["concept"] } } }
//
// MODES: fast=default autonomy, strict=escalate "safe" Bash to approval.
//
// Contract: a denial is exit code 2 with "BLOCKED: <reason>" on stderr; an
// allow or ask is a PreToolUse JSON object on stdout with exit code 0.
//
// LIMITATIONS: this is a role guardrail, not a security sandbox. A
// sufficiently adversarial agent could bypass command-string pattern matching
// via indirect execution (python3 -c, eval, base64). For true isolation, use
// OS-level sandboxing. See SECURITY.md.

import { existsSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';

const IS_WINDOWS = process.platform === 'win32';

// ── Verdicts ─────────────────────────────────────────────────────────

function deny(reason) {
  process.stderr.write(`BLOCKED: ${reason}\n`);
  process.exit(2);
}

function decide(permissionDecision, permissionDecisionReason) {
  const hookSpecificOutput = { hookEventName: 'PreToolUse', permissionDecision };
  if (permissionDecisionReason) hookSpecificOutput.permissionDecisionReason = permissionDecisionReason;
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput })}\n`);
  process.exit(0);
}

const allow = () => decide('allow');

// ── Paths ────────────────────────────────────────────────────────────

/** Same rule as src/lib/platform.ts userHome(); duplicated because this file is copied into projects alone. */
function userHome() {
  const home = process.env.HOME;
  if (home) {
    if (IS_WINDOWS) {
      if (/^[a-zA-Z]:[\\/]/.test(home) || home.startsWith('\\\\')) return home;
    } else if (isAbsolute(home)) {
      return home;
    }
  }
  return homedir();
}

function realOr(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * Case-folded and with one separator, for comparisons only. The shell version
 * always lowercased (the filesystem under ~/Builds is usually
 * case-insensitive); Windows also mixes separators.
 */
function fold(path) {
  return path.replace(/\\/g, '/').toLowerCase();
}

function isInside(childFolded, parentFolded) {
  const base = parentFolded.endsWith('/') ? parentFolded : `${parentFolded}/`;
  return childFolded.startsWith(base);
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function findProjectRoot(cwd) {
  let check = resolve(cwd);
  const { root } = parse(check);
  while (check && check !== root) {
    if (isFile(join(check, 'pipeline-events.json'))) return check;
    const parent = dirname(check);
    if (parent === check) break;
    check = parent;
  }
  return resolve(cwd);
}

/** Absolute, symlink-resolved path, or null when it cannot be trusted. */
function resolveFilePath(filePath, cwd) {
  let fp = filePath;
  if (!isAbsolute(fp)) fp = join(cwd, fp);
  // Reject .. anywhere, before normalisation can hide it.
  if (fp.includes('..')) return null;
  const dir = dirname(fp);
  if (!isDir(dir)) return null;
  fp = join(realOr(dir), basename(fp));
  // File-level symlinks. (Hardlinks are not detected — known limitation.)
  if (existsSync(fp)) fp = realOr(fp);
  return fp;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ── Input ────────────────────────────────────────────────────────────

/**
 * Read the whole payload. The first byte is waited for with a bound: Claude can
 * occasionally invoke the hook while stdin is not closed yet. No input is a
 * REFUSAL — a payload that arrived late on a loaded machine used to be
 * permitted unread. After the first byte, reading continues to EOF.
 */
function readStdin(firstByteTimeoutMs) {
  return new Promise((resolvePayload) => {
    const chunks = [];
    let gotFirst = false;
    const timer = setTimeout(() => {
      if (!gotFirst) deny('No tool call was received on stdin');
    }, firstByteTimeoutMs);
    process.stdin.on('data', (chunk) => {
      if (!gotFirst && chunk.length > 0) {
        gotFirst = true;
        clearTimeout(timer);
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) deny('No tool call was received on stdin');
      resolvePayload(text);
    });
    process.stdin.on('error', () => deny('No tool call was received on stdin'));
  });
}

// ── Bash patterns ────────────────────────────────────────────────────
//
// Ported from the grep -Ei patterns of the shell version. Those matched line
// by line, so these use the `m` flag (^/$ per line) and `.` does not cross a
// newline. [[:space:]] is \s.

const GATE_FILES =
  String.raw`\.claude(\/|\s|$)|\.opencode(\/|\s|$)|\.agents(\/|\s|$)|\.gemini(\/|\s|$)|approval-gate(\.sh|\.mjs)?|settings\.json|team-manifest\.json|hooks\.json|opencode\.json|plugin\.json|auth\.json|hooks\/`;
const RUN_FILES = String.raw`pipeline-(approved-bash|approved|pending|events)(\.[0-9]+)?\.json`;

const MUTATE_GATE = new RegExp(String.raw`(^|[;&|\s])(rm|mv|cp|chmod|chown|touch|mkdir|rmdir|sed|tee)\b.*(${GATE_FILES})`, 'im');
const REDIRECT_GATE = new RegExp(String.raw`(>|>>|<).*(${GATE_FILES})`, 'im');
const MUTATE_RUN = new RegExp(String.raw`(^|[;&|\s])(rm|mv|cp|chmod|chown|touch|sed|tee|dd|truncate)\b.*(${RUN_FILES})`, 'im');
// Writes only: `>` followed by the file, never `<`. Reading the run state is allowed.
const REDIRECT_RUN = new RegExp(String.raw`>[|&]?\s*["']?[^\s<>|;&]*(${RUN_FILES})`, 'im');

// The shell version used `case` globs here, which match across newlines.
const GLOB_ON_DOTFILES = /(mv |cp |rm ).*\..*\*/s;
const DOTFILE_TARGET = /mv \.|cp \.|rm \.|rm -.* \./s;

function hasLinkCommand(command) {
  return command.includes('ln ') || command.includes('$(ln') || command.includes('`ln');
}

// Matched on the invocation form rather than the bare binary name: "opencode"
// and "agy" are short enough to appear inside ordinary prose.
function spawnsAgent(command) {
  return (
    command.includes('PIPELINE_AGENT') ||
    command.includes('claude -') ||
    command.includes('opencode run') ||
    command.includes('opencode -') ||
    command.includes('agy -')
  );
}

const CONFIG_DIRS = new Set(['.claude', '.opencode', '.agents', '.gemini']);

// ── Main ─────────────────────────────────────────────────────────────

const READ_ONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'Skill', 'ToolSearch', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'LSP', 'StructuredOutput',
]);

async function main() {
  const raw = await readStdin(10_000);

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    deny('Could not parse tool name');
  }

  const toolName = typeof input?.tool_name === 'string' ? input.tool_name : '';
  const toolInput = input?.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cwd = typeof input?.cwd === 'string' && input.cwd ? input.cwd : process.cwd();

  if (!toolName || toolName === 'null') deny('Could not parse tool name');

  const buildsDir = realOr(join(userHome(), 'Builds'));
  const member = process.env.PIPELINE_AGENT ?? '';
  const securityMode = process.env.PIPELINE_SECURITY_MODE || 'fast';

  // ── Identity ──────────────────────────────────────────────────────

  // The member id is also a path segment and an env value, so keep it strict.
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(member)) deny(`Invalid member identity '${member}'`);

  let projectRoot = findProjectRoot(cwd);
  const manifestFile = join(projectRoot, '.claude', 'team-manifest.json');
  if (!isFile(manifestFile)) deny(`No team manifest at ${manifestFile} — cannot verify member '${member}'`);

  const manifest = readJson(manifestFile);
  const entry = manifest?.members && Object.prototype.hasOwnProperty.call(manifest.members, member) ? manifest.members[member] : null;
  if (!entry || typeof entry !== 'object') deny(`Member '${member}' is not on the team manifest`);

  const memberWrite = entry.write ?? 'none';
  const memberBash = entry.bash ?? 'none';
  const memberWeb = entry.web === true;

  // Reject values outside the known vocabulary rather than reading an
  // unrecognised level as permissive.
  if (!['none', 'artifact', 'project', 'builds'].includes(memberWrite)) {
    deny(`Member '${member}' has an unrecognised write level '${memberWrite}'`);
  }
  if (!['none', 'approval', 'safe', 'all'].includes(memberBash)) {
    deny(`Member '${member}' has an unrecognised bash level '${memberBash}'`);
  }

  // ── Read-only tools (all members) ─────────────────────────────────
  //
  // Skill belongs here: loading a skill only reads a file this system attached
  // to this member. Whatever the skill then tells the model to do still
  // arrives here as a Write, a Bash or a WebFetch and is judged on its own.
  if (READ_ONLY_TOOLS.has(toolName)) allow();

  if (toolName === 'Agent') deny(`Member ${member} cannot spawn sub-agents`);

  // ── Web (egress risk) ─────────────────────────────────────────────
  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    if (memberWeb) allow();
    deny(`Member ${member} cannot use ${toolName}`);
  }

  // ── Write / Edit / NotebookEdit ───────────────────────────────────
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    const requested = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
    const filePath = resolveFilePath(requested, cwd);
    if (!filePath) deny('Invalid file path');

    const fileName = basename(filePath);
    const fileFolded = fold(filePath);
    projectRoot = realOr(projectRoot);
    const projectFolded = fold(projectRoot);
    const eventsFile = join(projectRoot, 'pipeline-events.json');

    const inBuilds = isInside(fileFolded, fold(buildsDir));
    const inPipelineProject = isFile(eventsFile) && isInside(fileFolded, projectFolded);
    if (!inBuilds && !inPipelineProject) deny(`Cannot write to ${filePath} — outside the active pipeline project`);

    // Jail every member to the project root unless their write level is
    // "builds", which the roster only ever grants to the supervisor slot.
    if (memberWrite !== 'builds' && !isInside(fileFolded, projectFolded)) {
      deny(`Cannot write to ${filePath} — outside current project`);
    }

    // Every agent CLI's config directory, for ALL members. One per supported
    // CLI, because each keeps its gate somewhere different.
    const segments = fileFolded.split('/');
    if (segments.some((segment) => CONFIG_DIRS.has(segment))) deny('Cannot modify hook/settings files');

    // The run's own control files, in any directory that is a pipeline project
    // root, so a supervisor cannot do to a sibling project what the coder
    // cannot do to its own.
    const fileDir = dirname(filePath);
    if (/^pipeline-.*\.json/.test(fileName.toLowerCase())) {
      if (fold(fileDir) === projectFolded || isFile(join(fileDir, 'pipeline-events.json'))) {
        deny("Cannot modify the run's control files");
      }
    }

    // Shared-memory inbox: any member may drop a new .md entry directly into
    // it (Write only, never Edit, no nesting). Everything else there is denied.
    const inboxFolded = fold(join(projectRoot, '.squad', 'memory', 'inbox'));
    if (isInside(fileFolded, inboxFolded)) {
      const rel = filePath.replace(/\\/g, '/').slice(inboxFolded.length + 1);
      if (toolName === 'Write' && /^[A-Za-z0-9._-]+\.md$/.test(rel)) allow();
      deny('The memory inbox only accepts new .md files written directly into it');
    }

    if (memberWrite === 'none') deny(`Member ${member} cannot write files`);

    // Phase gate.
    const denyPhases = Array.isArray(entry.denyPhases) ? entry.denyPhases : [];
    if (denyPhases.length > 0) {
      const events = isFile(eventsFile) ? readJson(eventsFile) : null;
      const currentPhase = typeof events?.currentPhase === 'string' ? events.currentPhase : 'concept';
      if (denyPhases.includes(currentPhase)) deny(`Member ${member} cannot write during phase '${currentPhase}'`);
    }

    // Artifact ownership: plan.md belongs to exactly one member.
    const artifacts = manifest.artifacts && typeof manifest.artifacts === 'object' ? manifest.artifacts : {};
    const owner = Object.prototype.hasOwnProperty.call(artifacts, fileName) ? String(artifacts[fileName] ?? '') : '';

    if (memberWrite === 'artifact') {
      if (!owner || owner !== member) deny(`Member ${member} can only write the artifact it owns, not ${fileName}`);
    } else if (owner && owner !== member) {
      deny(`${fileName} is owned by member ${owner} and is locked`);
    }

    allow();
  }

  // ── Bash ──────────────────────────────────────────────────────────
  if (toolName === 'Bash') {
    if (memberBash === 'none') deny(`Member ${member} cannot run commands`);

    const command = typeof toolInput.command === 'string' ? toolInput.command : '';
    const grantFile = join(projectRoot, 'pipeline-approved-bash.json');

    if (MUTATE_GATE.test(command) || REDIRECT_GATE.test(command)) deny('Cannot modify hook or settings files via Bash');
    if (MUTATE_RUN.test(command) || REDIRECT_RUN.test(command)) deny("Cannot modify the run's control files via Bash");
    if (GLOB_ON_DOTFILES.test(command)) deny('Cannot mv/cp/rm with glob patterns on dot-files');
    if (DOTFILE_TARGET.test(command)) deny('Cannot mv/cp/rm dot-files or dot-directories');
    if (hasLinkCommand(command)) deny('Cannot create links via Bash');
    if (spawnsAgent(command)) deny('Cannot spawn agent sessions or modify agent identity via Bash');

    // "all" never escalates; "approval" always does; "safe" only in strict mode.
    const needsApproval = memberBash === 'approval' || (memberBash === 'safe' && securityMode === 'strict');

    if (needsApproval) {
      const grant = isFile(grantFile) ? readJson(grantFile) : null;
      if (grant && grant.agent === member && grant.command === command) {
        try {
          unlinkSync(grantFile);
        } catch {}
        allow();
      }
      decide('ask', `Member ${member} Bash requires approval`);
    }

    allow();
  }

  // ── DENY BY DEFAULT ───────────────────────────────────────────────
  deny(`Tool '${toolName}' is not allowed for member ${member}`);
}

main().catch((err) => deny(`the gate failed: ${err?.message ?? err}`));
