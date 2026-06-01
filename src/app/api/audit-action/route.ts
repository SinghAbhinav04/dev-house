import { NextRequest, NextResponse } from 'next/server';
import { startAuditAction, type AuditAction } from '@/lib/pipeline-control';

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
    if (typeof body?.projectDir === 'string' && body.projectDir.length > 0) {
      projectDir = body.projectDir;
    }
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
