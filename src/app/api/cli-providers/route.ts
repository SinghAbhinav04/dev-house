import { NextRequest, NextResponse } from 'next/server';

import {
  connectProvider,
  disconnectProvider,
  opencodeProviders,
} from '@/lib/cli/opencode-providers';
import { checkRequest } from '@/lib/request-guard';

/**
 * Providers a member can be pointed at, and connecting one.
 *
 * Separate from /api/team because it is slow — listing models shells out to the
 * CLI — and because it handles a credential, which is worth keeping on its own
 * route rather than buried in a roster update.
 *
 * The key is written straight into OpenCode's own auth file and is never
 * returned, echoed, or logged. A GET says which providers are connected and
 * never what with.
 */

export async function GET() {
  try {
    return NextResponse.json({ providers: opencodeProviders() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  // This route accepts a credential, so it only answers to the page it ships
  // with. Every request already passes this check in src/proxy.ts; it is
  // repeated here, with the same function, because this is the one route
  // where a proxy that was ever misconfigured or bypassed would cost a key.
  //
  // The check that used to live here accepted any localhost origin, so a page
  // served by some other local app on another port could post to it.
  const verdict = checkRequest(request);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const provider = typeof body.provider === 'string' ? body.provider : '';
  if (!provider) return NextResponse.json({ error: 'Which provider?' }, { status: 400 });

  try {
    if (body.action === 'disconnect') {
      disconnectProvider(provider);
    } else {
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
      if (!apiKey.trim()) return NextResponse.json({ error: 'No API key was provided.' }, { status: 400 });
      connectProvider(provider, apiKey);
    }
  } catch (err) {
    // Deliberately the message only. Nothing from the request body is echoed,
    // so a key cannot end up in an error page or a log line.
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  return NextResponse.json({ providers: opencodeProviders() });
}
