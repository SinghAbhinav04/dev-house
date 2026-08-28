/**
 * Turning an agent CLI's output stream into events this codebase understands.
 *
 * Claude Code emits newline-delimited JSON whose shape is its own: `assistant`
 * messages carrying `tool_use` blocks, `user` messages carrying `tool_result`
 * blocks that refer back by `tool_use_id`, and a terminal `result`. Three places
 * used to parse that independently — the orchestrator, the chat route and the
 * team-proposal route — each reimplementing the same `tool_use_id → name` map
 * and drifting: the chat route never learned to describe Glob, Grep, WebSearch
 * or WebFetch calls, so its terminal view showed a bare tool name where the
 * orchestrator showed the query.
 *
 * Parsing lives here; acting on the result stays with the caller. That split is
 * what lets the orchestrator resolve a promise and kill a child on a denial
 * while the chat route just appends to a file, without either of them owning a
 * copy of the wire format.
 *
 * A decoder is **stateful and single-use**: it remembers which tool a
 * `tool_use_id` belonged to, which is the only way to interpret the result that
 * comes back later. Create one per spawn.
 */

import { basename } from 'node:path';

// Explicit extensions: the test suite imports these sources directly under
// --experimental-strip-types with no bundler to resolve them.
import { extractStructuredSignal } from '../pipeline-signal.ts';
import { summarizeToolResult } from '../events.ts';

/**
 * The tool vocabulary events are reported in.
 *
 * Claude Code's own names, used as the canonical set. That is a deliberate
 * choice rather than a default: `approval-gate.sh` matches on these strings and
 * has 54 contract tests pinned to them, so a second CLI translating *into* this
 * vocabulary costs one mapping table, while translating everything into a new
 * neutral vocabulary would cost the gate and its tests.
 */
export type CanonicalTool =
  | 'Read' | 'Write' | 'Edit' | 'NotebookEdit'
  | 'Bash' | 'Glob' | 'Grep'
  | 'WebFetch' | 'WebSearch'
  | 'Agent' | 'StructuredOutput'
  | (string & {});

export interface ToolCallEvent {
  kind: 'tool_call';
  callId: string;
  tool: CanonicalTool;
  input: Record<string, unknown>;
  /** One line for a log or a sprite's speech bubble. */
  description: string;
  /** The fuller story, shown when a terminal row is expanded. */
  detail: string;
}

export interface ToolResultEvent {
  kind: 'tool_result';
  callId: string;
  /** Empty when the result refers to a call this decoder never saw. */
  tool: CanonicalTool | '';
  isError: boolean;
  content: unknown;
  /** Condensed for display; empty when there is nothing worth showing. */
  summary: string;
  /** The error text, already stringified. Empty unless `isError`. */
  errorText: string;
}

export interface ResultEvent {
  kind: 'result';
  text: string;
  sessionId: string;
  /** The raw terminal event, for usage extraction and diagnostics. */
  raw: Record<string, unknown>;
  denials: { toolName: string; toolInput: Record<string, unknown> }[];
}

export type AgentEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text'; text: string }
  | ToolCallEvent
  | ToolResultEvent
  | { kind: 'structured'; value: Record<string, unknown> }
  | ResultEvent;

export interface AgentDecoder {
  /** Feed one line of the stream. Returns whatever it resolved to, possibly none. */
  push(line: string): AgentEvent[];
  /**
   * Called once the stream closes.
   *
   * Claude Code always emits a terminal `result`, so this is empty for it. It
   * exists for CLIs that simply stop — a decoder for one of those synthesises
   * the result here from what it accumulated.
   */
  finish(): AgentEvent[];
}

/**
 * How a tool call reads in the log.
 *
 * Keyed on the canonical tool name, so it serves every CLI once their names are
 * mapped, and lives in one place rather than once per parse site.
 */
export function describeToolCall(
  tool: CanonicalTool,
  input: Record<string, unknown>
): { description: string; detail: string } {
  const filePath = typeof input.file_path === 'string' ? input.file_path : '';
  const command = typeof input.command === 'string' ? input.command : '';
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';

  if (tool === 'Read' && filePath) {
    return { description: `READ ${basename(filePath)}`, detail: filePath };
  }

  if (tool === 'Write' && filePath) {
    const content = typeof input.content === 'string' ? input.content : '';
    const truncated = content.slice(0, 500) + (content.length > 500 ? '\n...' : '');
    return {
      description: `WRITE ${basename(filePath)}`,
      detail: `${filePath}\n--- content (${content.split('\n').length} lines) ---\n${truncated}`,
    };
  }

  if (tool === 'Edit' && filePath) {
    const before = typeof input.old_string === 'string' ? input.old_string : '';
    const after = typeof input.new_string === 'string' ? input.new_string : '';
    return {
      description: `EDIT ${basename(filePath)}`,
      detail: `${filePath}\n- ${before.slice(0, 100)}\n+ ${after.slice(0, 100)}`,
    };
  }

  if (tool === 'Bash' && command) {
    return { description: `BASH ${command.slice(0, 80)}`, detail: command };
  }

  if (tool === 'Glob' && pattern) return { description: `GLOB ${pattern}`, detail: '' };
  if (tool === 'Grep' && pattern) return { description: `GREP ${pattern}`, detail: '' };

  if (tool === 'WebSearch') {
    const query = typeof input.query === 'string' ? input.query : '';
    return { description: `SEARCH ${query}`, detail: '' };
  }

  if (tool === 'WebFetch' && typeof input.url === 'string') {
    return { description: `FETCH ${input.url}`, detail: '' };
  }

  return { description: tool, detail: '' };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function contentBlocks(event: Record<string, unknown>): Record<string, unknown>[] {
  const message = asRecord(event.message);
  const content = message?.content;
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/** A decoder for Claude Code's `--output-format stream-json`. */
export function createClaudeDecoder(): AgentDecoder {
  // The wire format refers back to a call by id, so the tool a result belongs
  // to is only knowable by having watched the call go past.
  const toolsByCallId = new Map<string, CanonicalTool>();
  let sessionId = '';

  function decode(event: Record<string, unknown>): AgentEvent[] {
    const type = event.type;

    if (type === 'system') {
      const streamed = typeof event.session_id === 'string' ? event.session_id : '';
      if (!streamed) return [];
      sessionId = streamed;
      return [{ kind: 'session', sessionId: streamed }];
    }

    if (type === 'assistant') {
      const out: AgentEvent[] = [];
      for (const block of contentBlocks(event)) {
        if (block.type === 'tool_use') {
          const tool = (block.name as CanonicalTool) || '';
          const input = asRecord(block.input) ?? {};
          const callId = typeof block.id === 'string' ? block.id : '';
          if (callId) toolsByCallId.set(callId, tool);
          out.push({ kind: 'tool_call', callId, tool, input, ...describeToolCall(tool, input) });
        } else if (block.type === 'text') {
          const text = (typeof block.text === 'string' ? block.text : '').trim();
          if (text) out.push({ kind: 'text', text });
        }
      }
      return out;
    }

    if (type === 'user') {
      const out: AgentEvent[] = [];
      for (const block of contentBlocks(event)) {
        if (block.type !== 'tool_result') continue;

        const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        const tool = toolsByCallId.get(callId) ?? '';
        const isError = Boolean(block.is_error);

        // The verdict channel. Only trusted on a successful call — a failed
        // StructuredOutput carries an error message, not an answer.
        if (!isError && tool === 'StructuredOutput') {
          const value = extractStructuredSignal(block.content);
          if (value) out.push({ kind: 'structured', value });
        }

        const summary =
          !isError && tool && tool !== 'StructuredOutput'
            ? summarizeToolResult(tool, block.content)
            : '';

        out.push({
          kind: 'tool_result',
          callId,
          tool,
          isError,
          content: block.content,
          summary,
          errorText: isError ? stringify(block.content) : '',
        });
      }
      return out;
    }

    if (type === 'result') {
      const out: AgentEvent[] = [];

      const value = extractStructuredSignal(event.structured_output, event.result);
      if (value) out.push({ kind: 'structured', value });

      const denials = (Array.isArray(event.permission_denials) ? event.permission_denials : [])
        .map((raw) => asRecord(raw))
        .filter((raw): raw is Record<string, unknown> => raw !== null)
        .map((raw) => ({
          toolName: typeof raw.tool_name === 'string' ? raw.tool_name : '',
          toolInput: asRecord(raw.tool_input) ?? {},
        }));

      out.push({
        kind: 'result',
        text: typeof event.result === 'string' ? event.result : '',
        sessionId: typeof event.session_id === 'string' ? event.session_id : sessionId,
        raw: event,
        denials,
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
        // Not every line is an event — the CLI is free to write anything to
        // stdout. Skipping is right; the caller still counts the line as
        // liveness for the stall watcher.
        return [];
      }

      return event ? decode(event) : [];
    },

    finish(): AgentEvent[] {
      return [];
    },
  };
}
