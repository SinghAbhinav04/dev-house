import * as THREE from 'three';
import type { TextureCache } from './texture-cache';

export interface FloorDef {
  floorNumber: number;
  name: string;
  sublabel: string;
  floorType: 'atrium' | 'engineering' | 'command' | 'security' | 'construction' | 'rooftop';
}

export const DEV_HOUSE_FLOORS: FloorDef[] = [
  { floorNumber: 1, name: '1F Atrium & Lounge', sublabel: 'Reception & Coffee Bar', floorType: 'atrium' },
  { floorNumber: 2, name: '2F Dev House Studio', sublabel: 'Whole Engineering Team (ACTIVE)', floorType: 'engineering' },
  { floorNumber: 3, name: '3F Sky Suite', sublabel: 'Expansion Suite • Coming Soon', floorType: 'construction' },
];

export interface ArchitectureResult {
  group: THREE.Group;
  floors: FloorDef[];
  roomLights: THREE.Light[];
  setActiveFloor: (floorNum: number) => void;
  setLiftDoors: (openRatio: number) => void;
  dispose: () => void;
}

/**
 * Builds the focused single active floor architectural studio with the central elevator lift.
 * When switching floors via the lift, the room transforms dynamically into that floor's
 * unique environment (e.g. Under Construction scaffolding on 5F, Sky Terrace on 6F).
 */
export function buildStudioArchitecture(
  width: number,
  depth: number,
  height: number,
  textureCache: TextureCache
): ArchitectureResult {
  const rootGroup = new THREE.Group();
  rootGroup.name = 'SingleActiveFloorStudio';

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const roomLights: THREE.Light[] = [];

  // --- Warm Studio Materials ---
  const woodTexture = textureCache.getWoodFloorTexture();
  const parquetFloorMat = textureCache.getMaterial('mat:active_parquet', () =>
    new THREE.MeshStandardMaterial({
      map: woodTexture,
      roughness: 0.4,
      metalness: 0.05,
    })
  );

  const concreteFloorMat = textureCache.getMaterial('mat:active_concrete', () =>
    new THREE.MeshStandardMaterial({
      color: '#38332e',
      roughness: 0.85,
      metalness: 0.1,
    })
  );

  const rooftopDeckMat = textureCache.getMaterial('mat:active_deck', () =>
    new THREE.MeshStandardMaterial({
      color: '#453528',
      roughness: 0.7,
      metalness: 0.05,
    })
  );

  const wallPlasterMat = textureCache.getMaterial('mat:active_wall_plaster', () =>
    new THREE.MeshStandardMaterial({
      color: '#d1c4b2', // Warm architectural studio plaster - bright and light-reflective
      roughness: 0.7,
      metalness: 0.04,
    })
  );

  const ceilingPanelMat = textureCache.getMaterial('mat:active_ceiling_panel', () =>
    new THREE.MeshStandardMaterial({
      color: '#e4dacf', // Soft warm acoustic linen ceiling
      roughness: 0.75,
      metalness: 0.02,
    })
  );

  const timberBeamMat = textureCache.getMaterial('mat:active_timber', () =>
    new THREE.MeshStandardMaterial({
      color: '#3d2e24', // Warm architectural walnut timber
      roughness: 0.65,
      metalness: 0.15,
    })
  );

  const glassMat = textureCache.getMaterial('mat:active_glass', () =>
    new THREE.MeshStandardMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 0.2,
      roughness: 0.08,
      metalness: 0.1,
    })
  );

  const scaffoldYellowMat = textureCache.getMaterial('mat:active_scaffold', () =>
    new THREE.MeshStandardMaterial({ color: '#eab308', roughness: 0.5, metalness: 0.3 })
  );

  const cautionTapeMat = textureCache.getMaterial('mat:active_caution', () =>
    new THREE.MeshStandardMaterial({ color: '#f59e0b', roughness: 0.6 })
  );

  const woodPlankMat = textureCache.getMaterial('mat:active_plank', () =>
    new THREE.MeshStandardMaterial({ color: '#6e4c2f', roughness: 0.8 })
  );

  // --- 1. Floor Slab Mesh (Material changes per floor) ---
  const floorGeom = new THREE.PlaneGeometry(width, depth);
  geometries.push(floorGeom);
  const floorMesh = new THREE.Mesh(floorGeom, parquetFloorMat);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = 0.001;
  floorMesh.receiveShadow = true;
  rootGroup.add(floorMesh);

  // Ceiling & Rafters (Hidden on 6F rooftop)
  const ceilingGroup = new THREE.Group();
  const ceilingGeom = new THREE.PlaneGeometry(width, depth);
  geometries.push(ceilingGeom);
  const ceilingMesh = new THREE.Mesh(ceilingGeom, ceilingPanelMat);
  ceilingMesh.rotation.x = Math.PI / 2;
  ceilingMesh.position.y = height;
  ceilingGroup.add(ceilingMesh);

  // 4 Warm Ceiling Downlights (2700K incandescent warmth)
  const lightPositions = [
    [-3.8, height - 0.4, -2.4],
    [3.8, height - 0.4, -2.4],
    [-3.8, height - 0.4, 2.4],
    [3.8, height - 0.4, 2.4],
  ];

  lightPositions.forEach(([lx, ly, lz]) => {
    const light = new THREE.PointLight('#fef08a', 3.2, 16, 1.2);
    light.position.set(lx, ly, lz);
    light.userData = { onIntensity: 3.2, offIntensity: 0.3 };
    ceilingGroup.add(light);
    roomLights.push(light);

    const shadeGeom = new THREE.ConeGeometry(0.22, 0.14, 10);
    geometries.push(shadeGeom);
    const shade = new THREE.Mesh(shadeGeom, timberBeamMat);
    shade.position.set(lx, ly + 0.15, lz);
    ceilingGroup.add(shade);
  });

  // Central Architectural Ceiling Light
  const centerLight = new THREE.PointLight('#fff4dd', 3.6, 18, 1.2);
  centerLight.position.set(0, height - 0.35, 0);
  centerLight.userData = { onIntensity: 3.6, offIntensity: 0.35 };
  ceilingGroup.add(centerLight);
  roomLights.push(centerLight);

  rootGroup.add(ceilingGroup);

  // --- 2. Structural Corner Columns & Perimeter Timber Posts ---
  const postSize = 0.35;
  const colGeom = new THREE.BoxGeometry(postSize, height, postSize);
  geometries.push(colGeom);

  const corners = [
    [-width / 2, -depth / 2],
    [width / 2, -depth / 2],
    [-width / 2, depth / 2],
    [width / 2, depth / 2],
  ];

  corners.forEach(([cx, cz]) => {
    const col = new THREE.Mesh(colGeom, timberBeamMat);
    col.position.set(cx, height / 2, cz);
    col.castShadow = true;
    rootGroup.add(col);
  });

  // --- 3. Glass Curtain Walls (Front, Left, Right) ---
  const frontGlassGeom = new THREE.PlaneGeometry(width, height);
  const sideGlassGeom = new THREE.PlaneGeometry(depth, height);
  geometries.push(frontGlassGeom, sideGlassGeom);

  const frontGlass = new THREE.Mesh(frontGlassGeom, glassMat);
  frontGlass.position.set(0, height / 2, depth / 2);
  frontGlass.raycast = () => {}; // Never block click interactions
  rootGroup.add(frontGlass);

  const leftGlass = new THREE.Mesh(sideGlassGeom, glassMat);
  leftGlass.rotation.y = Math.PI / 2;
  leftGlass.position.set(-width / 2, height / 2, 0);
  leftGlass.raycast = () => {}; // Never block click interactions
  rootGroup.add(leftGlass);

  const rightGlass = new THREE.Mesh(sideGlassGeom, glassMat);
  rightGlass.rotation.y = -Math.PI / 2;
  rightGlass.position.set(width / 2, height / 2, 0);
  rightGlass.raycast = () => {}; // Never block click interactions
  rootGroup.add(rightGlass);

  // Back Wall (Solid with lift door opening)
  const backWallW = (width - 2.4) / 2;
  const backWallGeom = new THREE.BoxGeometry(backWallW, height, 0.2);
  geometries.push(backWallGeom);

  const backWallLeft = new THREE.Mesh(backWallGeom, wallPlasterMat);
  backWallLeft.position.set(-width / 4 - 0.6, height / 2, -depth / 2);
  backWallLeft.receiveShadow = true;
  rootGroup.add(backWallLeft);

  const backWallRight = new THREE.Mesh(backWallGeom, wallPlasterMat);
  backWallRight.position.set(width / 4 + 0.6, height / 2, -depth / 2);
  backWallRight.receiveShadow = true;
  rootGroup.add(backWallRight);

  // --- 4. Central Architectural Elevator Lift with Illuminated Cab & Sliding Doors ---
  const liftGroup = new THREE.Group();
  liftGroup.name = 'ElevatorLift';
  liftGroup.position.set(0, 0, -depth / 2 + 0.1);

  // Brushed Titanium Elevator Door Frame & Header Architrave
  const liftSteelMat = textureCache.getMaterial('mat:lift_steel_brushed', () =>
    new THREE.MeshStandardMaterial({ color: '#475569', roughness: 0.25, metalness: 0.85 })
  );
  const liftDoorMat = textureCache.getMaterial('mat:lift_door_stainless', () =>
    new THREE.MeshStandardMaterial({ color: '#94a3b8', roughness: 0.2, metalness: 0.9 })
  );
  const liftDarkGlassMat = textureCache.getMaterial('mat:lift_vision_glass', () =>
    new THREE.MeshStandardMaterial({
      color: '#1e293b',
      roughness: 0.1,
      metalness: 0.5,
      transparent: true,
      opacity: 0.7,
    })
  );

  const frameGeom = new THREE.BoxGeometry(2.4, 2.8, 0.25);
  geometries.push(frameGeom);
  const frameMesh = new THREE.Mesh(frameGeom, liftSteelMat);
  frameMesh.position.set(0, 1.4, 0);
  liftGroup.add(frameMesh);

  // Digital LED Dot-Matrix Floor Display above doors
  const indCanvas = document.createElement('canvas');
  indCanvas.width = 512;
  indCanvas.height = 100;
  const indCtx = indCanvas.getContext('2d')!;

  const updateLiftIndicator = (floorNum: number, floorName: string) => {
    indCtx.fillStyle = '#0f172a';
    indCtx.fillRect(0, 0, 512, 100);
    indCtx.strokeStyle = '#334155';
    indCtx.lineWidth = 4;
    indCtx.strokeRect(2, 2, 508, 96);

    indCtx.fillStyle = '#f59e0b';
    indCtx.font = 'bold 36px monospace';
    indCtx.textAlign = 'center';
    indCtx.fillText(`[ ${floorNum}F ]  ${floorName.toUpperCase()}  ▲`, 256, 62);
  };
  updateLiftIndicator(2, 'Dev House Studio');

  const indTex = new THREE.CanvasTexture(indCanvas);
  indTex.colorSpace = THREE.SRGBColorSpace;
  const indMat = new THREE.MeshBasicMaterial({ map: indTex });
  materials.push(indMat);

  const indicatorGeom = new THREE.PlaneGeometry(1.6, 0.32);
  geometries.push(indicatorGeom);
  const indicatorMesh = new THREE.Mesh(indicatorGeom, indMat);
  indicatorMesh.position.set(0, 2.7, 0.13);
  liftGroup.add(indicatorMesh);

  // Call Button Panel on right architrave
  const callPanelGeom = new THREE.BoxGeometry(0.12, 0.45, 0.04);
  geometries.push(callPanelGeom);
  const callPanel = new THREE.Mesh(callPanelGeom, liftSteelMat);
  callPanel.position.set(1.36, 1.3, 0.13);
  liftGroup.add(callPanel);

  // Two glowing call button pips (Up & Down)
  const btnGeom = new THREE.CylinderGeometry(0.02, 0.02, 0.02, 10);
  geometries.push(btnGeom);
  const btnMat = new THREE.MeshBasicMaterial({ color: '#f59e0b' });
  materials.push(btnMat);
  [0.08, -0.08].forEach((by) => {
    const btn = new THREE.Mesh(btnGeom, btnMat);
    btn.rotation.x = Math.PI / 2;
    btn.position.set(1.36, 1.3 + by, 0.15);
    liftGroup.add(btn);
  });

  // Modern Elevator Cab Interior behind sliding doors
  const cabGroup = new THREE.Group();
  cabGroup.position.set(0, 0, -1.1);

  // Cab Floor, Ceiling & Walls
  const cabWallMat = textureCache.getMaterial('mat:lift_cab_panel', () =>
    new THREE.MeshStandardMaterial({ color: '#64748b', roughness: 0.3, metalness: 0.8 })
  );
  const cabFloorMat = textureCache.getMaterial('mat:lift_cab_floor', () =>
    new THREE.MeshStandardMaterial({ color: '#1e293b', roughness: 0.6 })
  );

  const cabBackGeom = new THREE.PlaneGeometry(2.1, 2.6);
  const cabSideGeom = new THREE.PlaneGeometry(2.1, 2.6);
  const cabFloorGeom = new THREE.PlaneGeometry(2.1, 2.1);
  geometries.push(cabBackGeom, cabSideGeom, cabFloorGeom);

  const cabBack = new THREE.Mesh(cabBackGeom, cabWallMat);
  cabBack.position.set(0, 1.3, -1.05);
  cabGroup.add(cabBack);

  // Cab back mirror
  const mirrorGeom = new THREE.PlaneGeometry(1.6, 1.8);
  geometries.push(mirrorGeom);
  const mirrorMat = new THREE.MeshStandardMaterial({ color: '#e2e8f0', roughness: 0.05, metalness: 0.95 });
  materials.push(mirrorMat);
  const mirror = new THREE.Mesh(mirrorGeom, mirrorMat);
  mirror.position.set(0, 1.4, -1.04);
  cabGroup.add(mirror);

  const cabLeft = new THREE.Mesh(cabSideGeom, cabWallMat);
  cabLeft.rotation.y = Math.PI / 2;
  cabLeft.position.set(-1.05, 1.3, 0);
  cabGroup.add(cabLeft);

  const cabRight = new THREE.Mesh(cabSideGeom, cabWallMat);
  cabRight.rotation.y = -Math.PI / 2;
  cabRight.position.set(1.05, 1.3, 0);
  cabGroup.add(cabRight);

  const cabFloor = new THREE.Mesh(cabFloorGeom, cabFloorMat);
  cabFloor.rotation.x = -Math.PI / 2;
  cabFloor.position.set(0, 0.01, 0);
  cabGroup.add(cabFloor);

  // Stainless Handrail
  const railGeom = new THREE.CylinderGeometry(0.02, 0.02, 1.8, 8);
  geometries.push(railGeom);
  const rail = new THREE.Mesh(railGeom, liftSteelMat);
  rail.rotation.z = Math.PI / 2;
  rail.position.set(0, 0.9, -0.98);
  cabGroup.add(rail);

  // Warm LED downlight inside cab
  const cabLight = new THREE.PointLight('#fffbeb', 2.0, 5.0, 1.2);
  cabLight.position.set(0, 2.5, 0);
  cabGroup.add(cabLight);

  liftGroup.add(cabGroup);

  // Sliding Lift Doors (Left and Right with vertical vision glass slots)
  const doorW = 0.95;
  const doorH = 2.5;
  const doorGeom = new THREE.BoxGeometry(doorW, doorH, 0.05);
  const visionGlassGeom = new THREE.BoxGeometry(0.14, 1.6, 0.06);
  geometries.push(doorGeom, visionGlassGeom);

  const doorLeft = new THREE.Mesh(doorGeom, liftDoorMat);
  doorLeft.position.set(-doorW / 2, doorH / 2, 0.06);
  const glassLeft = new THREE.Mesh(visionGlassGeom, liftDarkGlassMat);
  glassLeft.position.set(0.2, 0, 0);
  doorLeft.add(glassLeft);
  liftGroup.add(doorLeft);

  const doorRight = new THREE.Mesh(doorGeom, liftDoorMat);
  doorRight.position.set(doorW / 2, doorH / 2, 0.06);
  const glassRight = new THREE.Mesh(visionGlassGeom, liftDarkGlassMat);
  glassRight.position.set(-0.2, 0, 0);
  doorRight.add(glassRight);
  liftGroup.add(doorRight);

  rootGroup.add(liftGroup);

  // --- 5. Floor 5: Under Construction Elements Group ---
  const constructionGroup = new THREE.Group();
  constructionGroup.name = 'ConstructionZone';
  constructionGroup.visible = false;

  // Yellow Scaffolding Towers
  const pipeGeom = new THREE.CylinderGeometry(0.04, 0.04, 3.8, 8);
  const plankGeom = new THREE.BoxGeometry(1.2, 0.06, 3.6);
  geometries.push(pipeGeom, plankGeom);

  [-4.2, 4.2].forEach((sx) => {
    const scaf = new THREE.Group();
    scaf.position.set(sx, 1.9, 0);

    [[-0.6, -1.6], [0.6, -1.6], [-0.6, 1.6], [0.6, 1.6]].forEach(([px, pz]) => {
      const pipe = new THREE.Mesh(pipeGeom, scaffoldYellowMat);
      pipe.position.set(px, 0, pz);
      scaf.add(pipe);
    });

    const plank = new THREE.Mesh(plankGeom, woodPlankMat);
    plank.position.set(0, 0.2, 0);
    scaf.add(plank);

    const bannerGeom = new THREE.PlaneGeometry(1.4, 0.35);
    geometries.push(bannerGeom);
    const banner = new THREE.Mesh(bannerGeom, cautionTapeMat);
    banner.position.set(0, 1.1, 1.62);
    scaf.add(banner);

    constructionGroup.add(scaf);
  });

  // Wooden Supply Crates & Pallets
  const crateGeom = new THREE.BoxGeometry(0.9, 0.9, 0.9);
  geometries.push(crateGeom);
  [
    [-1.6, 0.45, 2.2],
    [-1.6, 1.35, 2.2],
    [-0.6, 0.45, 2.5],
    [2.2, 0.45, 2.2],
  ].forEach(([cx, cy, cz]) => {
    const crate = new THREE.Mesh(crateGeom, woodPlankMat);
    crate.position.set(cx, cy, cz);
    constructionGroup.add(crate);
  });

  // Hanging Industrial Yellow Work Lights
  // Kept outside constructionGroup and dimmed instead of hidden, so the
  // scene's light count — and with it every shader — is the same on each floor.
  const workLight = new THREE.PointLight('#fef08a', 0, 14.0, 1.2);
  workLight.position.set(0, 3.2, 0);
  rootGroup.add(workLight);

  // Large In-Room "COMING SOON" Expansion Suite Banner
  const roomBannerCanvas = document.createElement('canvas');
  roomBannerCanvas.width = 1024;
  roomBannerCanvas.height = 180;
  const rbCtx = roomBannerCanvas.getContext('2d')!;
  rbCtx.fillStyle = '#f59e0b';
  rbCtx.fillRect(0, 0, 1024, 180);
  rbCtx.fillStyle = '#17130f';
  rbCtx.fillRect(16, 16, 992, 148);
  rbCtx.fillStyle = '#f59e0b';
  rbCtx.font = 'bold 36px monospace';
  rbCtx.textAlign = 'center';
  rbCtx.fillText('3F SKY EXPANSION SUITE • COMING SOON', 512, 75);
  rbCtx.fillStyle = '#f4ece2';
  rbCtx.font = 'bold 20px monospace';
  rbCtx.fillText('UNDER ARCHITECTURAL EXPANSION • NEW SQUADS EXPANDING HERE', 512, 120);

  const roomBannerTex = new THREE.CanvasTexture(roomBannerCanvas);
  roomBannerTex.colorSpace = THREE.SRGBColorSpace;
  const roomBannerMat = new THREE.MeshBasicMaterial({ map: roomBannerTex });
  materials.push(roomBannerMat);

  const roomBannerGeom = new THREE.PlaneGeometry(8.5, 1.5);
  geometries.push(roomBannerGeom);
  const roomBannerMesh = new THREE.Mesh(roomBannerGeom, roomBannerMat);
  roomBannerMesh.position.set(0, 2.6, -depth / 2 + 0.35);
  constructionGroup.add(roomBannerMesh);

  rootGroup.add(constructionGroup);

  // --- 6. Floor 6: Rooftop Sky Terrace Group ---
  const rooftopGroup = new THREE.Group();
  rooftopGroup.name = 'RooftopSkyTerrace';
  rooftopGroup.visible = false;

  // Glass safety perimeter railings
  const railH = 1.15;
  const railFrontGeom = new THREE.PlaneGeometry(width - 0.4, railH);
  const railSideGeom = new THREE.PlaneGeometry(depth - 0.4, railH);
  geometries.push(railFrontGeom, railSideGeom);

  const railFront = new THREE.Mesh(railFrontGeom, glassMat);
  railFront.position.set(0, railH / 2, depth / 2 - 0.2);
  rooftopGroup.add(railFront);

  const railLeft = new THREE.Mesh(railSideGeom, glassMat);
  railLeft.rotation.y = Math.PI / 2;
  railLeft.position.set(-width / 2 + 0.2, railH / 2, 0);
  rooftopGroup.add(railLeft);

  const railRight = new THREE.Mesh(railSideGeom, glassMat);
  railRight.rotation.y = -Math.PI / 2;
  railRight.position.set(width / 2 - 0.2, railH / 2, 0);
  rooftopGroup.add(railRight);

  // Astronomical Brass Telescope Pointed at Cosmos
  const teleGroup = new THREE.Group();
  teleGroup.position.set(0, 0, 3.8);

  const tripodLegGeom = new THREE.CylinderGeometry(0.025, 0.025, 1.4, 6);
  const teleTubeGeom = new THREE.CylinderGeometry(0.08, 0.11, 1.2, 10);
  geometries.push(tripodLegGeom, teleTubeGeom);

  const brassMat = new THREE.MeshStandardMaterial({ color: '#d97706', roughness: 0.3, metalness: 0.8 });
  materials.push(brassMat);

  [-0.3, 0.3].forEach((tx) => {
    const leg = new THREE.Mesh(tripodLegGeom, timberBeamMat);
    leg.position.set(tx, 0.7, 0);
    leg.rotation.z = tx > 0 ? -0.2 : 0.2;
    teleGroup.add(leg);
  });
  const backLeg = new THREE.Mesh(tripodLegGeom, timberBeamMat);
  backLeg.position.set(0, 0.7, -0.3);
  backLeg.rotation.x = -0.2;
  teleGroup.add(backLeg);

  const barrel = new THREE.Mesh(teleTubeGeom, brassMat);
  barrel.position.set(0, 1.35, 0);
  barrel.rotation.x = -Math.PI / 5;
  teleGroup.add(barrel);

  rooftopGroup.add(teleGroup);
  rootGroup.add(rooftopGroup);

  // --- Dynamic Active Floor Switcher ---
  const setActiveFloor = (floorNum: number) => {
    const floor = DEV_HOUSE_FLOORS.find((f) => f.floorNumber === floorNum) || DEV_HOUSE_FLOORS[1];
    const isConstruction = floor.floorType === 'construction';
    const isRooftop = floor.floorType === 'rooftop';

    // Switch floor materials
    floorMesh.material = isRooftop ? rooftopDeckMat : isConstruction ? concreteFloorMat : parquetFloorMat;

    // Toggle ceiling & rooftop elements
    ceilingGroup.visible = !isRooftop;
    constructionGroup.visible = isConstruction;
    rooftopGroup.visible = isRooftop;
    workLight.intensity = isConstruction ? 2.8 : 0;

    // Update modern elevator digital indicator
    updateLiftIndicator(floor.floorNumber, floor.name);
    indTex.needsUpdate = true;
  };

  // Lift sliding door animation (openRatio 0 = closed, 1 = open)
  const setLiftDoors = (openRatio: number) => {
    const clamped = Math.max(0, Math.min(1, openRatio));
    const offset = clamped * 0.85; // slide 0.85m sideways
    doorLeft.position.x = -doorW / 2 - offset;
    doorRight.position.x = doorW / 2 + offset;
  };

  // Initialize with doors open on Floor 2 (Active Studio with Whole Team)
  setLiftDoors(1.0);
  setActiveFloor(2);

  const dispose = () => {
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
  };

  return {
    group: rootGroup,
    floors: DEV_HOUSE_FLOORS,
    roomLights,
    setActiveFloor,
    setLiftDoors,
    dispose,
  };
}
