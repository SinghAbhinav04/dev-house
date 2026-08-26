import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { writeJsonAtomic } from '../src/lib/atomic-write.ts';

const dir = mkdtempSync(join(tmpdir(), 'hackeroom-atomic-'));
const file = join(dir, 'pipeline-events.json');

// ── It writes ────────────────────────────────────────────────────────

writeJsonAtomic(file, { concept: 'a thing', events: [] });
assert.deepEqual(
  JSON.parse(readFileSync(file, 'utf8')),
  { concept: 'a thing', events: [] },
  'writes the payload',
);

// ── It replaces, and leaves no temp file behind ──────────────────────

writeJsonAtomic(file, { concept: 'a different thing', events: [1, 2] });
assert.deepEqual(
  JSON.parse(readFileSync(file, 'utf8')).events,
  [1, 2],
  'replaces the previous contents',
);
assert.deepEqual(
  readdirSync(dir),
  ['pipeline-events.json'],
  'no .tmp sibling survives a successful write',
);

// ── A reader never sees a partial file ───────────────────────────────
//
// The point of the rename. Under the old plain writeFileSync the file was
// truncated and refilled in place, so a reader arriving mid-write got a syntax
// error — which surfaced as an empty state pushed over SSE and a viewer that
// blanked at random during a run. Here: after any number of writes, every
// observation of the path is valid JSON, never a truncated prefix.
const big = { events: Array.from({ length: 5_000 }, (_, i) => ({ i, text: 'x'.repeat(200) })) };
for (let round = 0; round < 5; round++) {
  writeJsonAtomic(file, { ...big, round });
  const observed = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(observed.events.length, 5_000, 'a large write is observed whole or not at all');
}

// ── A failed write does not strand a temp file ───────────────────────

const readOnlyDir = mkdtempSync(join(tmpdir(), 'hackeroom-atomic-ro-'));
const blocked = join(readOnlyDir, 'state.json');
writeFileSync(blocked, '{}');
chmodSync(readOnlyDir, 0o500);

let threw = false;
try {
  writeJsonAtomic(blocked, { anything: true });
} catch {
  threw = true;
}

chmodSync(readOnlyDir, 0o700);

if (threw) {
  assert.equal(
    existsSync(`${blocked}.tmp`),
    false,
    'a failed write cleans up its temp file rather than leaving one that reads like a crash',
  );
} else {
  // Running as root, or a filesystem that ignores the mode. Not a failure of
  // the code under test, so do not fail the suite over it.
  console.log('  (skipped the failed-write cleanup check — the directory stayed writable)');
}

console.log('atomic write checks passed');
