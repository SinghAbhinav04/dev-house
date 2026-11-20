import { NextRequest, NextResponse } from 'next/server';
import { startAuditAction, type AuditAction } from '@/lib/pipeline-control';
import { projectDirFromRequest } from '@/lib/project-dir';

const VALID_ACTIONS: AuditAction[] = ['send-to-c', 'dismiss', 'deploy'];

export async function POST(req: NextRequest) {
  let action: AuditAction | null = null;
  let findingId: string | undefined;
  let projectDir: string | undefined;

  try {
    const body = await req.json();
    if (VALID_ACTIONS.includes(body?.action)) {
      action = body.action as AuditAction;
    }
    if (typeof body?.findingId === 'string' && body.findingId.length > 0) {
      findingId = body.findingId;
    }
    // An audit action spawns an orchestrator in the directory, so a named
    // project has to be one.
    const choice = projectDirFromRequest(body?.projectDir);
    if (!choice.ok) {
      return NextResponse.json({ success: false, error: choice.error }, { status: 400 });
    }
    projectDir = choice.projectDir;
  } catch {}

  if (!action) {
    return NextResponse.json(
      { success: false, error: `Invalid action. Expected one of: ${VALID_ACTIONS.join(', ')}` },
      { status: 400 }
    );
  }

  const result = startAuditAction(action, findingId, projectDir);
  if (!result.success) {
    return NextResponse.json(
      { success: false, error: result.error || 'Could not start audit action' },
      { status: result.status ?? 500 }
    );
  }
  return NextResponse.json({ success: true, projectDir: result.projectDir, action, findingId });
}
