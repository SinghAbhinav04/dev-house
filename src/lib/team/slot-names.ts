/**
 * What to call whoever fills each seat.
 *
 * The page and the supervisor's own text used to say "B approved the plan" and
 * "Ask S to start": the letters of the fixed team this app began with. With a
 * roster the user defines, those letters appear nowhere else on screen, so a
 * sentence about a seat now names the member in it, or the seat's own label
 * when it is empty or no roster is at hand.
 *
 * No imports beyond the types, so the page, the API routes and the test suite
 * can all use it. Who fills a seat is the caller's to say: the server asks
 * `resolveSlot()`, the page reads the members it was sent.
 */

import { SLOT_IDS, SLOT_LABELS, type SlotId } from './types.ts';

export type SlotNames = Record<SlotId, string>;

/** Every seat by its label: what a sentence says when no roster is at hand. */
export const SEAT_LABELS: SlotNames = { ...SLOT_LABELS };

/**
 * A name for every seat, from whatever `nameOf` knows. A seat it has no name
 * for (empty, disabled, or a blank name) keeps its label, so no sentence is
 * ever left with a hole in it.
 */
export function slotNames(nameOf: (slot: SlotId) => string | null | undefined): SlotNames {
  const names: SlotNames = { ...SLOT_LABELS };
  for (const slot of SLOT_IDS) {
    const name = nameOf(slot)?.trim();
    if (name) names[slot] = name;
  }
  return names;
}
