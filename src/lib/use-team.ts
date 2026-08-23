'use client';

import { useCallback, useEffect, useState } from 'react';

import type {
  Effort,
  MemberPermissionMode,
  Roster,
  SlotId,
  TeamMember,
} from '@/lib/team/types';
import type { TokenUsage } from '@/lib/team/usage';

export interface TeamMemberView extends TeamMember {
  role: string;
  usage: TokenUsage;
  /** Tokens counted against the budget (excludes cache reads). */
  billable: number;
  status: string;
  currentTask: string;
  /** When the current turn began, for uptime. Empty when not running. */
  startedAt: string;
  working: boolean;
}

export interface TeamPlanView {
  ok: boolean;
  errors: string[];
  notes: string[];
  phases: Record<string, boolean>;
  runGoal: string;
  filled: Record<string, string | null>;
}

export interface TeamView {
  roster: Roster;
  templates: string[];
  plan: TeamPlanView;
  members: TeamMemberView[];
}

const EMPTY: TeamView = {
  roster: {
    version: 2,
    teamModel: 'sonnet',
    members: [],
    workflow: {
      slots: {} as Roster['workflow']['slots'],
      runGoal: 'full-build',
      stopAfterSlot: 'none',
    },
  },
  templates: [],
  plan: { ok: false, errors: [], notes: [], phases: {}, runGoal: 'full-build', filled: {} },
  members: [],
};

export function useTeam() {
  const [team, setTeam] = useState<TeamView>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/team');
      const data = await res.json();
      if (data.error) setError(data.error);
      else {
        setTeam(data);
        setError(null);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Every mutation returns the whole view, so the page never has to guess what
   * the server did — it just replaces its state with the result.
   */
  const act = useCallback(
    async (payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> => {
      try {
        const res = await fetch('/api/team', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();

        if (!res.ok || data.error) {
          setError(data.error || 'Something went wrong.');
          return { ok: false, error: data.error };
        }

        setTeam(data);
        setError(null);
        return { ok: true };
      } catch (err) {
        setError(String(err));
        return { ok: false, error: String(err) };
      }
    },
    []
  );

  return {
    team,
    loading,
    error,
    reload: load,
    clearError: () => setError(null),

    createMember: (input: {
      id: string;
      name?: string;
      title?: string;
      slot?: SlotId | null;
      model?: string;
      permissionMode?: MemberPermissionMode;
      effort?: Effort;
      role?: string;
    }) => act({ action: 'create', ...input }),

    updateMember: (id: string, patch: Partial<TeamMember>) => act({ action: 'update', id, patch }),
    removeMember: (id: string, deleteFiles = false) => act({ action: 'remove', id, deleteFiles }),
    setRole: (id: string, role: string) => act({ action: 'role', id, role }),

    addSkill: (id: string, name: string, description: string, body: string) =>
      act({ action: 'add-skill', id, name, description, body }),
    removeSkill: (id: string, name: string) => act({ action: 'remove-skill', id, name }),

    setSlotEnabled: (slot: SlotId, enabled: boolean) => act({ action: 'slot', slot, enabled }),
    setTeamModel: (teamModel: string) => act({ action: 'workflow', teamModel }),
    setAutoTeam: (autoTeam: boolean) => act({ action: 'workflow', autoTeam }),
    setTheme: (theme: string) => act({ action: 'workflow', theme }),
    setRunGoal: (runGoal: string) => act({ action: 'workflow', runGoal }),
  };
}
