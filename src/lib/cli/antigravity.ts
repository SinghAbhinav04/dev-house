/**
 * Antigravity (`agy`) as an `AgentCli`.
 *
 * Flags, models and behaviour here were checked against the installed binary
 * and a real captured run, not against the documentation — see
 * `scripts/probe-antigravity.mjs` and the fixtures beside it.
 */

import { createAntigravityDecoder } from './antigravity-decoder.ts';
import { ANTIGRAVITY_TOOLS } from './antigravity-tools.ts';
import { clampEffort, hasValue, resolvePermissionMode } from './args.ts';
import type { AgentCli, CliModel, PathLayout, SpawnRequest } from './types.ts';
import type { MemberPermissionMode } from '../team/types.ts';
import { TURN_IDLE_TIMEOUT_MS } from '../pipeline-runtime.ts';

/**
 * How long agy may spend on one turn before killing it itself.
 *
 * Its default is five minutes, which is exactly our idle timeout — and the two
 * measure different things. Ours is *idle* and resets on every line of output;
 * agy's is the whole turn. Left alone, a healthy twenty-minute coding turn that
 * streams continuously would never look stalled to us and would be killed by
 * agy anyway, so every long turn would end in a mysterious truncation.
 *
 * Set well above the idle timeout, so our stall detector is the one that fires
 * first and agy's is only a backstop.
 */
const PRINT_TIMEOUT_MINUTES = Math.max(20, Math.ceil((4 * TURN_IDLE_TIMEOUT_MS) / 60_000));

/**
 * Model families, with the effort levels each comes in.
 *
 * agy's own list is the cross product — `gemini-3.7-flash-high`,
 * `-medium`, `-low` are three separate entries — and it *also* has an
 * `--effort` flag whose interaction with the suffix is undocumented. Listing
 * families and deriving the id from the member's effort keeps that a single
 * choice, and means never depending on the undocumented interaction.
 */
const MODELS: readonly CliModel[] = [
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', efforts: ['low', 'medium', 'high'] },
  // Two levels only, not three: there is no gemini-3.1-pro-medium.
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', efforts: ['low', 'high'] },
  // No variants at all; the effort setting does not apply.
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (via Antigravity)' },
  { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (via Antigravity)' },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B' },
];

const PERMISSION_MODES: readonly MemberPermissionMode[] = ['acceptEdits', 'plan', 'bypassPermissions'];

export function findAntigravityModel(id: string): CliModel | undefined {
  return MODELS.find((model) => model.id === id);
}

/**
 * The `--model` value for a family plus an effort level.
 *
 * Returns the clamp as well, so a caller can say that a member asking for
 * `max` on a model that stops at `high` got `high` — rather than it happening
 * silently.
 */
export function resolveAntigravityModel(
  model: string,
  effort: string | undefined
): { modelId: string; clampedFrom?: string } {
  const family = findAntigravityModel(model);

  // A fully qualified id the catalog does not list — including agy's own
  // suffixed names — is passed through untouched. Better to let the CLI reject
  // something it does not know than to mangle a name a user typed deliberately.
  if (!family) return { modelId: model };
  if (!family.efforts) return { modelId: family.id };

  const { effort: level, clampedFrom } = clampEffort(effort, family.efforts);
  return { modelId: level ? `${family.id}-${level}` : family.id, clampedFrom };
}

export const antigravityCli: AgentCli = {
  id: 'antigravity',
  label: 'Antigravity',
  binary: 'agy',
  // No image ships agy yet; an isolated agy member is refused at run start
  // rather than being quietly moved onto the host.
  containerBinary: 'agy',

  support: {
    // --json-schema is real, and under stream-json it applies to the final
    // result, which is exactly the verdict channel.
    structuredOutput: 'native',
    // No --system-prompt-file. The role has to be written into the project as
    // an agent definition, which puts it where every member can read it.
    systemPrompt: 'generated-agent',
    // No --plugin-dir either, so the active member's skills are written into
    // the project immediately before it spawns.
    skills: 'project-materialised',
    // Confirmed by probe: a resumed turn could answer a question about turn
    // one without using a tool.
    resumeReplaysTranscript: true,
    reportsTokens: true,
    // Confirmed by probe: there is no cost field anywhere in the stream.
    reportsCost: false,
    // Confirmed by probe: a resumed turn reported 92k where the first reported
    // 75k. Every reading is the session's running total.
    usageReporting: 'cumulative',
  },

  efforts: ['low', 'medium', 'high'],
  permissionModes: PERMISSION_MODES,
  models: MODELS,
  defaultModel: 'gemini-3.7-flash',

  tools: ANTIGRAVITY_TOOLS,
  createDecoder: createAntigravityDecoder,

  buildArgs(request: SpawnRequest, layout: PathLayout): string[] {
    const { modelId } = resolveAntigravityModel(request.model, request.effort);

    const args: string[] = [
      '--print', request.prompt,
      '--output-format', 'stream-json',
      '--model', modelId,
      // Named explicitly so agy cannot infer a different project root than the
      // one everything else in the run is working against.
      '--add-dir', request.projectDir,
      '--print-timeout', `${PRINT_TIMEOUT_MINUTES}m`,
      // A slash command could reach a subagent, which no member may spawn.
      '--disable-slash-commands',
    ];

    // Effort rides in the model id (see resolveAntigravityModel), so --effort
    // is deliberately never passed: two ways to say the same thing invites
    // them to disagree, and their interaction is undocumented.

    const mode = resolvePermissionMode(request);
    if (mode === 'plan') {
      args.push('--mode', 'plan');
    } else {
      // This flag reads far worse than it is, so: it stops *agy* asking, and
      // nothing else. Headless agy auto-DENIES any tool that would need an
      // interactive prompt, so without it a member cannot write a single file.
      // It does not disable PreToolUse hooks — confirmed by probe, the gate
      // fired under it — so Hackeroom's capability manifest remains the only
      // thing deciding what this member may do.
      args.push('--dangerously-skip-permissions');
      args.push('--mode', 'accept-edits');
    }

    // The role is carried by a generated agent definition rather than a flag;
    // `roleFile` is written into the project before the spawn and named here.
    if (hasValue(layout.roleFile)) args.push('--agent', layout.roleFile);

    if (hasValue(request.resume)) args.push('--conversation', request.resume);
    if (request.jsonSchema) args.push('--json-schema', JSON.stringify(request.jsonSchema));

    return args;
  },
};
