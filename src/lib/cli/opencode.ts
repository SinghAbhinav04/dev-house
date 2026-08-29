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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createOpencodeDecoder } from './opencode-decoder.ts';
import { OPENCODE_TOOLS } from './opencode-tools.ts';
import { hasValue, resolvePermissionMode } from './args.ts';
import type { AgentCli, CliModel, FetchedTurn, PathLayout, SpawnRequest } from './types.ts';
import type { MemberPermissionMode } from '../team/types.ts';
import type { TokenUsage } from '../team/usage.ts';

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

/** `info.tokens` from an export, which counts the whole session, not the turn. */
function readSessionUsage(info: unknown): TokenUsage | undefined {
  const tokens = (info as { tokens?: Record<string, unknown> })?.tokens;
  if (!tokens || typeof tokens !== 'object') return undefined;

  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const cache = (tokens.cache ?? {}) as Record<string, unknown>;
  const cost = (info as { cost?: unknown })?.cost;

  return {
    inputTokens: num(tokens.input),
    outputTokens: num(tokens.output),
    cacheReadTokens: num(cache.read),
    cacheWriteTokens: num(cache.write),
    totalCostUsd: num(cost),
    // OpenCode reports reasoning separately, so it is not already inside
    // `output` and is safe to surface on its own.
    thinkingTokens: num(tokens.reasoning),
    unpricedTokens: 0,
  };
}

/**
 * What a finished turn actually produced.
 *
 * Runs `opencode export`, which returns `{info, messages}`. That one call is
 * the only source for both halves: the last assistant message's text parts are
 * the reply — and the verdict, since nothing else carries one on this CLI —
 * while `info.tokens` and `info.cost` are the only usage numbers the CLI will
 * give up. Its `--format json` stream emits a lone `step-start` and stops.
 */
export function exportTurnResult(sessionId: string, cwd: string): FetchedTurn {
  if (!sessionId) return { text: '' };

  // Collected through a FILE rather than a pipe, which is not fastidiousness.
  //
  // Piped, `opencode export` truncates: it exits before its stdout has drained,
  // and the reader gets whatever made it through — measured at 65441 bytes of
  // an answer that should have been larger, cut mid-token. It is a race, so it
  // is worst on the exports that return quickly, and a slow 850KB export came
  // back whole while a fast 65KB one did not. Truncated JSON does not parse, so
  // the turn produced no verdict and no spend, and the run failed at the first
  // gate with nothing to explain it. A file descriptor has no such limit.
  const spool = join(tmpdir(), `hackeroom-export-${sessionId}-${process.pid}.json`);
  let raw: string;
  let handle: number | undefined;
  try {
    handle = openSync(spool, 'w');
    execFileSync('opencode', ['export', sessionId], {
      cwd,
      // Generous: this re-serialises the ENTIRE conversation every turn, so it
      // slows as the session grows — 16.5s for an 850KB planning session.
      timeout: 180_000,
      stdio: ['ignore', handle, 'pipe'],
    });
    closeSync(handle);
    handle = undefined;
    raw = readFileSync(spool, 'utf8');
  } catch (err) {
    // A verdict that cannot be fetched is not a verdict. Returning nothing
    // lets the gate treat it as unreadable, which fails closed. Usage stays
    // undefined rather than zero — an unknown spend must not bank as a free
    // turn. The reason is carried out so the run can say it happened instead
    // of quietly reporting a member that said nothing and cost nothing.
    if (handle !== undefined) {
      try { closeSync(handle); } catch { /* already gone */ }
    }
    return { text: '', error: `could not read the session back: ${(err as Error).message}` };
  } finally {
    try { rmSync(spool, { force: true }); } catch { /* nothing to clean */ }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { text: '', error: 'the exported session was not readable JSON' };
  }

  const usage = readSessionUsage((parsed as { info?: unknown })?.info);
  const messages = (parsed as { messages?: unknown[] })?.messages;
  if (!Array.isArray(messages)) return { text: '', usage };

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

    if (text) return { text, usage };
  }

  return { text: '', usage };
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

/**
 * The environment that hands this member its skills, and only its skills.
 *
 * OpenCode has no `--skill` flag; skills come from config, and `skills.paths`
 * accepts absolute directories. That is the whole mechanism — the member's
 * existing skills directory is named where it already lives, so nothing is
 * copied into the project and nothing is left behind to clean up.
 *
 * Passed as config CONTENT rather than a config FILE because a file would have
 * to live somewhere, and anywhere it could live is shared by every member of
 * the run. An environment variable belongs to one process.
 *
 * The two disable flags matter as much as the paths: left on, OpenCode also
 * scans its own external sources and the user's Claude Code skill directories,
 * so a member would silently inherit whatever the user happens to have
 * installed. Off, the set is exactly what the roster attached — which is also
 * what makes allowing the `skill` tool at the gate a bounded decision.
 * Verified: our configured skills still load with both flags set.
 */
function skillEnvironment(request: SpawnRequest, layout: PathLayout): Record<string, string> {
  void request;

  // Claude packages a member's skills as a plugin, so the skills themselves sit
  // one level in. OpenCode wants the directory that CONTAINS the skills.
  const paths = layout.pluginDirs.map((dir) => join(dir, 'skills'));

  return {
    // Always set, even when the list is empty, and that is the whole point:
    // naming `paths` REPLACES the defaults, while omitting it leaves them in
    // place. A member with no skills of its own is the worst case to leave
    // open — everything it can then reach belongs to the user. Measured, with
    // nothing attached: flags alone still exposed the user's global OpenCode
    // skills, and an empty array is what actually removed them.
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ skills: { paths } }),
    // These close the other two doors: OpenCode's external skill sources, and
    // its scan of the user's Claude Code directories — which on this machine
    // was nineteen of the user's personal skills, in a teammate's context.
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
  };
  // `customize-opencode` still shows up and cannot be turned off: it is
  // registered in OpenCode's own code, not read from any directory. It is the
  // engine's, not the user's, so it is left alone.
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
    // Not materialised after all: `skills.paths` takes absolute directories, so
    // the member's own skills are named where they already are. Nothing is
    // written into the project, and two members could hold different skills at
    // the same time — which the materialised route could never have done.
    skills: 'config-paths',
    // --session resumes the same conversation, so the memory delta is safe.
    resumeReplaysTranscript: true,
    reportsTokens: true,
    reportsCost: true,
    // Not from the stream — `opencode export` reports the SESSION's totals, so
    // a resumed turn re-reads everything spent before it. Recording those as
    // deltas would bank the whole conversation again on every turn.
    usageReporting: 'cumulative',
  },

  // OpenCode maps effort onto a provider-specific --variant, which not every
  // provider supports. Kept to the three levels every provider understands.
  efforts: ['low', 'medium', 'high'],
  permissionModes: PERMISSION_MODES,
  models: FALLBACK_MODELS,
  defaultModel: 'opencode/big-pickle',

  tools: OPENCODE_TOOLS,
  createDecoder: createOpencodeDecoder,
  fetchTurnResult: exportTurnResult,
  prepare: writeAgentDefinition,
  spawnEnv: skillEnvironment,

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
