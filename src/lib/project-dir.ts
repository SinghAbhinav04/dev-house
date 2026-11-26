/**
 * Turning a `projectDir` a request sent into one this server will act on.
 *
 * Three routes accept one - /api/approve, /api/resume-pipeline and
 * /api/audit-action - and used it as given: they read and rewrote
 * `pipeline-events.json` and `pipeline-pending.json` in it and started an
 * orchestrator there. A project is only ever a directory directly inside
 * ~/Builds, so that is all a request may name.
 */

import { realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { buildsDir as platformBuildsDir } from './platform.ts';

/** Read at call time, not at import, so a test can point HOME somewhere else. */
export function buildsDir(): string {
  return platformBuildsDir();
}

/**
 * The real path of a project directory, or null if it is not one.
 *
 * Resolved through symlinks before it is judged: a link inside ~/Builds that
 * points elsewhere is elsewhere. Staging and manual mode are not projects and
 * have no run to resume or approve.
 */
export function resolveProjectDir(candidate: unknown): string | null {
  if (typeof candidate !== 'string' || candidate.length === 0) return null;

  let builds: string;
  let real: string;
  try {
    builds = realpathSync(buildsDir());
    real = realpathSync(candidate);
    if (!statSync(real).isDirectory()) return null;
  } catch {
    // Does not exist, or cannot be read: either way, not a project.
    return null;
  }

  if (dirname(real) !== builds) return null;

  const name = real.slice(builds.length + 1);
  if (name.startsWith('.')) return null;

  return real;
}

export type ProjectDirChoice =
  /** The request named no project; the caller falls back to the latest one. */
  | { ok: true; projectDir: undefined }
  | { ok: true; projectDir: string }
  | { ok: false; error: string };

/**
 * What a route should do with the `projectDir` field of a request body.
 *
 * Absent is fine and means "the current project". Present but not a project
 * is an error, not a fallback: a request that named somewhere it should not
 * have must not be answered as though it had named nothing.
 */
export function projectDirFromRequest(value: unknown): ProjectDirChoice {
  if (value === undefined || value === null || value === '') return { ok: true, projectDir: undefined };

  const resolved = resolveProjectDir(value);
  if (!resolved) return { ok: false, error: 'projectDir must be a project directly inside ~/Builds.' };

  return { ok: true, projectDir: resolved };
}
