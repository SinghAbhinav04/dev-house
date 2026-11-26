import { SEAT_LABELS, type SlotNames } from './team/slot-names.ts';

function normalize(message: string): string {
  return message.trim().toLowerCase();
}

export function looksLikeStatusQuestion(message: string): boolean {
  const normalized = normalize(message);
  if (!normalized) return false;

  if (normalized.includes('?')) return true;

  return /^(what|whats|what's|how|should|can|could|are|is|do|does|did|where|why|when)\b/.test(normalized);
}

export function buildSupervisorConceptReply(concept: string, updated: boolean, names: SlotNames = SEAT_LABELS): string {
  const summary = concept.trim() || '(no concept captured yet)';

  if (updated) {
    return [
      `Concept captured: ${summary}`,
      'Tell me `start planning`, `start plan only`, or `start full build` when you want me to hand it to the team.',
      `You can also message ${names.planner} directly if you want to shape the plan yourself before the team runs.`,
    ].join('\n');
  }

  return [
    `No run is active yet. Current concept: ${summary}`,
    'Tell me `start planning`, `start plan only`, or `start full build` when you want me to kick off the team.',
    `You can still talk directly to ${names.planner}, ${names.reviewer}, ${names.coder}, or ${names.tester} whenever you want.`,
  ].join('\n');
}
