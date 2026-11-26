import * as THREE from 'three';

export type HairStyle = 'bun' | 'beanie' | 'short' | 'cap' | 'curly';

export interface StylizedCharacterOptions {
  name: string;
  roleColor: string;
  hairStyle?: HairStyle;
  isSeated?: boolean;
  scale?: number;
  hasHeadphones?: boolean;
}

export type CharacterGesture = 'none' | 'write' | 'talk';

export interface StylizedCharacterResult {
  group: THREE.Group;
  update: (delta: number, isMoving: boolean, isTyping: boolean) => void;
  setFacingAngle: (rad: number) => void;
  /** Sit down at a desk or stand up from it; the pose changes in place. */
  setSeated: (seated: boolean) => void;
  /** What a standing character does with their arms while idle. */
  setGesture: (gesture: CharacterGesture) => void;
  setColor: (color: string) => void;
  dispose: () => void;
}

/**
 * High-fidelity stylized 3D character generator.
 * Creates charming low-poly developer avatars with hair styles (like the hair bun in the video!),
 * headphones with glowing LED rings, rounded hoodies, and articulated limbs for walking & typing.
 */
export function createStylizedCharacter(options: StylizedCharacterOptions): StylizedCharacterResult {
  const {
    name,
    roleColor,
    hairStyle = 'short',
    isSeated: seatedAtStart = false,
    scale = 1.0,
    hasHeadphones = true,
  } = options;

  const rootGroup = new THREE.Group();
  rootGroup.name = `StylizedChar_${name}`;
  rootGroup.scale.set(scale, scale, scale);

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  // --- Palettes ---
  const skinMat = new THREE.MeshStandardMaterial({
    color: '#f5cda7',
    roughness: 0.5,
    metalness: 0.05,
  });
  const hairMat = new THREE.MeshStandardMaterial({
    color: hairStyle === 'bun' ? '#3d261a' : hairStyle === 'cap' ? '#0f172a' : '#261914',
    roughness: 0.8,
  });
  const hoodieMat = new THREE.MeshStandardMaterial({
    color: roleColor,
    roughness: 0.55,
    metalness: 0.1,
  });
  const pantsMat = new THREE.MeshStandardMaterial({
    color: '#1e293b',
    roughness: 0.7,
  });
  const shoesMat = new THREE.MeshStandardMaterial({
    color: '#f8fafc', // crisp white sneakers
    roughness: 0.4,
  });
  const headphoneMat = new THREE.MeshStandardMaterial({
    color: '#18181b',
    metalness: 0.85,
    roughness: 0.25,
  });
  const ledGlowMat = new THREE.MeshBasicMaterial({
    color: roleColor,
  });

  materials.push(skinMat, hairMat, hoodieMat, pantsMat, shoesMat, headphoneMat, ledGlowMat);

  // --- 1. Torso / Hoodie ---
  const torsoH = 0.55;
  const torsoGeom = new THREE.CylinderGeometry(0.24, 0.28, torsoH, 12);
  torsoGeom.scale(1.2, 1, 0.8); // Oval chest
  geometries.push(torsoGeom);

  const torso = new THREE.Mesh(torsoGeom, hoodieMat);
  torso.position.y = seatedAtStart ? 0.72 : 0.92;
  torso.castShadow = true;
  torso.receiveShadow = true;
  rootGroup.add(torso);

  // Hoodie collar / hood rim
  const collarGeom = new THREE.TorusGeometry(0.22, 0.06, 8, 16);
  geometries.push(collarGeom);
  const collar = new THREE.Mesh(collarGeom, hoodieMat);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = seatedAtStart ? 0.98 : 1.18;
  rootGroup.add(collar);

  // --- 2. Head & Hair ---
  const headGroup = new THREE.Group();
  headGroup.position.set(0, seatedAtStart ? 1.25 : 1.45, 0);

  const headGeom = new THREE.SphereGeometry(0.24, 16, 14);
  headGeom.scale(1, 1.08, 0.95);
  geometries.push(headGeom);
  const head = new THREE.Mesh(headGeom, skinMat);
  head.castShadow = true;
  headGroup.add(head);

  // Stylized Eyes
  const eyeGeom = new THREE.SphereGeometry(0.032, 8, 8);
  geometries.push(eyeGeom);
  const eyeMat = new THREE.MeshBasicMaterial({ color: '#0f172a' });
  materials.push(eyeMat);

  [-0.08, 0.08].forEach((ex) => {
    const eye = new THREE.Mesh(eyeGeom, eyeMat);
    eye.position.set(ex, 0.02, 0.21);
    headGroup.add(eye);
  });

  // Hair Styling
  if (hairStyle === 'bun') {
    // Hair cap
    const hairCapGeom = new THREE.SphereGeometry(0.25, 14, 12, 0, Math.PI * 2, 0, Math.PI / 1.7);
    geometries.push(hairCapGeom);
    const hairCap = new THREE.Mesh(hairCapGeom, hairMat);
    hairCap.position.y = 0.04;
    headGroup.add(hairCap);

    // Cute high hair bun (like the girl in the video!)
    const bunGeom = new THREE.SphereGeometry(0.12, 12, 10);
    geometries.push(bunGeom);
    const bun = new THREE.Mesh(bunGeom, hairMat);
    bun.position.set(0, 0.28, -0.06);
    headGroup.add(bun);
  } else if (hairStyle === 'cap') {
    // Backward baseball cap
    const capGeom = new THREE.SphereGeometry(0.25, 14, 12, 0, Math.PI * 2, 0, Math.PI / 1.8);
    geometries.push(capGeom);
    const cap = new THREE.Mesh(capGeom, hairMat);
    cap.position.y = 0.05;
    headGroup.add(cap);

    const brimGeom = new THREE.CylinderGeometry(0.18, 0.2, 0.02, 12, 1, false, Math.PI * 0.7, Math.PI * 0.6);
    geometries.push(brimGeom);
    const brim = new THREE.Mesh(brimGeom, hairMat);
    brim.rotation.x = Math.PI / 1.2;
    brim.position.set(0, 0.08, -0.2);
    headGroup.add(brim);
  } else if (hairStyle === 'beanie') {
    // Cozy winter beanie
    const beanieGeom = new THREE.CylinderGeometry(0.22, 0.26, 0.25, 14);
    geometries.push(beanieGeom);
    const beanie = new THREE.Mesh(beanieGeom, hairMat);
    beanie.position.y = 0.16;
    headGroup.add(beanie);
  } else {
    // Modern styled short hair
    const hairCapGeom = new THREE.SphereGeometry(0.25, 14, 12, 0, Math.PI * 2, 0, Math.PI / 1.7);
    geometries.push(hairCapGeom);
    const hairCap = new THREE.Mesh(hairCapGeom, hairMat);
    hairCap.position.y = 0.05;
    headGroup.add(hairCap);

    const fringeGeom = new THREE.BoxGeometry(0.18, 0.08, 0.08);
    geometries.push(fringeGeom);
    const fringe = new THREE.Mesh(fringeGeom, hairMat);
    fringe.position.set(0, 0.16, 0.2);
    headGroup.add(fringe);
  }

  // Developer Headphones with glowing LED rings
  if (hasHeadphones) {
    const bandGeom = new THREE.TorusGeometry(0.23, 0.022, 8, 16, Math.PI);
    geometries.push(bandGeom);
    const band = new THREE.Mesh(bandGeom, headphoneMat);
    band.rotation.x = Math.PI / 2;
    band.position.y = 0.12;
    headGroup.add(band);

    const earCupGeom = new THREE.CylinderGeometry(0.075, 0.075, 0.06, 14);
    geometries.push(earCupGeom);
    const ledGeom = new THREE.CylinderGeometry(0.035, 0.035, 0.062, 10);
    geometries.push(ledGeom);

    [-0.22, 0.22].forEach((hx) => {
      const earCup = new THREE.Mesh(earCupGeom, headphoneMat);
      earCup.rotation.z = Math.PI / 2;
      earCup.position.set(hx, 0.02, 0);
      headGroup.add(earCup);

      const led = new THREE.Mesh(ledGeom, ledGlowMat);
      led.rotation.z = Math.PI / 2;
      led.position.set(hx, 0.02, 0);
      headGroup.add(led);
    });
  }

  rootGroup.add(headGroup);

  // --- 3. Arms & Hands ---
  const upperArmGeom = new THREE.CylinderGeometry(0.06, 0.055, 0.26, 8);
  const foreArmGeom = new THREE.CylinderGeometry(0.055, 0.05, 0.24, 8);
  const handSphereGeom = new THREE.SphereGeometry(0.06, 8, 8);
  geometries.push(upperArmGeom, foreArmGeom, handSphereGeom);

  // Left Arm (Shoulder Pivot)
  const leftShoulder = new THREE.Group();
  leftShoulder.position.set(-0.32, seatedAtStart ? 0.94 : 1.14, 0);
  const leftUpper = new THREE.Mesh(upperArmGeom, hoodieMat);
  leftUpper.position.y = -0.12;
  leftUpper.castShadow = true;
  leftShoulder.add(leftUpper);

  const leftElbow = new THREE.Group();
  leftElbow.position.set(0, -0.24, 0);
  const leftFore = new THREE.Mesh(foreArmGeom, hoodieMat);
  leftFore.position.y = -0.11;
  leftFore.castShadow = true;
  leftElbow.add(leftFore);
  const leftHand = new THREE.Mesh(handSphereGeom, skinMat);
  leftHand.position.y = -0.23;
  leftElbow.add(leftHand);
  leftShoulder.add(leftElbow);
  rootGroup.add(leftShoulder);

  // Right Arm (Shoulder Pivot)
  const rightShoulder = new THREE.Group();
  rightShoulder.position.set(0.32, seatedAtStart ? 0.94 : 1.14, 0);
  const rightUpper = new THREE.Mesh(upperArmGeom, hoodieMat);
  rightUpper.position.y = -0.12;
  rightUpper.castShadow = true;
  rightShoulder.add(rightUpper);

  const rightElbow = new THREE.Group();
  rightElbow.position.set(0, -0.24, 0);
  const rightFore = new THREE.Mesh(foreArmGeom, hoodieMat);
  rightFore.position.y = -0.11;
  rightFore.castShadow = true;
  rightElbow.add(rightFore);
  const rightHand = new THREE.Mesh(handSphereGeom, skinMat);
  rightHand.position.y = -0.23;
  rightElbow.add(rightHand);
  rightShoulder.add(rightElbow);
  rootGroup.add(rightShoulder);

  // --- 4. Legs & Sneakers ---
  const thighGeom = new THREE.CylinderGeometry(0.09, 0.08, 0.32, 8);
  const calfGeom = new THREE.CylinderGeometry(0.08, 0.07, 0.3, 8);
  const sneakerGeom = new THREE.BoxGeometry(0.15, 0.1, 0.25);
  geometries.push(thighGeom, calfGeom, sneakerGeom);

  // Left Leg (Hip Pivot)
  const leftHip = new THREE.Group();
  leftHip.position.set(-0.14, seatedAtStart ? 0.46 : 0.64, 0);
  const leftThigh = new THREE.Mesh(thighGeom, pantsMat);
  leftThigh.position.y = -0.15;
  leftThigh.castShadow = true;
  leftHip.add(leftThigh);

  const leftKnee = new THREE.Group();
  leftKnee.position.set(0, -0.3, 0);
  const leftCalf = new THREE.Mesh(calfGeom, pantsMat);
  leftCalf.position.y = -0.14;
  leftCalf.castShadow = true;
  leftKnee.add(leftCalf);
  const leftSneaker = new THREE.Mesh(sneakerGeom, shoesMat);
  leftSneaker.position.set(0, -0.28, 0.05);
  leftSneaker.castShadow = true;
  leftKnee.add(leftSneaker);
  leftHip.add(leftKnee);
  rootGroup.add(leftHip);

  // Right Leg (Hip Pivot)
  const rightHip = new THREE.Group();
  rightHip.position.set(0.14, seatedAtStart ? 0.46 : 0.64, 0);
  const rightThigh = new THREE.Mesh(thighGeom, pantsMat);
  rightThigh.position.y = -0.15;
  rightThigh.castShadow = true;
  rightHip.add(rightThigh);

  const rightKnee = new THREE.Group();
  rightKnee.position.set(0, -0.3, 0);
  const rightCalf = new THREE.Mesh(calfGeom, pantsMat);
  rightCalf.position.y = -0.14;
  rightCalf.castShadow = true;
  rightKnee.add(rightCalf);
  const rightSneaker = new THREE.Mesh(sneakerGeom, shoesMat);
  rightSneaker.position.set(0, -0.28, 0.05);
  rightSneaker.castShadow = true;
  rightKnee.add(rightSneaker);
  rightHip.add(rightKnee);
  rootGroup.add(rightHip);

  let isSeated = seatedAtStart;
  let gesture: CharacterGesture = 'none';

  /** Puts every joint in the seated pose: thighs forward, hands on the keyboard. */
  const applySeatedPose = () => {
    // Thighs forward
    leftHip.rotation.x = -Math.PI / 2;
    rightHip.rotation.x = -Math.PI / 2;
    // Calves down at 90 deg
    leftKnee.rotation.x = Math.PI / 2;
    rightKnee.rotation.x = Math.PI / 2;

    // Shoulders forward
    leftShoulder.rotation.x = -Math.PI / 3.2;
    rightShoulder.rotation.x = -Math.PI / 3.2;
    leftShoulder.rotation.y = 0.2;
    rightShoulder.rotation.y = -0.2;

    // Elbows bent forward resting hands on keyboard
    leftElbow.rotation.x = -Math.PI / 3.8;
    rightElbow.rotation.x = -Math.PI / 3.8;
  };

  /** Straight legs and loose arms, at standing height. */
  const applyStandingPose = () => {
    leftHip.rotation.set(0, 0, 0);
    rightHip.rotation.set(0, 0, 0);
    leftKnee.rotation.set(0, 0, 0);
    rightKnee.rotation.set(0, 0, 0);
    leftShoulder.rotation.set(0, 0, 0);
    rightShoulder.rotation.set(0, 0, 0);
    leftElbow.rotation.set(0, 0, 0);
    rightElbow.rotation.set(0, 0, 0);
    headGroup.rotation.set(0, 0, 0);
    torso.rotation.set(0, 0, 0);
  };

  const setHeights = (seated: boolean) => {
    const drop = seated ? -0.2 : 0;
    torso.position.y = 0.92 + drop;
    collar.position.y = 1.18 + drop;
    headGroup.position.y = 1.45 + drop;
    leftShoulder.position.y = 1.14 + drop;
    rightShoulder.position.y = 1.14 + drop;
    leftHip.position.y = seated ? 0.46 : 0.64;
    rightHip.position.y = seated ? 0.46 : 0.64;
  };

  if (isSeated) applySeatedPose();

  const setSeated = (seated: boolean) => {
    if (seated === isSeated) return;
    isSeated = seated;
    gesture = 'none';
    setHeights(seated);
    if (seated) applySeatedPose();
    else applyStandingPose();
  };

  const setGesture = (next: CharacterGesture) => {
    if (next === gesture) return;
    gesture = next;
    if (next === 'none') {
      rightShoulder.rotation.set(0, 0, 0);
      rightElbow.rotation.set(0, 0, 0);
      leftShoulder.rotation.set(0, 0, 0);
      leftElbow.rotation.set(0, 0, 0);
    }
  };

  let walkCycle = 0;
  let typingCycle = 0;

  /**
   * Fluid procedural animations:
   * - Seated: independent dual-hand keyboard typing with head nodding
   * - Moving: natural stride cycle with hip swaying and arm counter-balancing
   */
  const update = (delta: number, isMoving: boolean, isTyping: boolean) => {
    if (isSeated) {
      if (isTyping) {
        typingCycle += delta * 16;
        // Dual-hand alternate typing rhythm
        leftElbow.rotation.x = -Math.PI / 3.8 + Math.sin(typingCycle) * 0.12;
        rightElbow.rotation.x = -Math.PI / 3.8 + Math.cos(typingCycle * 1.3) * 0.12;
        leftShoulder.rotation.z = -0.1 + Math.sin(typingCycle * 0.5) * 0.04;
        rightShoulder.rotation.z = 0.1 - Math.cos(typingCycle * 0.5) * 0.04;
        headGroup.rotation.x = 0.08 + Math.sin(typingCycle * 0.4) * 0.03;
      } else {
        // Idle breathing at desk
        typingCycle += delta * 2.2;
        torso.position.y = 0.72 + Math.sin(typingCycle) * 0.012;
        headGroup.position.y = 1.25 + Math.sin(typingCycle) * 0.012;
        leftShoulder.rotation.x = -Math.PI / 3.2 + Math.sin(typingCycle) * 0.02;
        rightShoulder.rotation.x = -Math.PI / 3.2 + Math.sin(typingCycle) * 0.02;
      }
    } else {
      if (isMoving) {
        walkCycle += delta * 12;
        const hipSwing = Math.sin(walkCycle) * 0.55;
        const kneeBend = Math.max(0, Math.sin(walkCycle + Math.PI / 2)) * 0.5;
        const armSwing = Math.cos(walkCycle) * 0.5;

        leftHip.rotation.x = hipSwing;
        rightHip.rotation.x = -hipSwing;
        leftKnee.rotation.x = hipSwing > 0 ? kneeBend : 0;
        rightKnee.rotation.x = -hipSwing > 0 ? kneeBend : 0;

        leftShoulder.rotation.x = -armSwing;
        rightShoulder.rotation.x = armSwing;
        leftElbow.rotation.x = 0;
        rightElbow.rotation.x = 0;

        // Subtle torso bounce & hip sway
        torso.position.y = 0.92 + Math.abs(Math.sin(walkCycle)) * 0.035;
        headGroup.position.y = 1.45 + Math.abs(Math.sin(walkCycle)) * 0.035;
        torso.rotation.z = Math.sin(walkCycle) * 0.03;
      } else {
        // Stand idle breathing
        walkCycle += delta * 2.0;
        leftHip.rotation.x = 0;
        rightHip.rotation.x = 0;
        leftKnee.rotation.x = 0;
        rightKnee.rotation.x = 0;
        torso.rotation.z = 0;
        torso.position.y = 0.92 + Math.sin(walkCycle) * 0.01;
        headGroup.position.y = 1.45 + Math.sin(walkCycle) * 0.01;
        if (gesture === 'write') {
          // Right arm up at the board, small strokes; left arm at rest.
          rightShoulder.rotation.x = -2.1 + Math.sin(walkCycle * 6) * 0.08;
          rightShoulder.rotation.z = 0.15 + Math.cos(walkCycle * 4.5) * 0.06;
          rightElbow.rotation.x = -0.35;
          leftShoulder.rotation.x = 0;
          headGroup.rotation.x = -0.12;
        } else if (gesture === 'talk') {
          // Hands moving as they explain, head nodding along.
          leftShoulder.rotation.x = -0.45 + Math.sin(walkCycle * 3) * 0.12;
          rightShoulder.rotation.x = -0.35 + Math.cos(walkCycle * 2.6) * 0.14;
          leftElbow.rotation.x = -0.9;
          rightElbow.rotation.x = -0.8;
          headGroup.rotation.x = Math.sin(walkCycle * 2.2) * 0.05;
        } else {
          leftShoulder.rotation.x = 0;
          rightShoulder.rotation.x = 0;
          headGroup.rotation.x = 0;
        }
      }
    }
  };

  const setFacingAngle = (rad: number) => {
    rootGroup.rotation.y = rad;
  };

  const setColor = (newColor: string) => {
    hoodieMat.color.set(newColor);
    ledGlowMat.color.set(newColor);
  };

  const dispose = () => {
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
  };

  return {
    group: rootGroup,
    update,
    setFacingAngle,
    setSeated,
    setGesture,
    setColor,
    dispose,
  };
}
