'use client';

import { motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';

/* Sprite sheet layout: 256×128, 32×32 cells
   8 columns (walk frames), 4 rows
   Row 0 = front (facing camera), 1 = back, 2 = left-facing art, 3 = right-facing art
   Frame 0 = idle standing pose */
const SCALE = 2;
const CELL = 32;
const COLS = 8;
const FRAME_PX = CELL * SCALE; // 96
const SHEET_W = CELL * COLS * SCALE; // 768
const SHEET_H = CELL * 4 * SCALE; // 384
const WALK_FPS = 150; // ms per frame
const spriteFile = {
  planner: '/sprites/agent_a.png',
  reviewer: '/sprites/agent_b.png',
  coder: '/sprites/agent_c.png',
  tester: '/sprites/agent_d.png',
  supervisor: '/sprites/agent_s.png',
  auditor: '/sprites/agent_e.png'
};
function getRow(facing: 'front' | 'left' | 'right' | 'back' | undefined): number {
  switch (facing) {
    case 'back':
      return 1;
    case 'left':
      return 2;
    // row 2 contains left-facing art
    case 'right':
      return 3;
    // row 3 contains right-facing art
    default:
      return 0;
    // front
  }
}
export function PixelSprite({
  id,
  name,
  bodyColor,
  x,
  y,
  isActive,
  isWalking,
  isWaiting = false,
  facing = 'right',
  carrying = false,
  speech = null,
  title
}: {
  id: string;
  name: string;
  title?: string;
  bodyColor?: string;
  x: number;
  y: number;
  isActive?: boolean;
  isWalking?: boolean;
  isWaiting?: boolean;
  facing?: 'front' | 'left' | 'right' | 'back';
  speech?: string | null;
  carrying?: boolean;
  scale?: number;
}) {
  const [frame, setFrame] = useState(0);
  const intervalRef = useRef<number | null>(null);
  useEffect(() => {
    if (isWalking) {
      intervalRef.current = window.setInterval(() => {
        setFrame(prev => (prev + 1) % COLS);
      }, WALK_FPS);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isWalking]);
  const displayFrame = isWalking ? frame : 0;
  const row = getRow(facing);
  const src = spriteFile[id as keyof typeof spriteFile] || spriteFile.planner;
  const bgX = -(displayFrame * FRAME_PX);
  const bgY = -(row * FRAME_PX);
  return <motion.div className="absolute z-20" animate={{
    left: x,
    top: y
  }} transition={{
    duration: 2.5,
    ease: 'easeInOut'
  }} style={{
    transform: 'translate(-50%, -100%)'
  }}>{speech && <motion.div initial={{
      opacity: 0,
      y: 4
    }} animate={{
      opacity: 1,
      y: 0
    }} exit={{
      opacity: 0
    }} className="absolute bottom-full left-1/2 z-30 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-line-strong bg-black/80 px-2 py-1 text-[9px] leading-tight text-ink/90" style={{
      maxWidth: 180,
      whiteSpace: 'normal'
    }}>{speech}<div className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-black/80" /></motion.div>}<div style={{
      width: FRAME_PX,
      height: FRAME_PX,
      backgroundImage: `url(${src})`,
      backgroundPosition: `${bgX}px ${bgY}px`,
      backgroundSize: `${SHEET_W}px ${SHEET_H}px`,
      backgroundRepeat: 'no-repeat',
      imageRendering: 'pixelated'
    }} />{carrying && <motion.div className="absolute z-30" style={{
      right: -4,
      top: FRAME_PX * 0.35
    }} animate={{
      y: [0, -2, 0],
      rotate: [0, 5, 0]
    }} transition={{
      duration: 0.8,
      repeat: Infinity,
      ease: 'easeInOut'
    }}><div className="h-[18px] w-[14px] rounded-[1px] border border-[#6c5a43] bg-[#efe4cf]"><div className="absolute left-[18%] top-[20%] h-[8%] w-[60%] rounded-full bg-[#b8aea0]" /><div className="absolute left-[18%] top-[38%] h-[8%] w-[60%] rounded-full bg-[#b8aea0]" /><div className="absolute left-[18%] top-[56%] h-[8%] w-[60%] rounded-full bg-[#b8aea0]" /></div></motion.div>}{isActive && <motion.div className="absolute -right-1 top-2 h-3 w-3 rounded-full bg-signal-ok" animate={{
      opacity: [1, 0.4, 1],
      scale: [1, 1.3, 1]
    }} transition={{
      duration: 1.5,
      repeat: Infinity
    }} style={{
      boxShadow: '0 0 8px rgba(34,197,94,0.6)'
    }} />}<div className="mt-0.5 rounded-sm border border-black/20 bg-black/60 px-1.5 py-0.5 text-center text-[9px] uppercase tracking-[0.16em] text-ink/80">{title || name}</div></motion.div>;
}