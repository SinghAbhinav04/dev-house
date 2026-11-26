'use client';

import { useEffect, useRef, useState } from 'react';

import {
  HINT_SIZE,
  MIN_PANE_HEIGHT,
  MIN_REMAINING,
  placeHints,
  restingPlace,
  wantsHint,
  type HintCandidate,
  type HintPlacement,
} from '@/lib/scroll-hints';

/**
 * A floating down-arrow at the bottom of every pane that has more below.
 *
 * Mounted once, in the root layout, and it finds the panes itself: the page,
 * and any element whose content overflows a scrolling box. So a pane added
 * later gets its arrow without anyone remembering to give it one, which is
 * the same reason the request guard lives in one proxy rather than in each
 * route. Clicking an arrow scrolls that pane to its bottom.
 *
 * The arrows are drawn in one fixed layer above everything, positioned from
 * each pane's rectangle, so nothing has to be wrapped or restyled. Which
 * panes get one and where is src/lib/scroll-hints.ts.
 */

/** Marks the layer the arrows are drawn in, so they are never mistaken for what is under them. */
const LAYER_SELECTOR = '[data-scroll-hints]';

/** How often to look again when nothing has scrolled or resized (a feed growing, a panel opening). */
const RESCAN_MS = 1000;

/** The topmost thing at a point that is not one of our own arrows. */
function topElementAt(x: number, y: number): Element | null {
  for (const element of document.elementsFromPoint(x, y)) {
    if (!element.closest(LAYER_SELECTOR)) return element;
  }
  return null;
}

/** Whether something drawn over the page (a modal, its backdrop) covers this element. */
function isInOverlay(element: Element | null): boolean {
  for (let node = element; node && node !== document.body; node = node.parentElement) {
    if (getComputedStyle(node).position === 'fixed') return true;
  }
  return false;
}

export function ScrollDownHints() {
  const [hints, setHints] = useState<HintPlacement[]>([]);
  // What each arrow scrolls. null stands for the page itself.
  const targets = useRef(new Map<string, HTMLElement | null>());
  const ids = useRef(new WeakMap<HTMLElement, string>());
  const nextId = useRef(1);

  useEffect(() => {
    const idFor = (element: HTMLElement): string => {
      let id = ids.current.get(element);
      if (!id) {
        id = `pane-${nextId.current++}`;
        ids.current.set(element, id);
      }
      return id;
    };

    const scan = () => {
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const candidates: HintCandidate[] = [];
      const found = new Map<string, HTMLElement | null>();

      // The page.
      const page = document.documentElement;
      const pageMetrics = { scrollTop: window.scrollY, scrollHeight: page.scrollHeight, clientHeight: viewport.height };
      if (wantsHint(pageMetrics)) {
        const box = { left: 0, top: 0, width: viewport.width, height: viewport.height };
        const spot = restingPlace(box, viewport);
        if (spot && !isInOverlay(topElementAt(spot.left + HINT_SIZE / 2, spot.top + HINT_SIZE / 2))) {
          candidates.push({ id: 'page', box, root: true });
          found.set('page', null);
        }
      }

      // Every pane inside it. The two size tests come first because they are
      // cheap and rule out nearly everything; the computed style is asked for
      // only of what is left.
      for (const element of document.body.querySelectorAll<HTMLElement>('*')) {
        if (element.clientHeight < MIN_PANE_HEIGHT) continue;
        if (element.scrollHeight - element.clientHeight < MIN_REMAINING) continue;
        if (element.tagName === 'TEXTAREA') continue;
        if (!wantsHint(element)) continue;
        const overflowY = getComputedStyle(element).overflowY;
        if (overflowY !== 'auto' && overflowY !== 'scroll') continue;

        const rect = element.getBoundingClientRect();
        const box = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        const spot = restingPlace(box, viewport);
        if (!spot) continue;
        // Something else is drawn over the spot (a modal over a panel): no arrow through it.
        const top = topElementAt(spot.left + HINT_SIZE / 2, spot.top + HINT_SIZE / 2);
        if (!top || !(top === element || element.contains(top))) continue;

        const id = idFor(element);
        candidates.push({ id, box, root: false });
        found.set(id, element);
      }

      targets.current = found;
      const next = placeHints(candidates, viewport);
      setHints((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    };

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        scan();
      });
    };

    schedule();
    // Scroll events do not bubble; capturing on the document hears every pane's.
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    // A click is what opens a modal over a pane, or a panel beside one: look again at once
    // rather than leave an arrow floating over the dialog until the next tick.
    document.addEventListener('click', schedule, { capture: true });
    const timer = window.setInterval(schedule, RESCAN_MS);

    return () => {
      document.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      document.removeEventListener('click', schedule, { capture: true });
      window.clearInterval(timer);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  const scrollToBottom = (id: string) => {
    const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    const target = targets.current.get(id);
    if (target) target.scrollTo({ top: target.scrollHeight, behavior });
    else if (target === null) window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
  };

  return (
    <div data-scroll-hints="" className="pointer-events-none fixed inset-0 z-[70]">
      {hints.map((hint) => (
        <button
          key={hint.id}
          type="button"
          aria-label="Scroll to bottom"
          title="More below - scroll to bottom"
          onClick={() => scrollToBottom(hint.id)}
          style={{ left: hint.left, top: hint.top, width: HINT_SIZE, height: HINT_SIZE }}
          className="pointer-events-auto absolute flex items-center justify-center rounded-full border border-line-strong bg-surface-overlay text-ink shadow-[0_4px_14px_rgba(0,0,0,0.45)] transition-colors hover:border-signal-ok hover:text-signal-ok"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />
          </svg>
        </button>
      ))}
    </div>
  );
}
