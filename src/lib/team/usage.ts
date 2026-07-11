/**
 * Token and cost accounting, broken down per member.
 *
 * The CLI reports usage and `total_cost_usd` on each result event, and the
 * orchestrator always knows which member it spawned, so attribution is free —
 * it simply was not being recorded. Previously everything landed in one flat
 * counter that nothing in the UI ever read.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCostUsd: number;
}

export interface UsageBreakdown {
  total: TokenUsage;
  /** Keyed by member id. */
  byMember: Record<string, TokenUsage>;
  /** Keyed by the model string actually passed to the CLI. */
  byModel: Record<string, TokenUsage>;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCostUsd: 0 };
}

export function emptyBreakdown(): UsageBreakdown {
  return { total: emptyUsage(), byMember: {}, byModel: {} };
}

/** Tokens that count against a member's budget: what the model actually processed. */
export function billableTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens;
}

function addInto(target: TokenUsage, delta: TokenUsage): void {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
  target.cacheWriteTokens += delta.cacheWriteTokens;
  target.totalCostUsd += delta.totalCostUsd;
}

/** Pull a usage delta out of a raw CLI `result` stream event. */
export function usageFromResultEvent(event: Record<string, unknown>): TokenUsage {
  const usage = (event.usage as Record<string, unknown>) || {};
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

  return {
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWriteTokens: num(usage.cache_creation_input_tokens),
    totalCostUsd: num(event.total_cost_usd),
  };
}

/** Record a delta against the total, the member, and the model at once. */
export function recordUsage(
  breakdown: UsageBreakdown,
  delta: TokenUsage,
  attribution: { memberId: string; model: string }
): void {
  addInto(breakdown.total, delta);

  if (attribution.memberId) {
    breakdown.byMember[attribution.memberId] ||= emptyUsage();
    addInto(breakdown.byMember[attribution.memberId], delta);
  }

  if (attribution.model) {
    breakdown.byModel[attribution.model] ||= emptyUsage();
    addInto(breakdown.byModel[attribution.model], delta);
  }
}

function coerceUsage(raw: unknown): TokenUsage {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

  return {
    inputTokens: num(input.inputTokens),
    outputTokens: num(input.outputTokens),
    cacheReadTokens: num(input.cacheReadTokens),
    cacheWriteTokens: num(input.cacheWriteTokens),
    totalCostUsd: num(input.totalCostUsd),
  };
}

function coerceMap(raw: unknown): Record<string, TokenUsage> {
  if (!raw || typeof raw !== 'object') return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([key, value]) => [key, coerceUsage(value)]));
}

/**
 * Read a usage value from a state file, accepting the old flat shape.
 *
 * State files written before per-member accounting stored a bare TokenUsage;
 * those become the total with no breakdown rather than being discarded.
 */
export function normalizeUsage(raw: unknown): UsageBreakdown {
  if (!raw || typeof raw !== 'object') return emptyBreakdown();
  const input = raw as Record<string, unknown>;

  if (input.total === undefined && input.inputTokens !== undefined) {
    return { total: coerceUsage(input), byMember: {}, byModel: {} };
  }

  return {
    total: coerceUsage(input.total),
    byMember: coerceMap(input.byMember),
    byModel: coerceMap(input.byModel),
  };
}

/** Members over their configured budget, for warnings and halting. */
export function membersOverBudget(
  breakdown: UsageBreakdown,
  budgets: Record<string, number | undefined>
): Array<{ memberId: string; used: number; budget: number }> {
  const over: Array<{ memberId: string; used: number; budget: number }> = [];

  for (const [memberId, usage] of Object.entries(breakdown.byMember)) {
    const budget = budgets[memberId];
    if (!budget || budget <= 0) continue;

    const used = billableTokens(usage);
    if (used >= budget) over.push({ memberId, used, budget });
  }

  return over;
}
