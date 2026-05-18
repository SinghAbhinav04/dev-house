import type { RunGoal, SecurityMode } from '@/lib/pipeline-control';

export type SupervisorIntent =
  | {
      action: 'start-run';
      runGoal?: RunGoal;
      securityMode?: SecurityMode;
      concept?: string;
    }
  | {
      action: 'set-stop-after-review';
      enabled: boolean;
    }
  | {
      action: 'resume-run';
    }
  | {
      action: 'stop-run';
    };

function normalize(message: string): string {
  return message.toLowerCase().trim().replace(/\s+/g, ' ');
}

function extractTrailingConcept(message: string): string {
  const colonIdx = message.indexOf(':');
  if (colonIdx !== -1) {
    return message.slice(colonIdx + 1).trim();
  }

  const forMatch = message.match(/\bfor\b([\s\S]+)$/i);
  return forMatch ? forMatch[1].trim() : '';
}

export function parseSupervisorIntent(message: string): SupervisorIntent | null {
  const normalized = normalize(message);
  if (!normalized) return null;

  if (
    normalized === 'stop after review' ||
    normalized === 'pause after review' ||
    normalized === 'hold after review' ||
    /\b(stop|pause|hold)\b.*\bafter review\b/.test(normalized)
  ) {
    return { action: 'set-stop-after-review', enabled: true };
  }

  if (
    normalized === 'keep running after review' ||
    normalized === 'clear stop after review' ||
    normalized === 'dont stop after review' ||
    normalized === "don't stop after review" ||
    /\b(keep running|continue)\b.*\bafter review\b/.test(normalized)
  ) {
    return { action: 'set-stop-after-review', enabled: false };
  }

  if (
    normalized === 'continue' ||
    normalized === 'continue build' ||
    normalized === 'continue the build' ||
    normalized === 'resume build' ||
    normalized === 'resume the build' ||
    normalized === 'send it to c' ||
    normalized === 'have c start' ||
    normalized === 'have coder start' ||
    normalized === 'resume stalled run' ||
    normalized === 'resume the stalled run' ||
    normalized === 'resume the stalled planner' ||
    normalized === 'resume planner' ||
    normalized === 'resume reviewer' ||
    normalized === 'resume the reviewer'
  ) {
    return { action: 'resume-run' };
  }

  if (
    normalized === 'stop' ||
    normalized === 'stop run' ||
    normalized === 'stop the run' ||
    normalized === 'stop build' ||
    normalized === 'stop the build' ||
    normalized === 'abort the build' ||
    normalized === 'abort build' ||
    normalized === 'cancel the build' ||
    normalized === 'kill the run'
  ) {
    return { action: 'stop-run' };
  }

  const startMatch = normalized.match(/^(start|begin|launch|run|kick off|kickoff|have)\b/);
  const planOnlyHint =
    /\b(plan only|just plan|only plan)\b/.test(normalized) ||
    /\b(planner|planning)\b/.test(normalized);
  const fullBuildHint =
    /\b(full build|build|team|squad|coder|coding)\b/.test(normalized) &&
    !planOnlyHint;

  if (normalized === 'plan only' || normalized === 'start planning' || normalized === 'kick off the planner') {
    return { action: 'start-run', runGoal: 'plan-only' };
  }

  if (startMatch && (planOnlyHint || fullBuildHint)) {
    const concept = extractTrailingConcept(message);
    const intent: SupervisorIntent = {
      action: 'start-run',
      runGoal: planOnlyHint ? 'plan-only' : 'full-build',
      ...(concept ? { concept } : {}),
      ...(/\bstrict\b/.test(normalized) ? { securityMode: 'strict' as const } : /\bfast\b/.test(normalized) ? { securityMode: 'fast' as const } : {}),
    };
    return intent;
  }

  return null;
}
