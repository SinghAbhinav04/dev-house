import { spawn, execFileSync, execSync } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

import { readRoster } from './team/roster.ts';
import { resolveSlot } from './team/slots.ts';
import { writeTeamManifest } from './team/manifest.ts';

/** Event author for orchestrator-side supervisor narration. */
function supervisorEventAgent(): string {
  return resolveSlot(readRoster(), 'supervisor')?.id ?? 'supervisor';
}

export const BUILDUI_DIR = resolve(process.cwd(), 'pipeline');
export const BUILDS_DIR = join(homedir(), 'Builds');
export const STAGING_DIR = join(BUILDS_DIR, '.staging');

export type SecurityMode = 'fast' | 'strict';
export type PermissionMode = 'auto' | 'plan' | 'dangerously-skip-permissions';
export type RunGoal = 'full-build' | 'plan-only';
/** What a run does when a member that asked to be isolated cannot be. */
export type IsolationPolicy = 'ask' | 'required';
export type ResumeOutcome = 'continue-approved-plan' | 'resume-stalled-turn';

function readJson(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeJson(file: string, data: Record<string, unknown>) {
  writeFileSync(file, JSON.stringify(data, null, 2));
}

export function findLatestProject(): string | null {
  try {
    const dirs = readdirSync(BUILDS_DIR)
      .filter((name) => name !== '.staging' && name !== '.manual')
      .map((name) => join(BUILDS_DIR, name))
      .filter((projectDir) => {
        try {
          return statSync(projectDir).isDirectory() && statSync(join(projectDir, 'pipeline-events.json')).isFile();
        } catch {
          return false;
        }
      })
      .sort(
        (a, b) =>
          statSync(join(b, 'pipeline-events.json')).mtimeMs - statSync(join(a, 'pipeline-events.json')).mtimeMs
      );

    return dirs[0] || null;
  } catch {
    return null;
  }
}

export function readPipelineState(projectDir: string): Record<string, unknown> | null {
  return readJson(join(projectDir, 'pipeline-events.json'));
}

export function appendPipelineEvent(
  projectDir: string,
  event: { time?: string; agent: string; phase: string; type: string; text: string }
) {
  const file = join(projectDir, 'pipeline-events.json');
  const state = readJson(file);
  if (!state) return;
  const events = Array.isArray(state.events) ? state.events : [];
  events.push({
    time: event.time || new Date().toISOString(),
    agent: event.agent,
    phase: event.phase,
    type: event.type,
    text: event.text,
  });
  state.events = events;
  writeJson(file, state);
}

function spawnOrchestrator(projectDir: string, securityMode: SecurityMode, aSession?: string, permissionMode?: PermissionMode) {
  const orchestratorPath = join(BUILDUI_DIR, 'orchestrator.ts');
  const args = ['tsx', orchestratorPath, '--project-dir', projectDir];
  if (aSession) args.push('--a-session', aSession);

  const env: NodeJS.ProcessEnv = { ...process.env, PIPELINE_SECURITY_MODE: securityMode };
  if (permissionMode) env.PIPELINE_PERMISSION_MODE = permissionMode;

  const child = spawn('npx', args, {
    cwd: projectDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env,
  });

  child.stdout?.on('data', (data) => process.stdout.write(data));
  child.stderr?.on('data', (data) => process.stderr.write(data));
  child.unref();
}

export function startPipelineRun(options: {
  securityMode?: SecurityMode;
  permissionMode?: PermissionMode;
  runGoal?: RunGoal;
  runFinalAudit?: boolean;
  isolationPolicy?: IsolationPolicy;
}): { success: boolean; error?: string; projectDir?: string; securityMode?: SecurityMode; permissionMode?: PermissionMode; runGoal?: RunGoal; runFinalAudit?: boolean; isolationPolicy?: IsolationPolicy } {
  const securityMode = options.securityMode === 'strict' ? 'strict' : 'fast';
  const isolationPolicy: IsolationPolicy = options.isolationPolicy === 'required' ? 'required' : 'ask';
  const permissionMode: PermissionMode = options.permissionMode === 'plan' ? 'plan'
    : options.permissionMode === 'dangerously-skip-permissions' ? 'dangerously-skip-permissions'
    : 'auto';
  const runGoal = options.runGoal === 'plan-only' ? 'plan-only' : 'full-build';
  const runFinalAudit = options.runFinalAudit === true;

  const activeProject = findLatestProject();
  if (activeProject) {
    const activeState = readPipelineState(activeProject);
    const activeStatus = String(activeState?.pipelineStatus || '');
    if (activeStatus === 'running') {
      return { success: false, error: 'A pipeline run is already active' };
    }
  }

  const stagingEvents = join(STAGING_DIR, 'pipeline-events.json');
  const stagingState = readJson(stagingEvents);
  if (!stagingState) {
    return { success: false, error: 'No staging session found. Talk to S or A first.' };
  }

  const concept = String(stagingState.concept || '').trim();
  const sessions = (stagingState.sessions as Record<string, string> | undefined) || {};
  const aSession = sessions.A || '';

  if (!concept) {
    return { success: false, error: 'No build concept found yet.' };
  }

  const projectName = concept
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'new-build';

  const projectDir = join(BUILDS_DIR, projectName);
  mkdirSync(projectDir, { recursive: true });

  const templates = ['checklist-template.md', 'build-plan-template.md'];
  for (const template of templates) {
    const src = join(BUILDUI_DIR, template);
    const dst = join(projectDir, template.replace('-template', ''));
    if (existsSync(src) && !existsSync(dst)) copyFileSync(src, dst);
  }

  mkdirSync(join(projectDir, '.claude', 'hooks'), { recursive: true });
  const settingsSrc = join(BUILDUI_DIR, '.claude', 'settings.json');
  const hookSrc = join(BUILDUI_DIR, '.claude', 'hooks', 'approval-gate.sh');
  if (existsSync(settingsSrc)) copyFileSync(settingsSrc, join(projectDir, '.claude', 'settings.json'));
  if (existsSync(hookSrc)) {
    copyFileSync(hookSrc, join(projectDir, '.claude', 'hooks', 'approval-gate.sh'));
    try {
      execFileSync('chmod', ['+x', join(projectDir, '.claude', 'hooks', 'approval-gate.sh')]);
    } catch {}
  }

  // The hook resolves each member's capabilities from this manifest. It is
  // written here and never by an agent — .claude/ is unwritable from inside a
  // run, which is what stops a member editing its own permissions.
  writeTeamManifest(projectDir, readRoster());

  stagingState.projectDir = projectDir;
  stagingState.securityMode = securityMode;
  stagingState.permissionMode = permissionMode;
  stagingState.runGoal = runGoal;
  stagingState.runFinalAudit = runFinalAudit;
  stagingState.isolationPolicy = isolationPolicy;
  stagingState.stopAfterPhase = runGoal === 'plan-only' ? 'plan-review' : 'none';
  stagingState.pipelineStatus = 'running';
  stagingState.resumeAction = 'none';
  writeJson(join(projectDir, 'pipeline-events.json'), stagingState);

  try {
    rmSync(STAGING_DIR, { recursive: true, force: true });
  } catch {}

  spawnOrchestrator(projectDir, securityMode, aSession || undefined, permissionMode);

  return { success: true, projectDir, securityMode, permissionMode, runGoal, runFinalAudit, isolationPolicy };
}

export function setStopAfterReview(enabled: boolean, projectDir?: string): { success: boolean; error?: string; stopAfterPhase?: string; projectDir?: string } {
  const resolvedProjectDir = projectDir || findLatestProject();
  if (!resolvedProjectDir) {
    return { success: false, error: 'No pipeline project found' };
  }

  const file = join(resolvedProjectDir, 'pipeline-events.json');
  const state = readJson(file);
  if (!state) {
    return { success: false, error: 'No pipeline state found' };
  }

  state.stopAfterPhase = enabled ? 'plan-review' : 'none';
  const events = Array.isArray(state.events) ? state.events : [];
  events.push({
    time: new Date().toISOString(),
    agent: supervisorEventAgent(),
    phase: String(state.currentPhase || 'concept'),
    type: 'status',
    text: enabled ? 'Supervisor armed stop-after-review' : 'Supervisor cleared stop-after-review',
  });
  state.events = events;

  writeJson(file, state);
  return { success: true, projectDir: resolvedProjectDir, stopAfterPhase: String(state.stopAfterPhase || 'none') };
}

export function resumePipelineRun(projectDir?: string): { success: boolean; error?: string; projectDir?: string; action?: ResumeOutcome } {
  const resolvedProjectDir = projectDir || findLatestProject();
  if (!resolvedProjectDir) {
    return { success: false, error: 'No pipeline project found' };
  }

  const file = join(resolvedProjectDir, 'pipeline-events.json');
  const state = readJson(file);
  if (!state) {
    return { success: false, error: 'No pipeline state found' };
  }

  const currentPhase = String(state.currentPhase || 'concept');
  const pipelineStatus = String(state.pipelineStatus || (state.buildComplete ? 'complete' : 'idle'));
  const activeTurn = (state.runtime as { activeTurn?: { status?: string; agent?: string; phase?: string } } | undefined)?.activeTurn;
  const isStalled = activeTurn?.status === 'stalled';
  const canResumeSupportedTurn = isStalled && (
    activeTurn?.phase === 'planning' || activeTurn?.phase === 'plan-review'
  );
  const canContinueApprovedPlan = pipelineStatus === 'paused' && currentPhase === 'plan-review';

  if (!canResumeSupportedTurn && !canContinueApprovedPlan) {
    return { success: false, error: 'This run is not paused after review and does not have a resumable stalled turn' };
  }

  let action: ResumeOutcome;
  if (canContinueApprovedPlan) {
    state.runGoal = 'full-build';
    state.stopAfterPhase = 'none';
    state.resumeAction = 'continue-approved-plan';
    action = 'continue-approved-plan';
  } else {
    state.resumeAction = 'resume-stalled-turn';
    action = 'resume-stalled-turn';
  }

  const actionText = canContinueApprovedPlan
    ? 'Supervisor resumed the build from the approved plan'
    : 'Supervisor requested a manual resume of the stalled turn';

  const events = Array.isArray(state.events) ? state.events : [];
  events.push({
    time: new Date().toISOString(),
    agent: supervisorEventAgent(),
    phase: currentPhase,
    type: 'status',
    text: actionText,
  });
  state.events = events;
  writeJson(file, state);

  const resumePermission: PermissionMode = state.permissionMode === 'plan' ? 'plan'
    : state.permissionMode === 'dangerously-skip-permissions' ? 'dangerously-skip-permissions'
    : 'auto';
  spawnOrchestrator(resolvedProjectDir, state.securityMode === 'strict' ? 'strict' : 'fast', undefined, resumePermission);
  return { success: true, projectDir: resolvedProjectDir, action };
}

export type AuditAction = 'send-to-c' | 'dismiss' | 'deploy';

export function startAuditAction(
  action: AuditAction,
  findingId: string | undefined,
  projectDir?: string
): { success: boolean; error?: string; status?: number; projectDir?: string } {
  const resolvedProjectDir = projectDir || findLatestProject();
  if (!resolvedProjectDir) {
    return { success: false, error: 'No pipeline project found', status: 404 };
  }

  const file = join(resolvedProjectDir, 'pipeline-events.json');
  const state = readJson(file);
  if (!state) {
    return { success: false, error: 'No pipeline state found for that project', status: 404 };
  }

  if (state.pipelineStatus !== 'awaiting-audit-decision') {
    return {
      success: false,
      error: `Audit actions are only valid when pipelineStatus is 'awaiting-audit-decision' (current: ${String(state.pipelineStatus)})`,
      status: 409,
    };
  }

  if (state.auditActionInFlight === true) {
    return {
      success: false,
      error: 'An audit action is already in flight — wait for it to complete before starting another.',
      status: 409,
    };
  }

  const findings = Array.isArray(state.auditFindings) ? state.auditFindings as Array<Record<string, unknown>> : [];

  if (action === 'send-to-c' || action === 'dismiss') {
    if (!findingId) {
      return { success: false, error: `findingId is required for action '${action}'`, status: 400 };
    }
    const finding = findings.find((f) => typeof f?.id === 'string' && f.id === findingId);
    if (!finding) {
      return { success: false, error: `Unknown findingId: ${findingId}`, status: 400 };
    }
    const allowedStatuses = ['open', 'still-open'];
    if (typeof finding.status === 'string' && !allowedStatuses.includes(finding.status)) {
      return {
        success: false,
        error: `Finding ${findingId} has status '${finding.status}'; only 'open' or 'still-open' findings can be acted on`,
        status: 409,
      };
    }
  } else if (action === 'deploy') {
    // No findingId required. Deploy is always valid while awaiting-audit-decision.
  } else {
    return { success: false, error: `Unknown action: ${String(action)}`, status: 400 };
  }

  const resumeAction: 'audit-send-to-c' | 'audit-dismiss' | 'audit-deploy' =
    action === 'send-to-c' ? 'audit-send-to-c' : action === 'dismiss' ? 'audit-dismiss' : 'audit-deploy';

  state.resumeAction = resumeAction;
  state.resumeActionTarget = action === 'deploy' ? undefined : findingId;
  state.auditActionInFlight = true;
  writeJson(file, state);

  const permissionMode: PermissionMode =
    state.permissionMode === 'plan' ? 'plan'
    : state.permissionMode === 'dangerously-skip-permissions' ? 'dangerously-skip-permissions'
    : 'auto';
  spawnOrchestrator(
    resolvedProjectDir,
    state.securityMode === 'strict' ? 'strict' : 'fast',
    undefined,
    permissionMode
  );

  return { success: true, projectDir: resolvedProjectDir };
}

export function stopPipelineRun(projectDir?: string): { success: boolean; projectDir?: string } {
  try {
    execSync('pkill -f "tsx.*orchestrator\\.ts" 2>/dev/null || true', { encoding: 'utf8' });
    execSync('pkill -f "claude.*--output-format.*stream-json" 2>/dev/null || true', { encoding: 'utf8' });
  } catch {}

  const resolvedProjectDir = projectDir || findLatestProject() || undefined;
  if (resolvedProjectDir) {
    const file = join(resolvedProjectDir, 'pipeline-events.json');
    const state = readJson(file);
    if (state) {
      state.activeAgent = '';
      state.pipelineStatus = 'paused';
      if (state.agentStatus && typeof state.agentStatus === 'object') {
        for (const [agent, status] of Object.entries(state.agentStatus)) {
          if (status === 'active' || status === 'working') {
            (state.agentStatus as Record<string, string>)[agent] = 'idle';
          }
        }
      }
      if (state.runtime && typeof state.runtime === 'object') {
        (state.runtime as { activeTurn?: unknown }).activeTurn = null;
      }
      const events = Array.isArray(state.events) ? state.events : [];
      events.push({
        time: new Date().toISOString(),
        agent: 'system',
        phase: String(state.currentPhase || 'concept'),
        type: 'status',
        text: 'Pipeline stopped by user',
      });
      state.events = events;
      writeJson(file, state);
    }
  }

  return { success: true, projectDir: resolvedProjectDir };
}
