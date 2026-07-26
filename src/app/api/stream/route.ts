import { NextRequest } from 'next/server';

import { findLatestPendingApproval } from '@/lib/pipeline-approval';
import { readCurrentState, stateFileMtime } from '@/lib/state-source';

/**
 * Server-sent stream of run state.
 *
 * This replaces three separate polls the viewer used to run at once — the
 * 400 ms whole-state poll, the 500 ms pending-approval poll, and a 1 s clock —
 * which together meant roughly five requests a second, each re-parsing the
 * entire state file whether or not anything had changed.
 *
 * The server still watches the file (the orchestrator is a detached process
 * writing JSON, so there is nothing to subscribe to), but it does so once and
 * only sends a frame when the file's mtime actually moves.
 */

export const dynamic = 'force-dynamic';

/** How often the server checks the file. Cheap: a stat, not a parse. */
const WATCH_INTERVAL_MS = 250;

/** Keepalive cadence, to stop intermediaries closing an idle stream. */
const HEARTBEAT_MS = 15_000;

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get('mode') || 'pipeline';
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let lastMtime = -1;
      let lastPendingId: string | null = null;
      let lastBeat = Date.now();

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };

      const pushStateIfChanged = (force = false) => {
        const mtime = stateFileMtime(mode);
        if (!force && mtime === lastMtime) return false;
        lastMtime = mtime;
        send('state', readCurrentState(mode));
        return true;
      };

      const pushPendingIfChanged = (force = false) => {
        // Approvals live in their own file and can appear without the state
        // file changing, so they are watched separately.
        const found = mode === 'manual' ? null : findLatestPendingApproval();
        const id = found?.pending.requestId ?? null;
        if (!force && id === lastPendingId) return false;
        lastPendingId = id;
        send('pending', found?.pending ?? null);
        return true;
      };

      // Initial frames so a fresh connection is immediately correct.
      pushStateIfChanged(true);
      pushPendingIfChanged(true);

      const timer = setInterval(() => {
        if (closed) return;

        let sent = false;
        try {
          sent = pushStateIfChanged() || sent;
          sent = pushPendingIfChanged() || sent;
        } catch {
          // A read that fails mid-write is not worth tearing the stream down
          // for; the next tick will pick it up.
        }

        if (!sent && Date.now() - lastBeat > HEARTBEAT_MS) {
          lastBeat = Date.now();
          send('ping', Date.now());
        } else if (sent) {
          lastBeat = Date.now();
        }
      }, WATCH_INTERVAL_MS);

      function cleanup() {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        try {
          controller.close();
        } catch {}
      }

      req.signal.addEventListener('abort', cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Proxies that buffer would defeat the point of streaming.
      'X-Accel-Buffering': 'no',
    },
  });
}
