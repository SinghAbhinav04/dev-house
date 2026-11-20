import { NextResponse, type NextRequest } from 'next/server';

import { checkRequest } from '@/lib/request-guard';

/**
 * The one place every request passes before it reaches a page or a route.
 *
 * Here rather than in each route so that a route added later is covered
 * without anyone remembering to cover it. The rules, and why each exists, are
 * in src/lib/request-guard.ts.
 */
export function proxy(request: NextRequest) {
  const verdict = checkRequest(request);
  if (verdict.ok) return NextResponse.next();

  return NextResponse.json({ success: false, error: verdict.error }, { status: verdict.status });
}

export const config = {
  // Everything except Next's own assets. Pages are included as well as /api:
  // they are rendered from the same roster and run state the API serves, so a
  // request addressed to some other host has no more business reading one
  // than the other.
  matcher: ['/((?!_next/).*)'],
};
