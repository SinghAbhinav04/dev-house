/**
 * Which agent CLIs this build knows how to run.
 *
 * Registering an adapter is the last step of adding a CLI, not the first: an
 * id that resolves here is one the UI will offer and the runner will spawn, so
 * a half-finished adapter must not appear until its gate can be installed and
 * self-tested.
 */

import { claudeCli } from './claude.ts';
import { DEFAULT_CLI, isCliId, type AgentCli, type CliId } from './types.ts';

const ADAPTERS: Partial<Record<CliId, AgentCli>> = {
  claude: claudeCli,
};

/** The CLIs a member can actually be assigned to right now. */
export function availableClis(): AgentCli[] {
  return Object.values(ADAPTERS).filter((cli): cli is AgentCli => Boolean(cli));
}

export function findCli(id: unknown): AgentCli | null {
  return (isCliId(id) && ADAPTERS[id]) || null;
}

/**
 * The adapter for a member, falling back to Claude Code.
 *
 * The fallback covers rosters written before members had a CLI at all, which
 * is every roster that exists today. It deliberately does *not* cover an id
 * that is known but unregistered — see `requireCli`.
 */
export function resolveCli(id: unknown): AgentCli {
  return findCli(id) ?? findCli(DEFAULT_CLI)!;
}

/**
 * The adapter for a member, or an error naming what is missing.
 *
 * Used where silently falling back would run a member on an engine its owner
 * did not choose — with a different model vocabulary, different tool names and
 * a gate written for something else.
 */
export function requireCli(id: unknown): AgentCli {
  const cli = findCli(id);
  if (cli) return cli;

  const known = availableClis().map((entry) => entry.id).join(', ');
  throw new Error(
    `No adapter for CLI '${String(id)}'. This build can run: ${known}.`
  );
}
