/**
 * Shared team memory.
 *
 * Members run as separate Claude sessions and cannot see each other's context,
 * so anything one of them learns is lost unless it is written down. This is the
 * place they write it down.
 *
 * The design constraint is token cost. A transcript-shaped memory would be
 * re-fed into every prompt and would grow without bound, so instead memory is
 * split in two:
 *
 *   index.md      one ~120-char line per fact. This is the only part injected
 *                 into prompts, so N facts cost roughly N lines, not N pages.
 *   entries/<id>  the full detail, read on demand by whoever needs it.
 *
 * Members cannot append to the index directly — most of them are write-blocked
 * by the hook, and letting several sessions edit one file concurrently would
 * corrupt it. They drop files into inbox/ instead and the orchestrator ingests
 * them between turns.
 *
 *   <project>/.squad/memory/
 *     index.md
 *     entries/<id>.md
 *     inbox/<member>-<timestamp>.md
 *     archive.md
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const MEMORY_DIR = '.squad/memory';

/** Index lines kept on disk before older ones are archived. */
export const MAX_INDEX_LINES = 120;

/**
 * Index lines actually injected into a prompt.
 *
 * Much smaller than what is kept on disk, and deliberately so. The whole
 * 120-line index used to go into every turn regardless of who was running or
 * what they were doing — roughly 3-6k tokens, on a "fix each issue" prompt as
 * readily as on a research turn. The file stays the team's full record; this is
 * how much of it is worth paying for on any one turn.
 */
export const MEMORY_BLOCK_LIMIT = 20;

/**
 * Hard ceiling on the injected block, whatever the scoring decides.
 *
 * A backstop, not a target: if a future change to the ranking lets more through
 * than intended, the cost is still bounded. Lines are dropped lowest-scoring
 * first so the cut is never arbitrary.
 */
export const MAX_MEMORY_BLOCK_CHARS = 3000;

/** Hard cap on a single index line, so one verbose entry cannot dominate. */
export const MAX_CLAIM_LENGTH = 120;

export const MEMORY_KINDS = ['decision', 'flow', 'gotcha', 'fact', 'interface'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  claim: string;
  tags: string[];
  files: string[];
  author: string;
  detail: string;
}

export interface IndexLine {
  id: string;
  kind: MemoryKind;
  tags: string[];
  claim: string;
  files: string[];
}

// ── Paths ────────────────────────────────────────────────────────────

export function memoryDir(projectDir: string): string {
  return join(projectDir, '.squad', 'memory');
}

export function memoryIndexPath(projectDir: string): string {
  return join(memoryDir(projectDir), 'index.md');
}

export function memoryEntriesDir(projectDir: string): string {
  return join(memoryDir(projectDir), 'entries');
}

export function memoryInboxDir(projectDir: string): string {
  return join(memoryDir(projectDir), 'inbox');
}

export function memoryArchivePath(projectDir: string): string {
  return join(memoryDir(projectDir), 'archive.md');
}

export function ensureMemoryDirs(projectDir: string): void {
  mkdirSync(memoryEntriesDir(projectDir), { recursive: true });
  mkdirSync(memoryInboxDir(projectDir), { recursive: true });
}

// ── Index format ─────────────────────────────────────────────────────
//
// [m17] decision · auth · Sessions are JWT, not DB-backed · src/lib/auth.ts

function formatIndexLine(entry: IndexLine): string {
  // The id is a prefix, not a field — it must not be joined with the same
  // separator the parser splits on, or the line will not round-trip.
  const parts: string[] = [entry.kind];
  if (entry.tags.length > 0) parts.push(entry.tags.join('/'));
  parts.push(entry.claim);
  if (entry.files.length > 0) parts.push(entry.files.join(' '));
  return `[${entry.id}] ${parts.join(' · ')}`;
}

export function parseIndexLine(line: string): IndexLine | null {
  const match = /^\[([a-z0-9]+)\]\s+(.*)$/.exec(line.trim());
  if (!match) return null;

  const [, id, rest] = match;
  const segments = rest.split(' · ').map((s) => s.trim());
  const kind = (MEMORY_KINDS as readonly string[]).includes(segments[0]) ? (segments[0] as MemoryKind) : 'fact';

  // Segments are [kind, tags?, claim, files?]; the claim is the only one that
  // is always present, so work inwards from both ends.
  const body = segments.slice(1);
  let files: string[] = [];
  if (body.length > 1 && /\.[a-z]{1,5}(\s|$)/i.test(body[body.length - 1])) {
    files = body.pop()!.split(/\s+/).filter(Boolean);
  }
  const claim = body.pop() ?? '';
  const tags = body.length > 0 ? body[0].split('/').filter(Boolean) : [];

  return { id, kind, tags, claim, files };
}

export function readIndex(projectDir: string): IndexLine[] {
  const file = memoryIndexPath(projectDir);
  if (!existsSync(file)) return [];

  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .map(parseIndexLine)
      .filter((line): line is IndexLine => line !== null);
  } catch {
    return [];
  }
}

function writeIndex(projectDir: string, lines: IndexLine[]): void {
  ensureMemoryDirs(projectDir);
  writeFileSync(memoryIndexPath(projectDir), lines.map(formatIndexLine).join('\n') + (lines.length > 0 ? '\n' : ''));
}

// ── Entry files ──────────────────────────────────────────────────────

function truncateClaim(claim: string): string {
  const normalized = claim.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_CLAIM_LENGTH) return normalized;
  return normalized.slice(0, MAX_CLAIM_LENGTH - 1) + '…';
}

/**
 * Claims are compared normalised so the same fact is not recorded twice.
 *
 * Punctuation collapses to a space rather than vanishing, so "JWT-based" and
 * "JWT based" are recognised as the same claim — members phrase things
 * differently and would otherwise each add their own copy.
 */
function dedupeKey(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) return { meta: {}, body: text };

  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    meta[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }

  return { meta, body: match[2] };
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Highest id currently in use. Read from the archive too, so ids stay unique
 * after rotation rather than being reused by a later entry.
 */
function highestId(projectDir: string, index: IndexLine[]): number {
  let max = 0;

  const consider = (id: string) => {
    const n = Number(/^m(\d+)$/.exec(id)?.[1] ?? 0);
    if (n > max) max = n;
  };

  for (const line of index) consider(line.id);

  const archive = memoryArchivePath(projectDir);
  if (existsSync(archive)) {
    try {
      for (const line of readFileSync(archive, 'utf8').split('\n')) {
        const parsed = parseIndexLine(line);
        if (parsed) consider(parsed.id);
      }
    } catch {}
  }

  return max;
}

// ── Ingest ───────────────────────────────────────────────────────────

export interface IngestResult {
  added: MemoryEntry[];
  duplicates: number;
  archived: number;
}

/**
 * Fold everything members dropped in the inbox into the index, then clear it.
 *
 * Called by the orchestrator between turns, when no member is writing, so the
 * index has exactly one writer.
 */
export function ingestInbox(projectDir: string): IngestResult {
  ensureMemoryDirs(projectDir);

  const inbox = memoryInboxDir(projectDir);
  const index = readIndex(projectDir);
  const seen = new Set(index.map((line) => dedupeKey(line.claim)));

  const added: MemoryEntry[] = [];
  let duplicates = 0;
  let idCounter = highestId(projectDir, index);

  let files: string[] = [];
  try {
    files = readdirSync(inbox).filter((name) => name.endsWith('.md')).sort();
  } catch {
    return { added, duplicates, archived: 0 };
  }

  for (const name of files) {
    const path = join(inbox, name);

    let raw = '';
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }

    const { meta, body } = parseFrontmatter(raw);
    const claim = truncateClaim(meta.claim || body.split('\n').find((l) => l.trim())?.trim() || '');

    // An entry with nothing to say is dropped rather than indexed as an empty
    // line that costs tokens forever.
    if (!claim) {
      try { unlinkSync(path); } catch {}
      continue;
    }

    const key = dedupeKey(claim);
    if (seen.has(key)) {
      duplicates++;
      try { unlinkSync(path); } catch {}
      continue;
    }
    seen.add(key);

    const entry: MemoryEntry = {
      id: `m${++idCounter}`,
      kind: (MEMORY_KINDS as readonly string[]).includes(meta.kind) ? (meta.kind as MemoryKind) : 'fact',
      claim,
      tags: splitList(meta.tags).slice(0, 3),
      files: splitList(meta.files).slice(0, 3),
      author: meta.author || name.split('-')[0] || 'unknown',
      detail: body.trim(),
    };

    index.push({ id: entry.id, kind: entry.kind, tags: entry.tags, claim: entry.claim, files: entry.files });
    added.push(entry);

    writeFileSync(
      join(memoryEntriesDir(projectDir), `${entry.id}.md`),
      [
        '---',
        `id: ${entry.id}`,
        `kind: ${entry.kind}`,
        `author: ${entry.author}`,
        `tags: ${entry.tags.join(', ')}`,
        `files: ${entry.files.join(', ')}`,
        `recorded: ${new Date().toISOString()}`,
        '---',
        '',
        entry.claim,
        '',
        entry.detail,
        '',
      ].join('\n')
    );

    try { unlinkSync(path); } catch {}
  }

  // Rotate the oldest lines out so the injected block stays a fixed cost.
  let archived = 0;
  if (index.length > MAX_INDEX_LINES) {
    const overflow = index.splice(0, index.length - MAX_INDEX_LINES);
    archived = overflow.length;
    const existing = existsSync(memoryArchivePath(projectDir)) ? readFileSync(memoryArchivePath(projectDir), 'utf8') : '';
    writeFileSync(memoryArchivePath(projectDir), existing + overflow.map(formatIndexLine).join('\n') + '\n');
  }

  writeIndex(projectDir, index);

  return { added, duplicates, archived };
}

// ── Prompt injection ─────────────────────────────────────────────────

/**
 * How much a kind of fact is worth to the member doing a particular job.
 *
 * A coder needs interfaces and gotchas; whether the team debated Postgres
 * versus SQLite is settled and costs it tokens to be told. A reviewer needs the
 * opposite: the decisions are the thing under review. Ranking by recency alone
 * — which is what `slice(-limit)` did — gets this right only by accident.
 */
const KIND_WEIGHT_BY_SLOT: Record<string, Partial<Record<MemoryKind, number>>> = {
  planner: { decision: 3, fact: 3, interface: 2, flow: 2, gotcha: 2 },
  reviewer: { decision: 3, interface: 2, gotcha: 2, fact: 1, flow: 1 },
  coder: { interface: 3, gotcha: 3, flow: 2, decision: 2, fact: 1 },
  tester: { gotcha: 3, interface: 2, flow: 2, decision: 1, fact: 1 },
  auditor: { gotcha: 3, interface: 2, decision: 2, flow: 1, fact: 1 },
  supervisor: { decision: 3, fact: 2, flow: 2, gotcha: 1, interface: 1 },
};

const DEFAULT_KIND_WEIGHT = 1;

export interface MemoryBlockOptions {
  /** The slot the prompt is going to, used to weight kinds. */
  slot?: string;
  /** The phase in progress, matched against entry tags. */
  phase?: string;
  /** Files this turn is about. Overlap here is the strongest signal there is. */
  focusFiles?: string[];
  /** How many lines to inject. Defaults to MEMORY_BLOCK_LIMIT. */
  limit?: number;
  /** Entry ids already present in this session's transcript. */
  exclude?: string[];
}

export interface MemorySelection {
  /** The rendered block, or '' when there is nothing worth injecting. */
  block: string;
  /** The ids that went in, so a caller can avoid re-sending them next turn. */
  ids: string[];
}

function baseName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/**
 * How useful this line is to the turn about to run.
 *
 * File overlap dominates on purpose: "someone already worked out something
 * about the file you are editing" is worth more than any amount of topical
 * similarity. Recency is a tiebreak with a deliberately tiny weight — it is
 * what to fall back on when nothing else distinguishes two facts, not a
 * ranking in its own right.
 */
function scoreLine(
  line: IndexLine,
  position: number,
  total: number,
  options: MemoryBlockOptions
): number {
  let score = 0;

  const weights = options.slot ? KIND_WEIGHT_BY_SLOT[options.slot] : undefined;
  score += weights?.[line.kind] ?? DEFAULT_KIND_WEIGHT;

  const focus = options.focusFiles ?? [];
  if (focus.length > 0 && line.files.length > 0) {
    const focusNames = new Set(focus.map(baseName));
    const overlap = line.files.filter((file) => focusNames.has(baseName(file))).length;
    score += Math.min(overlap, 3) * 5;
  }

  if (options.phase && line.tags.length > 0) {
    const phaseTerms = options.phase.toLowerCase().split('-').filter(Boolean);
    const tags = line.tags.map((tag) => tag.toLowerCase());
    for (const term of phaseTerms) {
      if (tags.some((tag) => tag.includes(term) || term.includes(tag))) score += 1;
    }
  }

  score += total > 1 ? (position / (total - 1)) * 0.5 : 0;

  return score;
}

/**
 * Choose which index lines are worth this turn's tokens, and render them.
 *
 * Returns the ids alongside the text so the orchestrator can track what a
 * session has already been told and send only what is new next time.
 */
export function buildMemorySelection(
  projectDir: string,
  options: MemoryBlockOptions = {}
): MemorySelection {
  const all = readIndex(projectDir);
  if (all.length === 0) return { block: '', ids: [] };

  const excluded = new Set(options.exclude ?? []);
  const candidates = all.filter((line) => !excluded.has(line.id));
  if (candidates.length === 0) return { block: '', ids: [] };

  const limit = options.limit ?? MEMORY_BLOCK_LIMIT;

  const ranked = candidates
    .map((line, position) => ({ line, score: scoreLine(line, position, candidates.length, options) }))
    .sort((a, b) => b.score - a.score);

  const chosen: typeof ranked = [];
  let chars = 0;
  for (const candidate of ranked) {
    if (chosen.length >= limit) break;
    const cost = formatIndexLine(candidate.line).length + 1;
    if (chars + cost > MAX_MEMORY_BLOCK_CHARS) break;
    chosen.push(candidate);
    chars += cost;
  }

  if (chosen.length === 0) return { block: '', ids: [] };

  // Ranked to decide what goes in, chronological to present it: a list that
  // jumps around in time reads as noise even when every line earns its place.
  const order = new Map(candidates.map((line, index) => [line.id, index]));
  const shown = chosen
    .map((candidate) => candidate.line)
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  const entriesPath = join(memoryDir(projectDir), 'entries');
  const isDelta = excluded.size > 0;

  const block = [
    isDelta
      ? `[TEAM MEMORY — NEW] ${shown.length} fact(s) recorded since your last turn.`
      : `[TEAM MEMORY] ${shown.length} fact(s) the team has already established.`,
    `Trust these over guessing. Full detail for any line: read ${entriesPath}/<id>.md`,
    ...shown.map(formatIndexLine),
    '[END TEAM MEMORY]',
  ].join('\n');

  return { block, ids: shown.map((line) => line.id) };
}

/** The memory block on its own, for callers that do not track what was sent. */
export function buildMemoryBlock(projectDir: string, options: MemoryBlockOptions = {}): string {
  return buildMemorySelection(projectDir, options).block;
}

/**
 * Attach the memory block to a prompt.
 *
 * Appended, not prepended. The block changes from turn to turn, so putting it
 * first made every token after it a cache miss; the stable part of a prompt
 * belongs at the front and the volatile part at the back.
 */
export function withMemory(projectDir: string, prompt: string, options: MemoryBlockOptions = {}): string {
  const block = buildMemoryBlock(projectDir, options);
  return block ? `${prompt}\n\n${block}` : prompt;
}

// ── Writing (used by the orchestrator itself) ────────────────────────

/**
 * Drop an entry into the inbox. Members do this with the `squad-memory` skill;
 * the orchestrator uses it to record things it knows directly.
 */
export function recordToInbox(
  projectDir: string,
  entry: { claim: string; kind?: MemoryKind; tags?: string[]; files?: string[]; author: string; detail?: string }
): void {
  ensureMemoryDirs(projectDir);

  const safeAuthor = entry.author.replace(/[^a-z0-9-]/gi, '') || 'system';
  const path = join(memoryInboxDir(projectDir), `${safeAuthor}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);

  writeFileSync(
    path,
    [
      '---',
      `kind: ${entry.kind || 'fact'}`,
      `claim: ${entry.claim.replace(/\n/g, ' ')}`,
      `tags: ${(entry.tags || []).join(', ')}`,
      `files: ${(entry.files || []).join(', ')}`,
      `author: ${safeAuthor}`,
      '---',
      '',
      entry.detail || entry.claim,
      '',
    ].join('\n')
  );
}
