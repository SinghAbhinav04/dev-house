import { NextResponse } from 'next/server';
import { findLatestPendingApproval } from '@/lib/pipeline-approval';

export async function GET() {
  const latest = findLatestPendingApproval();
  return NextResponse.json(latest?.pending ?? null);
}
