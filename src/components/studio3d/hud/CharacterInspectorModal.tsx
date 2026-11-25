'use client';

import { motion, AnimatePresence } from 'framer-motion';
import type { OfficeMember } from '@/components/mission/MemberStatCard';
import { uptimeLabel, compactTokens, energyLabel } from '@/components/mission/MemberStatCard';
import { shortModelLabel, SLOT_LABELS, type SlotId } from '@/lib/team/types';

interface CharacterInspectorModalProps {
  member: OfficeMember | null;
  slot?: SlotId;
  status: string;
  now: number;
  onClose: () => void;
  onOpenChat: (agentId: string) => void;
}

/**
 * Inspector Card shown when tapping or interacting with any 3D dev character.
 * Displays who they are, their assigned task, live metrics, and quick chat launcher.
 * Uses the Warm Studio palette (No generic AI cyan).
 */
export function CharacterInspectorModal({
  member,
  slot,
  status,
  now,
  onClose,
  onOpenChat,
}: CharacterInspectorModalProps) {
  if (!member) return null;

  const energy = energyLabel(member);
  const isActive = status === 'active' || status === 'working';
  const roleLabel = slot ? SLOT_LABELS[slot] : 'Specialist';

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm bg-black/60">
        <motion.div
          initial={{ opacity: 0, scale: 0.94, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.94, y: 12 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="relative w-full max-w-md rounded-2xl border border-[rgba(244,236,226,0.12)] bg-[#17130f] p-6 text-[#f4ece2] shadow-2xl"
        >
          {/* Close button */}
          <button
            type="button"
            onClick={onClose}
            className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-lg border border-[rgba(244,236,226,0.08)] bg-[#262019] text-[#8a7a6b] transition-colors hover:text-[#f4ece2] hover:bg-[#2f2820]"
          >
            ✕
          </button>

          {/* Header: Name, Role, Model */}
          <div className="flex items-center gap-3.5">
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl font-mono text-base font-bold text-[#17130f] shadow-lg"
              style={{ background: member.color || '#d98b4d' }}
            >
              {member.name.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-lg font-bold text-[#f4ece2]">{member.name}</h3>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                    status === 'working'
                      ? 'bg-[#8fae60]/20 text-[#8fae60] border border-[#8fae60]/40'
                      : status === 'waiting'
                      ? 'bg-[#d9a441]/20 text-[#d9a441] border border-[#d9a441]/40'
                      : 'bg-[#262019] text-[#8a7a6b] border border-[rgba(244,236,226,0.08)]'
                  }`}
                >
                  {status}
                </span>
              </div>
              <p className="text-xs text-[#c4b5a5]">
                {roleLabel} • <span className="text-[#d98b4d] font-bold">{shortModelLabel(member.model)}</span>
              </p>
            </div>
          </div>

          {/* Assigned Task Section */}
          <div className="mt-4 rounded-xl border border-[rgba(244,236,226,0.08)] bg-[#262019]/70 p-3.5">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[#8a7a6b]">
              Current Assigned Task / Focus
            </div>
            <p className="text-[12px] leading-relaxed text-[#f4ece2]">
              {member.currentTask || (isActive ? 'Executing assigned task turn...' : 'Standing by at workstation for instructions.')}
            </p>
          </div>

          {/* Real-Time Metrics Grid */}
          <div className="mt-3.5 grid grid-cols-2 gap-2.5">
            <div className="rounded-xl border border-[rgba(244,236,226,0.08)] bg-[#262019]/40 p-2.5">
              <div className="text-[9px] uppercase tracking-wider text-[#8a7a6b]">Uptime</div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-[#f4ece2]">
                {uptimeLabel(member.startedAt, now, isActive)}
              </div>
            </div>

            <div className="rounded-xl border border-[rgba(244,236,226,0.08)] bg-[#262019]/40 p-2.5">
              <div className="text-[9px] uppercase tracking-wider text-[#8a7a6b]">Energy State</div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-[#f4ece2]">
                {energy.text}
              </div>
            </div>

            <div className="rounded-xl border border-[rgba(244,236,226,0.08)] bg-[#262019]/40 p-2.5">
              <div className="text-[9px] uppercase tracking-wider text-[#8a7a6b]">Billable Tokens</div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-[#f4ece2]">
                {compactTokens(member.billable)}
              </div>
            </div>

            <div className="rounded-xl border border-[rgba(244,236,226,0.08)] bg-[#262019]/40 p-2.5">
              <div className="text-[9px] uppercase tracking-wider text-[#8a7a6b]">Cost Accrued</div>
              <div className="mt-0.5 font-mono text-sm font-semibold text-[#f4ece2]">
                ${member.usage.totalCostUsd.toFixed(3)}
              </div>
            </div>
          </div>

          {/* Action Launcher */}
          <div className="mt-5 flex gap-2">
            <button
              type="button"
              onClick={() => onOpenChat(member.id)}
              className="flex-1 rounded-xl bg-[#d98b4d] py-2.5 text-center text-xs font-bold uppercase tracking-wider text-[#17130f] shadow-md transition-all hover:bg-[#d98b4d]/90 active:scale-95"
            >
              Open Direct Chat in Terminal →
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-[rgba(244,236,226,0.1)] bg-[#262019] px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-[#8a7a6b] hover:text-[#f4ece2]"
            >
              Close
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
