/**
 * OpenCode as an `AgentCli`.
 *
 * The awkward one. Two capabilities the other engines have, it lacks:
 *
 * - No `--json-schema`, so a verdict cannot be demanded structurally.
 * - No assistant text in `--format json` at all, so a verdict cannot be read
 *   out of the stream either.
 *
 * Both were verified by probe rather than inferred. The way through is
 * `opencode export <sessionID>`, which returns the whole message list including
 * the reply — so a turn costs two processes: the run, then the export.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createOpencodeDecoder } from './opencode-decoder.ts';
import { OPENCODE_TOOLS } from './opencode-tools.ts';
import { hasValue, resolvePermissionMode } from './args.ts';
import type { AgentCli, CliModel, PathLayout, SpawnRequest } from './types.ts';
import type { MemberPermissionMode } from '../team/types.ts';

/**
 * A small, stable set for when the live catalog cannot be read.
 *
 * Deliberately tiny. OpenCode reports hundreds of models across whichever
 * providers happen to be connected, so the real list is fetched at runtime;
 * this exists only so the picker is never empty.
 */
const FALLBACK_MODELS: readonly CliModel[] = [
  { id: 'opencode/big-pickle', label: 'Big Pickle (OpenCode Zen)' },
];

/** OpenCode decides tool permissions itself; these are the modes we map onto. */
const PERMISSION_MODES: readonly MemberPermissionMode[] = ['acceptEdits', 'plan', 'bypassPermissions'];

/**
 * The assistant's reply for a session.
 *
 * Runs `opencode export`, which returns `{info, messages}`. The last assistant
 * message's text parts are the reply — and the verdict, since nothing else
 * carries one on this CLI.
 */
export function exportReplyText(sessionId: string, cwd: string): string {
  if (!sessionId) return '';

  let raw: string;
  try {
    raw = execFileSync('opencode', ['export', sessionId], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    // A verdict that cannot be fetched is not a verdict. Returning nothing
    // lets the gate treat it as unreadable, which fails closed.
    return '';
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '';
  }

  const messages = (parsed as { messages?: unknown[] })?.messages;
  if (!Array.isArray(messages)) return '';

  // Walk backwards: the verdict is the last thing the assistant said.
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { info?: { role?: string }; parts?: unknown[] };
    if (message?.info?.role !== 'assistant') continue;

    const text = (Array.isArray(message.parts) ? message.parts : [])
      .map((part) => (part as { type?: string; text?: string }))
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('\n')
      .trim();

    if (text) return text;
  }

  return '';
}

/**
 * What this member's generated agent is called.
 *
 * The member id, which is already a validated slug, so it is safe as both a
 * filename and a CLI argument.
 */
function agentNameFor(request: SpawnRequest): string {
  return request.pipelineAgent ?? '';
}

/**
 * Write the member's role where OpenCode will actually read it.
 *
 * There is no `--system-prompt-file` on this CLI; a system prompt can only
 * come from an agent definition on disk. So the role is written to
 * `<project>/.opencode/agent/<member>.md` immediately before the spawn, and
 * `--agent <member>` points at it.
 *
 * Rewritten every turn rather than created once: the role is editable in the
 * UI, and a stale copy would be a member quietly running yesterday's
 * instructions.
 */
function writeAgentDefinition(request: SpawnRequest, layout: PathLayout): void {
  const name = agentNameFor(request);
  if (!name) return;

  let body = '';
  if (hasValue(layout.roleFile) && existsSync(layout.roleFile)) {
    body = readFileSync(layout.roleFile, 'utf8');
  } else if (hasValue(request.systemPrompt)) {
    body = request.systemPrompt;
  }
  if (!body.trim()) return;

  const dir = join(request.projectDir, '.opencode', 'agent');
  mkdirSync(dir, { recursive: true });

  // `mode: primary` so the agent can be selected for the whole turn rather
  // than only invoked as a subagent.
  writeFileSync(
    join(dir, `${name}.md`),
    `---\ndescription: Hackeroom member ${name}\nmode: primary\n---\n\n${body.trim()}\n`
  );
}

/** Models this install actually has, grouped later by provider in the UI. */
export function liveOpencodeModels(): CliModel[] {
  try {
    const out = execFileSync('opencode', ['models'], { encoding: 'utf8', timeout: 30_000 });
    const models = out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('/'))
      .map((id) => ({ id, label: id }));
    return models.length > 0 ? models : [...FALLBACK_MODELS];
  } catch {
    return [...FALLBACK_MODELS];
  }
}

export const openCodeCli: AgentCli = {
  id: 'opencode',
  label: 'OpenCode',
  binary: 'opencode',
  containerBinary: 'opencode',

  support: {
    // No --json-schema. The verdict is asked for in the prompt and parsed back
    // out, which degrades toward "unreadable" rather than toward "approved" —
    // parseTextSignal already fails closed.
    structuredOutput: 'prompted',
    // No --system-prompt-file either; the role becomes a generated agent
    // definition inside the project.
    systemPrompt: 'generated-agent',
    skills: 'project-materialised',
    // --session resumes the same conversation, so the memory delta is safe.
    resumeReplaysTranscript: true,
    reportsTokens: true,
    reportsCost: true,
    // step_finish reports input/output/cache per step. `total` is the running
    // total and is deliberately ignored.
    usageReporting: 'delta',
  },

  // OpenCode maps effort onto a provider-specific --variant, which not every
  // provider supports. Kept to the three levels every provider understands.
  efforts: ['low', 'medium', 'high'],
  permissionModes: PERMISSION_MODES,
  models: FALLBACK_MODELS,
  defaultModel: 'opencode/big-pickle',

  tools: OPENCODE_TOOLS,
  createDecoder: createOpencodeDecoder,
  fetchReplyText: exportReplyText,
  prepare: writeAgentDefinition,

  buildArgs(request: SpawnRequest, layout: PathLayout): string[] {
    const args: string[] = [
      'run',
      // The prompt is a positional. Note `-p` on this CLI is --password, not
      // print: copying Claude's flag here would send the prompt as an auth
      // credential.
      request.prompt,
      '--format', 'json',
      '--dir', request.projectDir,
    ];

    if (hasValue(request.model)) args.push('--model', request.model);

    // A NAME, never a path. `--agent /some/role.md` does not error — it hangs
    // the process forever with no output at all, which is how this first
    // shipped and why an OpenCode member looked stuck rather than broken. The
    // definition the name refers to is written by prepare(), below.
    const agentName = agentNameFor(request);
    if (agentName) args.push('--agent', agentName);

    if (hasValue(request.effort)) args.push('--variant', request.effort);
    if (hasValue(request.resume)) args.push('--session', request.resume);

    const mode = resolvePermissionMode(request);
    if (mode === 'bypassPermissions') args.push('--dangerously-skip-permissions');

    // Never --pure: it runs without external plugins, and the gate IS a
    // plugin. Never --attach: it targets a pre-existing server, which severs
    // the environment carrying this member's identity.

    return args;
  },
};
