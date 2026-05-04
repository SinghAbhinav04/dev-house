import { NextRequest, NextResponse } from 'next/server';
import { findLatestPendingApproval, updatePendingApproval } from '@/lib/pipeline-approval';

export async function POST(req: NextRequest) {
  const { approved, requestId, projectDir } = await req.json();
  const latest = findLatestPendingApproval();
  const targetProjectDir = projectDir || latest?.projectDir;

  if (!targetProjectDir) {
    return NextResponse.json({ success: false });
  }

  const success = updatePendingApproval(targetProjectDir, !!approved, requestId);
  return NextResponse.json({ success });
}
