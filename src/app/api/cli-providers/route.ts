import { NextRequest, NextResponse } from 'next/server';

import {
  connectProvider,
  disconnectProvider,
  opencodeProviders,
} from '@/lib/cli/opencode-providers';

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
  // with. Hackeroom binds to localhost, but a page on another origin can still
  // reach localhost from your browser.
  const origin = request.headers.get('origin');
  if (origin) {
    try {
      const host = new URL(origin).hostname;
      if (host !== 'localhost' && host !== '127.0.0.1') {
        return NextResponse.json({ error: 'Cross-origin requests are not accepted here.' }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: 'Bad origin.' }, { status: 403 });
    }
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
