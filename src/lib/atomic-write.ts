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
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, file);
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
