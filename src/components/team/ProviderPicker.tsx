'use client';

import { useEffect, useState } from 'react';

/**
 * Picking an OpenCode provider and model, and connecting a new provider.
 *
 * OpenCode reaches hundreds of models across whichever providers you have
 * credentials for, so one flat list is unusable — the provider is chosen first
 * and the model list follows from it, the way OpenCode's own picker works.
 *
 * The key field writes into OpenCode's own auth file. It exists because
 * `opencode auth login` cannot be scripted: it needs a TTY and ignores a piped
 * key, so there is no way to offer this in a browser without handling the key
 * here. It is sent once, never read back, and never stored by Hackeroom
 * anywhere else.
 */

export interface ProviderView {
  id: string;
  label: string;
  connected: boolean;
  models: { id: string; label: string }[];
}

export function ProviderPicker({
  model,
  onModel,
}: {
  /** The full `provider/model` id currently chosen, or ''. */
  model: string;
  onModel: (value: string) => void;
}) {
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [error, setError] = useState('');

  // Derived from the model id rather than held separately, so the two can
  // never drift out of step with each other.
  const [provider, setProvider] = useState(() => model.split('/')[0] ?? '');

  const [connecting, setConnecting] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');

  const load = async () => {
    try {
      const response = await fetch('/api/cli-providers');
      const data = await response.json();
      if (data.error) setError(data.error);
      else setProviders(data.providers);
    } catch {
      setError('Could not reach the provider list.');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const chosen = providers?.find((p) => p.id === provider);
  // A provider is usable when it actually offers models. OpenCode Zen has some
  // without any credentials at all, so "connected" alone would understate it.
  const usable = (p: ProviderView) => p.models.length > 0;

  const models = (chosen?.models ?? []).filter((m) =>
    filter ? m.label.toLowerCase().includes(filter.toLowerCase()) || m.id.includes(filter) : true
  );

  async function connect(providerId: string) {
    if (!apiKey.trim()) return;
    setBusy(true);
    try {
      const response = await fetch('/api/cli-providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: providerId, apiKey }),
      });
      const data = await response.json();
      if (data.error) setError(data.error);
      else {
        setProviders(data.providers);
        setError('');
        setConnecting('');
      }
    } catch {
      setError('Could not save that key.');
    } finally {
      // Cleared whatever happened, so a key never lingers in a form field.
      setApiKey('');
      setBusy(false);
    }
  }

  if (!providers) {
    return <p className="text-xs text-ink-faint">Loading providers…</p>;
  }

  return (
    <div className="space-y-3">
      {error && <p className="text-xs text-signal-bad">{error}</p>}

      <label className="block">
        <span className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">Provider</span>
        <select
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            // The model belongs to the old provider; keeping it would send a
            // name the new one has never heard of.
            onModel('');
            setFilter('');
          }}
          className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
        >
          <option value="">Choose a provider…</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id} disabled={!usable(p)}>
              {p.label}
              {usable(p) ? ` — ${p.models.length} models` : ' — not connected'}
            </option>
          ))}
        </select>
      </label>

      {chosen && !usable(chosen) && (
        <div className="rounded-md border border-line bg-surface-sunken p-3">
          {connecting === chosen.id ? (
            <div className="space-y-2">
              <p className="text-xs text-ink-soft">
                Paste your {chosen.label} API key. It goes into OpenCode’s own credential file and is
                not stored anywhere else.
              </p>
              <input
                type="password"
                value={apiKey}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="API key"
                className="w-full rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-sm text-ink outline-none focus:border-accent"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy || !apiKey.trim()}
                  onClick={() => void connect(chosen.id)}
                  className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface-sunken disabled:opacity-40"
                >
                  {busy ? 'Saving…' : 'Save key'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConnecting('');
                    setApiKey('');
                  }}
                  className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-soft"
                >
                  Cancel
                </button>
              </div>
              <p className="text-[11px] text-ink-faint">
                Rather not paste it here? Run{' '}
                <code className="rounded bg-surface px-1">opencode auth login -p {chosen.id}</code> in a
                terminal instead, then reload.
              </p>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-ink-soft">{chosen.label} has no models available yet.</p>
              <button
                type="button"
                onClick={() => setConnecting(chosen.id)}
                className="shrink-0 rounded-md border border-line px-3 py-1.5 text-sm text-ink transition-colors hover:border-accent"
              >
                Connect
              </button>
            </div>
          )}
        </div>
      )}

      {chosen && usable(chosen) && (
        <label className="block">
          <span className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">Model</span>
          {chosen.models.length > 20 && (
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Search ${chosen.models.length} models…`}
              className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
            />
          )}
          <select
            value={model}
            onChange={(e) => onModel(e.target.value)}
            className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
          >
            <option value="">Choose a model…</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {filter && models.length === 0 && (
            <p className="mt-1 text-[11px] text-ink-faint">Nothing matches “{filter}”.</p>
          )}
        </label>
      )}
    </div>
  );
}
