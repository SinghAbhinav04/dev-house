'use client';

import React, { useRef, useEffect, useState, useCallback } from 'react';
import * as THREE from 'three';
import type { SeatMap, SeatOccupant } from '@/components/mission/LunarOfficeScene';
import type { OfficeMember } from '@/components/mission/MemberStatCard';
import type { SlotId } from '@/lib/team/types';
import { SLOT_LABELS } from '@/lib/team/types';
import { createStarfield } from './core/starfield';
import { buildFloatingIsland } from './core/island-builder';
import { buildStudioArchitecture } from './core/studio-architecture';
import { buildWorkstations, WORKSTATION_CONFIGS, type WhiteboardContent } from './core/workstation-builder';

export type { WhiteboardContent };
import { buildInteractiveRoomFeatures } from './core/interactive-room-features';
import { buildExteriorScenery, type ExteriorSceneryResult } from './core/exterior-scenery';
import { createDayNightCycle, type DayNightCycleResult, type TimeOfDayMode } from './core/day-night-cycle';
import { buildCozyProps } from './core/cozy-props';
import {
  createStylizedCharacter,
  type StylizedCharacterResult,
  type HairStyle,
} from './core/stylized-character';
import { createCameraRig } from './core/camera-rig';
import { TextureCache } from './core/texture-cache';
import { resolveAllObstacles } from './math/collision';
import { buildNavGrid } from './core/nav-grid';
import { createStudioStage, seatOf, type ActorSeat, type StageView } from './core/agent-actor';
import { createDirector, ingest, nextDirection, type DirectorEvent, type DirectorState } from '@/lib/studio-director';
import { BOARD_COLUMNS, ticketsInColumn, type Ticket } from '@/lib/tickets';
import type { CommanderBoardColumn } from './core/screen-texture-factory';
import { createLabelLayer, type LabelItem, type ScreenRect } from './core/label-layer';

export interface StudioCanvasProps {
  activePhase: string;
  agentStatus: Record<string, string>;
  latestSpeech: Record<string, string | null>;
  seats?: SeatMap;
  guests?: SeatOccupant[];
  members?: OfficeMember[];
  timeOfDayMode?: TimeOfDayMode;
  isLightsOn?: boolean;
  isACOn?: boolean;
  /** What the whiteboard shows; drawn again whenever this object changes. */
  whiteboard?: WhiteboardContent;
  /** The run's events: hand-offs, board writes and QA turns are acted out in the room. */
  events?: readonly DirectorEvent[];
  /** The run's tickets, drawn on the commander desk's screen; and the run's title. */
  tickets?: readonly Ticket[];
  boardTitle?: string;
  /**
   * A modal is open over the studio: keys go to the modal, not the player,
   * and the scene behind it redraws at a few frames a second.
   */
  paused?: boolean;
  onAgentClick?: (agentId: string) => void;
  onOpenCommanderDesk?: () => void;
  /** A teammate (or an empty desk: member null) was clicked or interacted with. */
  onInspectCharacter?: (member: OfficeMember | null, slot: SlotId, status: string, activity?: string) => void;
  onOpenWhiteboard?: () => void;
  onControlsReady?: (controls: {
    cycleTimeOfDay: () => void;
    toggleLights: () => void;
    toggleAC: () => void;
    updateWhiteboardPlan: (content: WhiteboardContent) => void;
  }) => void;
}

const ROLE_COLORS: Record<SlotId, string> = {
  planner: '#c084fc',
  reviewer: '#7fa8a0',
  coder: '#8fae60',
  tester: '#d9a441',
  supervisor: '#d98b4d',
  auditor: '#cf6c5a',
};

const ROLE_HAIRSTYLES: Record<SlotId, HairStyle> = {
  planner: 'bun',     // Chic hair bun matching video
  reviewer: 'short',   // Sleek parted hair
  coder: 'cap',       // Backward baseball cap
  tester: 'beanie',   // Cozy tech beanie
  supervisor: 'short',// Executive short hair
  auditor: 'short',
};

const ROOM_WIDTH = 18;
const ROOM_DEPTH = 15;
/** How close you need to be to a teammate (from where they are now) to talk to them. */
const INTERACTION_RADIUS = 2.6;

// Spawns on 2F Dev House Engineering Studio (y = 0) in front of Commander Desk ("My Computer")
const persistentPlayerPos = new THREE.Vector3(0, 0, 1.8);
let persistentFacingAngle = 0;

export function StudioCanvas({
  activePhase,
  agentStatus,
  latestSpeech,
  seats = {},
  guests = [],
  members = [],
  timeOfDayMode: controlledTimeMode,
  isLightsOn: controlledLights,
  isACOn: controlledAC,
  whiteboard,
  events,
  tickets,
  boardTitle,
  paused = false,
  onAgentClick,
  onOpenCommanderDesk,
  onInspectCharacter,
  onOpenWhiteboard,
  onControlsReady,
}: StudioCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [caffeineRemaining, setCaffeineRemaining] = useState<number>(0);

  // Direct DOM refs for in-world 60 FPS overlays (Zero React re-renders in RAF loop!)
  const roomPromptRef = useRef<HTMLDivElement>(null);
  const roomPromptTitleRef = useRef<HTMLSpanElement>(null);
  const roomPromptSubRef = useRef<HTMLSpanElement>(null);
  const perfRef = useRef<HTMLPreElement>(null);

  // Proximity flags for key bindings
  const nearCmdRef = useRef(false);
  const nearRoomFeatureRef = useRef<'lights' | 'ac' | 'coffeeMachine' | 'coffeeCup' | 'whiteboard' | null>(null);
  const targetAgentIdRef = useRef<string | null>(null);

  // Trigger handlers into Three.js scene (zero remounts!)
  const featureActionTriggerRef = useRef<((feature: 'lights' | 'ac' | 'coffeeMachine' | 'coffeeCup' | 'whiteboard') => void) | null>(null);
  const timeModeTriggerRef = useRef<((mode: TimeOfDayMode) => void) | null>(null);
  const updateWhiteboardTriggerRef = useRef<((content: WhiteboardContent) => void) | null>(null);
  const commanderBoardRef = useRef<((title: string, columns: CommanderBoardColumn[]) => void) | null>(null);
  const commanderBoardData = useRef<{ title: string; columns: CommanderBoardColumn[] }>({ title: '', columns: [] });

  // Stage directions from the run's events, pulled per desk by the render loop.
  const directorRef = useRef<DirectorState>(createDirector());
  /** What each desk's teammate is doing right now, for the inspector and labels. */
  const stageViewRef = useRef<(slot: SlotId) => StageView | undefined>(() => undefined);

  // Mutable ref for ALL props & callbacks
  const propsRef = useRef({
    agentStatus,
    latestSpeech,
    seats,
    guests,
    members,
    activePhase,
    whiteboard,
    paused,
    onAgentClick,
    onOpenCommanderDesk,
    onInspectCharacter,
    onOpenWhiteboard,
    onControlsReady,
  });

  // Keep props synced without triggering any effect re-execution
  useEffect(() => {
    propsRef.current = {
      agentStatus,
      latestSpeech,
      seats,
      guests,
      members,
      activePhase,
      whiteboard,
      paused,
      onAgentClick,
      onOpenCommanderDesk,
      onInspectCharacter,
      onOpenWhiteboard,
      onControlsReady,
    };
  });

  // The commander screen shows the board; redrawn only when the tickets change.
  useEffect(() => {
    const colorOf = (id: string | null) => members.find((m) => m.id === id)?.color || '#8a7a6b';
    const columns = BOARD_COLUMNS.map((column) => {
      const cards = ticketsInColumn(tickets ?? [], column.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return {
        label: column.label,
        count: cards.length,
        cards: cards.slice(0, 4).map((t) => ({ id: t.id, title: t.title, color: colorOf(t.assignee) })),
      };
    });
    commanderBoardData.current = { title: boardTitle ?? '', columns };
    commanderBoardRef.current?.(boardTitle ?? '', columns);
  }, [tickets, boardTitle, members]);

  // Turn new events into stage directions (seated teammates only).
  useEffect(() => {
    const seated = new Set(Object.values(seats).map((o) => o?.agentId).filter((id): id is string => Boolean(id)));
    directorRef.current = ingest(directorRef.current, events ?? [], (id) => seated.has(id));
  }, [events, seats]);

  // Sync controlled timeOfDayMode
  useEffect(() => {
    if (controlledTimeMode) {
      timeModeTriggerRef.current?.(controlledTimeMode);
    }
  }, [controlledTimeMode]);

  // Sync controlled isLightsOn
  useEffect(() => {
    if (controlledLights !== undefined) {
      featureActionTriggerRef.current?.('lights');
    }
  }, [controlledLights]);

  // Sync controlled isACOn
  useEffect(() => {
    if (controlledAC !== undefined) {
      featureActionTriggerRef.current?.('ac');
    }
  }, [controlledAC]);

  // Redraw the whiteboard when the brief or plan changes
  useEffect(() => {
    if (whiteboard !== undefined) {
      updateWhiteboardTriggerRef.current?.(whiteboard);
    }
  }, [whiteboard]);

  const showToast = useCallback((msg: string) => {
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
    setToastMessage(msg);
    toastTimeoutRef.current = setTimeout(() => {
      setToastMessage(null);
    }, 3200);
  }, []);

  const showToastRef = useRef(showToast);
  useEffect(() => {
    showToastRef.current = showToast;
  });

  /**
   * Open the inspector for a desk: the same for a click on the character, E,
   * or the prompt. An empty desk says so rather than inventing a teammate.
   */
  const inspectSlot = useCallback((slot: SlotId) => {
    const currentProps = propsRef.current;
    const occupant = currentProps.seats[slot];
    const member = occupant ? currentProps.members.find((m) => m.id === occupant.agentId) ?? null : null;
    const status = occupant ? currentProps.agentStatus[occupant.agentId] || 'idle' : 'idle';
    const activity = stageViewRef.current(slot)?.activity;
    currentProps.onInspectCharacter?.(member, slot, status, activity);
    if (member) currentProps.onAgentClick?.(member.id);
  }, []);

  const handleInteract = useCallback((agentId: string) => {
    const seatMap = propsRef.current.seats;
    const slot = (Object.keys(seatMap) as SlotId[]).find((s) => seatMap[s]?.agentId === agentId);
    if (slot) inspectSlot(slot);
  }, [inspectSlot]);


  // MOUNT ONCE: Main Three.js Scene Setup & Game Loop
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    let width = container.clientWidth || 1024;
    let height = container.clientHeight || 640;

    // 1. High-Performance WebGL Renderer with ACES Tone Mapping & Shadows
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      alpha: true,
    });
    renderer.setSize(width, height);
    const maxDpr = Math.min(window.devicePixelRatio, 2);
    renderer.setPixelRatio(maxDpr);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.35;

    // 2. Scene & Texture Cache
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#386b9e');
    // Initialize scene.fog from Frame 0 with huge distance so #define USE_FOG is compiled into all shaders once
    scene.fog = new THREE.Fog(new THREE.Color('#386b9e'), 1500, 3000);
    const textureCache = new TextureCache();

    // 3. Dynamic Day/Night Cycle with PBR Sun/Moon Directional Shadows
    const dayNightCycle: DayNightCycleResult = createDayNightCycle();
    scene.add(dayNightCycle.sunLight);
    scene.add(dayNightCycle.moonLight);
    scene.add(dayNightCycle.hemiLight);
    scene.add(dayNightCycle.ambientLight);

    timeModeTriggerRef.current = (mode: TimeOfDayMode) => {
      dayNightCycle.setTimeMode(mode);
    };

    // 4. Exterior City Scenery: Roadway, Driving Cars, Pedestrians, Trees, Streetlamps
    const scenery: ExteriorSceneryResult = buildExteriorScenery(textureCache);
    scene.add(scenery.group);

    // 5. Environment: Deep Space Starfield (Visible at Night)
    const starfield = createStarfield();
    scene.add(starfield.group);

    const island = buildFloatingIsland(ROOM_WIDTH, ROOM_DEPTH, textureCache);
    scene.add(island.group);

    // 6. Single Active Floor Studio Architecture with Dynamic Lift
    const architecture = buildStudioArchitecture(ROOM_WIDTH, ROOM_DEPTH, 4.2, textureCache);
    scene.add(architecture.group);

    // 7. Workstations across active floors (with WHOLE TEAM on Floor 2 & live realistic screens!)
    const workstationSystem = buildWorkstations(textureCache);
    scene.add(workstationSystem.group);

    // 8. Interactive In-Room Environmental Props (Lights, AC, Espresso Coffee Bar)
    const allRoomLights: THREE.Light[] = [
      ...architecture.roomLights,
      ...scenery.streetLights,
      dayNightCycle.hemiLight,
      dayNightCycle.ambientLight,
      dayNightCycle.sunLight,
    ];
    const roomFeatures = buildInteractiveRoomFeatures(textureCache, allRoomLights);
    scene.add(roomFeatures.group);
    workstationSystem.obstacles.push(roomFeatures.obstacle);

    // 9. Ground floor cozy props (Robot companion, Terrarium, Bookshelf)
    const cozyProps = buildCozyProps(textureCache);
    scene.add(cozyProps.group);

    // Register external control hooks & sync initial plan
    propsRef.current.onControlsReady?.({
      cycleTimeOfDay: () => {
        const next: TimeOfDayMode = dayNightCycle.mode === 'day' ? 'sunset' : dayNightCycle.mode === 'sunset' ? 'night' : 'day';
        dayNightCycle.setTimeMode(next);
        showToastRef.current(`Time of Day: ${next.toUpperCase()}`);
      },
      toggleLights: () => {
        const on = roomFeatures.toggleLights();
        showToastRef.current(on ? 'Studio Lights ON' : 'Cozy Mode (Lights OFF)');
      },
      toggleAC: () => {
        const on = roomFeatures.toggleAC();
        showToastRef.current(on ? 'AC Unit ON (70°F)' : 'AC Unit Standby');
      },
      updateWhiteboardPlan: (content: WhiteboardContent) => {
        workstationSystem.updateWhiteboardPlan(content);
      },
    });

    commanderBoardRef.current = (title, columns) => workstationSystem.updateCommanderBoard(title, columns);
    workstationSystem.updateCommanderBoard(commanderBoardData.current.title, commanderBoardData.current.columns);

    updateWhiteboardTriggerRef.current = (content: WhiteboardContent) => {
      workstationSystem.updateWhiteboardPlan(content);
    };
    if (propsRef.current.whiteboard) {
      workstationSystem.updateWhiteboardPlan(propsRef.current.whiteboard);
    }

    // 10. Stylized 3D Character Models Physically Seated in Chairs at Desks (ALL 6 TEAM MEMBERS!)
    const devCharacters = new Map<SlotId, StylizedCharacterResult>();
    // Teammates live in world space so they can get up and walk about; the
    // group is shown on the studio floor only.
    const actorsGroup = new THREE.Group();
    actorsGroup.name = 'TeamActors';
    scene.add(actorsGroup);
    const actorSeats = new Map<SlotId, { char: StylizedCharacterResult; seat: ActorSeat }>();
    WORKSTATION_CONFIGS.forEach((config) => {
      const char = createStylizedCharacter({
        name: config.label,
        roleColor: ROLE_COLORS[config.slot] || '#d98b4d',
        hairStyle: ROLE_HAIRSTYLES[config.slot] || 'short',
        isSeated: true,
        scale: 0.95,
        hasHeadphones: true,
      });

      const ws = workstationSystem.workstations.get(config.slot);
      if (ws) {
        // Seated on the ergonomic chair at (0, 0, 0.62) desk-local, facing the monitors
        char.group.userData = { isCharacter: true, slot: config.slot };
        actorsGroup.add(char.group);
        devCharacters.set(config.slot, char);
        actorSeats.set(config.slot, { char, seat: seatOf(ws.group) });
      }
    });

    // 12. Controllable 3D Player Avatar (Articulated Walking Stride & Smooth Turning)
    const playerChar = createStylizedCharacter({
      name: 'Player',
      roleColor: '#d98b4d', // Warm amber lead developer hoodie
      hairStyle: 'short',
      isSeated: false,
      scale: 1.0,
      hasHeadphones: true,
    });

    // Persistent player position across renders (Starts on Floor 2)
    const playerPos = persistentPlayerPos.clone();
    let currentFacingAngle = persistentFacingAngle;
    let targetFacingAngle = persistentFacingAngle;

    playerChar.group.position.copy(playerPos);
    playerChar.setFacingAngle(currentFacingAngle);
    scene.add(playerChar.group);

    // Ground shadow under player feet
    const shadowGeom = new THREE.CircleGeometry(0.35, 16);
    const shadowMat = new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.45 });
    const shadowMesh = new THREE.Mesh(shadowGeom, shadowMat);
    shadowMesh.rotation.x = -Math.PI / 2;
    shadowMesh.position.y = 0.02;
    playerChar.group.add(shadowMesh);

    // Movement Physics & Collision Bounds
    const playerVelocity = new THREE.Vector3();
    let isPlayerMoving = false;
    let clickDestination: THREE.Vector3 | null = null;

    const roomBounds = {
      minX: -8.85,
      maxX: 8.85,
      minZ: -7.35,
      maxZ: 7.35,
    };

    // The team's walkable floor: the player's colliders, inflated by a body.
    const stage = createStudioStage({
      grid: buildNavGrid(roomBounds, workstationSystem.obstacles, 0.28),
      characters: actorSeats,
      // In front of the whiteboard (x -3.2, face at z -4.76), facing it.
      boardSpots: [
        { x: -3.2, z: -3.95 },
        { x: -4.25, z: -3.85 },
        { x: -2.15, z: -3.85 },
      ],
      boardFacing: Math.PI,
      slotOf: (memberId) => {
        const seatMap = propsRef.current.seats;
        return (Object.keys(seatMap) as SlotId[]).find((slot) => seatMap[slot]?.agentId === memberId);
      },
    });
    stageViewRef.current = (slot) => stage.view(slot);
    const lastColor = new Map<SlotId, string>();
    const pullDirection = (slot: SlotId) => {
      const memberId = propsRef.current.seats[slot]?.agentId;
      if (!memberId) return undefined;
      const { state, direction } = nextDirection(directorRef.current, memberId);
      directorRef.current = state;
      return direction;
    };
    const isTypingAt = (slot: SlotId) => {
      const occupant = propsRef.current.seats[slot];
      const status = occupant ? propsRef.current.agentStatus[occupant.agentId] || 'idle' : 'idle';
      return status === 'working' || status === 'active';
    };

    // Click-to-Move Destination Ring on Floor
    const markerGeom = new THREE.RingGeometry(0.24, 0.32, 28);
    const markerMat = new THREE.MeshBasicMaterial({
      color: '#d98b4d',
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0,
    });
    const destinationRing = new THREE.Mesh(markerGeom, markerMat);
    destinationRing.rotation.x = -Math.PI / 2;
    destinationRing.position.y = playerPos.y + 0.03;
    scene.add(destinationRing);

    // Feature action execution helper
    const triggerFeatureAction = (feature: 'lights' | 'ac' | 'coffeeMachine' | 'coffeeCup' | 'whiteboard') => {
      if (feature === 'lights') {
        const on = roomFeatures.toggleLights();
        showToastRef.current(on ? 'Studio Lights ON (Bright Mode)' : 'Cozy Mood Mode (Lights OFF)');
      } else if (feature === 'ac') {
        const on = roomFeatures.toggleAC();
        showToastRef.current(on ? 'AC Unit ON (70°F Cooling Stream)' : 'AC Unit OFF (Standby)');
      } else if (feature === 'coffeeCup') {
        const res = roomFeatures.drinkCoffee();
        if (res.success) {
          showToastRef.current('Fresh espresso drank. +40% Speed Buff active (45s).');
        }
      } else if (feature === 'coffeeMachine') {
        const res = roomFeatures.brewCoffee();
        if (res.success) {
          showToastRef.current(res.message);
        }
      } else if (feature === 'whiteboard') {
        propsRef.current.onOpenWhiteboard?.();
      }
    };

    featureActionTriggerRef.current = triggerFeatureAction;

    // Keyboard controls with Sprint modifier
    const keys = { up: false, down: false, left: false, right: false, sprint: false };
    const onKeyDown = (e: KeyboardEvent) => {
      if (propsRef.current.paused) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      const k = e.key.toLowerCase();
      if (k === 'w' || e.key === 'ArrowUp' || e.code === 'KeyW') { keys.up = true; e.preventDefault(); }
      if (k === 's' || e.key === 'ArrowDown' || e.code === 'KeyS') { keys.down = true; e.preventDefault(); }
      if (k === 'a' || e.key === 'ArrowLeft' || e.code === 'KeyA') { keys.left = true; e.preventDefault(); }
      if (k === 'd' || e.key === 'ArrowRight' || e.code === 'KeyD') { keys.right = true; e.preventDefault(); }
      if (e.shiftKey || e.code === 'ShiftLeft' || e.code === 'ShiftRight') { keys.sprint = true; }

      // Press 'E' to interact with Commander Desk, Interactive Room Prop, or nearest dev
      if (k === 'e') {
        if (nearCmdRef.current) {
          propsRef.current.onOpenCommanderDesk?.();
        } else if (nearRoomFeatureRef.current) {
          triggerFeatureAction(nearRoomFeatureRef.current);
        } else if (targetAgentIdRef.current) {
          handleInteract(targetAgentIdRef.current);
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === 'w' || e.key === 'ArrowUp' || e.code === 'KeyW') keys.up = false;
      if (k === 's' || e.key === 'ArrowDown' || e.code === 'KeyS') keys.down = false;
      if (k === 'a' || e.key === 'ArrowLeft' || e.code === 'KeyA') keys.left = false;
      if (k === 'd' || e.key === 'ArrowRight' || e.code === 'KeyD') keys.right = false;
      if (!e.shiftKey) keys.sprint = false;
    };

    const onBlur = () => {
      keys.up = false;
      keys.down = false;
      keys.left = false;
      keys.right = false;
      keys.sprint = false;
    };

    window.addEventListener('keydown', onKeyDown, { passive: false });
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    // Camera Rig (3rd Person Follow + Mouse Orbit & Cosmic Zoom out to 58m)
    const cameraRig = createCameraRig({ aspect: width / height, initialDistance: 17, initialTarget: playerPos });

    // Resize Observer
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        width = entry.contentRect.width;
        height = entry.contentRect.height;
        if (width > 0 && height > 0) {
          renderer.setSize(width, height);
          cameraRig.setAspect(width / height);
        }
      }
    });
    resizeObserver.observe(container);

    // Raycasting for Clicking Characters, Desks, Floor Plane, or Interactive Room Features
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -playerPos.y);

    const onPointerClick = (e: MouseEvent) => {
      if (e.button !== 0) return; // Left click only
      const rect = canvas.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, cameraRig.camera);

      // Raycast against all interactive objects in the scene (penetrates structural elements)
      const intersects = raycaster.intersectObjects(scene.children, true);
      let hitCommander = false;
      let hitWhiteboard = false;
      let hitSlot: SlotId | null = null;
      let hitRoomFeature: 'lights' | 'ac' | 'coffeeMachine' | 'coffeeCup' | 'whiteboard' | null = null;

      for (const hit of intersects) {
        let curr: THREE.Object3D | null = hit.object;
        while (curr && curr !== scene) {
          if (curr.userData?.isWhiteboard) {
            hitWhiteboard = true;
            break;
          }
          if (curr.userData?.isCommanderDesk) {
            hitCommander = true;
            break;
          }
          if (curr.userData?.slot) {
            hitSlot = curr.userData.slot as SlotId;
            break;
          }
          if (curr.userData?.isLightSwitch) {
            hitRoomFeature = 'lights';
            break;
          }
          if (curr.userData?.isACUnit) {
            hitRoomFeature = 'ac';
            break;
          }
          if (curr.userData?.isCoffeeCup) {
            hitRoomFeature = 'coffeeCup';
            break;
          }
          if (curr.userData?.isCoffeeMachine) {
            hitRoomFeature = 'coffeeMachine';
            break;
          }
          curr = curr.parent;
        }
        if (hitWhiteboard || hitCommander || hitSlot || hitRoomFeature) break;
      }

      if (hitWhiteboard) {
        propsRef.current.onOpenWhiteboard?.();
        return;
      }

      // Proximity fallback check for Commander Desk (on Floor 2)
      if (!hitCommander && playerPos.distanceTo(workstationSystem.commanderDeskPos) < 2.5) {
        if (intersects.length > 0 && intersects[0].point.distanceTo(workstationSystem.commanderDeskPos) < 2.2) {
          hitCommander = true;
        }
      }

      if (hitRoomFeature) {
        triggerFeatureAction(hitRoomFeature);
        return;
      }

      if (hitCommander) {
        propsRef.current.onOpenCommanderDesk?.();
        return;
      }

      if (hitSlot) {
        inspectSlot(hitSlot);
        return;
      }

      // Smooth click-to-move on current floor plane!
      floorPlane.set(new THREE.Vector3(0, 1, 0), -playerPos.y);
      const floorIntersection = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(floorPlane, floorIntersection)) {
        const clampedX = Math.max(roomBounds.minX + 0.1, Math.min(roomBounds.maxX - 0.1, floorIntersection.x));
        const clampedZ = Math.max(roomBounds.minZ + 0.1, Math.min(roomBounds.maxZ - 0.1, floorIntersection.z));
        clickDestination = new THREE.Vector3(clampedX, playerPos.y, clampedZ);

        destinationRing.position.set(clampedX, playerPos.y + 0.03, clampedZ);
        markerMat.opacity = 0.85;
      }
    };

    // Attach Camera Mouse Events (smooth right-drag orbit + left-click navigation)
    const detachDomEvents = cameraRig.attachDomEvents(canvas, onPointerClick);

    // Scratch math vectors (Zero-allocation RAF loop - 0B/s GC pressure on low-spec CPUs!)
    const _scratchCamForward = new THREE.Vector3();
    const _scratchCamRight = new THREE.Vector3();
    const _scratchMoveDir = new THREE.Vector3();
    const _scratchToDest = new THREE.Vector3();
    const _scratchDeskPos = new THREE.Vector3();
    const _scratchPromptAnchor = new THREE.Vector3();
    const labelLayer = createLabelLayer(container);
    const labelPool = new Map<SlotId, LabelItem>();
    const labelItems: LabelItem[] = [];
    const promptRects: ScreenRect[] = [];
    let promptText = '';
    let promptW = 0;
    let promptH = 0;
    const _scratchScreenProj = new THREE.Vector3();
    const _worldUp = new THREE.Vector3(0, 1, 0);

    // High-Performance 60 FPS Game Render Loop
    let animFrameId: number;
    let lastTime = performance.now();
    let prevCaffeineFloor = -1;
    let cutawayOn = false;

    // ?perf=1 — frame cost, draw calls and lights, for checking changes here.
    // CPU time is measured inside the loop, so it stays honest even when the
    // browser throttles rAF for an occluded window.
    const perfEnabled = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('perf');
    const perfStats = { frames: 0, cpuMs: 0, renderMs: 0, worstMs: 0, lastReport: 0 };

    // Behind a modal: a few frames a second keeps the room alive for almost
    // no GPU.
    const PAUSED_FRAME_MS = 200;
    let lastPausedFrame = 0;
    let wasPaused = false;

    // Adaptive resolution: a slow machine steps its pixel ratio down
    // (2 → 1.5 → 1) after two seconds of long frames, and back up after four
    // of short ones. Frame intervals, not CPU time, so GPU-bound frames count.
    const DPR_STEPS = [2, 1.5, 1].filter((d) => d <= maxDpr);
    if (DPR_STEPS[0] !== maxDpr) DPR_STEPS.unshift(maxDpr);
    let dprIndex = 0;
    let slowMs = 0;
    let fastMs = 0;
    const adaptDpr = (intervalMs: number) => {
      // A hidden tab or a hitch from loading is not a slow machine.
      if (intervalMs > 250) return;
      if (intervalMs > 20) {
        slowMs += intervalMs;
        fastMs = 0;
      } else if (intervalMs < 12) {
        fastMs += intervalMs;
        slowMs = Math.max(0, slowMs - intervalMs);
      } else {
        slowMs = Math.max(0, slowMs - intervalMs);
        fastMs = 0;
      }
      if (slowMs > 2000 && dprIndex < DPR_STEPS.length - 1) {
        dprIndex += 1;
        renderer.setPixelRatio(DPR_STEPS[dprIndex]);
        slowMs = 0;
      } else if (fastMs > 4000 && dprIndex > 0) {
        dprIndex -= 1;
        renderer.setPixelRatio(DPR_STEPS[dprIndex]);
        fastMs = 0;
      }
    };

    const renderLoop = (timeNow: number) => {
      animFrameId = requestAnimationFrame(renderLoop);
      const paused = propsRef.current.paused === true;
      if (paused) {
        if (!wasPaused) onBlur(); // let go of any held movement key
        wasPaused = true;
        if (timeNow - lastPausedFrame < PAUSED_FRAME_MS) return;
        lastPausedFrame = timeNow;
      } else if (wasPaused) {
        wasPaused = false;
        // Not a slow frame: the loop was resting.
        lastTime = timeNow;
      }
      const frameStart = perfEnabled ? performance.now() : 0;
      if (!paused) adaptDpr(timeNow - lastTime);
      const delta = Math.min((timeNow - lastTime) / 1000, 0.05);
      lastTime = timeNow;
      const timeSec = timeNow / 1000;

      const currentProps = propsRef.current;
      const camDist = cameraRig.getDistance();

      // Update dynamic Day/Night Cycle & Sky lighting
      dayNightCycle.update(delta, scene, camDist);

      // Exterior Scenery is always resident in GPU memory to eliminate runtime allocation freezes
      scenery.update(delta, dayNightCycle.isNight);
      // Zoomed in on the studio: cut the building shell away. Zoomed out to
      // the city: show it whole. Hysteresis so a scroll at the edge does not flicker.
      const wantCutaway = cutawayOn ? camDist < 30 : camDist < 26;
      if (wantCutaway !== cutawayOn) {
        cutawayOn = wantCutaway;
        scenery.setCutaway(cutawayOn);
      }

      // Update cosmic environment & cozy props & interactive room features
      starfield.update(delta);
      starfield.group.visible = dayNightCycle.isNight;
      cozyProps.update(delta, timeSec);
      roomFeatures.update(delta);

      // Sync caffeine timer to React state when second integer changes
      const currentCaffeine = Math.ceil(roomFeatures.caffeineTimer);
      if (currentCaffeine !== prevCaffeineFloor) {
        prevCaffeineFloor = currentCaffeine;
        setCaffeineRemaining(currentCaffeine);
      }

      // Camera-Relative Movement Vector (Zero-allocation reuse!)
      cameraRig.camera.getWorldDirection(_scratchCamForward);
      _scratchCamForward.y = 0;
      _scratchCamForward.normalize();

      _scratchCamRight.crossVectors(_scratchCamForward, _worldUp).normalize();

      _scratchMoveDir.set(0, 0, 0);
      if (keys.up) _scratchMoveDir.add(_scratchCamForward);
      if (keys.down) _scratchMoveDir.sub(_scratchCamForward);
      if (keys.left) _scratchMoveDir.sub(_scratchCamRight);
      if (keys.right) _scratchMoveDir.add(_scratchCamRight);

      const hasKeyboardInput = _scratchMoveDir.lengthSq() > 0;
      let moveSpeed = keys.sprint ? 9.5 : 6.2;
      // Caffeine Speed & Focus Buff (+40% sprint boost!)
      if (roomFeatures.caffeineTimer > 0) {
        moveSpeed *= 1.4;
      }

      if (hasKeyboardInput) {
        clickDestination = null;
        markerMat.opacity = 0;
        isPlayerMoving = true;
        _scratchMoveDir.normalize();

        targetFacingAngle = Math.atan2(_scratchMoveDir.x, _scratchMoveDir.z);

        playerVelocity.x = THREE.MathUtils.lerp(playerVelocity.x, _scratchMoveDir.x * moveSpeed, delta * 15);
        playerVelocity.z = THREE.MathUtils.lerp(playerVelocity.z, _scratchMoveDir.z * moveSpeed, delta * 15);
      } else if (clickDestination) {
        _scratchToDest.subVectors(clickDestination, playerPos);
        _scratchToDest.y = 0;
        const distToDest = _scratchToDest.length();

        if (distToDest > 0.28) {
          isPlayerMoving = true;
          _scratchToDest.normalize();
          targetFacingAngle = Math.atan2(_scratchToDest.x, _scratchToDest.z);

          playerVelocity.x = THREE.MathUtils.lerp(playerVelocity.x, _scratchToDest.x * 6.5, delta * 15);
          playerVelocity.z = THREE.MathUtils.lerp(playerVelocity.z, _scratchToDest.z * 6.5, delta * 15);

          destinationRing.rotation.z += delta * 3;
          destinationRing.scale.setScalar(1 + Math.sin(timeSec * 8) * 0.1);
        } else {
          clickDestination = null;
          markerMat.opacity = 0;
          isPlayerMoving = false;
          playerVelocity.set(0, 0, 0);
        }
      } else {
        isPlayerMoving = false;
        playerVelocity.x = THREE.MathUtils.lerp(playerVelocity.x, 0, delta * 16);
        playerVelocity.z = THREE.MathUtils.lerp(playerVelocity.z, 0, delta * 16);
      }

      if (playerVelocity.lengthSq() > 0.0001) {
        const nextX = playerPos.x + playerVelocity.x * delta;
        const nextZ = playerPos.z + playerVelocity.z * delta;
        // Accurate player collision radius (0.20m matching avatar torso) for tight, natural proximity to objects
        const resolved = resolveAllObstacles(nextX, nextZ, 0.20, workstationSystem.obstacles, roomBounds);
        // Eliminate collision jitter by canceling velocity along blocked axes
        if (Math.abs(resolved.x - nextX) > 0.0001) {
          playerVelocity.x = 0;
        }
        if (Math.abs(resolved.z - nextZ) > 0.0001) {
          playerVelocity.z = 0;
        }
        const clear = stage.pushOut(resolved.x, resolved.z, 0.2);
        playerPos.x = clear.x;
        playerPos.z = clear.z;
      }

      // Shortest-path angle rotation (smooth, no 360 flip glitch!)
      let angleDiff = targetFacingAngle - currentFacingAngle;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      currentFacingAngle += angleDiff * Math.min(delta * 15, 1.0);

      playerChar.setFacingAngle(currentFacingAngle);
      playerChar.group.position.copy(playerPos);
      playerChar.update(delta, isPlayerMoving, false);

      // Save position into persistent ref
      persistentPlayerPos.copy(playerPos);
      persistentFacingAngle = currentFacingAngle;

      // Smooth Camera Follow
      cameraRig.update(playerPos, delta);

      stage.update(delta, performance.now(), pullDirection, isTypingAt, playerPos);
      WORKSTATION_CONFIGS.forEach((config) => {
        const occupant = currentProps.seats[config.slot];
        const status = occupant ? currentProps.agentStatus[occupant.agentId] || 'idle' : 'idle';
        const speech = occupant ? currentProps.latestSpeech[occupant.agentId] : null;
        const devChar = devCharacters.get(config.slot);
        if (devChar && occupant?.color && lastColor.get(config.slot) !== occupant.color) {
          lastColor.set(config.slot, occupant.color);
          devChar.setColor(occupant.color);
        }
        if (occupant) {
          const member = currentProps.members.find((m) => m.id === occupant.agentId);
          if (member) stage.setMemberName(config.slot, member.name);
        }
        workstationSystem.updateStatus(config.slot, status, timeSec, speech);
      });

      // --- One interaction target: the nearest thing within reach. The one
      // prompt shows exactly what E, or a click on it, will do. ---
      let pickKind: 'cmd' | 'feature' | 'agent' | null = null;
      let pickFeature: 'lights' | 'ac' | 'coffeeMachine' | 'coffeeCup' | 'whiteboard' | null = null;
      let pickAgent: string | null = null;
      let pickDist = Infinity;
      let pickTitle = '';
      let pickSub = '';
      let pickY = 0;
      const consider = (
        kind: 'cmd' | 'feature' | 'agent',
        dist: number,
        reach: number,
        anchor: THREE.Vector3,
        anchorY: number,
        title: string,
        sub: string,
        feature: typeof pickFeature = null,
        agent: string | null = null,
      ) => {
        if (dist >= reach || dist >= pickDist) return;
        pickKind = kind;
        pickDist = dist;
        pickFeature = feature;
        pickAgent = agent;
        pickTitle = title;
        pickSub = sub;
        _scratchPromptAnchor.copy(anchor);
        pickY = anchorY;
      };

      consider('cmd', playerPos.distanceTo(workstationSystem.commanderDeskPos), 2.5, workstationSystem.commanderDeskPos, 1.8, 'Open My Computer', 'Ticket board · team · pipeline');
      consider('feature', playerPos.distanceTo(workstationSystem.whiteboardPos), 2.8, workstationSystem.whiteboardPos, 1.9, 'Studio Whiteboard', 'Write the brief · see the plan', 'whiteboard');
      if (roomFeatures.hasBrewedCup) {
        consider('feature', playerPos.distanceTo(roomFeatures.coffeePos), 2.5, roomFeatures.coffeePos, 1.2, 'Drink Fresh Espresso', '+40% Sprint Boost (45s)', 'coffeeCup');
      } else {
        consider('feature', playerPos.distanceTo(roomFeatures.coffeePos), 2.5, roomFeatures.coffeePos, 1.2, 'Brew Artisan Espresso', 'Fresh Ground Roast', 'coffeeMachine');
      }
      consider('feature', playerPos.distanceTo(roomFeatures.switchPos), 2.4, roomFeatures.switchPos, 1.4,
        roomFeatures.isLightsOn ? 'Turn Off Lights' : 'Turn On Lights',
        roomFeatures.isLightsOn ? 'Switch to Cozy Mood Mode' : 'Switch to Studio Lighting', 'lights');
      consider('feature', playerPos.distanceTo(roomFeatures.acPos), 2.6, roomFeatures.acPos, 2.0,
        roomFeatures.isACOn ? 'Turn Off AC' : 'Turn On AC',
        roomFeatures.isACOn ? 'Cool Airflow Active (70°F)' : 'Standby Mode', 'ac');

      // Teammates, measured from where they are now (desk or not), and the
      // labels over their heads.
      labelItems.length = 0;
      for (const config of WORKSTATION_CONFIGS) {
        const view = stage.view(config.slot);
        const occupant = currentProps.seats[config.slot];
        if (!view || !occupant) continue;
        const member = currentProps.members.find((m) => m.id === occupant.agentId);
        const name = member?.name || occupant.name || config.label;
        const headY = view.seated ? 1.55 : 1.95;
        _scratchDeskPos.set(view.x, 0, view.z);
        consider('agent', Math.hypot(playerPos.x - view.x, playerPos.z - view.z), INTERACTION_RADIUS, _scratchDeskPos, headY + 0.35,
          `Talk to ${name}`, view.seated ? SLOT_LABELS[config.slot] || config.label : view.activity, null, occupant.agentId);
        let item = labelPool.get(config.slot);
        if (!item) {
          item = { key: config.slot, name, color: '#d98b4d', say: null, x: 0, y: 0, z: 0 };
          labelPool.set(config.slot, item);
        }
        item.name = name;
        item.color = occupant.color || member?.color || '#d98b4d';
        item.say = view.say;
        item.x = view.x;
        item.y = headY;
        item.z = view.z;
        labelItems.push(item);
      }

      nearCmdRef.current = pickKind === 'cmd';
      nearRoomFeatureRef.current = pickKind === 'feature' ? pickFeature : null;
      targetAgentIdRef.current = pickKind === 'agent' ? pickAgent : null;

      promptRects.length = 0;
      const prompt = roomPromptRef.current;
      if (prompt) {
        let shown = false;
        if (pickKind && cutawayOn) {
          _scratchScreenProj.copy(_scratchPromptAnchor).setY(playerPos.y + pickY).project(cameraRig.camera);
          if (_scratchScreenProj.z < 1.0) {
            const sx = ((_scratchScreenProj.x + 1) / 2) * width;
            const sy = ((-_scratchScreenProj.y + 1) / 2) * height;
            if (promptText !== pickTitle + pickSub) {
              promptText = pickTitle + pickSub;
              if (roomPromptTitleRef.current) roomPromptTitleRef.current.textContent = pickTitle;
              if (roomPromptSubRef.current) roomPromptSubRef.current.textContent = pickSub;
              prompt.style.display = 'block';
              promptW = prompt.offsetWidth;
              promptH = prompt.offsetHeight;
            }
            prompt.style.display = 'block';
            prompt.style.transform = `translate3d(${sx}px, ${sy}px, 0)`;
            promptRects.push({ left: sx - promptW / 2 - 4, top: sy - promptH - 4, right: sx + promptW / 2 + 4, bottom: sy + 4 });
            shown = true;
          }
        }
        if (!shown) prompt.style.display = 'none';
      }

      if (cutawayOn) {
        labelLayer.update(cameraRig.camera, width, height, labelItems, promptRects);
      } else {
        labelLayer.hideAll();
      }

      // Render Three.js frame
      const renderStart = perfEnabled ? performance.now() : 0;
      renderer.render(scene, cameraRig.camera);

      if (perfEnabled) {
        const end = performance.now();
        perfStats.frames += 1;
        perfStats.cpuMs += end - frameStart;
        perfStats.renderMs += end - renderStart;
        perfStats.worstMs = Math.max(perfStats.worstMs, end - frameStart);
        if (end - perfStats.lastReport > 1000 && perfRef.current) {
          let lights = 0;
          scene.traverseVisible((o) => {
            if ((o as THREE.Light).isLight) lights += 1;
          });
          const n = perfStats.frames || 1;
          const elapsed = (end - perfStats.lastReport) / 1000;
          perfRef.current.textContent = [
            `${(perfStats.frames / elapsed).toFixed(0)} fps`,
            `cpu ${(perfStats.cpuMs / n).toFixed(1)}ms (render ${(perfStats.renderMs / n).toFixed(1)}) worst ${perfStats.worstMs.toFixed(0)}ms`,
            `calls ${renderer.info.render.calls} tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k`,
            `lights ${lights} programs ${renderer.info.programs?.length ?? 0} tex ${renderer.info.memory.textures} dpr ${renderer.getPixelRatio()}`,
          ].join('\n');
          (window as unknown as { __studioPerf?: unknown }).__studioPerf = {
            fps: perfStats.frames / elapsed,
            cpuMs: perfStats.cpuMs / n,
            renderMs: perfStats.renderMs / n,
            worstMs: perfStats.worstMs,
            calls: renderer.info.render.calls,
            triangles: renderer.info.render.triangles,
            lights,
            programs: renderer.info.programs?.length ?? 0,
            dpr: renderer.getPixelRatio(),
          };
          perfStats.frames = 0;
          perfStats.cpuMs = 0;
          perfStats.renderMs = 0;
          perfStats.worstMs = 0;
          perfStats.lastReport = end;
        }
      }
    };

    // Compile every shader and upload every texture before the first frame,
    // so nothing stalls the moment it first comes into view.
    renderer.compile(scene, cameraRig.camera);
    scene.traverse((object) => {
      const material = (object as THREE.Mesh).material;
      if (!material) return;
      for (const m of Array.isArray(material) ? material : [material]) {
        for (const value of Object.values(m)) {
          if ((value as THREE.Texture | null)?.isTexture) renderer.initTexture(value as THREE.Texture);
        }
      }
    });

    animFrameId = requestAnimationFrame(renderLoop);

    // Cleanup on Unmount
    return () => {
      cancelAnimationFrame(animFrameId);
      resizeObserver.disconnect();
      detachDomEvents();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current);
      markerGeom.dispose();
      markerMat.dispose();
      starfield.dispose();
      island.dispose();
      architecture.dispose();
      workstationSystem.dispose();
      roomFeatures.dispose();
      scenery.dispose();
      dayNightCycle.dispose();
      cozyProps.dispose();
      labelLayer.dispose();
      devCharacters.forEach((c) => c.dispose());
      playerChar.dispose();
      cameraRig.dispose();
      textureCache.dispose();
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={containerRef} className="relative h-full w-full select-none overflow-hidden bg-[#0a0807]">
      <canvas ref={canvasRef} className="h-full w-full cursor-grab active:cursor-grabbing" />
      <pre
        ref={perfRef}
        className="pointer-events-none absolute right-3 top-14 z-50 whitespace-pre rounded-md bg-black/70 px-2 py-1 font-mono text-[10px] leading-4 text-[#8fae60] empty:hidden"
      />

      {/* Floating Toast Notification Banner */}
      {toastMessage && (
        <div className="pointer-events-none absolute top-4 left-1/2 z-50 -translate-x-1/2 transition-all duration-300">
          <div className="flex items-center gap-2.5 rounded-xl border border-[#d98b4d]/50 bg-[#17130f]/95 px-4 py-2 shadow-2xl backdrop-blur-md">
            <span className="h-2 w-2 rounded-full bg-[#d98b4d] animate-ping" />
            <span className="font-mono text-xs font-bold text-[#f4ece2]">{toastMessage}</span>
          </div>
        </div>
      )}

      {/* Active Caffeine Buff Speed HUD Indicator - Placed cleanly at bottom-left without colliding with top buttons */}
      {caffeineRemaining > 0 && (
        <div className="pointer-events-auto absolute bottom-14 left-3 z-30 flex items-center gap-2 rounded-xl border border-[#8fae60]/50 bg-[#17130f]/95 px-3 py-1.5 backdrop-blur-md shadow-2xl">
          <div className="h-2 w-2 rounded-full bg-[#8fae60] animate-ping" />
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] font-bold text-[#8fae60]">
              Espresso Rush (+40% Speed)
            </span>
            <span className="font-mono text-[10px] text-[#f4ece2]">
              {caffeineRemaining}s
            </span>
          </div>
        </div>
      )}

      {/* The one in-world prompt: exactly what E, or a click here, will act on */}
      <div
        ref={roomPromptRef}
        className="pointer-events-auto absolute left-0 top-0 z-40 -translate-x-1/2 -translate-y-full cursor-pointer hidden"
        onClick={() => {
          if (nearCmdRef.current) propsRef.current.onOpenCommanderDesk?.();
          else if (nearRoomFeatureRef.current) featureActionTriggerRef.current?.(nearRoomFeatureRef.current);
          else if (targetAgentIdRef.current) handleInteract(targetAgentIdRef.current);
        }}
      >
        <div className="flex items-center gap-2 rounded-xl border border-[#d98b4d] bg-[#17130f]/95 px-3.5 py-1.5 shadow-xl backdrop-blur-md transition-transform hover:scale-105 active:scale-95">
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[#d98b4d] font-mono text-[10px] font-bold text-[#17130f] shadow-sm">
            E
          </span>
          <div className="flex flex-col">
            <span ref={roomPromptTitleRef} className="text-xs font-bold text-[#f4ece2]">
              Room Feature
            </span>
            <span ref={roomPromptSubRef} className="text-[9px] uppercase tracking-wider text-[#8a7a6b]">
              Action
            </span>
          </div>
        </div>
        <div className="mx-auto h-0 w-0 border-x-4 border-t-4 border-x-transparent border-t-[#d98b4d]" />
      </div>

      {/* Quick Navigation HUD Overlay */}
      <div className="pointer-events-none absolute bottom-3 left-3 z-20 flex items-center gap-2 rounded-lg border border-[rgba(244,236,226,0.08)] bg-[#17130f]/80 px-3 py-1.5 backdrop-blur-sm">
        <span className="font-mono text-[9px] uppercase tracking-wider text-[#8a7a6b]">
          WASD: <span className="font-bold text-[#f4ece2]">Move</span> • Shift: <span className="font-bold text-[#f4ece2]">Sprint</span> • Scroll: <span className="font-bold text-[#8fae60]">Zoom Out to Scenery & Cars</span> • Right-Drag: <span className="font-bold text-[#f4ece2]">Orbit</span>
        </span>
      </div>
    </div>
  );
}