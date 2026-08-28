import assert from 'node:assert/strict';

import {
  CLI_IDS,
  DEFAULT_CLI,
  isCliId,
} from '../src/lib/cli/types.ts';
import {
  availableClis,
  findCli,
  requireCli,
  resolveCli,
} from '../src/lib/cli/registry.ts';
import { claudeCli } from '../src/lib/cli/claude.ts';
import { EFFORT_LEVELS, PERMISSION_MODES } from '../src/lib/team/types.ts';

// ── Ids ──────────────────────────────────────────────────────────────

assert.ok(isCliId('claude'));
assert.ok(isCliId('opencode'));
assert.ok(isCliId('antigravity'));
assert.equal(isCliId('gpt'), false);
assert.equal(isCliId(''), false);
assert.equal(isCliId(undefined), false);
assert.equal(isCliId(null), false);
assert.equal(isCliId(1), false, 'a number is not an id, and must not throw on .includes');

assert.equal(DEFAULT_CLI, 'claude', 'the default is what every existing member is already running');

// ── The registry only offers what it can actually run ────────────────
//
// An id existing in CLI_IDS is a promise about the vocabulary; an adapter
// existing is a promise the run will work. Those are deliberately separate:
// a half-finished adapter must not appear in the UI before its gate can be
// installed and self-tested.

const available = availableClis().map((cli) => cli.id);
assert.deepEqual(available.sort(), ['antigravity', 'claude'], 'Claude Code and Antigravity have adapters');

for (const id of available) {
  assert.ok(CLI_IDS.includes(id), `${id} is a known id`);
}

assert.equal(findCli('claude'), claudeCli);
assert.equal(findCli('opencode'), null, 'a known id with no adapter yet resolves to nothing');
assert.equal(findCli('nonsense'), null);
assert.equal(findCli(undefined), null);

// Every registered adapter has to be complete enough to actually spawn with.
for (const cli of availableClis()) {
  assert.ok(cli.binary, `${cli.id} names a binary`);
  assert.ok(cli.label, `${cli.id} has a label for the UI`);
  assert.ok(cli.models.length > 0, `${cli.id} offers at least one model`);
  assert.ok(
    cli.models.some((model) => model.id === cli.defaultModel) || cli.defaultModel.length > 0,
    `${cli.id} has a default model`,
  );
  assert.ok(cli.permissionModes.length > 0, `${cli.id} accepts at least one permission mode`);
  assert.equal(typeof cli.buildArgs, 'function', `${cli.id} can build a command line`);
  assert.equal(typeof cli.tools.toCanonical, 'function', `${cli.id} can translate tool names`);
}

// ── resolveCli falls back; requireCli does not ───────────────────────
//
// Two behaviours on purpose. Reading a roster written before members had a
// CLI must not fail, so resolveCli falls back. But silently falling back
// where someone DID choose would run a member on an engine its owner did not
// pick, with a different model vocabulary and a gate written for something
// else -- so requireCli refuses and names what is missing.

assert.equal(resolveCli(undefined), claudeCli, 'a roster with no cli field reads as Claude Code');
assert.equal(resolveCli(''), claudeCli);
assert.equal(resolveCli('opencode'), claudeCli, 'an id with no adapter falls back rather than crashing a live run');

assert.equal(requireCli('claude'), claudeCli);
assert.throws(
  () => requireCli('opencode'),
  /No adapter for CLI 'opencode'/,
  'refusing names the CLI that is missing',
);
assert.throws(
  () => requireCli('opencode'),
  /can run: /,
  'and what this build can run instead',
);
assert.throws(() => requireCli(undefined), /No adapter/);

// ── The Claude adapter describes Claude Code ─────────────────────────

assert.equal(claudeCli.binary, 'claude');
assert.match(claudeCli.containerBinary, /\/claude$/, 'the container needs an absolute path, not a PATH lookup');

assert.equal(claudeCli.support.structuredOutput, 'native', 'it enforces --json-schema itself');
assert.equal(claudeCli.support.systemPrompt, 'file-flag');
assert.equal(claudeCli.support.skills, 'session-plugin-dir');
assert.equal(
  claudeCli.support.resumeReplaysTranscript,
  true,
  'the memory delta depends on this: a resumed turn is only safe to send the delta to if the transcript comes back',
);
assert.equal(claudeCli.support.reportsTokens, true);
assert.equal(claudeCli.support.reportsCost, true);

assert.deepEqual(claudeCli.efforts, EFFORT_LEVELS, 'Claude Code defines the effort vocabulary');
assert.deepEqual(claudeCli.permissionModes, PERMISSION_MODES);

// Claude's tool names ARE the canonical set, so translation is identity.
for (const tool of ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent']) {
  assert.equal(claudeCli.tools.toCanonical(tool), tool, `${tool} maps to itself`);
}

// The arg keys are what a gate shim reads a path or command out of. A wrong
// key here means the gate sees an empty path, which resolves to the project
// root -- a path it allows. That is a silent fail-open, so pin them.
assert.equal(claudeCli.tools.argKeys.Bash.command, 'command');
assert.equal(claudeCli.tools.argKeys.Read.path, 'file_path');
assert.equal(claudeCli.tools.argKeys.Write.path, 'file_path');
assert.equal(claudeCli.tools.argKeys.Edit.path, 'file_path');
assert.equal(claudeCli.tools.argKeys.NotebookEdit.path, 'notebook_path', 'notebooks use their own key');

// Every tool the gate makes a path or command decision about needs an entry.
for (const tool of ['Read', 'Write', 'Edit', 'NotebookEdit', 'Bash']) {
  assert.ok(claudeCli.tools.argKeys[tool], `${tool} has arg keys the gate can read`);
}

assert.equal(typeof claudeCli.createDecoder, 'function');
assert.notEqual(
  claudeCli.createDecoder(),
  claudeCli.createDecoder(),
  'a decoder is per spawn — sharing one would leak tool-call correlation between turns',
);

console.log('cli registry checks passed');
