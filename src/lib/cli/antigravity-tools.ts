/**
 * Antigravity's tool vocabulary, translated into Claude's.
 *
 * Every name and every argument key here was observed by running the real
 * binary (`scripts/probe-antigravity.mjs`, fixtures under `scripts/fixtures/`),
 * not read off the documentation — which names exactly one of them.
 *
 * The keys are PascalCase against Claude's snake_case, and they are not
 * internally consistent: `view_file` names its path `AbsolutePath` while
 * `write_to_file` and `replace_file_content` name theirs `TargetFile`. Guessing
 * would have been wrong for every tool.
 *
 * Why that matters more than it looks: the gate reads a path out of these
 * arguments to decide whether a write is allowed. A key that does not exist
 * yields an empty string, an empty path resolves to the working directory, and
 * the working directory is inside the project root — which the gate ALLOWS. So
 * a wrong key is not a gate that breaks loudly. It is a gate that quietly
 * permits everything.
 */

import type { CanonicalTool } from './decoder.ts';
import type { ToolVocabulary } from './types.ts';

/**
 * What each Antigravity tool is, in Claude's vocabulary.
 *
 * Deliberately partial. `init.tools` reports 57 tools — browser automation,
 * notebooks, MCP, task scheduling — and anything absent from this map reaches
 * the gate under its own name and is denied by default. That is the intended
 * outcome, not an oversight: a tool nobody has looked at is a tool no member
 * should be able to call.
 */
const CANONICAL_BY_NATIVE: Readonly<Record<string, CanonicalTool>> = {
  // Reads. The gate auto-allows these, so a missing argument key cannot widen
  // anything — but they are probed regardless.
  view_file: 'Read',
  list_dir: 'Glob',
  find_by_name: 'Glob',
  grep_search: 'Grep',

  // Writes. These are the ones whose arguments the gate actually reads, so
  // ONLY tools whose key has been observed appear here. `sed_file`,
  // `notebook_edit` and `multi_replace_file_content` can all write and are
  // deliberately absent: their argument keys have not been probed, and mapping
  // them on a plausible guess is exactly the silent fail-open described above.
  // Denied by default until someone runs them and looks.
  write_to_file: 'Write',
  replace_file_content: 'Edit',

  // Commands.
  run_command: 'Bash',

  // Egress. The gate decides these on the member's `web` capability alone and
  // never looks at the arguments, so mapping them without probed keys is safe.
  read_url_content: 'WebFetch',
  search_web: 'WebSearch',

  // Sub-agents. Blocked for every member unconditionally, and the gate reads no
  // arguments to do it. Four of them here where the docs describe three —
  // `browser_subagent` only shows up in the live tool list.
  invoke_subagent: 'Agent',
  define_subagent: 'Agent',
  manage_subagents: 'Agent',
  browser_subagent: 'Agent',
};

/**
 * Where each tool keeps the values the gate needs, keyed by the tool's own
 * name rather than its canonical one — two native tools can map to the same
 * canonical tool and still name their arguments differently.
 *
 * A tool that reaches the gate's path or command branches without an entry
 * here must be denied rather than passed an empty value.
 */
const ARG_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  view_file: { path: 'AbsolutePath' },
  list_dir: { path: 'DirectoryPath' },
  grep_search: { pattern: 'Query', path: 'SearchPath' },

  write_to_file: { path: 'TargetFile', content: 'CodeContent' },
  replace_file_content: { path: 'TargetFile' },

  run_command: { command: 'CommandLine', cwd: 'Cwd' },
};

/**
 * Native tools whose gate decision depends on reading an argument.
 *
 * The shim must deny these outright when the expected value is missing, rather
 * than handing the gate an empty one. Reads are not on this list: the gate
 * allows them on the tool name alone, so a missing key there cannot widen
 * anything.
 */
export const ANTIGRAVITY_ARG_SENSITIVE_TOOLS: readonly string[] = [
  'write_to_file',
  'replace_file_content',
  'run_command',
];

export const ANTIGRAVITY_TOOLS: ToolVocabulary = {
  /**
   * Unmapped names come back unchanged, which is what makes deny-by-default
   * work: the gate does not recognise `browser_press_key` and refuses it,
   * rather than this map having to enumerate everything it should block.
   */
  toCanonical: (nativeTool: string): CanonicalTool =>
    CANONICAL_BY_NATIVE[nativeTool] ?? nativeTool,

  argKeys: ARG_KEYS,
};

/** True when this build knows what a tool is. Unknown means denied. */
export function isMappedAntigravityTool(nativeTool: string): boolean {
  return nativeTool in CANONICAL_BY_NATIVE;
}

/**
 * Rewrite a native argument object into the keys the rest of the codebase uses.
 *
 * Only the fields the gate and the event log care about are translated; the
 * rest (`toolAction`, `toolSummary`, `Overwrite`, and so on) are dropped rather
 * than carried, because nothing downstream reads them and passing them through
 * would invite someone to start.
 */
export function toCanonicalArgs(
  nativeTool: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  const keys = ARG_KEYS[nativeTool];
  if (!keys) return {};

  const out: Record<string, unknown> = {};

  // Claude's own names, because describeToolCall and the gate both read those.
  const canonicalField: Record<string, string> = {
    path: 'file_path',
    content: 'content',
    command: 'command',
    cwd: 'cwd',
    pattern: 'pattern',
  };

  for (const [field, nativeKey] of Object.entries(keys)) {
    const value = args[nativeKey];
    if (value === undefined) continue;
    out[canonicalField[field] ?? field] = value;
  }

  return out;
}
