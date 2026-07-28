import { NextRequest, NextResponse } from 'next/server';

import {
  createMember,
  listMemberSkills,
  listRoleTemplates,
  readMemberRole,
  readRoster,
  removeMember,
  removeMemberSkill,
  seedRoleTemplates,
  updateMember,
  writeMemberRole,
  writeMemberSkill,
  writeRoster,
} from '@/lib/team/roster';
import { buildRunPlan } from '@/lib/team/slots';
import { readCurrentState } from '@/lib/state-source';
import { billableTokens, emptyUsage } from '@/lib/team/usage';
import { SLOT_IDS, type SlotId, type TeamMember } from '@/lib/team/types';

/**
 * Roster management for the /team page.
 *
 * GET returns the roster joined with what each member has actually spent and
 * what they are working on, because those are the numbers you look at when
 * deciding whether a member is on the right model.
 */

function readTeamView() {
  const roster = readRoster();
  const plan = buildRunPlan(roster);
  const state = readCurrentState('pipeline');

  const usage = state.usage as { byMember?: Record<string, ReturnType<typeof emptyUsage>> };
  const activeTurns = (state.runtime as { activeTurns?: Record<string, { currentTask?: string; status?: string; startedAt?: string }> })
    ?.activeTurns;

  return {
    roster,
    templates: listRoleTemplates().map((t) => t.name),
    plan: {
      ok: plan.ok,
      errors: plan.errors,
      notes: plan.notes,
      phases: plan.phases,
      runGoal: plan.runGoal,
      filled: Object.fromEntries(SLOT_IDS.map((slot) => [slot, plan.members[slot]?.id ?? null])),
    },
    members: roster.members.map((member) => {
      const spent = usage?.byMember?.[member.id] ?? emptyUsage();
      const turn = activeTurns?.[member.id];

      return {
        ...member,
        skills: listMemberSkills(member.id),
        role: readMemberRole(member.id),
        usage: spent,
        billable: billableTokens(spent),
        status: (state.agentStatus as Record<string, string>)?.[member.id] ?? 'idle',
        currentTask: turn?.currentTask ?? '',
        startedAt: turn?.startedAt ?? '',
        working: state.activeAgent === member.id,
      };
    }),
  };
}

export async function GET() {
  try {
    seedRoleTemplates();
    return NextResponse.json(readTeamView());
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const action = String(body.action || '');
  const id = typeof body.id === 'string' ? body.id : '';

  try {
    switch (action) {
      case 'create': {
        createMember(readRoster(), {
          id,
          name: body.name as string | undefined,
          title: body.title as string | undefined,
          slot: (body.slot as SlotId | null) ?? null,
          model: body.model as string | undefined,
          permissionMode: body.permissionMode as TeamMember['permissionMode'] | undefined,
          effort: body.effort as TeamMember['effort'] | undefined,
          role: body.role as string | undefined,
          color: body.color as string | undefined,
        });
        break;
      }

      case 'update': {
        const patch = body.patch as Partial<TeamMember> | undefined;
        if (!patch) return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 });
        updateMember(readRoster(), id, patch);
        break;
      }

      case 'remove': {
        removeMember(readRoster(), id, { deleteFiles: body.deleteFiles === true });
        break;
      }

      case 'role': {
        if (typeof body.role !== 'string') {
          return NextResponse.json({ error: 'A role body is required.' }, { status: 400 });
        }
        writeMemberRole(id, body.role);
        break;
      }

      case 'add-skill': {
        writeMemberSkill(id, {
          name: String(body.name || ''),
          description: String(body.description || ''),
          body: String(body.body || ''),
        });
        break;
      }

      case 'remove-skill': {
        removeMemberSkill(id, String(body.name || ''));
        break;
      }

      case 'slot': {
        // Switch a staffed slot off for the next run without unassigning anyone.
        const slot = body.slot as SlotId;
        if (!SLOT_IDS.includes(slot)) {
          return NextResponse.json({ error: `Unknown slot "${slot}".` }, { status: 400 });
        }
        const roster = readRoster();
        writeRoster({
          ...roster,
          workflow: {
            ...roster.workflow,
            slots: { ...roster.workflow.slots, [slot]: { ...roster.workflow.slots[slot], enabled: body.enabled === true } },
          },
        });
        break;
      }

      case 'workflow': {
        const roster = readRoster();
        writeRoster({
          ...roster,
          ...(typeof body.teamModel === 'string' ? { teamModel: body.teamModel } : {}),
          ...(typeof body.theme === 'string' ? { theme: body.theme } : {}),
          workflow: {
            ...roster.workflow,
            ...(body.runGoal === 'plan-only' || body.runGoal === 'full-build' ? { runGoal: body.runGoal } : {}),
          },
        });
        break;
      }

      default:
        return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
    }

    return NextResponse.json({ success: true, ...readTeamView() });
  } catch (error) {
    // Roster helpers throw with messages meant for the user (duplicate id,
    // invalid slug), so pass them through rather than flattening to a 500.
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
