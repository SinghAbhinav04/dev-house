/**
 * Where to float a "more below" arrow.
 *
 * Any pane that scrolls can hide what the user is looking for under its fold,
 * with nothing on screen saying so: the Start button sat below the fold of the
 * dashboard and the chat box a screen below the office. The arrow is the cue,
 * and one click takes that pane to its bottom.
 *
 * This file is the arithmetic only - which panes get an arrow and where it
 * goes - so it can be tested as plain functions. Finding the panes in the DOM
 * and drawing the buttons is src/components/shared/ScrollDownHints.tsx.
 */

export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** A rectangle in viewport coordinates, as getBoundingClientRect() gives it. */
export type Box = { left: number; top: number; width: number; height: number };

export type Viewport = { width: number; height: number };

export type HintCandidate = { id: string; box: Box; root: boolean };

export type HintPlacement = { id: string; left: number; top: number };

/** The arrow button is a circle this many pixels across. */
export const HINT_SIZE = 32;

/** Space between the arrow and the bottom edge of its pane. */
export const HINT_MARGIN = 10;

/** Space kept between two arrows that would otherwise touch. */
export const HINT_GAP = 6;

/**
 * How much has to be hidden below before an arrow is worth showing. Less than
 * a line or two is not something anyone goes looking for, and without the
 * slack a pane scrolled "to the bottom" at a fractional pixel would flicker.
 */
export const MIN_REMAINING = 24;

/** A pane shorter than this (an auto-growing text box, say) gets no arrow. */
export const MIN_PANE_HEIGHT = 96;

/** Pixels of content below what is visible. Never negative (overscroll). */
export function remainingBelow(metrics: ScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop);
}

export function wantsHint(metrics: ScrollMetrics): boolean {
  return metrics.clientHeight >= MIN_PANE_HEIGHT && remainingBelow(metrics) >= MIN_REMAINING;
}

/** The part of a box that is on screen, or null when none of it is. */
export function visibleBox(box: Box, viewport: Viewport): Box | null {
  const left = Math.max(box.left, 0);
  const top = Math.max(box.top, 0);
  const right = Math.min(box.left + box.width, viewport.width);
  const bottom = Math.min(box.top + box.height, viewport.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Where an arrow for this pane sits before any other arrow is considered:
 * centred, just above the bottom of whatever part of the pane is on screen.
 * Null when too little of the pane is visible to carry one.
 */
export function restingPlace(box: Box, viewport: Viewport): { left: number; top: number } | null {
  const visible = visibleBox(box, viewport);
  if (!visible) return null;
  if (visible.height < MIN_PANE_HEIGHT || visible.width < HINT_SIZE + 2 * HINT_MARGIN) return null;
  return {
    left: Math.round(visible.left + visible.width / 2 - HINT_SIZE / 2),
    top: Math.round(visible.top + visible.height - HINT_SIZE - HINT_MARGIN),
  };
}

function overlaps(a: { left: number; top: number }, b: { left: number; top: number }): boolean {
  const reach = HINT_SIZE + HINT_GAP;
  return Math.abs(a.left - b.left) < reach && Math.abs(a.top - b.top) < reach;
}

/**
 * Place one arrow per pane.
 *
 * The page's own arrow is placed first and keeps the bottom of the screen. An
 * arrow that would land on one already placed moves up until it is clear, and
 * is dropped if that takes it out of the top of its own pane: two buttons
 * stacked on each other are worse than one missing.
 */
export function placeHints(candidates: HintCandidate[], viewport: Viewport): HintPlacement[] {
  const ordered = [...candidates].sort((a, b) => Number(b.root) - Number(a.root));
  const placed: HintPlacement[] = [];

  for (const candidate of ordered) {
    const spot = restingPlace(candidate.box, viewport);
    if (!spot) continue;
    const ceiling = Math.max(candidate.box.top, 0) + HINT_MARGIN;

    while (spot.top >= ceiling && placed.some((other) => overlaps(spot, other))) {
      spot.top -= HINT_SIZE + HINT_GAP;
    }
    if (spot.top < ceiling) continue;

    placed.push({ id: candidate.id, left: spot.left, top: spot.top });
  }

  return placed;
}
