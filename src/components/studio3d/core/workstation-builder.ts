import * as THREE from 'three';
import type { SlotId } from '@/lib/team/types';
import type { AABB, WorkstationDef } from '../types';
import type { TextureCache } from './texture-cache';
import {
  createWorkstationScreen,
  createCommanderUltrawideScreen,
  type ScreenTextureResult,
} from './screen-texture-factory';

export interface WorkstationMeshRefs {
  group: THREE.Group;
  slot: SlotId;
  deskPos: THREE.Vector3;
  monitorScreens: THREE.Mesh[];
  screenTextures: ScreenTextureResult[];
  deskLight: THREE.PointLight;
  floorNumber: number;
}

export interface WorkstationsResult {
  group: THREE.Group;
  workstations: Map<SlotId, WorkstationMeshRefs>;
  commanderDeskPos: THREE.Vector3;
  commanderScreenMesh: THREE.Mesh;
  whiteboardPos: THREE.Vector3;
  obstacles: AABB[];
  setActiveFloor: (floorNum: number) => void;
  updateStatus: (slot: SlotId, status: string, timeSec: number, speech?: string | null) => void;
  updateCommanderScreen: (timeSec: number) => void;
  updateWhiteboardPlan: (planText: string) => void;
  dispose: () => void;
}

/**
 * Workstation assignments across the building's active floors:
 * - 2F (Dev House Engineering Studio): ALL 6 DEVELOPERS + Commander Desk ("My Computer")
 * - 1F (Ground Atrium): Reception Desk & Lounge
 * - 3F (Sky Suite): Expansion Suite (Under Construction / Coming Soon)
 */
export const WORKSTATION_CONFIGS: Array<WorkstationDef & { floorNumber: number }> = [
  // 2F Dev House Engineering Floor - WHOLE TEAM TOGETHER (Pixel-accurate tight collision bounds)
  {
    slot: 'coder',
    label: 'Coder',
    floorNumber: 2,
    position: [-5.6, 0, -3.2],
    rotationY: Math.PI / 4,
    bounds: { minX: -6.45, maxX: -4.75, minZ: -3.95, maxZ: -2.45, label: 'Coder Desk' },
  },
  {
    slot: 'tester',
    label: 'Tester',
    floorNumber: 2,
    position: [-5.6, 0, 0.4],
    rotationY: Math.PI / 6,
    bounds: { minX: -6.45, maxX: -4.75, minZ: -0.35, maxZ: 1.15, label: 'Tester Desk' },
  },
  {
    slot: 'reviewer',
    label: 'Reviewer',
    floorNumber: 2,
    position: [-5.6, 0, 4.0],
    rotationY: Math.PI / 6,
    bounds: { minX: -6.45, maxX: -4.75, minZ: 3.25, maxZ: 4.75, label: 'Reviewer Desk' },
  },
  {
    slot: 'planner',
    label: 'Planner',
    floorNumber: 2,
    position: [5.6, 0, -3.2],
    rotationY: -Math.PI / 4,
    bounds: { minX: 4.75, maxX: 6.45, minZ: -3.95, maxZ: -2.45, label: 'Planner Desk' },
  },
  {
    slot: 'auditor',
    label: 'Auditor',
    floorNumber: 2,
    position: [5.6, 0, 0.4],
    rotationY: -Math.PI / 6,
    bounds: { minX: 4.75, maxX: 6.45, minZ: -0.35, maxZ: 1.15, label: 'Auditor Desk' },
  },
  {
    slot: 'supervisor',
    label: 'Supervisor',
    floorNumber: 2,
    position: [5.6, 0, 4.0],
    rotationY: -Math.PI / 6,
    bounds: { minX: 4.75, maxX: 6.45, minZ: 3.25, maxZ: 4.75, label: 'Supervisor Desk' },
  },
];

export function buildWorkstations(textureCache: TextureCache): WorkstationsResult {
  const rootGroup = new THREE.Group();
  rootGroup.name = 'WorkstationsGroup';

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const workstations = new Map<SlotId, WorkstationMeshRefs>();
  const obstacles: AABB[] = [];

  // --- Shared Reusable Geometries ---
  const deskTopGeom = new THREE.BoxGeometry(2.0, 0.08, 1.0);
  const cuttingMatGeom = new THREE.PlaneGeometry(1.2, 0.7);
  const legGeom = new THREE.CylinderGeometry(0.03, 0.03, 0.72, 8);
  const monitorBezelGeom = new THREE.BoxGeometry(0.7, 0.42, 0.03);
  const monitorScreenGeom = new THREE.PlaneGeometry(0.66, 0.38);
  const monitorStandGeom = new THREE.CylinderGeometry(0.02, 0.04, 0.22, 8);
  const chairSeatGeom = new THREE.BoxGeometry(0.55, 0.08, 0.5);
  const chairBackGeom = new THREE.BoxGeometry(0.5, 0.5, 0.06);
  const chairPneumaticGeom = new THREE.CylinderGeometry(0.032, 0.032, 0.38, 8);
  const chairStarArmGeom = new THREE.BoxGeometry(0.04, 0.03, 0.26);
  const chairWheelGeom = new THREE.CylinderGeometry(0.024, 0.024, 0.028, 8);
  const chairArmrestGeom = new THREE.BoxGeometry(0.06, 0.16, 0.28);
  const mugGeom = new THREE.CylinderGeometry(0.05, 0.04, 0.09, 8);
  const plantPotGeom = new THREE.CylinderGeometry(0.12, 0.08, 0.16, 8);
  const plantLeafGeom = new THREE.SphereGeometry(0.14, 6, 6);

  geometries.push(
    deskTopGeom,
    cuttingMatGeom,
    legGeom,
    monitorBezelGeom,
    monitorScreenGeom,
    monitorStandGeom,
    chairSeatGeom,
    chairBackGeom,
    chairPneumaticGeom,
    chairStarArmGeom,
    chairWheelGeom,
    chairArmrestGeom,
    mugGeom,
    plantPotGeom,
    plantLeafGeom
  );

  // --- Warm Studio Materials ---
  const walnutWoodMat = textureCache.getMaterial('mat:walnut_desktop', () =>
    new THREE.MeshStandardMaterial({ color: '#3d2b1f', roughness: 0.45, metalness: 0.05 })
  );
  const leatherMatMat = textureCache.getMaterial('mat:leather_desk_mat', () =>
    new THREE.MeshStandardMaterial({ color: '#1c1917', roughness: 0.75 })
  );
  const darkMetalLegMat = textureCache.getMaterial('mat:dark_metal_legs', () =>
    new THREE.MeshStandardMaterial({ color: '#27221d', roughness: 0.35, metalness: 0.7 })
  );
  const bezelMat = textureCache.getMaterial('mat:monitor_bezel', () =>
    new THREE.MeshStandardMaterial({ color: '#181512', roughness: 0.4, metalness: 0.4 })
  );
  const chairClothMat = textureCache.getMaterial('mat:warm_chair_cloth', () =>
    new THREE.MeshStandardMaterial({ color: '#2b241e', roughness: 0.9 })
  );
  const potMat = textureCache.getMaterial('mat:clay_pot', () =>
    new THREE.MeshStandardMaterial({ color: '#b45309', roughness: 0.8 })
  );
  const leafMat = textureCache.getMaterial('mat:monstera_leaf', () =>
    new THREE.MeshStandardMaterial({ color: '#15803d', roughness: 0.6 })
  );
  const mugMat = textureCache.getMaterial('mat:ceramic_mug', () =>
    new THREE.MeshStandardMaterial({ color: '#f4ece2', roughness: 0.25 })
  );

  // Helper: Build a grounded ergonomic office chair with 5-star wheeled base touching the floor
  const createGroundedOfficeChair = (clothMat: THREE.Material = chairClothMat) => {
    const chairGroup = new THREE.Group();

    // 1. Padded Seat Cushion (y = 0.46)
    const seat = new THREE.Mesh(chairSeatGeom, clothMat);
    seat.position.y = 0.46;
    seat.castShadow = true;
    chairGroup.add(seat);

    // 2. Ergonomic Backrest with Lumbar Curve
    const back = new THREE.Mesh(chairBackGeom, clothMat);
    back.position.set(0, 0.74, -0.24);
    back.castShadow = true;
    chairGroup.add(back);

    // 3. Central Pneumatic Lift Cylinder
    const cylinder = new THREE.Mesh(chairPneumaticGeom, darkMetalLegMat);
    cylinder.position.y = 0.24;
    cylinder.castShadow = true;
    chairGroup.add(cylinder);

    // 4. Five-Star Wheeled Base (Resting directly on the floor at y = 0!)
    const starBaseGroup = new THREE.Group();
    starBaseGroup.position.y = 0.045;

    for (let i = 0; i < 5; i++) {
      const angle = (i * Math.PI * 2) / 5;
      const armGroup = new THREE.Group();
      armGroup.rotation.y = angle;

      const arm = new THREE.Mesh(chairStarArmGeom, darkMetalLegMat);
      arm.position.set(0, 0, 0.13);
      arm.castShadow = true;
      armGroup.add(arm);

      // Caster wheel firmly touching the floor at y = 0.02
      const wheel = new THREE.Mesh(chairWheelGeom, darkMetalLegMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(0, -0.025, 0.25);
      wheel.castShadow = true;
      armGroup.add(wheel);

      starBaseGroup.add(armGroup);
    }
    chairGroup.add(starBaseGroup);

    // 5. Left and Right Ergonomic Armrests
    [-0.26, 0.26].forEach((ax) => {
      const armrest = new THREE.Mesh(chairArmrestGeom, darkMetalLegMat);
      armrest.position.set(ax, 0.58, -0.02);
      chairGroup.add(armrest);
    });

    return chairGroup;
  };

  // Build the 6 team workstations
  WORKSTATION_CONFIGS.forEach((config) => {
    const deskGroup = new THREE.Group();
    deskGroup.name = `Desk_${config.slot}`;
    deskGroup.userData = { isWorkstation: true, slot: config.slot, floorNumber: config.floorNumber };
    deskGroup.position.set(config.position[0], config.position[1], config.position[2]);
    deskGroup.rotation.y = config.rotationY;

    // Desktop
    const deskTop = new THREE.Mesh(deskTopGeom, walnutWoodMat);
    deskTop.position.y = 0.74;
    deskTop.castShadow = true;
    deskTop.receiveShadow = true;
    deskGroup.add(deskTop);

    // Leather desk pad
    const cuttingMat = new THREE.Mesh(cuttingMatGeom, leatherMatMat);
    cuttingMat.rotation.x = -Math.PI / 2;
    cuttingMat.position.set(0, 0.785, 0.05);
    cuttingMat.receiveShadow = true;
    deskGroup.add(cuttingMat);

    // 4 Dark bronze legs
    const legPositions = [
      [-0.9, 0.36, -0.4],
      [0.9, 0.36, -0.4],
      [-0.9, 0.36, 0.4],
      [0.9, 0.36, 0.4],
    ];
    legPositions.forEach(([lx, ly, lz]) => {
      const leg = new THREE.Mesh(legGeom, darkMetalLegMat);
      leg.position.set(lx, ly, lz);
      leg.castShadow = true;
      deskGroup.add(leg);
    });

    // Dual High-Resolution Dynamic Monitors with realistic code & telemetry
    const screens: THREE.Mesh[] = [];
    const screenTextures: ScreenTextureResult[] = [];
    const monitorAngles = [-0.18, 0.18];
    const monitorOffsets = [-0.38, 0.38];

    monitorOffsets.forEach((mx, mIdx) => {
      const monGroup = new THREE.Group();
      monGroup.position.set(mx, 0.78, -0.28);
      monGroup.rotation.y = monitorAngles[mIdx];

      const stand = new THREE.Mesh(monitorStandGeom, darkMetalLegMat);
      stand.position.y = 0.11;
      monGroup.add(stand);

      const bezel = new THREE.Mesh(monitorBezelGeom, bezelMat);
      bezel.position.y = 0.28;
      bezel.castShadow = true;
      monGroup.add(bezel);

      // Create realistic role-specific screen texture (IDE code, CLI, test runner, etc.)
      const screenTex = createWorkstationScreen(config.slot, mIdx as 0 | 1);
      screenTextures.push(screenTex);

      const screenMat = new THREE.MeshStandardMaterial({
        color: '#ffffff',
        map: screenTex.texture,
        emissive: new THREE.Color('#ffffff'),
        emissiveMap: screenTex.texture,
        emissiveIntensity: 0.85,
        roughness: 0.2,
      });
      materials.push(screenMat);

      const screen = new THREE.Mesh(monitorScreenGeom, screenMat);
      screen.position.set(0, 0.28, 0.016);
      monGroup.add(screen);
      screens.push(screen);

      deskGroup.add(monGroup);
    });

    // Grounded Ergonomic Office Chair with 5-Star Wheeled Base (Resting firmly on floor at y=0)
    const chairGroup = createGroundedOfficeChair(chairClothMat);
    chairGroup.position.set(0, 0, 0.7);
    chairGroup.rotation.y = Math.PI;
    chairGroup.userData = { slot: config.slot };
    deskGroup.add(chairGroup);
    deskGroup.userData = { isWorkstation: true, slot: config.slot };

    // Warm Desk Banker Lamp
    const lamp = new THREE.PointLight('#fef08a', 1.4, 4.5, 1.2);
    lamp.position.set(0.7, 1.1, -0.2);
    deskGroup.add(lamp);

    // Plant & Mug
    const pot = new THREE.Mesh(plantPotGeom, potMat);
    pot.position.set(-0.75, 0.86, -0.3);
    deskGroup.add(pot);

    const leaf = new THREE.Mesh(plantLeafGeom, leafMat);
    leaf.position.set(-0.75, 0.98, -0.3);
    deskGroup.add(leaf);

    const mug = new THREE.Mesh(mugGeom, mugMat);
    mug.position.set(0.48, 0.82, 0.2);
    deskGroup.add(mug);

    rootGroup.add(deskGroup);
    obstacles.push(config.bounds);

    workstations.set(config.slot, {
      group: deskGroup,
      slot: config.slot,
      deskPos: new THREE.Vector3(config.position[0], config.position[1], config.position[2]),
      monitorScreens: screens,
      screenTextures,
      deskLight: lamp,
      floorNumber: config.floorNumber,
    });
  });

  // --- Floor 1: Ground Atrium Reception & Coffee Lounge ---
  const loungeGroup = new THREE.Group();
  loungeGroup.name = 'GroundLounge';
  loungeGroup.userData = { floorNumber: 1 };
  loungeGroup.position.set(0, 0, -1.8);

  const couchBaseGeom = new THREE.BoxGeometry(3.2, 0.4, 1.1);
  const couchBackGeom = new THREE.BoxGeometry(3.2, 0.6, 0.3);
  const coffeeTableGeom = new THREE.BoxGeometry(1.6, 0.3, 0.8);
  geometries.push(couchBaseGeom, couchBackGeom, coffeeTableGeom);

  const leatherCouchMat = textureCache.getMaterial('mat:leather_couch', () =>
    new THREE.MeshStandardMaterial({ color: '#38251a', roughness: 0.8 })
  );

  const couchBase = new THREE.Mesh(couchBaseGeom, leatherCouchMat);
  couchBase.position.y = 0.25;
  loungeGroup.add(couchBase);

  const couchBack = new THREE.Mesh(couchBackGeom, leatherCouchMat);
  couchBack.position.set(0, 0.65, -0.4);
  loungeGroup.add(couchBack);

  const coffeeTable = new THREE.Mesh(coffeeTableGeom, walnutWoodMat);
  coffeeTable.position.set(0, 0.18, 1.1);
  loungeGroup.add(coffeeTable);

  rootGroup.add(loungeGroup);

  // Reception Desk on Floor 1
  const recDeskGroup = new THREE.Group();
  recDeskGroup.name = 'ReceptionDesk';
  recDeskGroup.userData = { floorNumber: 1 };
  recDeskGroup.position.set(0, 0, 1.6);
  const recDeskGeom = new THREE.BoxGeometry(2.4, 0.9, 0.9);
  geometries.push(recDeskGeom);
  const recDesk = new THREE.Mesh(recDeskGeom, walnutWoodMat);
  recDesk.position.y = 0.45;
  recDeskGroup.add(recDesk);
  rootGroup.add(recDeskGroup);

  // --- Floor 2: Architecture Whiteboard (Positioned at X=-3.2, Z=-4.8 to keep central elevator path clear) ---
  const whiteboardGroup = new THREE.Group();
  whiteboardGroup.name = 'Whiteboard';
  whiteboardGroup.userData = { isWhiteboard: true, floorNumber: 2 };
  const whiteboardPos = new THREE.Vector3(-3.2, 0, -4.8);
  whiteboardGroup.position.copy(whiteboardPos);

  const boardFrameGeom = new THREE.BoxGeometry(2.8, 1.6, 0.08);
  const boardSurfaceGeom = new THREE.PlaneGeometry(2.68, 1.48);
  geometries.push(boardFrameGeom, boardSurfaceGeom);

  const boardFrame = new THREE.Mesh(boardFrameGeom, darkMetalLegMat);
  boardFrame.position.y = 1.4;
  boardFrame.userData = { isWhiteboard: true, floorNumber: 2 };
  whiteboardGroup.add(boardFrame);

  // Grounded Steel Mobile Stand (Firmly planted on the floor at y=0, zero floating!)
  const wbPostGeom = new THREE.BoxGeometry(0.06, 1.48, 0.06);
  const wbFootGeom = new THREE.BoxGeometry(0.08, 0.05, 0.76);
  const wbCrossbarGeom = new THREE.BoxGeometry(2.62, 0.05, 0.05);
  const wbWheelGeom = new THREE.CylinderGeometry(0.028, 0.028, 0.035, 8);
  geometries.push(wbPostGeom, wbFootGeom, wbCrossbarGeom, wbWheelGeom);

  [-1.34, 1.34].forEach((postX) => {
    // Vertical upright steel leg extending down to floor
    const post = new THREE.Mesh(wbPostGeom, darkMetalLegMat);
    post.position.set(postX, 0.78, 0);
    post.castShadow = true;
    whiteboardGroup.add(post);

    // Floor T-foot resting on the floor (y = 0.025)
    const foot = new THREE.Mesh(wbFootGeom, darkMetalLegMat);
    foot.position.set(postX, 0.025, 0);
    foot.castShadow = true;
    whiteboardGroup.add(foot);

    // Caster wheels touching the floor at y = 0
    [-0.32, 0.32].forEach((wz) => {
      const wheel = new THREE.Mesh(wbWheelGeom, darkMetalLegMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(postX, 0.015, wz);
      wheel.castShadow = true;
      whiteboardGroup.add(wheel);
    });
  });

  // Lower steel crossbar brace
  const crossbar = new THREE.Mesh(wbCrossbarGeom, darkMetalLegMat);
  crossbar.position.set(0, 0.22, 0);
  crossbar.castShadow = true;
  whiteboardGroup.add(crossbar);

  // Pen tray at bottom of whiteboard
  const trayGeom = new THREE.BoxGeometry(2.6, 0.05, 0.12);
  geometries.push(trayGeom);
  const tray = new THREE.Mesh(trayGeom, darkMetalLegMat);
  tray.position.set(0, 0.62, 0.06);
  whiteboardGroup.add(tray);

  // Architecture Whiteboard Dynamic Canvas Texture (1024x576)
  const wbCanvas = document.createElement('canvas');
  wbCanvas.width = 1024;
  wbCanvas.height = 576;
  const wbCtx = wbCanvas.getContext('2d')!;

  const renderWhiteboardPlan = (text: string) => {
    // Crisp dry-erase board background with light subtle grid
    wbCtx.fillStyle = '#f8fafc';
    wbCtx.fillRect(0, 0, 1024, 576);

    // Subtle faint blueprint grid
    wbCtx.strokeStyle = 'rgba(203, 213, 225, 0.35)';
    wbCtx.lineWidth = 1;
    for (let x = 0; x < 1024; x += 32) {
      wbCtx.beginPath();
      wbCtx.moveTo(x, 0);
      wbCtx.lineTo(x, 576);
      wbCtx.stroke();
    }
    for (let y = 0; y < 576; y += 32) {
      wbCtx.beginPath();
      wbCtx.moveTo(0, y);
      wbCtx.lineTo(1024, y);
      wbCtx.stroke();
    }

    // Header bar
    wbCtx.fillStyle = '#0f172a';
    wbCtx.font = 'bold 22px monospace';
    wbCtx.fillText('DEV HOUSE • MISSION ARCHITECTURE PLAN', 36, 42);

    wbCtx.fillStyle = '#64748b';
    wbCtx.font = '13px monospace';
    wbCtx.fillText('AUTONOMOUS AGENT PIPELINE SPECIFICATION', 36, 68);

    wbCtx.strokeStyle = '#3b82f6';
    wbCtx.lineWidth = 3;
    wbCtx.beginPath();
    wbCtx.moveTo(36, 82);
    wbCtx.lineTo(988, 82);
    wbCtx.stroke();

    // Render lines of plan in dry-erase marker style
    const defaultLines = `# Mission Architecture Plan\n- [x] Modern 3D Studio & 6-Agent Workspace\n- [ ] Multi-Agent Autonomous Build Pipeline\n- [ ] Vitest Suite & Automated Contracts`;
    const lines = (text && text.trim().length > 0 ? text : defaultLines)
      .split('\n')
      .slice(0, 16);

    let currentY = 118;
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) {
        wbCtx.fillStyle = '#1e3a8a'; // Blue marker for headings
        wbCtx.font = 'bold 18px monospace';
      } else if (trimmed.startsWith('- [x]') || trimmed.startsWith('[x]')) {
        wbCtx.fillStyle = '#166534'; // Green marker for checked tasks
        wbCtx.font = 'bold 15px monospace';
      } else if (trimmed.startsWith('- [ ]') || trimmed.startsWith('[ ]')) {
        wbCtx.fillStyle = '#b45309'; // Amber marker for pending tasks
        wbCtx.font = 'bold 15px monospace';
      } else if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
        wbCtx.fillStyle = '#334155'; // Dark charcoal marker for bullet points
        wbCtx.font = '15px monospace';
      } else {
        wbCtx.fillStyle = '#475569';
        wbCtx.font = '14px monospace';
      }

      wbCtx.fillText(line.substring(0, 68), 36, currentY);
      currentY += 26;
    });

    // Bottom action callout
    wbCtx.fillStyle = '#0f172a';
    wbCtx.fillRect(36, 524, 952, 36);
    wbCtx.fillStyle = '#f8fafc';
    wbCtx.font = 'bold 13px monospace';
    wbCtx.textAlign = 'center';
    wbCtx.fillText('PRESS [E] OR CLICK TO VIEW & EDIT PIPELINE PLAN', 512, 547);
    wbCtx.textAlign = 'left';
  };

  renderWhiteboardPlan('');

  const wbTexture = new THREE.CanvasTexture(wbCanvas);
  wbTexture.colorSpace = THREE.SRGBColorSpace;
  const boardMat = new THREE.MeshStandardMaterial({
    map: wbTexture,
    roughness: 0.25,
    metalness: 0.05,
    emissive: new THREE.Color('#ffffff'),
    emissiveMap: wbTexture,
    emissiveIntensity: 0.45,
  });
  materials.push(boardMat);

  const boardSurface = new THREE.Mesh(boardSurfaceGeom, boardMat);
  boardSurface.position.set(0, 1.4, 0.042);
  boardSurface.userData = { isWhiteboard: true, floorNumber: 2 };
  whiteboardGroup.add(boardSurface);

  rootGroup.add(whiteboardGroup);

  // Add precise AABB collision detection for the whiteboard so the player cannot walk through it!
  obstacles.push({
    minX: -4.6,
    maxX: -1.8,
    minZ: -5.05,
    maxZ: -4.55,
    label: 'Architecture Whiteboard',
  });

  // --- Floor 2: Commander Desk ("My Computer" / Lead Workspace) ---
  const cmdDeskGroup = new THREE.Group();
  cmdDeskGroup.name = 'CommanderDeskGroup';
  cmdDeskGroup.userData = { isCommanderDesk: true, floorNumber: 2 };
  const cmdDeskPos = new THREE.Vector3(0, 0, 3.6); // Positioned on 2F Dev House Engineering Studio
  cmdDeskGroup.position.copy(cmdDeskPos);
  cmdDeskGroup.rotation.y = Math.PI; // Faces into the office towards the team

  // Executive wide walnut desktop
  const cmdTopGeom = new THREE.BoxGeometry(2.4, 0.09, 1.1);
  geometries.push(cmdTopGeom);
  const cmdTop = new THREE.Mesh(cmdTopGeom, walnutWoodMat);
  cmdTop.userData = { isCommanderDesk: true, floorNumber: 2 };
  cmdTop.position.y = 0.74;
  cmdTop.castShadow = true;
  cmdTop.receiveShadow = true;
  cmdDeskGroup.add(cmdTop);

  // Bronze pedestal base
  const cmdBaseGeom = new THREE.BoxGeometry(2.0, 0.72, 0.6);
  geometries.push(cmdBaseGeom);
  const cmdBase = new THREE.Mesh(cmdBaseGeom, darkMetalLegMat);
  cmdBase.position.y = 0.36;
  cmdBase.castShadow = true;
  cmdDeskGroup.add(cmdBase);

  // Ultrawide Curved Monitor with Warm Amber Terminal Glow
  const ultrawideBezelGeom = new THREE.BoxGeometry(1.6, 0.55, 0.04);
  const ultrawideScreenGeom = new THREE.PlaneGeometry(1.54, 0.5);
  geometries.push(ultrawideBezelGeom, ultrawideScreenGeom);

  const cmdMonitorGroup = new THREE.Group();
  cmdMonitorGroup.position.set(0, 0.8, -0.25);

  const ultrawideBezel = new THREE.Mesh(ultrawideBezelGeom, bezelMat);
  ultrawideBezel.position.y = 0.34;
  cmdMonitorGroup.add(ultrawideBezel);

  // Ultrawide Curved Monitor with Realtime Lead Command Dashboard
  const cmdScreenTex = createCommanderUltrawideScreen();
  const cmdScreenMat = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    map: cmdScreenTex.texture,
    emissive: new THREE.Color('#ffffff'),
    emissiveMap: cmdScreenTex.texture,
    emissiveIntensity: 0.85,
    roughness: 0.2,
  });
  materials.push(cmdScreenMat);

  const cmdScreen = new THREE.Mesh(ultrawideScreenGeom, cmdScreenMat);
  cmdScreen.userData = { isCommanderDesk: true, floorNumber: 3 };
  cmdScreen.position.set(0, 0.34, 0.022);
  cmdMonitorGroup.add(cmdScreen);

  const cmdStand = new THREE.Mesh(monitorStandGeom, darkMetalLegMat);
  cmdStand.position.y = 0.12;
  cmdMonitorGroup.add(cmdStand);

  cmdDeskGroup.add(cmdMonitorGroup);

  // Tactile Brass Architect Desk Lamp
  const brassLampArmGeom = new THREE.CylinderGeometry(0.015, 0.015, 0.38, 8);
  const brassLampShadeGeom = new THREE.ConeGeometry(0.08, 0.11, 10);
  geometries.push(brassLampArmGeom, brassLampShadeGeom);

  const brassLampMat = new THREE.MeshStandardMaterial({ color: '#d97706', roughness: 0.35, metalness: 0.8 });
  materials.push(brassLampMat);

  const lampGroup = new THREE.Group();
  lampGroup.position.set(0.9, 0.74, -0.15);

  const lampArm = new THREE.Mesh(brassLampArmGeom, brassLampMat);
  lampArm.position.y = 0.19;
  lampArm.rotation.z = -0.25;
  lampGroup.add(lampArm);

  const lampShade = new THREE.Mesh(brassLampShadeGeom, brassLampMat);
  lampShade.position.set(-0.06, 0.36, 0);
  lampShade.rotation.z = Math.PI / 1.35;
  lampGroup.add(lampShade);

  const warmLampLight = new THREE.PointLight('#fef08a', 1.6, 5.0, 1.2);
  warmLampLight.position.set(-0.06, 0.33, 0);
  lampGroup.add(warmLampLight);

  cmdDeskGroup.add(lampGroup);

  // Executive Leather Chair with Grounded 5-Star Wheeled Base (Firmly on floor at y=0!)
  const execChair = createGroundedOfficeChair(chairClothMat);
  execChair.position.set(0, 0, 0.8);
  execChair.rotation.y = Math.PI;
  execChair.userData = { isCommanderDesk: true };
  cmdDeskGroup.add(execChair);

  rootGroup.add(cmdDeskGroup);
  // Pixel-accurate bounds matching 2.2m x 0.95m desk geometry at (0, 0, 3.6)
  obstacles.push({ minX: -1.15, maxX: 1.15, minZ: 3.15, maxZ: 4.10, label: 'My Desk & Computer' });
  // Studio Library Bookcase at (-5.6, 0, -7.18), width 2.4, depth 0.36
  obstacles.push({ minX: -6.82, maxX: -4.38, minZ: -7.38, maxZ: -6.98, label: 'Studio Library Bookcase' });

  // --- Active Floor Visibility Filter ---
  const setActiveFloor = (floorNum: number) => {
    // Floor 2 hosts the entire engineering team!
    workstations.forEach((ws) => {
      ws.group.visible = floorNum === 2;
    });

    // Floor 2 features: Commander Desk & Whiteboard
    cmdDeskGroup.visible = floorNum === 2;
    whiteboardGroup.visible = floorNum === 2;

    // Floor 1 features: Reception & Lounge
    loungeGroup.visible = floorNum === 1;
    recDeskGroup.visible = floorNum === 1;
  };

  // Initialize on Floor 2 (Active Studio Floor with Whole Team)
  setActiveFloor(2);

  const updateStatus = (slot: SlotId, status: string, timeSec: number, speech?: string | null) => {
    const ws = workstations.get(slot);
    if (!ws) return;

    // Update dynamic code / terminal / status screen textures
    ws.screenTextures.forEach((st) => {
      st.update(timeSec, status, speech);
    });

    const isActive = status === 'working' || status === 'active';
    ws.deskLight.intensity = isActive ? 1.4 : 0.9;
  };

  const updateCommanderScreen = (timeSec: number) => {
    cmdScreenTex.update(timeSec);
  };

  const dispose = () => {
    workstations.forEach((ws) => {
      ws.screenTextures.forEach((st) => st.dispose());
    });
    cmdScreenTex.dispose();
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
  };

  const updateWhiteboardPlan = (planText: string) => {
    renderWhiteboardPlan(planText);
    wbTexture.needsUpdate = true;
  };

  return {
    group: rootGroup,
    workstations,
    commanderDeskPos: cmdDeskPos,
    commanderScreenMesh: cmdScreen,
    whiteboardPos,
    obstacles,
    setActiveFloor,
    updateStatus,
    updateCommanderScreen,
    updateWhiteboardPlan,
    dispose,
  };
}
