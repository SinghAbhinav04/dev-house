/**
 * Roster storage and normalisation.
 *
 * Layout under HACKEROOM_HOME (default ~/.hackeroom):
 *
 *   team.json                       the roster
 *   members/<id>/role.md            the member's system prompt
 *   members/<id>/plugin/            the member's skills, as a Claude Code plugin
 *     .claude-plugin/plugin.json
 *     skills/<skill>/SKILL.md
 *   templates/roles/*.md            starter role templates
 *
 * Follows the module shape of pipeline-approval.ts: exported filename
 * constants, path helpers, and a read/write pair that never throws.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  DEFAULT_MODEL,
  DEFAULT_WORKFLOW,
  EFFORT_LEVELS,
  EMPTY_ROSTER,
  MAX_TEAM_SIZE,
  MEMBER_COLORS,
  OFFICE_FULL_MESSAGE,
  MODEL_ALIASES,
  PERMISSION_MODES,
  SLOT_IDS,
  UNSLOTTED_CAPABILITY_DEFAULTS,
  defaultCapabilitiesForSlot,
  isEffort,
  isPermissionMode,
  isSlotId,
  isValidMemberId,
  type Effort,
  type MemberCapabilities,
  type MemberPermissionMode,
  type Roster,
  type SlotConfig,
  type SlotId,
  type TeamMember,
  type WorkflowConfig,
} from './types.ts';
import { DEFAULT_CLI, isCliId } from '../cli/types.ts';

export const ROSTER_FILE = 'team.json';
export const ROLE_FILENAME = 'role.md';

// ── Paths ────────────────────────────────────────────────────────────

/**
 * Root of the team configuration. Overridable via HACKEROOM_HOME so tests can
 * run against a temp directory without touching the user's real roster.
 */
export function hackeroomHome(): string {
  const override = process.env.HACKEROOM_HOME;
  return override ? resolve(override) : join(homedir(), '.hackeroom');
}

export function rosterPath(): string {
  return join(hackeroomHome(), ROSTER_FILE);
}

export function membersDir(): string {
  return join(hackeroomHome(), 'members');
}

export function memberDir(id: string): string {
  return join(membersDir(), id);
}

export function memberRolePath(id: string): string {
  return join(memberDir(id), ROLE_FILENAME);
}

/** A member's skills are packaged as a session-scoped Claude Code plugin. */
export function memberPluginDir(id: string): string {
  return join(memberDir(id), 'plugin');
}

export function memberSkillsDir(id: string): string {
  return join(memberPluginDir(id), 'skills');
}

export function roleTemplatesDir(): string {
  return join(hackeroomHome(), 'templates', 'roles');
}

/** Role templates shipped in the repo, seeded into HACKEROOM_HOME on first run. */
export function bundledRoleTemplatesDir(): string {
  return resolve(process.cwd(), 'templates', 'roles');
}

// ── Normalisation ────────────────────────────────────────────────────

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Repair a capabilities object and enforce the one invariant the roster itself
 * owns: only the supervisor slot may write outside the project root. Everything
 * else is enforced by the hook, which treats the generated manifest as data and
 * keeps its own unconditional clamps.
 */
export function clampCapabilities(raw: unknown, slot: SlotId | null): MemberCapabilities {
  const defaults = defaultCapabilitiesForSlot(slot);
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const caps: MemberCapabilities = {
    write: oneOf(input.write, ['none', 'artifact', 'project', 'builds'] as const, defaults.write),
    bash: oneOf(input.bash, ['none', 'approval', 'safe', 'all'] as const, defaults.bash),
    web: typeof input.web === 'boolean' ? input.web : defaults.web,
    network: oneOf(input.network, ['none', 'research', 'build'] as const, defaults.network),
    projectMount: oneOf(input.projectMount, ['ro', 'rw'] as const, defaults.projectMount),
    preferIsolated: typeof input.preferIsolated === 'boolean' ? input.preferIsolated : defaults.preferIsolated,
  };

  // Only the supervisor may roam ~/Builds. Anyone else claiming that scope is
  // silently downgraded to the project jail.
  if (caps.write === 'builds' && slot !== 'supervisor') {
    caps.write = 'project';
  }

  // A member that may not write at all has no use for a writable mount.
  if (caps.write === 'none' && caps.projectMount === 'rw' && slot !== null) {
    caps.projectMount = defaults.projectMount;
  }

  return caps;
}

function normalizeMember(raw: unknown, index: number): TeamMember | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;

  const id = str(input.id).trim().toLowerCase();
  if (!isValidMemberId(id)) return null;

  const slot = isSlotId(input.slot) ? input.slot : null;
  const skills = Array.isArray(input.skills)
    ? input.skills.filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];

  const budget = typeof input.tokenBudget === 'number' && input.tokenBudget > 0 ? Math.floor(input.tokenBudget) : undefined;

  return {
    id,
    name: str(input.name) || id,
    title: str(input.title),
    color: str(input.color) || MEMBER_COLORS[index % MEMBER_COLORS.length],
    sprite: str(input.sprite),
    slot,
    // Absent on every roster written before members could choose an engine,
    // and on any roster naming a CLI this build cannot run. Both read as
    // Claude Code, which is what those members were already running.
    cli: isCliId(input.cli) ? input.cli : DEFAULT_CLI,
    model: str(input.model),
    permissionMode: isPermissionMode(input.permissionMode) ? input.permissionMode : 'auto',
    effort: isEffort(input.effort) ? input.effort : 'high',
    capabilities: clampCapabilities(input.capabilities, slot),
    skills,
    ...(budget === undefined ? {} : { tokenBudget: budget }),
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
  };
}

function normalizeWorkflow(raw: unknown, members: TeamMember[]): WorkflowConfig {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawSlots = (input.slots && typeof input.slots === 'object' ? input.slots : {}) as Record<string, unknown>;
  const known = new Set(members.map((m) => m.id));

  const slots = {} as Record<SlotId, SlotConfig>;
  for (const slotId of SLOT_IDS) {
    const rawSlot = (rawSlots[slotId] && typeof rawSlots[slotId] === 'object' ? rawSlots[slotId] : {}) as Record<string, unknown>;

    // Assignments come from the members array first (member.slot is the
    // authoritative link), then from any explicit workflow entry that still
    // refers to a member who exists.
    const fromMembers = members.filter((m) => m.slot === slotId && m.enabled).map((m) => m.id);
    const explicit = Array.isArray(rawSlot.members)
      ? rawSlot.members.filter((id): id is string => typeof id === 'string' && known.has(id))
      : [];

    const assigned = fromMembers.length > 0 ? fromMembers : explicit;

    slots[slotId] = {
      // Staffing a slot is what makes it run; `enabled` exists so a staffed slot
      // can be switched off for one run ("skip the tester on this frontend job")
      // without unassigning anybody.
      enabled: rawSlot.enabled === undefined ? true : Boolean(rawSlot.enabled),
      members: Array.from(new Set(assigned)),
    };
  }

  return {
    slots,
    runGoal: oneOf(input.runGoal, ['full-build', 'plan-only'] as const, DEFAULT_WORKFLOW.runGoal),
    stopAfterSlot: isSlotId(input.stopAfterSlot) ? input.stopAfterSlot : 'none',
    autoTeam: input.autoTeam === true,
  };
}

/**
 * Coerce arbitrary JSON into a valid Roster. Invalid members are dropped rather
 * than repaired into something the user did not ask for — a member with a
 * malformed id would be rejected by the hook anyway, so keeping it would only
 * produce confusing mid-run failures.
 */
export function normalizeRoster(raw: unknown): Roster {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_ROSTER, workflow: normalizeWorkflow(null, []) };
  const input = raw as Record<string, unknown>;

  const seen = new Set<string>();
  const members: TeamMember[] = [];
  const rawMembers = Array.isArray(input.members) ? input.members : [];

  for (const [index, rawMember] of rawMembers.entries()) {
    const member = normalizeMember(rawMember, index);
    if (!member || seen.has(member.id)) continue;
    seen.add(member.id);
    members.push(member);
  }

  return {
    version: 2,
    teamModel: str(input.teamModel) || DEFAULT_MODEL,
    ...(typeof input.theme === 'string' ? { theme: input.theme } : {}),
    members,
    workflow: normalizeWorkflow(input.workflow, members),
  };
}

// ── Read / write ─────────────────────────────────────────────────────

export function readRoster(): Roster {
  const file = rosterPath();
  if (!existsSync(file)) return normalizeRoster(null);

  try {
    return normalizeRoster(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return normalizeRoster(null);
  }
}

export function writeRoster(roster: Roster): Roster {
  const normalized = normalizeRoster(roster);
  mkdirSync(hackeroomHome(), { recursive: true });
  writeFileSync(rosterPath(), JSON.stringify(normalized, null, 2));
  return normalized;
}

// ── Member helpers ───────────────────────────────────────────────────

export function getMember(roster: Roster, id: string): TeamMember | null {
  return roster.members.find((m) => m.id === id) ?? null;
}

/**
 * The model a member actually runs on: its own choice, else the team default,
 * else the built-in default. Aliases are passed through to the CLI untouched.
 */
export function resolveModel(roster: Roster, member: TeamMember): string {
  return member.model || roster.teamModel || DEFAULT_MODEL;
}

export function memberDisplayName(member: TeamMember): string {
  return member.title ? `${member.name} (${member.title})` : member.name;
}

/**
 * Create a member and lay down its on-disk files. `role` is the markdown system
 * prompt; when omitted the member gets a placeholder that names its slot.
 */
export function createMember(
  roster: Roster,
  input: {
    id: string;
    name?: string;
    title?: string;
    slot?: SlotId | null;
    model?: string;
    permissionMode?: MemberPermissionMode;
    effort?: Effort;
    capabilities?: Partial<MemberCapabilities>;
    color?: string;
    sprite?: string;
    role?: string;
    tokenBudget?: number;
  }
): { roster: Roster; member: TeamMember } {
  const id = input.id.trim().toLowerCase();
  if (!isValidMemberId(id)) {
    throw new Error(`Invalid member id "${input.id}" — use lowercase letters, digits and dashes (max 32 chars).`);
  }
  if (getMember(roster, id)) {
    throw new Error(`A member with id "${id}" already exists.`);
  }
  if (roster.members.length >= MAX_TEAM_SIZE) {
    throw new Error(OFFICE_FULL_MESSAGE);
  }

  const slot = input.slot ?? null;
  const member = normalizeMember(
    {
      ...input,
      id,
      slot,
      capabilities: { ...defaultCapabilitiesForSlot(slot), ...(input.capabilities ?? {}) },
    },
    roster.members.length
  );
  if (!member) throw new Error(`Could not create member "${id}".`);

  mkdirSync(memberDir(id), { recursive: true });
  mkdirSync(memberSkillsDir(id), { recursive: true });
  writeMemberPluginManifest(member);

  if (!existsSync(memberRolePath(id))) {
    writeMemberRole(id, input.role ?? defaultRoleFor(member));
  }

  const next = writeRoster({ ...roster, members: [...roster.members, member] });
  return { roster: next, member: getMember(next, id) ?? member };
}

export function updateMember(roster: Roster, id: string, patch: Partial<TeamMember>): Roster {
  const existing = getMember(roster, id);
  if (!existing) throw new Error(`No member with id "${id}".`);

  // The id is the on-disk directory name and the PIPELINE_AGENT value; renaming
  // it would orphan the member's role and skills, so it is not patchable.
  const merged = { ...existing, ...patch, id: existing.id };
  const normalized = normalizeMember(merged, roster.members.indexOf(existing));
  if (!normalized) throw new Error(`Invalid update for member "${id}".`);

  return writeRoster({
    ...roster,
    members: roster.members.map((m) => (m.id === id ? normalized : m)),
  });
}

export function removeMember(roster: Roster, id: string, options: { deleteFiles?: boolean } = {}): Roster {
  if (options.deleteFiles) {
    try {
      rmSync(memberDir(id), { recursive: true, force: true });
    } catch {}
  }

  return writeRoster({
    ...roster,
    members: roster.members.filter((m) => m.id !== id),
    workflow: {
      ...roster.workflow,
      slots: Object.fromEntries(
        SLOT_IDS.map((slotId) => [
          slotId,
          { ...roster.workflow.slots[slotId], members: roster.workflow.slots[slotId].members.filter((m) => m !== id) },
        ])
      ) as Record<SlotId, SlotConfig>,
    },
  });
}

// ── Role markdown ────────────────────────────────────────────────────

export function readMemberRole(id: string): string {
  const file = memberRolePath(id);
  if (!existsSync(file)) return '';
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export function writeMemberRole(id: string, markdown: string): void {
  mkdirSync(memberDir(id), { recursive: true });
  writeFileSync(memberRolePath(id), markdown);
}

function defaultRoleFor(member: TeamMember): string {
  const slotLine = member.slot
    ? `You are the ${member.slot} on this team.`
    : 'You are a specialist on this team, available for direct questions and handoffs.';

  return [
    `# ${member.name}`,
    '',
    slotLine,
    member.title ? `Your speciality is ${member.title}.` : '',
    '',
    'Replace this file with the role you actually want. It is used verbatim as',
    'the system prompt for every session this member runs.',
    '',
  ]
    .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
    .join('\n');
}

/** Copy the repo's bundled role templates into HACKEROOM_HOME if not present. */
export function seedRoleTemplates(): string[] {
  const source = bundledRoleTemplatesDir();
  const target = roleTemplatesDir();
  if (!existsSync(source)) return [];

  mkdirSync(target, { recursive: true });
  const copied: string[] = [];

  for (const name of readdirSync(source)) {
    if (!name.endsWith('.md')) continue;
    const dest = join(target, name);
    if (existsSync(dest)) continue;
    try {
      writeFileSync(dest, readFileSync(join(source, name), 'utf8'));
      copied.push(name);
    } catch {}
  }

  return copied;
}

export function listRoleTemplates(): Array<{ name: string; path: string }> {
  const dir = roleTemplatesDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => ({ name: name.replace(/\.md$/, ''), path: join(dir, name) }));
  } catch {
    return [];
  }
}

// ── Skills (per-member Claude Code plugin) ───────────────────────────

/**
 * Each member's skills live in their own plugin directory, loaded per session
 * with `claude --plugin-dir`. This is what makes skills per-member: the shared
 * `<cwd>/.claude/skills` location cannot isolate, because every member runs
 * with the same working directory.
 */
export function writeMemberPluginManifest(member: TeamMember): void {
  const dir = join(memberPluginDir(member.id), '.claude-plugin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify(
      {
        name: `squad-${member.id}`,
        description: `Skills attached to ${member.name}${member.title ? ` (${member.title})` : ''}.`,
        version: '1.0.0',
      },
      null,
      2
    )
  );
}

export function listMemberSkills(id: string): string[] {
  const dir = memberSkillsDir(id);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'SKILL.md')))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Write a skill for a member. `body` is the markdown the model reads once it
 * invokes the skill; only `name` and `description` sit in context until then,
 * which is what keeps attached documentation cheap.
 */
export function writeMemberSkill(
  id: string,
  skill: { name: string; description: string; body: string }
): string {
  const slug = skill.name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`Invalid skill name "${skill.name}".`);

  const dir = join(memberSkillsDir(id), slug);
  mkdirSync(dir, { recursive: true });

  const frontmatter = ['---', `name: ${slug}`, `description: ${skill.description.replace(/\n/g, ' ').trim()}`, '---', ''].join('\n');
  writeFileSync(join(dir, 'SKILL.md'), `${frontmatter}\n${skill.body.trim()}\n`);

  return slug;
}

export function removeMemberSkill(id: string, skillName: string): void {
  try {
    rmSync(join(memberSkillsDir(id), skillName), { recursive: true, force: true });
  } catch {}
}

/** Whether this member has anything worth passing `--plugin-dir` for. */
export function memberHasSkills(member: TeamMember): boolean {
  return listMemberSkills(member.id).length > 0;
}

export { MODEL_ALIASES, PERMISSION_MODES, EFFORT_LEVELS, SLOT_IDS, UNSLOTTED_CAPABILITY_DEFAULTS };
