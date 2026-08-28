import { execFileSync, spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

import type { MemberCapabilities } from '../src/lib/team/types.ts';
import { resolveCli } from '../src/lib/cli/registry.ts';
import type { AgentCli, CliId, PathLayout } from '../src/lib/cli/types.ts';

export type { PathLayout };

/**
 * The adapter for a spawn.
 *
 * Falls back rather than throwing: the runner is the wrong place to refuse an
 * unknown CLI, because by the time a turn is spawning the run has already
 * started. Validation happens when the roster is saved and again at run start,
 * where refusing still means "this run does not begin".
 */
function cliFor(opts: RunnerOptions): AgentCli {
  return resolveCli(opts.cli);
}

/**
 * Members are user-authored, so an id is any roster slug — not a fixed letter.
 * The runner no longer branches on identity at all; behaviour that used to be
 * keyed on the agent letter is now driven by the member's capabilities.
 */
export type PipelineAgentId = string;
export type RunnerMode = 'host' | 'docker' | 'auto';
export type RunnerBackend = 'host' | 'docker';

export interface RunnerOptions {
  prompt: string;
  projectDir: string;
  pipelineDir?: string;
  model: string;
  roleFile?: string;
  systemPrompt?: string;
  resume?: string;
  jsonSchema?: Record<string, unknown>;
  effort?: string;
  pipelineAgent?: PipelineAgentId;
  securityMode?: 'fast' | 'strict';
  /**
   * Per-spawn permission mode. Falls back to PIPELINE_PERMISSION_MODE and then
   * to 'auto'. This must be per-spawn: members carry their own mode, so one
   * member can run in plan mode while another auto-accepts edits.
   */
  permissionMode?: string;
  /** Drives isolation, mount mode, and network profile. */
  capabilities?: MemberCapabilities;
  /** Directories passed to `claude --plugin-dir`, carrying the member's skills. */
  pluginDirs?: string[];
  /**
   * Which agent CLI runs this turn. Omitted means Claude Code, which is what
   * every roster written before this was a choice implies.
   */
  cli?: CliId;
  extraEnv?: NodeJS.ProcessEnv;
  templateFiles?: string[];
  forceHost?: boolean;
  /**
   * Fail rather than run on the host when this member asked to be isolated.
   *
   * Losing isolation changes the safety boundary, not just availability, so
   * this outranks `forceHost`: no caller can quietly downgrade a run that was
   * started with isolation required.
   */
  requireIsolation?: boolean;
}

/**
 * Whether a member that asked to be isolated will actually get it.
 *
 * `requested` is the member's own capability; `available` is whether the
 * backend can honour it right now. The two used to be collapsed inside
 * `spawn()`, which is how a run could lose isolation with nothing but a
 * console warning to show for it.
 */
export interface IsolationStatus {
  requested: boolean;
  available: boolean;
  /** Why it is unavailable, empty when it is not. */
  reason: string;
}

export type RunnerChild = Pick<
  ChildProcessWithoutNullStreams,
  'stdout' | 'stderr' | 'on' | 'kill'
>;

export type SpawnedRunnerChild = RunnerChild & {
  backend: RunnerBackend;
};

export interface Runner {
  spawn(opts: RunnerOptions): SpawnedRunnerChild;
  cleanup(projectDir: string): Promise<void>;
  isAvailable(): boolean;
  supportsHostFallback(opts: RunnerOptions): boolean;
  /** Asked before spawning, so a lost boundary can be reported or refused. */
  isolationStatus(opts: IsolationQuery): IsolationStatus;
}

/** All `isolationStatus` needs: isolation is a property of the member. */
export type IsolationQuery = Pick<RunnerOptions, 'capabilities'>;

const DOCKER_IMAGE = 'hackeroom-agent:latest';
const KEYCHAIN_SERVICE_NAME = 'Claude Code-credentials';
const DOCKER_WORKSPACE_ROOT = join(tmpdir(), 'hackeroom-docker-workspaces');
const DOCKER_SYNC_BACK_EXCLUDES = new Set([
  '.claude',
  '.git',
  'pipeline-approved.json',
  'pipeline-events.json',
  'pipeline-pending.json',
]);

export interface DockerCredentialBootstrap {
  source: 'none' | 'host-credentials-file' | 'macos-keychain';
  mountArgs: string[];
  cleanup: () => void;
}

interface DockerWorkspace {
  mountedProjectDir: string;
  syncBack: () => void;
  cleanup: () => void;
}

function hasValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function hasUsableCredentialsFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    return statSync(filePath).size > 4;
  } catch {
    return false;
  }
}

export function createCredentialBootstrap(
  credentialsJson: string,
  source: DockerCredentialBootstrap['source'],
): DockerCredentialBootstrap {
  const tempDir = mkdtempSync(join(tmpdir(), 'hackeroom-claude-'));
  const claudeDir = join(tempDir, '.claude');
  const credentialsPath = join(claudeDir, '.credentials.json');

  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(credentialsPath, credentialsJson, { mode: 0o600 });

  return {
    source,
    mountArgs: [
      '-v', `${credentialsPath}:/home/node/.claude/.credentials.json:ro`,
    ],
    cleanup: () => {
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function readMacOsKeychainCredentials(): string | null {
  if (process.platform !== 'darwin') return null;

  try {
    const output = execFileSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE_NAME, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();

    return output || null;
  } catch {
    return null;
  }
}

export function resolveDockerCredentialBootstrap(): DockerCredentialBootstrap {
  const hostCredentialsPath = join(homedir(), '.claude', '.credentials.json');
  if (hasUsableCredentialsFile(hostCredentialsPath)) {
    return createCredentialBootstrap(
      readFileSync(hostCredentialsPath, 'utf8'),
      'host-credentials-file'
    );
  }

  const keychainCredentials = readMacOsKeychainCredentials();
  if (keychainCredentials) {
    return createCredentialBootstrap(keychainCredentials, 'macos-keychain');
  }

  return {
    source: 'none',
    mountArgs: [],
    cleanup: () => {},
  };
}

function projectHash(projectDir: string): string {
  return createHash('sha256').update(projectDir).digest('hex').slice(0, 12);
}

function getDockerWorkspaceDir(projectDir: string, agent?: PipelineAgentId): string {
  return join(
    DOCKER_WORKSPACE_ROOT,
    `${projectHash(projectDir)}-${agent || 'session'}`
  );
}

function copyDirectoryContents(sourceDir: string, targetDir: string, excludes?: Set<string>) {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (excludes?.has(entry.name)) continue;
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    cpSync(sourcePath, targetPath, {
      recursive: true,
      force: true,
      dereference: false,
    });
  }
}

function prepareDockerWorkspace(opts: RunnerOptions): DockerWorkspace {
  const mountedProjectDir = getDockerWorkspaceDir(opts.projectDir, opts.pipelineAgent);
  rmSync(mountedProjectDir, { recursive: true, force: true });
  copyDirectoryContents(opts.projectDir, mountedProjectDir);

  return {
    mountedProjectDir,
    syncBack: () => {
      // Only a member that can actually write the project has anything to
      // sync back out of the container.
      if (!canWriteProject(opts.capabilities)) return;
      copyDirectoryContents(mountedProjectDir, opts.projectDir, DOCKER_SYNC_BACK_EXCLUDES);
    },
    cleanup: () => {},
  };
}

function canWriteProject(capabilities?: MemberCapabilities): boolean {
  return capabilities?.write === 'project' || capabilities?.write === 'builds';
}

export function shouldPreferDocker(opts: IsolationQuery): boolean {
  return opts.capabilities?.preferIsolated === true;
}

export function getProjectMountMode(capabilities?: MemberCapabilities): 'rw' | 'ro' {
  return capabilities?.projectMount ?? 'rw';
}

export function getNetworkProfile(capabilities?: MemberCapabilities): 'research' | 'build' | 'none' {
  return capabilities?.network ?? 'none';
}

// Permission-mode resolution moved onto the adapters: how a mode is spelled on
// the command line is the CLI's business, and the three spell it differently.
// The shared resolution lives in src/lib/cli/args.ts.

/** Container-side plugin mount point for the Nth attached plugin directory. */
export function containerPluginDir(index: number): string {
  return `/opt/pipeline/plugins/${index}`;
}

/** Container-side mount point for the member's role file. */
export const CONTAINER_ROLE_FILE = '/opt/pipeline/role.md';

/** What the host sees: the paths exactly as they are on disk. */
export function hostLayout(opts: RunnerOptions): PathLayout {
  return {
    roleFile: opts.roleFile,
    pluginDirs: [...(opts.pluginDirs || [])],
  };
}

/** What the container sees: the read-only mount points bound in buildDockerArgs. */
export function containerLayout(opts: RunnerOptions): PathLayout {
  return {
    roleFile: hasValue(opts.roleFile) ? CONTAINER_ROLE_FILE : undefined,
    pluginDirs: (opts.pluginDirs || []).map((_dir, index) => containerPluginDir(index)),
  };
}

/**
 * The argv for one turn, against a given view of the filesystem.
 *
 * The flags themselves belong to the member's CLI, so this is a lookup rather
 * than a list. It used to be Claude Code's vocabulary written out twice, once
 * per backend.
 */
export function buildArgs(opts: RunnerOptions, layout: PathLayout): string[] {
  const cli = cliFor(opts);
  // Some engines cannot be handed a system prompt on the command line and have
  // to read it off disk, so anything they need there is written first.
  cli.prepare?.(opts, layout);
  return cli.buildArgs(opts, layout);
}

/** The argv for a turn running directly on the host. */
export function buildClaudeArgs(opts: RunnerOptions): string[] {
  return buildArgs(opts, hostLayout(opts));
}

/** The argv for a turn running inside the agent container. */
function buildContainerClaudeArgs(opts: RunnerOptions): string[] {
  return buildArgs(opts, containerLayout(opts));
}

export function buildRunnerEnv(opts: RunnerOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.extraEnv,
    // Reset Claude's working directory after each Bash command so a `cd`
    // does not persist into later Write/Edit tool calls.
    CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '1',
  };

  if (hasValue(opts.pipelineAgent)) {
    env.PIPELINE_AGENT = opts.pipelineAgent;
  }

  if (hasValue(opts.securityMode)) {
    env.PIPELINE_SECURITY_MODE = opts.securityMode;
  }

  return env;
}

export function isRecoverableDockerAuthFailure(text: string): boolean {
  const normalized = text.toLowerCase();
  return [
    'not logged in',
    'please run /login',
    'invalid bearer token',
    'authentication_failed',
    '"type":"authentication_error"',
    'failed to authenticate. api error: 401',
  ].some((needle) => normalized.includes(needle));
}

function withBackend(child: RunnerChild, backend: RunnerBackend): SpawnedRunnerChild {
  return Object.assign(child, { backend });
}

export function buildDockerArgs(
  opts: RunnerOptions,
  authBootstrap: DockerCredentialBootstrap,
): string[] {
  const hostAuthEnv = {
    ...process.env,
    ...opts.extraEnv,
  };
  const agentLabel = opts.pipelineAgent || 'session';
  const containerProject = `/home/node/Builds/${basename(opts.projectDir)}`;
  const containerName = `hackeroom-${projectHash(opts.projectDir)}-${agentLabel}-${Date.now()}`;
  const sessionVolume = `hackeroom-sessions-${projectHash(opts.projectDir)}-${agentLabel}`;
  const projectAccess = getProjectMountMode(opts.capabilities);
  const dockerArgs: string[] = [
    'run', '--rm',
    '--name', containerName,
    '-v', `${opts.projectDir}:${containerProject}:${projectAccess}`,
    '-v', `${sessionVolume}:/home/node/.claude`,
    '--memory', '4g',
    '--cpus', '2',
    '-w', containerProject,
  ];

  if (hasValue(opts.pipelineDir) && existsSync(`${opts.pipelineDir}/.claude/hooks`)) {
    dockerArgs.push('-v', `${opts.pipelineDir}/.claude/hooks:${containerProject}/.claude/hooks:ro`);
  }

  if (hasValue(opts.pipelineDir) && existsSync(`${opts.pipelineDir}/.claude/settings.json`)) {
    dockerArgs.push('-v', `${opts.pipelineDir}/.claude/settings.json:${containerProject}/.claude/settings.json:ro`);
  }

  if (hasValue(opts.roleFile)) {
    dockerArgs.push('-v', `${opts.roleFile}:${CONTAINER_ROLE_FILE}:ro`);
  }

  for (const file of opts.templateFiles || []) {
    if (!existsSync(file)) continue;
    dockerArgs.push('-v', `${file}:/opt/pipeline/${basename(file)}:ro`);
  }

  (opts.pluginDirs || []).forEach((dir, index) => {
    if (!existsSync(dir)) return;
    dockerArgs.push('-v', `${dir}:${containerPluginDir(index)}:ro`);
  });

  dockerArgs.push(...authBootstrap.mountArgs);

  dockerArgs.push('--cap-add=NET_ADMIN', '--cap-add=NET_RAW');
  for (const envKey of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const) {
    if (hasValue(hostAuthEnv[envKey])) {
      dockerArgs.push('-e', envKey);
    }
  }
  if (hasValue(opts.pipelineAgent)) {
    dockerArgs.push('-e', `PIPELINE_AGENT=${opts.pipelineAgent}`);
  }

  if (hasValue(opts.securityMode)) {
    dockerArgs.push('-e', `PIPELINE_SECURITY_MODE=${opts.securityMode}`);
  }

  dockerArgs.push('-e', 'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1');
  dockerArgs.push('-e', `AGENT_NETWORK_PROFILE=${getNetworkProfile(opts.capabilities)}`);

  dockerArgs.push(
    DOCKER_IMAGE,
    cliFor(opts).containerBinary,
    ...buildContainerClaudeArgs(opts),
  );

  return dockerArgs;
}

export class HostRunner implements Runner {
  spawn(opts: RunnerOptions): SpawnedRunnerChild {
    const child = nodeSpawn(cliFor(opts).binary, buildClaudeArgs(opts), {
      cwd: opts.projectDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildRunnerEnv(opts),
    });

    // Nothing here ever writes to the child's stdin — the prompt goes in as an
    // argument — so close it immediately and give the CLI its EOF.
    //
    // This is not tidiness. `claude -p` ignores stdin and exits regardless, but
    // OpenCode accepts a piped prompt, so an open pipe means it waits for input
    // that will never come: no output, no error, no exit. A member on it just
    // sat there looking busy. The docker path already passes 'ignore', which is
    // why only host runs hung.
    child.stdin?.end();

    return withBackend(child, 'host');
  }

  async cleanup(_projectDir: string): Promise<void> {
    void _projectDir;
  }

  isAvailable(): boolean {
    return true;
  }

  supportsHostFallback(opts: RunnerOptions): boolean {
    void opts;
    return false;
  }

  /**
   * Running host-only is an explicit operator choice (PIPELINE_RUNNER=host),
   * so it is not reported as isolation being lost — there was never any to
   * lose. The gate exists for runs that asked for it and silently did not
   * get it.
   */
  isolationStatus(opts: IsolationQuery): IsolationStatus {
    void opts;
    return { requested: false, available: false, reason: '' };
  }
}

export class DockerRunner implements Runner {
  spawn(opts: RunnerOptions): SpawnedRunnerChild {
    const workspace = prepareDockerWorkspace(opts);
    const authBootstrap = resolveDockerCredentialBootstrap();
    const dockerOpts = {
      ...opts,
      projectDir: workspace.mountedProjectDir,
    };
    const child = nodeSpawn('docker', buildDockerArgs(dockerOpts, authBootstrap), {
      cwd: workspace.mountedProjectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildRunnerEnv(opts),
    });

    let cleanedUp = false;
    const cleanupBootstrap = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      workspace.syncBack();
      workspace.cleanup();
      authBootstrap.cleanup();
    };

    child.on('close', cleanupBootstrap);
    child.on('error', cleanupBootstrap);

    // Docker runs with stdio: ['ignore', 'pipe', 'pipe'] so child.stdin is null.
    // Nothing on the docker path reads stdin — cast through unknown to satisfy the
    // RunnerChild interface (which expects Writable) without widening the type.
    return withBackend(child as unknown as RunnerChild, 'docker');
  }

  async cleanup(projectDir: string): Promise<void> {
    const pid = projectHash(projectDir);
    const prefix = `hackeroom-sessions-${pid}-`;

    // Member ids are user-authored, so there is no list to iterate. Discover
    // whatever this project actually created instead.
    let volumes: string[] = [];
    try {
      volumes = execFileSync('docker', ['volume', 'ls', '--quiet', '--filter', `name=${prefix}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith(prefix));
    } catch {
      // Docker unavailable — nothing to clean.
    }

    for (const volume of volumes) {
      try {
        execFileSync('docker', ['volume', 'rm', '-f', volume], { stdio: 'pipe' });
      } catch {
        // Ignore volumes that are already gone or still in use.
      }
    }

    // Workspace directories are named <hash>-<member>, so the same discovery
    // applies on the filesystem side.
    try {
      for (const entry of readdirSync(DOCKER_WORKSPACE_ROOT)) {
        if (!entry.startsWith(`${pid}-`)) continue;
        rmSync(join(DOCKER_WORKSPACE_ROOT, entry), { recursive: true, force: true });
      }
    } catch {
      // Workspace root may not exist yet.
    }
  }

  isAvailable(): boolean {
    try {
      execFileSync('docker', ['info'], { stdio: 'pipe' });
      execFileSync('docker', ['image', 'inspect', DOCKER_IMAGE], { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  supportsHostFallback(opts: RunnerOptions): boolean {
    void opts;
    return false;
  }

  unavailableReason(): string {
    try {
      execFileSync('docker', ['info'], { stdio: 'pipe' });
    } catch {
      return 'Docker is not running or not installed.';
    }

    try {
      execFileSync('docker', ['image', 'inspect', DOCKER_IMAGE], { stdio: 'pipe' });
    } catch {
      return `Docker image '${DOCKER_IMAGE}' not found. Build it with: docker build -t ${DOCKER_IMAGE} -f pipeline/Dockerfile.agent pipeline/`;
    }

    return '';
  }

  isolationStatus(opts: IsolationQuery): IsolationStatus {
    // createRunner() throws when Docker is unavailable in this mode, so
    // reaching here at all means isolation is honoured.
    return { requested: shouldPreferDocker(opts), available: true, reason: '' };
  }
}

export class AutoRunner implements Runner {
  private readonly host = new HostRunner();
  private readonly docker = new DockerRunner();
  private warned = false;

  spawn(opts: RunnerOptions): SpawnedRunnerChild {
    // Deliberately ahead of forceHost: a run started with isolation required
    // must not be relocated to the host by any later decision, including the
    // orchestrator's own fallback path.
    if (opts.requireIsolation && shouldPreferDocker(opts)) {
      if (!this.docker.isAvailable()) {
        throw new Error(`Isolation is required for this run but unavailable. ${this.docker.unavailableReason()}`);
      }
      return this.docker.spawn(opts);
    }

    if (opts.forceHost) {
      return this.host.spawn(opts);
    }

    if (shouldPreferDocker(opts)) {
      if (this.docker.isAvailable()) {
        return this.docker.spawn(opts);
      }
      this.warnUnavailable();
    }

    return this.host.spawn(opts);
  }

  async cleanup(projectDir: string): Promise<void> {
    if (this.docker.isAvailable()) {
      await this.docker.cleanup(projectDir);
    }
  }

  isAvailable(): boolean {
    return true;
  }

  supportsHostFallback(opts: RunnerOptions): boolean {
    return shouldPreferDocker(opts) && !opts.forceHost && !opts.requireIsolation;
  }

  isolationStatus(opts: IsolationQuery): IsolationStatus {
    const requested = shouldPreferDocker(opts);
    if (!requested) return { requested: false, available: false, reason: '' };

    const available = this.docker.isAvailable();
    return { requested, available, reason: available ? '' : this.docker.unavailableReason() };
  }

  private warnUnavailable() {
    if (this.warned) return;
    const reason = this.docker.unavailableReason();
    console.warn(`\x1b[33m[WARNING] ${reason}\x1b[0m`);
    console.warn('\x1b[33m[WARNING] Falling back to host runner for sandbox-eligible agents.\x1b[0m');
    this.warned = true;
  }
}

export function createRunner(mode: RunnerMode | string = process.env.PIPELINE_RUNNER || 'auto'): Runner {
  const requested = String(mode).toLowerCase() as RunnerMode;

  if (requested === 'host') {
    return new HostRunner();
  }

  if (requested === 'docker') {
    const docker = new DockerRunner();
    if (!docker.isAvailable()) {
      throw new Error(docker.unavailableReason());
    }
    return docker;
  }

  return new AutoRunner();
}
