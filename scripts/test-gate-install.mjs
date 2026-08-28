#!/usr/bin/env node

/**
 * That installing a gate actually verifies it.
 *
 * The point of the self-test is not that the file was copied — it is that the
 * gate refuses what it should. The failures worth catching here all look
 * exactly like a working installation from the outside: a lost executable bit,
 * a missing `jq`, a shim edited into something that permits everything. So
 * these deliberately break the gate in each of those ways and assert the run
 * refuses to start.
 */

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { installGates, GateInstallError } = await import(join(repoRoot, 'src/lib/cli/gates.ts'));
const { antigravityCli } = await import(join(repoRoot, 'src/lib/cli/antigravity.ts'));
const { claudeCli } = await import(join(repoRoot, 'src/lib/cli/claude.ts'));

const pipelineDir = join(repoRoot, 'pipeline');

/** A project laid out the way a run start would leave it. */
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'hackeroom-gate-install-'));
  const home = join(root, 'home');
  const projectDir = join(home, 'Builds', 'p');

  mkdirSync(join(projectDir, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(projectDir, 'pipeline-events.json'), JSON.stringify({ currentPhase: 'coding' }));
  writeFileSync(join(projectDir, 'plan.md'), '# plan\n');

  // approval-gate.sh has to be in place: the shim is only a translator and
  // invokes it as its sibling.
  const gate = join(projectDir, '.claude', 'hooks', 'approval-gate.sh');
  writeFileSync(gate, readFileSync(join(pipelineDir, '.claude', 'hooks', 'approval-gate.sh'), 'utf8'), { mode: 0o755 });

  writeFileSync(
    join(projectDir, '.claude', 'team-manifest.json'),
    JSON.stringify({
      version: 1,
      artifacts: {},
      members: { reacty: { slot: 'coder', write: 'project', bash: 'safe', web: false, denyPhases: [] } },
    })
  );

  return { root, home, projectDir };
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('a correctly installed gate passes', () => {
  const { root, home, projectDir } = makeProject();
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    installGates(projectDir, pipelineDir, [antigravityCli], 'reacty');
  } finally {
    process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

check('installing writes hooks.json naming an ABSOLUTE command', () => {
  const { root, home, projectDir } = makeProject();
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    installGates(projectDir, pipelineDir, [antigravityCli], 'reacty');
    const config = JSON.parse(readFileSync(join(projectDir, '.agents', 'hooks.json'), 'utf8'));
    const entry = config.hackeroom.PreToolUse[0];

    assert.equal(entry.matcher, '*', 'without a catch-all there is no deny-by-default');
    assert.ok(
      entry.hooks[0].command.startsWith('/'),
      // agy runs hooks from <project>/.agents, not the project root, so a
      // relative path would resolve against the wrong directory.
      'a relative command would not exist from where agy runs the hook',
    );
  } finally {
    process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

check('a gate that lost its executable bit is caught', () => {
  const { root, home, projectDir } = makeProject();
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    chmodSync(join(projectDir, '.claude', 'hooks', 'approval-gate.sh'), 0o644);
    assert.throws(
      () => installGates(projectDir, pipelineDir, [antigravityCli], 'reacty'),
      GateInstallError,
      'an unrunnable gate must stop the run, not be discovered mid-build',
    );
  } finally {
    process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A build whose shipped shim has been replaced by something broken.
 *
 * Sabotaging the *installed* copy proves nothing, because installGates rewrites
 * it from the build on every run — which is itself worth knowing: a shim a
 * member somehow modified is replaced before the next run rather than trusted.
 * What the self-test can catch is a broken shim in the build, and that is what
 * these two drive.
 */
function makeSabotagedBuild(root, body) {
  const fakePipeline = join(root, 'fake-pipeline', '.claude', 'hooks');
  mkdirSync(fakePipeline, { recursive: true });
  writeFileSync(join(fakePipeline, 'gate-antigravity.sh'), body, { mode: 0o755 });
  return join(root, 'fake-pipeline');
}

check('a shim that permits everything is caught', () => {
  const { root, home, projectDir } = makeProject();
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // The failure this whole self-test exists for: a gate that is present,
    // executable, parses cleanly, and quietly allows everything. An existence
    // check would call this a successful installation.
    const build = makeSabotagedBuild(root, '#!/bin/bash\nexit 0\n');

    assert.throws(
      () => installGates(projectDir, build, [antigravityCli], 'reacty'),
      /refuses a write to its own hooks/,
      'the check names what failed',
    );
  } finally {
    process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

check('a shim that refuses EVERYTHING is also caught', () => {
  const { root, home, projectDir } = makeProject();
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // Refusing everything would satisfy a deny-only self-test while making the
    // CLI useless, so the allow case is checked too.
    const build = makeSabotagedBuild(root, '#!/bin/bash\necho \'{"decision":"deny","reason":"no"}\'\nexit 0\n');

    assert.throws(
      () => installGates(projectDir, build, [antigravityCli], 'reacty'),
      /permits an ordinary read/,
      'a gate that blocks everything is broken too, just less dangerously',
    );
  } finally {
    process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

check('a missing shim in the build is caught', () => {
  const { root, home, projectDir } = makeProject();
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.throws(
      () => installGates(projectDir, join(root, 'no-such-pipeline-dir'), [antigravityCli], 'reacty'),
      /missing from this build/,
    );
  } finally {
    process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

check('a Claude-only run installs nothing extra and still starts', () => {
  const { root, home, projectDir } = makeProject();
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // Claude's gate is installed by the caller alongside settings.json and has
    // its own contract suite; this must not invent a second install path.
    installGates(projectDir, pipelineDir, [claudeCli], 'reacty');
  } finally {
    process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

let failures = 0;
for (const { name, fn } of checks) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}`);
    console.error(`  ${err.message.split('\n')[0]}`);
  }
}

if (failures > 0) {
  console.error(`\nGate install failed: ${failures} check(s).`);
  process.exit(1);
}

console.log(`\nGate install passed: ${checks.length} check(s).`);
