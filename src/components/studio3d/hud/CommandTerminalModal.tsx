'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Link from 'next/link';
import type { OfficeMember } from '@/components/mission/MemberStatCard';
import { compactTokens } from '@/components/mission/MemberStatCard';
import { shortModelLabel } from '@/lib/team/types';

interface CommandTerminalModalProps {
  isOpen: boolean;
  onClose: () => void;
  members: OfficeMember[];
  activePhase: string;
  isPipelineRunning: boolean;
  onStartPipeline: () => void;
  onStopPipeline: () => void;
  onOpenDirectChat?: (agentId: string) => void;
  initialTab?: 'team' | 'pipeline' | 'chat' | 'feed';
  // Slots for embedding existing page controls
  pipelineControlsNode?: React.ReactNode;
  chatNode?: React.ReactNode;
  feedNode?: React.ReactNode;
}

export function CommandTerminalModal({
  isOpen,
  onClose,
  members,
  activePhase,
  isPipelineRunning,
  onStartPipeline,
  onStopPipeline,
  onOpenDirectChat,
  initialTab = 'team',
  pipelineControlsNode,
  chatNode,
  feedNode,
}: CommandTerminalModalProps) {
  const [activeTab, setActiveTab] = useState<'team' | 'pipeline' | 'chat' | 'feed'>(initialTab);
  const [prevInitialTab, setPrevInitialTab] = useState(initialTab);

  // Sync tab during render if initialTab changes (React-recommended pattern)
  if (initialTab !== prevInitialTab) {
    setPrevInitialTab(initialTab);
    setActiveTab(initialTab);
  }

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 backdrop-blur-md bg-black/60">
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 16 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
          className="relative flex h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[rgba(244,236,226,0.12)] bg-[#17130f] text-[#f4ece2] shadow-[0_20px_60px_rgba(0,0,0,0.85)]"
        >
          {/* Top Warm Studio Navigation Bar */}
          <div className="flex items-center justify-between border-b border-[rgba(244,236,226,0.08)] bg-[#1e1915]/95 px-5 py-3.5">
            <div className="flex items-center gap-3">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#d98b4d]/20 border border-[#d98b4d]/40 text-[#d98b4d]">
                <div className="h-2 w-2 rounded-sm bg-[#d98b4d]" />
              </div>
              <div>
                <h2 className="font-mono text-xs font-bold uppercase tracking-[0.2em] text-[#f4ece2]">
                  Command Terminal • My Computer
                </h2>
                <p className="text-[10px] text-[#8a7a6b]">
                  Dev House Lead Control System • Active Phase: <span className="text-[#d98b4d] font-bold">{activePhase}</span>
                </p>
              </div>
            </div>

            {/* Navigation Tabs (Warm Studio Theme) */}
            <div className="flex rounded-xl border border-[rgba(244,236,226,0.08)] bg-[#17130f] p-1">
              <button
                type="button"
                onClick={() => setActiveTab('team')}
                className={`rounded-lg px-3 py-1 text-[11px] font-bold uppercase tracking-wider transition-all ${
                  activeTab === 'team'
                    ? 'bg-[#d98b4d] text-[#17130f] shadow-sm'
                    : 'text-[#8a7a6b] hover:text-[#f4ece2]'
                }`}
              >
                Team & Skills
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('pipeline')}
                className={`rounded-lg px-3 py-1 text-[11px] font-bold uppercase tracking-wider transition-all ${
                  activeTab === 'pipeline'
                    ? 'bg-[#d98b4d] text-[#17130f] shadow-sm'
                    : 'text-[#8a7a6b] hover:text-[#f4ece2]'
                }`}
              >
                Pipeline Controls
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('chat')}
                className={`rounded-lg px-3 py-1 text-[11px] font-bold uppercase tracking-wider transition-all ${
                  activeTab === 'chat'
                    ? 'bg-[#d98b4d] text-[#17130f] shadow-sm'
                    : 'text-[#8a7a6b] hover:text-[#f4ece2]'
                }`}
              >
                Chat & Approvals
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('feed')}
                className={`rounded-lg px-3 py-1 text-[11px] font-bold uppercase tracking-wider transition-all ${
                  activeTab === 'feed'
                    ? 'bg-[#d98b4d] text-[#17130f] shadow-sm'
                    : 'text-[#8a7a6b] hover:text-[#f4ece2]'
                }`}
              >
                Live Feed
              </button>
            </div>

            {/* Close Button */}
            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-[rgba(244,236,226,0.1)] bg-[#262019] text-[#8a7a6b] transition-colors hover:text-[#f4ece2] hover:bg-[#2f2820]"
              title="Close Terminal (Esc)"
            >
              ✕
            </button>
          </div>

          {/* Modal Body */}
          <div className="flex-1 overflow-y-auto p-5">
            {/* TAB 1: Team & Skills Config */}
            {activeTab === 'team' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-[#f4ece2]">Dev House Team Roster</h3>
                    <p className="text-xs text-[#c4b5a5]">
                      Configure models, roles, capabilities, and permissions per team member.
                    </p>
                  </div>
                  <Link
                    href="/team"
                    className="rounded-lg border border-[#d98b4d]/40 bg-[#d98b4d]/10 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[#d98b4d] transition-colors hover:bg-[#d98b4d]/20"
                  >
                    Manage Roster in Squad →
                  </Link>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {members.map((member) => (
                    <div
                      key={member.id}
                      className="flex flex-col justify-between rounded-xl border border-[rgba(244,236,226,0.08)] bg-[#262019]/90 p-4 transition-all hover:border-[#d98b4d]/40 hover:bg-[#262019]"
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="h-3 w-3 rounded-full" style={{ background: member.color || '#d98b4d' }} />
                            <span className="font-bold text-[#f4ece2]">{member.name}</span>
                          </div>
                          <span className="font-mono text-[10px] uppercase tracking-wider text-[#d98b4d]">
                            {shortModelLabel(member.model)}
                          </span>
                        </div>

                        <p className="mt-2 text-xs text-[#c4b5a5] line-clamp-2">
                          {member.currentTask ? `Task: ${member.currentTask}` : 'Standing by at workstation.'}
                        </p>
                      </div>

                      <div className="mt-4 border-t border-[rgba(244,236,226,0.08)] pt-3">
                        <div className="flex justify-between text-[10px] text-[#8a7a6b]">
                          <span>Tokens: {compactTokens(member.billable)}</span>
                          <span>Cost: ${member.usage.totalCostUsd.toFixed(3)}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            onOpenDirectChat?.(member.id);
                            setActiveTab('chat');
                          }}
                          className="mt-2 w-full rounded-lg bg-[#2f2820] py-1.5 text-center text-[10px] font-bold uppercase tracking-wider text-[#f4ece2] transition-colors hover:bg-[#d98b4d] hover:text-[#17130f]"
                        >
                          Chat with {member.name}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* TAB 2: Pipeline Controls */}
            {activeTab === 'pipeline' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-[#f4ece2]">Pipeline Doctrine & Execution</h3>
                    <p className="text-xs text-[#c4b5a5]">
                      Guardrails, execution path, supervisor goals, and test verification.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {isPipelineRunning ? (
                      <button
                        type="button"
                        onClick={onStopPipeline}
                        className="rounded-lg bg-[#cf6c5a] px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-white shadow-md hover:bg-[#cf6c5a]/90"
                      >
                        Stop Pipeline
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={onStartPipeline}
                        className="rounded-lg bg-[#8fae60] px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-[#17130f] shadow-md hover:bg-[#8fae60]/90"
                      >
                        Start Pipeline Run
                      </button>
                    )}
                  </div>
                </div>

                <div className="rounded-xl border border-[rgba(244,236,226,0.08)] bg-[#262019]/50 p-4">
                  {pipelineControlsNode}
                </div>
              </div>
            )}

            {/* TAB 3: Chat & Approvals */}
            {activeTab === 'chat' && (
              <div className="h-full">
                {chatNode}
              </div>
            )}

            {/* TAB 4: Live Feed */}
            {activeTab === 'feed' && (
              <div className="h-full">
                {feedNode}
              </div>
            )}
          </div>

          {/* Footer Bar */}
          <div className="flex items-center justify-between border-t border-[rgba(244,236,226,0.08)] bg-[#1e1915]/80 px-5 py-2.5 text-xs text-[#8a7a6b] font-mono">
            <span>Press <kbd className="rounded border border-[rgba(244,236,226,0.12)] bg-[#262019] px-1 py-0.5 text-[#f4ece2]">Esc</kbd> or click ✕ to return to 3D room</span>
            <span>Dev House Studio • 2F Engineering Studio</span>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
