import { NextRequest, NextResponse } from 'next/server';

import { readCurrentState } from '@/lib/state-source';

/**
 * Snapshot of the current run.
 *
 * The viewer normally reads /api/stream instead; this remains as the initial
 * load and as the fallback when EventSource is unavailable.
 */
export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode') || 'pipeline';
  return NextResponse.json(readCurrentState(mode));
}
