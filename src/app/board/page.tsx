'use client';

import Link from 'next/link';
import { useMemo } from 'react';

import { TicketBoard } from '@/components/board/TicketBoard';
import { usePipelineState } from '@/lib/use-pipeline';
import { useTeam } from '@/lib/use-team';

/**
 * The run's ticket board on a page of its own — the same board as the
 * commander desk in the studio, for a second screen.
 */
export default function BoardPage() {
  const { state, connected, sendTicketOp } = usePipelineState({ mode: 'pipeline', model: '' });
  const { team } = useTeam();
  const people = useMemo(
    () => team.roster.members.map((m) => ({ id: m.id, name: m.name, color: m.color })),
    [team.roster.members],
  );

  return (
    <main className="min-h-screen bg-[#0f0c0a] px-4 py-4 text-[#f4ece2] sm:px-6">
      <header className="mb-4 flex flex-wrap items-center gap-3">
        <Link href="/" className="font-mono text-[11px] text-[#8a7a6b] hover:text-[#f4ece2]">
          ← Studio
        </Link>
        <h1 className="font-mono text-sm font-bold uppercase tracking-[0.2em]">Team board</h1>
        <span className="truncate font-mono text-[11px] text-[#8a7a6b]">{state.concept || 'No run yet'}</span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[10px] text-[#8a7a6b]">
          <span className={`h-2 w-2 rounded-full ${connected ? 'bg-[#8fae60]' : 'bg-[#cf6c5a]'}`} />
          {connected ? 'Live' : 'Reconnecting…'}
        </span>
      </header>
      <TicketBoard tickets={state.tickets ?? []} people={people} onOp={sendTicketOp} />
    </main>
  );
}
