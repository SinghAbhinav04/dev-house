import { NextRequest, NextResponse } from 'next/server';
import { findLatestPendingApproval, updatePendingApproval } from '@/lib/pipeline-approval';
import { projectDirFromRequest } from '@/lib/project-dir';

export async function POST(req: NextRequest) {
  const { approved, requestId, projectDir } = await req.json();

  // A named project has to be one. It used to be taken as given, so a request
  // could answer an approval file anywhere on disk.
  const choice = projectDirFromRequest(projectDir);
  if (!choice.ok) {
    return NextResponse.json({ success: false, error: choice.error }, { status: 400 });
  }

  const latest = findLatestPendingApproval();
  const targetProjectDir = choice.projectDir || latest?.projectDir;

  if (!targetProjectDir) {
    return NextResponse.json({ success: false });
  }

  const success = updatePendingApproval(targetProjectDir, !!approved, requestId);
  return NextResponse.json({ success });
}
