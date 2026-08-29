/**
 * OpenCode's tool vocabulary, translated into Claude's.
 *
 * Third CLI, third naming convention: `filePath` in camelCase, where Claude
 * says `file_path` and Antigravity says `TargetFile`. The four marked below as
 * observed came from running the binary (`scripts/probe-opencode.mjs`).
 *
 * The unobserved ones are mapped anyway, and that is safe here in a way it was
 * not for Antigravity — because the shim refuses when the expected value is
 * absent. A wrong key therefore denies the call rather than handing the gate an
 * empty path, so the cost of guessing wrong is a member that cannot edit, which
 * is loud, rather than a member that can write anywhere, which is silent. Each
 * one is marked so the next person knows which is which.
 */

import type { CanonicalTool } from './decoder.ts';
import type { ToolVocabulary } from './types.ts';

const CANONICAL_BY_NATIVE: Readonly<Record<string, CanonicalTool>> = {
  read: 'Read',        // observed
  write: 'Write',      // observed
  bash: 'Bash',        // observed
  glob: 'Glob',        // observed

  edit: 'Edit',        // assumed: same filePath convention as read/write
  patch: 'Edit',       // assumed
  grep: 'Grep',
  list: 'Glob',
  webfetch: 'WebFetch',

  // Loading one of the member's own attached skills. Named `skill` here and
  // `Skill` in the canonical vocabulary, where the gate allows it — the skills
  // it can reach are only the ones spawnEnv pointed it at.
  skill: 'Skill',

  // OpenCode's sub-agent tool. Blocked for everyone, and the gate reads no
  // argument to do it, so no key is needed.
  task: 'Agent',
};

const ARG_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  read: { path: 'filePath' },          // observed
  write: { path: 'filePath', content: 'content' }, // observed
  bash: { command: 'command' },        // observed
  glob: { pattern: 'pattern' },        // observed

  edit: { path: 'filePath' },          // assumed; denies if wrong
  patch: { path: 'filePath' },         // assumed; denies if wrong
  grep: { pattern: 'pattern' },
  list: { path: 'path' },
};

/** Native tools whose gate decision depends on reading an argument. */
export const OPENCODE_ARG_SENSITIVE_TOOLS: readonly string[] = ['write', 'edit', 'patch', 'bash'];

export const OPENCODE_TOOLS: ToolVocabulary = {
  toCanonical: (nativeTool: string): CanonicalTool => CANONICAL_BY_NATIVE[nativeTool] ?? nativeTool,
  argKeys: ARG_KEYS,
};

export function isMappedOpencodeTool(nativeTool: string): boolean {
  return nativeTool in CANONICAL_BY_NATIVE;
}

/** Rewrite native arguments into the keys the gate and the event log read. */
export function toCanonicalArgs(
  nativeTool: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  const keys = ARG_KEYS[nativeTool];
  if (!keys) return {};

  const canonicalField: Record<string, string> = {
    path: 'file_path',
    content: 'content',
    command: 'command',
    pattern: 'pattern',
  };

  const out: Record<string, unknown> = {};
  for (const [field, nativeKey] of Object.entries(keys)) {
    const value = args[nativeKey];
    if (value === undefined) continue;
    out[canonicalField[field] ?? field] = value;
  }
  return out;
}
