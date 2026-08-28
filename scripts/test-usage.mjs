#!/usr/bin/env node

import assert from 'node:assert/strict';

const {
  billableTokens,
  createUsageMeter,
  emptyBreakdown,
  emptyUsage,
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
  // Claude Code prices every result and does not break thinking out, so both
  // are zero on this path rather than absent.
  thinkingTokens: 0,
  unpricedTokens: 0,
});

assert.deepEqual(
  usageFromResultEvent({}),
  emptyUsage(),
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

// ── Cumulative reporters ─────────────────────────────────────────────
//
// recordUsage() ADDS whatever it is handed. Some CLIs send the session's
// running total on every event rather than that step's own consumption, so
// handing those readings straight to recordUsage counts turn one again on turn
// two and again on turn three. On a ten-turn coding phase that reports several
// times the tokens actually spent, and fires budget warnings on members well
// inside their limits.

const reading = (input, output = 0) => ({ ...emptyUsage(), inputTokens: input, outputTokens: output });

// A delta reporter is passed through untouched — the meter costs it nothing.
const deltaMeter = createUsageMeter('delta');
assert.deepEqual(deltaMeter.observe('s1', reading(100)), reading(100));
assert.deepEqual(
  deltaMeter.observe('s1', reading(100)),
  reading(100),
  'a delta CLI sending the same numbers twice really did spend them twice',
);
assert.deepEqual(deltaMeter.snapshot(), {}, 'and nothing needs remembering');

// A cumulative reporter only ever contributes what is new.
const cumulative = createUsageMeter('cumulative');
assert.deepEqual(cumulative.observe('s1', reading(100, 10)), reading(100, 10), 'the first reading is all new');
assert.deepEqual(
  cumulative.observe('s1', reading(150, 25)),
  reading(50, 15),
  'the second contributes only the difference',
);
assert.deepEqual(
  cumulative.observe('s1', reading(150, 25)),
  reading(0, 0),
  'an unchanged reading contributes nothing — this is the resumed-turn case',
);

// Sessions are independent; one conversation's total is not another's baseline.
assert.deepEqual(
  cumulative.observe('s2', reading(80)),
  reading(80),
  'a different session starts from zero, not from s1',
);

// A counter that goes backwards must never subtract from a running budget.
assert.deepEqual(
  cumulative.observe('s1', reading(10, 5)),
  reading(0, 0),
  'a reset or a dropped field clamps at zero rather than refunding tokens',
);

// Seeding is what survives an orchestrator restart. Every audit action spawns a
// fresh process against the same run; without the seed it would treat the next
// reading as entirely new and bank a whole conversation twice.
const before = createUsageMeter('cumulative');
before.observe('s9', reading(500, 200));

const after = createUsageMeter('cumulative', before.snapshot());
assert.deepEqual(
  after.observe('s9', reading(520, 210)),
  reading(20, 10),
  'a restarted run resumes from the high-water mark it had already counted',
);

const unseeded = createUsageMeter('cumulative');
assert.deepEqual(
  unseeded.observe('s9', reading(520, 210)),
  reading(520, 210),
  'and without the seed it would have re-banked the entire conversation',
);

// ── The new fields ───────────────────────────────────────────────────

const fresh = emptyUsage();
assert.equal(fresh.thinkingTokens, 0);
assert.equal(fresh.unpricedTokens, 0);

assert.equal(
  billableTokens({ ...emptyUsage(), inputTokens: 10, outputTokens: 5, thinkingTokens: 1000 }),
  15,
  'thinking tokens are displayed but not billed — whether a CLI already counts them inside output is per-CLI and undocumented, and guessing would charge twice',
);

const migrated = normalizeUsage({ total: { inputTokens: 7 }, byMember: {}, byModel: {} });
assert.equal(migrated.total.thinkingTokens, 0, 'state files written before these fields read as zero');
assert.equal(migrated.total.unpricedTokens, 0);

const oldFlat = normalizeUsage({ inputTokens: 3, outputTokens: 4 });
assert.equal(oldFlat.total.inputTokens, 3, 'the pre-breakdown flat shape still migrates');
assert.equal(oldFlat.total.unpricedTokens, 0);

console.log('usage checks passed');
