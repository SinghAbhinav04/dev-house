import { NextRequest, NextResponse } from 'next/server';
import { resumePipelineRun } from '@/lib/pipeline-control';

export async function POST(req: NextRequest) {
  let requestedProjectDir = '';
  try {
    const body = await req.json();
    requestedProjectDir = typeof body?.projectDir === 'string' ? body.projectDir : '';
  } catch {}

  const result = resumePipelineRun(requestedProjectDir || undefined);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error || 'Could not resume pipeline' });
  }
  return NextResponse.json(result);
}
