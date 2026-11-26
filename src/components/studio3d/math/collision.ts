import type { AABB } from '../types';

/**
 * Fast, allocation-free 2D collision detection on the X-Z ground plane.
 */

export interface CircleCollider {
  x: number;
  z: number;
  radius: number;
}

export interface RoomBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * Clamps a circle collider within the room's perimeter walls.
 */
export function clampToRoom(
  x: number,
  z: number,
  radius: number,
  bounds: RoomBounds
): { x: number; z: number } {
  const minX = bounds.minX + radius;
  const maxX = bounds.maxX - radius;
  const minZ = bounds.minZ + radius;
  const maxZ = bounds.maxZ - radius;

  return {
    x: Math.max(minX, Math.min(maxX, x)),
    z: Math.max(minZ, Math.min(maxZ, z)),
  };
}

/**
 * Tests if a circle collider intersects with an AABB box and pushes it out along the minimum penetration axis.
 */
export function resolveCircleAABB(
  circleX: number,
  circleZ: number,
  radius: number,
  box: AABB
): { x: number; z: number; collided: boolean } {
  // Find closest point on AABB to circle center
  const closestX = Math.max(box.minX, Math.min(box.maxX, circleX));
  const closestZ = Math.max(box.minZ, Math.min(box.maxZ, circleZ));

  const deltaX = circleX - closestX;
  const deltaZ = circleZ - closestZ;
  const distSq = deltaX * deltaX + deltaZ * deltaZ;

  if (distSq >= radius * radius) {
    return { x: circleX, z: circleZ, collided: false };
  }

  // Inside or penetrating
  const dist = Math.sqrt(distSq);
  if (dist > 0.0001) {
    const penetration = radius - dist;
    const normalX = deltaX / dist;
    const normalZ = deltaZ / dist;
    return {
      x: circleX + normalX * penetration,
      z: circleZ + normalZ * penetration,
      collided: true,
    };
  }

  // Exactly centered inside box: push out along nearest edge
  const toMinX = Math.abs(circleX - box.minX);
  const toMaxX = Math.abs(circleX - box.maxX);
  const toMinZ = Math.abs(circleZ - box.minZ);
  const toMaxZ = Math.abs(circleZ - box.maxZ);

  const minEdge = Math.min(toMinX, toMaxX, toMinZ, toMaxZ);
  if (minEdge === toMinX) return { x: box.minX - radius, z: circleZ, collided: true };
  if (minEdge === toMaxX) return { x: box.maxX + radius, z: circleZ, collided: true };
  if (minEdge === toMinZ) return { x: circleX, z: box.minZ - radius, collided: true };
  return { x: circleX, z: box.maxZ + radius, collided: true };
}

/**
 * Resolves collisions against an array of obstacles, allowing smooth sliding along edges.
 */
export function resolveAllObstacles(
  startX: number,
  startZ: number,
  radius: number,
  obstacles: readonly AABB[],
  roomBounds: RoomBounds
): { x: number; z: number } {
  let curX = startX;
  let curZ = startZ;

  // Resolve against each obstacle sequentially (up to 2 passes for corner pinching)
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < obstacles.length; i++) {
      const res = resolveCircleAABB(curX, curZ, radius, obstacles[i]);
      if (res.collided) {
        curX = res.x;
        curZ = res.z;
      }
    }
  }

  // Final clamp against outer walls
  return clampToRoom(curX, curZ, radius, roomBounds);
}
