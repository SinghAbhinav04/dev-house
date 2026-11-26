import * as THREE from 'three';
import type { TextureCache } from './texture-cache';

/**
 * Builds the floating celestial island base upon which the glass house rests.
 */
export function buildFloatingIsland(
  width: number,
  depth: number,
  textureCache: TextureCache
): {
  group: THREE.Group;
  dispose: () => void;
} {
  const group = new THREE.Group();
  group.name = 'FloatingIsland';

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  // 1. Lush plateau border (slightly larger than room)
  const plateauW = width + 4;
  const plateauD = depth + 4;
  const plateauH = 1.2;

  const plateauGeom = new THREE.BoxGeometry(plateauW, plateauH, plateauD);
  geometries.push(plateauGeom);

  const plateauMat = textureCache.getMaterial('mat:island_plateau', () =>
    new THREE.MeshStandardMaterial({
      color: '#1e2922', // deep mossy evergreen
      roughness: 0.9,
      metalness: 0.1,
    })
  );
  materials.push(plateauMat);

  const plateauMesh = new THREE.Mesh(plateauGeom, plateauMat);
  plateauMesh.position.y = -plateauH / 2;
  plateauMesh.receiveShadow = true;
  group.add(plateauMesh);

  // 2. Inverted faceted cliff base (tapering downwards into the cosmos)
  const cliffSegments = [
    { topY: -plateauH, botY: -plateauH - 3, topScale: 1.0, botScale: 0.75, color: '#18151f' },
    { topY: -plateauH - 3, botY: -plateauH - 7, topScale: 0.75, botScale: 0.45, color: '#13111a' },
    { topY: -plateauH - 7, botY: -plateauH - 12, topScale: 0.45, botScale: 0.1, color: '#0d0b12' },
  ];

  cliffSegments.forEach((seg, idx) => {
    const segH = Math.abs(seg.topY - seg.botY);
    const geom = new THREE.CylinderGeometry(
      (plateauW / 2) * seg.topScale,
      (plateauW / 2) * seg.botScale,
      segH,
      7, // Low-poly 7-sided faceted rock appearance
      1
    );
    geometries.push(geom);

    const mat = textureCache.getMaterial(`mat:cliff_${idx}`, () =>
      new THREE.MeshStandardMaterial({
        color: seg.color,
        roughness: 0.85,
        flatShading: true,
      })
    );
    materials.push(mat);

    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.y = seg.topY - segH / 2;
    group.add(mesh);
  });

  // 3. Wooden entrance deck & floating steps
  const stepCount = 3;
  for (let s = 0; s < stepCount; s++) {
    const stepGeom = new THREE.BoxGeometry(2.4 - s * 0.2, 0.2, 0.8);
    geometries.push(stepGeom);

    const stepMat = textureCache.getMaterial('mat:wood_step', () =>
      new THREE.MeshStandardMaterial({
        color: '#453225',
        roughness: 0.7,
      })
    );
    materials.push(stepMat);

    const stepMesh = new THREE.Mesh(stepGeom, stepMat);
    stepMesh.position.set(0, -0.1 - s * 0.25, depth / 2 + 0.6 + s * 0.7);
    stepMesh.castShadow = true;
    stepMesh.receiveShadow = true;
    group.add(stepMesh);
  }

  // 4. Subtle glowing island under-crystal
  const crystalGeom = new THREE.OctahedronGeometry(1.2, 0);
  geometries.push(crystalGeom);

  const crystalMat = new THREE.MeshBasicMaterial({
    color: '#38bdf8',
    wireframe: true,
  });
  materials.push(crystalMat);

  const crystalMesh = new THREE.Mesh(crystalGeom, crystalMat);
  crystalMesh.position.y = -plateauH - 12.8;
  group.add(crystalMesh);

  const dispose = () => {
    geometries.forEach((g) => g.dispose());
  };

  return { group, dispose };
}
