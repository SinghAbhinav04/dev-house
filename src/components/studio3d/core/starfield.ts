import * as THREE from 'three';

/**
 * Creates a cosmic starfield particle system around the floating island.
 * Provides the deep-space second-brain atmosphere seen in the video.
 */
export function createStarfield(): {
  group: THREE.Group;
  update: (delta: number) => void;
  dispose: () => void;
} {
  const group = new THREE.Group();
  group.name = 'Starfield';

  const count = 1200;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  // Deep space palette: soft blues, subtle violets, golden stars, crisp whites
  const palette = [
    new THREE.Color('#ffffff'),
    new THREE.Color('#94a3b8'),
    new THREE.Color('#60a5fa'),
    new THREE.Color('#c084fc'),
    new THREE.Color('#fde047'),
  ];

  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    // Distribute around a spherical shell around the island (radius 40 to 120)
    const radius = 40 + Math.random() * 80;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);

    positions[i3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[i3 + 2] = radius * Math.cos(phi);

    const color = palette[Math.floor(Math.random() * palette.length)];
    colors[i3] = color.r;
    colors[i3 + 1] = color.g;
    colors[i3 + 2] = color.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 1.4,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    sizeAttenuation: true,
  });

  const points = new THREE.Points(geometry, material);
  group.add(points);

  // Subtle celestial orbital ring
  const ringGeom = new THREE.TorusGeometry(32, 0.08, 16, 120);
  const ringMat = new THREE.MeshBasicMaterial({
    color: '#38bdf8',
    transparent: true,
    opacity: 0.15,
  });
  const ring = new THREE.Mesh(ringGeom, ringMat);
  ring.rotation.x = Math.PI / 3;
  group.add(ring);

  const update = (delta: number) => {
    // Gentle cosmic rotation
    points.rotation.y += delta * 0.015;
    ring.rotation.z += delta * 0.008;
  };

  const dispose = () => {
    geometry.dispose();
    material.dispose();
    ringGeom.dispose();
    ringMat.dispose();
  };

  return { group, update, dispose };
}
