'use client';

import { motion } from 'framer-motion';
import type { InteractionTarget } from '../types';

interface ProximityInteractPromptProps {
  target: InteractionTarget | null;
  onInteract: (agentId: string) => void;
}

/**
 * In-world interaction badge that appears when the player avatar walks near a workstation.
 * Prompts the user to press 'E' or click to open the agent's live session chat.
 */
export function ProximityInteractPrompt({ target, onInteract }: ProximityInteractPromptProps) {
  if (!target || !target.screenPosition) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.9 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.95 }}
      transition={{ duration: 0.15 }}
      className="pointer-events-auto absolute z-40 -translate-x-1/2 -translate-y-full cursor-pointer"
      style={{
        left: `${target.screenPosition.x}px`,
        top: `${target.screenPosition.y - 12}px`,
      }}
      onClick={() => onInteract(target.agentId)}
    >
      <div className="flex items-center gap-2 rounded-xl border border-[#38bdf8]/60 bg-black/85 px-3 py-1.5 shadow-[0_0_15px_rgba(56,189,248,0.35)] backdrop-blur-md transition-transform hover:scale-105 active:scale-95">
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[#38bdf8] font-mono text-[10px] font-bold text-black shadow-sm">
          E
        </span>
        <div className="flex flex-col">
          <span className="text-[11px] font-semibold text-white">
            Check on <span className="text-[#38bdf8]">{target.name}</span>
          </span>
          <span className="text-[9px] uppercase tracking-wider text-white/60">
            {target.role} • Click or tap
          </span>
        </div>
      </div>
      {/* Downward indicator arrow */}
      <div className="mx-auto h-0 w-0 border-x-4 border-t-4 border-x-transparent border-t-[#38bdf8]/60" />
    </motion.div>
  );
}
