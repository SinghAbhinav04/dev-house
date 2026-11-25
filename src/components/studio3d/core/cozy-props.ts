import * as THREE from 'three';
import type { TextureCache } from './texture-cache';

export interface CozyPropsResult {
  group: THREE.Group;
  update: (delta: number, timeSec: number) => void;
  dispose: () => void;
}

/**
 * Creates the high-fidelity interior props seen in the Google Antigravity video:
 * 1. Cute desk robot companion with antenna and face screen (frame 0:03)
 * 2. Glass terrarium / aquarium cube with glowing plants & water (frame 0:02)
 * 3. Wall bookshelf with books and trailing ivy / pothos vines
 * 4. Potted monstera plant in ceramic planter
 */
export function buildCozyProps(textureCache: TextureCache): CozyPropsResult {
  const rootGroup = new THREE.Group();
  rootGroup.name = 'CozyProps';

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  // --- 1. Cute Robot Companion on Desk (Frame 0:03 in video) ---
  const robotGroup = new THREE.Group();
  robotGroup.position.set(4.5, 0.82, -2.8); // Sitting on Coder's desk
  robotGroup.rotation.y = -Math.PI / 4;

  const robotBodyGeom = new THREE.BoxGeometry(0.2, 0.22, 0.16);
  geometries.push(robotBodyGeom);
  const robotMat = textureCache.getMaterial('mat:robot_white', () =>
    new THREE.MeshStandardMaterial({ color: '#f8fafc', roughness: 0.2, metalness: 0.3 })
  );
  materials.push(robotMat);
  const robotBody = new THREE.Mesh(robotBodyGeom, robotMat);
  robotBody.position.y = 0.11;
  robotGroup.add(robotBody);

  // Robot Screen Face with glowing cyan eyes
  const screenGeom = new THREE.PlaneGeometry(0.16, 0.12);
  geometries.push(screenGeom);
  const robotScreenMat = new THREE.MeshBasicMaterial({ color: '#0ea5e9' });
  materials.push(robotScreenMat);
  const robotScreen = new THREE.Mesh(screenGeom, robotScreenMat);
  robotScreen.position.set(0, 0.12, 0.082);
  robotGroup.add(robotScreen);

  // Little Antenna
  const antennaStemGeom = new THREE.CylinderGeometry(0.01, 0.01, 0.08, 6);
  const antennaBallGeom = new THREE.SphereGeometry(0.025, 8, 8);
  geometries.push(antennaStemGeom, antennaBallGeom);

  const antennaStem = new THREE.Mesh(antennaStemGeom, robotMat);
  antennaStem.position.set(0, 0.26, 0);
  robotGroup.add(antennaStem);

  const antennaBallMat = new THREE.MeshBasicMaterial({ color: '#38bdf8' });
  materials.push(antennaBallMat);
  const antennaBall = new THREE.Mesh(antennaBallGeom, antennaBallMat);
  antennaBall.position.set(0, 0.3, 0);
  robotGroup.add(antennaBall);

  rootGroup.add(robotGroup);

  // --- 2. Glowing Terrarium Cube on Sideboard (Frame 0:02 in video) ---
  const credenzaGroup = new THREE.Group();
  credenzaGroup.position.set(-6.2, 0, 1.8);
  credenzaGroup.rotation.y = Math.PI / 2;

  // Credenza cabinet
  const credenzaGeom = new THREE.BoxGeometry(2.0, 0.72, 0.6);
  geometries.push(credenzaGeom);
  const woodMat = textureCache.getMaterial('mat:credenza_wood', () =>
    new THREE.MeshStandardMaterial({ color: '#3e2c1e', roughness: 0.6 })
  );
  materials.push(woodMat);
  const credenza = new THREE.Mesh(credenzaGeom, woodMat);
  credenza.position.y = 0.36;
  credenza.castShadow = true;
  credenza.receiveShadow = true;
  credenzaGroup.add(credenza);

  // Glass Terrarium Cube
  const terrariumW = 0.65;
  const terrariumH = 0.55;
  const terrariumD = 0.45;
  const glassTankGeom = new THREE.BoxGeometry(terrariumW, terrariumH, terrariumD);
  geometries.push(glassTankGeom);

  const glassTankMat = textureCache.getMaterial('mat:terrarium_glass', () =>
    new THREE.MeshPhysicalMaterial({
      color: '#cffafe',
      transparent: true,
      opacity: 0.3,
      roughness: 0.05,
      metalness: 0.1,
      transmission: 0.85,
      ior: 1.5,
    })
  );
  materials.push(glassTankMat);

  const tank = new THREE.Mesh(glassTankGeom, glassTankMat);
  tank.position.set(0, 0.72 + terrariumH / 2, 0);
  credenzaGroup.add(tank);

  // Terrarium Soil / Moss Base
  const mossBaseGeom = new THREE.BoxGeometry(terrariumW - 0.04, 0.12, terrariumD - 0.04);
  geometries.push(mossBaseGeom);
  const mossMat = textureCache.getMaterial('mat:moss_green', () =>
    new THREE.MeshStandardMaterial({ color: '#15803d', roughness: 0.9 })
  );
  materials.push(mossMat);
  const moss = new THREE.Mesh(mossBaseGeom, mossMat);
  moss.position.set(0, 0.72 + 0.06, 0);
  credenzaGroup.add(moss);

  // Glowing Mini Flora inside terrarium
  const floraGeom = new THREE.DodecahedronGeometry(0.12);
  geometries.push(floraGeom);
  const floraMat = new THREE.MeshStandardMaterial({
    color: '#34d399',
    emissive: new THREE.Color('#10b981'),
    emissiveIntensity: 0.8,
  });
  materials.push(floraMat);
  const flora = new THREE.Mesh(floraGeom, floraMat);
  flora.position.set(0, 0.72 + 0.22, 0);
  credenzaGroup.add(flora);

  // Subtle interior glow light
  const terrariumLight = new THREE.PointLight('#34d399', 0.6, 2.5);
  terrariumLight.position.set(0, 0.72 + 0.3, 0);
  credenzaGroup.add(terrariumLight);

  rootGroup.add(credenzaGroup);

  // --- 3. Floor-Standing Architectural Bookcase (Firmly planted on the floor at y=0, flush against back wall) ---
  const shelfGroup = new THREE.Group();
  shelfGroup.position.set(-5.6, 0, -7.18);

  const bookcaseW = 2.4;
  const bookcaseH = 2.1;
  const bookcaseD = 0.36;

  // Vertical Side Gables (from floor y=0 up to y=2.1)
  const gableGeom = new THREE.BoxGeometry(0.04, bookcaseH, bookcaseD);
  // Horizontal Shelves (Base plinth, 3 tiers, top crown)
  const shelfTierGeom = new THREE.BoxGeometry(bookcaseW, 0.04, bookcaseD);
  const backPanelGeom = new THREE.PlaneGeometry(bookcaseW, bookcaseH);
  geometries.push(gableGeom, shelfTierGeom, backPanelGeom);

  [-bookcaseW / 2 + 0.02, bookcaseW / 2 - 0.02].forEach((gx) => {
    const gable = new THREE.Mesh(gableGeom, woodMat);
    gable.position.set(gx, bookcaseH / 2, 0);
    gable.castShadow = true;
    shelfGroup.add(gable);
  });

  // Shelves: Plinth (y=0.02), Shelf 1 (y=0.55), Shelf 2 (y=1.1), Shelf 3 (y=1.6), Top (y=2.08)
  const shelfYLevels = [0.02, 0.55, 1.1, 1.6, 2.08];
  shelfYLevels.forEach((sy) => {
    const shelf = new THREE.Mesh(shelfTierGeom, woodMat);
    shelf.position.set(0, sy, 0);
    shelf.castShadow = true;
    shelfGroup.add(shelf);
  });

  // Backing panel
  const backPanel = new THREE.Mesh(backPanelGeom, woodMat);
  backPanel.position.set(0, bookcaseH / 2, -bookcaseD / 2 + 0.01);
  shelfGroup.add(backPanel);

  // Rows of colorful books on the shelves
  const bookGeom = new THREE.BoxGeometry(0.06, 0.28, 0.22);
  geometries.push(bookGeom);
  const bookColors = ['#f43f5e', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];

  // Populate Shelf 1 & Shelf 2 with books
  [0.55, 1.1].forEach((shelfY, tierIdx) => {
    for (let b = 0; b < 14; b++) {
      const bColor = bookColors[(b + tierIdx * 3) % bookColors.length];
      const bMat = textureCache.getMaterial(`mat:book_${bColor}`, () =>
        new THREE.MeshStandardMaterial({ color: bColor, roughness: 0.7 })
      );
      materials.push(bMat);
      const book = new THREE.Mesh(bookGeom, bMat);
      book.position.set(-0.95 + b * 0.14, shelfY + 0.16, (Math.random() - 0.5) * 0.02);
      book.rotation.y = (Math.random() - 0.5) * 0.08;
      shelfGroup.add(book);
    }
  });

  // Creeping Pothos / Ivy Vines trailing from upper shelf (y = 1.6)
  const vineLeafGeom = new THREE.SphereGeometry(0.05, 6, 6);
  geometries.push(vineLeafGeom);
  const vineLeafMat = textureCache.getMaterial('mat:vine_leaf', () =>
    new THREE.MeshStandardMaterial({ color: '#22c55e', roughness: 0.6 })
  );
  materials.push(vineLeafMat);

  const vinePositions = [-0.7, 0.2, 0.8];
  vinePositions.forEach((vx) => {
    for (let l = 0; l < 5; l++) {
      const leaf = new THREE.Mesh(vineLeafGeom, vineLeafMat);
      leaf.position.set(vx + (Math.random() - 0.5) * 0.08, 1.55 - l * 0.09, 0.12 + (Math.random() - 0.5) * 0.05);
      shelfGroup.add(leaf);
    }
  });

  rootGroup.add(shelfGroup);

  // --- 4. Large Potted Monstera Plant in Ceramic Planter ---
  const plantGroup = new THREE.Group();
  plantGroup.position.set(-6.2, 0, -5.0); // Cozy corner plant

  const planterGeom = new THREE.CylinderGeometry(0.35, 0.26, 0.6, 14);
  geometries.push(planterGeom);
  const planterMat = textureCache.getMaterial('mat:white_ceramic', () =>
    new THREE.MeshStandardMaterial({ color: '#f1f5f9', roughness: 0.3 })
  );
  materials.push(planterMat);
  const planter = new THREE.Mesh(planterGeom, planterMat);
  planter.position.y = 0.3;
  planter.castShadow = true;
  plantGroup.add(planter);

  // Fan leaves
  const monsteraLeafGeom = new THREE.CircleGeometry(0.28, 8);
  geometries.push(monsteraLeafGeom);
  for (let m = 0; m < 5; m++) {
    const angle = (m / 5) * Math.PI * 2;
    const leaf = new THREE.Mesh(monsteraLeafGeom, vineLeafMat);
    leaf.rotation.x = Math.PI / 3;
    leaf.rotation.y = angle;
    leaf.position.set(Math.cos(angle) * 0.2, 0.65 + m * 0.08, Math.sin(angle) * 0.2);
    leaf.castShadow = true;
    plantGroup.add(leaf);
  }

  rootGroup.add(plantGroup);

  /**
   * Subtle prop animations:
   * - Cute robot turns its head gently and blinks
   * - Flora in terrarium gently pulses with light
   */
  const update = (_delta: number, timeSec: number) => {
    robotGroup.rotation.y = -Math.PI / 4 + Math.sin(timeSec * 1.5) * 0.2;
    antennaBall.position.y = 0.3 + Math.sin(timeSec * 4) * 0.01;
    floraMat.emissiveIntensity = 0.8 + Math.sin(timeSec * 2.5) * 0.3;
  };

  const dispose = () => {
    geometries.forEach((g) => g.dispose());
  };

  return {
    group: rootGroup,
    update,
    dispose,
  };
}
