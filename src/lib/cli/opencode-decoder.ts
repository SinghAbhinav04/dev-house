/**
 * Reading OpenCode's `--format json`.
 *
 * Shapes taken from a real captured stream
 * (`scripts/fixtures/opencode-stream.ndjson`). Three things about it drive the
 * design:
 *
 * - Every event is `{type, timestamp, sessionID, part}`, and the interesting
 *   part is inside `part`.
 * - A `tool_use` event arrives ONCE, already completed, carrying both the
 *   arguments and the output. So a call and its result are decoded together
 *   rather than correlated across two events.
 * - **The assistant's reply text is never in the stream.** Verified on a
 *   tool-using turn and a plain one, on free and paid models. Combined with
 *   OpenCode having no `--json-schema`, that leaves no verdict in the stream at
 *   all — which is why the adapter fetches it afterwards with
 *   `opencode export`. See `openCodeCli.fetchReplyText`.
 *
 * There is also no terminal event, so `finish()` synthesises one. That is the
 * reason `finish()` had to be wired into every call site before this existed.
 */

import { describeToolCall, type AgentDecoder, type AgentEvent } from './decoder.ts';
import { OPENCODE_TOOLS, toCanonicalArgs } from './opencode-tools.ts';
import { summarizeToolResult } from '../events.ts';
import { emptyUsage, type TokenUsage } from '../team/usage.ts';

/** The marker the gate writes, so a denial can be replayed to the approval flow. */
const GATE_DENIAL_MARKER = 'BLOCKED:';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Tokens for one step.
 *
 * Deliberately not `tokens.total`: input, output and cache are per-step, but
 * total is a running total for the session, so adding it would count every
 * earlier step again. Observed directly — the second step reported input=280
 * against total=13014.
 */
function readUsage(step: Record<string, unknown>): TokenUsage | null {
  const tokens = asRecord(step.tokens);
  if (!tokens) return null;

  const cache = asRecord(tokens.cache) ?? {};
  const cost = num(step.cost);
  const inputTokens = num(tokens.input);
  const outputTokens = num(tokens.output);

  return {
    ...emptyUsage(),
    inputTokens,
    outputTokens,
    cacheReadTokens: num(cache.read),
    cacheWriteTokens: num(cache.write),
    thinkingTokens: num(tokens.reasoning),
    totalCostUsd: cost,
    // A free model reports cost 0 honestly; only count tokens as unpriced when
    // there is genuinely no price attached.
    unpricedTokens: cost > 0 ? 0 : inputTokens + outputTokens,
  };
}

export function createOpencodeDecoder(): AgentDecoder {
  let sessionId = '';
  const denials: { toolName: string; toolInput: Record<string, unknown> }[] = [];
  let sawAnything = false;

  function decodeTool(part: Record<string, unknown>): AgentEvent[] {
    const native = str(part.tool);
    if (!native) return [];

    const canonical = OPENCODE_TOOLS.toCanonical(native);
    const callId = str(part.callID) || `${sessionId}:${str(part.id)}`;
    const state = asRecord(part.state) ?? {};
    const input = toCanonicalArgs(native, asRecord(state.input) ?? {});

    const status = str(state.status);
    const errorText = str(state.error) || (status === 'error' ? `${native} failed` : '');
    const isError = Boolean(errorText) || status === 'error';

    if (isError && errorText.includes(GATE_DENIAL_MARKER)) {
      denials.push({ toolName: canonical, toolInput: input });
    }

    // The call and its result arrive together, but they are emitted as two
    // events so every caller's bookkeeping works the same way across CLIs.
    return [
      { kind: 'tool_call', callId, tool: canonical, input, ...describeToolCall(canonical, input) },
      {
        kind: 'tool_result',
        callId,
        tool: canonical,
        isError,
        content: state.output,
        summary: !isError ? summarizeToolResult(canonical, state.output) : '',
        errorText,
      },
    ];
  }

  function decode(event: Record<string, unknown>): AgentEvent[] {
    const type = str(event.type);
    const part = asRecord(event.part);
    const out: AgentEvent[] = [];

    const streamedSession = str(event.sessionID) || str(part?.sessionID);
    if (streamedSession && streamedSession !== sessionId) {
      sessionId = streamedSession;
      out.push({ kind: 'session', sessionId });
    }

    if (type === 'tool_use' && part) {
      sawAnything = true;
      out.push(...decodeTool(part));
      return out;
    }

    if (type === 'step_finish' && part) {
      sawAnything = true;
      const usage = readUsage(part);
      if (usage) out.push({ kind: 'usage', sessionKey: sessionId, reading: usage });
      return out;
    }

    // step_start carries nothing but the ids, which are already handled above.
    return out;
  }

  return {
    push(line: string): AgentEvent[] {
      if (!line.trim()) return [];
      let event: Record<string, unknown> | null;
      try {
        event = asRecord(JSON.parse(line));
      } catch {
        return [];
      }
      return event ? decode(event) : [];
    },

    /**
     * OpenCode's stream simply stops — there is no terminal event — so the
     * result is synthesised here.
     *
     * `text` is left empty on purpose. The reply is not in the stream at all,
     * and fetching it means running `opencode export`, which is a subprocess
     * and cannot happen inside a synchronous decoder. The runner fills it in
     * afterwards via the adapter's fetchReplyText.
     */
    finish(): AgentEvent[] {
      return [
        {
          kind: 'result',
          text: '',
          sessionId,
          outcome: sawAnything || sessionId ? 'ok' : 'error',
          errorText: sawAnything || sessionId ? '' : 'the turn produced no output at all',
          raw: {},
          denials: [...denials],
        },
      ];
    },
  };
}
