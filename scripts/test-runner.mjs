import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  AutoRunner,
  CONTAINER_ROLE_FILE,
  DockerRunner,
  HostRunner,
  buildArgs,
  buildClaudeArgs,
  buildDockerArgs,
  containerLayout,
  containerPluginDir,
  hostLayout,
  buildRunnerEnv,
  createCredentialBootstrap,
  createRunner,
  getNetworkProfile,
  getProjectMountMode,
  hasUsableCredentialsFile,
  isRecoverableDockerAuthFailure,
  shouldPreferDocker,
} from '../pipeline/runner.ts';
import { claudeCli } from '../src/lib/cli/claude.ts';

const roleArgs = buildClaudeArgs({
  prompt: 'build me a tiny app',
  projectDir: '/tmp/project',
  model: 'claude-opus-4-6',
  roleFile: '/tmp/role.md',
  resume: 'sess-123',
  effort: 'high',
  jsonSchema: { type: 'object' },
});

assert.equal(roleArgs[0], '-p');
assert.equal(roleArgs[1], 'build me a tiny app');
assert.ok(
  roleArgs.includes('--permission-mode') || roleArgs.includes('--dangerously-skip-permissions'),
  'permission flag present',
);
assert.ok(roleArgs.includes('--model'));
assert.ok(roleArgs.includes('--output-format'));
assert.ok(roleArgs.includes('--system-prompt-file'));
assert.ok(roleArgs.includes('/tmp/role.md'));
assert.ok(roleArgs.includes('--resume'));
assert.ok(roleArgs.includes('sess-123'));
assert.ok(roleArgs.includes('--effort'));
assert.ok(roleArgs.includes('high'));
assert.ok(roleArgs.includes('--json-schema'));

const promptArgs = buildClaudeArgs({
  prompt: 'hello',
  projectDir: '/tmp/project',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are helpful.',
});
assert.ok(promptArgs.includes('--system-prompt'));
assert.ok(promptArgs.includes('You are helpful.'));

// ── Per-member model, permission mode and skills ─────────────────────
// These must vary per spawn: two members in the same run can hold different
// models and permission modes.

const haikuArgs = buildClaudeArgs({
  prompt: 'x',
  projectDir: '/tmp/project',
  model: 'haiku',
  systemPrompt: 'p',
  permissionMode: 'plan',
});
assert.equal(haikuArgs[haikuArgs.indexOf('--model') + 1], 'haiku', 'model alias is passed through');
assert.equal(haikuArgs[haikuArgs.indexOf('--permission-mode') + 1], 'plan');

const acceptArgs = buildClaudeArgs({
  prompt: 'x',
  projectDir: '/tmp/project',
  model: 'opus',
  systemPrompt: 'p',
  permissionMode: 'acceptEdits',
});
assert.equal(acceptArgs[acceptArgs.indexOf('--permission-mode') + 1], 'acceptEdits');
assert.equal(acceptArgs[acceptArgs.indexOf('--model') + 1], 'opus');

// Two spawns in the same process must not share a permission mode — the old
// module-level constant made that impossible.
assert.notEqual(
  haikuArgs[haikuArgs.indexOf('--permission-mode') + 1],
  acceptArgs[acceptArgs.indexOf('--permission-mode') + 1],
  'permission mode is resolved per spawn, not once at module load',
);

const skipArgs = buildClaudeArgs({
  prompt: 'x',
  projectDir: '/tmp/project',
  model: 'sonnet',
  systemPrompt: 'p',
  permissionMode: 'dangerously-skip-permissions',
});
assert.ok(skipArgs.includes('--dangerously-skip-permissions'), 'legacy skip value becomes the CLI flag');
assert.ok(!skipArgs.includes('--permission-mode'));

const pluginArgs = buildClaudeArgs({
  prompt: 'x',
  projectDir: '/tmp/project',
  model: 'sonnet',
  systemPrompt: 'p',
  pluginDirs: ['/home/u/.hackeroom/members/reacty/plugin', '/home/u/.hackeroom/members/shared/plugin'],
});
const pluginFlags = pluginArgs.reduce((acc, arg, i) => (arg === '--plugin-dir' ? [...acc, pluginArgs[i + 1]] : acc), []);
assert.deepEqual(
  pluginFlags,
  ['/home/u/.hackeroom/members/reacty/plugin', '/home/u/.hackeroom/members/shared/plugin'],
  'attached skills are passed as repeatable session-scoped plugin dirs',
);
assert.equal(
  buildClaudeArgs({ prompt: 'x', projectDir: '/tmp/p', model: 'sonnet', systemPrompt: 'p' }).includes('--plugin-dir'),
  false,
  'a member with no skills gets no plugin flag',
);

const env = buildRunnerEnv({
  prompt: 'hello',
  projectDir: '/tmp/project',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are helpful.',
  pipelineAgent: 'reacty',
  securityMode: 'strict',
  extraEnv: { TEST_ONLY: '1' },
});
assert.equal(env.PIPELINE_AGENT, 'reacty', 'member ids are arbitrary roster slugs, not letters');
assert.equal(env.PIPELINE_SECURITY_MODE, 'strict');
assert.equal(env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR, '1');
assert.equal(env.TEST_ONLY, '1');

// ── Capability-driven behaviour (was keyed on agent letter) ──────────

const caps = (overrides) => ({
  write: 'none',
  bash: 'none',
  web: false,
  network: 'none',
  projectMount: 'ro',
  preferIsolated: false,
  ...overrides,
});

assert.equal(shouldPreferDocker({ capabilities: caps({ preferIsolated: true }) }), true);
assert.equal(shouldPreferDocker({ capabilities: caps({ preferIsolated: false }) }), false);
assert.equal(shouldPreferDocker({}), false, 'no capabilities means no isolation preference');

assert.equal(getProjectMountMode(caps({ projectMount: 'ro' })), 'ro');
assert.equal(getProjectMountMode(caps({ projectMount: 'rw' })), 'rw');
assert.equal(getProjectMountMode(undefined), 'rw', 'defaults to rw when unknown');

assert.equal(getNetworkProfile(caps({ network: 'research' })), 'research');
assert.equal(getNetworkProfile(caps({ network: 'build' })), 'build');
assert.equal(getNetworkProfile(undefined), 'none', 'defaults closed when unknown');
assert.equal(isRecoverableDockerAuthFailure('Not logged in · Please run /login'), true);
assert.equal(isRecoverableDockerAuthFailure('Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}'), true);
assert.equal(isRecoverableDockerAuthFailure('Tool execution failed for a different reason'), false);

const credentialsTmp = mkdtempSync(join(tmpdir(), 'runner-creds-'));
const placeholderPath = join(credentialsTmp, 'placeholder.json');
const realCredsPath = join(credentialsTmp, 'real.json');
writeFileSync(placeholderPath, '{}');
writeFileSync(realCredsPath, '{"oauth_token":"abc"}');
assert.equal(hasUsableCredentialsFile(join(credentialsTmp, 'missing.json')), false);
assert.equal(hasUsableCredentialsFile(placeholderPath), false);
assert.equal(hasUsableCredentialsFile(realCredsPath), true);

const bootstrap = createCredentialBootstrap(
  '{"oauth_token":"abc"}',
  'macos-keychain',
  '{"hasCompletedOnboarding":true}'
);
assert.equal(bootstrap.source, 'macos-keychain');
assert.equal(bootstrap.mountArgs.length, 2);
assert.ok(bootstrap.mountArgs[1].includes('/home/node/.claude/.credentials.json:ro'));
assert.match(readFileSync(bootstrap.mountArgs[1].split(':')[0], 'utf8'), /oauth_token/);
const dockerArgs = buildDockerArgs({
  prompt: 'Reply with OK.',
  projectDir: '/tmp/project',
  pipelineDir: '/tmp/pipeline',
  model: 'claude-sonnet-4-6',
  roleFile: '/tmp/role.md',
  pipelineAgent: 'C',
  securityMode: 'fast',
}, bootstrap);
assert.equal(dockerArgs[0], 'run');
assert.equal(dockerArgs[1], '--rm');
assert.ok(!dockerArgs.includes('-i'));
assert.ok(dockerArgs.includes('hackeroom-agent:latest'));
assert.ok(dockerArgs.includes('/usr/local/share/npm-global/bin/claude'));
assert.ok(!dockerArgs.includes('sh'));
assert.ok(!dockerArgs.includes('-lc'));
assert.ok(!dockerArgs.includes('ANTHROPIC_API_KEY'));

const dockerArgsWithAuth = buildDockerArgs({
  prompt: 'Reply with OK.',
  projectDir: '/tmp/project',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'You are helpful.',
  extraEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'token-123' },
}, bootstrap);
assert.ok(dockerArgsWithAuth.includes('CLAUDE_CODE_OAUTH_TOKEN'));
bootstrap.cleanup();
rmSync(credentialsTmp, { recursive: true, force: true });

assert.ok(createRunner('host') instanceof HostRunner);
assert.ok(createRunner('auto') instanceof AutoRunner);
assert.equal(typeof new DockerRunner().isAvailable(), 'boolean');
const isolated = { pipelineAgent: 'reacty', capabilities: caps({ preferIsolated: true }) };
assert.equal(new HostRunner().supportsHostFallback(isolated), false);
assert.equal(new AutoRunner().supportsHostFallback(isolated), true);
assert.equal(new AutoRunner().supportsHostFallback({ ...isolated, forceHost: true }), false);
assert.equal(
  new AutoRunner().supportsHostFallback({ pipelineAgent: 'pat', capabilities: caps({ preferIsolated: false }) }),
  false,
  'a member that does not want isolation has nothing to fall back from',
);

// Losing isolation is a safety question, not an availability one: a run that
// required it must not be relocated to the host by any later decision.
assert.equal(
  new AutoRunner().supportsHostFallback({ ...isolated, requireIsolation: true }),
  false,
  'required isolation refuses the mid-turn host fallback',
);

const auto = new AutoRunner();
const dockerUp = new DockerRunner().isAvailable();

const status = auto.isolationStatus(isolated);
assert.equal(status.requested, true, 'the member asked to be isolated');
assert.equal(status.available, dockerUp, 'availability tracks whether Docker can actually serve it');
assert.equal(status.reason === '', dockerUp, 'an unavailable backend has to say why');

assert.deepEqual(
  auto.isolationStatus({ capabilities: caps({ preferIsolated: false }) }),
  { requested: false, available: false, reason: '' },
  'a member that never asked for isolation is not reported as having lost it',
);
assert.equal(
  new HostRunner().isolationStatus(isolated).requested,
  false,
  'an explicit host runner is an operator decision, not a lost boundary',
);

// Docker is up on some machines and not others, and this is the assertion that
// most needs to hold either way, so the backend is stubbed unavailable rather
// than the test being skipped.
const grounded = new AutoRunner();
grounded.docker.isAvailable = () => false;
grounded.docker.unavailableReason = () => 'Docker is not running or not installed.';

const isolationRequired = {
  ...isolated,
  requireIsolation: true,
  prompt: 'x',
  projectDir: '/tmp/project',
  model: 'haiku',
  systemPrompt: 'x',
};

assert.throws(
  () => grounded.spawn(isolationRequired),
  /Isolation is required/,
  'required isolation throws rather than silently spawning on the host',
);
assert.throws(
  () => grounded.spawn({ ...isolationRequired, forceHost: true }),
  /Isolation is required/,
  'forceHost does not override required isolation',
);
assert.equal(
  grounded.isolationStatus(isolated).available,
  false,
  'an unavailable backend reports isolation as unavailable before anything spawns',
);
assert.match(
  grounded.isolationStatus(isolated).reason,
  /Docker/,
  'the caller is told why, so the pause can explain itself',
);

// ── Host and container argv differ only in paths ─────────────────────
//
// The flag vocabulary used to be written out twice, once per backend, so a
// flag added to one copy silently did not exist in the other. Now both go
// through buildArgs and differ only in the PathLayout handed to it. This
// asserts exactly that: replace the container's mount points with the host's
// real paths and the two command lines must be identical.

const layoutOpts = {
  prompt: 'do the thing',
  projectDir: '/tmp/project',
  model: 'sonnet',
  roleFile: '/home/me/.hackeroom/members/pat/role.md',
  pluginDirs: ['/repo/templates/team-plugin', '/home/me/.hackeroom/members/pat/plugin'],
  resume: 'sess-9',
  effort: 'high',
  jsonSchema: { type: 'object' },
};

const onHost = buildArgs(layoutOpts, hostLayout(layoutOpts));
const inContainer = buildArgs(layoutOpts, containerLayout(layoutOpts));

const containerToHost = new Map([
  [CONTAINER_ROLE_FILE, layoutOpts.roleFile],
  ...layoutOpts.pluginDirs.map((dir, index) => [containerPluginDir(index), dir]),
]);

assert.deepEqual(
  inContainer.map((arg) => containerToHost.get(arg) ?? arg),
  onHost,
  'the two backends build the same command line, differing only in where the files are mounted',
);

assert.ok(
  inContainer.includes(CONTAINER_ROLE_FILE),
  'the container is told the mount point, not the host path it would not be able to read',
);
assert.ok(
  !inContainer.includes(layoutOpts.roleFile),
  'and never the host path',
);

assert.throws(
  () => buildArgs({ prompt: 'x', projectDir: '/tmp/p', model: 'sonnet' }, { pluginDirs: [] }),
  /roleFile or systemPrompt/,
  'a turn with no system prompt at all is a programming error, on either backend',
);

assert.ok(
  buildArgs(
    { prompt: 'x', projectDir: '/tmp/p', model: 'sonnet', systemPrompt: 'inline' },
    containerLayout({ prompt: 'x', projectDir: '/tmp/p', model: 'sonnet', systemPrompt: 'inline' }),
  ).includes('--system-prompt'),
  'an inline system prompt needs no mount, so it survives the container layout',
);

// ── The binary comes from the adapter, not from a literal ────────────

const dockerCliArgs = buildDockerArgs(
  { prompt: 'x', projectDir: '/tmp/p', model: 'sonnet', systemPrompt: 'p', pipelineAgent: 'pat' },
  { source: 'none', mountArgs: [], cleanup: () => {} },
  '/tmp/mounted',
);
assert.ok(
  dockerCliArgs.includes(claudeCli.containerBinary),
  'the container is told which binary to run by the adapter, so a second CLI needs no change here',
);
assert.ok(
  !dockerCliArgs.includes('claude'),
  'and never a bare name that would depend on the container PATH',
);

console.log('runner checks passed');
