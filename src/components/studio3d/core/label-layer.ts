import * as THREE from 'three';

/**
 * Name tags and speech bubbles over the team, as one pooled DOM layer.
 *
 * One label per person: a small name tag, which becomes a bubble with the
 * name and the line while they are talking. Each frame the labels are placed
 * in priority order (talking first, nearest first) and a label that would
 * overlap one already placed — or the interaction prompt — is nudged up a
 * step at a time, and hidden if it still does not fit. Labels stay inside the
 * viewport and fade with distance. Moved with transforms only; a label's size
 * is measured again only when its text changes.
 */

export interface LabelItem {
  key: string;
  name: string;
  color: string;
  /** The line being said, or null for just the name. */
  say: string | null;
  /** Point above the head, world space. */
  x: number;
  y: number;
  z: number;
}

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Slot {
  el: HTMLDivElement;
  nameEl: HTMLSpanElement;
  sayEl: HTMLSpanElement;
  dot: HTMLSpanElement;
  text: string;
  w: number;
  h: number;
  visible: boolean;
}

const MARGIN = 16;
const NUDGE_STEPS = 4;
const GAP = 4;
const FADE_START = 14;
const FADE_END = 30;

const _proj = new THREE.Vector3();

function overlaps(a: ScreenRect, b: ScreenRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export interface LabelLayer {
  update(camera: THREE.Camera, width: number, height: number, items: readonly LabelItem[], reserved: readonly ScreenRect[]): void;
  hideAll(): void;
  dispose(): void;
}

export function createLabelLayer(container: HTMLElement): LabelLayer {
  const root = document.createElement('div');
  root.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:35;';
  container.appendChild(root);
  const slots = new Map<string, Slot>();
  const placed: ScreenRect[] = [];
  const order: { item: LabelItem; sx: number; sy: number; dist: number }[] = [];

  const slotFor = (key: string): Slot => {
    let slot = slots.get(key);
    if (slot) return slot;
    const el = document.createElement('div');
    el.style.cssText =
      'position:absolute;left:0;top:0;display:none;max-width:240px;border-radius:10px;' +
      'background:rgba(23,19,15,0.92);border:1px solid rgba(244,236,226,0.16);' +
      'box-shadow:0 6px 18px rgba(0,0,0,0.45);color:#f4ece2;font:600 11px/1.3 ui-monospace,monospace;' +
      'padding:3px 8px;will-change:transform,opacity;white-space:normal;';
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:5px;white-space:nowrap;';
    const dot = document.createElement('span');
    dot.style.cssText = 'width:7px;height:7px;border-radius:50%;flex:none;';
    const nameEl = document.createElement('span');
    head.append(dot, nameEl);
    const sayEl = document.createElement('span');
    sayEl.style.cssText = 'display:none;margin-top:2px;font-weight:400;font-family:ui-sans-serif,system-ui,sans-serif;font-size:12px;color:#e8dccd;';
    el.append(head, sayEl);
    root.appendChild(el);
    slot = { el, nameEl, sayEl, dot, text: '', w: 0, h: 0, visible: false };
    slots.set(key, slot);
    return slot;
  };

  const hide = (slot: Slot) => {
    if (!slot.visible) return;
    slot.visible = false;
    slot.el.style.display = 'none';
  };

  return {
    update(camera, width, height, items, reserved) {
      order.length = 0;
      for (const item of items) {
        _proj.set(item.x, item.y, item.z);
        const dist = _proj.distanceTo(camera.position);
        _proj.project(camera);
        if (_proj.z >= 1 || dist > FADE_END) continue;
        order.push({ item, sx: ((_proj.x + 1) / 2) * width, sy: ((1 - _proj.y) / 2) * height, dist });
      }
      // Talking beats a name tag; nearer beats farther.
      order.sort((a, b) => (a.item.say ? 0 : 1) - (b.item.say ? 0 : 1) || a.dist - b.dist);

      placed.length = 0;
      for (const r of reserved) placed.push(r);
      const shown = new Set<string>();

      for (const { item, sx, sy, dist } of order) {
        const slot = slotFor(item.key);
        const text = `${item.name}\u0000${item.say ?? ''}\u0000${item.color}`;
        if (text !== slot.text) {
          slot.text = text;
          slot.nameEl.textContent = item.name;
          slot.dot.style.background = item.color;
          slot.sayEl.textContent = item.say ?? '';
          slot.sayEl.style.display = item.say ? 'block' : 'none';
          slot.el.style.borderColor = item.say ? item.color : 'rgba(244,236,226,0.16)';
          slot.el.style.display = 'block';
          slot.visible = true;
          slot.w = slot.el.offsetWidth;
          slot.h = slot.el.offsetHeight;
        }
        const w = slot.w;
        const h = slot.h;
        let left = Math.min(Math.max(sx - w / 2, MARGIN), width - MARGIN - w);
        let top = Math.min(Math.max(sy - h, MARGIN), height - MARGIN - h);
        let fits = false;
        for (let step = 0; step <= NUDGE_STEPS; step++) {
          const rect = { left, top, right: left + w, bottom: top + h };
          if (!placed.some((p) => overlaps(p, rect))) {
            placed.push(rect);
            fits = true;
            break;
          }
          top -= h + GAP;
          if (top < MARGIN) {
            // No room above: try beside the anchor instead.
            top = Math.min(Math.max(sy - h, MARGIN), height - MARGIN - h);
            left = sx + (step % 2 === 0 ? 12 : -w - 12);
            left = Math.min(Math.max(left, MARGIN), width - MARGIN - w);
          }
        }
        if (!fits) {
          hide(slot);
          continue;
        }
        shown.add(item.key);
        if (!slot.visible) {
          slot.visible = true;
          slot.el.style.display = 'block';
        }
        const fade = dist <= FADE_START ? 1 : 1 - (dist - FADE_START) / (FADE_END - FADE_START);
        slot.el.style.opacity = String(item.say ? Math.max(fade, 0.75) : fade * 0.9);
        slot.el.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
      }
      for (const [key, slot] of slots) if (!shown.has(key)) hide(slot);
    },

    hideAll() {
      for (const slot of slots.values()) hide(slot);
    },

    dispose() {
      root.remove();
      slots.clear();
    },
  };
}
