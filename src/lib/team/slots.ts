/**
 * Slot resolution and run planning.
 *
 * The orchestrator never names a member. It asks "who is filling the coder
 * slot?" and "does the testing phase run at all?", and this module answers
 * both from the roster plus the workflow config.
 */

import { SLOT_ARTIFACTS, SLOT_LABELS, type Roster, type RunGoal, type SlotId, type TeamMember } from './types.ts';
import { getMember } from './roster.ts';

/**
 * The member filling a slot, or null when the slot is disabled, unassigned, or
 * assigned to a member who has since been disabled or deleted.
 *
 * Multi-fill: the schema accepts several members per slot, but the runtime uses
 * the first eligible one. Running two members in the same phase concurrently
 * would require an append-only event log — today the whole state file is
 * rewritten on every event with no locking, so parallel writers would corrupt
 * it. `extraMembersFor()` reports the ignored assignments so callers can warn.
 */
export function resolveSlot(roster: Roster, slotId: SlotId): TeamMember | null {
  const slot = roster.workflow.slots[slotId];
  if (!slot || !slot.enabled) return null;

  for (const id of slot.members) {
    const member = getMember(roster, id);
    if (member && member.enabled) return member;
  }

  return null;
}

/** Assigned members beyond the first eligible one, which the runtime ignores. */
export function extraMembersFor(roster: Roster, slotId: SlotId): TeamMember[] {
  const slot = roster.workflow.slots[slotId];
  if (!slot || !slot.enabled) return [];

  const eligible = slot.members
    .map((id) => getMember(roster, id))
    .filter((m): m is TeamMember => Boolean(m && m.enabled));

  return eligible.slice(1);
}

/** Which slot, if any, a member occupies in the current workflow. */
export function slotForMember(roster: Roster, memberId: string): SlotId | null {
  const member = getMember(roster, memberId);
  return member?.slot ?? null;
}

/** Every member that will actually take part in a run, supervisor included. */
export function activeMembers(roster: Roster): TeamMember[] {
  const seen = new Set<string>();
  const out: TeamMember[] = [];

  for (const slotId of Object.keys(roster.workflow.slots) as SlotId[]) {
    const member = resolveSlot(roster, slotId);
    if (member && !seen.has(member.id)) {
      seen.add(member.id);
      out.push(member);
    }
  }

  return out;
}

/** The file a member exclusively owns, if its slot has one (planner → plan.md). */
export function artifactForMember(roster: Roster, memberId: string): string | null {
  const slot = slotForMember(roster, memberId);
  return slot ? SLOT_ARTIFACTS[slot] ?? null : null;
}

/** Map of artifact filename → owning member id, for the hook manifest. */
export function artifactOwners(roster: Roster): Record<string, string> {
  const owners: Record<string, string> = {};

  for (const [slotId, filename] of Object.entries(SLOT_ARTIFACTS) as Array<[SlotId, string]>) {
    const member = resolveSlot(roster, slotId);
    if (member) owners[filename] = member.id;
  }

  return owners;
}

// ── Run planning ─────────────────────────────────────────────────────

export interface RunPhases {
  planning: boolean;
  planReview: boolean;
  coding: boolean;
  codeReview: boolean;
  testing: boolean;
  audit: boolean;
  deploy: boolean;
}

export interface RunPlan {
  ok: boolean;
  errors: string[];
  notes: string[];
  members: Record<SlotId, TeamMember | null>;
  phases: RunPhases;
  /** May be downgraded from the configured goal — e.g. no coder means plan-only. */
  runGoal: RunGoal;
  stopAfterSlot: SlotId | 'none';
}

/**
 * Work out what a run will actually do given the roster.
 *
 * Skip rules, in the order they matter:
 * - no planner  → the run cannot start; nothing owns the plan
 * - no coder    → plan-only, whatever the configured goal says
 * - no reviewer → the plan locks after the planner's own pass, with no
 *                 external approval gate to wait on
 * - no tester   → both the code-review loop and the testing loop are skipped
 * - no auditor  → the audit phase is skipped (the old runFinalAudit:false path)
 */
export function buildRunPlan(roster: Roster): RunPlan {
  const members = {
    planner: resolveSlot(roster, 'planner'),
    reviewer: resolveSlot(roster, 'reviewer'),
    coder: resolveSlot(roster, 'coder'),
    tester: resolveSlot(roster, 'tester'),
    auditor: resolveSlot(roster, 'auditor'),
    supervisor: resolveSlot(roster, 'supervisor'),
  } as Record<SlotId, TeamMember | null>;

  const errors: string[] = [];
  const notes: string[] = [];

  if (!members.planner) {
    errors.push('No member is filling the planner slot — nothing would own the build plan. Assign a planner to start a run.');
  }

  const configuredGoal = roster.workflow.runGoal;
  const runGoal: RunGoal = members.coder ? configuredGoal : 'plan-only';

  if (!members.coder && configuredGoal === 'full-build') {
    notes.push('No coder assigned — running plan-only.');
  }
  if (!members.reviewer) {
    notes.push('No plan reviewer — the plan locks after the planner’s own review pass.');
  }
  if (!members.tester) {
    notes.push('No tester — code review and testing are skipped.');
  }
  if (!members.auditor) {
    notes.push('No security auditor — the audit phase is skipped.');
  }
  if (!members.supervisor) {
    notes.push('No supervisor — status narration and recovery suggestions are unavailable.');
  }

  for (const slotId of Object.keys(members) as SlotId[]) {
    const extras = extraMembersFor(roster, slotId);
    if (extras.length > 0) {
      notes.push(
        `${SLOT_LABELS[slotId]} slot has ${extras.length} extra member(s) assigned (${extras
          .map((m) => m.name)
          .join(', ')}); only ${members[slotId]?.name} will run.`
      );
    }
  }

  const building = runGoal === 'full-build' && Boolean(members.coder);

  const phases: RunPhases = {
    planning: Boolean(members.planner),
    planReview: Boolean(members.planner && members.reviewer),
    coding: building,
    codeReview: building && Boolean(members.tester),
    testing: building && Boolean(members.tester),
    audit: building && Boolean(members.auditor),
    deploy: building,
  };

  return {
    ok: errors.length === 0,
    errors,
    notes,
    members,
    phases,
    runGoal,
    stopAfterSlot: roster.workflow.stopAfterSlot,
  };
}

/** One-line summary of a run plan, for pipeline events and the UI. */
export function describeRunPlan(plan: RunPlan): string {
  const running = (Object.keys(plan.members) as SlotId[])
    .filter((slotId) => plan.members[slotId])
    .map((slotId) => `${SLOT_LABELS[slotId]}: ${plan.members[slotId]!.name}`);

  return running.length > 0 ? running.join(' · ') : 'No members assigned.';
}

/** A fresh idle status map keyed by the members currently on the team. */
export function idleStatusForRoster(roster: Roster): Record<string, string> {
  const status: Record<string, string> = {};
  for (const member of roster.members) {
    if (member.enabled) status[member.id] = 'idle';
  }
  return status;
}
