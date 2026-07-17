#!/usr/bin/env node

import assert from 'node:assert/strict';

const {
  billableTokens,
  emptyBreakdown,
  membersOverBudget,
  normalizeUsage,
  recordUsage,
  usageFromResultEvent,
} = await import('../src/lib/team/usage.ts');

// ── Reading a CLI result event ───────────────────────────────────────

const delta = usageFromResultEvent({
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 50,
  },
  total_cost_usd: 0.0125,
});

assert.deepEqual(delta, {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 900,
  cacheWriteTokens: 50,
  totalCostUsd: 0.0125,
});

assert.deepEqual(
  usageFromResultEvent({}),
  { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalCostUsd: 0 },
  'a result event with no usage block is zero, not NaN'
);
assert.equal(usageFromResultEvent({ usage: { input_tokens: 'lots' } }).inputTokens, 0, 'non-numeric usage is ignored');

// ── Attribution ──────────────────────────────────────────────────────

const breakdown = emptyBreakdown();

recordUsage(breakdown, delta, { memberId: 'reacty', model: 'haiku' });
recordUsage(breakdown, delta, { memberId: 'reacty', model: 'haiku' });
recordUsage(breakdown, delta, { memberId: 'pat', model: 'opus' });

assert.equal(breakdown.total.inputTokens, 300, 'the total still adds up');
assert.equal(breakdown.byMember.reacty.inputTokens, 200, 'per-member attribution');
assert.equal(breakdown.byMember.pat.inputTokens, 100);
assert.equal(breakdown.byModel.haiku.inputTokens, 200, 'per-model attribution');
assert.equal(breakdown.byModel.opus.inputTokens, 100);

// Cost is the number the CLI reported, summed the same way.
assert.ok(Math.abs(breakdown.total.totalCostUsd - 0.0375) < 1e-9);
assert.ok(Math.abs(breakdown.byMember.reacty.totalCostUsd - 0.025) < 1e-9);

recordUsage(breakdown, delta, { memberId: '', model: '' });
assert.equal(breakdown.total.inputTokens, 400, 'unattributed usage still reaches the total');
assert.equal(Object.keys(breakdown.byMember).length, 2, 'but does not invent a member');

// ── Billable tokens ──────────────────────────────────────────────────
// Cache reads are excluded: they are the cheap path, and counting them would
// make a member look expensive precisely when caching is working.

assert.equal(billableTokens(delta), 170, 'input + output + cache writes, not cache reads');

// ── Migration from the old flat shape ────────────────────────────────

const legacy = normalizeUsage({
  inputTokens: 5,
  outputTokens: 6,
  cacheReadTokens: 7,
  cacheWriteTokens: 8,
  totalCostUsd: 9,
});
assert.equal(legacy.total.inputTokens, 5, 'an old flat state file becomes the total');
assert.deepEqual(legacy.byMember, {}, 'with no breakdown, rather than being discarded');
assert.deepEqual(legacy.byModel, {});

const modern = normalizeUsage(breakdown);
assert.equal(modern.total.inputTokens, 400, 'the new shape round-trips');
assert.equal(modern.byMember.reacty.inputTokens, 200);

assert.deepEqual(normalizeUsage(null), emptyBreakdown(), 'null is an empty breakdown');
assert.deepEqual(normalizeUsage('nonsense'), emptyBreakdown());
assert.equal(normalizeUsage({ total: { inputTokens: 'x' } }).total.inputTokens, 0, 'garbage coerces to zero');

// ── Budgets ──────────────────────────────────────────────────────────

const budgets = { reacty: 150, pat: 100_000 };
const over = membersOverBudget(breakdown, budgets);

assert.equal(over.length, 1, 'only the member past its budget is reported');
assert.equal(over[0].memberId, 'reacty');
assert.equal(over[0].used, 340);
assert.equal(over[0].budget, 150);

assert.deepEqual(membersOverBudget(breakdown, {}), [], 'no budgets means no warnings');
assert.deepEqual(membersOverBudget(breakdown, { reacty: 0 }), [], 'a zero budget means unlimited, not instantly over');
assert.deepEqual(membersOverBudget(emptyBreakdown(), budgets), [], 'nothing spent, nothing to warn about');

console.log('usage checks passed');
