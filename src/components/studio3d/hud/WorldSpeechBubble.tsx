'use client';

import { motion } from 'framer-motion';

interface WorldSpeechBubbleProps {
  speech: string | null;
  agentName: string;
  color?: string;
  screenPos: { x: number; y: number } | null;
}

/**
 * 3D-projected live speech bubble rendered in screen coordinates directly above an agent workstation.
 */
export function WorldSpeechBubble({ speech, agentName, color = '#38bdf8', screenPos }: WorldSpeechBubbleProps) {
  if (!speech || !screenPos) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6, scale: 0.92 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.95 }}
      transition={{ duration: 0.2 }}
      className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-full"
      style={{
        left: `${screenPos.x}px`,
        top: `${screenPos.y - 18}px`,
        maxWidth: 220,
      }}
    >
      <div className="rounded-xl border border-line-strong bg-black/90 p-2.5 shadow-2xl backdrop-blur-md">
        <div className="mb-1 flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
          <span className="text-[9px] font-bold uppercase tracking-wider text-ink-faint">
            {agentName}
          </span>
        </div>
        <p className="line-clamp-3 text-[11px] leading-snug text-ink">{speech}</p>
      </div>
      {/* Downward tail pointing to agent desk */}
      <div className="mx-auto h-0 w-0 border-x-4 border-t-4 border-x-transparent border-t-black/90" />
    </motion.div>
  );
}
