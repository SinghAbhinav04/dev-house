/**
 * The staging state: what exists before a run has a project folder.
 *
 * Shared by the chat route, which captures the concept, and the board route,
 * which captures the brief written on the studio whiteboard.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeJsonAtomic } from './atomic-write.ts';
import { EMPTY_RUNTIME } from './pipeline-runtime.ts';
import { STAGING_DIR } from './state-source.ts';
import { readRoster } from './team/roster.ts';
import type { Roster } from './team/types.ts';
import { emptyBreakdown } from './team/usage.ts';

export const STAGING_EVENTS_FILE = join(STAGING_DIR, 'pipeline-events.json');

/** A fresh idle status map keyed by the members currently on the team. */
export function idleStatusForRoster(roster: Roster): Record<string, string> {
  const status: Record<string, string> = {};
  for (const member of roster.members) {
    if (member.enabled) status[member.id] = 'idle';
  }
  return status;
}

export function freshState(projectDir: string): Record<string, unknown> {
  return {
    concept: '',
    projectDir,
    currentPhase: 'concept',
    securityMode: 'fast',
    activeAgent: '',
    agentStatus: idleStatusForRoster(readRoster()),
    sessions: {},
    buildComplete: false,
    usage: emptyBreakdown(),
    runtime: { ...EMPTY_RUNTIME },
    events: [],
    tickets: [],
    board: {},
  };
}

/** Read the staging state, creating it if this is the first thing said. */
export function getStagingState(): Record<string, unknown> {
  if (existsSync(STAGING_EVENTS_FILE)) {
    try {
      return JSON.parse(readFileSync(STAGING_EVENTS_FILE, 'utf8'));
    } catch {}
  }
  mkdirSync(STAGING_DIR, { recursive: true });
  const fresh = freshState('');
  writeJsonAtomic(STAGING_EVENTS_FILE, fresh);
  return fresh;
}
