'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import type { SeatMap, SeatOccupant } from '@/components/mission/LunarOfficeScene';
import type { OfficeMember } from '@/components/mission/MemberStatCard';
import type { SlotId } from '@/lib/team/types';
import type { BoardState, Ticket, TicketOpInput } from '@/lib/tickets';
import { TicketBoard } from '@/components/board/TicketBoard';
import type { StudioCanvasProps, WhiteboardContent } from './StudioCanvas';
import type { TimeOfDayMode } from './core/day-night-cycle';
import { CharacterInspectorModal } from './hud/CharacterInspectorModal';
import { CommandTerminalModal, type CommandTerminalTab } from './hud/CommandTerminalModal';
import { WhiteboardModal, type BriefSubmitResult } from './hud/WhiteboardModal';

// Dynamically import StudioCanvas with ssr: false so Three.js only executes client-side
const StudioCanvas = dynamic<StudioCanvasProps>(
  () => import('./StudioCanvas').then((mod) => mod.StudioCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full min-h-[500px] w-full items-center justify-center bg-[#030306]">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-line-strong border-t-[#38bdf8]" />
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">
            Initializing 3D Studio & Characters...
          </span>
        </div>
      </div>
    ),
  }
);

export interface DevHouseStudio3DProps {
  activePhase: string;
  agentStatus: Record<string, string>;
  latestSpeech: Record<string, string | null>;
  runFinalAudit?: boolean;
  seats?: SeatMap;
  guests?: SeatOccupant[];
  members?: OfficeMember[];
  /** The run's whiteboard (brief and plan) and ticket board. */
  board?: BoardState;
  tickets?: Ticket[];
  onSubmitBrief?: (text: string, start: boolean) => Promise<BriefSubmitResult>;
  onTicketOp?: (op: TicketOpInput) => Promise<{ ok: boolean; error?: string; queued?: boolean }>;
  onAgentClick?: (agentId: string) => void;
  onViewSwitch?: (mode: '2d' | '3d') => void;
  // Slots for embedding existing page controls in Command Terminal
  pipelineControlsNode?: React.ReactNode;
  chatNode?: React.ReactNode;
  feedNode?: React.ReactNode;
  isPipelineRunning?: boolean;
  onStartPipeline?: () => void;
  onStopPipeline?: () => void;
}

export function DevHouseStudio3D({
  activePhase,
  agentStatus,
  latestSpeech,
  seats = {},
  guests = [],
  members = [],
  board,
  tickets = [],
  onSubmitBrief,
  onTicketOp,
  onAgentClick,
  onViewSwitch,
  pipelineControlsNode,
  chatNode,
  feedNode,
  isPipelineRunning = false,
  onStartPipeline = () => {},
  onStopPipeline = () => {},
}: DevHouseStudio3DProps) {
  // Command Terminal ("My Desk") Modal State
  const [isCommanderOpen, setIsCommanderOpen] = useState(false);
  const [commanderTab, setCommanderTab] = useState<CommandTerminalTab>('board');

  // Whiteboard: the run's own board state is the only source of truth, so a
  // plan the planner writes always shows, whatever was typed before.
  const [isWhiteboardOpen, setIsWhiteboardOpen] = useState(false);
  const memberName = useCallback((id?: string) => members.find((m) => m.id === id)?.name ?? id, [members]);
  const whiteboard = useMemo<WhiteboardContent>(
    () => ({
      brief: board?.brief?.text,
      plan: board?.plan?.text,
      planBy: memberName(board?.plan?.by),
      planStatus: board?.plan?.status,
    }),
    [board?.brief?.text, board?.plan?.text, board?.plan?.by, board?.plan?.status, memberName],
  );
  const people = useMemo(() => members.map((m) => ({ id: m.id, name: m.name, color: m.color })), [members]);

  // Environmental Controls State (Unified top bar, zero overlap!)
  const [timeOfDayMode, setTimeOfDayMode] = useState<TimeOfDayMode>('day');
  const [isLightsOn, setIsLightsOn] = useState(true);
  const [isACOn, setIsACOn] = useState(true);
  const studioControlsRef = useRef<{
    cycleTimeOfDay: () => void;
    toggleLights: () => void;
    toggleAC: () => void;
    updateWhiteboardPlan: (content: WhiteboardContent) => void;
  } | null>(null);

  const handleControlsReady = useCallback((ctrls: {
    cycleTimeOfDay: () => void;
    toggleLights: () => void;
    toggleAC: () => void;
    updateWhiteboardPlan: (content: WhiteboardContent) => void;
  }) => {
    studioControlsRef.current = ctrls;
  }, []);

  // Character Inspector Modal State
  const [inspectorMember, setInspectorMember] = useState<OfficeMember | null>(null);
  const [inspectorSlot, setInspectorSlot] = useState<SlotId | undefined>(undefined);
  const [inspectorStatus, setInspectorStatus] = useState<string>('idle');
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!inspectorMember) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [inspectorMember]);

  return (
    <div className="relative flex h-full min-h-[580px] w-full flex-col overflow-hidden rounded-2xl border border-line bg-[#030306]">
      {/* Floating Top Header Bar - Single unified flex row, zero stacked overlapping divs */}
      <div className="pointer-events-none absolute left-3 right-3 top-3 z-30 flex items-center justify-between">
        {/* Left: Studio Identity & Sleek Environmental Controls (NO Emojis) */}
        <div className="pointer-events-auto flex items-center gap-2">
          <div className="flex items-center gap-2 rounded-xl border border-[rgba(244,236,226,0.1)] bg-[#17130f]/90 px-3 py-1.5 backdrop-blur-md shadow-lg">
            <div className="h-2 w-2 rounded-full bg-[#d98b4d] animate-pulse" />
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-[#f4ece2]">
              Dev House Tower
            </span>
          </div>

          <div className="flex items-center gap-1 rounded-xl border border-[rgba(244,236,226,0.1)] bg-[#17130f]/90 p-1 backdrop-blur-md shadow-lg">
            <button
              type="button"
              onClick={() => {
                setTimeOfDayMode((prev) => (prev === 'day' ? 'sunset' : prev === 'sunset' ? 'night' : 'day'));
                studioControlsRef.current?.cycleTimeOfDay();
              }}
              className="rounded px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-[#d9a441] hover:bg-[#d9a441]/20 transition-all"
              title="Cycle Time of Day"
            >
              {timeOfDayMode.toUpperCase()}
            </button>
            <button
              type="button"
              onClick={() => {
                setIsLightsOn((prev) => !prev);
                studioControlsRef.current?.toggleLights();
              }}
              className={`rounded px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider transition-all ${
                isLightsOn ? 'text-[#8fae60] bg-[#8fae60]/20' : 'text-[#8a7a6b] hover:text-[#f4ece2]'
              }`}
              title="Toggle Studio Lighting"
            >
              LIGHTS: {isLightsOn ? 'ON' : 'OFF'}
            </button>
            <button
              type="button"
              onClick={() => {
                setIsACOn((prev) => !prev);
                studioControlsRef.current?.toggleAC();
              }}
              className={`rounded px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider transition-all ${
                isACOn ? 'text-[#7fa8a0] bg-[#7fa8a0]/20' : 'text-[#8a7a6b] hover:text-[#f4ece2]'
              }`}
              title="Toggle Air Conditioner"
            >
              AC: {isACOn ? '70°F' : 'OFF'}
            </button>
          </div>
        </div>

        {/* Center: Workspace & Whiteboard Plan Shortcuts (NO Emojis) */}
        <div className="pointer-events-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setCommanderTab('board');
              setIsCommanderOpen(true);
            }}
            className="flex items-center gap-2 rounded-xl border border-[#d98b4d]/40 bg-[#1e1915]/95 px-3.5 py-1.5 text-xs font-bold text-[#f4ece2] shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur-md transition-all hover:scale-105 hover:bg-[#d98b4d]/20 active:scale-95"
          >
            <span>Open My Computer (Lead Desk)</span>
          </button>
          <button
            type="button"
            onClick={() => setIsWhiteboardOpen(true)}
            className="flex items-center gap-2 rounded-xl border border-[#3b82f6]/40 bg-[#1e1915]/95 px-3.5 py-1.5 text-xs font-bold text-[#93c5fd] shadow-[0_4px_20px_rgba(0,0,0,0.5)] backdrop-blur-md transition-all hover:scale-105 hover:bg-[#3b82f6]/20 active:scale-95"
          >
            <span>Whiteboard Plan</span>
          </button>
        </div>

        {/* Right: Phase & View Switcher */}
        <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-[rgba(244,236,226,0.1)] bg-[#17130f]/90 p-1 backdrop-blur-md shadow-lg">
          <div className="px-2 font-mono text-[10px] uppercase tracking-wider text-[#8a7a6b]">
            {activePhase}
          </div>
          <div className="flex rounded-lg border border-[rgba(244,236,226,0.08)] bg-[#262019] p-0.5">
            <button
              type="button"
              className="rounded px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-[#d98b4d] text-[#17130f] shadow-sm"
            >
              3D Studio
            </button>
            <button
              type="button"
              onClick={() => onViewSwitch?.('2d')}
              className="rounded px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#8a7a6b] hover:text-[#f4ece2] transition-colors"
            >
              2D Retro
            </button>
          </div>
        </div>
      </div>

      {/* Main 3D WebGL Canvas */}
      <div className="relative h-full w-full flex-1">
        <StudioCanvas
          activePhase={activePhase}
          agentStatus={agentStatus}
          latestSpeech={latestSpeech}
          seats={seats}
          guests={guests}
          members={members}
          whiteboard={whiteboard}
          onControlsReady={handleControlsReady}
          onAgentClick={(agentId) => {
            const member = members.find((m) => m.id === agentId);
            if (member) {
              setInspectorMember(member);
              setInspectorStatus(agentStatus[agentId] || 'idle');
            }
            onAgentClick?.(agentId);
          }}
          onOpenCommanderDesk={() => {
            setCommanderTab('board');
            setIsCommanderOpen(true);
          }}
          onOpenWhiteboard={() => setIsWhiteboardOpen(true)}
          onInspectCharacter={(member, slot, status) => {
            setInspectorMember(member);
            setInspectorSlot(slot);
            setInspectorStatus(status || 'idle');
          }}
        />
      </div>

      {/* Whiteboard Plan Editor Modal */}
      <WhiteboardModal
        isOpen={isWhiteboardOpen}
        onClose={() => setIsWhiteboardOpen(false)}
        brief={board?.brief?.text}
        plan={board?.plan?.text}
        planStatus={board?.plan?.status}
        planBy={whiteboard.planBy}
        runActive={isPipelineRunning}
        onSubmitBrief={onSubmitBrief}
      />

      {/* Character Inspector Modal (When tapping any 3D dev) */}
      <CharacterInspectorModal
        member={inspectorMember}
        slot={inspectorSlot}
        status={inspectorStatus}
        now={nowMs}
        onClose={() => setInspectorMember(null)}
        onOpenChat={(agentId) => {
          setInspectorMember(null);
          setCommanderTab('chat');
          setIsCommanderOpen(true);
          onAgentClick?.(agentId);
        }}
      />

      {/* Commander Desk Modal ("My Desk & Computer") */}
      <CommandTerminalModal
        isOpen={isCommanderOpen}
        onClose={() => setIsCommanderOpen(false)}
        members={members}
        activePhase={activePhase}
        isPipelineRunning={isPipelineRunning}
        onStartPipeline={onStartPipeline}
        onStopPipeline={onStopPipeline}
        initialTab={commanderTab}
        onOpenDirectChat={(agentId) => {
          onAgentClick?.(agentId);
        }}
        pipelineControlsNode={pipelineControlsNode}
        chatNode={chatNode}
        feedNode={feedNode}
        boardNode={<TicketBoard tickets={tickets} people={people} onOp={onTicketOp} compact />}
      />
    </div>
  );
}
