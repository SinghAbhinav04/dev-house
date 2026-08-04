#!/usr/bin/env node

/**
 * Runs every test script in sequence and reports a summary.
 *
 * The suite is a set of standalone node scripts using node:assert rather than a
 * test framework; this is just the aggregator that `npm test` calls so nothing
 * silently stops being run.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

/** The hook contract drives a shell script and must not strip types. */
const PLAIN_NODE = new Set(['test-hook-contract.mjs']);

const suites = readdirSync(scriptsDir)
  .filter((name) => name.startsWith('test-') && name.endsWith('.mjs'))
  .sort();

if (suites.length === 0) {
  console.error('No test suites found in scripts/.');
  process.exit(1);
}

const failed = [];
const started = Date.now();

for (const suite of suites) {
  const args = PLAIN_NODE.has(suite) ? [join(scriptsDir, suite)] : ['--experimental-strip-types', join(scriptsDir, suite)];

  process.stdout.write(`\n── ${suite} ${'─'.repeat(Math.max(0, 60 - suite.length))}\n`);

  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });

  if (result.status !== 0) failed.push(suite);
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log(`\n${'═'.repeat(64)}`);

if (failed.length > 0) {
  console.error(`FAILED ${failed.length}/${suites.length} suite(s) in ${seconds}s:`);
  for (const suite of failed) console.error(`  - ${suite}`);
  process.exit(1);
}

console.log(`All ${suites.length} suite(s) passed in ${seconds}s.`);
