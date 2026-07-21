/**
 * Shared vocabulary for pipeline events.
 *
 * How an event should look was previously decided independently in five places
 * — the live feed, the supervisor panel, the member panels, the detail modal
 * and the audit panel — which meant the same event type could render in
 * different colours depending on where you were looking at it.
 */

export type EventTone =
  | 'muted'
  | 'info'
  | 'text'
  | 'success'
  | 'warning'
  | 'danger'
  | 'accent'
  | 'user';

export interface EventStyle {
  tone: EventTone;
  /** Short uppercase tag shown in terminal-style views. */
  tag: string;
  /** Whether the body is prose worth rendering as markdown. */
  prose: boolean;
}

const STYLES: Record<string, EventStyle> = {
  status: { tone: 'info', tag: 'STATUS', prose: false },
  send: { tone: 'accent', tag: 'SEND', prose: false },
  receive: { tone: 'accent', tag: 'RECV', prose: false },
  handoff: { tone: 'accent', tag: 'HANDOFF', prose: false },
  question: { tone: 'warning', tag: 'ASK', prose: true },
  answer: { tone: 'success', tag: 'ANSWER', prose: true },
  issue: { tone: 'danger', tag: 'ISSUE', prose: true },
  fix: { tone: 'success', tag: 'FIX', prose: false },
  approval: { tone: 'success', tag: 'OK', prose: false },
  failure: { tone: 'danger', tag: 'FAIL', prose: true },
  permission_denied: { tone: 'warning', tag: 'DENIED', prose: false },
  dismissal: { tone: 'muted', tag: 'DISMISS', prose: false },
  tool_call: { tone: 'muted', tag: 'TOOL', prose: false },
  tool_result: { tone: 'muted', tag: '  ↳', prose: false },
  text: { tone: 'text', tag: '', prose: true },
  user_msg: { tone: 'user', tag: 'YOU', prose: true },
};

const FALLBACK: EventStyle = { tone: 'muted', tag: '', prose: false };

export function eventStyle(type: string): EventStyle {
  return STYLES[type] ?? FALLBACK;
}

/**
 * Tailwind text colour per tone. These read from the theme tokens rather than
 * naming palette colours directly, so a re-theme moves them all at once.
 */
export const TONE_TEXT_CLASS: Record<EventTone, string> = {
  muted: 'text-ink-faint',
  info: 'text-accent-cool',
  text: 'text-ink-soft',
  success: 'text-signal-ok',
  warning: 'text-signal-warn',
  danger: 'text-signal-bad',
  accent: 'text-accent',
  user: 'text-ink',
};

export function eventToneClass(type: string): string {
  return TONE_TEXT_CLASS[eventStyle(type).tone];
}

/** HH:MM:SS, the density a log wants. */
export function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString('en-GB', { hour12: false });
}

/** Events that carry a payload worth expanding in the terminal. */
export function hasExpandableDetail(event: { detail?: string }): boolean {
  return typeof event.detail === 'string' && event.detail.trim().length > 0;
}

// ── Tool result summaries ────────────────────────────────────────────

/** Cap on a tool result excerpt stored in an event. */
export const MAX_RESULT_EXCERPT = 300;

function firstLines(text: string, count: number): string {
  return text.split('\n').slice(0, count).join('\n');
}

/**
 * A short, useful summary of what a tool actually returned.
 *
 * Tool results were never emitted at all, so a terminal view had nothing to
 * show between a call and the next message. Storing them whole would balloon
 * the state file, so each tool gets the shape of answer that is worth reading:
 * a count for searches, output for commands, a size for reads.
 */
export function summarizeToolResult(toolName: string, content: unknown): string {
  const text = typeof content === 'string' ? content : safeStringify(content);
  const trimmed = text.trim();
  if (!trimmed) return 'no output';

  switch (toolName) {
    case 'Read': {
      const lines = trimmed.split('\n').length;
      return `${lines} line${lines === 1 ? '' : 's'}`;
    }
    case 'Grep':
    case 'Glob': {
      const lines = trimmed.split('\n').filter(Boolean).length;
      return `${lines} match${lines === 1 ? '' : 'es'}`;
    }
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return firstLines(trimmed, 1).slice(0, 120) || 'written';
    case 'Bash':
      return excerpt(trimmed);
    default:
      return excerpt(trimmed);
  }
}

function excerpt(text: string): string {
  if (text.length <= MAX_RESULT_EXCERPT) return text;
  return `${text.slice(0, MAX_RESULT_EXCERPT)}… (${text.length - MAX_RESULT_EXCERPT} more chars)`;
}

function safeStringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
