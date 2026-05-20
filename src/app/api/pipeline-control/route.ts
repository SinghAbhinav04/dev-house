import { NextRequest, NextResponse } from 'next/server';
import { setStopAfterReview } from '@/lib/pipeline-control';

export async function POST(req: NextRequest) {
  let action = '';
  try {
    const body = await req.json();
    action = typeof body?.action === 'string' ? body.action : '';
  } catch {}

  if (action !== 'stop-after-review' && action !== 'clear-stop-after-review') {
    return NextResponse.json({ success: false, error: 'Unsupported pipeline control action' });
  }

  const result = setStopAfterReview(action === 'stop-after-review');
  if (!result.success) {
    return NextResponse.json({ success: false, error: result.error || 'Could not update pipeline control' });
  }
  return NextResponse.json(result);
}
