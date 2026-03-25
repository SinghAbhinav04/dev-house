import { NextRequest, NextResponse } from 'next/server';
import { startPipelineRun } from '@/lib/pipeline-control';

export async function POST(req: NextRequest) {
  let securityMode = 'fast';
  let permissionMode = 'auto';
  let runGoal = 'full-build';
  let runFinalAudit = false;
  try {
    const body = await req.json();
    if (body?.securityMode === 'strict') securityMode = 'strict';
    if (body?.permissionMode === 'plan') permissionMode = 'plan';
    else if (body?.permissionMode === 'dangerously-skip-permissions') permissionMode = 'dangerously-skip-permissions';
    if (body?.runGoal === 'plan-only') runGoal = 'plan-only';
    if (body?.runFinalAudit === true) runFinalAudit = true;
  } catch {}

  const result = startPipelineRun({
    securityMode: securityMode === 'strict' ? 'strict' : 'fast',
    permissionMode: permissionMode as 'auto' | 'plan' | 'dangerously-skip-permissions',
    runGoal: runGoal === 'plan-only' ? 'plan-only' : 'full-build',
    runFinalAudit,
  });

  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error || 'Could not start pipeline' });
  }

  return NextResponse.json(result);
}
