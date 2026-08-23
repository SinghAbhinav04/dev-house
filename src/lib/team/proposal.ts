/**
 * Letting the supervisor draft a team, without letting it grant permissions.
 *
 * A model proposes who the team should be; the server decides what those
 * people may touch. Nothing here reads capabilities from the proposal, and
 * nothing here writes to disk — `normalizeProposal` builds a fresh object out
 * of an allowlist of fields, so a proposal that names `capabilities`,
 * `enabled` or a token budget simply has those ignored rather than clamped.
 *
 * That split is the whole point. `.claude/` is unwritable and the roster lives
 * outside every member's write scope precisely so a member cannot widen its
 * own permissions; a drafting feature that let the model author capabilities
 * would reintroduce that by the front door.
 */

import {
  EFFORT_LEVELS,
  MAX_TEAM_SIZE,
  MODEL_ALIASES,
  SLOT_IDS,
  SLOT_LABELS,
  isValidMemberId,
  type Effort,
  type Roster,
  type SlotId,
} from './types.ts';
import { createMember, getMember, writeMemberRole, writeMemberSkill } from './roster.ts';

export interface ProposedSkill {
  name: string;
  description: string;
  body: string;
}

export interface ProposedMember {
  id: string;
  name: string;
  title: string;
  slot: SlotId | null;
  /** A model alias, or '' to follow the team default. */
  model: string;
  effort: Effort;
  /** Markdown, used verbatim as that member's system prompt. */
  role: string;
  skills: ProposedSkill[];
}

export interface TeamProposal {
  summary: string;
  members: ProposedMember[];
}

/** Caps that keep one bad proposal from filling the office or the disk. */
const MAX_SKILLS_PER_MEMBER = 3;
const MAX_SKILL_BODY = 12_000;
const MAX_ROLE_BODY = 12_000;
const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * The schema handed to the CLI.
 *
 * Deliberately has no `capabilities`, `enabled` or `tokenBudget` field: the
 * model is never invited to describe permissions, so a refusal to grant them
 * is not a special case in the validator, it is the shape of the request.
 */
export const TEAM_PROPOSAL_SCHEMA = {
  type: 'object',
  required: ['summary', 'members'],
  additionalProperties: false,
  properties: {
    summary: {
      type: 'string',
      description: 'One or two sentences on why this team, in plain language.',
    },
    members: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_TEAM_SIZE,
      items: {
        type: 'object',
        required: ['id', 'name', 'title', 'slot', 'role'],
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            description: 'Lowercase slug, letters digits and dashes, unique on the team.',
          },
          name: { type: 'string', description: 'Display name.' },
          title: { type: 'string', description: 'Short speciality, e.g. "Frontend".' },
          slot: {
            type: ['string', 'null'],
            enum: [...SLOT_IDS, null],
            description: 'Which seat they fill, or null for chat only. One member per seat.',
          },
          model: {
            type: 'string',
            enum: ['', ...MODEL_ALIASES],
            description: 'Empty follows the team default. Cheaper models for mechanical work.',
          },
          effort: { type: 'string', enum: [...EFFORT_LEVELS] },
          role: {
            type: 'string',
            description:
              'Markdown system prompt for this member. Specific to this project, not a generic job description.',
          },
          skills: {
            type: 'array',
            maxItems: MAX_SKILLS_PER_MEMBER,
            items: {
              type: 'object',
              required: ['name', 'description', 'body'],
              additionalProperties: false,
              properties: {
                name: { type: 'string', description: 'Slug, e.g. "house-style".' },
                description: { type: 'string', description: 'One line: when this member should open it.' },
                body: { type: 'string', description: 'Markdown the member reads on demand.' },
              },
            },
          },
        },
      },
    },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const WRAPPER_KEYS = ['structured_output', 'input', 'output', 'data', 'content', 'json', 'value', 'proposal'];

/**
 * Dig a proposal out of whatever the CLI wrapped it in.
 *
 * Mirrors the tolerance of the signal parser: the payload turns up at the
 * result level, nested under one of several wrapper keys, or as a JSON string.
 */
export function extractProposal(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 6 || value == null) return null;

  if (typeof value === 'string') {
    try {
      return extractProposal(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractProposal(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (!isRecord(value)) return null;
  if (Array.isArray(value.members)) return value;

  for (const key of WRAPPER_KEYS) {
    if (!(key in value)) continue;
    const found = extractProposal(value[key], depth + 1);
    if (found) return found;
  }

  for (const nested of Object.values(value)) {
    if (nested !== null && (typeof nested === 'object' || typeof nested === 'string')) {
      const found = extractProposal(nested, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizeSkills(raw: unknown, warnings: string[], memberId: string): ProposedSkill[] {
  if (!Array.isArray(raw)) return [];

  const skills: ProposedSkill[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (skills.length >= MAX_SKILLS_PER_MEMBER) {
      warnings.push(`${memberId}: only the first ${MAX_SKILLS_PER_MEMBER} skills were kept.`);
      break;
    }
    if (!isRecord(entry)) continue;

    const name = text(entry.name, 32).toLowerCase().replace(/\s+/g, '-');
    const body = text(entry.body, MAX_SKILL_BODY);

    if (!SKILL_NAME_PATTERN.test(name)) {
      warnings.push(`${memberId}: dropped a skill with an unusable name.`);
      continue;
    }
    if (!body) {
      warnings.push(`${memberId}: dropped empty skill "${name}".`);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);

    skills.push({ name, description: text(entry.description, 200), body });
  }

  return skills;
}

/**
 * Turn a model's raw answer into something safe to apply.
 *
 * Every field is copied out by name. Nothing is spread, so a proposal cannot
 * smuggle a field through by inventing it, and warnings explain each drop
 * rather than the team quietly coming out different from what was reviewed.
 */
export function normalizeProposal(raw: unknown, roster: Roster): { proposal: TeamProposal; warnings: string[] } {
  const warnings: string[] = [];
  const found = extractProposal(raw);
  const rawMembers = found && Array.isArray(found.members) ? found.members : [];

  const seatsLeft = Math.max(0, MAX_TEAM_SIZE - roster.members.length);
  const takenIds = new Set(roster.members.map((m) => m.id));
  const takenSlots = new Set(roster.members.filter((m) => m.slot).map((m) => m.slot as SlotId));

  const members: ProposedMember[] = [];

  for (const entry of rawMembers) {
    if (!isRecord(entry)) continue;

    if (members.length >= seatsLeft) {
      warnings.push(`The office is full at ${MAX_TEAM_SIZE}; later members in the proposal were dropped.`);
      break;
    }

    const id = text(entry.id, 32).toLowerCase();
    if (!isValidMemberId(id)) {
      warnings.push(`Dropped a member with an invalid id ("${text(entry.id, 32) || 'empty'}").`);
      continue;
    }
    if (takenIds.has(id)) {
      warnings.push(`Dropped "${id}" — a member with that id already exists.`);
      continue;
    }
    takenIds.add(id);

    let slot: SlotId | null = null;
    const rawSlot = text(entry.slot, 32);
    if (rawSlot) {
      if (!SLOT_IDS.includes(rawSlot as SlotId)) {
        warnings.push(`${id}: unknown slot "${rawSlot}", left with no seat.`);
      } else if (takenSlots.has(rawSlot as SlotId)) {
        // The runtime only ever runs the first member in a slot, so a second
        // one would look staffed and never run. Better as an explicit guest.
        warnings.push(`${id}: the ${SLOT_LABELS[rawSlot as SlotId]} seat is already taken, so they have no seat.`);
      } else {
        slot = rawSlot as SlotId;
        takenSlots.add(slot);
      }
    }

    const rawModel = text(entry.model, 64);
    const model = MODEL_ALIASES.includes(rawModel as (typeof MODEL_ALIASES)[number]) ? rawModel : '';
    if (rawModel && !model) warnings.push(`${id}: unknown model "${rawModel}", following the team default.`);

    const rawEffort = text(entry.effort, 16);
    const effort = (EFFORT_LEVELS.includes(rawEffort as Effort) ? rawEffort : 'medium') as Effort;

    members.push({
      id,
      name: text(entry.name, 60) || id,
      title: text(entry.title, 60),
      slot,
      model,
      effort,
      role: text(entry.role, MAX_ROLE_BODY),
      skills: normalizeSkills(entry.skills, warnings, id),
    });
  }

  return {
    proposal: { summary: text(found?.summary, 600), members },
    warnings,
  };
}

/**
 * Create the proposed members for real.
 *
 * Goes through the same `createMember` every other path uses, which derives
 * capabilities from the slot — this function has no way to set them even if
 * it wanted to. Members are created one at a time and failures are collected,
 * so one bad entry does not abandon the rest half-applied.
 */
export function applyProposal(
  roster: Roster,
  proposal: TeamProposal
): { roster: Roster; created: string[]; failed: Array<{ id: string; error: string }> } {
  let current = roster;
  const created: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const member of proposal.members) {
    if (getMember(current, member.id)) {
      failed.push({ id: member.id, error: 'A member with that id already exists.' });
      continue;
    }

    try {
      const result = createMember(current, {
        id: member.id,
        name: member.name,
        title: member.title,
        slot: member.slot,
        model: member.model,
        effort: member.effort,
        ...(member.role ? { role: member.role } : {}),
      });
      current = result.roster;

      // createMember only writes a role when the file does not exist yet, so a
      // re-hire keeps whatever was on disk. A fresh draft should win.
      if (member.role) writeMemberRole(member.id, member.role);
      for (const skill of member.skills) writeMemberSkill(member.id, skill);

      created.push(member.id);
    } catch (error) {
      failed.push({ id: member.id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { roster: current, created, failed };
}

/** The instruction the drafting turn runs under. */
export function proposalSystemPrompt(roster: Roster): string {
  const staffed = SLOT_IDS.filter((slot) => roster.members.some((m) => m.slot === slot));
  const open = SLOT_IDS.filter((slot) => !staffed.includes(slot));

  return [
    'You design a small software team for one specific job, then stop.',
    '',
    'The seats are: ' + SLOT_IDS.map((s) => `${s} (${SLOT_LABELS[s]})`).join(', ') + '.',
    staffed.length > 0 ? `Already staffed, do not propose these: ${staffed.join(', ')}.` : 'No seat is staffed yet.',
    open.length > 0 ? `Open seats: ${open.join(', ')}.` : 'Every seat is taken.',
    `At most ${MAX_TEAM_SIZE} members exist in total, so propose only who the job needs.`,
    '',
    'Rules:',
    '- A planner is required for a run to start at all. A coder is required for anything to be built.',
    '- One member per seat. Leaving a seat empty skips that phase, which is a legitimate choice.',
    '- Write each role as instructions to that member for this job, not a generic job description.',
    '- Give a member a skill only when there is a real document worth attaching; skills cost context.',
    '- Prefer cheaper models for mechanical work and reserve the expensive ones for planning and review.',
    '',
    'You do not decide what anyone is permitted to do. Tool permissions come from the seat and are',
    'enforced elsewhere; do not describe, request or assume them.',
    '',
    'Answer with the JSON object the schema describes and nothing else.',
  ].join('\n');
}
