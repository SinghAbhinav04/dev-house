import { NextRequest, NextResponse } from 'next/server';
import { resumePipelineRun } from '@/lib/pipeline-control';
import { projectDirFromRequest } from '@/lib/project-dir';

export async function POST(req: NextRequest) {
  let requested: unknown;
  try {
    const body = await req.json();
    requested = body?.projectDir;
  } catch {}

  // Resuming spawns an orchestrator in the directory, so it has to be a
  // project and not merely a path the request happened to carry.
  const choice = projectDirFromRequest(requested);
  if (!choice.ok) {
    return NextResponse.json({ success: false, error: choice.error }, { status: 400 });
  }

  const result = resumePipelineRun(choice.projectDir);
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error || 'Could not resume pipeline' });
  }
  return NextResponse.json(result);
}
