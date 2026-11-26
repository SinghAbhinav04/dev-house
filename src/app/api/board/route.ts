import { NextRequest, NextResponse } from 'next/server';

import { writeJsonAtomic } from '@/lib/atomic-write';
import { findLatestProject, readPipelineState, startPipelineRun } from '@/lib/pipeline-control';
import { getStagingState, STAGING_EVENTS_FILE } from '@/lib/staging';
import { readCurrentState } from '@/lib/state-source';
import { encodeWorkflowDetail, normalizeBoard } from '@/lib/tickets';

const MAX_BRIEF = 20_000;

/** What the whiteboard currently shows. */
export async function GET() {
  const state = readCurrentState('pipeline');
  return NextResponse.json({ ok: true, board: normalizeBoard((state as Record<string, unknown>).board) });
}

/**
 * The user writes a brief on the whiteboard and, optionally, hands it to the
 * planner straight away.
 *
 * The brief is kept in the staging state next to the concept, so it travels
 * into the project folder with everything else when the run starts, and the
 * orchestrator puts it in front of the planner.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Body must be JSON' }, { status: 400 });
  }

  const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
  if (!brief) return NextResponse.json({ ok: false, error: 'Write something on the board first' }, { status: 400 });
  if (brief.length > MAX_BRIEF) {
    return NextResponse.json({ ok: false, error: `The brief is over ${MAX_BRIEF} characters` }, { status: 400 });
  }

  const active = findLatestProject();
  if (active && String(readPipelineState(active)?.pipelineStatus || '') === 'running') {
    return NextResponse.json(
      { ok: false, error: 'A run is in progress. Stop it before writing a new brief.' },
      { status: 409 },
    );
  }

  const now = new Date().toISOString();
  const state = getStagingState();
  const board = normalizeBoard(state.board);
  board.brief = { text: brief, updatedAt: now };
  // A new brief invalidates whatever plan was on the board from an earlier run.
  delete board.plan;
  state.board = board;

  // The first line names the project, the way a ticket title would.
  if (!String(state.concept || '').trim()) {
    const firstLine = brief.split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) || brief;
    state.concept = firstLine.slice(0, 200);
  }

  const events = Array.isArray(state.events) ? (state.events as Array<Record<string, unknown>>) : [];
  events.push({
    time: now,
    agent: 'user',
    phase: String(state.currentPhase || 'concept'),
    type: 'board_write',
    text: `You wrote the brief on the whiteboard (${brief.split('\n').length} lines)`,
    detail: encodeWorkflowDetail({ target: 'brief' }),
  });
  state.events = events;
  writeJsonAtomic(STAGING_EVENTS_FILE, state);

  if (body.start !== true) return NextResponse.json({ ok: true, started: false });

  const result = startPipelineRun({
    securityMode: body.securityMode === 'strict' ? 'strict' : 'fast',
    permissionMode:
      body.permissionMode === 'plan' || body.permissionMode === 'dangerously-skip-permissions'
        ? body.permissionMode
        : 'auto',
    runGoal: body.runGoal === 'plan-only' ? 'plan-only' : 'full-build',
    runFinalAudit: body.runFinalAudit === true,
    isolationPolicy: body.isolationPolicy === 'required' ? 'required' : 'ask',
  });

  if (!result.success) {
    return NextResponse.json({ ok: false, started: false, error: result.error || 'Could not start the run' }, { status: 409 });
  }
  return NextResponse.json({ ok: true, started: true, projectDir: result.projectDir });
}
