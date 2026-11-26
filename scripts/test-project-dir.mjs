#!/usr/bin/env node

/**
 * Which directories a request may name as a project.
 *
 * /api/approve, /api/resume-pipeline and /api/audit-action took `projectDir`
 * from the body and used it as given. Only a directory directly inside
 * ~/Builds is a project, and only that may be named.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'hackeroom-projectdir-')));
process.env.HOME = join(tempRoot, 'home');

const { buildsDir, projectDirFromRequest, resolveProjectDir } = await import('../src/lib/project-dir.ts');

const builds = join(process.env.HOME, 'Builds');
const project = join(builds, 'my-app');
const outside = join(tempRoot, 'elsewhere');

mkdirSync(join(project, 'src'), { recursive: true });
mkdirSync(join(builds, '.staging'), { recursive: true });
mkdirSync(join(builds, '.manual'), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(builds, 'a-file'), 'not a directory');
writeFileSync(join(outside, 'pipeline-pending.json'), '{"approved":null}');
// Junctions on Windows: a directory symlink there needs admin rights or
// developer mode, a junction does not, and both resolve through realpath the
// same way, which is what is under test.
const linkType = process.platform === 'win32' ? 'junction' : 'dir';
symlinkSync(outside, join(builds, 'link-out'), linkType);
symlinkSync(project, join(builds, 'link-in'), linkType);
symlinkSync(project, join(outside, 'link-to-project'), linkType);

try {
  assert.equal(buildsDir(), builds, 'the builds directory follows HOME');

  // ── What is a project ──────────────────────────────────────────────

  assert.equal(resolveProjectDir(project), project, 'a directory directly inside ~/Builds');
  assert.equal(resolveProjectDir(`${project}/`), project, 'with or without a trailing slash');
  assert.equal(resolveProjectDir(join(builds, 'other', '..', 'my-app')), project, 'however it was spelled');
  assert.equal(resolveProjectDir(join(builds, 'link-in')), project, 'a link to a project resolves to the project');
  assert.equal(resolveProjectDir(join(outside, 'link-to-project')), project, 'from wherever the link sits');

  // ── What is not ────────────────────────────────────────────────────

  const refused = [
    [outside, 'a directory somewhere else'],
    [join(builds, 'link-out'), 'a link inside ~/Builds that points somewhere else'],
    [join(project, '..', '..', '..', 'elsewhere'), 'a path that climbs out'],
    [process.env.HOME, 'the home directory'],
    [builds, '~/Builds itself'],
    [join(project, 'src'), 'a directory deeper than a project'],
    [join(builds, '.staging'), 'staging, which has no run to resume'],
    [join(builds, '.manual'), 'manual mode'],
    [join(builds, 'a-file'), 'a file'],
    [join(builds, 'does-not-exist'), 'a project that does not exist'],
    ['my-app', 'a bare name, resolved against wherever the server happens to run'],
    ['/', 'the root'],
    ['', 'an empty string'],
    [undefined, 'nothing'],
    [null, 'null'],
    [42, 'a number'],
    [[project], 'an array holding a project'],
    [{ path: project }, 'an object'],
  ];

  for (const [candidate, what] of refused) {
    assert.equal(resolveProjectDir(candidate), null, `${what} is not a project`);
  }

  // ── What a route does with the field ───────────────────────────────

  for (const absent of [undefined, null, '']) {
    assert.deepEqual(
      projectDirFromRequest(absent),
      { ok: true, projectDir: undefined },
      'no projectDir means the current project, as before'
    );
  }

  assert.deepEqual(projectDirFromRequest(project), { ok: true, projectDir: project });

  for (const bad of [outside, join(builds, 'link-out'), process.env.HOME, 42, { path: project }]) {
    const choice = projectDirFromRequest(bad);
    assert.equal(choice.ok, false, 'a projectDir that is not a project is an error');
    assert.equal('projectDir' in choice, false, 'and never a quiet fall back to the current one');
    assert.match(choice.error, /inside ~\/Builds/);
  }

  // ── The three routes use it ────────────────────────────────────────

  for (const route of ['approve', 'resume-pipeline', 'audit-action']) {
    const source = readFileSync(join(repoRoot, 'src', 'app', 'api', route, 'route.ts'), 'utf8');
    assert.match(source, /projectDirFromRequest\(/, `/api/${route} checks the projectDir it is given`);
    assert.match(source, /status: 400/, 'and answers 400 when it is not a project');
  }

  console.log('project dir checks passed');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
