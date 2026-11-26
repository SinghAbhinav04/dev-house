/**
 * One git branch per ticket, like a pull request per work item.
 *
 *   start   trunk → `dh-3-board-columns`, remembering the commit it left from
 *   finish  commit the work (authored by the teammate), merge back --no-ff
 *   diff    base..head, per file, for the review page
 *   review  a separate worktree on the branch, for opening in an editor
 *           without touching the folder the team is working in
 *
 * Every git call goes through spawnSync with an argument array — no shell —
 * so it behaves the same on Windows, macOS and Linux. Failures are reported,
 * never thrown: a run must not stop because git is missing or unhappy.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { TicketBranch } from './tickets.ts';

export interface GitAuthor {
  name: string;
  email: string;
}

/** Run-state files that are not the product: kept out of every commit and diff. */
export const RUN_FILES = ['pipeline-events.json', 'pipeline-events.json.tmp*', '.claude/', '.squad/', '*.log', 'node_modules/'];

export function git(dir: string, args: string[], author?: GitAuthor): { ok: boolean; out: string; err: string } {
  const identity = author ? ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`] : [];
  const res = spawnSync('git', [...identity, ...args], { cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  return { ok: res.status === 0, out: (res.stdout ?? '').trim(), err: (res.stderr ?? '').trim() || (res.error ? String(res.error.message) : '') };
}

export function branchName(ticket: { id: string; title: string }): string {
  const slug = ticket.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `${ticket.id.toLowerCase()}${slug ? `-${slug}` : ''}`;
}

export function memberAuthor(member: { id: string; name: string }): GitAuthor {
  return { name: member.name, email: `${member.id}@hackeroom.local` };
}

const FALLBACK_AUTHOR: GitAuthor = { name: 'Hackeroom', email: 'team@hackeroom.local' };

/** A repo with at least one commit and the run files excluded; returns the trunk branch name. */
export function ensureRepo(dir: string): string | null {
  if (!existsSync(join(dir, '.git')) && !git(dir, ['init']).ok) return null;
  // Branch switches must leave files exactly as the team wrote them; with
  // Git for Windows' autocrlf every checkout would rewrite them as CRLF.
  git(dir, ['config', 'core.autocrlf', 'false']);
  const exclude = join(dir, '.git', 'info', 'exclude');
  try {
    mkdirSync(dirname(exclude), { recursive: true });
    const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    const missing = RUN_FILES.filter((line) => !current.split(/\r?\n/).includes(line));
    if (missing.length) writeFileSync(exclude, `${current.replace(/\s*$/, '\n')}# hackeroom run files\n${missing.join('\n')}\n`);
  } catch {}
  // Files committed before they were excluded stop being tracked.
  // -f: only the index entry goes; the files on disk stay.
  git(dir, ['rm', '-r', '-f', '--cached', '--quiet', '--ignore-unmatch', 'pipeline-events.json', '.claude', '.squad']);
  if (!git(dir, ['rev-parse', '--verify', 'HEAD']).ok) {
    git(dir, ['add', '-A']);
    if (!git(dir, ['commit', '--allow-empty', '-m', 'Initial project setup'], FALLBACK_AUTHOR).ok) return null;
  } else if (git(dir, ['status', '--porcelain']).out) {
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'Project state before the tickets'], FALLBACK_AUTHOR);
  }
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return branch.ok ? branch.out : null;
}

/** Branch off trunk for a ticket. Null if git is unavailable. */
export function startTicketBranch(dir: string, ticket: { id: string; title: string }, trunk: string, author?: GitAuthor): TicketBranch | null {
  // Leftovers from an earlier step land on the current branch first, so the
  // new branch starts clean and its diff is only this ticket's work.
  if (git(dir, ['status', '--porcelain']).out) {
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', `Work in progress before ${ticket.id}`], author ?? FALLBACK_AUTHOR);
  }
  if (!git(dir, ['checkout', '--quiet', trunk]).ok) return null;
  const base = git(dir, ['rev-parse', 'HEAD']);
  if (!base.ok) return null;
  const name = branchName(ticket);
  if (!git(dir, ['checkout', '--quiet', '-B', name]).ok) return null;
  return { name, base: base.out };
}

function stats(dir: string, base: string, head: string): Pick<TicketBranch, 'files' | 'additions' | 'deletions'> {
  const numstat = git(dir, ['diff', '--numstat', '-M', base, head]);
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of numstat.out.split('\n')) {
    if (!line.trim()) continue;
    const [a, d] = line.split('\t');
    files += 1;
    additions += Number(a) || 0;
    deletions += Number(d) || 0;
  }
  return { files, additions, deletions };
}

/** Commit the ticket's work on its branch and merge it into trunk. */
export function finishTicketBranch(
  dir: string,
  ticket: { id: string; title: string },
  branch: TicketBranch,
  trunk: string,
  author?: GitAuthor,
): TicketBranch {
  const who = author ?? FALLBACK_AUTHOR;
  git(dir, ['checkout', '--quiet', branch.name]);
  git(dir, ['add', '-A']);
  if (git(dir, ['status', '--porcelain']).out) git(dir, ['commit', '-m', `${ticket.id}: ${ticket.title}`], who);
  const head = git(dir, ['rev-parse', 'HEAD']).out || branch.base;
  const result: TicketBranch = { ...branch, head, ...stats(dir, branch.base, head) };
  if (!git(dir, ['checkout', '--quiet', trunk]).ok) return result;
  const merge = git(dir, ['merge', '--no-ff', '--quiet', '-m', `Merge ${ticket.id}: ${ticket.title}`, branch.name], who);
  if (!merge.ok) {
    git(dir, ['merge', '--abort']);
    git(dir, ['checkout', '--quiet', branch.name]);
    return result;
  }
  return { ...result, merged: true };
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  /** Unified diff hunks, without the file header. */
  patch: string;
  binary: boolean;
}

const MAX_PATCH_CHARS = 400_000;

/** The ticket's changes, file by file: base..head, or base..working tree while it is still being built. */
export function ticketDiff(dir: string, branch: TicketBranch): { files: FileDiff[]; truncated: boolean } {
  const range = branch.head && branch.head !== branch.base ? [branch.base, branch.head] : [branch.base];
  const res = git(dir, ['diff', '--no-color', '-M', '--no-ext-diff', ...range, '--', '.']);
  if (!res.ok) return { files: [], truncated: false };
  const text = res.out.length > MAX_PATCH_CHARS ? res.out.slice(0, MAX_PATCH_CHARS) : res.out;
  return { files: parseUnifiedDiff(text), truncated: res.out.length > MAX_PATCH_CHARS };
}

export function parseUnifiedDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  const chunks = text.split(/^diff --git /m).filter((c) => c.trim());
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const header = lines[0];
    const m = header.match(/^a\/(.+?) b\/(.+)$/);
    let path = m ? m[2] : header;
    let oldPath: string | undefined;
    let status: FileDiff['status'] = 'modified';
    let binary = false;
    let i = 1;
    for (; i < lines.length && !lines[i].startsWith('@@'); i++) {
      const line = lines[i];
      if (line.startsWith('new file')) status = 'added';
      else if (line.startsWith('deleted file')) status = 'deleted';
      else if (line.startsWith('rename from ')) {
        status = 'renamed';
        oldPath = line.slice('rename from '.length);
      } else if (line.startsWith('rename to ')) path = line.slice('rename to '.length);
      else if (line.startsWith('Binary files')) binary = true;
    }
    const body = lines.slice(i);
    let additions = 0;
    let deletions = 0;
    for (const line of body) {
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) deletions += 1;
    }
    files.push({ path, oldPath, status, additions, deletions, patch: body.join('\n').replace(/\n+$/, ''), binary });
  }
  return files;
}

/**
 * A worktree on the ticket's branch under `root`, for opening in an editor.
 * If the team's folder already has that branch checked out (work in
 * progress), that folder is returned instead.
 */
export function reviewWorktree(dir: string, branch: TicketBranch, root: string): { ok: true; path: string } | { ok: false; error: string } {
  if (git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).out === branch.name) return { ok: true, path: dir };
  const path = join(root, branch.name);
  if (existsSync(join(path, '.git'))) {
    // Already there from an earlier review: bring it up to the branch's tip.
    git(path, ['checkout', '--quiet', branch.name]);
    git(path, ['reset', '--quiet', '--hard', branch.head ?? branch.name]);
    return { ok: true, path };
  }
  mkdirSync(root, { recursive: true });
  git(dir, ['worktree', 'prune']);
  const add = git(dir, ['worktree', 'add', '--quiet', path, branch.name]);
  if (add.ok) return { ok: true, path };
  // Branch busy elsewhere: a detached checkout of the same commit still shows the code.
  const detached = git(dir, ['worktree', 'add', '--quiet', '--detach', path, branch.head ?? branch.name]);
  return detached.ok ? { ok: true, path } : { ok: false, error: add.err || detached.err || 'git worktree failed' };
}
