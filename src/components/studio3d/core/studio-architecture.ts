import * as THREE from 'three';
import type { TextureCache } from './texture-cache';

export interface ArchitectureResult {
  group: THREE.Group;
  roomLights: THREE.Light[];
  dispose: () => void;
}

/** The studio: one room — floor, glass sides, solid back wall, ceiling and lights. */
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




  // --- 1. Floor slab ---
  const floorGeom = new THREE.PlaneGeometry(width, depth);
  geometries.push(floorGeom);
  const floorMesh = new THREE.Mesh(floorGeom, parquetFloorMat);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = 0.001;
  floorMesh.receiveShadow = true;
  rootGroup.add(floorMesh);

  // Ceiling & rafters
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

  // Back wall, solid across the room.
  const backWallGeom = new THREE.BoxGeometry(width, height, 0.2);
  geometries.push(backWallGeom);
  const backWall = new THREE.Mesh(backWallGeom, wallPlasterMat);
  backWall.position.set(0, height / 2, -depth / 2);
  backWall.receiveShadow = true;
  rootGroup.add(backWall);

  const dispose = () => {
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
  };

  return {
    group: rootGroup,
    roomLights,
    dispose,
  };
}
