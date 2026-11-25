import type * as THREE from 'three';
import type { SlotId } from '@/lib/team/types';
import type { OfficeMember } from '@/components/mission/MemberStatCard';
import type { SeatOccupant, SeatMap } from '@/components/mission/LunarOfficeScene';

export type FacingDirection = 'front' | 'back' | 'left' | 'right';

export interface AABB {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  label?: string;
}

export interface WorkstationDef {
  slot: SlotId;
  label: string;
  /** Center coordinates in 3D world space (X = right/left, Y = height, Z = forward/back) */
  position: [number, number, number];
  /** Rotation around Y axis in radians */
  rotationY: number;
  /** Interaction bounding box around desk */
  bounds: AABB;
}

export interface ActiveWorkstationState {
  slot: SlotId;
  occupant?: SeatOccupant;
  memberStats?: OfficeMember;
  status: 'idle' | 'active' | 'working' | 'waiting';
  speech: string | null;
  position: THREE.Vector3;
}

export interface InteractionTarget {
  agentId: string;
  name: string;
  role: string;
  slot: SlotId;
  screenPosition: { x: number; y: number } | null;
  distance: number;
}

export interface StudioConfig {
  roomWidth: number;
  roomDepth: number;
  roomHeight: number;
  wallThickness: number;
  avatarSpeed: number;
  interactionRadius: number;
}

export interface Studio3DProps {
  activePhase: string;
  agentStatus: Record<string, string>;
  latestSpeech: Record<string, string | null>;
  seats?: SeatMap;
  guests?: SeatOccupant[];
  members?: OfficeMember[];
  onAgentClick?: (agentId: string) => void;
  className?: string;
}
