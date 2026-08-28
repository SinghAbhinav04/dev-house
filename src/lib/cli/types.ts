/**
 * The agent CLI a member runs on.
 *
 * A member is already yours — your role prompt, your skills, your model, your
 * permissions. The engine was the one thing that was not: every member was a
 * `claude` process. This is the seam that makes it another choice.
 *
 * It sits *beside* `Runner`, not under it. `Runner` answers where a turn runs
 * (this machine, or a container); `AgentCli` answers what binary runs it and
 * how to read what comes back. The two are orthogonal, so composing them costs
 * one adapter per CLI plus one runner per location, where nesting them would
 * cost the product of the two and duplicate the container mounting logic in
 * every adapter.
 */

import type { AgentDecoder, CanonicalTool } from './decoder.ts';
import type { Effort, MemberPermissionMode } from '../team/types.ts';
import type { UsageReporting } from '../team/usage.ts';

export const CLI_IDS = ['claude', 'opencode', 'antigravity'] as const;
export type CliId = (typeof CLI_IDS)[number];

export function isCliId(value: unknown): value is CliId {
  return typeof value === 'string' && (CLI_IDS as readonly string[]).includes(value);
}

/**
 * The CLI every member ran on before this was a choice, and what a roster
 * written before that gets when it is read back.
 */
export const DEFAULT_CLI: CliId = 'claude';

/**
 * What a CLI can and cannot do, so callers branch on a capability rather than
 * on a vendor name.
 *
 * These are not preferences. Each one is somewhere the orchestrator would
 * otherwise be silently wrong: a CLI that does not replay its transcript on
 * resume would lose every memory line we chose not to re-send, and a CLI that
 * reports no tokens would make a budget that never fires look like a budget
 * that is never exceeded.
 */
export interface CliSupport {
  /**
   * `native` — the CLI enforces a JSON schema itself.
   * `prompted` — we ask for a JSON block and parse it back out, which is
   * less reliable and must degrade toward "unreadable", never toward "approved".
   */
  structuredOutput: 'native' | 'prompted';
  /**
   * `file-flag` — a system prompt can be handed over per invocation.
   * `generated-agent` — it can only come from an agent definition we write to
   * disk first, which puts the member's role inside the project and therefore
   * within reach of anything that can write there.
   */
  systemPrompt: 'file-flag' | 'generated-agent';
  /**
   * `session-plugin-dir` — skills attach per invocation, so members cannot see
   * each other's.
   * `project-materialised` — they load from a fixed path, so the active
   * member's have to be written there just before it spawns. That works only
   * while exactly one member runs at a time.
   */
  skills: 'session-plugin-dir' | 'project-materialised';
  /** Whether a resumed turn re-sends the whole prior transcript to the model. */
  resumeReplaysTranscript: boolean;
  /** Whether the terminal event carries token counts. */
  reportsTokens: boolean;
  /**
   * Whether it carries a cost. Tokens without a cost is normal; the gap is
   * recorded as `unpricedTokens` rather than papered over with an estimate,
   * because a guessed number displayed like a measured one is worse than a
   * stated blank.
   */
  reportsCost: boolean;
  /**
   * Whether a usage reading is that step's own consumption or the session's
   * running total. Getting this wrong on a `cumulative` CLI multiplies reported
   * spend by the number of turns in the conversation.
   */
  usageReporting: UsageReporting;
}

/**
 * Translation between a CLI's tool names and the ones this codebase uses.
 *
 * The canonical set is Claude Code's own. That is a deliberate choice rather
 * than an accident of history: `approval-gate.sh` matches on those exact
 * strings and has contract tests pinned to them, so a new CLI translating
 * *into* the vocabulary costs one table, while moving everything to a new
 * neutral vocabulary would cost the gate and every test that guards it.
 */
export interface ToolVocabulary {
  /** What the CLI calls a tool → what we call it. */
  toCanonical(nativeTool: string): CanonicalTool;
  /**
   * Where in a native tool's arguments each canonical field lives.
   *
   * Used by the gate shims. A missing entry must deny rather than forward an
   * empty argument: an empty file path resolves to the project root, which is
   * a path the gate allows.
   */
  argKeys: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/**
 * Where the files a spawn refers to actually live, from the CLI's point of
 * view: real paths on the host, mount points inside a container.
 *
 * Isolating that difference is what lets one arg builder serve both backends
 * instead of the flag list being written out once per backend.
 */
export interface PathLayout {
  roleFile?: string;
  pluginDirs: string[];
}

/**
 * What an adapter needs in order to build a command line.
 *
 * A narrower view of the runner's options, declared here rather than imported
 * from the runner so an adapter and the runner do not have to import each
 * other. `RunnerOptions` satisfies this structurally.
 */
export interface SpawnRequest {
  prompt: string;
  projectDir: string;
  model: string;
  systemPrompt?: string;
  resume?: string;
  jsonSchema?: Record<string, unknown>;
  effort?: string;
  permissionMode?: string;
  /** The member id. Engines that name an agent per turn need something to call it. */
  pipelineAgent?: string;
}

/**
 * A model a member can be pointed at.
 *
 * A *family*, not a specific id. Antigravity bakes the effort level into the
 * model name (`gemini-3.7-flash-high`), so listing every combination would put
 * the same choice in two places and let them disagree. The family is the
 * choice; `efforts` says which levels it comes in.
 */
export interface CliModel {
  id: string;
  label: string;
  /** Omitted when the model has no effort variants at all. */
  efforts?: readonly Effort[];
}

export interface AgentCli {
  id: CliId;
  /** Human-facing name, for the team page and the office badge. */
  label: string;
  /** Executable on the host. */
  binary: string;
  /** Executable inside the agent container, where PATH differs. */
  containerBinary: string;
  support: CliSupport;
  /** Effort levels this CLI accepts. Narrower than ours for some. */
  efforts: readonly Effort[];
  /** Permission modes this CLI accepts. */
  permissionModes: readonly MemberPermissionMode[];
  /** What the UI offers for this CLI. */
  models: readonly CliModel[];
  /** Used when a member on this CLI has expressed no preference. */
  defaultModel: string;
  tools: ToolVocabulary;
  createDecoder(): AgentDecoder;
  /** The argv for one turn, against a given view of the filesystem. */
  buildArgs(request: SpawnRequest, layout: PathLayout): string[];
  /**
   * Anything that must exist on disk before the process starts.
   *
   * For engines with no `--system-prompt-file`, this is where the member's
   * role is written into whatever file the CLI *will* read. Called once per
   * spawn, immediately before it.
   */
  prepare?(request: SpawnRequest, layout: PathLayout): void;
  /**
   * Fetch the turn's reply after the process exits, for CLIs that do not put
   * it in the stream.
   *
   * OpenCode is the reason this exists: its JSON stream carries tool calls and
   * token counts but never the assistant's text, and it has no structured
   * output either — so without a second call there is no verdict to read at
   * all. Left undefined by engines whose reply arrives in the stream, which is
   * where it belongs.
   */
  fetchReplyText?(sessionId: string, projectDir: string): string;
}
