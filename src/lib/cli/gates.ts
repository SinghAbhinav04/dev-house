/**
 * Installing each CLI's tool gate into a project, and proving it works.
 *
 * The premise of this whole system is that what a member may do is enforced,
 * not asked for politely. That premise is only as good as the gate actually
 * being wired up — so this does not just copy files into place, it fires a call
 * through each gate that *must* be refused and checks that it was.
 *
 * An existence check would not be enough. The failures that matter here are
 * quiet ones: a shim whose executable bit was lost, a missing `jq`, a wrong
 * argument key that makes the gate read an empty path. All of those look
 * exactly like a working installation until a member writes somewhere it
 * should not have been able to.
 *
 * If any check fails the run refuses to start. There is deliberately no
 * override: "run my team with nothing enforcing what they may do" is not a
 * choice this can meaningfully offer.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentCli, CliId } from './types.ts';

/** Where the shipped hooks live, relative to the repo root. */
export function hookSourceDir(pipelineDir: string): string {
  return join(pipelineDir, '.claude', 'hooks');
}

export class GateInstallError extends Error {
  // Written out rather than declared as constructor parameter properties: the
  // test suite runs these sources directly under --experimental-strip-types,
  // which cannot emit the implicit assignments that shorthand needs.
  readonly cli: CliId;
  readonly check: string;

  constructor(cli: CliId, check: string, detail: string) {
    super(`${cli} gate failed the "${check}" check: ${detail}`);
    this.name = 'GateInstallError';
    this.cli = cli;
    this.check = check;
  }
}

interface GateProbe {
  /** What agy would send, or the equivalent for another CLI. */
  payload: unknown;
  /** True when the CLI would treat this response as a refusal. */
  isDenial(stdout: string, status: number | null): boolean;
}

/**
 * Ask a gate to judge something, in that CLI's own dialect.
 *
 * `PIPELINE_AGENT` is set to a member the manifest knows about with the
 * narrowest capabilities, so a denial proves the gate read the manifest rather
 * than refusing because it could not find one.
 */
function invokeGate(script: string, probe: GateProbe, env: NodeJS.ProcessEnv, cwd: string) {
  try {
    const stdout = execFileSync('bash', [script], {
      input: JSON.stringify(probe.payload),
      encoding: 'utf8',
      cwd,
      env,
      timeout: 20_000,
    });
    return { stdout, status: 0 };
  } catch (err) {
    const failure = err as { stdout?: string; status?: number; message?: string };
    return { stdout: failure.stdout ?? '', status: failure.status ?? null, message: failure.message };
  }
}

/** The Antigravity shim's own dialect: a refusal is JSON on stdout. */
function antigravityProbe(tool: string, args: Record<string, unknown>): GateProbe {
  return {
    payload: { toolCall: { name: tool, args }, conversationId: 'gate-self-test', stepIdx: 0 },
    isDenial(stdout: string): boolean {
      try {
        return JSON.parse(stdout.trim()).decision === 'deny';
      } catch {
        return false;
      }
    },
  };
}

/**
 * Write Antigravity's hook config and prove the shim refuses what it should.
 *
 * The command path is absolute on purpose: agy runs hooks with its working
 * directory set to `<project>/.agents`, not the project root, so a relative
 * path would resolve against the wrong directory and simply not exist.
 */
function installAntigravityGate(projectDir: string, pipelineDir: string, memberId: string): void {
  const fail = (check: string, detail: string) => {
    throw new GateInstallError('antigravity', check, detail);
  };

  const hooksDir = join(projectDir, '.claude', 'hooks');
  const shim = join(hooksDir, 'gate-antigravity.sh');
  const source = join(hookSourceDir(pipelineDir), 'gate-antigravity.sh');

  if (!existsSync(source)) fail('shim present', `${source} is missing from this build`);

  // Rewritten from the build every run, not patched if absent. That is a
  // defence as well as a convenience: a shim a member somehow altered is
  // replaced before the next run rather than being trusted because it exists.
  mkdirSync(hooksDir, { recursive: true });
  copyFileSync(source, shim);
  chmodSync(shim, 0o755);

  mkdirSync(join(projectDir, '.agents'), { recursive: true });
  writeFileSync(
    join(projectDir, '.agents', 'hooks.json'),
    `${JSON.stringify(
      {
        hackeroom: {
          // "" and "*" both mean every tool. Without a catch-all there would be
          // no deny-by-default, and this CLI could not be supported at all.
          PreToolUse: [{ matcher: '*', hooks: [{ command: shim, timeout: 30 }] }],
        },
      },
      null,
      2
    )}\n`
  );

  try {
    execFileSync('jq', ['--version'], { stdio: 'ignore' });
  } catch {
    fail('jq available', 'the shim cannot translate anything without jq');
  }

  try {
    execFileSync('bash', ['-n', shim], { stdio: 'ignore' });
  } catch (err) {
    fail('shim parses', (err as Error).message);
  }

  const env = { ...process.env, PIPELINE_AGENT: memberId, PIPELINE_SECURITY_MODE: 'fast' };
  const cwd = join(projectDir, '.agents');

  const run = (check: string, probe: GateProbe, expectDenial: boolean) => {
    const result = invokeGate(shim, probe, env, cwd);
    const denied = probe.isDenial(result.stdout, result.status);
    if (denied === expectDenial) return;
    fail(
      check,
      expectDenial
        ? `expected a refusal, got ${JSON.stringify(result.stdout.trim()) || '(nothing)'}`
        : `expected it to be permitted, got ${result.stdout.trim()}`
    );
  };

  // The check that proves the argument key is right. A wrong key would make the
  // gate read an empty path, which resolves inside the project and is allowed —
  // so this failing open is exactly the outcome the self-test exists to catch.
  run(
    'refuses a write to its own hooks',
    antigravityProbe('write_to_file', { TargetFile: join(projectDir, '.claude', 'hooks', 'approval-gate.sh') }),
    true
  );

  // And that it is not simply refusing everything, which would pass the check
  // above while making the CLI useless.
  run('permits an ordinary read', antigravityProbe('view_file', { AbsolutePath: join(projectDir, 'plan.md') }), false);

  run('refuses a write with no path at all', antigravityProbe('write_to_file', {}), true);
  run('refuses a tool it does not recognise', antigravityProbe('some_tool_from_the_future', {}), true);
  run('refuses spawning a sub-agent', antigravityProbe('invoke_subagent', {}), true);

  // Identity absent must refuse, or a hook that lost its environment would
  // quietly permit everything.
  const anonymous = invokeGate(
    shim,
    antigravityProbe('view_file', { AbsolutePath: join(projectDir, 'plan.md') }),
    { ...process.env, PIPELINE_AGENT: '' },
    cwd
  );
  if (!antigravityProbe('view_file', {}).isDenial(anonymous.stdout, anonymous.status)) {
    fail('refuses a member it cannot name', 'an unidentified caller was permitted');
  }
}

/**
 * Install and verify the gate for every CLI a run will actually use.
 *
 * `memberId` must name a member present in the manifest — the self-test is
 * driven as that member, so a denial has to come from the rules rather than
 * from the gate failing to find anyone.
 */
export function installGates(
  projectDir: string,
  pipelineDir: string,
  clis: readonly AgentCli[],
  memberId: string
): void {
  for (const cli of clis) {
    // Claude Code's gate is installed by the caller alongside settings.json and
    // is covered by its own contract suite; nothing extra to write here.
    if (cli.id === 'antigravity') installAntigravityGate(projectDir, pipelineDir, memberId);
  }
}
