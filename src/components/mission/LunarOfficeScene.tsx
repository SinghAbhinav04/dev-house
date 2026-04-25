'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { PixelSprite } from './PixelSprite';

export type WorkerId = 'planner' | 'reviewer' | 'coder' | 'tester' | 'supervisor' | 'auditor';

/**
 * Who is sitting at each desk. The desks are the six workflow slots, so a
 * member takes a desk by filling that slot.
 */
export interface SeatOccupant {
  agentId: string;
  name: string;
  color: string;
}

export type SeatMap = Partial<Record<WorkerId, SeatOccupant>>;

/** The slice of a roster member the office needs in order to describe them. */
export interface OfficeMember {
  id: string;
  name: string;
  color: string;
  model: string;
  billable: number;
  usage: { totalCostUsd: number };
  tokenBudget?: number;
  currentTask: string;
  startedAt: string;
}

type Facing = 'front' | 'left' | 'right' | 'back';

interface WorkerPos {
  x: number;
  y: number;
  facing: Facing;
}

interface WorkerDef {
  id: WorkerId;
  agentId: string;
  name: string;
  title: string;
  color: string;
  x: number;
  y: number;
}

/** A positioned box, used by every piece of drawn furniture. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Candidate {
  x: number;
  y: number;
  label?: string;
}

const SCENE_W = 1200;
const SCENE_H = 560;
/** Desk positions and fallback labels, used when a seat is empty. */
const workers: WorkerDef[] = [{
  id: 'planner',
  agentId: '',
  name: 'Planner',
  title: 'Planner',
  color: '#8a7a6b',
  x: 155,
  y: 370
}, {
  id: 'reviewer',
  agentId: '',
  name: 'Reviewer',
  title: 'Reviewer',
  color: '#8a7a6b',
  x: 365,
  y: 370
}, {
  id: 'coder',
  agentId: '',
  name: 'Coder',
  title: 'Coder',
  color: '#8a7a6b',
  x: 558,
  y: 370
}, {
  id: 'tester',
  agentId: '',
  name: 'Tester',
  title: 'Tester',
  color: '#8a7a6b',
  x: 775,
  y: 370
}, {
  id: 'supervisor',
  agentId: '',
  name: 'Supervisor',
  title: 'Supervisor',
  color: '#8a7a6b',
  x: 990,
  y: 370
}, {
  id: 'auditor',
  agentId: '',
  name: 'Auditor',
  title: 'Auditor',
  color: '#8a7a6b',
  x: 1080,
  y: 485
}];
// Home positions — each worker always faces the same direction
// Workers sit BELOW their desks — feet at y:460, heads peek above desk edge
const homePositions: Record<WorkerId, WorkerPos> = {
  planner: { x: 279, y: 303, facing: 'back' },
  reviewer: { x: 423, y: 303, facing: 'back' },
  coder: { x: 559, y: 303, facing: 'back' },
  tester: { x: 693, y: 303, facing: 'back' },
  supervisor: { x: 830, y: 303, facing: 'back' },
  auditor: { x: 966, y: 303, facing: 'back' }
};
// Per-phase position overrides for ACTIVE workers (pipeline movements)
// Matches actual orchestrator flow: A plans, A↔B review, C codes, C↔D review+test, A deploys
// S (Supervisor) is never spawned by orchestrator — no overrides for S
const phasePositions: Record<string, Partial<Record<WorkerId, WorkerPos>>> = {
  concept: {
    planner: { x: 279, y: 303, facing: 'back' }
  },
  planning: {
    planner: { x: 279, y: 303, facing: 'back' }
  },
  'plan-review': {
    planner: { x: 331, y: 330, facing: 'right' },
    reviewer: { x: 375, y: 330, facing: 'left' }
  },
  coding: {
    coder: { x: 559, y: 303, facing: 'back' }
  },
  'code-review': {
    coder: { x: 604, y: 330, facing: 'right' },
    tester: { x: 648, y: 330, facing: 'left' }
  },
  testing: {
    tester: { x: 693, y: 303, facing: 'back' }
  },
  'security-audit': {
    tester: { x: 876, y: 330, facing: 'right' },
    auditor: { x: 920, y: 330, facing: 'left' }
  },
  deploy: {
    tester: { x: 345, y: 330, facing: 'left' },
    planner: { x: 301, y: 330, facing: 'right' }
  },
  complete: {}
};
// Idle activity spots — places workers can wander to when not active
const idleSpots: Candidate[] = [{
  x: 45,
  y: 330,
  label: 'water-cooler-left'
}, {
  x: 1060,
  y: 330,
  label: 'water-cooler-right'
}, {
  x: 250,
  y: 380,
  label: 'plant-1'
}, {
  x: 480,
  y: 380,
  label: 'plant-2'
}, {
  x: 700,
  y: 380,
  label: 'plant-3'
}, {
  x: 870,
  y: 380,
  label: 'plant-4'
}, {
  x: 45,
  y: 390,
  label: 'filing-left'
}, {
  x: 1060,
  y: 390,
  label: 'filing-right'
}, {
  x: 450,
  y: 330,
  label: 'hallway-1'
}, {
  x: 660,
  y: 330,
  label: 'hallway-2'
}, {
  x: 200,
  y: 430,
  label: 'floor-left'
}, {
  x: 140,
  y: 505,
  label: 'tv'
}, {
  x: 330,
  y: 505,
  label: 'tv'
}, {
  x: 859,
  y: 470,
  label: 'cafe'
}, {
  x: 975,
  y: 470,
  label: 'cafe'
}, {
  x: 917,
  y: 515,
  label: 'cafe'
}, {
  x: 600,
  y: 440,
  label: 'floor-center'
}, {
  x: 800,
  y: 450,
  label: 'floor-center-right'
}, {
  x: 150,
  y: 480,
  label: 'floor-far-left'
}, {
  x: 550,
  y: 490,
  label: 'floor-far-center'
}, {
  x: 850,
  y: 480,
  label: 'floor-far-right'
}, {
  x: 1080,
  y: 485,
  label: 'sofa'
}, {
  x: 1120,
  y: 485,
  label: 'sofa'
}];
// Returns positions occupied by all OTHER workers (excluding selfId), considering
// phase override > current idle position > home. Used to prevent wander overlap.
// Without this, a wanderer can land on top of a worker that's at home or at a
// phase-overridden position (e.g. Eddie chilling on the sofa at their home spot).
function computeOccupiedPositions(
  selfId: WorkerId,
  activePhase: string,
  runFinalAudit: boolean,
  idleNow: Partial<Record<WorkerId, WorkerPos | null>>
) {
  const phaseOverrides = phasePositions[activePhase as string] || {};
  const positions = [];
  for (const w of workers) {
    if (w.id === selfId) continue;
    if (w.id === 'auditor' && !runFinalAudit) continue;
    const phasePos = phaseOverrides[w.id];
    const idlePos = idleNow[w.id];
    const home = homePositions[w.id as WorkerId];
    positions.push(phasePos || idlePos || home);
  }
  return positions;
}
// Determines whether a candidate idle spot is too close to any occupied position,
// honoring the group-spot exception (sofa/cafe/tv allow side-by-side
// stacking with other spots of the same label, but never exact-coord collision).
function isCandidateBlocked(candidate: Candidate, occupied: Array<{ x: number; y: number }>) {
  const candidateIsGroup = candidate.label === 'sofa' || candidate.label === 'cafe' || candidate.label === 'tv';
  for (const p of occupied) {
    if (p.x === candidate.x && p.y === candidate.y) return true; // exact collision — always block
    if (candidateIsGroup) {
      const occupiedSpot = idleSpots.find(s => s.x === p.x && s.y === p.y);
      if (occupiedSpot && occupiedSpot.label === candidate.label) continue; // same group label, allow
    }
    if (Math.abs(candidate.x - p.x) < 80 && Math.abs(candidate.y - p.y) < 60) return true;
  }
  return false;
}
// Which worker is carrying a document in each phase
// Matches actual orchestrator flow:
// planning: A writes plan at desk
// plan-review: A carries plan to B, B reviews, B sends questions back to A, A answers, loop
// coding: C builds at desk
// code-review: C carries code to D, D reviews, D sends issues back to C, C fixes, loop
// testing: D tests at desk, sends failures to C, C fixes, loop
// deploy: D carries final code to A
const phaseCarriers: Record<string, WorkerId | null> = {
  concept: null,
  planning: null,
  'plan-review': 'planner',
  coding: null,
  'code-review': 'coder',
  testing: null,
  deploy: 'tester',
  complete: null
};
const phaseMap = ['concept', 'planning', 'plan-review', 'coding', 'code-review', 'testing', 'deploy', 'complete'];
const phaseLabels: Record<string, string> = {
  concept: 'Defining the concept',
  planning: 'Drafting the plan',
  'plan-review': 'Reviewing the plan',
  coding: 'Writing code',
  'code-review': 'Reviewing code changes',
  testing: 'Running tests',
  deploy: 'Deploying the build',
  complete: 'Build complete'
};
// Per-agent speech — describes what each agent is doing when active in a phase.
// E omitted: it never appears as an office worker — it runs only at end-of-build.
const agentSpeechPool: Partial<Record<WorkerId, Record<string, string[]>>> = {
  planner: {
    concept: ['Reading the brief...', 'Parsing the concept.', 'Scoping this out.', 'Interesting. Let me think.'],
    planning: ['Writing the plan...', 'Researching dependencies.', 'Structuring the architecture.', 'Checking package versions.', 'Drafting file layout.'],
    'plan-review': ['Answering reviewer questions.', 'Updating the plan.', 'Verifying my assumptions.', 'Adding more detail here.'],
    deploy: ['Committing to git...', 'Deploying the build.', 'Final checks...', 'Pushing to remote.'],
    complete: ['Build shipped.', 'Done. Next project?']
  },
  reviewer: {
    'plan-review': ['Reading the full plan...', 'Checking for gaps.', 'This section is vague.', 'Verifying edge cases.', 'Cross-referencing requirements.', 'Sending questions to Planner.', 'Reviewing updated plan.', 'Almost satisfied.'],
    complete: ['My work here is done.']
  },
  coder: {
    coding: ['Writing code...', 'Building the components.', 'Implementing the plan.', 'One more file to write.', 'Following the spec exactly.'],
    'code-review': ['Fixing review issues.', 'Updating the code.', 'Addressing feedback.'],
    testing: ['Fixing test failures.', 'Patching the bug.', 'Applying the fix.'],
    complete: ['Code is done.']
  },
  tester: {
    'code-review': ['Reading the diff...', 'Comparing to the plan.', 'Found a mismatch.', 'Checking every file.', 'Sending issues to Coder.', 'Re-reviewing the fixes.'],
    testing: ['Running tests...', 'Launching the app.', 'Testing edge cases.', 'Checking all functionality.', 'One test failing...', 'Re-running after fix.'],
    deploy: ['Handing off to Planner.'],
    complete: ['All tests passed.']
  },
  supervisor: {
    concept: ['Standing by.'],
    complete: ['Good work, team.']
  },
  auditor: {
    concept: ['Just chillin\'.', 'Eyes on the screen.', 'Standing by.'],
    planning: ['Watching how this plan shapes up.', 'Letting the team cook.'],
    'plan-review': ['Watching B poke holes.', 'Standing by.'],
    coding: ['Standing by until the build is testable.', 'Watching C build.'],
    'code-review': ['Letting D do their pass first.', 'Almost my turn.'],
    testing: ['Tests almost done. My turn next.', 'Sharpening my checklist.'],
    'security-audit': ['OWASP sweep in progress.', 'Reading every file.', 'Looking for real exploits, not noise.', 'Severity calls coming up.'],
    deploy: ['Audit done. Heading back to the sofa.'],
    complete: ['Solid build. Back to chillin\'.']
  }
};
function getRandomSpeech(workerId: WorkerId, phase: string): string {
  const agentPool = agentSpeechPool[workerId as WorkerId];
  const pool = agentPool?.[phase] || agentPool?.['concept'] || ['Working...'];
  return pool[Math.floor(Math.random() * pool.length)];
}
const DESK_W = 250;
const DESK_H = 170;
const CHAIR_Y = 280;
const desks: Array<Record<string, Box>> = [{
  desk: {
    x: 55,
    y: 195,
    w: DESK_W,
    h: DESK_H
  },
  chair: {
    x: 159,
    y: CHAIR_Y,
    w: 55,
    h: 60
  },
  monitor: {
    x: 117,
    y: 218,
    w: 48,
    h: 48
  },
  extra: {
    x: 185,
    y: 238,
    w: 40,
    h: 40
  }
}, {
  desk: {
    x: 260,
    y: 195,
    w: DESK_W,
    h: DESK_H
  },
  chair: {
    x: 364,
    y: CHAIR_Y,
    w: 55,
    h: 60
  },
  monitor: {
    x: 323,
    y: 222,
    w: 48,
    h: 48
  },
  extra: {
    x: 400,
    y: 240,
    w: 40,
    h: 40
  }
}, {
  desk: {
    x: 465,
    y: 195,
    w: DESK_W,
    h: DESK_H
  },
  chair: {
    x: 569,
    y: CHAIR_Y,
    w: 55,
    h: 60
  },
  monitor: {
    x: 523,
    y: 218,
    w: 48,
    h: 48
  },
  extra: {
    x: 590,
    y: 238,
    w: 40,
    h: 40
  }
}, {
  desk: {
    x: 670,
    y: 195,
    w: DESK_W,
    h: DESK_H
  },
  chair: {
    x: 774,
    y: CHAIR_Y,
    w: 55,
    h: 60
  },
  monitor: {
    x: 733,
    y: 222,
    w: 48,
    h: 48
  },
  extra: {
    x: 810,
    y: 240,
    w: 40,
    h: 40
  }
}, {
  desk: {
    x: 875,
    y: 195,
    w: DESK_W,
    h: DESK_H
  },
  chair: {
    x: 979,
    y: CHAIR_Y,
    w: 55,
    h: 60
  },
  monitor: {
    x: 910,
    y: 218,
    w: 48,
    h: 48
  },
  extra: {
    x: 980,
    y: 238,
    w: 40,
    h: 40
  }
}];
// CSS furniture components
function CSSDesk({
  x,
  y,
  w,
  h
}: Box & Record<string, unknown>) {
  return <div className="absolute" style={{
    left: x,
    top: y,
    width: w,
    height: h,
    zIndex: 5
  }}><div className="absolute inset-x-[5%] top-0 h-[35%] rounded-t-[4px] border border-black/20 bg-[#5c4a3a] shadow-[inset_0_2px_0_rgba(255,255,255,0.1)]" /><div className="absolute bottom-[10%] left-[8%] h-[55%] w-[3px] bg-[#4a3a2e]" /><div className="absolute bottom-[10%] right-[8%] h-[55%] w-[3px] bg-[#4a3a2e]" /><div className="absolute inset-x-[5%] top-[8%] h-[4px] bg-[#6b5a48]" /></div>;
}
function CSSChair({
  x,
  y,
  w,
  h
}: Box & Record<string, unknown>) {
  return <div className="absolute" style={{
    left: x,
    top: y,
    width: w,
    height: h,
    zIndex: 4
  }}><div className="absolute left-[15%] top-0 h-[40%] w-[70%] rounded-t-[6px] border border-black/15 bg-[#2a2a3a]" /><div className="absolute left-[20%] top-[38%] h-[25%] w-[60%] rounded-[3px] bg-[#333345]" /><div className="absolute bottom-[5%] left-[25%] h-[30%] w-[4px] bg-[#1a1a28]" /><div className="absolute bottom-[5%] right-[25%] h-[30%] w-[4px] bg-[#1a1a28]" /></div>;
}
function CSSMonitor({
  x,
  y,
  w,
  h
}: Box & Record<string, unknown>) {
  return <div className="absolute" style={{
    left: x,
    top: y,
    width: w,
    height: h,
    zIndex: 6
  }}><div className="absolute inset-[8%] rounded-[3px] border border-black/30 bg-[#1a1a2e]"><motion.div className="absolute inset-[12%] rounded-[2px] bg-[#0a2a1a]" animate={{
        opacity: [0.6, 1, 0.6]
      }} transition={{
        duration: 3,
        repeat: Infinity
      }}><div className="absolute left-[10%] top-[15%] h-[8%] w-[60%] rounded-full bg-[#33ff66]/40" /><div className="absolute left-[10%] top-[30%] h-[8%] w-[80%] rounded-full bg-[#33ff66]/30" /><div className="absolute left-[10%] top-[45%] h-[8%] w-[45%] rounded-full bg-[#33ff66]/35" /><div className="absolute left-[10%] top-[60%] h-[8%] w-[70%] rounded-full bg-[#33ff66]/25" /><div className="absolute left-[10%] top-[75%] h-[8%] w-[55%] rounded-full bg-[#33ff66]/30" /></motion.div></div><div className="absolute bottom-0 left-1/2 h-[12%] w-[15%] -translate-x-1/2 bg-[#333]" /></div>;
}
function CSSMug({
  x,
  y,
  w,
  h
}: Box & Record<string, unknown>) {
  return <div className="absolute" style={{
    left: x,
    top: y,
    width: w,
    height: h,
    zIndex: 7
  }}><div className="absolute bottom-[20%] left-[25%] h-[55%] w-[45%] rounded-b-[4px] border border-black/20 bg-[#e8e0d0]"><div className="absolute right-[-30%] top-[15%] h-[50%] w-[30%] rounded-r-full border-2 border-l-0 border-black/15" /></div><motion.div className="absolute left-[30%] top-[5%] h-[20%] w-[8%] rounded-full bg-white/20" animate={{
      y: [0, -4, -8],
      opacity: [0.3, 0.15, 0]
    }} transition={{
      duration: 2,
      repeat: Infinity,
      repeatDelay: 3
    }} /></div>;
}
function CSSPlant({
  x,
  y,
  w,
  h
}: Box & Record<string, unknown>) {
  return <div className="absolute" style={{
    left: x,
    top: y,
    width: w,
    height: h,
    zIndex: 7
  }}><div className="absolute bottom-0 left-1/2 h-[35%] w-[50%] -translate-x-1/2 rounded-b-[4px] rounded-t-[2px] border border-black/15 bg-[#8b6b4a]" /><div className="absolute bottom-[30%] left-1/2 h-[45%] w-[70%] -translate-x-1/2 rounded-full bg-[#2d6b3f]" /><div className="absolute bottom-[45%] left-[20%] h-[35%] w-[40%] rounded-full bg-[#3a8a50]" /><div className="absolute bottom-[50%] right-[15%] h-[30%] w-[35%] rounded-full bg-[#257a3a]" /></div>;
}
function CSSChart({
  x,
  y,
  w,
  h,
  type
}: Box & Record<string, unknown>) {
  return <div className="absolute rounded-[2px] border border-black/20 bg-surface-raised" style={{
    left: x,
    top: y,
    width: w,
    height: h,
    zIndex: 4
  }}>{type === 'line' ? <svg className="absolute inset-[15%]" viewBox="0 0 40 20" fill="none"><polyline points="0,18 8,12 16,15 24,6 32,9 40,3" stroke="#33ff66" strokeWidth="1.5" opacity="0.6" /><polyline points="0,16 8,14 16,10 24,12 32,5 40,8" stroke="#6699ff" strokeWidth="1" opacity="0.4" /></svg> : <div className="absolute inset-[15%] flex items-end gap-[8%]"><div className="h-[60%] flex-1 bg-[#33ff66]/40" /><div className="h-[80%] flex-1 bg-[#33ff66]/50" /><div className="h-[45%] flex-1 bg-[#33ff66]/35" /><div className="h-[90%] flex-1 bg-[#33ff66]/55" /><div className="h-[70%] flex-1 bg-[#33ff66]/45" /></div>}</div>;
}
function CSSWhiteboard({
  x,
  y,
  w,
  h
}: Box & Record<string, unknown>) {
  return <div className="absolute rounded-[2px] border-2 border-[#999] bg-[#f0ece4]" style={{
    left: x,
    top: y,
    width: w,
    height: h,
    zIndex: 4
  }}><div className="absolute left-[10%] top-[20%] h-[6%] w-[60%] rounded-full bg-[#e74c3c]/50" /><div className="absolute left-[10%] top-[35%] h-[6%] w-[80%] rounded-full bg-[#3498db]/40" /><div className="absolute left-[10%] top-[50%] h-[6%] w-[45%] rounded-full bg-[#2ecc71]/40" /><div className="absolute left-[10%] top-[65%] h-[6%] w-[70%] rounded-full bg-[#333]/20" /></div>;
}
function CSSWaterCooler({
  x,
  y,
  w,
  h
}: Box & Record<string, unknown>) {
  return <div className="absolute" style={{
    left: x,
    top: y,
    width: w,
    height: h,
    zIndex: 5
  }}><div className="absolute left-1/2 top-0 h-[30%] w-[40%] -translate-x-1/2 rounded-t-full border border-black/15 bg-[#a8d8ea]/60" /><div className="absolute left-1/2 top-[28%] h-[55%] w-[55%] -translate-x-1/2 rounded-[3px] border border-black/15 bg-[#ddd]" /><div className="absolute bottom-0 left-1/2 h-[15%] w-[65%] -translate-x-1/2 rounded-b-[3px] bg-[#999]" /></div>;
}
function CSSCalendar({
  x,
  y,
  w,
  h
}: Box & Record<string, unknown>) {
  return <div className="absolute rounded-[2px] border border-black/20 bg-white/90" style={{
    left: x,
    top: y,
    width: w,
    height: h,
    zIndex: 4
  }}><div className="absolute inset-x-0 top-0 h-[20%] rounded-t-[2px] bg-[#e74c3c]" /><div className="absolute inset-[15%] top-[25%] grid grid-cols-5 gap-[4%]">{Array.from({
        length: 15
      }).map((_, i) => <div key={i} className="aspect-square rounded-[1px] bg-black/10" />)}</div></div>;
}
function CSSNameplate({
  x,
  y,
  w,
  h
}: Box & Record<string, unknown>) {
  return <div className="absolute flex items-center justify-center rounded-[2px] border border-[#8b7355] bg-[#2a2218]" style={{
    left: x,
    top: y,
    width: w,
    height: h,
    zIndex: 7
  }}><span className="text-[7px] font-bold tracking-wider text-[#d4a847]">BOSS</span></div>;
}
function CSSCouchFront({
  x,
  y,
  w,
  h
}: Box & Record<string, unknown>) {
  return <div className="absolute" style={{
    left: x,
    top: y,
    width: w,
    height: h,
    zIndex: 6
  }}><div className="absolute inset-0 rounded-[6px] border border-black/20 bg-[#4a3a5c]" /><div className="absolute left-[3%] top-[15%] h-[70%] w-[20%] rounded-[4px] bg-[#5a4a6e]" /><div className="absolute right-[3%] top-[15%] h-[70%] w-[20%] rounded-[4px] bg-[#5a4a6e]" /></div>;
}
function CSSCushion({
  x,
  y,
  w,
  h
}: Box & Record<string, unknown>) {
  return <div className="absolute rounded-[4px] border border-black/10 bg-[#6b5a7e] shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]" style={{
    left: x,
    top: y,
    width: w,
    height: h,
    zIndex: 6
  }} />;
}
function CSSRetroTV({
  x,
  y,
  w,
  h
}: Box & Record<string, unknown>) {
  return <div className="absolute" style={{
    left: x,
    top: y,
    width: w,
    height: h,
    zIndex: 6
  }}><div className="absolute inset-0 rounded-[6px] border-2 border-black/30 bg-[#8b7355]"><div className="absolute inset-[10%] rounded-[3px] border border-black/20 bg-[#1a1a2e]"><motion.div className="absolute inset-[8%] rounded-[2px] bg-[#0a1a2a]" animate={{
          opacity: [0.5, 0.8, 0.5]
        }} transition={{
          duration: 2,
          repeat: Infinity
        }}><div className="absolute inset-0 bg-[linear-gradient(transparent_50%,rgba(0,0,0,0.1)_50%)] bg-[length:100%_4px]" /></motion.div></div><div className="absolute bottom-[8%] right-[8%] h-[8%] w-[8%] rounded-full bg-[#33ff66]/60" /></div><div className="absolute left-[30%] top-[-15%] h-[20%] w-[4%] origin-bottom rotate-[-20deg] bg-[#555]" /><div className="absolute right-[30%] top-[-15%] h-[20%] w-[4%] origin-bottom rotate-[20deg] bg-[#555]" /></div>;
}
const stars = [{
  left: 60,
  top: 38,
  size: 3
}, {
  left: 180,
  top: 55,
  size: 4
}, {
  left: 350,
  top: 35,
  size: 3
}, {
  left: 500,
  top: 42,
  size: 3
}, {
  left: 650,
  top: 50,
  size: 4
}, {
  left: 820,
  top: 38,
  size: 3
}, {
  left: 950,
  top: 48,
  size: 3
}, {
  left: 1100,
  top: 40,
  size: 4
}];
function Sprite({
  src,
  x,
  y,
  w,
  h,
  z = 5
}: Box & { src: string; z?: number }) {
  return <img src={src} alt="" className="absolute" style={{
    left: x,
    top: y,
    width: w,
    height: h,
    imageRendering: 'pixelated',
    objectFit: 'contain',
    zIndex: z
  }} />;
}
// TV screen — cycles through channel GIFs with brief static between flips.
// Powered down (renders nothing) when nobody is watching.
const TV_CHANNELS = ['/sprites/tv/cody-vs-bison.gif', '/sprites/tv/1_9Cv-HmxcZyEk75OXcIlo8g.gif', '/sprites/tv/172142.gif', '/sprites/tv/AqRry_.gif', '/sprites/tv/fxijoh1wp0291.gif', '/sprites/tv/G39sTMg.gif', '/sprites/tv/thimbleweed-park-wasptube1.gif', '/sprites/tv/V45wrCa.gif', '/sprites/tv/1IU1.gif', '/sprites/tv/88e5440b86d65fef5ec08e9747f93a63.gif', '/sprites/tv/all-you-can-eat.gif', '/sprites/tv/dance-dancing.gif', '/sprites/tv/Dl6k3i.gif', '/sprites/tv/giphy.gif', '/sprites/tv/giphy-1.gif', '/sprites/tv/giphy-downsized.gif', '/sprites/tv/giphy%20(1).gif', '/sprites/tv/giphy%20(2).gif', '/sprites/tv/hamster-jazz-band.gif', '/sprites/tv/running-ethan-hunt.gif', '/sprites/tv/SugHDy.gif', '/sprites/tv/UQdePR.gif', '/sprites/tv/vandamme-dancing.gif'];
const TV_STATIC = '/sprites/tv/static.gif';
const TV_CHANNEL_MS = 7000;
const TV_STATIC_MS = 1000;
function shuffledDeck(n: number): number[] {
  const deck = Array.from({
    length: n
  }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function TVScreen({
  isOn
}: { isOn?: boolean }) {
  const [channelIdx, setChannelIdx] = useState(0);
  const [showingStatic, setShowingStatic] = useState(false);
  // Bag-shuffle: every channel airs once per deck, then reshuffle.
  const deckRef = useRef(shuffledDeck(TV_CHANNELS.length));
  useEffect(() => {
    if (!isOn) return; // pause cycling when nobody is watching
    if (showingStatic) {
      const t = setTimeout(() => {
        setChannelIdx((current): number => {
          if (TV_CHANNELS.length <= 1) return 0;
          if (deckRef.current.length === 0) {
            const fresh = shuffledDeck(TV_CHANNELS.length);
            // Avoid back-to-back repeat across the deck boundary.
            if (fresh[0] === current && fresh.length > 1) {
              [fresh[0], fresh[1]] = [fresh[1], fresh[0]];
            }
            deckRef.current = fresh;
          }
          return deckRef.current.shift() ?? 0;
        });
        setShowingStatic(false);
      }, TV_STATIC_MS);
      return () => clearTimeout(t);
    } else {
      const t = setTimeout(() => setShowingStatic(true), TV_CHANNEL_MS);
      return () => clearTimeout(t);
    }
  }, [isOn, showingStatic, channelIdx]);
  if (!isOn) return null;
  const src = showingStatic ? TV_STATIC : TV_CHANNELS[channelIdx];
  return <img src={src} alt="" className="absolute" style={{
    left: 1040,
    top: 331,
    width: 132,
    height: 65,
    objectFit: 'fill',
    imageRendering: 'pixelated',
    zIndex: 8
  }} />;
}
function WaterPipe({
  x,
  y
}: { x: number; y: number }) {
  return <div className="absolute z-[12]" style={{
    left: x,
    top: y
  }}><div className="relative h-[18px] w-[14px] rounded-b-full rounded-t-[3px] border border-black/20 bg-[#8ec8e8]/60"><div className="absolute bottom-0 left-0 right-0 h-[55%] rounded-b-full bg-[#5ba8d4]/50" /><div className="absolute left-[15%] top-[10%] h-[60%] w-[20%] rounded-full bg-white/25" /></div><div className="absolute bottom-[16px] left-1/2 h-[16px] w-[5px] -translate-x-1/2 rounded-t-full border border-black/15 bg-[#8ec8e8]/50"><div className="absolute left-[20%] top-[10%] h-[70%] w-[25%] bg-white/20" /></div><div className="absolute bottom-[30px] left-1/2 h-[4px] w-[7px] -translate-x-1/2 rounded-t-full border border-black/15 bg-[#8ec8e8]/45" /><div className="absolute bottom-[12px] left-[11px] h-[4px] w-[8px] origin-left rotate-[-35deg] rounded-r-full border border-black/15 bg-[#7a7a7a]"><div className="absolute -top-[3px] right-[-2px] h-[5px] w-[5px] rounded-full border border-black/20 bg-[#6a6a6a]" /></div><motion.div className="absolute bottom-[4px] left-1/2 h-[2px] w-[2px] -translate-x-1/2 rounded-full bg-white/40" animate={{
      y: [0, -6, -10],
      opacity: [0.5, 0.3, 0],
      x: [-1, 1, 0]
    }} transition={{
      duration: 2.5,
      repeat: Infinity,
      ease: 'easeOut',
      repeatDelay: 4
    }} /><motion.div className="absolute bottom-[3px] left-[40%] h-[1.5px] w-[1.5px] rounded-full bg-white/30" animate={{
      y: [0, -5, -8],
      opacity: [0.4, 0.2, 0],
      x: [1, -1, 0]
    }} transition={{
      duration: 2,
      repeat: Infinity,
      ease: 'easeOut',
      delay: 1.2,
      repeatDelay: 4
    }} /></div>;
}
function Worker({
  worker,
  isActive,
  speech
}: { worker: WorkerDef; isActive?: boolean; speech?: string | null }) {
  return <div className="absolute z-20" style={{
    left: worker.x,
    top: worker.y,
    transform: 'translate(-50%, -50%)'
  }}><motion.div className="relative" animate={isActive ? {
      scale: [1, 1.1, 1]
    } : {}} transition={isActive ? {
      duration: 1.5,
      repeat: Infinity,
      ease: 'easeInOut'
    } : {}}><div className="absolute left-1/2 top-1/2 -translate-x-1/2 rounded-full bg-black/30" style={{
        width: 30,
        height: 14,
        marginTop: 12
      }} /><div className="relative rounded-full border-2 border-line-strong" style={{
        width: 26,
        height: 26,
        background: `radial-gradient(circle at 35% 35%, ${worker.color}dd, ${worker.color})`,
        boxShadow: isActive ? `0 0 14px ${worker.color}66` : 'none'
      }}><div className="absolute left-1/2 top-[28%] h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-white/80" /><div className="absolute left-[28%] top-[26%] h-1.5 w-1.5 rounded-full bg-white/50" /><div className="absolute right-[28%] top-[26%] h-1.5 w-1.5 rounded-full bg-white/50" />{isActive && <motion.div className="absolute -inset-3 rounded-full border-2" style={{
          borderColor: `${worker.color}55`
        }} animate={{
          scale: [1, 1.4, 1],
          opacity: [0.5, 0, 0.5]
        }} transition={{
          duration: 2,
          repeat: Infinity,
          ease: 'easeInOut'
        }} />}</div><div className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-black/75 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-ink" style={{
        top: 34
      }}>{worker.name}</div></motion.div><AnimatePresence>{speech && <motion.div initial={{
        opacity: 0,
        y: 6,
        scale: 0.92
      }} animate={{
        opacity: 1,
        y: 0,
        scale: 1
      }} exit={{
        opacity: 0,
        y: -4,
        scale: 0.95
      }} transition={{
        duration: 0.3
      }} className="absolute left-1/2 -translate-x-1/2 rounded-lg border border-line-strong bg-black/85 px-3 py-2 text-[10px] leading-tight text-ink backdrop-blur-sm" style={{
        bottom: 52,
        width: 150
      }}>{speech}<div className="absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent border-t-black/85" /></motion.div>}</AnimatePresence></div>;
}
/** Uptime on the current turn. Idle members have none to report. */
function uptimeLabel(startedAt: string, now: number, isActive: boolean): string {
  if (!isActive || !startedAt) return '—';
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return '—';

  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Energy is budget headroom. With no budget there is nothing to deplete, so it
 * says so rather than showing a full bar that never moves.
 */
function energyLabel(stats: OfficeMember): { text: string; pct: number | null } {
  if (!stats.tokenBudget || stats.tokenBudget <= 0) return { text: 'unlimited', pct: null };
  const left = Math.max(0, stats.tokenBudget - stats.billable);
  const pct = Math.round((left / stats.tokenBudget) * 100);
  return { text: `${pct}%`, pct };
}

function compactTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

function MemberStatCard({
  stats,
  x,
  y,
  isActive,
  now,
}: {
  stats: OfficeMember;
  x: number;
  y: number;
  isActive: boolean;
  now: number;
}) {
  const energy = energyLabel(stats);

  return (
    <div
      className="pointer-events-none absolute z-[60] w-[200px] -translate-x-1/2 rounded-lg border border-line bg-surface-raised/95 p-2.5 shadow-xl backdrop-blur-sm"
      style={{ left: x, top: y - 132 }}
      role="tooltip"
    >
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: stats.color }} />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-ink">{stats.name}</span>
        <span className="shrink-0 text-[9px] uppercase tracking-wider text-ink-faint">{stats.model || 'team'}</span>
      </div>

      <p className="mt-1.5 line-clamp-2 text-[10px] leading-snug text-ink-soft">
        {isActive && stats.currentTask ? stats.currentTask : stats.currentTask ? `Last: ${stats.currentTask}` : '—'}
      </p>

      <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1.5 border-t border-line pt-2">
        <div>
          <dt className="text-[8px] uppercase tracking-wider text-ink-faint">Uptime</dt>
          <dd className="font-mono text-[10px] text-ink">{uptimeLabel(stats.startedAt, now, isActive)}</dd>
        </div>
        <div>
          <dt className="text-[8px] uppercase tracking-wider text-ink-faint">Tokens</dt>
          <dd className="font-mono text-[10px] text-ink">{compactTokens(stats.billable)}</dd>
        </div>
        <div>
          <dt className="text-[8px] uppercase tracking-wider text-ink-faint">Cost</dt>
          <dd className="font-mono text-[10px] text-ink">${stats.usage.totalCostUsd.toFixed(3)}</dd>
        </div>
        <div>
          <dt className="text-[8px] uppercase tracking-wider text-ink-faint">Energy</dt>
          <dd className="font-mono text-[10px] text-ink">{energy.text}</dd>
          {energy.pct !== null && (
            <dd className="mt-0.5 h-0.5 overflow-hidden rounded-full bg-surface-overlay">
              <span
                className={`block h-full ${energy.pct > 25 ? 'bg-signal-ok' : 'bg-signal-warn'}`}
                style={{ width: `${energy.pct}%` }}
              />
            </dd>
          )}
        </div>
      </dl>
    </div>
  );
}

export function LunarOfficeScene({
  activePhase,
  agentStatus,
  latestSpeech,
  runFinalAudit = false,
  seats = {},
  members = [],
  onAgentClick
}: {
  activePhase: string;
  agentStatus: Record<string, string>;
  latestSpeech: Record<string, string | null>;
  runFinalAudit?: boolean;
  /** Which roster member occupies each desk. */
  seats?: SeatMap;
  /** Live roster data, for the hover stat card. */
  members?: OfficeMember[];
  onAgentClick?: (agent: string) => void;
}) {
  /** Desks whose occupant is mid-turn. Drives the active pose and glow. */
  const activeWorkerIds = useMemo(() => {
    const active = new Set<WorkerId>();
    for (const [agentId, status] of Object.entries(agentStatus)) {
      if (status !== 'active' && status !== 'working') continue;
      const seat = (Object.keys(seats) as WorkerId[]).find((id) => seats[id]?.agentId === agentId);
      if (seat) active.add(seat);
    }
    return active;
  }, [agentStatus, seats]);

  const sceneRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = sceneRef.current;
    if (!el) return;
    const obs = new ResizeObserver(entries => {
      for (const e of entries) setScale(e.contentRect.width / SCENE_W);
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  const [walkingIds, setWalkingIds] = useState<Set<WorkerId>>(new Set());
  const [idlePositions, setIdlePositions] = useState<Partial<Record<WorkerId, WorkerPos | null>>>({
    planner: null,
    reviewer: null,
    coder: null,
    tester: null,
    supervisor: null,
    auditor: null
  });
  // The wander timers fire seconds after being scheduled and need positions as
  // they are *then*, not as they were at schedule time, so the latest value is
  // mirrored into a ref. React's compiler lint flags the write either way —
  // during render as a ref access, in an effect as modifying an effect
  // dependency — and this form is the one that has always worked here.
  const idlePositionsRef = useRef(idlePositions);
  idlePositionsRef.current = idlePositions;

  const prevPhaseRef = useRef(activePhase);
  const idleTimerRef = useRef<number[]>([]);
  // When phase changes, only move pipeline workers immediately
  useLayoutEffect(() => {
    if (prevPhaseRef.current === activePhase) return;
    prevPhaseRef.current = activePhase;
    // Clear any pending idle timers
    idleTimerRef.current.forEach(t => window.clearTimeout(t));
    idleTimerRef.current = [];
    // Reset all idle positions — everyone returns home first
    setIdlePositions({
      planner: null,
      reviewer: null,
      coder: null,
      tester: null,
      supervisor: null,
      auditor: null
    });
    // Mark only pipeline movers as walking
    const overrides = phasePositions[activePhase as string] || {};
    const pipelineMovers = new Set<WorkerId>();
    for (const [key, pos] of Object.entries(overrides)) {
      const wId = key as WorkerId;
      if (!pos) continue;
      const home = homePositions[wId as WorkerId];
      if (pos.x !== home.x || pos.y !== home.y) pipelineMovers.add(wId as WorkerId);
    }
    setWalkingIds(pipelineMovers);
    // Stop pipeline walking after arrival
    const stopPipeline = window.setTimeout(() => {
      setWalkingIds(new Set());
    }, 2600);
    idleTimerRef.current.push(stopPipeline);
    // Stagger idle movements — one worker at a time, random delays
    const activeIds = new Set(Object.keys(overrides));
    const baseIdleWorkers: WorkerId[] = ['planner', 'reviewer', 'coder', 'tester', 'supervisor'];
    if (runFinalAudit) baseIdleWorkers.push('auditor');
    const idleWorkers = baseIdleWorkers.filter(id => !activeIds.has(id));
    // Shuffle idle workers
    const shuffled = [...idleWorkers].sort(() => Math.random() - 0.5);
    // Pick spots without overlap
    const usedSpotIdxs = new Set<number>();
    shuffled.forEach((wId, i) => {
      // 50% chance to wander, 50% stay at desk
      if (Math.random() < 0.5) return;
      // Stagger: first idle worker moves at 2s, next at 4.5s, etc.
      const delay = 2000 + i * 2500;
      const timer = window.setTimeout(() => {
        // Compute external occupied positions (other workers' actual current positions)
        // plus already-batched assignments from this wander cycle.
        const externalOccupied = computeOccupiedPositions(wId as WorkerId, activePhase, runFinalAudit, idlePositionsRef.current);
        const batchedOccupied = Array.from(usedSpotIdxs).map(i => ({
          x: idleSpots[i].x,
          y: idleSpots[i].y,
          facing: 'right'
        }));
        const allOccupied = [...externalOccupied, ...batchedOccupied];
        // Find an available spot. Skip the TV corner — it is a group spot, only sendGroup() puts agents there.
        const startIdx = Math.floor(Math.random() * idleSpots.length);
        for (let attempt = 0; attempt < idleSpots.length; attempt++) {
          const idx = (startIdx + attempt) % idleSpots.length;
          if (usedSpotIdxs.has(idx)) continue;
          const spot = idleSpots[idx];
          if (spot.label === 'tv') continue;
          if (!isCandidateBlocked(spot, allOccupied)) {
            usedSpotIdxs.add(idx);
            const isCouch = spot.label === 'sofa';
            const isHookah = spot.label === 'cafe';
            const isPingPong = spot.label === 'tv';
            const isGroupSpot = isCouch || isHookah || isPingPong;
            const home = homePositions[wId as WorkerId];
            const spotFacing = isCouch ? 'back' : isHookah ? 'front' : isPingPong ? spot.x < 210 ? 'right' : 'left' : spot.x < home.x ? 'left' : 'right';
            // Walk facing the direction of movement, switch to spot facing on arrival
            const walkFacing = spot.x < home.x ? 'left' : 'right';
            setWalkingIds(prev => new Set([...prev, wId]));
            setIdlePositions(prev => ({
              ...prev,
              [wId]: {
                x: spot.x,
                y: spot.y,
                facing: walkFacing
              }
            }));
            // Stop walking and switch to destination facing on arrival
            const stopTimer = window.setTimeout(() => {
              setWalkingIds(prev => {
                const next = new Set<WorkerId>(prev);
                next.delete(wId);
                return next;
              });
              setIdlePositions(prev => prev[wId as WorkerId] ? {
                ...prev,
                [wId]: {
                  ...prev[wId as WorkerId],
                  facing: spotFacing
                }
              } : prev);
            }, 2600);
            idleTimerRef.current.push(stopTimer);
            // Return home after a while — group spots: 30-60s, other spots: 3-5s
            const stayDuration = isGroupSpot ? 30000 + Math.random() * 30000 : 3000 + Math.random() * 2000;
            const returnTimer = window.setTimeout(() => {
              const home = homePositions[wId as WorkerId];
              const returnWalkFacing = home.x < spot.x ? 'left' : 'right';
              setWalkingIds(prev => new Set([...prev, wId]));
              setIdlePositions(prev => ({
                ...prev,
                [wId]: {
                  x: home.x,
                  y: home.y,
                  facing: returnWalkFacing
                }
              }));
              const returnStopTimer = window.setTimeout(() => {
                setWalkingIds(prev => {
                  const next = new Set<WorkerId>(prev);
                  next.delete(wId);
                  return next;
                });
                setIdlePositions(prev => ({
                  ...prev,
                  [wId]: null
                })); // null = back to homePositions facing
              }, 2600);
              idleTimerRef.current.push(returnStopTimer);
            }, stayDuration);
            idleTimerRef.current.push(returnTimer);
            break;
          }
        }
      }, delay);
      idleTimerRef.current.push(timer);
    });
    return () => {
      window.clearTimeout(stopPipeline);
    };
  }, [activePhase, runFinalAudit]);
  // Periodic idle wandering — independent of phase changes
  // Every 15-25s, pick a random non-active agent and send them somewhere
  // Occasionally triggers group gatherings at the cafe or the sofas
  const idleWanderRef = useRef<number[]>([]);
  useEffect(() => {
    // Send a group of agents to a group spot (the cafe bar, the sofa cluster or the TV corner)
    function sendGroup(groupLabel: string, agents: WorkerId[]) {
      const allSpots = idleSpots.filter(s => s.label === groupLabel);
      // Filter to spots NOT already occupied by some other worker (idle position OR home OR phase override).
      // Without this, sendGroup blindly assigns spots by index and stomps on whoever's already there
      // (e.g. Eddie's home is on a couch spot; a second TV group can land on the existing pair).
      const unoccupiedSpots = allSpots.filter(spot => {
        return !workers.some(w => {
          if (agents.includes(w.id)) return false; // ignore the agents we're about to send
          if (w.id === 'auditor' && !runFinalAudit) return false;
          const phasePos = phasePositions[activePhase as string]?.[w.id];
          const idlePos = idlePositionsRef.current[w.id];
          const home = homePositions[w.id as WorkerId];
          const cur = phasePos || idlePos || home;
          return cur.x === spot.x && cur.y === spot.y;
        });
      });
      // Pingpong requires a partner — abort if both spots aren't free.
      if (groupLabel === 'tv' && unoccupiedSpots.length < 2) return;
      // Hookah/couch: skip if every seat is taken.
      if (unoccupiedSpots.length === 0) return;
      const spots = unoccupiedSpots;
      // Pingpong is a paired game — both players leave together. Compute one shared
      // wall-clock return time so agent[1] doesn't get stranded alone after agent[0] heads home.
      const sharedReturnAt = groupLabel === 'tv' ? performance.now() + (30000 + Math.random() * 30000) : null;
      // Per-spot final facing:
      //   couch    -> back (sit, look at TV)
      //   cafe     -> front (facing out from the bar)
      //   tv       -> back (facing the television)
      const facingForSpot = (spot: Candidate): Facing => {
        if (groupLabel === 'sofa') return 'back';
        if (groupLabel === 'tv') return spot.x < 210 ? 'right' : 'left';
        return 'front';
      };
      agents.forEach((wId: WorkerId, i: number) => {
        if (i >= spots.length) return;
        const spot = spots[i];
        const facing = facingForSpot(spot);
        // Stagger departures slightly
        const departTimer = window.setTimeout(() => {
          const currentPos = idlePositions[wId as WorkerId] || homePositions[wId as WorkerId];
          const groupWalkFacing = spot.x < currentPos.x ? 'left' : 'right';
          setWalkingIds(p => new Set<WorkerId>([...p, wId as WorkerId]));
          setIdlePositions(prev => ({
            ...prev,
            [wId]: {
              x: spot.x,
              y: spot.y,
              facing: groupWalkFacing
            }
          }));
          const stopTimer = window.setTimeout(() => {
            setWalkingIds(p => {
              const n = new Set<WorkerId>(p);
              n.delete(wId as WorkerId);
              return n;
            });
            setIdlePositions(prev => prev[wId as WorkerId] ? {
              ...prev,
              [wId]: {
                ...prev[wId as WorkerId],
                facing
              }
            } : prev);
          }, 2600);
          idleWanderRef.current.push(stopTimer);
          // Return home — the TV group shares a return time so they leave together.
          // Other group spots use their own random delay (chilling agents leave independently).
          const returnDelay = sharedReturnAt !== null ? Math.max(0, sharedReturnAt - performance.now()) : 30000 + Math.random() * 30000;
          const returnTimer = window.setTimeout(() => {
            const home = homePositions[wId as WorkerId];
            const returnFacing = home.x < spot.x ? 'left' : 'right';
            setWalkingIds(p => new Set<WorkerId>([...p, wId as WorkerId]));
            setIdlePositions(p => ({
              ...p,
              [wId]: {
                x: home.x,
                y: home.y,
                facing: returnFacing
              }
            }));
            const returnStop = window.setTimeout(() => {
              setWalkingIds(p => {
                const n = new Set<WorkerId>(p);
                n.delete(wId as WorkerId);
                return n;
              });
              setIdlePositions(p => ({
                ...p,
                [wId]: null
              }));
            }, 2600);
            idleWanderRef.current.push(returnStop);
          }, returnDelay);
          idleWanderRef.current.push(returnTimer);
        }, i * 1500);
        idleWanderRef.current.push(departTimer);
      });
    }
    function scheduleWander() {
      const delay = 15000 + Math.random() * 10000; // 15-25s
      const timer = window.setTimeout(() => {
        const allIds = ['planner', 'reviewer', 'coder', 'tester', 'supervisor'];
        if (runFinalAudit) allIds.push('auditor');
        // Filter to agents not actually working in the pipeline
        const available = allIds.filter(id => !activeWorkerIds.has(id as WorkerId));
        if (available.length === 0) {
          scheduleWander();
          return;
        }
        // 50% chance of group gathering when 2+ agents available.
        // Weighted: the TV corner reads best on screen, so it fires more often than the cafe or sofas.
        if (available.length >= 2 && Math.random() < 0.5) {
          const shuffled = [...available].sort(() => Math.random() - 0.5);
          const groupSize = Math.min(2 + Math.floor(Math.random() * 2), shuffled.length); // 2-3 agents
          const group = shuffled.slice(0, groupSize);
          // Weights: tv 55%, cafe 25%, sofa 20%
          const r = Math.random();
          const spot = r < 0.55 ? 'tv' : r < 0.80 ? 'cafe' : 'sofa';
          // Pingpong always uses exactly 2 players — trim group if it's bigger.
          const finalGroup = spot === 'tv' ? group.slice(0, 2) : group;
          sendGroup(spot as string, finalGroup as WorkerId[]);
          scheduleWander();
          return;
        }
        // Pick a random available agent
        const wId = available[Math.floor(Math.random() * available.length)];
        // Figure out current position (use ref for fresh state)
        const currentIdle = idlePositionsRef.current;
        const currentPos = currentIdle[wId as WorkerId] || homePositions[wId as WorkerId];
        const isOut = currentIdle[wId as WorkerId] != null;
        if (isOut) {
          // Walk home — set facing based on direction, then clear after arrival
          const home = homePositions[wId as WorkerId];
          const facing = home.x < currentPos.x ? 'left' : 'right';
          setWalkingIds(p => new Set<WorkerId>([...p, wId as WorkerId]));
          setIdlePositions(prev => ({
            ...prev,
            [wId]: {
              x: home.x,
              y: home.y,
              facing
            }
          }));
          const stopTimer = window.setTimeout(() => {
            setWalkingIds(p => {
              const n = new Set<WorkerId>(p);
              n.delete(wId as WorkerId);
              return n;
            });
            setIdlePositions(prev => ({
              ...prev,
              [wId]: null
            }));
          }, 2600);
          idleWanderRef.current.push(stopTimer);
        } else {
          // Walk to a random spot — avoid spots occupied by other agents
          // Considers ALL other workers' actual positions (phase override > idle > home)
          // so wanderers don't land on top of someone at home or at a phase desk.
          // Pingpong is excluded here — it requires a partner, so only sendGroup() puts agents there.
          const occupiedPositions = computeOccupiedPositions(wId as WorkerId, activePhase, runFinalAudit, idlePositionsRef.current);
          const soloSpots = idleSpots.filter(s => s.label !== 'tv');
          const startIdx = Math.floor(Math.random() * soloSpots.length);
          let spot = soloSpots[startIdx];
          for (let attempt = 0; attempt < soloSpots.length; attempt++) {
            const candidate = soloSpots[(startIdx + attempt) % soloSpots.length];
            if (!isCandidateBlocked(candidate, occupiedPositions)) {
              spot = candidate;
              break;
            }
          }
          const isCouch = spot.label === 'sofa';
          const isHookah = spot.label === 'cafe';
          const isPingPong = spot.label === 'tv';
          const isGroupSpot = isCouch || isHookah || isPingPong;
          const spotFacing = isCouch ? 'back' : isHookah ? 'front' : isPingPong ? spot.x < 210 ? 'right' : 'left' : spot.x < currentPos.x ? 'left' : 'right';
          setWalkingIds(p => new Set<WorkerId>([...p, wId as WorkerId]));
          setIdlePositions(prev => ({
            ...prev,
            [wId]: {
              x: spot.x,
              y: spot.y,
              facing: spotFacing
            }
          }));
          const stopTimer = window.setTimeout(() => {
            setWalkingIds(p => {
              const n = new Set<WorkerId>(p);
              n.delete(wId as WorkerId);
              return n;
            });
          }, 2600);
          idleWanderRef.current.push(stopTimer);
          // Group spots: return home after 30-60s
          if (isGroupSpot) {
            const returnTimer = window.setTimeout(() => {
              const home = homePositions[wId as WorkerId];
              const returnFacing = home.x < spot.x ? 'left' : 'right';
              setWalkingIds(p => new Set<WorkerId>([...p, wId as WorkerId]));
              setIdlePositions(p => ({
                ...p,
                [wId]: {
                  x: home.x,
                  y: home.y,
                  facing: returnFacing
                }
              }));
              const returnStop = window.setTimeout(() => {
                setWalkingIds(p => {
                  const n = new Set<WorkerId>(p);
                  n.delete(wId as WorkerId);
                  return n;
                });
                setIdlePositions(p => ({
                  ...p,
                  [wId]: null
                }));
              }, 2600);
              idleWanderRef.current.push(returnStop);
            }, 30000 + Math.random() * 30000);
            idleWanderRef.current.push(returnTimer);
          }
        }
        scheduleWander();
      }, delay);
      idleWanderRef.current.push(timer);
    }
    scheduleWander();
    return () => idleWanderRef.current.forEach(t => window.clearTimeout(t));
  }, [activePhase, runFinalAudit, activeWorkerIds]);
  // Speech only shows after walking stops, randomized per agent per phase
  const [showSpeech, setShowSpeech] = useState(false);
  const [hoveredSeat, setHoveredSeat] = useState<WorkerId | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Only tick while somebody is mid-turn — an idle office has no uptime.
  useEffect(() => {
    if (!hoveredSeat) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hoveredSeat]);
  const [currentSpeech, setCurrentSpeech] = useState<Partial<Record<WorkerId, string>>>({});
  useLayoutEffect(() => {
    setShowSpeech(false);
    setCurrentSpeech({
      planner: getRandomSpeech('planner', activePhase),
      reviewer: getRandomSpeech('reviewer', activePhase),
      coder: getRandomSpeech('coder', activePhase),
      tester: getRandomSpeech('tester', activePhase),
      auditor: runFinalAudit ? getRandomSpeech('auditor', activePhase) : '',
      supervisor: getRandomSpeech('supervisor', activePhase)
    });
    const timer = window.setTimeout(() => setShowSpeech(true), 3200);
    return () => window.clearTimeout(timer);
  }, [activePhase, runFinalAudit]);
  // Determine active workers from agentStatus

  // TV is on whenever any agent is parked at a couch spot (idle wander OR home position).
  // Used to gate the TVScreen channel cycling.
  const couchOccupied = useMemo(() => {
    const couchSpots = idleSpots.filter(s => s.label === 'tv');
    return workers.some(w => {
      if (w.id === 'auditor' && !runFinalAudit) return false;
      const phasePos = phasePositions[activePhase as string]?.[w.id];
      const idlePos = idlePositions[w.id];
      const home = homePositions[w.id as WorkerId];
      const cur = phasePos || idlePos || home;
      return couchSpots.some(s => s.x === cur.x && s.y === cur.y);
    });
  }, [activePhase, idlePositions, runFinalAudit]);
  // Check if both ping pong spots are occupied
  const pingPongSpots = idleSpots.filter(s => s.label === 'tv');
  const pingPongPlayers = Object.values(idlePositions).filter(p => p && pingPongSpots.some(s => Math.abs(s.x - p.x) < 10 && Math.abs(s.y - p.y) < 10)).length;
  const pingPongActive = pingPongPlayers >= 2;
  // Warm bar lighting kicks in when somebody is at the cafe
  const cafeSpots = idleSpots.filter(s => s.label === 'cafe');
  const cafeActive = Object.values(idlePositions).some(p => p && cafeSpots.some(s => Math.abs(s.x - p.x) < 10 && Math.abs(s.y - p.y) < 10));
  const label = phaseLabels[activePhase] || activePhase;
  const seatedCount = Object.values(seats).filter(Boolean).length;
  // The ticker reports the run rather than asserting one is happening: it used
  // to read "BUILD IN PROGRESS" even with nothing running.
  const working = activeWorkerIds.size > 0;
  const tickerText =
    `/// HACKEROOM /// ${label.toUpperCase()} /// ` +
    `${seatedCount} ${seatedCount === 1 ? 'MEMBER' : 'MEMBERS'} SEATED /// ` +
    `${working ? 'BUILD IN PROGRESS' : 'STANDING BY'} /// `;
  return <div className="rounded-2xl border border-line bg-[#0e0c10] p-1 sm:p-2"><div ref={sceneRef} className="overflow-hidden rounded-xl border border-[#4a3a36]" style={{
      height: SCENE_H * scale
    }}><div className="relative origin-top-left" style={{
        width: SCENE_W,
        height: SCENE_H,
        transform: `scale(${scale})`
      }}>
        {/* The room itself. Everything below is drawn on top of it. */}
        <img
          src="/dev_office.webp"
          alt=""
          width={SCENE_W}
          height={SCENE_H}
          className="pointer-events-none absolute inset-0 h-full w-full select-none"
          style={{ imageRendering: 'pixelated' }}
          draggable={false}
        />
        {/* The artwork has a TV; this plays on its screen. */}
        <div className="absolute" style={{ left: 800, top: 318, width: 172, height: 100 }}>
          <TVScreen isOn={couchOccupied} />
        </div>
        
{workers.filter(w => w.id !== 'auditor' || runFinalAudit).map(w => {
          const wId = w.id as WorkerId;
          const phaseOverride = phasePositions[activePhase as string]?.[wId];
          const idleOverride = idlePositions[wId as WorkerId];
          const home = homePositions[wId as WorkerId];
          const pos = phaseOverride || idleOverride || home;
          const isActive = activeWorkerIds.has(wId);
          const isWalking = walkingIds.has(wId);
          // Whoever fills this desk's slot. An empty desk draws nothing — the
          // artwork already has an empty chair there, and adding a greyed-out
          // person invents somebody who is not on the team.
          const occupant = seats[wId];
          if (!occupant) return null;

          const speech = latestSpeech[occupant.agentId];
          // "Waiting" = at a phase interaction position but partner is the active one
          const isWaiting = !!phaseOverride && !isActive && !isWalking;
          // Show speech bubbles for active agents
          const bubbleText = isActive && !isWalking ? speech || (showSpeech ? currentSpeech[wId] : null) : null;
          const stats = members.find(m => m.id === occupant.agentId);
          return <div
            key={w.id}
            onClick={() => onAgentClick?.(occupant.agentId)}
            onMouseEnter={() => setHoveredSeat(wId)}
            onMouseLeave={() => setHoveredSeat(null)}
            className="cursor-pointer"
          >{hoveredSeat === wId && stats && <MemberStatCard stats={stats} x={pos.x} y={pos.y} isActive={isActive} now={nowMs} />}<PixelSprite id={w.id} name={occupant.name} title="" bodyColor={occupant.color} x={pos.x} y={pos.y} isActive={isActive} isWalking={isWalking} isWaiting={isWaiting} facing={pos.facing} carrying={phaseCarriers[activePhase] === wId} speech={bubbleText} /></div>;
        })}<div className="absolute left-3 top-3 z-30 rounded-md border border-line bg-black/50 px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.24em] text-[#d7d4cd]">Mission Control</div><div className="absolute right-3 top-3 z-30 rounded-md border border-line bg-black/60 px-3 py-2 text-right backdrop-blur-sm"><p className="font-mono text-[9px] uppercase tracking-[0.24em] text-[#c8b9a7]">Hackeroom</p><p className="mt-0.5 text-sm font-semibold text-ink">{label}</p></div><div className="absolute inset-x-0 bottom-0 z-30 h-[22px] overflow-hidden border-t border-[#38313a] bg-black/90"><motion.div className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-[10px] text-[#35f38f]/80" animate={{
            x: [0, -1200]
          }} transition={{
            duration: 25,
            repeat: Infinity,
            ease: 'linear'
          }}>{tickerText}{tickerText}</motion.div></div></div></div></div>;
}