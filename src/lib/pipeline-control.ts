import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

import { readRoster } from './team/roster.ts';
import { resolveSlot } from './team/slots.ts';
import { writeTeamManifest } from './team/manifest.ts';
import { writeJsonAtomic } from './atomic-write.ts';
import { installGates } from './cli/gates.ts';
import { findCli } from './cli/registry.ts';
import type { AgentCli } from './cli/types.ts';

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
  writeJsonAtomic(file, data);
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

// ── What "stop" is allowed to reach ──────────────────────────────────
//
// Stopping a run used to be two `pkill -f` patterns, one of them
// `claude.*--output-format.*stream-json`. That matches every headless Claude
// Code process on the machine: other projects, scheduled jobs, SDK-driven
// sessions, anything. Pressing Stop in this app killed work that had nothing
// to do with it.
//
// So stop now signals only what this app started, and it knows what that is
// because it wrote it down:
//
//   - the orchestrator is spawned detached, which makes it the leader of its
//     own process group, and every member turn it spawns inherits that group.
//     The group id is recorded at spawn and the whole group is signalled.
//   - direct chat turns are children of this server process, tracked in memory.

/**
 * Lives in `.claude/` because no member can write there. In the project root
 * a coder could point it at any process group the user owns and have the next
 * Stop signal that instead.
 */
export const ORCHESTRATOR_PID_FILE = 'orchestrator.pid';

export function orchestratorPidPath(projectDir: string): string {
  return join(projectDir, '.claude', ORCHESTRATOR_PID_FILE);
}

export function recordOrchestratorPid(projectDir: string, pid: number): void {
  mkdirSync(join(projectDir, '.claude'), { recursive: true });
  writeFileSync(orchestratorPidPath(projectDir), `${pid}\n`);
}

export function readOrchestratorPid(projectDir: string): number | null {
  const file = orchestratorPidPath(projectDir);
  if (!existsSync(file)) return null;

  const pid = Number(readFileSync(file, 'utf8').trim());
  // Never 0 or 1 or anything negative: as a group id those mean "my own
  // group" and "everything I am allowed to signal".
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

/**
 * Whether a process group is still an orchestrator.
 *
 * A recorded id outlives the run it belonged to, and ids are reused. Signalling
 * a stale one would hit whatever unrelated group inherited the number, so the
 * group has to still contain the thing we started before it is touched.
 *
 * `pgrep -g` rather than reading the whole process table out of `ps`: the
 * table on a busy machine runs past execFileSync's output buffer, and the
 * question only ever concerns one group.
 */
export function isOrchestratorGroup(pgid: number): boolean {
  try {
    execFileSync('pgrep', ['-g', String(pgid), '-f', 'orchestrator\\.ts'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    // 1 is pgrep saying nothing matched. Anything else is pgrep itself
    // failing, which must not be read as "the run has already gone".
    if ((err as { status?: number }).status === 1) return false;
    throw err;
  }
}

/** Signal the orchestrator this project recorded, and only that. */
/**
 * Send SIGTERM to a whole process group: the orchestrator and every member
 * turn it has in flight. Returns whether there was anything left to signal.
 *
 * The group can exit between being found and being signalled - a run that
 * finishes as Stop is pressed does exactly that - and the kill then fails with
 * ESRCH. That is the outcome Stop wanted, so it is not an error.
 */
export function signalOrchestratorGroup(pgid: number): boolean {
  try {
    // Negative: the group, not the one process.
    process.kill(-pgid, 'SIGTERM');
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw err;
  }
}

function describeFailure(err: unknown): string {
  const failure = err as NodeJS.ErrnoException & { path?: string };
  if (failure.code === 'ENOENT' && failure.path === 'pgrep') return 'pgrep is not installed';
  return failure.message || String(err);
}

/**
 * Signal the orchestrator this project recorded, and only that.
 *
 * Never throws. Returns a sentence describing what went wrong when the
 * orchestrator may still be running, and null otherwise. Stop has to finish
 * pausing the run whatever happens here: a Stop that threw half-way left the
 * run marked as running with nothing to press.
 */
function stopOrchestrator(projectDir: string): string | null {
  const pgid = readOrchestratorPid(projectDir);
  if (pgid === null) {
    console.warn(`*** No orchestrator is recorded for ${projectDir}, so nothing was signalled.`);
    return null;
  }

  let running: boolean;
  try {
    running = isOrchestratorGroup(pgid);
  } catch (err) {
    // The record is kept, so a later Stop can try again once the cause is fixed.
    return `Could not check whether the orchestrator is still running (${describeFailure(err)}), so it was not signalled. It may still be running as process group ${pgid}.`;
  }

  if (running) {
    try {
      signalOrchestratorGroup(pgid);
    } catch (err) {
      return `Could not signal the orchestrator (${describeFailure(err)}). It may still be running as process group ${pgid}.`;
    }
  } else {
    console.warn(`*** Process group ${pgid} recorded for ${projectDir} is no longer an orchestrator; not signalled.`);
  }

  rmSync(orchestratorPidPath(projectDir), { force: true });
  return null;
}

type DirectTurn = Pick<ChildProcess, 'kill' | 'on'>;

/**
 * On globalThis rather than at module scope: each route is bundled separately,
 * so the chat route and the stop route would otherwise each get their own
 * empty set.
 */
const DIRECT_TURNS = Symbol.for('hackeroom.directTurns');

function directTurns(): Set<DirectTurn> {
  const store = globalThis as unknown as Record<symbol, Set<DirectTurn> | undefined>;
  return (store[DIRECT_TURNS] ??= new Set<DirectTurn>());
}

/** Remember a chat turn this server spawned, so Stop can end it by handle. */
export function trackDirectTurn<T extends DirectTurn>(child: T): T {
  const turns = directTurns();
  turns.add(child);
  child.on('close', () => turns.delete(child));
  child.on('error', () => turns.delete(child));
  return child;
}

function stopDirectTurns(): number {
  const turns = [...directTurns()];
  for (const child of turns) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already gone. Its close handler removes it from the set.
    }
  }
  return turns.length;
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

  // `detached` made this child the leader of a new process group, so its pid
  // is the id of the group that Stop will signal.
  if (child.pid !== undefined) recordOrchestratorPid(projectDir, child.pid);
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
    return { success: false, error: 'Nothing to build yet — describe what you want in the chat first.' };
  }

  const concept = String(stagingState.concept || '').trim();
  const sessions = (stagingState.sessions as Record<string, string> | undefined) || {};
  // Sessions are keyed by member id. `sessions.A` was left over from fixed
  // letter members and never matched, so the planner's concept conversation
  // was silently dropped on the way into every run.
  const plannerId = resolveSlot(readRoster(), 'planner')?.id;
  const aSession = (plannerId && sessions[plannerId]) || '';

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
  //
  // Written before the gates are installed, because the self-test below drives
  // the real gate against this manifest.
  const roster = readRoster();
  writeTeamManifest(projectDir, roster);

  // Install and *verify* a gate for every engine this run will use. A member
  // whose gate cannot be proved to refuse what it should is not a member that
  // runs — copying the file into place is not evidence that it works.
  const runClis = [...new Set(roster.members.filter((m) => m.enabled).map((m) => m.cli))]
    .map((id) => findCli(id))
    .filter((cli): cli is AgentCli => cli !== null);

  const selfTestMember = roster.members.find((m) => m.enabled)?.id;
  if (selfTestMember) {
    try {
      installGates(projectDir, BUILDUI_DIR, runClis, selfTestMember);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

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

export function stopPipelineRun(projectDir?: string): { success: boolean; projectDir?: string; warning?: string } {
  const resolvedProjectDir = projectDir || findLatestProject() || undefined;

  // By handle and by recorded group, never by matching command lines: see the
  // note above stopOrchestrator.
  stopDirectTurns();
  const problem = resolvedProjectDir ? stopOrchestrator(resolvedProjectDir) : null;
  if (problem) console.warn(`*** ${problem}`);

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
      if (problem) {
        // Said in the run log as well as the console: the run is marked
        // paused either way, and it would be wrong to let that read as
        // "nothing is running" when it could not be confirmed.
        events.push({
          time: new Date().toISOString(),
          agent: 'system',
          phase: String(state.currentPhase || 'concept'),
          type: 'failure',
          text: problem,
        });
      }
      state.events = events;
      writeJson(file, state);
    }
  }

  return { success: true, projectDir: resolvedProjectDir, ...(problem ? { warning: problem } : {}) };
}
