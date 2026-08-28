/**
 * Reading Antigravity's `--output-format stream-json`.
 *
 * Shapes here are taken from a real captured stream
 * (`scripts/fixtures/antigravity-stream.ndjson`), and differ from the
 * documentation in two ways that matter:
 *
 * - `state` has a third value, `ERROR`, not just `ACTIVE` and `DONE`. A tool
 *   that fails arrives as `ERROR` with `tool_info.error`, and that error is an
 *   object with a `message`, not a string.
 * - The documented `text_delta` never appeared. `agent_response` steps carry
 *   timing and usage and no prose at all; the reply arrives whole, once, in the
 *   terminal `result.response`. Delta handling is kept because the field is
 *   documented and may return, but nothing depends on it.
 *
 * Usage is the session's running total on every event, not that step's own
 * consumption. That is why usage is emitted as its own event for the caller to
 * put through a meter, rather than being read straight off the result.
 */

import {
  describeToolCall,
  type AgentEvent,
  type AgentDecoder,
  type TurnOutcome,
} from './decoder.ts';
import { ANTIGRAVITY_TOOLS, toCanonicalArgs } from './antigravity-tools.ts';
import { extractStructuredSignal } from '../pipeline-signal.ts';
import { summarizeToolResult } from '../events.ts';
import { emptyUsage, type TokenUsage } from '../team/usage.ts';

/** The marker the gate writes to stderr, which agy surfaces as a tool error. */
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
 * A usage reading from any event that carries one.
 *
 * There is no cache-*write* count and no cost anywhere in the stream, so both
 * stay zero; the billable total is recorded as unpriced so the UI can say so
 * rather than showing a measured-looking $0.00.
 */
function readUsage(raw: unknown): TokenUsage | null {
  const usage = asRecord(raw);
  if (!usage) return null;

  const inputTokens = num(usage.input_tokens);
  const outputTokens = num(usage.output_tokens);

  return {
    ...emptyUsage(),
    inputTokens,
    outputTokens,
    cacheReadTokens: num(usage.cache_read_tokens),
    thinkingTokens: num(usage.thinking_tokens),
    // Deliberately not total_tokens: that includes cache reads and thinking,
    // and adding it to a budget would count both twice.
    unpricedTokens: inputTokens + outputTokens,
  };
}

/**
 * How the turn ended.
 *
 * The distinction earns its keep on this CLI: agy ends a turn its own
 * `--print-timeout` killed with a perfectly ordinary terminal event whose
 * status says CANCELED. Without this that arrives as a clean turn that
 * happened to produce nothing.
 */
function readOutcome(status: string): TurnOutcome {
  switch (status) {
    case 'SUCCESS':
      return 'ok';
    case 'CANCELED':
    case 'INTERRUPTED':
    case 'WAITING':
    case 'RUNNING':
      return 'stalled';
    default:
      // ERROR, INVALID, and anything a later version adds. Unknown is a
      // failure rather than a success.
      return 'error';
  }
}

export function createAntigravityDecoder(): AgentDecoder {
  let conversationId = '';
  const toolsByCallId = new Map<string, { native: string; canonical: string }>();
  const emittedCallFor = new Set<string>();
  const denials: { toolName: string; toolInput: Record<string, unknown> }[] = [];

  // Only used if text_delta ever reappears; see the file comment.
  const textByStep = new Map<number, string>();

  /** No tool_use_id in this protocol, so one is made from what there is. */
  function callIdFor(stepIndex: number): string {
    return `${conversationId}:${stepIndex}`;
  }

  function flushText(stepIndex: number): AgentEvent[] {
    const buffered = textByStep.get(stepIndex);
    if (buffered === undefined) return [];
    textByStep.delete(stepIndex);
    const text = buffered.trim();
    return text ? [{ kind: 'text', text }] : [];
  }

  function flushAllText(): AgentEvent[] {
    const out: AgentEvent[] = [];
    for (const stepIndex of [...textByStep.keys()].sort((a, b) => a - b)) {
      out.push(...flushText(stepIndex));
    }
    return out;
  }

  function decodeToolStep(step: Record<string, unknown>, stepIndex: number): AgentEvent[] {
    const info = asRecord(step.tool_info);
    const native = str(info?.name) || str(step.tool_name);
    if (!native) return [];

    const canonical = ANTIGRAVITY_TOOLS.toCanonical(native);
    const callId = callIdFor(stepIndex);
    const state = str(step.state);
    const input = toCanonicalArgs(native, asRecord(info?.parameters) ?? {});

    toolsByCallId.set(callId, { native, canonical });

    const out: AgentEvent[] = [];

    // Announce the call once. Parameters are present on ACTIVE in practice, but
    // emitting on whichever update arrives first keeps the call ahead of its
    // result either way — which is what the caller's bookkeeping assumes.
    if (!emittedCallFor.has(callId)) {
      emittedCallFor.add(callId);
      out.push({
        kind: 'tool_call',
        callId,
        tool: canonical,
        input,
        ...describeToolCall(canonical, input),
      });
    }

    if (state === 'ACTIVE') return out;

    const errorObject = asRecord(info?.error);
    const isError = state === 'ERROR' || errorObject !== null;
    // The error is an object with a message, not a string.
    const errorText = isError
      ? str(errorObject?.message) || str(info?.error) || `${native} failed`
      : '';

    if (isError && errorText.includes(GATE_DENIAL_MARKER)) {
      // agy has no permission_denials array, so denials are collected as they
      // go and replayed on the result — otherwise the strict-mode approval
      // flow would never see them.
      denials.push({ toolName: canonical, toolInput: input });
    }

    out.push({
      kind: 'tool_result',
      callId,
      tool: canonical,
      isError,
      content: info?.output,
      summary: !isError && canonical ? summarizeToolResult(canonical, info?.output) : '',
      errorText,
    });

    return out;
  }

  function decode(event: Record<string, unknown>): AgentEvent[] {
    const kind = str(event.event);

    if (kind === 'init') {
      const init = asRecord(event.init);
      const out: AgentEvent[] = [];

      conversationId = str(event.conversation_id) || conversationId;
      if (conversationId) out.push({ kind: 'session', sessionId: conversationId });

      const tools = Array.isArray(init?.tools) ? init.tools.filter((t): t is string => typeof t === 'string') : [];
      if (tools.length > 0) out.push({ kind: 'tools', tools });

      return out;
    }

    if (kind === 'step_update') {
      const step = asRecord(event.step_update);
      if (!step) return [];

      conversationId = str(step.conversation_id) || conversationId;

      const stepIndex = num(step.step_index);
      const stepType = str(step.step_type);
      const out: AgentEvent[] = [];

      // Every event carries the session total, so this is the caller's chance
      // to bank a turn that later gets killed before any result arrives.
      const usage = readUsage(step.usage);
      if (usage) out.push({ kind: 'usage', sessionKey: conversationId, reading: usage });

      if (stepType === 'tool') {
        out.push(...decodeToolStep(step, stepIndex));
        return out;
      }

      if (stepType === 'agent_response') {
        const delta = str(step.text_delta);
        if (delta) textByStep.set(stepIndex, (textByStep.get(stepIndex) ?? '') + delta);
        if (str(step.state) !== 'ACTIVE') out.push(...flushText(stepIndex));
        return out;
      }

      // user_input, checkpoint, and anything a later version adds: the usage
      // above is the only part worth keeping.
      return out;
    }

    if (kind === 'result') {
      const result = asRecord(event.result);
      if (!result) return [];

      conversationId = str(result.conversation_id) || conversationId;

      const out: AgentEvent[] = [...flushAllText()];

      const usage = readUsage(result.usage);
      if (usage) out.push({ kind: 'usage', sessionKey: conversationId, reading: usage });

      const response = str(result.response);
      const value = extractStructuredSignal(result.structured_output, response);
      if (value) out.push({ kind: 'structured', value });

      // The reply arrives here in one piece rather than as deltas, so it is
      // also the turn's text.
      if (response.trim()) out.push({ kind: 'text', text: response.trim() });

      const errorText = str(result.error);

      out.push({
        kind: 'result',
        text: response,
        sessionId: conversationId,
        outcome: readOutcome(str(result.status)),
        errorText,
        raw: result,
        denials: [...denials],
      });

      return out;
    }

    return [];
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

    finish(): AgentEvent[] {
      // Anything a turn that died before its result left behind.
      return flushAllText();
    },
  };
}
