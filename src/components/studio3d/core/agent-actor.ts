import * as THREE from 'three';

import type { SlotId } from '@/lib/team/types';
import { WAIT_FOR_MAX_MS, type StageDirection } from '@/lib/studio-director';

import { findPath, isFree, nearestFree, type NavGrid, type NavPoint } from './nav-grid';
import type { StylizedCharacterResult } from './stylized-character';

/**
 * Plays the director's stage directions with the six teammates: stand up,
 * walk a path round the furniture, talk or write, and sit back down.
 *
 * One actor per desk. Every actor lives in world space (the stage group), so
 * standing up is just a change of pose and position, never a reparent.
 */

const WALK_SPEED = 1.7;
const ARRIVE_EPS = 0.06;
const PERSONAL_SPACE = 0.6;
const YIELD_MAX_S = 0.9;
/** Idle on their feet this long and they go back to their desk. */
const IDLE_RETURN_MS = 5000;
/** Longer at the whiteboard: the planner keeps writing between updates. */
const IDLE_AT_BOARD_MS = 20000;
const SAY_MIN_MS = 2500;
const NEAR_FOR_TALK = 2.4;

export interface ActorSeat {
  /** Where the character sits, world space. */
  x: number;
  z: number;
  facing: number;
}

type Goal =
  | { kind: 'desk' }
  | { kind: 'board'; spot: number }
  | { kind: 'member'; slot: SlotId; spot: NavPoint };

interface Actor {
  slot: SlotId;
  char: StylizedCharacterResult;
  seat: ActorSeat;
  x: number;
  z: number;
  facing: number;
  targetFacing: number;
  seated: boolean;
  path: NavPoint[];
  goal: Goal | null;
  arrived: boolean;
  /** The direction being played, and when it may give way to the next one. */
  current: StageDirection | null;
  holdUntil: number;
  waitStarted: number;
  idleSince: number;
  yieldFor: number;
  say: string | null;
  sayUntil: number;
  activity: string;
  memberName: string;
}

export interface StageView {
  slot: SlotId;
  x: number;
  z: number;
  seated: boolean;
  walking: boolean;
  say: string | null;
  activity: string;
}

export interface StudioStage {
  /** Advance one frame. `pull` hands over the next direction for a desk's member. */
  update(
    delta: number,
    nowMs: number,
    pull: (slot: SlotId) => StageDirection | undefined,
    isTyping: (slot: SlotId) => boolean,
    obstacleFor: { x: number; z: number },
  ): void;
  /** Push a circle (the player) out of anyone standing. */
  pushOut(x: number, z: number, radius: number): { x: number; z: number };
  view(slot: SlotId): StageView | undefined;
  setMemberName(slot: SlotId, name: string): void;
  /** Rebuild the walkable grid after the furniture changes. */
  setGrid(grid: NavGrid): void;
}

export interface StageOptions {
  grid: NavGrid;
  characters: Map<SlotId, { char: StylizedCharacterResult; seat: ActorSeat }>;
  /** Standing spots in front of the whiteboard, best first, and the way to face it. */
  boardSpots: NavPoint[];
  boardFacing: number;
  /** The desk a member sits at, from the run's seat map. */
  slotOf: (memberId: string) => SlotId | undefined;
}

function angleTo(fromX: number, fromZ: number, toX: number, toZ: number): number {
  return Math.atan2(toX - fromX, toZ - fromZ);
}

export function createStudioStage(options: StageOptions): StudioStage {
  let grid = options.grid;
  const actors = new Map<SlotId, Actor>();
  for (const [slot, { char, seat }] of options.characters) {
    char.setSeated(true);
    char.group.position.set(seat.x, 0, seat.z);
    char.setFacingAngle(seat.facing);
    actors.set(slot, {
      slot,
      char,
      seat,
      x: seat.x,
      z: seat.z,
      facing: seat.facing,
      targetFacing: seat.facing,
      seated: true,
      path: [],
      goal: null,
      arrived: true,
      current: null,
      holdUntil: 0,
      waitStarted: 0,
      idleSince: 0,
      yieldFor: 0,
      say: null,
      sayUntil: 0,
      activity: 'At their desk',
      memberName: slot,
    });
  }

  const taken = (except: Actor, p: NavPoint) => {
    for (const other of actors.values()) {
      if (other === except || other.seated) continue;
      const g = other.goal;
      const gx = g?.kind === 'board' ? options.boardSpots[g.spot].x : g?.kind === 'member' ? g.spot.x : other.x;
      const gz = g?.kind === 'board' ? options.boardSpots[g.spot].z : g?.kind === 'member' ? g.spot.z : other.z;
      if (Math.hypot(gx - p.x, gz - p.z) < PERSONAL_SPACE) return true;
    }
    return false;
  };

  /** Where `target` is, or is heading: the place to stand next to. */
  const anchorOf = (target: Actor): NavPoint => {
    if (target.goal?.kind === 'board') return options.boardSpots[target.goal.spot];
    if (target.goal?.kind === 'member') return target.goal.spot;
    if (target.goal?.kind === 'desk' || target.seated) return { x: target.seat.x, z: target.seat.z };
    return { x: target.x, z: target.z };
  };

  const walkTo = (actor: Actor, goal: Goal, dest: NavPoint, finalLeg?: NavPoint) => {
    const from = { x: actor.x, z: actor.z };
    const route = findPath(grid, from, dest) ?? [dest];
    // Getting up from a chair tucked into the desk: step out to the first
    // free spot before following the route.
    const out = nearestFree(grid, from.x, from.z);
    if (out && Math.hypot(out.x - from.x, out.z - from.z) > 0.02) route.unshift(out);
    if (finalLeg) route.push(finalLeg);
    if (actor.seated) {
      actor.seated = false;
      actor.char.setSeated(false);
    }
    actor.char.setGesture('none');
    actor.path = route;
    actor.goal = goal;
    actor.arrived = false;
  };

  const startDirection = (actor: Actor, d: StageDirection, nowMs: number) => {
    actor.current = d;
    actor.waitStarted = nowMs;
    actor.holdUntil = Infinity;
    const spot = d.spot;
    if (!spot) {
      actor.arrived = actor.path.length === 0;
      return;
    }
    if (spot.kind === 'desk') {
      const approach = nearestFree(grid, actor.seat.x, actor.seat.z) ?? { x: actor.seat.x, z: actor.seat.z };
      if (actor.seated) {
        actor.arrived = true;
        return;
      }
      actor.activity = 'Heading back to their desk';
      walkTo(actor, { kind: 'desk' }, approach, { x: actor.seat.x, z: actor.seat.z });
      return;
    }
    if (spot.kind === 'board') {
      if (actor.goal?.kind === 'board' && !actor.seated) {
        actor.arrived = actor.path.length === 0;
        return;
      }
      let index = options.boardSpots.findIndex((p) => !taken(actor, p));
      if (index < 0) index = options.boardSpots.length - 1;
      actor.activity = 'Walking to the whiteboard';
      walkTo(actor, { kind: 'board', spot: index }, options.boardSpots[index]);
      return;
    }
    const targetSlot = options.slotOf(spot.memberId);
    const target = targetSlot ? actors.get(targetSlot) : undefined;
    if (!target || target === actor) {
      actor.arrived = true;
      return;
    }
    // A ring round the person, nearest free and unclaimed point first.
    const anchor = anchorOf(target);
    const candidates: NavPoint[] = [];
    for (const radius of [1.0, 1.4]) {
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        candidates.push({ x: anchor.x + Math.sin(a) * radius, z: anchor.z + Math.cos(a) * radius });
      }
    }
    candidates.sort((a, b) => Math.hypot(a.x - actor.x, a.z - actor.z) - Math.hypot(b.x - actor.x, b.z - actor.z));
    const dest = candidates.find((p) => isFree(grid, p.x, p.z) && !taken(actor, p)) ?? nearestFree(grid, anchor.x, anchor.z) ?? anchor;
    actor.activity = `Going over to ${target.memberName}`;
    walkTo(actor, { kind: 'member', slot: target.slot, spot: dest }, dest);
  };

  /** Once at the spot: face the right way, sit, gesture, say the line. */
  const settle = (actor: Actor, nowMs: number) => {
    const d = actor.current;
    const goal = actor.goal;
    if (goal?.kind === 'desk') {
      actor.seated = true;
      actor.char.setSeated(true);
      actor.targetFacing = actor.seat.facing;
      actor.x = actor.seat.x;
      actor.z = actor.seat.z;
      actor.goal = null;
      actor.activity = 'At their desk';
    } else if (goal?.kind === 'board') {
      actor.targetFacing = options.boardFacing;
    } else if (goal?.kind === 'member') {
      const target = actors.get(goal.slot);
      if (target) actor.targetFacing = angleTo(actor.x, actor.z, target.x, target.z);
    }
    if (!d) return;
    if (d.waitFor) {
      const otherSlot = options.slotOf(d.waitFor);
      const other = otherSlot ? actors.get(otherSlot) : undefined;
      const near = other && Math.hypot(other.x - actor.x, other.z - actor.z) < NEAR_FOR_TALK && other.arrived;
      if (other && !near && nowMs - actor.waitStarted < WAIT_FOR_MAX_MS) return;
      if (other && !actor.seated) actor.targetFacing = angleTo(actor.x, actor.z, other.x, other.z);
    }
    if (!actor.seated) actor.char.setGesture(d.gesture ?? 'none');
    if (d.gesture === 'write') actor.activity = 'Writing the plan on the whiteboard';
    else if (d.say && d.waitFor) {
      const otherSlot = options.slotOf(d.waitFor);
      const other = otherSlot ? actors.get(otherSlot) : undefined;
      actor.activity = other ? `Talking with ${other.memberName}` : 'Talking';
    }
    if (d.say) {
      actor.say = d.say;
      actor.sayUntil = nowMs + Math.max(SAY_MIN_MS, d.holdMs + 1200);
    }
    actor.holdUntil = nowMs + d.holdMs;
  };

  const avoid = (actor: Actor, dirX: number, dirZ: number, player: { x: number; z: number }): boolean => {
    const ahead = (ox: number, oz: number) => {
      const dx = ox - actor.x;
      const dz = oz - actor.z;
      const dist = Math.hypot(dx, dz);
      return dist < PERSONAL_SPACE && dist > 1e-4 && (dx * dirX + dz * dirZ) / dist > 0.35;
    };
    if (ahead(player.x, player.z)) return true;
    for (const other of actors.values()) {
      if (other === actor || other.seated) continue;
      // Two walkers meeting head-on: the one with the later desk gives way.
      if (ahead(other.x, other.z) && (other.arrived || other.slot < actor.slot)) return true;
    }
    return false;
  };

  return {
    update(delta, nowMs, pull, isTyping, player) {
      const step = Math.min(delta, 0.1);
      for (const actor of actors.values()) {
        // Next direction once the last one has played out.
        if (!actor.current || (actor.arrived && nowMs >= actor.holdUntil)) {
          const next = pull(actor.slot);
          if (next) {
            startDirection(actor, next, nowMs);
          } else if (actor.current) {
            actor.current = null;
            actor.idleSince = nowMs;
            if (!actor.seated) actor.char.setGesture('none');
          } else if (!actor.seated && actor.arrived) {
            const idleFor = actor.goal?.kind === 'board' ? IDLE_AT_BOARD_MS : IDLE_RETURN_MS;
            if (nowMs - actor.idleSince > idleFor) {
              startDirection(actor, { actor: actor.slot, spot: { kind: 'desk' }, holdMs: 0 }, nowMs);
            }
          }
        }

        // Walk.
        let moving = false;
        if (actor.path.length > 0) {
          const wp = actor.path[0];
          const dx = wp.x - actor.x;
          const dz = wp.z - actor.z;
          const dist = Math.hypot(dx, dz);
          if (dist < ARRIVE_EPS) {
            actor.path.shift();
          } else {
            const dirX = dx / dist;
            const dirZ = dz / dist;
            actor.targetFacing = Math.atan2(dirX, dirZ);
            if (avoid(actor, dirX, dirZ, player) && actor.yieldFor < YIELD_MAX_S) {
              actor.yieldFor += step;
            } else {
              actor.yieldFor = 0;
              const move = Math.min(dist, WALK_SPEED * step);
              actor.x += dirX * move;
              actor.z += dirZ * move;
              moving = true;
            }
          }
          if (actor.path.length === 0) {
            actor.arrived = true;
            settle(actor, nowMs);
          }
        } else if (actor.current && actor.holdUntil === Infinity) {
          // Arrived (or never moved) but still waiting on the other person.
          actor.arrived = true;
          settle(actor, nowMs);
        }

        if (actor.say && nowMs > actor.sayUntil) actor.say = null;

        // Turn smoothly, shortest way round.
        let diff = actor.targetFacing - actor.facing;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        actor.facing += diff * Math.min(step * 10, 1);

        actor.char.group.position.set(actor.x, 0, actor.z);
        actor.char.setFacingAngle(actor.facing);
        actor.char.update(step, moving, actor.seated && isTyping(actor.slot));
      }
    },

    pushOut(x, z, radius) {
      let px = x;
      let pz = z;
      for (const actor of actors.values()) {
        if (actor.seated) continue;
        const dx = px - actor.x;
        const dz = pz - actor.z;
        const min = radius + 0.25;
        const dist = Math.hypot(dx, dz);
        if (dist < min && dist > 1e-4) {
          px = actor.x + (dx / dist) * min;
          pz = actor.z + (dz / dist) * min;
        }
      }
      return { x: px, z: pz };
    },

    view(slot) {
      const a = actors.get(slot);
      if (!a) return undefined;
      return {
        slot,
        x: a.x,
        z: a.z,
        seated: a.seated,
        walking: a.path.length > 0,
        say: a.say,
        activity: a.activity,
      };
    },

    setMemberName(slot, name) {
      const a = actors.get(slot);
      if (a) a.memberName = name;
    },

    setGrid(next) {
      grid = next;
    },
  };
}

/** World-space seat for a desk: the chair sits 0.62 m behind the desk centre. */
export function seatOf(deskGroup: THREE.Object3D): ActorSeat {
  deskGroup.updateWorldMatrix(true, false);
  const p = new THREE.Vector3(0, 0, 0.62).applyMatrix4(deskGroup.matrixWorld);
  const q = new THREE.Quaternion();
  deskGroup.getWorldQuaternion(q);
  const yaw = new THREE.Euler().setFromQuaternion(q, 'YXZ').y;
  return { x: p.x, z: p.z, facing: yaw + Math.PI };
}
