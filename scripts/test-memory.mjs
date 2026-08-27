#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  MAX_CLAIM_LENGTH,
  MAX_INDEX_LINES,
  MAX_MEMORY_BLOCK_CHARS,
  MEMORY_BLOCK_LIMIT,
  buildMemoryBlock,
  buildMemorySelection,
  ensureMemoryDirs,
  ingestInbox,
  memoryArchivePath,
  memoryEntriesDir,
  memoryIndexPath,
  memoryInboxDir,
  parseIndexLine,
  readIndex,
  recordToInbox,
  withMemory,
} = await import('../src/lib/team/memory.ts');

const project = mkdtempSync(join(tmpdir(), 'hackeroom-memory-'));
ensureMemoryDirs(project);

function drop(name, body) {
  writeFileSync(join(memoryInboxDir(project), name), body);
}

// ── Empty memory costs nothing ───────────────────────────────────────

assert.equal(buildMemoryBlock(project), '', 'an empty memory injects no block at all');
assert.equal(withMemory(project, 'do the thing'), 'do the thing', 'and leaves the prompt untouched');
assert.deepEqual(readIndex(project), []);

// ── Ingest ───────────────────────────────────────────────────────────

drop(
  'reacty-1.md',
  `---
kind: decision
claim: Sessions are JWT-based, not database-backed
tags: auth, sessions
files: src/lib/auth.ts
author: reacty
---

Chose JWT because the deploy target has no persistent store.
`
);

let result = ingestInbox(project);
assert.equal(result.added.length, 1);
assert.equal(result.duplicates, 0);

const [entry] = result.added;
assert.equal(entry.id, 'm1');
assert.equal(entry.kind, 'decision');
assert.equal(entry.claim, 'Sessions are JWT-based, not database-backed');
assert.deepEqual(entry.tags, ['auth', 'sessions']);
assert.deepEqual(entry.files, ['src/lib/auth.ts']);
assert.equal(entry.author, 'reacty');

assert.ok(!existsSync(join(memoryInboxDir(project), 'reacty-1.md')), 'the inbox file is consumed');
assert.ok(existsSync(join(memoryEntriesDir(project), 'm1.md')), 'the full entry is written');
assert.match(readFileSync(join(memoryEntriesDir(project), 'm1.md'), 'utf8'), /no persistent store/, 'detail is preserved');

// ── The index line is the cheap part ─────────────────────────────────

const index = readIndex(project);
assert.equal(index.length, 1);
assert.deepEqual(index[0], {
  id: 'm1',
  kind: 'decision',
  tags: ['auth', 'sessions'],
  claim: 'Sessions are JWT-based, not database-backed',
  files: ['src/lib/auth.ts'],
});

const rawIndex = readFileSync(memoryIndexPath(project), 'utf8').trim();
assert.equal(rawIndex, '[m1] decision · auth/sessions · Sessions are JWT-based, not database-backed · src/lib/auth.ts');
assert.ok(rawIndex.length < 140, 'one fact costs one short line');
assert.deepEqual(parseIndexLine(rawIndex), index[0], 'the line round-trips');

const block = buildMemoryBlock(project);
assert.match(block, /\[TEAM MEMORY\] 1 fact/);
assert.match(block, /read .*entries\/<id>\.md/, 'points at the detail rather than inlining it');
assert.ok(!block.includes('no persistent store'), 'the body is NOT injected — that is the whole point');
// The block goes AFTER the prompt. It changes every turn, so leading with it
// made every token behind it a cache miss; the stable part of a prompt belongs
// at the front.
const withBlock = withMemory(project, 'do the thing');
assert.ok(withBlock.startsWith('do the thing'), 'the prompt leads');
assert.ok(withBlock.trimEnd().endsWith('[END TEAM MEMORY]'), 'the volatile block trails');

// ── Dedupe ───────────────────────────────────────────────────────────

drop('tess-1.md', `---\nkind: decision\nclaim: sessions are JWT based, NOT database backed!!\n---\nsame thing, said differently\n`);
result = ingestInbox(project);
assert.equal(result.added.length, 0, 'a restated claim is not recorded twice');
assert.equal(result.duplicates, 1);
assert.equal(readIndex(project).length, 1);

// ── Ids keep climbing ────────────────────────────────────────────────

drop('pat-1.md', `---\nkind: gotcha\nclaim: The build fails on node 18 because of the ESM loader\n---\ndetail\n`);
result = ingestInbox(project);
assert.equal(result.added[0].id, 'm2', 'ids increment');

// ── Malformed input degrades, never throws ───────────────────────────

drop('junk-1.md', 'no frontmatter at all, just a line');
result = ingestInbox(project);
assert.equal(result.added.length, 1, 'a bare line is taken as the claim');
assert.equal(result.added[0].claim, 'no frontmatter at all, just a line');
assert.equal(result.added[0].kind, 'fact', 'kind falls back');

drop('empty-1.md', '---\nkind: fact\nclaim:\n---\n\n');
result = ingestInbox(project);
assert.equal(result.added.length, 0, 'an empty claim is dropped, not indexed as a blank line');

drop('badkind-1.md', `---\nkind: prophecy\nclaim: Something with an unknown kind\n---\nx\n`);
result = ingestInbox(project);
assert.equal(result.added[0].kind, 'fact', 'an unrecognised kind falls back rather than failing');

// ── Long claims are capped ───────────────────────────────────────────

drop('long-1.md', `---\nkind: fact\nclaim: ${'x'.repeat(400)}\n---\nbody\n`);
result = ingestInbox(project);
assert.ok(result.added[0].claim.length <= MAX_CLAIM_LENGTH, 'one verbose entry cannot dominate the index');
assert.ok(result.added[0].claim.endsWith('…'));

// Tags and files are capped too, so a line stays a line.
drop('tagspam-1.md', `---\nkind: fact\nclaim: Tag spam is trimmed\ntags: a, b, c, d, e, f\nfiles: 1.ts, 2.ts, 3.ts, 4.ts\n---\nx\n`);
result = ingestInbox(project);
assert.equal(result.added[0].tags.length, 3);
assert.equal(result.added[0].files.length, 3);

// ── recordToInbox round-trips ────────────────────────────────────────

recordToInbox(project, { claim: 'Recorded by the orchestrator itself', kind: 'flow', author: 'system', detail: 'because' });
result = ingestInbox(project);
assert.equal(result.added.length, 1);
assert.equal(result.added[0].claim, 'Recorded by the orchestrator itself');
assert.equal(result.added[0].kind, 'flow');

// ── Rotation keeps the injected block a bounded cost ─────────────────

const before = readIndex(project).length;
for (let i = 0; i < MAX_INDEX_LINES; i++) {
  drop(`bulk-${i}.md`, `---\nkind: fact\nclaim: Bulk fact number ${i} about the system\n---\nbody ${i}\n`);
}
result = ingestInbox(project);

const after = readIndex(project);
assert.equal(after.length, MAX_INDEX_LINES, 'the index is capped');
assert.ok(result.archived > 0, 'the overflow was archived, not dropped');
assert.ok(existsSync(memoryArchivePath(project)), 'an archive file exists');
assert.ok(
  readFileSync(memoryArchivePath(project), 'utf8').includes('[m1]'),
  'the oldest entries are the ones that moved out'
);
assert.equal(readIndex(project).some((l) => l.id === 'm1'), false, 'and they are gone from the live index');

// Ids must not be reused after rotation, or entries/ would be overwritten.
drop('after-rotation.md', `---\nkind: fact\nclaim: Recorded after the archive rotated\n---\nx\n`);
result = ingestInbox(project);
const archivedIds = new Set(
  readFileSync(memoryArchivePath(project), 'utf8').split('\n').map((l) => parseIndexLine(l)?.id).filter(Boolean)
);
assert.equal(archivedIds.has(result.added[0].id), false, 'a new id never collides with an archived one');
assert.ok(before >= 0);

// ── The block stays bounded no matter how much is remembered ─────────

const bigBlock = buildMemoryBlock(project);
assert.ok(
  bigBlock.split('\n').length <= MAX_INDEX_LINES + 3,
  'the injected block is bounded by the cap, not by total facts ever recorded'
);
assert.equal(buildMemoryBlock(project, { limit: 5 }).split('\n').length, 8, 'callers can ask for fewer');

// The default injected slice is much smaller than what is kept on disk. The
// whole index used to go into every single turn regardless of who was running.
assert.ok(
  buildMemoryBlock(project).split('\n').length <= MEMORY_BLOCK_LIMIT + 3,
  'the default injection is the block limit, not the whole index',
);
assert.ok(
  bigBlock.length <= MAX_MEMORY_BLOCK_CHARS + 400,
  'the char backstop holds even when the line limit would allow more',
);
assert.ok(readIndex(project).length > MEMORY_BLOCK_LIMIT, 'the on-disk index really is larger than the slice');

// ── Selection is scoped to the job ───────────────────────────────────

const scoped = mkdtempSync(join(tmpdir(), 'hackeroom-memory-scope-'));
ensureMemoryDirs(scoped);

writeFileSync(
  join(memoryInboxDir(scoped), 'pat-1.md'),
  `---\nkind: decision\nclaim: We chose Postgres over SQLite for concurrent writes\ntags: storage\n---\nlong rationale\n`,
);
writeFileSync(
  join(memoryInboxDir(scoped), 'pat-2.md'),
  `---\nkind: interface\nclaim: createUser returns the row id, not the row\ntags: db\nfiles: src/db/users.ts\n---\nsignature detail\n`,
);
writeFileSync(
  join(memoryInboxDir(scoped), 'pat-3.md'),
  `---\nkind: gotcha\nclaim: The test runner needs DATABASE_URL set or it silently skips\ntags: testing\n---\nwhy\n`,
);
ingestInbox(scoped);

const coderPick = buildMemorySelection(scoped, { slot: 'coder', limit: 1 });
assert.deepEqual(
  coderPick.ids.length,
  1,
  'the limit is respected',
);
assert.ok(
  !buildMemorySelection(scoped, { slot: 'coder', limit: 1 }).block.includes('Postgres over SQLite'),
  'a settled architecture decision is not what a coder is short of',
);

const focused = buildMemorySelection(scoped, { slot: 'coder', focusFiles: ['src/db/users.ts'], limit: 1 });
assert.match(
  focused.block,
  /createUser returns the row id/,
  'a fact about the file being worked on outranks everything else',
);

const reviewerPick = buildMemorySelection(scoped, { slot: 'reviewer', limit: 1 });
assert.match(
  reviewerPick.block,
  /Postgres over SQLite/,
  'the same index reads differently for a reviewer, whose job is the decisions',
);

// ── Deltas: a resumed session is not re-told what it already has ─────

const first = buildMemorySelection(scoped, { slot: 'coder' });
assert.equal(first.ids.length, 3, 'a cold turn gets the full slice');
assert.match(first.block, /\[TEAM MEMORY\] 3 fact/);

const second = buildMemorySelection(scoped, { slot: 'coder', exclude: first.ids });
assert.equal(second.block, '', 'nothing new means nothing sent — not a second copy of the same block');
assert.deepEqual(second.ids, []);

writeFileSync(
  join(memoryInboxDir(scoped), 'reacty-4.md'),
  `---\nkind: gotcha\nclaim: The auth middleware runs after the body parser, not before\ntags: auth\n---\nwhy\n`,
);
ingestInbox(scoped);

const third = buildMemorySelection(scoped, { slot: 'coder', exclude: first.ids });
assert.equal(third.ids.length, 1, 'only the new fact goes into a resumed prompt');
assert.match(third.block, /\[TEAM MEMORY — NEW\] 1 fact/, 'and it is labelled as new rather than restated');
assert.ok(!third.block.includes('createUser returns'), 'what the session already has is not repeated');

rmSync(scoped, { recursive: true, force: true });
rmSync(project, { recursive: true, force: true });

console.log('memory checks passed');
