import * as THREE from 'three';
import type { TextureCache } from './texture-cache';

export interface ExteriorSceneryResult {
  group: THREE.Group;
  streetLights: THREE.Light[];
  update: (delta: number, isNight: boolean) => void;
  /**
   * Dollhouse cutaway: hide the shell around the studio (front glass, upper
   * floors, slabs, roof) so a close camera sees into the room. The studio is
   * always built at ground level, so the slab and two storeys above it sit
   * between any normal camera angle and the team.
   */
  setCutaway: (on: boolean) => void;
  dispose: () => void;
}

interface MovingCar {
  group: THREE.Group;
  speed: number;
  direction: 1 | -1; // 1 = Eastbound (+X), -1 = Westbound (-X)
  headlights: THREE.Light[];
  wheels: THREE.Mesh[];
}

interface WalkingPedestrian {
  group: THREE.Group;
  speed: number;
  direction: 1 | -1;
  isCrossing?: boolean;
  legs: THREE.Mesh[];
  arms: THREE.Mesh[];
  walkPhase: number;
}

/**
 * Exterior City & Nature Scenery.
 * Renders the 3-story Dev House building in a rich environment with an asphalt roadway,
 * animated driving cars, walking pedestrians, lush stylized trees, streetlamps,
 * and a 3F "COMING SOON" expansion banner.
 */
export function buildExteriorScenery(textureCache: TextureCache): ExteriorSceneryResult {
  const rootGroup = new THREE.Group();
  rootGroup.name = 'ExteriorScenery';

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const streetLights: THREE.Light[] = [];
  const cars: MovingCar[] = [];
  const pedestrians: WalkingPedestrian[] = [];

  // --- Materials ---
  const asphaltMat = textureCache.getMaterial('mat:scenery_asphalt', () =>
    new THREE.MeshStandardMaterial({ color: '#23201d', roughness: 0.9, metalness: 0.05 })
  );
  const roadStripeYellowMat = textureCache.getMaterial('mat:scenery_stripe_yellow', () =>
    new THREE.MeshStandardMaterial({ color: '#eab308', roughness: 0.5 })
  );
  const roadStripeWhiteMat = textureCache.getMaterial('mat:scenery_stripe_white', () =>
    new THREE.MeshStandardMaterial({ color: '#f4ece2', roughness: 0.5 })
  );
  const sidewalkMat = textureCache.getMaterial('mat:scenery_sidewalk', () =>
    new THREE.MeshStandardMaterial({ color: '#8a7d70', roughness: 0.85 })
  );
  const grassMat = textureCache.getMaterial('mat:scenery_grass', () =>
    new THREE.MeshStandardMaterial({ color: '#3d5828', roughness: 0.9 })
  );
  const curbMat = textureCache.getMaterial('mat:scenery_curb', () =>
    new THREE.MeshStandardMaterial({ color: '#574d42', roughness: 0.7 })
  );
  const treeTrunkMat = textureCache.getMaterial('mat:scenery_trunk', () =>
    new THREE.MeshStandardMaterial({ color: '#3a271d', roughness: 0.9 })
  );
  const treeFoliageMat1 = textureCache.getMaterial('mat:scenery_foliage_1', () =>
    new THREE.MeshStandardMaterial({ color: '#4d7334', roughness: 0.7 })
  );
  const treeFoliageMat2 = textureCache.getMaterial('mat:scenery_foliage_2', () =>
    new THREE.MeshStandardMaterial({ color: '#3b5c26', roughness: 0.75 })
  );
  const lampPoleMat = textureCache.getMaterial('mat:scenery_lamp_pole', () =>
    new THREE.MeshStandardMaterial({ color: '#2a221a', roughness: 0.4, metalness: 0.8 })
  );
  const lampGlassMat = textureCache.getMaterial('mat:scenery_lamp_glass', () =>
    new THREE.MeshBasicMaterial({ color: '#fef08a' })
  );

  // --- 1. Grand Endless Ground Landscape (Extends 300m to horizon, zero sharp cut-off!) ---
  const terrainW = 600;
  const terrainD = 600;
  const terrainGeom = new THREE.PlaneGeometry(terrainW, terrainD);
  geometries.push(terrainGeom);

  const terrain = new THREE.Mesh(terrainGeom, grassMat);
  terrain.rotation.x = -Math.PI / 2;
  terrain.position.set(0, -0.05, 0);
  terrain.receiveShadow = true;
  rootGroup.add(terrain);

  // --- 2. Asphalt Roadway Across District (340m Long Avenue) ---
  const roadLength = 340;
  const roadWidth = 9.0;
  const roadZ = 19.5;

  const roadGeom = new THREE.PlaneGeometry(roadLength, roadWidth);
  geometries.push(roadGeom);
  const roadMesh = new THREE.Mesh(roadGeom, asphaltMat);
  roadMesh.rotation.x = -Math.PI / 2;
  roadMesh.position.set(0, 0.01, roadZ);
  roadMesh.receiveShadow = true;
  rootGroup.add(roadMesh);

  // Dashed Yellow Center Line
  const stripeGeom = new THREE.PlaneGeometry(2.4, 0.22);
  geometries.push(stripeGeom);
  for (let x = -160; x < 160; x += 4.8) {
    const stripe = new THREE.Mesh(stripeGeom, roadStripeYellowMat);
    stripe.rotation.x = -Math.PI / 2;
    stripe.position.set(x, 0.02, roadZ);
    rootGroup.add(stripe);
  }

  // Solid White Shoulder Lines
  const whiteLineGeom = new THREE.PlaneGeometry(roadLength, 0.18);
  geometries.push(whiteLineGeom);

  const whiteLineNorth = new THREE.Mesh(whiteLineGeom, roadStripeWhiteMat);
  whiteLineNorth.rotation.x = -Math.PI / 2;
  whiteLineNorth.position.set(0, 0.02, roadZ - roadWidth / 2 + 0.3);
  rootGroup.add(whiteLineNorth);

  const whiteLineSouth = new THREE.Mesh(whiteLineGeom, roadStripeWhiteMat);
  whiteLineSouth.rotation.x = -Math.PI / 2;
  whiteLineSouth.position.set(0, 0.02, roadZ + roadWidth / 2 - 0.3);
  rootGroup.add(whiteLineSouth);

  // Pedestrian Zebra Crosswalk in front of Dev House entrance
  const zebraBarGeom = new THREE.PlaneGeometry(0.7, 5.0);
  geometries.push(zebraBarGeom);
  for (let x = -3.2; x <= 3.2; x += 1.2) {
    const zebra = new THREE.Mesh(zebraBarGeom, roadStripeWhiteMat);
    zebra.rotation.x = -Math.PI / 2;
    zebra.position.set(x, 0.022, roadZ);
    rootGroup.add(zebra);
  }

  // Concrete Sidewalks (North & South)
  const sidewalkW = roadLength;
  const sidewalkD = 3.8;
  const sidewalkGeom = new THREE.BoxGeometry(sidewalkW, 0.22, sidewalkD);
  geometries.push(sidewalkGeom);

  const northSidewalk = new THREE.Mesh(sidewalkGeom, sidewalkMat);
  northSidewalk.position.set(0, 0.11, roadZ - roadWidth / 2 - sidewalkD / 2);
  northSidewalk.receiveShadow = true;
  rootGroup.add(northSidewalk);

  const southSidewalk = new THREE.Mesh(sidewalkGeom, sidewalkMat);
  southSidewalk.position.set(0, 0.11, roadZ + roadWidth / 2 + sidewalkD / 2);
  southSidewalk.receiveShadow = true;
  rootGroup.add(southSidewalk);

  // Stone Curbs
  const curbGeom = new THREE.BoxGeometry(roadLength, 0.14, 0.2);
  geometries.push(curbGeom);
  const northCurb = new THREE.Mesh(curbGeom, curbMat);
  northCurb.position.set(0, 0.16, roadZ - roadWidth / 2);
  rootGroup.add(northCurb);

  const southCurb = new THREE.Mesh(curbGeom, curbMat);
  southCurb.position.set(0, 0.16, roadZ + roadWidth / 2);
  rootGroup.add(southCurb);

  // --- 3. Street Lamps along Sidewalk ---
  const lampPoleGeom = new THREE.CylinderGeometry(0.06, 0.08, 4.2, 8);
  const lampHeadGeom = new THREE.BoxGeometry(0.35, 0.35, 0.35);
  geometries.push(lampPoleGeom, lampHeadGeom);

  const lampPositions = [-42, -24, -8, 8, 24, 42];
  lampPositions.forEach((lx) => {
    const lampGroup = new THREE.Group();
    lampGroup.position.set(lx, 0, roadZ - roadWidth / 2 - 0.8);

    const pole = new THREE.Mesh(lampPoleGeom, lampPoleMat);
    pole.position.y = 2.1;
    pole.castShadow = true;
    lampGroup.add(pole);

    const head = new THREE.Mesh(lampHeadGeom, lampGlassMat);
    head.position.set(0, 4.2, 0.3);
    lampGroup.add(head);

    // The lamp head glows; no point light. Each one was evaluated for every
    // pixel in the scene, day and night, even at intensity 0.

    rootGroup.add(lampGroup);
  });

  // --- 4. Stylized Low-Poly Trees along the Street & Plaza ---
  const trunkGeom = new THREE.CylinderGeometry(0.2, 0.3, 2.8, 7);
  const foliageCone1 = new THREE.ConeGeometry(1.6, 2.6, 7);
  const foliageCone2 = new THREE.ConeGeometry(1.3, 2.2, 7);
  const foliageCone3 = new THREE.ConeGeometry(0.9, 1.8, 7);
  geometries.push(trunkGeom, foliageCone1, foliageCone2, foliageCone3);

  const treePositions = [
    [-32, roadZ - 6.8],
    [-22, roadZ - 7.2],
    [-14, roadZ - 6.5],
    [14, roadZ - 6.5],
    [22, roadZ - 7.2],
    [32, roadZ - 6.8],
    [-38, roadZ + 7.5],
    [-20, roadZ + 7.2],
    [-6, roadZ + 7.5],
    [8, roadZ + 7.5],
    [24, roadZ + 7.2],
    [38, roadZ + 7.5],
    [-18, 6.0],
    [-18, -4.0],
    [18, 6.0],
    [18, -4.0],
  ];

  treePositions.forEach(([tx, tz], idx) => {
    const treeGroup = new THREE.Group();
    treeGroup.position.set(tx, 0, tz);

    const trunk = new THREE.Mesh(trunkGeom, treeTrunkMat);
    trunk.position.y = 1.4;
    trunk.castShadow = true;
    treeGroup.add(trunk);

    const mat = idx % 2 === 0 ? treeFoliageMat1 : treeFoliageMat2;

    const f1 = new THREE.Mesh(foliageCone1, mat);
    f1.position.y = 3.2;
    f1.castShadow = true;
    treeGroup.add(f1);

    const f2 = new THREE.Mesh(foliageCone2, mat);
    f2.position.y = 4.4;
    f2.castShadow = true;
    treeGroup.add(f2);

    const f3 = new THREE.Mesh(foliageCone3, mat);
    f3.position.y = 5.4;
    f3.castShadow = true;
    treeGroup.add(f3);

    rootGroup.add(treeGroup);
  });

  // --- 4B. Surrounding District Buildings (Rich tech campus cityscape with depth) ---
  const districtBldgGroup = new THREE.Group();
  const districtMat1 = textureCache.getMaterial('mat:district_bldg_1', () =>
    new THREE.MeshStandardMaterial({ color: '#27221d', roughness: 0.7 })
  );
  const districtMat2 = textureCache.getMaterial('mat:district_bldg_2', () =>
    new THREE.MeshStandardMaterial({ color: '#1c1815', roughness: 0.6 })
  );

  const SURROUNDING_BUILDINGS = [
    // Flanking buildings on same side of avenue (Dev House at X=0, Z=0)
    { x: -36, z: -1, w: 22, h: 22, d: 18, mat: districtMat1 },
    { x: -66, z: -2, w: 26, h: 16, d: 20, mat: districtMat2 },
    { x: 36, z: -1, w: 20, h: 26, d: 18, mat: districtMat2 },
    { x: 64, z: -2, w: 24, h: 18, d: 20, mat: districtMat1 },
    // Buildings across the avenue (Z = 38)
    { x: -52, z: 38, w: 28, h: 20, d: 22, mat: districtMat2 },
    { x: -18, z: 38, w: 24, h: 28, d: 22, mat: districtMat1 },
    { x: 18, z: 38, w: 24, h: 24, d: 22, mat: districtMat2 },
    { x: 52, z: 38, w: 28, h: 18, d: 22, mat: districtMat1 },
  ];

  SURROUNDING_BUILDINGS.forEach((bldg) => {
    const bldgGeom = new THREE.BoxGeometry(bldg.w, bldg.h, bldg.d);
    geometries.push(bldgGeom);
    const mesh = new THREE.Mesh(bldgGeom, bldg.mat);
    mesh.position.set(bldg.x, bldg.h / 2, bldg.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    districtBldgGroup.add(mesh);

    // Architectural floor bands
    const bandGeom = new THREE.BoxGeometry(bldg.w + 0.3, 0.35, bldg.d + 0.3);
    geometries.push(bandGeom);
    for (let by = 4.2; by < bldg.h - 1; by += 4.2) {
      const band = new THREE.Mesh(bandGeom, districtMat2);
      band.position.set(bldg.x, by, bldg.z);
      districtBldgGroup.add(band);
    }
  });
  rootGroup.add(districtBldgGroup);

  // --- 5. Optimized Animated Driving Cars (3 smooth, spaced-out vehicles) ---
  const CAR_MODELS = [
    { color: '#d98b4d', lane: 1, speed: 12.0, length: 3.6, startX: -110 }, // Amber Coupe (Eastbound)
    { color: '#7fa8a0', lane: -1, speed: 13.5, length: 3.8, startX: 10 },  // Sage Wagon (Westbound)
    { color: '#d9a441', lane: -1, speed: 11.0, length: 3.5, startX: 130 }, // Ochre Taxi (Westbound)
  ];

  const wheelGeom = new THREE.CylinderGeometry(0.3, 0.3, 0.22, 10);
  const wheelMat = textureCache.getMaterial('mat:car_wheel', () =>
    new THREE.MeshStandardMaterial({ color: '#17130f', roughness: 0.8 })
  );
  geometries.push(wheelGeom);

  CAR_MODELS.forEach((model) => {
    const carGroup = new THREE.Group();
    const isEast = model.lane === 1;
    const laneZ = isEast ? roadZ - 2.2 : roadZ + 2.2;

    carGroup.position.set(model.startX, 0.45, laneZ);
    if (!isEast) {
      carGroup.rotation.y = Math.PI; // Face westbound
    }

    // Car Body Mesh
    const carBodyMat = new THREE.MeshStandardMaterial({ color: model.color, roughness: 0.3, metalness: 0.2 });
    materials.push(carBodyMat);

    const bodyGeom = new THREE.BoxGeometry(model.length, 0.65, 1.6);
    geometries.push(bodyGeom);
    const bodyMesh = new THREE.Mesh(bodyGeom, carBodyMat);
    bodyMesh.castShadow = true;
    carGroup.add(bodyMesh);

    // Cabin / Roof
    const cabinGeom = new THREE.BoxGeometry(model.length * 0.58, 0.55, 1.4);
    geometries.push(cabinGeom);
    const glassRoofMat = new THREE.MeshStandardMaterial({ color: '#17130f', roughness: 0.2 });
    materials.push(glassRoofMat);
    const cabinMesh = new THREE.Mesh(cabinGeom, glassRoofMat);
    cabinMesh.position.set(-0.2, 0.58, 0);
    cabinMesh.castShadow = true;
    carGroup.add(cabinMesh);

    // 4 Wheels
    const carWheels: THREE.Mesh[] = [];
    const wx = model.length * 0.32;
    const wz = 0.82;
    [
      [-wx, -0.15, -wz],
      [wx, -0.15, -wz],
      [-wx, -0.15, wz],
      [wx, -0.15, wz],
    ].forEach(([cx, cy, cz]) => {
      const wheel = new THREE.Mesh(wheelGeom, wheelMat);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(cx, cy, cz);
      wheel.castShadow = true;
      carGroup.add(wheel);
      carWheels.push(wheel);
    });

    // Headlights
    const headLightsList: THREE.Light[] = [];
    [-0.55, 0.55].forEach((hz) => {
      // Bulb only, no point light: see the street lamps.

      // Yellow glowing headlight mesh
      const bulbGeom = new THREE.BoxGeometry(0.08, 0.14, 0.2);
      geometries.push(bulbGeom);
      const bulb = new THREE.Mesh(bulbGeom, lampGlassMat);
      bulb.position.set(model.length / 2 + 0.02, 0, hz);
      carGroup.add(bulb);
    });

    // Red Taillights
    const tailMat = new THREE.MeshBasicMaterial({ color: '#ef4444' });
    materials.push(tailMat);
    [-0.55, 0.55].forEach((tz) => {
      const tailGeom = new THREE.BoxGeometry(0.08, 0.12, 0.2);
      geometries.push(tailGeom);
      const tail = new THREE.Mesh(tailGeom, tailMat);
      tail.position.set(-model.length / 2 - 0.02, 0, tz);
      carGroup.add(tail);
    });

    rootGroup.add(carGroup);
    cars.push({
      group: carGroup,
      speed: model.speed,
      direction: isEast ? 1 : -1,
      headlights: headLightsList,
      wheels: carWheels,
    });
  });

  // --- 6. Walking Pedestrians on Sidewalk ---
  // --- 6. Stylized Walking Pedestrians on Sidewalks & Crosswalk ---
  const pedBodyGeom = new THREE.BoxGeometry(0.32, 0.58, 0.22);
  const pedHeadGeom = new THREE.SphereGeometry(0.13, 8, 8);
  const pedArmGeom = new THREE.BoxGeometry(0.09, 0.48, 0.09);
  const pedLegGeom = new THREE.BoxGeometry(0.11, 0.62, 0.11);
  const pedHairGeom = new THREE.BoxGeometry(0.28, 0.16, 0.28);
  geometries.push(pedBodyGeom, pedHeadGeom, pedArmGeom, pedLegGeom, pedHairGeom);

  const PED_CONFIGS = [
    // North Sidewalk Pedestrian (Eastbound)
    { x: -38, z: roadZ - roadWidth / 2 - 1.8, dir: 1, speed: 2.1, skin: '#fcd3b6', jacket: '#d98b4d', pants: '#1e293b', hair: '#271810', isCrossing: false },
    // South Sidewalk Pedestrian (Westbound)
    { x: 38, z: roadZ + roadWidth / 2 + 1.8, dir: -1, speed: 2.0, skin: '#8d5524', jacket: '#15803d', pants: '#1c1917', hair: '#0f172a', isCrossing: false },
    // Crosswalk Pedestrian crossing between building entrance and South Sidewalk
    { x: 0.0, z: roadZ - roadWidth / 2 - 1.2, dir: 1, speed: 1.8, skin: '#d4a373', jacket: '#334155', pants: '#475569', hair: '#181512', isCrossing: true },
  ];

  PED_CONFIGS.forEach((cfg) => {
    const pedGroup = new THREE.Group();
    pedGroup.position.set(cfg.x, 0.72, cfg.z);

    const skinMat = new THREE.MeshStandardMaterial({ color: cfg.skin, roughness: 0.5 });
    const jacketMat = new THREE.MeshStandardMaterial({ color: cfg.jacket, roughness: 0.6 });
    const pantsMat = new THREE.MeshStandardMaterial({ color: cfg.pants, roughness: 0.7 });
    const hairMat = new THREE.MeshStandardMaterial({ color: cfg.hair, roughness: 0.8 });
    materials.push(skinMat, jacketMat, pantsMat, hairMat);

    // Torso / Jacket
    const body = new THREE.Mesh(pedBodyGeom, jacketMat);
    body.position.y = 0.38;
    body.castShadow = true;
    pedGroup.add(body);

    // Head with Skin Tone
    const head = new THREE.Mesh(pedHeadGeom, skinMat);
    head.position.y = 0.82;
    head.castShadow = true;
    pedGroup.add(head);

    // Hair / Cap
    const hair = new THREE.Mesh(pedHairGeom, hairMat);
    hair.position.y = 0.90;
    pedGroup.add(hair);

    // Arms (swing opposite to legs)
    const arms: THREE.Mesh[] = [];
    [-0.22, 0.22].forEach((ax) => {
      const armGroup = new THREE.Group();
      armGroup.position.set(ax, 0.58, 0);
      const arm = new THREE.Mesh(pedArmGeom, jacketMat);
      arm.position.y = -0.2;
      arm.castShadow = true;
      armGroup.add(arm);
      pedGroup.add(armGroup);
      arms.push(arm);
    });

    // Legs with Pants
    const legs: THREE.Mesh[] = [];
    [-0.09, 0.09].forEach((lx) => {
      const legGroup = new THREE.Group();
      legGroup.position.set(lx, 0.1, 0);
      const leg = new THREE.Mesh(pedLegGeom, pantsMat);
      leg.position.y = -0.3;
      leg.castShadow = true;
      legGroup.add(leg);
      pedGroup.add(legGroup);
      legs.push(leg);
    });

    rootGroup.add(pedGroup);
    pedestrians.push({
      group: pedGroup,
      speed: cfg.speed,
      direction: cfg.dir as 1 | -1,
      isCrossing: cfg.isCrossing,
      legs,
      arms,
      walkPhase: Math.random() * Math.PI * 2,
    });
  });

  // --- 7. Full 3-Story Modern Architectural Building Envelope ---
  const exteriorFacadeGroup = new THREE.Group();
  exteriorFacadeGroup.name = 'BuildingExteriorFacade';

  const bldgW = 18.6;
  const bldgD = 15.6;
  const bldgH = 12.8; // 3 floors ~4.2m each

  // Architectural Cladding Materials
  const darkBronzeCladdingMat = textureCache.getMaterial('mat:ext_dark_bronze', () =>
    new THREE.MeshStandardMaterial({ color: '#241f1c', roughness: 0.45, metalness: 0.4 })
  );
  const concretePlinthMat = textureCache.getMaterial('mat:ext_concrete_plinth', () =>
    new THREE.MeshStandardMaterial({ color: '#2d2722', roughness: 0.85, metalness: 0.1 })
  );
  const clearShowroomGlassMat = textureCache.getMaterial('mat:ext_showroom_glass', () =>
    new THREE.MeshStandardMaterial({
      color: '#ffffff',
      transparent: true,
      opacity: 0.25,
      roughness: 0.08,
      metalness: 0.1,
    })
  );
  const frostedUpperGlassMat = textureCache.getMaterial('mat:ext_frosted_glass', () =>
    new THREE.MeshStandardMaterial({
      color: '#334155',
      transparent: true,
      opacity: 0.65,
      roughness: 0.45,
      metalness: 0.2,
    })
  );

  // A. Heavy Architectural Concrete Foundation Plinth
  const plinthGeom = new THREE.BoxGeometry(bldgW + 0.8, 0.4, bldgD + 0.8);
  geometries.push(plinthGeom);
  const plinth = new THREE.Mesh(plinthGeom, concretePlinthMat);
  plinth.position.set(0, -0.2, 0);
  plinth.receiveShadow = true;
  exteriorFacadeGroup.add(plinth);

  // B. Solid Left Architectural Exterior Side Wall
  const sideWallGeom = new THREE.BoxGeometry(0.45, bldgH, bldgD);
  geometries.push(sideWallGeom);
  const leftSideWall = new THREE.Mesh(sideWallGeom, darkBronzeCladdingMat);
  leftSideWall.position.set(-bldgW / 2 - 0.22, bldgH / 2, 0);
  leftSideWall.castShadow = true;
  leftSideWall.receiveShadow = true;
  exteriorFacadeGroup.add(leftSideWall);

  // C. Solid Right Architectural Exterior Side Wall
  const rightSideWall = new THREE.Mesh(sideWallGeom, darkBronzeCladdingMat);
  rightSideWall.position.set(bldgW / 2 + 0.22, bldgH / 2, 0);
  rightSideWall.castShadow = true;
  rightSideWall.receiveShadow = true;
  exteriorFacadeGroup.add(rightSideWall);

  // D. Solid Exterior Back Wall
  const backWallGeom = new THREE.BoxGeometry(bldgW + 0.9, bldgH, 0.45);
  geometries.push(backWallGeom);
  const solidBackWall = new THREE.Mesh(backWallGeom, darkBronzeCladdingMat);
  solidBackWall.position.set(0, bldgH / 2, -bldgD / 2 - 0.22);
  solidBackWall.castShadow = true;
  exteriorFacadeGroup.add(solidBackWall);

  // E. Architectural Floor Slabs & Spandrel Trim (1F, 2F, 3F, Roof)
  const slabGeom = new THREE.BoxGeometry(bldgW + 0.5, 0.38, bldgD + 0.5);
  geometries.push(slabGeom);
  [4.2, 8.4, 12.6].forEach((fy) => {
    const slab = new THREE.Mesh(slabGeom, darkBronzeCladdingMat);
    slab.position.set(0, fy, 0);
    slab.castShadow = true;
    exteriorFacadeGroup.add(slab);
  });

  // F. Rooftop Parapet Wall (1.2m tall) & Elevator / HVAC Mechanical Penthouse
  const parapetFrontGeom = new THREE.BoxGeometry(bldgW + 0.5, 1.2, 0.3);
  const parapetSideGeom = new THREE.BoxGeometry(0.3, 1.2, bldgD + 0.5);
  geometries.push(parapetFrontGeom, parapetSideGeom);

  const parapetFront = new THREE.Mesh(parapetFrontGeom, darkBronzeCladdingMat);
  parapetFront.position.set(0, 13.2, bldgD / 2);
  exteriorFacadeGroup.add(parapetFront);

  const parapetBack = new THREE.Mesh(parapetFrontGeom, darkBronzeCladdingMat);
  parapetBack.position.set(0, 13.2, -bldgD / 2);
  exteriorFacadeGroup.add(parapetBack);

  const parapetLeft = new THREE.Mesh(parapetSideGeom, darkBronzeCladdingMat);
  parapetLeft.position.set(-bldgW / 2, 13.2, 0);
  exteriorFacadeGroup.add(parapetLeft);

  const parapetRight = new THREE.Mesh(parapetSideGeom, darkBronzeCladdingMat);
  parapetRight.position.set(bldgW / 2, 13.2, 0);
  exteriorFacadeGroup.add(parapetRight);

  // Rooftop Elevator & HVAC Mechanical Penthouse
  const penthouseGeom = new THREE.BoxGeometry(5.4, 2.2, 4.6);
  geometries.push(penthouseGeom);
  const penthouse = new THREE.Mesh(penthouseGeom, darkBronzeCladdingMat);
  penthouse.position.set(0, 13.7, -3.2);
  penthouse.castShadow = true;
  exteriorFacadeGroup.add(penthouse);

  // G. 1F Ground Entrance Portal & Modern Cantilevered Glass Canopy
  const portalGeom = new THREE.BoxGeometry(3.6, 3.2, 0.4);
  geometries.push(portalGeom);
  const portal = new THREE.Mesh(portalGeom, darkBronzeCladdingMat);
  portal.position.set(0, 1.6, bldgD / 2 + 0.1);
  exteriorFacadeGroup.add(portal);

  // Modern Glass Canopy extending over the front entrance towards the crosswalk
  const canopyGeom = new THREE.BoxGeometry(4.4, 0.14, 2.2);
  geometries.push(canopyGeom);
  const canopy = new THREE.Mesh(canopyGeom, darkBronzeCladdingMat);
  canopy.position.set(0, 3.4, bldgD / 2 + 1.1);
  canopy.castShadow = true;
  exteriorFacadeGroup.add(canopy);

  // Warm LED downlights under entrance canopy
  [-1.2, 1.2].forEach((cx) => {
    const canopyLight = new THREE.PointLight('#fffbeb', 1.8, 6.0, 1.5);
    canopyLight.position.set(cx, 3.2, bldgD / 2 + 1.1);
    exteriorFacadeGroup.add(canopyLight);
    streetLights.push(canopyLight);
  });

  // H. Front Glass Curtain Wall Panels (1F Showroom, 2F Active Studio, 3F Frosted Suite)
  // 1F Showroom Glass
  const glass1FGeom = new THREE.PlaneGeometry(bldgW, 3.8);
  geometries.push(glass1FGeom);
  const glass1F = new THREE.Mesh(glass1FGeom, clearShowroomGlassMat);
  glass1F.position.set(0, 2.0, bldgD / 2 + 0.05);
  exteriorFacadeGroup.add(glass1F);

  // 2F Active Dev House Engineering Studio Glass (Clear view of team & glowing screens!)
  const glass2FGeom = new THREE.PlaneGeometry(bldgW, 3.8);
  geometries.push(glass2FGeom);
  const glass2F = new THREE.Mesh(glass2FGeom, clearShowroomGlassMat);
  glass2F.position.set(0, 6.3, bldgD / 2 + 0.05);
  exteriorFacadeGroup.add(glass2F);

  // 3F Frosted Expansion Suite Glass with Horizontal Louvers
  const glass3FGeom = new THREE.PlaneGeometry(bldgW, 3.8);
  geometries.push(glass3FGeom);
  const glass3F = new THREE.Mesh(glass3FGeom, frostedUpperGlassMat);
  glass3F.position.set(0, 10.5, bldgD / 2 + 0.05);
  exteriorFacadeGroup.add(glass3F);

  // Front Aluminum Mullions
  const vertMullionGeom = new THREE.BoxGeometry(0.12, bldgH, 0.18);
  geometries.push(vertMullionGeom);
  [-6.2, -2.4, 2.4, 6.2].forEach((mx) => {
    const mullion = new THREE.Mesh(vertMullionGeom, darkBronzeCladdingMat);
    mullion.position.set(mx, bldgH / 2, bldgD / 2 + 0.08);
    exteriorFacadeGroup.add(mullion);
  });

  // I. 3F Architectural Spandrel Plaque: "3F SKY EXPANSION SUITE • COMING SOON" (Clean, No Emojis)
  const plaqueGeom = new THREE.PlaneGeometry(12.0, 1.4);
  geometries.push(plaqueGeom);

  const plaqueCanvas = document.createElement('canvas');
  plaqueCanvas.width = 1024;
  plaqueCanvas.height = 120;
  const pCtx = plaqueCanvas.getContext('2d')!;

  pCtx.fillStyle = '#1e1915';
  pCtx.fillRect(0, 0, 1024, 120);
  pCtx.strokeStyle = '#d98b4d';
  pCtx.lineWidth = 3;
  pCtx.strokeRect(3, 3, 1018, 114);

  pCtx.fillStyle = '#d98b4d';
  pCtx.font = 'bold 32px monospace';
  pCtx.textAlign = 'center';
  pCtx.fillText('3F SKY EXPANSION SUITE • COMING SOON', 512, 52);

  pCtx.fillStyle = '#f4ece2';
  pCtx.font = '18px monospace';
  pCtx.fillText('ARCHITECTURAL EXPANSION // NEXT-GEN AGENT LABS', 512, 92);

  const plaqueTex = new THREE.CanvasTexture(plaqueCanvas);
  plaqueTex.colorSpace = THREE.SRGBColorSpace;
  const plaqueMat = new THREE.MeshBasicMaterial({ map: plaqueTex });
  materials.push(plaqueMat);

  const plaqueMesh = new THREE.Mesh(plaqueGeom, plaqueMat);
  plaqueMesh.position.set(0, 8.4, bldgD / 2 + 0.28);
  exteriorFacadeGroup.add(plaqueMesh);

  // J. Roof Parapet Architectural Sign: "DEV HOUSE STUDIO" (Clean, No Emojis, No Stars)
  const roofSignCanvas = document.createElement('canvas');
  roofSignCanvas.width = 512;
  roofSignCanvas.height = 100;
  const rCtx = roofSignCanvas.getContext('2d')!;
  rCtx.fillStyle = '#1a1511';
  rCtx.fillRect(0, 0, 512, 100);
  rCtx.strokeStyle = '#d98b4d';
  rCtx.lineWidth = 3;
  rCtx.strokeRect(2, 2, 508, 96);

  rCtx.fillStyle = '#f4ece2';
  rCtx.font = 'bold 34px monospace';
  rCtx.textAlign = 'center';
  rCtx.fillText('DEV HOUSE STUDIO', 256, 60);

  const roofSignTex = new THREE.CanvasTexture(roofSignCanvas);
  roofSignTex.colorSpace = THREE.SRGBColorSpace;
  const roofSignMat = new THREE.MeshBasicMaterial({ map: roofSignTex });
  materials.push(roofSignMat);

  const roofSignGeom = new THREE.PlaneGeometry(7.2, 1.4);
  geometries.push(roofSignGeom);
  const roofSign = new THREE.Mesh(roofSignGeom, roofSignMat);
  roofSign.position.set(0, 13.2, bldgD / 2 + 0.18);
  exteriorFacadeGroup.add(roofSign);

  rootGroup.add(exteriorFacadeGroup);

  // Meshes only — the canopy lights stay put, since hiding a light changes the
  // light count and recompiles every shader. Only the plinth, below the
  // studio floor line, stays.
  const keepInCutaway = new Set<THREE.Object3D>([plinth]);
  const cutawayMeshes = exteriorFacadeGroup.children.filter(
    (child) => (child as THREE.Mesh).isMesh && !keepInCutaway.has(child),
  );
  let cutawayOn = false;
  const setCutaway = (on: boolean) => {
    if (on === cutawayOn) return;
    cutawayOn = on;
    for (const mesh of cutawayMeshes) mesh.visible = !on;
  };

  // --- Animation Update Loop ---
  const update = (delta: number, isNight: boolean) => {
    // 1. Update Cars driving along the road
    cars.forEach((car) => {
      car.group.position.x += car.speed * car.direction * delta;

      // Wrap around distant horizon far outside camera view
      if (car.direction === 1 && car.group.position.x > 165) {
        car.group.position.x = -165;
      } else if (car.direction === -1 && car.group.position.x < -165) {
        car.group.position.x = 165;
      }

      // Rotate wheels
      car.wheels.forEach((w) => {
        w.rotation.y += delta * car.speed * 3.5;
      });

      // Toggle car headlights at night
      car.headlights.forEach((h) => {
        h.intensity = isNight ? 1.6 : 0.0;
      });
    });

    // 2. Update Pedestrians walking along sidewalks and crossing crosswalk
    pedestrians.forEach((p) => {
      p.walkPhase += delta * p.speed * 3.2;

      if (p.isCrossing) {
        // Crosswalk pedestrian moves along Z axis
        p.group.position.z += delta * p.speed * p.direction * 0.9;
        if (p.direction === 1 && p.group.position.z > roadZ + roadWidth / 2 + 1.8) {
          p.direction = -1;
          p.group.rotation.y = Math.PI;
        } else if (p.direction === -1 && p.group.position.z < roadZ - roadWidth / 2 - 1.8) {
          p.direction = 1;
          p.group.rotation.y = 0;
        }
      } else {
        // Sidewalk pedestrian moves along X axis
        p.group.position.x += delta * p.speed * p.direction;
        if (p.direction === 1 && p.group.position.x > 150) {
          p.group.position.x = -150;
        } else if (p.direction === -1 && p.group.position.x < -150) {
          p.group.position.x = 150;
        }
      }

      // Smooth leg & arm stride swing
      const swingAngle = Math.sin(p.walkPhase) * 0.45;
      if (p.legs[0]) p.legs[0].rotation.x = swingAngle;
      if (p.legs[1]) p.legs[1].rotation.x = -swingAngle;
      if (p.arms[0]) p.arms[0].rotation.x = -swingAngle * 0.9;
      if (p.arms[1]) p.arms[1].rotation.x = swingAngle * 0.9;
    });

    // 3. Streetlamps & Canopy lights illuminated during Night
    streetLights.forEach((light) => {
      light.intensity = isNight ? 1.6 : 0.0;
    });
  };

  const dispose = () => {
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
  };

  return {
    group: rootGroup,
    streetLights,
    update,
    setCutaway,
    dispose,
  };
}
