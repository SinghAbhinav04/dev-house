#!/usr/bin/env node

/**
 * Find out what OpenCode actually sends, rather than what the docs say.
 *
 * Run manually — it spawns a real turn, so it spends tokens on whatever
 * provider is connected, and it provokes file writes, so it works in a
 * throwaway directory and never in a real project. It picks a free model where
 * one is available.
 *
 *   node scripts/probe-opencode.mjs [--keep] [--model provider/model]
 *
 * Two things matter most:
 *
 * 1. Whether the gate plugin fires at all, and which directory it loads from.
 *    The docs say `.opencode/plugins/` in one place and the singular elsewhere,
 *    and getting it wrong means a gate that is present, valid, and never
 *    consulted — a run that looks enforced and is not. So both are planted and
 *    the plugin reports which one it was loaded from.
 *
 * 2. The exact argument names on `output.args` per tool. The gate reads a path
 *    out of those to judge a write; a name that does not exist yields undefined,
 *    and a permissive shim would let it through.
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(scriptsDir, 'fixtures');

const argv = process.argv.slice(2);
const KEEP = argv.includes('--keep');
const MODEL = argv[argv.indexOf('--model') + 1] || '';

const TURN_TIMEOUT_MS = 240_000;

function heading(text) {
  console.log(`\n\x1b[1m── ${text} ${'─'.repeat(Math.max(0, 62 - text.length))}\x1b[0m`);
}

function opencodeVersion() {
  try {
    return execFileSync('opencode', ['--version'], { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

/** A free model if the install has one, so probing costs nothing. */
function pickModel() {
  if (MODEL) return MODEL;
  try {
    const models = execFileSync('opencode', ['models'], { encoding: 'utf8' }).split('\n').map((m) => m.trim());
    return models.find((m) => m.startsWith('opencode/') && m.includes('free')) || models.find(Boolean) || '';
  } catch {
    return '';
  }
}

/**
 * A project with a recording plugin planted in both candidate directories.
 *
 * The plugin ALLOWS everything and only records — recording and deciding are
 * separate jobs, and a plugin that threw would stop the turn at the first tool
 * and teach us the shape of exactly one call.
 */
function makeProbeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'hackeroom-oc-probe-'));
  const log = join(dir, 'plugin-calls.ndjson');

  writeFileSync(join(dir, 'notes.txt'), 'the secret word is pomegranate\nsecond line\n');

  const plugin = (loadedFrom) => `
// Records every tool call, then allows it.
import { appendFileSync } from "node:fs";

export const HackeroomProbe = async (ctx) => {
  return {
    "tool.execute.before": async (input, output) => {
      try {
        appendFileSync(${JSON.stringify(log)}, JSON.stringify({
          loadedFrom: ${JSON.stringify(loadedFrom)},
          input,
          args: output?.args ?? null,
          outputKeys: output ? Object.keys(output) : [],
          ctxKeys: ctx ? Object.keys(ctx) : [],
          env: {
            PIPELINE_AGENT: process.env.PIPELINE_AGENT ?? "<unset>",
            PIPELINE_SECURITY_MODE: process.env.PIPELINE_SECURITY_MODE ?? "<unset>",
          },
          cwd: process.cwd(),
        }) + "\\n");
      } catch {}
    },
  };
};
`;

  // Both spellings; the plugin says which one it came from.
  for (const name of ['plugin', 'plugins']) {
    const target = join(dir, '.opencode', name);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'hackeroom-probe.js'), plugin(name));
  }

  return { dir, log };
}

function runOpencode(args, { cwd, env }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('opencode', args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, TURN_TIMEOUT_MS);

    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n${err.message}`, code: null, timedOut, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut, ms: Date.now() - started });
    });
  });
}

function parseNdjson(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Not every line is an event.
    }
  }
  return events;
}

async function main() {
  const version = opencodeVersion();
  if (!version) {
    console.error('opencode is not on PATH.');
    process.exit(1);
  }

  const model = pickModel();
  console.log(`\x1b[1mProbing opencode ${version}\x1b[0m`);
  console.log(`Model: ${model || '(install default)'}`);
  console.log('This spawns a real turn and spends tokens on the connected provider.');

  const { dir, log } = makeProbeProject();
  console.log(`Scratch project: ${dir}`);

  const report = { opencodeVersion: version, model, probedAt: new Date().toISOString() };

  heading('Turn 1 — tool coverage');

  const prompt = [
    'Do all of these using your tools, then reply with one short line:',
    '1. Read notes.txt and tell me the secret word.',
    '2. Create a file called probe-output.txt containing exactly: hello',
    '3. Run the shell command: echo probe-ran',
  ].join('\n');

  const turn1 = await runOpencode(
    [
      'run', prompt,
      '--format', 'json',
      '--dir', dir,
      ...(model ? ['--model', model] : []),
    ],
    {
      cwd: dir,
      env: { PIPELINE_AGENT: 'probe-member', PIPELINE_SECURITY_MODE: 'fast' },
    }
  );

  console.log(`exit=${turn1.code} timedOut=${turn1.timedOut} ${(turn1.ms / 1000).toFixed(1)}s`);
  if (turn1.stderr.trim()) console.log(`stderr: ${turn1.stderr.trim().slice(0, 500)}`);

  const events = parseNdjson(turn1.stdout);
  report.streamEventCount = events.length;

  heading('Stream shape');

  if (events.length === 0) {
    console.log('\x1b[31mNo events parsed.\x1b[0m Raw stdout head:');
    console.log(turn1.stdout.slice(0, 1500) || '(empty)');
  } else {
    const kinds = new Map();
    const topLevelKeys = new Set();
    for (const event of events) {
      const kind = event.type ?? event.event ?? '(no type key)';
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      for (const key of Object.keys(event)) topLevelKeys.add(key);
    }
    console.log('event types:', Object.fromEntries(kinds));
    console.log('top-level keys seen:', [...topLevelKeys].sort().join(', '));

    report.eventKinds = Object.fromEntries(kinds);
    report.topLevelKeys = [...topLevelKeys].sort();

    console.log('\nfirst event:', JSON.stringify(events[0]).slice(0, 400));
    console.log('last event: ', JSON.stringify(events[events.length - 1]).slice(0, 400));
    report.sessionIdSeen = events.find((e) => e.sessionID || e.sessionId)?.sessionID ?? null;
  }

  heading('Did the gate plugin fire, and from where?');

  const calls = existsSync(log) ? parseNdjson(readFileSync(log, 'utf8')) : [];
  report.pluginCallCount = calls.length;

  if (calls.length === 0) {
    console.log('\x1b[31mThe plugin never ran.\x1b[0m');
    console.log('Neither .opencode/plugin/ nor .opencode/plugins/ was loaded from the project.');
    console.log('OpenCode cannot be gated this way if this stays empty.');
  } else {
    const dirs = [...new Set(calls.map((c) => c.loadedFrom))];
    console.log(`plugin fired ${calls.length} time(s), loaded from: \x1b[1m.opencode/${dirs.join(', .opencode/')}\x1b[0m`);
    report.pluginDirs = dirs;

    const first = calls[0];
    console.log(`input keys:      ${Object.keys(first.input ?? {}).sort().join(', ')}`);
    console.log(`output keys:     ${first.outputKeys.join(', ')}`);
    console.log(`plugin ctx keys: ${first.ctxKeys.join(', ')}`);
    console.log(`PIPELINE_AGENT:  ${first.env.PIPELINE_AGENT}`);
    console.log(`plugin cwd:      ${first.cwd}`);

    report.pluginInputKeys = Object.keys(first.input ?? {}).sort();
    report.pluginCtxKeys = first.ctxKeys;
    report.identityReachesPlugin = first.env.PIPELINE_AGENT === 'probe-member';

    heading('Tool argument names (the fail-open risk)');

    const byTool = new Map();
    for (const call of calls) {
      const tool = call.input?.tool;
      if (typeof tool !== 'string') continue;
      if (!byTool.has(tool)) byTool.set(tool, { keys: new Set(), sample: null });
      const entry = byTool.get(tool);
      for (const key of Object.keys(call.args ?? {})) entry.keys.add(key);
      if (!entry.sample) entry.sample = call.args;
    }

    report.toolArgKeys = {};
    for (const [tool, { keys, sample }] of [...byTool].sort()) {
      const list = [...keys].sort();
      console.log(`  ${tool.padEnd(20)} ${list.join(', ')}`);
      report.toolArgKeys[tool] = { keys: list, sample };
    }

    if (!report.identityReachesPlugin) {
      console.log('\n\x1b[33mIdentity does not reach the plugin.\x1b[0m It will need a file fallback.');
    }
  }

  heading('Fixtures');

  mkdirSync(fixturesDir, { recursive: true });

  const home = process.env.HOME ?? '';
  const scrub = (text) => {
    let out = text.split(dir).join('/tmp/probe-project');
    if (home) out = out.split(home).join('$HOME');
    return out;
  };

  const streamFile = join(fixturesDir, 'opencode-stream.ndjson');
  writeFileSync(streamFile, `${scrub(turn1.stdout.trimEnd())}\n`);
  console.log(`stream  → ${streamFile}`);

  const pluginFile = join(fixturesDir, 'opencode-plugin-calls.json');
  writeFileSync(pluginFile, `${scrub(JSON.stringify(calls, null, 2))}\n`);
  console.log(`plugin  → ${pluginFile}`);

  const reportFile = join(fixturesDir, 'opencode-probe-report.json');
  writeFileSync(reportFile, `${scrub(JSON.stringify(report, null, 2))}\n`);
  console.log(`report  → ${reportFile}`);

  if (KEEP) console.log(`\nScratch project kept at ${dir}`);
  else rmSync(dir, { recursive: true, force: true });

  console.log('\nDone. The plugin directory and the argument names are the parts to check by eye.');
}

main().catch((err) => {
  console.error('\n[probe failed]', err);
  process.exit(1);
});
