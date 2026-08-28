/**
 * Claude Code as an `AgentCli`.
 *
 * The reference implementation, and the one whose vocabulary the others
 * translate into. Everything here was previously spelled out inline in the
 * runner and the orchestrator; naming it as an adapter is what lets a second
 * CLI be added rather than woven in.
 */

import { createClaudeDecoder, type CanonicalTool } from './decoder.ts';
import type { AgentCli } from './types.ts';
import { EFFORT_LEVELS, PERMISSION_MODES } from '../team/types.ts';

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
};
