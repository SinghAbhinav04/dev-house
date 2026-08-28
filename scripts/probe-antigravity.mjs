#!/usr/bin/env node

/**
 * Find out what the Antigravity CLI actually sends, rather than what the docs
 * say it sends.
 *
 * Run manually — it spawns real `agy` turns, so it spends tokens on whatever
 * account `agy` is logged into, and it deliberately provokes file writes, so it
 * works in a throwaway directory and never in a real project.
 *
 *   node scripts/probe-antigravity.mjs [--keep]
 *
 * The one that matters is the tool-argument key names. The gate shim has to
 * read a path out of `toolCall.args` to decide anything about it; if it reads
 * the wrong key it gets an empty string, and an empty path resolves to the
 * project root, which is a path the gate ALLOWS. So a typo here is not a broken
 * gate that fails loudly — it is a gate that quietly permits every write. The
 * docs name exactly one key (`run_command`'s `CommandLine`), so the rest have
 * to be observed.
 *
 * Output is written to scripts/fixtures/ so the decoder and shim tests can run
 * against a real captured stream without needing `agy` in CI.
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(scriptsDir, 'fixtures');

const KEEP = process.argv.includes('--keep');

// Long enough that a slow turn is not mistaken for a hang, short enough that a
// wedged one does not sit here forever.
const TURN_TIMEOUT_MS = 240_000;

function heading(text) {
  console.log(`\n\x1b[1m── ${text} ${'─'.repeat(Math.max(0, 62 - text.length))}\x1b[0m`);
}

function agyVersion() {
  try {
    return execFileSync('agy', ['--version'], { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

/**
 * A project directory with a hook that records every tool call and allows it.
 *
 * The hook must ALLOW, or the turn stops at the first tool and we learn the
 * shape of exactly one call. Recording and deciding are separate jobs; this
 * script only does the first.
 */
function makeProbeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'hackeroom-agy-probe-'));
  const log = join(dir, 'hook-calls.ndjson');
  const recorder = join(dir, 'record-hook.sh');

  mkdirSync(join(dir, '.agents'), { recursive: true });

  // Some real files to act on, so the tools have something to name.
  writeFileSync(join(dir, 'notes.txt'), 'the secret word is banana\nsecond line\n');
  writeFileSync(join(dir, 'other.txt'), 'nothing interesting here\n');

  writeFileSync(
    recorder,
    [
      '#!/usr/bin/env bash',
      '# Records what the hook was handed, then allows it.',
      'INPUT=$(cat)',
      `LOG=${JSON.stringify(log)}`,
      'printf \'%s\\n\' "$(jq -c --arg pwd "$PWD" --arg argv0 "$0" \\',
      '  --arg pipeline_agent "${PIPELINE_AGENT-<unset>}" \\',
      '  --arg security_mode "${PIPELINE_SECURITY_MODE-<unset>}" \\',
      '  \'{stdin: ., env: {PIPELINE_AGENT: $pipeline_agent, PIPELINE_SECURITY_MODE: $security_mode}, pwd: $pwd, argv0: $argv0}\' \\',
      '  <<<"$INPUT" 2>/dev/null || echo "{\\"unparseable\\": true}")" >> "$LOG"',
      '# No output and exit 0 = proceed. A deny would be {"decision":"deny",...}.',
      'exit 0',
    ].join('\n')
  );
  execFileSync('chmod', ['+x', recorder]);

  writeFileSync(
    join(dir, '.agents', 'hooks.json'),
    JSON.stringify(
      {
        'hackeroom-probe': {
          // "*" is the documented catch-all. If this does not fire for every
          // tool, deny-by-default is impossible on this CLI and that is a
          // finding in itself.
          PreToolUse: [{ matcher: '*', hooks: [{ command: recorder, timeout: 30 }] }],
        },
      },
      null,
      2
    )
  );

  return { dir, log };
}

function runAgy(args, { cwd, env }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('agy', args, {
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
      // Not every line is an event; the CLI may write anything to stdout.
    }
  }
  return events;
}

function readHookCalls(log) {
  if (!existsSync(log)) return [];
  return parseNdjson(readFileSync(log, 'utf8'));
}

/** The question this whole script exists to answer. */
function summariseArgKeys(calls) {
  const byTool = new Map();

  for (const call of calls) {
    const toolCall = call?.stdin?.toolCall;
    const name = toolCall?.name;
    if (typeof name !== 'string') continue;

    if (!byTool.has(name)) byTool.set(name, { keys: new Set(), sample: null });
    const entry = byTool.get(name);

    for (const key of Object.keys(toolCall.args ?? {})) entry.keys.add(key);
    if (!entry.sample) entry.sample = toolCall.args ?? {};
  }

  return byTool;
}

async function main() {
  const version = agyVersion();
  if (!version) {
    console.error('agy is not on PATH. Install it, or skip this probe.');
    process.exit(1);
  }

  try {
    execFileSync('jq', ['--version'], { stdio: 'ignore' });
  } catch {
    console.error('jq is not on PATH. The recorder hook needs it, and so does the real gate.');
    process.exit(1);
  }

  console.log(`\x1b[1mProbing agy ${version}\x1b[0m`);
  console.log('This spawns real turns and spends tokens on the logged-in account.');

  const { dir, log } = makeProbeProject();
  console.log(`Scratch project: ${dir}`);

  const report = { agyVersion: version, probedAt: new Date().toISOString() };

  // ── Turn 1: provoke as many distinct tools as possible ──────────────
  heading('Turn 1 — tool coverage');

  const prompt = [
    'Do all of these, in order, using your tools:',
    '1. List the files in this directory.',
    '2. Read notes.txt and tell me the secret word.',
    '3. Search this directory for the text "interesting".',
    '4. Create a file called probe-output.txt containing exactly: hello',
    '5. Run the shell command: echo probe-ran',
    'Then reply with a one-line summary.',
  ].join('\n');

  const turn1 = await runAgy(
    [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--add-dir', dir,
      '--mode', 'accept-edits',
      '--print-timeout', '4m',
    ],
    {
      cwd: dir,
      // The real gate reads identity from here. Whether it survives into the
      // hook process is the second thing this probe answers.
      env: { PIPELINE_AGENT: 'probe-member', PIPELINE_SECURITY_MODE: 'fast' },
    }
  );

  console.log(`exit=${turn1.code} timedOut=${turn1.timedOut} ${(turn1.ms / 1000).toFixed(1)}s`);
  if (turn1.stderr.trim()) console.log(`stderr: ${turn1.stderr.trim().slice(0, 400)}`);

  const events = parseNdjson(turn1.stdout);
  report.streamEventCount = events.length;

  if (events.length === 0) {
    console.log('\n\x1b[31mNo stream events parsed.\x1b[0m Raw stdout head:');
    console.log(turn1.stdout.slice(0, 1200) || '(empty)');
  }

  // ── Turn 1b: the tools the first turn never reached ────────────────
  //
  // Headless mode auto-DENIES any tool that would need an interactive
  // permission prompt, so the first turn stops at the first write and we never
  // see run_command's or replace_file_content's arguments.
  //
  // Getting past it with --dangerously-skip-permissions answers a second and
  // much more important question at the same time: whether that flag also
  // skips PreToolUse hooks. If it does, the flag removes the gate entirely and
  // no member may ever be allowed to use it.
  heading('Turn 1b — skip-permissions, and does it skip the hook?');

  const callsBeforeSkip = readHookCalls(log).length;

  const turn1b = await runAgy(
    [
      '-p', [
        'Do both of these using your tools:',
        '1. Run the shell command: echo probe-ran',
        '2. Edit notes.txt so the second line reads: edited by the probe',
      ].join('\n'),
      '--output-format', 'stream-json',
      '--add-dir', dir,
      '--dangerously-skip-permissions',
      '--print-timeout', '4m',
    ],
    { cwd: dir, env: { PIPELINE_AGENT: 'probe-member', PIPELINE_SECURITY_MODE: 'fast' } }
  );

  const callsAfterSkip = readHookCalls(log).length;
  const hookFiredUnderSkip = callsAfterSkip > callsBeforeSkip;

  console.log(`exit=${turn1b.code} ${(turn1b.ms / 1000).toFixed(1)}s`);
  console.log(`hook calls before=${callsBeforeSkip} after=${callsAfterSkip}`);
  console.log(`\nPreToolUse still fires under --dangerously-skip-permissions: \x1b[1m${hookFiredUnderSkip}\x1b[0m`);

  report.hookFiresUnderSkipPermissions = hookFiredUnderSkip;

  if (!hookFiredUnderSkip) {
    console.log('\x1b[31mThat flag removes the gate. bypassPermissions must be refused for this CLI.\x1b[0m');
  } else {
    console.log('The gate survives the flag, so it only widens what the CLI itself would ask about.');
  }

  // ── What the stream looks like ──────────────────────────────────────
  heading('Stream shape');

  const eventKinds = new Map();
  const stepTypes = new Set();
  const usageKeys = new Set();
  let resultEvent = null;
  let initEvent = null;

  for (const event of events) {
    const kind = event.event ?? '(no "event" key)';
    eventKinds.set(kind, (eventKinds.get(kind) ?? 0) + 1);

    if (event.event === 'init') initEvent = event;
    if (event.event === 'result') resultEvent = event;

    const step = event.step_update;
    if (step) {
      if (step.step_type) stepTypes.add(step.step_type);
      for (const key of Object.keys(step.usage ?? {})) usageKeys.add(key);
    }
    for (const key of Object.keys(event.result?.usage ?? {})) usageKeys.add(key);
  }

  console.log('event types:', Object.fromEntries(eventKinds));
  console.log('step_type values:', [...stepTypes].sort().join(', ') || '(none seen)');
  console.log('usage fields:', [...usageKeys].sort().join(', ') || '(none seen)');

  report.eventKinds = Object.fromEntries(eventKinds);
  report.stepTypes = [...stepTypes].sort();
  report.usageFields = [...usageKeys].sort();

  if (initEvent) {
    const tools = initEvent.init?.tools ?? [];
    console.log(`init.tools (${tools.length}):`, tools.join(', ') || '(none)');
    report.initTools = tools;
    report.initKeys = Object.keys(initEvent.init ?? {});
  } else {
    console.log('\x1b[33mNo init event.\x1b[0m The tool list cannot be checked at runtime.');
  }

  if (resultEvent) {
    console.log('result keys:', Object.keys(resultEvent.result ?? {}).sort().join(', '));
    console.log('result.status:', resultEvent.result?.status);
    report.resultKeys = Object.keys(resultEvent.result ?? {}).sort();
    report.resultStatus = resultEvent.result?.status;
    report.conversationId = resultEvent.result?.conversation_id ?? initEvent?.conversation_id ?? null;
    report.resultUsage = resultEvent.result?.usage ?? null;
  }

  // ── THE question: argument key names per tool ───────────────────────
  heading('Tool argument keys (the fail-open risk)');

  const calls = readHookCalls(log);
  report.hookCallCount = calls.length;

  if (calls.length === 0) {
    console.log('\x1b[31mThe hook never fired.\x1b[0m');
    console.log('Either matcher "*" does not match, or hooks.json was not read from .agents/.');
    console.log('Antigravity cannot be gated this way if this stays empty.');
  } else {
    const byTool = summariseArgKeys(calls);
    report.toolArgKeys = {};

    for (const [tool, { keys, sample }] of [...byTool].sort()) {
      const keyList = [...keys].sort();
      console.log(`  ${tool.padEnd(28)} ${keyList.join(', ')}`);
      report.toolArgKeys[tool] = { keys: keyList, sample };
    }

    // ── Identity, and where the hook runs ────────────────────────────
    heading('Identity and hook environment');

    const first = calls[0];
    const agentSeen = first?.env?.PIPELINE_AGENT;
    console.log(`PIPELINE_AGENT in hook: ${agentSeen}`);
    console.log(`PIPELINE_SECURITY_MODE: ${first?.env?.PIPELINE_SECURITY_MODE}`);
    console.log(`hook pwd:               ${first?.pwd}`);
    console.log(`hook $0:                ${first?.argv0}`);
    console.log(`stdin top-level keys:   ${Object.keys(first?.stdin ?? {}).sort().join(', ')}`);

    report.hookEnv = first?.env ?? null;
    report.hookPwd = first?.pwd ?? null;
    report.hookStdinKeys = Object.keys(first?.stdin ?? {}).sort();
    report.identityReachesHook = agentSeen === 'probe-member';

    if (!report.identityReachesHook) {
      console.log('\n\x1b[33mThe gate cannot read identity from the environment.\x1b[0m');
      console.log('It will need the active-member file fallback instead.');
    }
  }

  // ── Does resuming replay the conversation? ──────────────────────────
  heading('Conversation replay on resume');

  if (!report.conversationId) {
    console.log('No conversation id captured; skipping.');
  } else {
    const turn2 = await runAgy(
      [
        '-p', 'Without using any tools, what was the secret word you read earlier?',
        '--output-format', 'stream-json',
        '--conversation', report.conversationId,
        '--add-dir', dir,
        '--print-timeout', '4m',
      ],
      { cwd: dir, env: { PIPELINE_AGENT: 'probe-member' } }
    );

    const turn2Events = parseNdjson(turn2.stdout);
    const turn2Result = turn2Events.find((e) => e.event === 'result')?.result;
    const answer = String(turn2Result?.response ?? '');

    // If the transcript came back, the model can answer from it. If it did not,
    // it has no idea -- and that is what decides whether team memory can be
    // sent as a delta on resumed turns.
    const remembered = /banana/i.test(answer);
    console.log(`answer: ${answer.slice(0, 200).replace(/\n/g, ' ')}`);
    console.log(`\nresumeReplaysTranscript: \x1b[1m${remembered}\x1b[0m`);

    report.resumeReplaysTranscript = remembered;
    report.turn2Usage = turn2Result?.usage ?? null;

    // Cumulative vs delta falls out of the same pair.
    const first = report.resultUsage?.total_tokens;
    const second = turn2Result?.usage?.total_tokens;
    if (typeof first === 'number' && typeof second === 'number') {
      const cumulative = second >= first;
      console.log(`turn1 total_tokens=${first} turn2 total_tokens=${second}`);
      console.log(`usageReporting: \x1b[1m${cumulative ? 'cumulative' : 'delta'}\x1b[0m (inferred)`);
      report.usageReportingInferred = cumulative ? 'cumulative' : 'delta';
    }
  }

  // ── Freeze it ───────────────────────────────────────────────────────
  heading('Fixtures');

  mkdirSync(fixturesDir, { recursive: true });

  // These get committed, so they must not carry whoever ran the probe. agy
  // puts its transcript and artifact directories under the user's home and
  // names both in every hook payload.
  const home = process.env.HOME ?? '';
  const scrub = (text) => {
    let out = text.split(dir).join('/tmp/probe-project');
    if (home) out = out.split(home).join('$HOME');
    return out;
  };

  const streamFile = join(fixturesDir, 'antigravity-stream.ndjson');
  writeFileSync(streamFile, `${scrub(turn1.stdout.trimEnd())}\n`);
  console.log(`stream  → ${streamFile}`);

  const hookFile = join(fixturesDir, 'antigravity-hook-payloads.json');
  writeFileSync(hookFile, `${scrub(JSON.stringify(calls, null, 2))}\n`);
  console.log(`hooks   → ${hookFile}`);

  const reportFile = join(fixturesDir, 'antigravity-probe-report.json');
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report  → ${reportFile}`);

  if (KEEP) {
    console.log(`\nScratch project kept at ${dir}`);
  } else {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log('\nDone. The tool argument keys are the part to check by eye.');
}

main().catch((err) => {
  console.error('\n[probe failed]', err);
  process.exit(1);
});
