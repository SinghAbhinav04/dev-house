function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function looksLikeSignalRecord(value: Record<string, unknown>): boolean {
  return typeof value.status === 'string' && value.status.length > 0;
}

const WRAPPER_KEYS = ['structured_output', 'input', 'output', 'data', 'content', 'text', 'json', 'value'];

export function parseStructuredSignal(value: unknown, depth: number = 0): Record<string, unknown> | null {
  if (depth > 6 || value == null) return null;

  if (typeof value === 'string') {
    try {
      return parseStructuredSignal(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = parseStructuredSignal(item, depth + 1);
      if (parsed) return parsed;
    }
    return null;
  }

  if (!isRecord(value)) return null;
  if (looksLikeSignalRecord(value)) return value;

  for (const key of WRAPPER_KEYS) {
    if (!(key in value)) continue;
    const parsed = parseStructuredSignal(value[key], depth + 1);
    if (parsed) return parsed;
  }

  // Deliberately no walk over the remaining values. Descending into every
  // nested object and string made any `status` anywhere in the payload the
  // run's verdict — an HTTP response the member quoted, a nested tool result,
  // a JSON blob it echoed back. The wrapper keys above are the shapes the CLI
  // actually nests structured output inside; anything else is not an answer to
  // the question we asked.
  return null;
}

export function extractStructuredSignal(...candidates: unknown[]): Record<string, unknown> | null {
  for (const candidate of candidates) {
    const parsed = parseStructuredSignal(candidate);
    if (parsed) return parsed;
  }
  return null;
}

// ── Text fallback ───────────────────────────────────────────────────
//
// Used when the structured-output path produced nothing at all. Everything
// below fails closed: the pipeline's plan review, code review, testing and
// security audit gates all route their verdict through here, so a parser that
// guesses "approved" when it cannot tell converts a broken turn into a clean
// bill of health. This used to return `{ status: 'approved' }` both for text
// merely *containing* the word "approved" and, unconditionally, for anything
// it could not parse — including the empty string a killed turn produces.

/**
 * The status reported when a turn's output carries no readable verdict.
 * Deliberately not one of the values any gate treats as a pass.
 */
export const UNPARSEABLE_STATUS = 'unparseable';

/** A signal has to be a plain object carrying a non-empty string status. */
export function asSignalRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.status !== 'string' || !record.status.trim()) return null;
  return record;
}

/**
 * Slice out the first balanced `{...}` in some text.
 *
 * Brace counting has to skip string literals: a `}` inside a message value
 * would otherwise close the object early, and the truncated slice then fails
 * to parse — which, under the old code, fell through to "approved".
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

function tryJsonParse(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Read a verdict out of a turn's raw text output. Never guesses. */
export function parseTextSignal(result: string): Record<string, unknown> {
  if (!result || !result.trim()) return { status: UNPARSEABLE_STATUS };

  const direct = asSignalRecord(tryJsonParse(result));
  if (direct) return direct;

  const embedded = asSignalRecord(tryJsonParse(extractFirstJsonObject(result)));
  if (embedded) return embedded;

  return { status: UNPARSEABLE_STATUS };
}

/** Approved and passed are the same positive result. Nothing else is. */
export function isPositiveSignal(signal: unknown): boolean {
  const record = asSignalRecord(signal);
  if (!record) return false;
  const status = (record.status as string).toLowerCase();
  return status === 'approved' || status === 'passed';
}

/** True when the turn gave us no readable verdict at all. */
export function isUnparseableSignal(signal: unknown): boolean {
  const record = asSignalRecord(signal);
  return !record || record.status === UNPARSEABLE_STATUS;
}
