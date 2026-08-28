/**
 * Bridge between a roster member and the runner.
 *
 * Everything the CLI needs to know about *who* is running — model, effort,
 * permission mode, tool capabilities, role prompt, attached skills — is derived
 * here from the member record, so no caller has to know a member id.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { memberPluginDir, memberRolePath, listMemberSkills, resolveModel } from './roster.ts';
import type { MemberCapabilities, Roster, TeamMember } from './types.ts';
import type { CliId } from '../cli/types.ts';

/**
 * Capabilities every member gets, currently the shared-memory skill. Lives in
 * the repo rather than being copied per member so it cannot drift, and costs
 * only its name and description until a member actually invokes it.
 */
export function teamPluginDir(): string {
  return resolve(process.cwd(), 'templates', 'team-plugin');
}

export interface MemberSpawnOptions {
  model: string;
  effort: string;
  permissionMode: string;
  capabilities: MemberCapabilities;
  pipelineAgent: string;
  roleFile?: string;
  systemPrompt?: string;
  pluginDirs: string[];
  /** Which agent CLI runs this member's turns. */
  cli: CliId;
}

/**
 * The spawn options for one member.
 *
 * A member with no role.md on disk falls back to a one-line system prompt
 * rather than failing the run — the CLI requires one or the other.
 */
export function memberSpawnOptions(roster: Roster, member: TeamMember): MemberSpawnOptions {
  const roleFile = memberRolePath(member.id);
  const hasRole = existsSync(roleFile);

  const pluginDirs: string[] = [];

  // The shared team plugin first, then the member's own skills.
  const shared = teamPluginDir();
  if (existsSync(shared)) pluginDirs.push(shared);

  // Attach the member's plugin only when it actually contains a skill;
  // pointing the CLI at an empty plugin is noise.
  if (listMemberSkills(member.id).length > 0) pluginDirs.push(memberPluginDir(member.id));

  return {
    model: resolveModel(roster, member),
    effort: member.effort,
    permissionMode: member.permissionMode,
    capabilities: member.capabilities,
    pipelineAgent: member.id,
    cli: member.cli,
    ...(hasRole ? { roleFile } : { systemPrompt: fallbackSystemPrompt(member) }),
    pluginDirs,
  };
}

function fallbackSystemPrompt(member: TeamMember): string {
  const role = member.slot ? `the ${member.slot}` : 'a specialist';
  const speciality = member.title ? ` Your speciality is ${member.title}.` : '';
  return `You are ${member.name}, ${role} on this development team.${speciality}`;
}
