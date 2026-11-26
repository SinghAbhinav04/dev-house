import { renameSync, unlinkSync, writeFileSync } from 'fs';

/**
 * Write JSON so a concurrent reader never sees a half-written file.
 *
 * The pipeline state file is rewritten whole on every event — every tool call,
 * every status line — while the SSE stream, the chat route and the CLI all read
 * it. A plain `writeFileSync` truncates and refills in place, so a reader that
 * arrives mid-write gets a syntax error. That used to surface as a blank
 * viewer: the read failed, an empty state went out over the stream, and the
 * whole UI cleared for a frame at random.
 *
 * Writing to a sibling temp file and renaming makes the swap atomic on POSIX
 * filesystems: a reader sees either the old file or the new one. It also means
 * mtime moves exactly once, on the rename, rather than at truncate and again at
 * the end — which is what the stream watches to decide something changed.
 *
 * This does not make concurrent *writers* safe. Two processes doing
 * read-modify-write still lose one of the two updates; only one of them wins
 * cleanly instead of producing a corrupt file. Fixing that needs an
 * append-only event log, not a better write call.
 */
export function writeJsonAtomic(file: string, data: unknown): void {
  // Per process, so two writers never share (and clobber) one temp file.
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameWithRetry(tmp, file);
  } catch (err) {
    // Never leave the temp file behind — the directory is user-visible, and a
    // stray `pipeline-events.json.tmp` reads like a crash even when the write
    // failed for a mundane reason.
    try {
      unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * On Windows, replacing a file fails with EPERM or EBUSY while any other
 * process has it open, and the SSE stream reads the state file four times a
 * second, so a plain rename lost writes there at random. The reader holds it
 * for microseconds, so a short bounded retry is enough. POSIX never hits this.
 */
function renameWithRetry(from: string, to: string): void {
  const deadline = Date.now() + 500;
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !RETRYABLE.has(code) || Date.now() > deadline) throw err;
      // Synchronous wait: callers are synchronous by design.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(5 * (attempt + 1), 25));
    }
  }
}
