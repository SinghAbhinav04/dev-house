import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { NextRequest, NextResponse } from 'next/server';

import { createRunner } from '../../../../pipeline/runner.ts';
import { readRoster } from '@/lib/team/roster';
import { buildRunPlan } from '@/lib/team/slots';
import { MAX_TEAM_SIZE, OFFICE_FULL_MESSAGE } from '@/lib/team/types';
import {
  TEAM_PROPOSAL_SCHEMA,
  applyProposal,
  normalizeProposal,
  proposalSystemPrompt,
} from '@/lib/team/proposal';

/**
 * Drafting a team from a description of the job.
 *
 * Two steps on purpose. `draft` runs a model and returns a proposal without
 * touching the roster; `apply` takes a proposal and creates the members. What
 * the model produced is therefore always seen before it exists, and `apply`
 * re-normalises rather than trusting the body it was handed — the review step
 * is a courtesy to the user, not the thing enforcing the rules.
 */

const runner = createRunner();
const DRAFT_DIR = join(homedir(), 'Builds', '.team-draft');
const DRAFT_TIMEOUT_MS = 180_000;

/** Runs one turn with no session, no resume and nothing to write to. */
function draftProposal(requirements: string, systemPrompt: string, model: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    mkdirSync(DRAFT_DIR, { recursive: true });

    const child = runner.spawn({
      prompt: requirements,
      projectDir: DRAFT_DIR,
      model,
      systemPrompt,
      jsonSchema: TEAM_PROPOSAL_SCHEMA as unknown as Record<string, unknown>,
      // Reading and writing files is not part of designing a team, and this
      // runs outside any project, so it gets the most restrictive shape the
      // runner offers rather than a member's capabilities.
      capabilities: {
        write: 'none',
        bash: 'none',
        web: false,
        network: 'none',
        projectMount: 'ro',
        preferIsolated: false,
      },
      permissionMode: 'plan',
    });

    let lastResult: Record<string, unknown> | null = null;
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('The drafting turn timed out.'));
    }, DRAFT_TIMEOUT_MS);

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === 'result') lastResult = event;
      } catch {
        // Non-JSON diagnostics are noise on this path.
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });

    child.on('error', (error: Error) => done(() => reject(error)));

    child.on('close', (code: number) => {
      done(() => {
        if (!lastResult) {
          reject(new Error(stderr.trim().split('\n').slice(-1)[0] || `The drafting turn exited with code ${code}.`));
          return;
        }
        resolve(lastResult);
      });
    });
  });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const action = String(body.action || 'draft');
  const roster = readRoster();

  if (action === 'draft') {
    const requirements = String(body.requirements || '').trim();
    if (requirements.length < 12) {
      return NextResponse.json(
        { error: 'Describe the job in a sentence or two so the team can be drafted for it.' },
        { status: 400 }
      );
    }

    // Checked before the model runs: a full office would have every proposed
    // member dropped in normalisation, and "nothing usable came back" is a
    // poor way to say "there is nowhere to put them".
    if (roster.members.length >= MAX_TEAM_SIZE) {
      return NextResponse.json({ error: OFFICE_FULL_MESSAGE }, { status: 400 });
    }

    try {
      const raw = await draftProposal(
        requirements,
        proposalSystemPrompt(roster),
        roster.teamModel || 'sonnet'
      );
      const { proposal, warnings } = normalizeProposal(raw, roster);

      if (proposal.members.length === 0) {
        return NextResponse.json(
          { error: 'Nothing usable came back. Try describing the job again, with a bit more detail.', warnings },
          { status: 422 }
        );
      }

      return NextResponse.json({ proposal, warnings });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  }

  if (action === 'apply') {
    // Re-normalised against the roster as it is now: the roster can have
    // changed since the draft was shown, and the client is not a trusted
    // source of member fields regardless.
    const { proposal, warnings } = normalizeProposal(body.proposal, roster);

    if (proposal.members.length === 0) {
      return NextResponse.json({ error: 'That proposal has nothing left to create.', warnings }, { status: 400 });
    }

    const { roster: next, created, failed } = applyProposal(roster, proposal);
    const plan = buildRunPlan(next);

    return NextResponse.json({
      created,
      failed,
      warnings,
      plan: { ok: plan.ok, errors: plan.errors, notes: plan.notes },
    });
  }

  return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
}
