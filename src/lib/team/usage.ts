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
  /**
   * Reasoning tokens, where the CLI reports them separately.
   *
   * Recorded for display only, and deliberately NOT part of billableTokens:
   * whether a CLI's output count already includes its thinking count is
   * per-CLI and undocumented, and adding it blind would charge a
   * thinking-heavy model twice against its budget.
   */
  thinkingTokens: number;
  /**
   * Billable tokens that arrived with no price attached.
   *
   * Not every CLI reports cost. Without this, a member on one that does not
   * shows $0.00 next to half a million tokens, which reads as a measured zero
   * rather than a missing number. Tracking it lets the UI say "and N tokens
   * with no price attached" instead of implying the total is complete.
   */
  unpricedTokens: number;
}

export interface UsageBreakdown {
  total: TokenUsage;
  /** Keyed by member id. */
  byMember: Record<string, TokenUsage>;
  /** Keyed by the model string actually passed to the CLI. */
  byModel: Record<string, TokenUsage>;
}

export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalCostUsd: 0,
    thinkingTokens: 0,
    unpricedTokens: 0,
  };
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
  target.thinkingTokens += delta.thinkingTokens;
  target.unpricedTokens += delta.unpricedTokens;
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
    // Claude Code reports a cost on every result, so nothing here is unpriced
    // and it does not break thinking out separately.
    thinkingTokens: 0,
    unpricedTokens: 0,
  };
}

// ── Cumulative reporters ─────────────────────────────────────────────

/**
 * How a CLI reports usage.
 *
 * `delta` — each event carries only what that step consumed. Add it and move on.
 * `cumulative` — each event carries the running total for the whole session.
 *   Adding those directly counts turn one again on turn two, and again on turn
 *   three: a ten-turn phase would report several times the tokens actually
 *   spent, and budget warnings would fire on members that are well within them.
 */
export type UsageReporting = 'delta' | 'cumulative';

export interface UsageMeter {
  /**
   * Convert one reading into the delta to record.
   *
   * `sessionKey` scopes the running total. It must be the CLI's own session or
   * conversation id, not the turn — a resumed turn continues the same session,
   * so a meter keyed per turn would bank the entire conversation again every
   * time one resumes.
   */
  observe(sessionKey: string, reading: TokenUsage): TokenUsage;
  /** High-water marks so far, for persisting across an orchestrator restart. */
  snapshot(): Record<string, TokenUsage>;
}

function subtractClamped(reading: TokenUsage, last: TokenUsage): TokenUsage {
  // Clamped at zero throughout. A counter that resets, or a field that stops
  // being reported, must never subtract from a running budget.
  const diff = (a: number, b: number) => Math.max(0, a - b);

  return {
    inputTokens: diff(reading.inputTokens, last.inputTokens),
    outputTokens: diff(reading.outputTokens, last.outputTokens),
    cacheReadTokens: diff(reading.cacheReadTokens, last.cacheReadTokens),
    cacheWriteTokens: diff(reading.cacheWriteTokens, last.cacheWriteTokens),
    totalCostUsd: diff(reading.totalCostUsd, last.totalCostUsd),
    thinkingTokens: diff(reading.thinkingTokens, last.thinkingTokens),
    unpricedTokens: diff(reading.unpricedTokens, last.unpricedTokens),
  };
}

/**
 * Turn a CLI's usage readings into deltas that can be recorded.
 *
 * Seed it from a previous `snapshot()` so a restarted orchestrator does not
 * re-bank a conversation it had already counted — every audit action spawns a
 * fresh orchestrator process against the same run.
 */
export function createUsageMeter(
  mode: UsageReporting,
  seed: Record<string, TokenUsage> = {}
): UsageMeter {
  const highWater = new Map<string, TokenUsage>(Object.entries(seed).map(([k, v]) => [k, coerceUsage(v)]));

  return {
    observe(sessionKey: string, reading: TokenUsage): TokenUsage {
      if (mode === 'delta') return reading;

      // An unseen session means the whole reading is new, which is correct for
      // a cold start and for the first turn of any conversation.
      const last = highWater.get(sessionKey);
      highWater.set(sessionKey, reading);
      return last ? subtractClamped(reading, last) : reading;
    },

    snapshot(): Record<string, TokenUsage> {
      return Object.fromEntries(highWater);
    },
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
    // Absent in every state file written before these existed; zero is right.
    thinkingTokens: num(input.thinkingTokens),
    unpricedTokens: num(input.unpricedTokens),
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
