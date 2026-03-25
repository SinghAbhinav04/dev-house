import { NextResponse } from 'next/server';
import { stopPipelineRun } from '@/lib/pipeline-control';

export async function POST() {
  return NextResponse.json(stopPipelineRun());
}
