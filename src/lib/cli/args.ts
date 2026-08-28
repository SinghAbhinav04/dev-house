/**
 * Small pieces every adapter's command-line builder needs.
 *
 * Here rather than in the runner so an adapter and the runner do not have to
 * import each other, and here rather than duplicated so two adapters cannot
 * disagree about what "unset" means.
 */

import type { Effort } from '../team/types.ts';

export function hasValue(value: string | undefined | null): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The permission mode for one spawn.
 *
 * Resolved per spawn rather than per process: members carry their own mode, so
 * one can run in plan mode while another accepts edits. The environment
 * variable is the run-level fallback the viewer sets.
 */
export function resolvePermissionMode(request: { permissionMode?: string }): string {
  return request.permissionMode || process.env.PIPELINE_PERMISSION_MODE || 'auto';
}

/**
 * Bring a member's effort down to something this model actually offers.
 *
 * Returns what to use and, when it differs, what was asked for — callers are
 * expected to say so in the log rather than quietly running at a level nobody
 * chose. Clamping *down* is safe in a way that clamping a permission mode
 * would not be, which is why those are a validation error instead.
 */
export function clampEffort(
  requested: string | undefined,
  supported: readonly Effort[] | undefined
): { effort: string | undefined; clampedFrom?: string } {
  if (!requested || !supported || supported.length === 0) return { effort: requested };
  if ((supported as readonly string[]).includes(requested)) return { effort: requested };

  // Order is low → high, so the last supported level is the closest thing to
  // "as much as this model can do" for anything above its range.
  const ladder: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];
  const wanted = ladder.indexOf(requested);
  const below = supported.filter((level) => ladder.indexOf(level) <= wanted);
  const chosen = below.length > 0 ? below[below.length - 1] : supported[0];

  return { effort: chosen, clampedFrom: requested };
}
