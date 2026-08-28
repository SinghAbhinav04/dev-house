/**
 * Claude Code as an `AgentCli`.
 *
 * The reference implementation, and the one whose vocabulary the others
 * translate into. Everything here was previously spelled out inline in the
 * runner and the orchestrator; naming it as an adapter is what lets a second
 * CLI be added rather than woven in.
 */

import { createClaudeDecoder, type CanonicalTool } from './decoder.ts';
import { hasValue, resolvePermissionMode } from './args.ts';
import type { AgentCli, PathLayout, SpawnRequest } from './types.ts';
import { EFFORT_LEVELS, MODEL_ALIASES, PERMISSION_MODES } from '../team/types.ts';

/**
 * Claude Code takes `dangerously-skip-permissions` as its own flag rather than
 * as a `--permission-mode` value. Legacy spelling from the run-level toggle.
 */
function permissionArgs(request: SpawnRequest): string[] {
  const mode = resolvePermissionMode(request);
  if (mode === 'dangerously-skip-permissions') return ['--dangerously-skip-permissions'];
  return ['--permission-mode', mode];
}

export const claudeCli: AgentCli = {
  id: 'claude',
  label: 'Claude Code',
  binary: 'claude',
  // Installed globally in the agent image, where the global npm prefix is not
  // on PATH for a non-login shell.
  containerBinary: '/usr/local/share/npm-global/bin/claude',

  support: {
    structuredOutput: 'native',
    systemPrompt: 'file-flag',
    skills: 'session-plugin-dir',
    // `--resume` replays the prior transcript, which is what lets the memory
    // block be sent as a delta rather than in full on every turn.
    resumeReplaysTranscript: true,
    reportsTokens: true,
    reportsCost: true,
    // Each result event carries only that turn's consumption.
    usageReporting: 'delta',
  },

  efforts: EFFORT_LEVELS,
  permissionModes: PERMISSION_MODES,

  // Aliases the CLI resolves itself. A member may also carry a fully qualified
  // id, which is why `model` is not validated against this list.
  models: MODEL_ALIASES.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })),
  defaultModel: 'sonnet',

  tools: {
    // Claude Code defines the canonical vocabulary, so this is identity.
    toCanonical: (nativeTool: string): CanonicalTool => nativeTool,
    argKeys: {
      Read: { path: 'file_path' },
      Write: { path: 'file_path', content: 'content' },
      Edit: { path: 'file_path' },
      NotebookEdit: { path: 'notebook_path' },
      Bash: { command: 'command' },
      Glob: { pattern: 'pattern' },
      Grep: { pattern: 'pattern' },
      WebFetch: { url: 'url' },
      WebSearch: { query: 'query' },
    },
  },

  createDecoder: createClaudeDecoder,

  buildArgs(request: SpawnRequest, layout: PathLayout): string[] {
    if (!hasValue(layout.roleFile) && !hasValue(request.systemPrompt)) {
      throw new Error('A turn needs either a role file or a system prompt');
    }

    const args: string[] = [
      '-p', request.prompt,
      ...permissionArgs(request),
      '--model', request.model,
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (hasValue(layout.roleFile)) {
      args.push('--system-prompt-file', layout.roleFile);
    } else if (hasValue(request.systemPrompt)) {
      args.push('--system-prompt', request.systemPrompt);
    }

    if (hasValue(request.effort)) args.push('--effort', request.effort);

    // Each member's skills are packaged as a session-scoped plugin. This is the
    // only mechanism that isolates skills per member — every member in a run
    // shares one working directory, so <cwd>/.claude/skills could not.
    for (const dir of layout.pluginDirs) args.push('--plugin-dir', dir);

    if (hasValue(request.resume)) args.push('--resume', request.resume);
    if (request.jsonSchema) args.push('--json-schema', JSON.stringify(request.jsonSchema));

    return args;
  },
};
