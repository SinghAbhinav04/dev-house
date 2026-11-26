/**
 * Walkable grid for the studio floor and A* over it, so teammates walk round
 * desks and the whiteboard instead of through them.
 *
 * The grid is built from the same AABBs the player collides with, inflated by
 * the walker's radius, so a path that is clear here is clear for the body
 * walking it. Plain numbers, no three.js: scripts/test-nav-grid.mjs runs it.
 */

export interface NavBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface NavPoint {
  x: number;
  z: number;
}

export interface NavGrid {
  cell: number;
  minX: number;
  minZ: number;
  cols: number;
  rows: number;
  /** 1 = blocked, row-major (row = z, col = x). */
  blocked: Uint8Array;
}

export function buildNavGrid(bounds: NavBox, boxes: readonly NavBox[], radius: number, cell = 0.25): NavGrid {
  const cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cell));
  const rows = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / cell));
  const blocked = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const z = bounds.minZ + (r + 0.5) * cell;
    for (let c = 0; c < cols; c++) {
      const x = bounds.minX + (c + 0.5) * cell;
      // Walls count as obstacles too.
      let hit =
        x < bounds.minX + radius || x > bounds.maxX - radius || z < bounds.minZ + radius || z > bounds.maxZ - radius;
      for (let i = 0; !hit && i < boxes.length; i++) {
        const b = boxes[i];
        hit = x > b.minX - radius && x < b.maxX + radius && z > b.minZ - radius && z < b.maxZ + radius;
      }
      blocked[r * cols + c] = hit ? 1 : 0;
    }
  }
  return { cell, minX: bounds.minX, minZ: bounds.minZ, cols, rows, blocked };
}

function colOf(grid: NavGrid, x: number): number {
  return Math.floor((x - grid.minX) / grid.cell);
}
function rowOf(grid: NavGrid, z: number): number {
  return Math.floor((z - grid.minZ) / grid.cell);
}
function centre(grid: NavGrid, index: number): NavPoint {
  const c = index % grid.cols;
  const r = (index - c) / grid.cols;
  return { x: grid.minX + (c + 0.5) * grid.cell, z: grid.minZ + (r + 0.5) * grid.cell };
}
function cellFree(grid: NavGrid, c: number, r: number): boolean {
  return c >= 0 && r >= 0 && c < grid.cols && r < grid.rows && grid.blocked[r * grid.cols + c] === 0;
}

export function isFree(grid: NavGrid, x: number, z: number): boolean {
  return cellFree(grid, colOf(grid, x), rowOf(grid, z));
}

/** The free cell centre nearest to a point (breadth-first in rings), or null if the grid is full. */
export function nearestFree(grid: NavGrid, x: number, z: number): NavPoint | null {
  const c0 = colOf(grid, x);
  const r0 = rowOf(grid, z);
  if (cellFree(grid, c0, r0)) return { x, z };
  const maxRing = Math.max(grid.cols, grid.rows);
  for (let ring = 1; ring <= maxRing; ring++) {
    let best: NavPoint | null = null;
    let bestD = Infinity;
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
        const c = c0 + dc;
        const r = r0 + dr;
        if (!cellFree(grid, c, r)) continue;
        const p = centre(grid, r * grid.cols + c);
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/** True when a straight walk from a to b stays on free cells. */
export function lineClear(grid: NavGrid, a: NavPoint, b: NavPoint): boolean {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const steps = Math.ceil(Math.hypot(dx, dz) / (grid.cell * 0.4));
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    if (!isFree(grid, a.x + dx * t, a.z + dz * t)) return false;
  }
  return true;
}

/**
 * A* from `from` to `to`, 8-connected without cutting corners, then
 * string-pulled into as few straight legs as possible. Both ends are moved to
 * the nearest free cell first (someone getting up from a chair tucked into a
 * desk). Returns the waypoints after the start, ending at the goal, or null
 * when no route exists.
 */
export function findPath(grid: NavGrid, from: NavPoint, to: NavPoint): NavPoint[] | null {
  const start = nearestFree(grid, from.x, from.z);
  const goal = nearestFree(grid, to.x, to.z);
  if (!start || !goal) return null;
  const s = rowOf(grid, start.z) * grid.cols + colOf(grid, start.x);
  const g = rowOf(grid, goal.z) * grid.cols + colOf(grid, goal.x);
  if (s === g) return [goal];

  const n = grid.cols * grid.rows;
  const gScore = new Float32Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const gc = g % grid.cols;
  const gr = (g - gc) / grid.cols;
  const h = (i: number) => {
    const c = i % grid.cols;
    const r = (i - c) / grid.cols;
    const dx = Math.abs(c - gc);
    const dz = Math.abs(r - gr);
    return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
  };

  // Binary heap of [f, index].
  const heap: number[] = [];
  const push = (f: number, i: number) => {
    heap.push(f, i);
    let k = heap.length / 2 - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p * 2] <= heap[k * 2]) break;
      [heap[p * 2], heap[k * 2]] = [heap[k * 2], heap[p * 2]];
      [heap[p * 2 + 1], heap[k * 2 + 1]] = [heap[k * 2 + 1], heap[p * 2 + 1]];
      k = p;
    }
  };
  const pop = (): number => {
    const top = heap[1];
    const lastF = heap[heap.length - 2];
    const lastI = heap[heap.length - 1];
    heap.length -= 2;
    if (heap.length > 0) {
      heap[0] = lastF;
      heap[1] = lastI;
      let k = 0;
      const size = heap.length / 2;
      for (;;) {
        const l = k * 2 + 1;
        const r = l + 1;
        let m = k;
        if (l < size && heap[l * 2] < heap[m * 2]) m = l;
        if (r < size && heap[r * 2] < heap[m * 2]) m = r;
        if (m === k) break;
        [heap[m * 2], heap[k * 2]] = [heap[k * 2], heap[m * 2]];
        [heap[m * 2 + 1], heap[k * 2 + 1]] = [heap[k * 2 + 1], heap[m * 2 + 1]];
        k = m;
      }
    }
    return top;
  };

  gScore[s] = 0;
  push(h(s), s);
  let found = false;
  while (heap.length > 0) {
    const cur = pop();
    if (closed[cur]) continue;
    if (cur === g) {
      found = true;
      break;
    }
    closed[cur] = 1;
    const c = cur % grid.cols;
    const r = (cur - c) / grid.cols;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nc = c + dc;
        const nr = r + dr;
        if (!cellFree(grid, nc, nr)) continue;
        // No squeezing diagonally between two blocked cells.
        if (dr && dc && (!cellFree(grid, c + dc, r) || !cellFree(grid, c, r + dr))) continue;
        const ni = nr * grid.cols + nc;
        if (closed[ni]) continue;
        const tentative = gScore[cur] + (dr && dc ? Math.SQRT2 : 1);
        if (tentative < gScore[ni]) {
          gScore[ni] = tentative;
          came[ni] = cur;
          push(tentative + h(ni), ni);
        }
      }
    }
  }
  if (!found) return null;

  const cells: NavPoint[] = [];
  for (let i = g; i !== -1 && i !== s; i = came[i]) cells.push(centre(grid, i));
  cells.reverse();
  cells[cells.length - 1] = goal;

  // String-pull: from each anchor, jump to the farthest waypoint in sight.
  const out: NavPoint[] = [];
  let anchor: NavPoint = start;
  let i = 0;
  while (i < cells.length) {
    let j = cells.length - 1;
    while (j > i && !lineClear(grid, anchor, cells[j])) j--;
    out.push(cells[j]);
    anchor = cells[j];
    i = j + 1;
  }
  return out;
}
