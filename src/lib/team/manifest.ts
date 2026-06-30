/**
 * The capability manifest the security hook reads.
 *
 * The hook used to identify agents with the regex `^[ABCDES]$` and branch on
 * hardcoded `case` blocks. With a user-authored roster there is no fixed set of
 * letters, so the server writes this manifest into the project's `.claude/`
 * directory at run start and the hook looks members up in it.
 *
 * The manifest is *data the hook consults*, not a grant of authority. The hook
 * keeps its own unconditional clamps — `.claude/` is unwritable, non-supervisor
 * members are jailed to the project root, the Agent tool is blocked, and any
 * tool that falls through is denied. A member absent from the manifest is
 * denied outright, so deny-by-default survives.
 *
 * Only the server ever writes this file; no member has write access to
 * `.claude/`, which is what stops an agent from editing its own permissions.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { artifactOwners, activeMembers } from './slots.ts';
import type { BashLevel, Roster, TeamMember, WriteLevel } from './types.ts';

export const TEAM_MANIFEST_FILE = 'team-manifest.json';

export interface ManifestMemberEntry {
  slot: string;
  write: WriteLevel;
  bash: BashLevel;
  web: boolean;
  /** Phases during which this member may not write at all. */
  denyPhases: string[];
}

export interface TeamManifest {
  version: 1;
  /** filename → member id that exclusively owns it. */
  artifacts: Record<string, string>;
  members: Record<string, ManifestMemberEntry>;
}

export function teamManifestPath(projectDir: string): string {
  return join(projectDir, '.claude', TEAM_MANIFEST_FILE);
}

function manifestEntry(member: TeamMember): ManifestMemberEntry {
  return {
    slot: member.slot ?? '',
    write: member.capabilities.write,
    bash: member.capabilities.bash,
    web: member.capabilities.web,
    // The planner writes plan.md, but not before the concept has been captured
    // and a real project exists — the original hook special-cased agent A this
    // way and the rule is worth keeping.
    denyPhases: member.slot === 'planner' ? ['concept'] : [],
  };
}

export function buildTeamManifest(roster: Roster): TeamManifest {
  const members: Record<string, ManifestMemberEntry> = {};

  for (const member of activeMembers(roster)) {
    members[member.id] = manifestEntry(member);
  }

  // Members with no slot still take part in direct chat, so they need an entry
  // or the hook would deny them every tool.
  for (const member of roster.members) {
    if (!member.enabled || members[member.id]) continue;
    members[member.id] = manifestEntry(member);
  }

  return {
    version: 1,
    artifacts: artifactOwners(roster),
    members,
  };
}

export function writeTeamManifest(projectDir: string, roster: Roster): TeamManifest {
  const manifest = buildTeamManifest(roster);
  mkdirSync(join(projectDir, '.claude'), { recursive: true });
  writeFileSync(teamManifestPath(projectDir), JSON.stringify(manifest, null, 2));
  return manifest;
}
