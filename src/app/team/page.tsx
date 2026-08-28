'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { useTeam, type CliOption, type TeamMemberView } from '@/lib/use-team';
import type { CliId } from '@/lib/cli/types';
import type { TeamProposal } from '@/lib/team/proposal';
import {
  EFFORT_LEVELS,
  MAX_TEAM_SIZE,
  OFFICE_FULL_MESSAGE,
  PERMISSION_MODES,
  SLOT_IDS,
  SLOT_LABELS,
  type Effort,
  type MemberPermissionMode,
  type SlotId,
} from '@/lib/team/types';

const THEMES = [
  { id: 'warm', label: 'Warm Studio' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'parchment', label: 'Parchment' },
];

const PERMISSION_HELP: Record<string, string> = {
  plan: 'Plans only. Never edits or runs anything.',
  auto: 'Claude’s safety classifier decides. The balanced default.',
  acceptEdits: 'Auto-accepts file edits. Still asks about risky commands.',
  dontAsk: 'Stops asking. Hook restrictions still apply.',
  manual: 'Asks about everything.',
  bypassPermissions: 'Skips Claude’s own checks. Only the hook stands between this member and your files.',
};

export default function TeamPage() {
  const {
    team,
    loading,
    error,
    clearError,
    createMember,
    updateMember,
    removeMember,
    setRole,
    addSkill,
    removeSkill,
    setSlotEnabled,
    setTeamCli,
    setTeamModel,
    setAutoTeam,
    setTheme,
    reload,
  } = useTeam();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const officeFull = team.members.length >= MAX_TEAM_SIZE;

  // Toasts are transient by nature; errors that need acting on stay in the
  // error banner instead.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  /**
   * The member being edited. Falls back to the first on the roster rather than
   * being written back into state, so a roster that loads after first paint
   * does not cause an extra render just to pick a default.
   */
  const selected = useMemo(
    () => team.members.find((m) => m.id === selectedId) ?? team.members[0] ?? null,
    [team.members, selectedId]
  );

  // Apply the saved theme immediately so this page previews it.
  useEffect(() => {
    if (team.roster.theme) document.documentElement.setAttribute('data-theme', team.roster.theme);
  }, [team.roster.theme]);

  return (
    <div className="min-h-screen bg-surface text-ink">
      <header className="border-b border-line bg-surface-raised">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Team</h1>
            <p className="text-xs text-ink-faint">Who is on the team, what they run on, and what they cost.</p>
          </div>

          <nav className="ml-auto flex items-center gap-1 text-sm">
            <Link href="/" className="rounded-lg px-3 py-1.5 text-ink-soft transition-colors hover:bg-surface hover:text-ink">
              Office
            </Link>
            <Link href="/squad" className="rounded-lg px-3 py-1.5 text-ink-soft transition-colors hover:bg-surface hover:text-ink">
              Squad
            </Link>
            <span className="rounded-lg bg-accent-soft px-3 py-1.5 text-accent">Team</span>
          </nav>
        </div>
      </header>

      {error && (
        <div className="mx-auto mt-4 flex max-w-7xl items-start gap-3 rounded-lg border border-signal-bad/40 bg-signal-bad/10 px-4 py-3 text-sm text-signal-bad">
          <span className="flex-1">{error}</span>
          <button type="button" onClick={clearError} className="shrink-0 text-xs underline">
            dismiss
          </button>
        </div>
      )}

      {/* The setting's whole effect: an offer, made at the moment it is useful.
          Nothing is created without going through the review below. */}
      {team.roster.workflow.autoTeam && !drafting && !officeFull && team.plan.errors.length > 0 && (
        <div className="mx-auto mt-4 flex max-w-7xl flex-wrap items-center gap-3 rounded-lg border border-accent/40 bg-accent-soft px-4 py-3 text-sm">
          <span className="flex-1 text-ink-soft">
            {team.plan.errors[0]} Describe the job and have a team drafted for it instead.
          </span>
          <button
            type="button"
            onClick={() => { setDrafting(true); setCreating(false); }}
            className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-surface-sunken transition-opacity hover:opacity-90"
          >
            Draft a team
          </button>
        </div>
      )}

      <main className="mx-auto grid max-w-7xl gap-6 px-6 py-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        {/* ── Roster ─────────────────────────────────────────────── */}
        <aside className="space-y-4">
          <section className="rounded-xl border border-line bg-surface-raised p-3">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
                Members{' '}
                <span className="font-normal normal-case tracking-normal">
                  {team.members.length}/{MAX_TEAM_SIZE}
                </span>
              </h2>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={officeFull}
                  onClick={() => { setDrafting(true); setCreating(false); }}
                  title={officeFull ? OFFICE_FULL_MESSAGE : 'Describe the job and have a team drafted for it'}
                  className="rounded-md border border-accent/40 px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Draft
                </button>
                <button
                  type="button"
                  disabled={officeFull}
                  onClick={() => { setCreating(true); setDrafting(false); }}
                  title={officeFull ? OFFICE_FULL_MESSAGE : undefined}
                  className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-surface-sunken transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  + New
                </button>
              </div>
            </div>

            {loading ? (
              <p className="py-4 text-center text-xs text-ink-faint">Loading…</p>
            ) : team.members.length === 0 ? (
              <div className="space-y-2 py-3 text-xs text-ink-faint">
                <p>No members yet. There is no built-in squad — the team is whoever you create.</p>
                <p>
                  Add one above, or run <code className="text-accent">npm run team -- starter</code> to seed one per
                  slot from the role templates.
                </p>
              </div>
            ) : (
              <ul className="space-y-1">
                {team.members.map((member) => (
                  <li key={member.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(member.id)}
                      className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors ${
                        selectedId === member.id ? 'bg-surface' : 'hover:bg-surface'
                      }`}
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: member.color }}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink">{member.name}</span>
                        <span className="block truncate text-[11px] text-ink-faint">
                          {member.slot ? SLOT_LABELS[member.slot] : 'No slot'}
                          {!member.enabled && ' · off'}
                        </span>
                      </span>
                      {member.working && (
                        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-signal-ok" title="Working" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <TeamSettings
            teamCli={team.roster.teamCli}
            teamModel={team.roster.teamModel}
            clis={team.clis ?? []}
            theme={team.roster.theme || 'warm'}
            autoTeam={team.roster.workflow.autoTeam === true}
            onTeamCli={setTeamCli}
            onTeamModel={setTeamModel}
            onAutoTeam={setAutoTeam}
            onTheme={(value) => {
              document.documentElement.setAttribute('data-theme', value);
              setTheme(value);
            }}
          />

          <WorkflowSlots
            filled={team.plan.filled}
            slots={team.roster.workflow.slots}
            phases={team.plan.phases}
            errors={team.plan.errors}
            notes={team.plan.notes}
            onToggle={setSlotEnabled}
          />
        </aside>

        {/* ── Detail ─────────────────────────────────────────────── */}
        <section className="min-w-0">
          {drafting ? (
            <DraftTeamPanel
              onCancel={() => setDrafting(false)}
              onApplied={async (created) => {
                await reload();
                setDrafting(false);
                if (created[0]) setSelectedId(created[0]);
                setToast(`Created ${created.length} member${created.length === 1 ? '' : 's'}. Read their roles before you run.`);
              }}
            />
          ) : creating ? (
            <CreateMemberForm
              templates={team.templates}
              clis={team.clis ?? []}
              teamCli={team.roster.teamCli}
              onCancel={() => setCreating(false)}
              onCreate={async (input) => {
                const result = await createMember(input);
                if (result.ok) {
                  setCreating(false);
                  setSelectedId(input.id);
                } else if (result.error === OFFICE_FULL_MESSAGE) {
                  // A full office is a normal thing to bump into, not an error
                  // to leave sitting in a red banner.
                  setToast(result.error);
                  clearError();
                  setCreating(false);
                }
                return result;
              }}
            />
          ) : selected ? (
            <MemberDetail
              key={selected.id}
              member={selected}
              clis={team.clis ?? []}
              onUpdate={(patch) => updateMember(selected.id, patch)}
              onRole={(role) => setRole(selected.id, role)}
              onAddSkill={(name, description, body) => addSkill(selected.id, name, description, body)}
              onRemoveSkill={(name) => removeSkill(selected.id, name)}
              onRemove={(deleteFiles) => removeMember(selected.id, deleteFiles)}
            />
          ) : (
            <div className="rounded-xl border border-dashed border-line px-6 py-16 text-center text-sm text-ink-faint">
              Select a member, or create one to get started.
            </div>
          )}
        </section>
      </main>

      {toast && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-xl border border-signal-warn/40 bg-surface-raised px-4 py-3 text-sm text-ink shadow-lg"
        >
          {toast}
        </div>
      )}
    </div>
  );
}

// ── Team-wide settings ─────────────────────────────────────────────

function TeamSettings({
  teamCli,
  teamModel,
  clis,
  theme,
  autoTeam,
  onTeamCli,
  onTeamModel,
  onAutoTeam,
  onTheme,
}: {
  teamCli: CliId;
  teamModel: string;
  clis: CliOption[];
  theme: string;
  autoTeam: boolean;
  onTeamCli: (value: CliId) => void;
  onTeamModel: (value: string) => void;
  onAutoTeam: (value: boolean) => void;
  onTheme: (value: string) => void;
}) {
  const cli = clis.find((option) => option.id === teamCli);
  return (
    <section className="space-y-3 rounded-xl border border-line bg-surface-raised p-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">Whole team</h2>

      <Field
        label="Auto team creation"
        hint="Offers to draft a team when the roster cannot staff a run. Drafts are always reviewed before anyone is created."
      >
        <label className="flex items-center gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={autoTeam}
            onChange={(e) => onAutoTeam(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          {autoTeam ? 'On' : 'Off'}
        </label>
      </Field>

      <Field label="Runs on" hint="What a new member gets unless you change it.">
        <select
          value={teamCli}
          onChange={(e) => onTeamCli(e.target.value as CliId)}
          className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
        >
          {clis.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Model" hint="Used by members on this CLI who have not picked their own.">
        <select
          value={teamModel}
          onChange={(e) => onTeamModel(e.target.value)}
          className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
        >
          {/* Only this engine's models. A team default belongs to one CLI:
              members on another fall back to their own engine's default
              instead, because a model id means nothing outside the CLI that
              defines it. */}
          {(cli?.models ?? []).map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Theme">
        <div className="flex gap-1">
          {THEMES.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => onTheme(option.id)}
              className={`flex-1 rounded-md border px-2 py-1.5 text-[11px] transition-colors ${
                theme === option.id
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-line text-ink-faint hover:text-ink-soft'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </Field>
    </section>
  );
}

// ── Workflow ───────────────────────────────────────────────────────

function WorkflowSlots({
  filled,
  slots,
  phases,
  errors,
  notes,
  onToggle,
}: {
  filled: Record<string, string | null>;
  slots: Record<string, { enabled: boolean; members: string[] }>;
  phases: Record<string, boolean>;
  errors: string[];
  notes: string[];
  onToggle: (slot: SlotId, enabled: boolean) => void;
}) {
  const running = Object.entries(phases)
    .filter(([, on]) => on)
    .map(([name]) => name);

  return (
    <section className="space-y-3 rounded-xl border border-line bg-surface-raised p-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-faint">This run</h2>
      <p className="text-[11px] leading-relaxed text-ink-faint">
        Switch a slot off to skip it for the next run without unassigning anyone.
      </p>

      <ul className="space-y-1">
        {SLOT_IDS.map((slot) => {
          const enabled = slots[slot]?.enabled !== false;
          const who = filled[slot];

          return (
            <li key={slot} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onToggle(slot, !enabled)}
                disabled={!slots[slot]?.members?.length}
                className={`h-4 w-7 shrink-0 rounded-full transition-colors disabled:opacity-30 ${
                  enabled && who ? 'bg-signal-ok' : 'bg-surface-overlay'
                }`}
                title={enabled ? 'Switch off for the next run' : 'Switch on'}
              >
                <span
                  className={`block h-3 w-3 rounded-full bg-surface-sunken transition-transform ${
                    enabled && who ? 'translate-x-3.5' : 'translate-x-0.5'
                  }`}
                />
              </button>
              <span className="flex-1 text-xs text-ink-soft">{SLOT_LABELS[slot]}</span>
              <span className="truncate text-[11px] text-ink-faint">{who || '—'}</span>
            </li>
          );
        })}
      </ul>

      <div className="border-t border-line pt-2">
        <p className="text-[11px] text-ink-faint">
          Phases: <span className="text-ink-soft">{running.length > 0 ? running.join(' → ') : 'none'}</span>
        </p>
        {errors.map((message) => (
          <p key={message} className="mt-1 text-[11px] leading-relaxed text-signal-bad">
            {message}
          </p>
        ))}
        {notes.map((message) => (
          <p key={message} className="mt-1 text-[11px] leading-relaxed text-signal-warn">
            {message}
          </p>
        ))}
      </div>
    </section>
  );
}

// ── Create ─────────────────────────────────────────────────────────

function CreateMemberForm({
  templates,
  clis,
  teamCli,
  onCancel,
  onCreate,
}: {
  templates: string[];
  clis: CliOption[];
  teamCli: CliId;
  onCancel: () => void;
  onCreate: (input: {
    id: string;
    name: string;
    title: string;
    slot: SlotId | null;
    cli: CliId;
    model: string;
    role?: string;
  }) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [slot, setSlot] = useState<SlotId | ''>('');
  const [cli, setCli] = useState<CliId>(teamCli);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);

  const cliOption = clis.find((option) => option.id === cli);

  // The id is derived from the name so there is one fewer thing to invent, but
  // it is shown because it becomes a directory name and the agent's identity.
  const id = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

  return (
    <div className="rounded-xl border border-line bg-surface-raised p-5">
      <h2 className="text-base font-semibold">New member</h2>
      <p className="mt-1 text-xs text-ink-faint">
        Name them anything. A member is just a role, a model, and whatever skills you attach.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label="Name" hint={id ? `id: ${id}` : 'Used to derive the id'}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Reacty"
            autoFocus
            className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
          />
        </Field>

        <Field label="Speciality" hint="Shown in the UI and used in their prompt.">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Frontend"
            className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
          />
        </Field>

        <Field label="Slot" hint="Which seat in the workflow they fill.">
          <select
            value={slot}
            onChange={(e) => setSlot(e.target.value as SlotId | '')}
            className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
          >
            <option value="">No slot (chat only)</option>
            {SLOT_IDS.map((option) => (
              <option key={option} value={option}>
                {SLOT_LABELS[option]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Runs on" hint="Which CLI their turns run in.">
          <select
            value={cli}
            // Changing engine drops the model with it, for the same reason the
            // member card does: a model id belongs to exactly one CLI.
            onChange={(e) => {
              setCli(e.target.value as CliId);
              setModel('');
            }}
            className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
          >
            {clis.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Model" hint="Empty means the team default.">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
          >
            <option value="">Team default</option>
            {(cliOption?.models ?? []).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {templates.length > 0 && (
        <p className="mt-4 text-[11px] text-ink-faint">
          A starter role is written for you; edit it after creating. Templates available: {templates.join(', ')}.
        </p>
      )}

      <div className="mt-5 flex gap-2">
        <button
          type="button"
          disabled={!id || busy}
          onClick={async () => {
            setBusy(true);
            await onCreate({ id, name: name.trim(), title: title.trim(), slot: slot || null, cli, model });
            setBusy(false);
          }}
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface-sunken transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? 'Creating…' : 'Create member'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-soft transition-colors hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Detail ─────────────────────────────────────────────────────────

function MemberDetail({
  member,
  clis,
  onUpdate,
  onRole,
  onAddSkill,
  onRemoveSkill,
  onRemove,
}: {
  member: TeamMemberView;
  clis: CliOption[];
  onUpdate: (patch: Record<string, unknown>) => void;
  onRole: (role: string) => void;
  onAddSkill: (name: string, description: string, body: string) => Promise<{ ok: boolean }>;
  onRemoveSkill: (name: string) => void;
  onRemove: (deleteFiles: boolean) => void;
}) {
  // What this member's own engine offers. Missing only if a roster names a CLI
  // this build cannot run, in which case the selects fall back to the built-in
  // vocabulary rather than rendering empty.
  const cli = clis.find((option) => option.id === member.cli);
  const [tab, setTab] = useState<'settings' | 'role' | 'skills'>('settings');
  const [role, setRoleDraft] = useState(member.role);
  const [roleDirty, setRoleDirty] = useState(false);
  /**
   * Removal used to ask through window.confirm(). Once a browser is told to
   * block dialogs for the page, confirm() returns false without showing
   * anything, so the button silently did nothing. The question is asked here
   * instead, where nothing outside the app can suppress it.
   */
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  return (
    <div className="space-y-4">
      {/* Header + live numbers */}
      <div className="rounded-xl border border-line bg-surface-raised p-5">
        <div className="flex flex-wrap items-start gap-4">
          <span className="mt-1 h-3 w-3 shrink-0 rounded-full" style={{ background: member.color }} aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold">{member.name}</h2>
            <p className="text-xs text-ink-faint">
              {member.id} · {member.slot ? SLOT_LABELS[member.slot] : 'no slot'}
              {member.title && ` · ${member.title}`}
            </p>
            {member.currentTask && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-soft">
                {member.working && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-signal-ok" />}
                {member.working ? member.currentTask : `Last: ${member.currentTask}`}
              </p>
            )}
          </div>

          <label className="flex shrink-0 items-center gap-2 text-xs text-ink-faint">
            <input
              type="checkbox"
              checked={member.enabled}
              onChange={(e) => onUpdate({ enabled: e.target.checked })}
              className="accent-[var(--accent)]"
            />
            Enabled
          </label>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4 sm:grid-cols-4">
          <Stat label="Tokens" value={member.billable.toLocaleString()} hint="Input + output + cache writes" />
          <Stat label="Cache reads" value={member.usage.cacheReadTokens.toLocaleString()} hint="The cheap path" />
          <Stat label="Cost" value={`$${member.usage.totalCostUsd.toFixed(4)}`} />
          <Stat label="Status" value={member.status} />
        </dl>

        {member.tokenBudget ? (
          <div className="mt-3">
            <div className="h-1 overflow-hidden rounded-full bg-surface-overlay">
              <div
                className={`h-full ${member.billable >= member.tokenBudget ? 'bg-signal-bad' : 'bg-signal-ok'}`}
                style={{ width: `${Math.min(100, (member.billable / member.tokenBudget) * 100)}%` }}
              />
            </div>
            <p className="mt-1 text-[11px] text-ink-faint">
              {member.billable.toLocaleString()} of {member.tokenBudget.toLocaleString()} token budget
            </p>
          </div>
        ) : null}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-line">
        {(
          [
            ['settings', 'Settings'],
            ['role', 'Role'],
            ['skills', `Skills (${member.skills.length})`],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === value ? 'border-accent text-ink' : 'border-transparent text-ink-faint hover:text-ink-soft'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'settings' && (
        <div className="space-y-4 rounded-xl border border-line bg-surface-raised p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <input
                defaultValue={member.name}
                onBlur={(e) => e.target.value !== member.name && onUpdate({ name: e.target.value })}
                className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
              />
            </Field>

            <Field label="Speciality">
              <input
                defaultValue={member.title}
                onBlur={(e) => e.target.value !== member.title && onUpdate({ title: e.target.value })}
                className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
              />
            </Field>

            <Field label="Slot" hint="Changing this changes which phase they run in.">
              <select
                value={member.slot ?? ''}
                onChange={(e) => onUpdate({ slot: e.target.value || null })}
                className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
              >
                <option value="">No slot (chat only)</option>
                {SLOT_IDS.map((slot) => (
                  <option key={slot} value={slot}>
                    {SLOT_LABELS[slot]}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Runs on" hint="The CLI this member's turns actually run in.">
              <select
                value={member.cli}
                // Switching engine clears the model. Model ids belong to one
                // CLI, so keeping `sonnet` on an Antigravity member is not a
                // stale preference — it is a name that engine rejects at spawn
                // time, long after the mistake was made. The server clears it
                // too; doing it here keeps the form from showing a value it is
                // about to lose.
                onChange={(e) => onUpdate({ cli: e.target.value as CliId, model: '' })}
                className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
              >
                {clis.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Model"
              hint={
                cli?.effortInModelId
                  ? 'This CLI builds the model id from the effort below.'
                  : 'Empty follows the team default.'
              }
            >
              <select
                value={member.model}
                onChange={(e) => onUpdate({ model: e.target.value })}
                className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
              >
                <option value="">Team default</option>
                {(cli?.models ?? []).map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Permission mode" hint={PERMISSION_HELP[member.permissionMode]}>
              <select
                value={member.permissionMode}
                onChange={(e) => onUpdate({ permissionMode: e.target.value as MemberPermissionMode })}
                className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
              >
                {/* Only what this engine accepts. A mode it does not have is a
                    validation error rather than something to clamp: clamping a
                    permission mode can only ever loosen it. */}
                {(cli?.permissionModes ?? PERMISSION_MODES).map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Effort"
              hint={
                cli?.effortInModelId
                  ? 'Picks the variant of the model above.'
                  : 'Higher costs more and thinks longer.'
              }
            >
              <select
                value={member.effort}
                onChange={(e) => onUpdate({ effort: e.target.value as Effort })}
                className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-accent"
              >
                {(cli?.efforts ?? EFFORT_LEVELS).map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Token budget" hint="Warns when passed. Does not stop the run.">
              <input
                type="number"
                min={0}
                defaultValue={member.tokenBudget ?? ''}
                placeholder="none"
                onBlur={(e) => onUpdate({ tokenBudget: e.target.value ? Number(e.target.value) : undefined })}
                className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
              />
            </Field>

            <Field label="Colour">
              <input
                type="color"
                defaultValue={member.color}
                onBlur={(e) => e.target.value !== member.color && onUpdate({ color: e.target.value })}
                className="h-9 w-full cursor-pointer rounded-md border border-line bg-surface"
              />
            </Field>
          </div>

          <div className="border-t border-line pt-4">
            <p className="text-[11px] text-ink-faint">
              Capabilities: writes <b className="text-ink-soft">{member.capabilities.write}</b>, bash{' '}
              <b className="text-ink-soft">{member.capabilities.bash}</b>, web{' '}
              <b className="text-ink-soft">{member.capabilities.web ? 'yes' : 'no'}</b>. These come from the slot and
              are enforced by the hook, not by the prompt.
            </p>

            {confirmingRemove ? (
              <div className="mt-4 rounded-md border border-signal-bad/40 bg-signal-bad/5 p-3">
                <p className="text-xs text-ink-soft">
                  Remove <b className="text-ink">{member.name}</b> from the team? Their role and skills are kept on
                  disk, so hiring them again restores both.
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmingRemove(false);
                      onRemove(false);
                    }}
                    className="rounded-md bg-signal-bad px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:opacity-90"
                  >
                    Remove
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingRemove(false)}
                    className="rounded-md border border-line px-3 py-1.5 text-xs text-ink-soft transition-colors hover:bg-surface-overlay"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingRemove(true)}
                className="mt-4 rounded-md border border-signal-bad/40 px-3 py-1.5 text-xs text-signal-bad transition-colors hover:bg-signal-bad/10"
              >
                Remove from team
              </button>
            )}
          </div>
        </div>
      )}

      {tab === 'role' && (
        <div className="rounded-xl border border-line bg-surface-raised p-5">
          <p className="mb-3 text-xs text-ink-faint">
            Used verbatim as the system prompt for every session this member runs. Markdown.
          </p>
          <textarea
            value={role}
            onChange={(e) => {
              setRoleDraft(e.target.value);
              setRoleDirty(true);
            }}
            rows={22}
            spellCheck={false}
            className="w-full resize-y rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-ink outline-none focus:border-accent"
          />
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              disabled={!roleDirty}
              onClick={() => {
                onRole(role);
                setRoleDirty(false);
              }}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface-sunken transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              Save role
            </button>
            {roleDirty && <span className="text-xs text-signal-warn">Unsaved changes</span>}
          </div>
        </div>
      )}

      {tab === 'skills' && (
        <SkillsTab member={member} onAdd={onAddSkill} onRemove={onRemoveSkill} />
      )}
    </div>
  );
}

// ── Skills ─────────────────────────────────────────────────────────

function SkillsTab({
  member,
  onAdd,
  onRemove,
}: {
  member: TeamMemberView;
  onAdd: (name: string, description: string, body: string) => Promise<{ ok: boolean }>;
  onRemove: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-surface-raised p-5">
        <h3 className="text-sm font-semibold">Attached skills</h3>
        <p className="mt-1 text-xs leading-relaxed text-ink-faint">
          Reference material only {member.name} can reach. Only the name and description sit in context — the body
          loads when they actually need it, so attaching a long document is close to free.
        </p>

        {member.skills.length === 0 ? (
          <p className="mt-4 text-xs text-ink-faint">Nothing attached yet.</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {member.skills.map((skill) => (
              <li
                key={skill}
                className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2 text-sm"
              >
                <span className="flex-1 font-mono text-xs text-ink-soft">{skill}</span>
                <button
                  type="button"
                  onClick={() => onRemove(skill)}
                  className="text-xs text-ink-faint transition-colors hover:text-signal-bad"
                >
                  detach
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-xl border border-line bg-surface-raised p-5">
        <h3 className="text-sm font-semibold">Attach a skill</h3>

        <div className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" hint="Becomes a slug, e.g. ui-docs.">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="UI docs"
                className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
              />
            </Field>

            <Field label="When to use it" hint="This is what the model sees before deciding to open it.">
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="House style for buttons, spacing and colour"
                className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
              />
            </Field>
          </div>

          <Field label="Content" hint="Markdown. Paste your docs here.">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
              spellCheck={false}
              placeholder="# UI guidelines&#10;&#10;Buttons use an 8px radius…"
              className="w-full resize-y rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-ink outline-none focus:border-accent"
            />
          </Field>

          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={!name.trim() || !body.trim() || busy}
              onClick={async () => {
                setBusy(true);
                const result = await onAdd(name.trim(), description.trim(), body);
                setBusy(false);
                if (result.ok) {
                  setName('');
                  setDescription('');
                  setBody('');
                }
              }}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface-sunken transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {busy ? 'Attaching…' : 'Attach skill'}
            </button>

            <label className="cursor-pointer text-xs text-ink-faint underline transition-colors hover:text-ink-soft">
              or upload a .md file
              <input
                type="file"
                accept=".md,.markdown,.txt"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setBody(await file.text());
                  if (!name.trim()) setName(file.name.replace(/\.(md|markdown|txt)$/i, ''));
                  e.target.value = '';
                }}
              />
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Small pieces ───────────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-ink-faint">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-relaxed text-ink-faint">{hint}</span>}
    </label>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wider text-ink-faint">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm text-ink">{value}</dd>
      {hint && <dd className="text-[10px] text-ink-faint">{hint}</dd>}
    </div>
  );
}

/**
 * Draft a team from a description of the job.
 *
 * The model proposes; this shows what it proposed; creating it is a separate
 * click. Nothing here can set capabilities — the proposal has no field for
 * them and the server derives them from the seat — so reviewing is about
 * whether these are the right people, not about what they would be allowed to
 * do.
 */
function DraftTeamPanel({
  onCancel,
  onApplied,
}: {
  onCancel: () => void;
  onApplied: (created: string[]) => void | Promise<void>;
}) {
  const [requirements, setRequirements] = useState('');
  const [proposal, setProposal] = useState<TeamProposal | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'draft' | 'apply' | null>(null);

  async function post(body: Record<string, unknown>) {
    const res = await fetch('/api/team-proposal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, data: (await res.json()) as Record<string, unknown> };
  }

  async function draft() {
    setBusy('draft');
    setError(null);
    const { ok, data } = await post({ action: 'draft', requirements });
    setBusy(null);

    if (!ok) {
      setError(String(data.error || 'The draft failed.'));
      setWarnings(Array.isArray(data.warnings) ? (data.warnings as string[]) : []);
      return;
    }

    setProposal(data.proposal as TeamProposal);
    setWarnings(Array.isArray(data.warnings) ? (data.warnings as string[]) : []);
  }

  async function apply() {
    if (!proposal) return;
    setBusy('apply');
    setError(null);
    const { ok, data } = await post({ action: 'apply', proposal });
    setBusy(null);

    if (!ok) {
      setError(String(data.error || 'Creating the team failed.'));
      return;
    }

    const failed = (data.failed as Array<{ id: string; error: string }>) || [];
    if (failed.length > 0) setError(failed.map((f) => `${f.id}: ${f.error}`).join(' · '));
    await onApplied((data.created as string[]) || []);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-surface-raised p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Draft a team</h2>
            <p className="mt-1 text-xs text-ink-faint">
              Describe the job. You get a proposed team to look at — nobody is created until you say so.
            </p>
          </div>
          <button type="button" onClick={onCancel} className="text-xs text-ink-faint underline">
            cancel
          </button>
        </div>

        <textarea
          value={requirements}
          onChange={(e) => setRequirements(e.target.value)}
          rows={4}
          placeholder="A Next.js dashboard that reads from a Postgres database. I care about the UI being consistent and about the queries not being slow. No design system yet."
          className="mt-4 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />

        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void draft()}
            disabled={busy !== null || requirements.trim().length < 12}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface-sunken transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === 'draft' ? 'Drafting…' : proposal ? 'Draft again' : 'Draft team'}
          </button>
          <span className="text-[11px] text-ink-faint">
            {busy === 'draft' ? 'One model turn — this takes a moment.' : 'Uses the team default model.'}
          </span>
        </div>

        {error && <p className="mt-3 text-xs text-signal-bad">{error}</p>}
      </div>

      {proposal && (
        <div className="rounded-xl border border-line bg-surface-raised p-5">
          {proposal.summary && <p className="text-sm leading-relaxed text-ink-soft">{proposal.summary}</p>}

          <ul className="mt-4 space-y-3">
            {proposal.members.map((member) => (
              <li key={member.id} className="rounded-lg border border-line bg-surface p-3">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-sm font-semibold text-ink">{member.name}</span>
                  <span className="text-[11px] text-ink-faint">
                    {member.id} · {member.slot ? SLOT_LABELS[member.slot] : 'no slot'}
                    {member.title && ` · ${member.title}`} · {member.model || 'team default'} · {member.effort}
                  </span>
                </div>
                {member.role && (
                  <p className="mt-2 line-clamp-3 whitespace-pre-line text-xs leading-relaxed text-ink-soft">
                    {member.role}
                  </p>
                )}
                {member.skills.length > 0 && (
                  <p className="mt-2 text-[11px] text-ink-faint">
                    Skills: {member.skills.map((s) => s.name).join(', ')}
                  </p>
                )}
              </li>
            ))}
          </ul>

          {warnings.length > 0 && (
            <ul className="mt-4 space-y-1 border-t border-line pt-3 text-[11px] text-signal-warn">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}

          <p className="mt-4 text-[11px] leading-relaxed text-ink-faint">
            What each member is allowed to touch comes from their seat and is enforced by the hook. A proposal cannot
            ask for permissions, so this is only about who the team is.
          </p>

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void apply()}
              disabled={busy !== null}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface-sunken transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {busy === 'apply' ? 'Creating…' : `Create ${proposal.members.length} member${proposal.members.length === 1 ? '' : 's'}`}
            </button>
            <button
              type="button"
              onClick={() => { setProposal(null); setWarnings([]); }}
              disabled={busy !== null}
              className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-soft transition-colors hover:bg-surface disabled:opacity-40"
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
