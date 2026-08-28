/**
 * OpenCode's providers, their models, and which of them are connected.
 *
 * OpenCode keeps credentials in its own file, one entry per provider:
 *
 *   ~/.local/share/opencode/auth.json
 *   { "openrouter": { "type": "api", "key": "..." } }
 *
 * Hackeroom reads and writes that same file rather than keeping a second copy.
 * That is deliberate: `opencode auth login` cannot be scripted — it needs a
 * TTY and ignores a piped key, verified by probe — so offering the connect flow
 * in the UI at all means writing this file. Better one store, in OpenCode's
 * own format, than two that can disagree about what you are logged into.
 *
 * Keys are never read back out to the browser. The UI is told which providers
 * are connected, never what with.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function opencodeAuthPath(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(dataHome, 'opencode', 'auth.json');
}

export interface ProviderView {
  id: string;
  label: string;
  connected: boolean;
  /** Models this provider offers, present only once it is connected. */
  models: { id: string; label: string }[];
}

/**
 * Providers worth offering before anything is connected.
 *
 * Once a provider has credentials its models come from `opencode models`, so
 * this list only has to be good enough to get someone started — it is not the
 * source of truth for anything.
 */
const KNOWN_PROVIDERS: Readonly<Record<string, string>> = {
  opencode: 'OpenCode Zen',
  openrouter: 'OpenRouter',
  'fireworks-ai': 'Fireworks AI',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
  xai: 'xAI',
};

function prettyProvider(id: string): string {
  return (
    KNOWN_PROVIDERS[id] ??
    id.split(/[-_]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
  );
}

/** Which providers have credentials. Ids only — never the keys themselves. */
export function connectedProviders(): string[] {
  const path = opencodeAuthPath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return [];
    return Object.keys(parsed as Record<string, unknown>);
  } catch {
    return [];
  }
}

/**
 * Turn a model id into something readable.
 *
 * Ids run from `opencode/big-pickle` to
 * `fireworks-ai/accounts/fireworks/models/deepseek-v4-flash`, so the last
 * segment is the only part worth showing.
 */
function modelLabel(id: string): string {
  const leaf = id.split('/').pop() ?? id;
  return leaf.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Every model this install can reach, grouped under its provider. */
export function opencodeProviders(): ProviderView[] {
  const connected = new Set(connectedProviders());

  const byProvider = new Map<string, { id: string; label: string }[]>();
  try {
    const out = execFileSync('opencode', ['models'], { encoding: 'utf8', timeout: 30_000 });
    for (const line of out.split('\n')) {
      const id = line.trim();
      if (!id.includes('/')) continue;
      const provider = id.split('/')[0];
      const list = byProvider.get(provider) ?? [];
      list.push({ id, label: modelLabel(id) });
      byProvider.set(provider, list);
    }
  } catch {
    // A missing or failing binary means no models to offer; the picker says so
    // rather than pretending.
  }

  const ids = new Set([...Object.keys(KNOWN_PROVIDERS), ...connected, ...byProvider.keys()]);

  return [...ids]
    .map((id) => ({
      id,
      label: prettyProvider(id),
      connected: connected.has(id),
      models: byProvider.get(id) ?? [],
    }))
    // Connected first, then by how much they offer, then by name.
    .sort((a, b) =>
      a.connected !== b.connected
        ? Number(b.connected) - Number(a.connected)
        : b.models.length - a.models.length || a.label.localeCompare(b.label)
    );
}

/**
 * Connect a provider by writing OpenCode's own auth file.
 *
 * The key is written and never returned, logged, or copied anywhere else. The
 * file is created 0600 because it is a credential store, and OpenCode reads it
 * back itself on the next run.
 */
export function connectProvider(providerId: string, apiKey: string): void {
  const id = providerId.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
    throw new Error(`"${providerId}" is not a valid provider id.`);
  }

  const key = apiKey.trim();
  if (!key) throw new Error('No API key was provided.');

  const path = opencodeAuthPath();
  mkdirSync(dirname(path), { recursive: true });

  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>;
    } catch {
      // A corrupt file is not a reason to lose a working key silently.
      throw new Error(`${path} exists but could not be read as JSON. Fix or move it, then try again.`);
    }
  }

  writeFileSync(path, `${JSON.stringify({ ...existing, [id]: { type: 'api', key } }, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on filesystems that do not carry POSIX modes.
  }
}

/** Forget a provider. Removes only that entry, leaving the rest intact. */
export function disconnectProvider(providerId: string): void {
  const path = opencodeAuthPath();
  if (!existsSync(path)) return;

  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return;
  }

  delete existing[providerId];
  writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
}
