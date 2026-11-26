import { NextRequest, NextResponse } from 'next/server';

import { findEditor, launchEditor } from '@/lib/editor-launch';
import { reviewWorktree } from '@/lib/ticket-git';
import { loadTicket, reviewRoot } from '@/lib/ticket-review';

/**
 * Open a ticket's branch in the user's editor. The branch is checked out in a
 * separate review worktree, so the team's folder (and a run in progress) is
 * never switched to another branch underneath them.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const found = loadTicket(id);
  if (!found.ok) return NextResponse.json({ ok: false, error: found.error }, { status: found.status });
  const { ticket, projectDir } = found;
  if (!ticket.branch) return NextResponse.json({ ok: false, error: `${ticket.id} has no branch yet` }, { status: 409 });

  const checkout = reviewWorktree(projectDir, ticket.branch, reviewRoot(projectDir));
  if (!checkout.ok) return NextResponse.json({ ok: false, error: checkout.error }, { status: 500 });

  const editor = findEditor(checkout.path);
  if (!editor) {
    return NextResponse.json(
      { ok: false, error: `No editor found (tried Cursor, VS Code, Windsurf, Zed, Sublime). The branch is checked out at ${checkout.path}`, path: checkout.path },
      { status: 404 },
    );
  }
  const launched = await launchEditor(editor);
  if (!launched.ok) return NextResponse.json({ ok: false, error: launched.error, path: checkout.path }, { status: 500 });
  return NextResponse.json({ ok: true, editor: editor.label, path: checkout.path, branch: ticket.branch.name });
}
