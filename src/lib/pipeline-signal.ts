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

  for (const nested of Object.values(value)) {
    if (nested !== null && (typeof nested === 'object' || typeof nested === 'string')) {
      const parsed = parseStructuredSignal(nested, depth + 1);
      if (parsed) return parsed;
    }
  }

  return null;
}

export function extractStructuredSignal(...candidates: unknown[]): Record<string, unknown> | null {
  for (const candidate of candidates) {
    const parsed = parseStructuredSignal(candidate);
    if (parsed) return parsed;
  }
  return null;
}
