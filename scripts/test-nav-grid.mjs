import assert from 'node:assert/strict';

import { buildNavGrid, findPath, isFree, lineClear, nearestFree } from '../src/components/studio3d/core/nav-grid.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const room = { minX: -5, maxX: 5, minZ: -5, maxZ: 5 };
// A wall across the middle with a gap at the right-hand end.
const wall = { minX: -5, maxX: 2, minZ: -0.2, maxZ: 0.2 };
const R = 0.25;

function walkIsClear(grid, from, path) {
  let prev = from;
  for (const p of path) {
    if (!lineClear(grid, prev, p)) return false;
    prev = p;
  }
  return true;
}

test('cells inside an obstacle (plus the walker radius) are blocked', () => {
  const grid = buildNavGrid(room, [wall], R);
  assert.equal(isFree(grid, 0, 0), false);
  assert.equal(isFree(grid, 0, 0.35), false, 'inflated by the radius');
  assert.equal(isFree(grid, 0, 1), true);
  assert.equal(isFree(grid, 4.9, 3), false, 'walls are blocked too');
});

test('a path goes round the wall, never through it', () => {
  const grid = buildNavGrid(room, [wall], R);
  const from = { x: -3, z: -2 };
  const to = { x: -3, z: 2 };
  const path = findPath(grid, from, to);
  assert.ok(path, 'route found');
  assert.ok(path.some((p) => p.x > 2), 'goes through the gap');
  assert.ok(walkIsClear(grid, nearestFree(grid, from.x, from.z), path), 'every leg is clear');
  const last = path.at(-1);
  assert.ok(Math.hypot(last.x - to.x, last.z - to.z) < 1e-6, 'ends at the goal');
});

test('a clear line is one straight leg', () => {
  const grid = buildNavGrid(room, [wall], R);
  const path = findPath(grid, { x: -3, z: 2 }, { x: 3, z: 3 });
  assert.equal(path.length, 1);
});

test('starting or ending inside furniture snaps to the nearest free spot', () => {
  const desk = { minX: -1, maxX: 1, minZ: 2, maxZ: 3 };
  const grid = buildNavGrid(room, [desk], R);
  const path = findPath(grid, { x: 0, z: 2.6 }, { x: 0, z: -3 });
  assert.ok(path && path.length > 0);
  const end = findPath(grid, { x: 0, z: -3 }, { x: 0, z: 2.5 });
  assert.ok(end && isFree(grid, end.at(-1).x, end.at(-1).z));
});

test('no route through a sealed room', () => {
  const sealed = [
    { minX: -5, maxX: 5, minZ: -0.2, maxZ: 0.2 },
  ];
  const grid = buildNavGrid(room, sealed, R);
  assert.equal(findPath(grid, { x: 0, z: -3 }, { x: 0, z: 3 }), null);
});

test('the real studio: coder desk to the whiteboard', () => {
  const studio = { minX: -8.85, maxX: 8.85, minZ: -7.35, maxZ: 7.35 };
  const obstacles = [
    { minX: -6.45, maxX: -4.75, minZ: -3.95, maxZ: -2.45 },
    { minX: -6.45, maxX: -4.75, minZ: -0.35, maxZ: 1.15 },
    { minX: -4.6, maxX: -1.8, minZ: -5.05, maxZ: -4.55 },
    { minX: -1.15, maxX: 1.15, minZ: 3.15, maxZ: 4.1 },
  ];
  const grid = buildNavGrid(studio, obstacles, R);
  const from = { x: -5.16, z: -2.76 };
  const to = { x: -3.2, z: -4.05 };
  const path = findPath(grid, from, to);
  assert.ok(path);
  assert.ok(walkIsClear(grid, nearestFree(grid, from.x, from.z), path));
});

console.log(`\n${passed} nav grid tests passed`);
