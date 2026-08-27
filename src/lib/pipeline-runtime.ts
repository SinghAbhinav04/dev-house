export type TurnStatus = 'running' | 'stalled';

export interface ActiveTurnState {
  agent: string;
  phase: string;
  status: TurnStatus;
  startedAt: string;
  lastEventAt: string;
  sessionId: string;
  promptSummary: string;
  /** Short human phrase for "what is this member doing right now". */
  currentTask: string;
  autoResumeCount: number;
  stalledAt?: string;
  stallReason?: string;
}

export interface PipelineRuntimeState {
  /**
   * The turn the pipeline is currently blocked on. One member runs at a time,
   * so this is the run's cursor — recovery and stall handling key off it.
   */
  activeTurn: ActiveTurnState | null;
  /**
   * Per-member view of the same thing, keyed by member id. Survives past the
   * end of a turn so the UI can show what each member last worked on, not just
   * whoever happens to be running this instant.
   */
  activeTurns: Record<string, ActiveTurnState>;
  /**
   * Memory entry ids each member has already been sent, keyed by member id.
   *
   * A resumed session replays its whole transcript, so injecting the full
   * memory block on every turn buried one copy per turn inside it — a coder
   * resumed six times carried six copies, all replayed on the seventh. This is
   * what lets a resumed turn send only what is new.
   *
   * Cleared for a member whenever they start a cold session, since a fresh
   * transcript has seen nothing.
   */
  memoryInjected: Record<string, string[]>;
}

export const EMPTY_RUNTIME: PipelineRuntimeState = {
  activeTurn: null,
  activeTurns: {},
  memoryInjected: {},
};

export const TURN_IDLE_TIMEOUT_MS = 300_000;
export const MAX_AUTO_RESUMES = 3;

/**
 * How many times a verdict loop may go round before the run pauses.
 *
 * Each round is two full turns on ever-growing resumed sessions, so a pair
 * that cannot agree burns tokens indefinitely with nothing to show for it.
 * Exhausting a cap is never an approval — the run pauses and hands the
 * disagreement back to the user, because "they stopped arguing" and "the work
 * is good" are not the same event.
 */
export const MAX_REVIEW_ROUNDS = 5;
export const MAX_CODE_REVIEW_ROUNDS = 5;
export const MAX_TEST_ROUNDS = 5;

/**
 * How many times a member may re-request the same Bash command in strict mode
 * before the run gives up on it. The grant is matched on the exact command
 * string, so a member that keeps drifting the whitespace would otherwise raise
 * an approval card forever, each one blocking the run for up to an hour.
 */
export const MAX_BASH_APPROVAL_RETRIES = 3;

export function summarizePrompt(prompt: string, maxLength: number = 140): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength - 3) + '...';
}

/**
 * What a member is doing, phrased for a human reading the team view.
 *
 * Derived from the slot and phase rather than passed in at every call site:
 * the pair already says what the work is, and deriving it keeps the phrase
 * consistent instead of depending on whichever prompt happened to be sent.
 */
export function describeCurrentTask(slot: string, phase: string): string {
  const byPhase: Record<string, string> = {
    concept: 'Talking through the idea',
    planning: 'Researching and writing the build plan',
    'plan-review': slot === 'reviewer' ? 'Poking holes in the plan' : 'Answering review questions',
    coding: 'Writing code from the approved plan',
    'code-review': slot === 'tester' ? 'Checking the code against the plan' : 'Applying review fixes',
    testing: slot === 'tester' ? 'Running the build and testing it' : 'Fixing failing tests',
    'security-audit': slot === 'auditor' ? 'Auditing for security issues' : 'Fixing an audit finding',
    deploy: 'Finishing up and handing back',
  };

  return byPhase[phase] || `Working (${phase})`;
}

/**
 * Read a runtime value from a state file, accepting the older shape that had
 * only a singular activeTurn.
 */
export function normalizeRuntime(raw: unknown): PipelineRuntimeState {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_RUNTIME, activeTurns: {}, memoryInjected: {} };
  const input = raw as Record<string, unknown>;

  const activeTurn = (input.activeTurn as ActiveTurnState | null) ?? null;
  const activeTurns =
    input.activeTurns && typeof input.activeTurns === 'object'
      ? (input.activeTurns as Record<string, ActiveTurnState>)
      : // Old state files carry only the cursor; seed the map from it so the
        // team view is not blank after an upgrade.
        activeTurn?.agent
        ? { [activeTurn.agent]: activeTurn }
        : {};

  // Absent in state files written before delta injection existed. An empty map
  // is the safe default: the next turn re-sends the block once, which costs a
  // few hundred tokens rather than risking a member never being told anything.
  const memoryInjected =
    input.memoryInjected && typeof input.memoryInjected === 'object'
      ? (input.memoryInjected as Record<string, string[]>)
      : {};

  return { activeTurn, activeTurns, memoryInjected };
}

/**
 * Which slots can have a stalled turn resumed automatically, and in which
 * phase. Keyed on the slot rather than a member id: the answer depends on the
 * job being done, not on who is doing it.
 */
export function canAutoResumeTurn(slot: string, phase: string): boolean {
  return (slot === 'planner' && (phase === 'planning' || phase === 'plan-review')) ||
    (slot === 'reviewer' && phase === 'plan-review') ||
    (slot === 'tester' && (phase === 'code-review' || phase === 'testing')) ||
    (slot === 'auditor' && phase === 'security-audit');
}

export function shouldMarkTurnStalled(lastEventAtMs: number, nowMs: number, idleTimeoutMs: number = TURN_IDLE_TIMEOUT_MS): boolean {
  return nowMs - lastEventAtMs >= idleTimeoutMs;
}

export function buildResumePrompt(slot: string, phase: string): string {
  if (slot === 'planner' && phase === 'planning') {
    return [
      'Your previous planning turn stalled mid-task.',
      'Continue from the last unfinished step only.',
      'Do not repeat research or reread everything from scratch unless absolutely necessary.',
      'If research is already complete, immediately write or finish plan.md, do one self-review pass, and stop.',
    ].join(' ');
  }

  if (slot === 'planner' && phase === 'plan-review') {
    return [
      'Your previous plan-review response stalled mid-task.',
      'Continue from the last unfinished answer only.',
      'Do not restart the whole review loop from scratch.',
      'Update plan.md only if the reviewer asked for a correction, then finish your response.',
    ].join(' ');
  }

  if (slot === 'reviewer' && phase === 'plan-review') {
    return [
      'Your previous review turn stalled mid-task.',
      'Do not restart the review or summarize the plan.',
      'Output your verdict immediately: {"status": "approved"} or {"status": "questions", "questions": ["..."]}.',
      'Nothing else.',
    ].join(' ');
  }

  if (slot === 'tester') {
    return [
      'Your previous turn stalled mid-task.',
      'Do not re-read all files or restart from scratch.',
      'If a build or test command failed due to missing SDKs, simulators, or platform tools, report that as a finding — do not try to install or download them.',
      'Output your verdict immediately.',
    ].join(' ');
  }

  if (slot === 'auditor' && phase === 'security-audit') {
    return [
      'Your previous security audit turn stalled mid-task.',
      'Do not restart the audit or re-read every file from scratch.',
      'Output your verdict immediately as JSON: {"status": "approved"} or {"status": "issues", "issues": ["[file/line] type: description and fix"]}.',
      'Nothing else.',
    ].join(' ');
  }

  return [
    'Your previous turn stalled mid-task.',
    'Continue from the last unfinished step only.',
    'Do not repeat completed work unless absolutely necessary.',
  ].join(' ');
}
