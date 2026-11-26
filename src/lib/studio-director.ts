/**
 * Turns the run's workflow events into stage directions for the 3D studio:
 * who walks where, who says what. The orchestrator already narrates every
 * hand-off as an event (src/lib/workflow.ts); this decides how each one looks
 * in the room.
 *
 *   board_write (planner)        planner walks to the whiteboard and writes
 *   call_member A → T            T walks over to A (at the board, or A's desk);
 *                                with `visit`, A walks to T instead (QA → dev)
 *   text A → T  ("DH-3 is yours") A says it
 *   text T → A  ("On it")         T says it and walks back to their desk
 *   qa_question / qa_answer      the tester and coder talk at the coder's desk;
 *                                the tester walks back once the answers are in
 *   ticket_created (bug)         the reporter says they filed it
 *
 * Pure, no three.js: tested in scripts/test-studio-director.mjs. The scene
 * asks for the next direction per member and plays it; anyone left standing
 * with nothing to do walks back to their desk on their own.
 */

import { decodeWorkflowDetail } from './tickets.ts';

export type StageSpot =
  | { kind: 'desk' }
  | { kind: 'board' }
  /** Next to another member, wherever they are. */
  | { kind: 'member'; memberId: string };

export interface StageDirection {
  actor: string;
  /** Where to be; omitted to say something where they stand. */
  spot?: StageSpot;
  say?: string;
  gesture?: 'write' | 'talk';
  /** Stay at least this long before the next direction. */
  holdMs: number;
  /**
   * Hold the line until this member is close by (or a few seconds pass): a
   * hand-off is said to the person, not to them walking over.
   */
  waitFor?: string;
}

/** How long a direction waits for `waitFor` before going ahead anyway. */
export const WAIT_FOR_MAX_MS = 8000;

export interface DirectorEvent {
  time: string;
  agent: string;
  phase?: string;
  type: string;
  text: string;
  detail?: string;
}

export interface DirectorState {
  /** Keys of events already staged, bounded. */
  seen: string[];
  queues: Record<string, StageDirection[]>;
}

/** A queue longer than this has fallen behind the run; older steps are dropped. */
export const MAX_QUEUE = 4;
const MAX_SEEN = 400;
export const SAY_MAX = 90;

export function createDirector(): DirectorState {
  return { seen: [], queues: {} };
}

function eventKey(event: DirectorEvent): string {
  return `${event.time}|${event.agent}|${event.type}|${event.text.slice(0, 40)}`;
}


export function clipSay(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SAY_MAX ? `${flat.slice(0, SAY_MAX - 1)}…` : flat;
}

/** What one event means on stage. `isMember` filters out 'user', 'system' and strangers. */
export function directionsFor(event: DirectorEvent, isMember: (id: string) => boolean): StageDirection[] {
  const actor = event.agent;
  if (!isMember(actor)) return [];
  const detail = decodeWorkflowDetail(event.detail);
  const target = typeof detail.target === 'string' ? detail.target : undefined;

  switch (event.type) {
    case 'board_write':
      return [{ actor, spot: { kind: 'board' }, say: clipSay(event.text), gesture: 'write', holdMs: 2500 }];

    case 'call_member':
      if (!target || !isMember(target)) return [{ actor, say: clipSay(event.text), holdMs: 1500 }];
      if (detail.visit) {
        return [{ actor, spot: { kind: 'member', memberId: target }, say: clipSay(event.text), holdMs: 1500 }];
      }
      return [
        { actor, say: clipSay(event.text), gesture: 'talk', holdMs: 1500 },
        { actor: target, spot: { kind: 'member', memberId: actor }, holdMs: 2500 },
      ];

    case 'text':
      // Workflow lines carry a target; free-form thinking does not, and is
      // left to the member's monitor rather than a bubble over their head.
      if (!target) return [];
      if (/^On it\b/.test(event.text)) {
        return [
          { actor, say: clipSay(event.text), gesture: 'talk', holdMs: 1800 },
          { actor, spot: { kind: 'desk' }, holdMs: 0 },
        ];
      }
      return [{ actor, say: clipSay(event.text), gesture: 'talk', holdMs: 2500, waitFor: target }];

    case 'qa_question':
    case 'qa_answer':
      return [
        {
          actor,
          say: clipSay(event.text),
          gesture: 'talk',
          holdMs: 3500,
          ...(target && isMember(target) ? { waitFor: target } : {}),
        },
      ];

    case 'ticket_created':
      if (/^DH-\d+ created: /.test(event.text) && event.phase && ['code-review', 'testing', 'security-audit'].includes(event.phase)) {
        return [{ actor, say: clipSay(`Filed ${event.text.replace(' created:', ' —')}`), holdMs: 2500 }];
      }
      return [];

    default:
      return [];
  }
}

/**
 * Feed the current event list. On the first call (an empty `seen`) history is
 * marked as seen without staging it — a page opened mid-run starts from now
 * rather than replaying an hour of hand-offs.
 */
export function ingest(
  state: DirectorState,
  events: readonly DirectorEvent[],
  isMember: (id: string) => boolean,
): DirectorState {
  const firstLook = state.seen.length === 0;
  const seen = new Set(state.seen);
  const queues: Record<string, StageDirection[]> = { ...state.queues };
  const fresh: string[] = [];

  for (const event of events) {
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(key);
    if (firstLook) continue;
    for (const direction of directionsFor(event, isMember)) {
      const before = queues[direction.actor] ?? [];
      // A newer board update replaces one still waiting: the planner shows
      // the latest line instead of replaying every save.
      const last = before.at(-1);
      const base = last?.gesture === 'write' && direction.gesture === 'write' ? before.slice(0, -1) : before;
      const queue = [...base, direction];
      // Fallen behind: keep the latest few, so the room shows what is
      // happening now rather than replaying the last five minutes.
      queues[direction.actor] = queue.length > MAX_QUEUE ? queue.slice(-MAX_QUEUE) : queue;
    }
  }

  if (fresh.length === 0 && !firstLook) return state;
  const allSeen = [...state.seen, ...fresh];
  return {
    seen: allSeen.length > MAX_SEEN ? allSeen.slice(-MAX_SEEN) : allSeen.length ? allSeen : ['∅'],
    queues,
  };
}

/** Take the next direction for a member, if any. */
export function nextDirection(state: DirectorState, actor: string): { state: DirectorState; direction?: StageDirection } {
  const queue = state.queues[actor];
  if (!queue || queue.length === 0) return { state };
  const [direction, ...rest] = queue;
  return { state: { ...state, queues: { ...state.queues, [actor]: rest } }, direction };
}
