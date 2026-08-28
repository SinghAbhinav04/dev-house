/**
 * Team roster types.
 *
 * The roster is the single source of truth for who is on the team. Nothing in
 * the codebase may hardcode a member id — every "who does the coding?" question
 * is answered by resolving a slot against the roster.
 */

import { DEFAULT_CLI, type CliId } from '../cli/types.ts';

// ── Slots ────────────────────────────────────────────────────────────

/**
 * A slot is a seat in the workflow, not a person. Members are assigned to
 * slots; the orchestrator asks the roster who is filling a slot rather than
 * naming anyone directly.
 */
export const SLOT_IDS = ['planner', 'reviewer', 'coder', 'tester', 'auditor', 'supervisor'] as const;
export type SlotId = (typeof SLOT_IDS)[number];

export function isSlotId(value: unknown): value is SlotId {
  return typeof value === 'string' && (SLOT_IDS as readonly string[]).includes(value);
}

/** Human labels for slots, used in prompts and UI. */
export const SLOT_LABELS: Record<SlotId, string> = {
  planner: 'Planner',
  reviewer: 'Plan Reviewer',
  coder: 'Coder',
  tester: 'Tester',
  auditor: 'Security Auditor',
  supervisor: 'Supervisor',
};

// ── Per-member execution settings ────────────────────────────────────

/**
 * Permission modes accepted by `claude --permission-mode`. Verified against
 * Claude Code 2.1.220: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.
 */
export const PERMISSION_MODES = ['plan', 'auto', 'acceptEdits', 'dontAsk', 'manual', 'bypassPermissions'] as const;
export type MemberPermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: unknown): value is MemberPermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** Effort levels accepted by `claude --effort`. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * Model aliases the CLI resolves itself (`claude --model opus`). A member may
 * also carry a fully qualified model id.
 */
export const MODEL_ALIASES = ['haiku', 'sonnet', 'opus', 'fable'] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];

export const DEFAULT_MODEL: ModelAlias = 'sonnet';

/**
 * A model id shortened to something that fits in a label.
 *
 * OpenCode ids are fully qualified paths —
 * `fireworks-ai/accounts/fireworks/models/glm-5p2` — and only the last segment
 * identifies the model to a human. Claude and Antigravity ids have no slashes,
 * so they come back unchanged.
 */
export function shortModelLabel(model: string): string {
  if (!model) return '';
  return model.split('/').pop() || model;
}

// ── Capabilities ─────────────────────────────────────────────────────

/**
 * What a member may write.
 * - `none`     — no writes at all
 * - `artifact` — only the file its slot owns (e.g. the planner's plan.md)
 * - `project`  — anywhere inside the active project root
 * - `builds`   — anywhere under ~/Builds; reserved for the supervisor slot and
 *                clamped down to `project` for anyone else (see clampCapabilities)
 */
export const WRITE_LEVELS = ['none', 'artifact', 'project', 'builds'] as const;
export type WriteLevel = (typeof WRITE_LEVELS)[number];

/**
 * How a member's Bash calls are treated.
 * - `none`     — Bash blocked outright
 * - `approval` — every call requires explicit user approval
 * - `safe`     — allowed, subject to the run's security mode and Claude's own classifier
 * - `all`      — allowed, and never escalated to approval even in strict mode
 */
export const BASH_LEVELS = ['none', 'approval', 'safe', 'all'] as const;
export type BashLevel = (typeof BASH_LEVELS)[number];

/** Docker network profile, previously `runner.ts` getNetworkProfile(). */
export const NETWORK_PROFILES = ['none', 'research', 'build'] as const;
export type NetworkProfile = (typeof NETWORK_PROFILES)[number];

export interface MemberCapabilities {
  write: WriteLevel;
  bash: BashLevel;
  /** WebFetch / WebSearch access. */
  web: boolean;
  network: NetworkProfile;
  /** Docker project mount mode, previously getProjectMountMode(). */
  projectMount: 'ro' | 'rw';
  /** Whether to prefer the isolated Docker runner, previously shouldPreferDocker(). */
  preferIsolated: boolean;
}

// ── Members ──────────────────────────────────────────────────────────

/**
 * Member ids double as the `PIPELINE_AGENT` env value and as a path segment
 * under ~/.hackeroom/members/, so they are deliberately restrictive.
 */
/**
 * How many members the office has room for.
 *
 * A real cap, not a suggestion: the office scene lays out one desk per member
 * and past seven they stop fitting, and a run only ever staffs six slots
 * anyway.
 */
export const MAX_TEAM_SIZE = 7;

export const OFFICE_FULL_MESSAGE =
  'Whoa — your office is currently too small for this. Remove someone before hiring again.';

export const MEMBER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isValidMemberId(value: unknown): value is string {
  return typeof value === 'string' && MEMBER_ID_PATTERN.test(value);
}

export interface TeamMember {
  id: string;
  name: string;
  /** Short role descriptor shown in the UI, e.g. "Frontend". */
  title: string;
  color: string;
  /** Sprite key under public/sprites/, or '' to use the generated fallback. */
  sprite: string;
  /** Which seat this member fills, or null for chat/handoff only. */
  slot: SlotId | null;
  /**
   * Which agent CLI this member runs on.
   *
   * Absent on any roster written before members had a choice, which the
   * normaliser reads as Claude Code. Model ids are CLI-specific — `opus` means
   * nothing to Antigravity — so this and `model` have to be changed together.
   */
  cli: CliId;
  /** Model alias or full model id. Empty string means "use the team default". */
  model: string;
  permissionMode: MemberPermissionMode;
  effort: Effort;
  capabilities: MemberCapabilities;
  /** Skill directory names under ~/.hackeroom/members/<id>/plugin/skills/. */
  skills: string[];
  /** Optional cap on total tokens this member may spend in one run. */
  tokenBudget?: number;
  enabled: boolean;
}

// ── Workflow ─────────────────────────────────────────────────────────

export interface SlotConfig {
  enabled: boolean;
  /**
   * Member ids filling this slot. Multi-fill is accepted by the schema but the
   * runtime currently uses only the first entry — see resolveSlot().
   */
  members: string[];
}

export type RunGoal = 'full-build' | 'plan-only';

export interface WorkflowConfig {
  slots: Record<SlotId, SlotConfig>;
  runGoal: RunGoal;
  /** Pause the run once this slot's phase completes. */
  stopAfterSlot: SlotId | 'none';
  /**
   * Offer to draft a team from a description of the job when the roster
   * cannot staff a run. Drafting always ends in a proposal you approve — this
   * decides whether the offer appears, never whether members are created.
   */
  autoTeam?: boolean;
}

export interface Roster {
  version: 2;
  /**
   * The engine a new member gets by default.
   *
   * Also decides who `teamModel` applies to: model ids are CLI-specific, so a
   * team default of `sonnet` cannot mean anything to a member running on
   * something that has never heard of it.
   */
  teamCli: CliId;
  /** Applied to any member on `teamCli` whose own `model` is empty. */
  teamModel: string;
  /** Active UI theme key, persisted alongside the roster. */
  theme?: string;
  members: TeamMember[];
  workflow: WorkflowConfig;
}

// ── Defaults ─────────────────────────────────────────────────────────

/**
 * Capability defaults per slot. These mirror the guarantees the original
 * fixed squad relied on: the planner writes only its plan, the reviewer and
 * auditor are read-only, the coder owns the project, the tester runs things.
 *
 * They are defaults for member *creation*, not enforcement — enforcement is
 * clampCapabilities() plus the hook.
 */
export const SLOT_CAPABILITY_DEFAULTS: Record<SlotId, MemberCapabilities> = {
  planner: { write: 'artifact', bash: 'none', web: true, network: 'research', projectMount: 'rw', preferIsolated: false },
  reviewer: { write: 'none', bash: 'none', web: true, network: 'research', projectMount: 'ro', preferIsolated: false },
  coder: { write: 'project', bash: 'safe', web: false, network: 'build', projectMount: 'rw', preferIsolated: true },
  tester: { write: 'none', bash: 'safe', web: false, network: 'build', projectMount: 'rw', preferIsolated: true },
  auditor: { write: 'none', bash: 'none', web: false, network: 'none', projectMount: 'ro', preferIsolated: false },
  supervisor: { write: 'builds', bash: 'safe', web: true, network: 'research', projectMount: 'rw', preferIsolated: false },
};

/** Capabilities for a member with no slot: read-only, no side effects. */
export const UNSLOTTED_CAPABILITY_DEFAULTS: MemberCapabilities = {
  write: 'none',
  bash: 'none',
  web: false,
  network: 'none',
  projectMount: 'ro',
  preferIsolated: false,
};

export function defaultCapabilitiesForSlot(slot: SlotId | null): MemberCapabilities {
  return { ...(slot ? SLOT_CAPABILITY_DEFAULTS[slot] : UNSLOTTED_CAPABILITY_DEFAULTS) };
}

/**
 * The artifact each slot owns. A member with `write: 'artifact'` may write
 * only this filename; a member with `write: 'project'` may write anything in
 * the project *except* artifacts owned by another slot.
 */
export const SLOT_ARTIFACTS: Partial<Record<SlotId, string>> = {
  planner: 'plan.md',
};

export const DEFAULT_WORKFLOW: WorkflowConfig = {
  slots: {
    planner: { enabled: true, members: [] },
    reviewer: { enabled: true, members: [] },
    coder: { enabled: true, members: [] },
    tester: { enabled: true, members: [] },
    auditor: { enabled: true, members: [] },
    supervisor: { enabled: true, members: [] },
  },
  runGoal: 'full-build',
  stopAfterSlot: 'none',
};

export const EMPTY_ROSTER: Roster = {
  version: 2,
  teamCli: DEFAULT_CLI,
  teamModel: DEFAULT_MODEL,
  members: [],
  workflow: DEFAULT_WORKFLOW,
};

/** Palette used when the UI auto-assigns a colour to a new member. */
export const MEMBER_COLORS = [
  '#c2703d',
  '#b5852a',
  '#8a8f3c',
  '#3f7d6a',
  '#4a6fa5',
  '#8a5a8f',
  '#b05664',
  '#7a6a58',
] as const;
