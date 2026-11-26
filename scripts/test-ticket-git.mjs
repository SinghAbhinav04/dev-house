import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  branchName,
  ensureRepo,
  finishTicketBranch,
  git,
  memberAuthor,
  parseUnifiedDiff,
  reviewWorktree,
  startTicketBranch,
  ticketDiff,
} from '../src/lib/ticket-git.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

if (!git(process.cwd(), ['--version']).ok) {
  console.log('  - git not installed; ticket-git tests skipped');
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), 'ticket-git-'));
const repo = join(root, 'proj');
const coder = memberAuthor({ id: 'coder-1', name: 'Ada' });

try {
  test('branch names are the key plus a slug', () => {
    assert.equal(branchName({ id: 'DH-3', title: 'Board columns & cards!' }), 'dh-3-board-columns-cards');
    assert.equal(branchName({ id: 'DH-12', title: '' }), 'dh-12');
  });

  let trunk;
  test('a fresh folder becomes a repo, run files excluded', () => {
    git(root, ['init', '--quiet', repo]);
    writeFileSync(join(repo, 'plan.md'), '# Plan\n');
    writeFileSync(join(repo, 'pipeline-events.json'), '{}');
    trunk = ensureRepo(repo);
    assert.ok(trunk, 'has a trunk branch');
    assert.match(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8'), /pipeline-events\.json/);
    assert.equal(git(repo, ['ls-files', 'pipeline-events.json']).out, '', 'run state is not tracked');
  });

  let first;
  test('a ticket gets a branch, a commit by its teammate, and is merged', () => {
    const ticket = { id: 'DH-2', title: 'Board columns' };
    const branch = startTicketBranch(repo, ticket, trunk, coder);
    assert.equal(branch.name, 'dh-2-board-columns');
    writeFileSync(join(repo, 'index.html'), '<div class="board"></div>\n');
    writeFileSync(join(repo, 'pipeline-events.json'), '{"changed":true}');
    first = finishTicketBranch(repo, ticket, branch, trunk, coder);
    assert.equal(first.merged, true);
    assert.equal(first.files, 1, 'only the product file, not run state');
    assert.equal(first.additions, 1);
    assert.equal(git(repo, ['log', '-1', '--format=%an', first.head]).out, 'Ada');
    assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).out, trunk, 'back on trunk');
  });

  test('the next ticket starts from the merged trunk and diffs only its own work', () => {
    const ticket = { id: 'DH-3', title: 'Drag and drop' };
    const branch = startTicketBranch(repo, ticket, trunk, coder);
    writeFileSync(join(repo, 'index.html'), '<div class="board" draggable="true"></div>\n');
    writeFileSync(join(repo, 'board.js'), 'export const drag = true;\n');
    const done = finishTicketBranch(repo, ticket, branch, trunk, coder);
    const diff = ticketDiff(repo, done);
    assert.deepEqual(diff.files.map((f) => `${f.status}:${f.path}`).sort(), ['added:board.js', 'modified:index.html']);
    const html = diff.files.find((f) => f.path === 'index.html');
    assert.equal(html.additions, 1);
    assert.equal(html.deletions, 1);
  });

  test('work in progress diffs against the working tree', () => {
    const ticket = { id: 'DH-4', title: 'Counts' };
    const branch = startTicketBranch(repo, ticket, trunk, coder);
    writeFileSync(join(repo, 'count.js'), 'export const n = 0;\n');
    git(repo, ['add', '-A']);
    const diff = ticketDiff(repo, branch);
    assert.deepEqual(diff.files.map((f) => f.path), ['count.js']);
    finishTicketBranch(repo, ticket, branch, trunk, coder);
  });

  test('a review worktree opens the branch without touching the team folder', () => {
    const review = reviewWorktree(repo, first, join(root, 'review'));
    assert.ok(review.ok, review.error);
    assert.ok(existsSync(join(review.path, 'index.html')));
    // Compared without line endings: core.autocrlf may turn \n into \r\n on checkout.
    assert.equal(readFileSync(join(review.path, 'index.html'), 'utf8').replace(/\r\n/g, '\n'), '<div class="board"></div>\n', 'shows DH-2 as it was');
    assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).out, trunk);
    const again = reviewWorktree(repo, first, join(root, 'review'));
    assert.ok(again.ok);
    assert.equal(again.path, review.path);
  });

  test('unified diffs parse into files with renames and binaries', () => {
    const files = parseUnifiedDiff(
      [
        'diff --git a/old.txt b/new.txt',
        'similarity index 90%',
        'rename from old.txt',
        'rename to new.txt',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        'diff --git a/img.png b/img.png',
        'Binary files a/img.png and b/img.png differ',
      ].join('\n'),
    );
    assert.equal(files[0].status, 'renamed');
    assert.equal(files[0].oldPath, 'old.txt');
    assert.equal(files[0].path, 'new.txt');
    assert.equal(files[1].binary, true);
  });
} finally {
  // Worktrees hold the folder on Windows until git forgets them.
  git(repo, ['worktree', 'prune']);
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

console.log(`\n${passed} ticket git tests passed`);
