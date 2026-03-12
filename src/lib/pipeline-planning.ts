import { join } from 'node:path';

export type PlanningStep = 'research' | 'write' | 'self-review' | 'done';

export interface PlanningEventLike {
  agent?: string;
  phase?: string;
  type?: string;
  text?: string;
}

const WRITE_INTENT_PATTERN =
  /\b(let me write the plan|writing plan\.md now|write the plan now|research is complete\b)/i;

export function detectPlanningStep(
  events: PlanningEventLike[],
  options: { planExists: boolean; plannerId: string }
): PlanningStep {
  const planningEvents = events.filter((event) => event.agent === options.plannerId && event.phase === 'planning');

  if (
    planningEvents.some(
      (event) => event.type === 'status' && String(event.text || '').trim() === 'Plan self-review complete'
    )
  ) {
    return 'done';
  }

  if (options.planExists) {
    return 'self-review';
  }

  if (
    planningEvents.some(
      (event) => event.type === 'text' && WRITE_INTENT_PATTERN.test(String(event.text || ''))
    )
  ) {
    return 'write';
  }

  return 'research';
}

export function hasPlanningWriteStarted(events: PlanningEventLike[], plannerId: string): boolean {
  return events.some(
    (event) =>
      event.agent === plannerId &&
      event.phase === 'planning' &&
      event.type === 'status' &&
      String(event.text || '').trim() === 'Writing plan.md...'
  );
}

export function extractPlanningResearchSummary(events: PlanningEventLike[], plannerId: string): string | null {
  const planningEvents = events.filter((event) => event.agent === plannerId && event.phase === 'planning');
  const cutoff = planningEvents.findIndex(
    (event) => event.type === 'status' && String(event.text || '').trim() === 'Writing plan.md...'
  );
  const searchable = cutoff === -1 ? planningEvents : planningEvents.slice(0, cutoff);

  for (let i = searchable.length - 1; i >= 0; i -= 1) {
    const event = searchable[i];
    if (event.type !== 'text') continue;
    const text = String(event.text || '').trim();
    if (text.length < 200) continue;
    if (WRITE_INTENT_PATTERN.test(text)) continue;
    return text;
  }

  return null;
}

export function buildPlanningResearchPrompt(phase0Context: string, concept: string): string {
  return [
    phase0Context
      ? phase0Context + 'Based on the conversation above, research the plan thoroughly before writing.'
      : `Build concept from the user: ${concept}`,
    '',
    'YOUR ONLY JOB RIGHT NOW: finish the research pass for plan.md.',
    '',
    'Follow these steps exactly:',
    '1. Read build-plan-template.md in this directory. Follow it step by step.',
    '2. Read checklist.md if it exists. Treat it as shared team doctrine.',
    '3. Research the concept — read docs, source code, web search, verify packages.',
    '4. Resolve every important unknown before the plan exists.',
    '5. When research is complete, say "Research complete" and STOP.',
    '',
    'RULES:',
    '- Do NOT write plan.md in this turn.',
    '- Do NOT create code files.',
    '- Use Read/Glob/Grep to inspect the workspace. Do NOT use Bash just to inspect files.',
    '- Do NOT use the Agent tool. Do NOT spawn sub-agents.',
    '- Verify from source. No guessing.',
  ].join('\n');
}

export function buildPlanningResearchResumePrompt(): string {
  return [
    'Your previous research turn stalled mid-task.',
    'Continue the research pass only.',
    'Do not restart the whole investigation from scratch unless absolutely necessary.',
    'Do not write plan.md yet.',
    'When research is complete, say "Research complete" and stop.',
  ].join(' ');
}

export function buildPlanningWritePrompt(projectDir: string, researchSummary?: string | null): string {
  return [
    'Research is already complete in this session.',
    researchSummary ? `Verified research summary from the completed research pass:\n\n${researchSummary}\n` : '',
    `Write the full build plan to ${join(projectDir, 'plan.md')} now.`,
    'Use the Write tool on plan.md in your next tool action. Do not narrate that you are about to write it; actually write it.',
    'The plan must contain complete, copy-pasteable code for every file the coder will need.',
    'Do not do more research unless a specific missing fact blocks the write.',
    'When the draft plan is written, say "Draft written" and stop.',
  ].filter(Boolean).join('\n\n');
}

export function buildPlanningWriteResumePrompt(projectDir: string, researchSummary?: string | null): string {
  return [
    'You stalled during the write step.',
    researchSummary ? `Use this already-verified research instead of redoing the investigation:\n\n${researchSummary}\n` : '',
    `Use the Write tool on ${join(projectDir, 'plan.md')} immediately in your next tool action.`,
    'Do not narrate. Do not re-summarize research. Write the plan now.',
    'If plan.md already exists, finish it instead of starting over.',
  ].filter(Boolean).join('\n\n');
}

export function buildPlanningSelfReviewPrompt(projectDir: string): string {
  return [
    `Read ${join(projectDir, 'plan.md')} once as a fresh self-review pass.`,
    'Patch any missing details or corrections directly in plan.md.',
    'Do not restart research unless a very specific missing fact forces it.',
    'When the plan is review-ready, say "Plan complete" and stop.',
  ].join(' ');
}

export function buildPlanningSelfReviewResumePrompt(projectDir: string): string {
  return [
    'You stalled during the self-review step.',
    `Read ${join(projectDir, 'plan.md')} once, patch any real gaps, and finish.`,
    'If the plan is already solid, say "Plan complete" and stop.',
  ].join(' ');
}
