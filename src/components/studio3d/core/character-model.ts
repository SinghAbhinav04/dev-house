import * as THREE from 'three';

export interface CharacterModelOptions {
  name: string;
  roleColor: string;
  isSeated?: boolean;
  scale?: number;
  hasHeadphones?: boolean;
}

export interface CharacterModelResult {
  group: THREE.Group;
  update: (delta: number, isMoving: boolean, isTyping: boolean) => void;
  setFacingAngle: (rad: number) => void;
  setColor: (color: string) => void;
  dispose: () => void;
}

/**
 * Creates a stylized 3D low-poly humanoid developer character model.
 * Features customizable hoodie colors, headphones, and articulated limbs
 * for walking (player) or desk typing (team devs).
 */
export function createCharacterModel(options: CharacterModelOptions): CharacterModelResult {
  const {
    name,
    roleColor,
    isSeated = false,
    scale = 1.0,
    hasHeadphones = true,
  } = options;

  const rootGroup = new THREE.Group();
  rootGroup.name = `Char_${name}`;
  rootGroup.scale.set(scale, scale, scale);

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  // --- Materials ---
  const skinMat = new THREE.MeshStandardMaterial({
    color: '#e2b896',
    roughness: 0.6,
  });
  const hairMat = new THREE.MeshStandardMaterial({
    color: '#261c16',
    roughness: 0.8,
  });
  const hoodieMat = new THREE.MeshStandardMaterial({
    color: roleColor,
    roughness: 0.7,
  });
  const pantsMat = new THREE.MeshStandardMaterial({
    color: '#1e293b', // dark navy pants
    roughness: 0.8,
  });
  const shoesMat = new THREE.MeshStandardMaterial({
    color: '#0f172a',
    roughness: 0.5,
  });
  const headphoneMat = new THREE.MeshStandardMaterial({
    color: '#09090b',
    metalness: 0.8,
    roughness: 0.2,
  });
  const ledGlowMat = new THREE.MeshBasicMaterial({
    color: roleColor,
  });

  materials.push(skinMat, hairMat, hoodieMat, pantsMat, shoesMat, headphoneMat, ledGlowMat);

  // --- 1. Torso / Hoodie ---
  const torsoGeom = new THREE.BoxGeometry(0.5, 0.6, 0.3);
  geometries.push(torsoGeom);
  const torso = new THREE.Mesh(torsoGeom, hoodieMat);
  torso.position.y = isSeated ? 0.75 : 0.95;
  torso.castShadow = true;
  rootGroup.add(torso);

  // --- 2. Head & Hair ---
  const headGroup = new THREE.Group();
  headGroup.position.set(0, isSeated ? 1.25 : 1.45, 0);

  const headGeom = new THREE.BoxGeometry(0.32, 0.34, 0.32);
  geometries.push(headGeom);
  const head = new THREE.Mesh(headGeom, skinMat);
  head.castShadow = true;
  headGroup.add(head);

  // Hair / Beanie
  const hairGeom = new THREE.BoxGeometry(0.34, 0.14, 0.34);
  geometries.push(hairGeom);
  const hair = new THREE.Mesh(hairGeom, hairMat);
  hair.position.y = 0.14;
  headGroup.add(hair);

  // Over-ear developer headphones
  if (hasHeadphones) {
    const bandGeom = new THREE.TorusGeometry(0.2, 0.025, 8, 16, Math.PI);
    geometries.push(bandGeom);
    const band = new THREE.Mesh(bandGeom, headphoneMat);
    band.rotation.x = Math.PI / 2;
    band.position.y = 0.16;
    headGroup.add(band);

    const earCupGeom = new THREE.CylinderGeometry(0.065, 0.065, 0.05, 12);
    geometries.push(earCupGeom);

    [-0.18, 0.18].forEach((hx) => {
      const earCup = new THREE.Mesh(earCupGeom, headphoneMat);
      earCup.rotation.z = Math.PI / 2;
      earCup.position.set(hx, 0.02, 0);
      headGroup.add(earCup);

      // Glowing LED ring on earcups
      const ledGeom = new THREE.CylinderGeometry(0.03, 0.03, 0.052, 8);
      geometries.push(ledGeom);
      const led = new THREE.Mesh(ledGeom, ledGlowMat);
      led.rotation.z = Math.PI / 2;
      led.position.set(hx, 0.02, 0);
      headGroup.add(led);
    });
  }

  rootGroup.add(headGroup);

  // --- 3. Arms & Hands ---
  const armGeom = new THREE.BoxGeometry(0.12, 0.45, 0.12);
  const handGeom = new THREE.BoxGeometry(0.1, 0.1, 0.1);
  geometries.push(armGeom, handGeom);

  // Left Arm Group (pivot at shoulder)
  const leftArm = new THREE.Group();
  leftArm.position.set(-0.32, isSeated ? 0.98 : 1.18, 0);
  const leftArmMesh = new THREE.Mesh(armGeom, hoodieMat);
  leftArmMesh.position.y = -0.2;
  leftArmMesh.castShadow = true;
  leftArm.add(leftArmMesh);
  const leftHand = new THREE.Mesh(handGeom, skinMat);
  leftHand.position.y = -0.44;
  leftArm.add(leftHand);
  rootGroup.add(leftArm);

  // Right Arm Group (pivot at shoulder)
  const rightArm = new THREE.Group();
  rightArm.position.set(0.32, isSeated ? 0.98 : 1.18, 0);
  const rightArmMesh = new THREE.Mesh(armGeom, hoodieMat);
  rightArmMesh.position.y = -0.2;
  rightArmMesh.castShadow = true;
  rightArm.add(rightArmMesh);
  const rightHand = new THREE.Mesh(handGeom, skinMat);
  rightHand.position.y = -0.44;
  rightArm.add(rightHand);
  rootGroup.add(rightArm);

  // --- 4. Legs & Shoes ---
  const legGeom = new THREE.BoxGeometry(0.16, 0.55, 0.16);
  const shoeGeom = new THREE.BoxGeometry(0.17, 0.12, 0.24);
  geometries.push(legGeom, shoeGeom);

  // Left Leg
  const leftLeg = new THREE.Group();
  leftLeg.position.set(-0.14, isSeated ? 0.45 : 0.65, 0);
  const leftLegMesh = new THREE.Mesh(legGeom, pantsMat);
  leftLegMesh.position.y = -0.25;
  leftLegMesh.castShadow = true;
  leftLeg.add(leftLegMesh);
  const leftShoe = new THREE.Mesh(shoeGeom, shoesMat);
  leftShoe.position.set(0, -0.52, 0.04);
  leftShoe.castShadow = true;
  leftLeg.add(leftShoe);
  rootGroup.add(leftLeg);

  // Right Leg
  const rightLeg = new THREE.Group();
  rightLeg.position.set(0.14, isSeated ? 0.45 : 0.65, 0);
  const rightLegMesh = new THREE.Mesh(legGeom, pantsMat);
  rightLegMesh.position.y = -0.25;
  rightLegMesh.castShadow = true;
  rightLeg.add(rightLegMesh);
  const rightShoe = new THREE.Mesh(shoeGeom, shoesMat);
  rightShoe.position.set(0, -0.52, 0.04);
  rightShoe.castShadow = true;
  rightLeg.add(rightShoe);
  rootGroup.add(rightLeg);

  // --- Initial Pose Setup ---
  if (isSeated) {
    // Seated pose: thighs forward at 90 deg, calves down at 90 deg
    leftLeg.rotation.x = -Math.PI / 2.2;
    rightLeg.rotation.x = -Math.PI / 2.2;
    leftLeg.position.z = 0.15;
    rightLeg.position.z = 0.15;

    // Arms resting on desk forward towards keyboard
    leftArm.rotation.x = -Math.PI / 2.8;
    rightArm.rotation.x = -Math.PI / 2.8;
    leftArm.rotation.z = -0.15;
    rightArm.rotation.z = 0.15;
  }

  let walkCycle = 0;
  let typeCycle = 0;

  /**
   * Updates limb animations (walk stride for player, typing for seated devs).
   */
  const update = (delta: number, isMoving: boolean, isTyping: boolean) => {
    if (isSeated) {
      // Typing animation at desk
      if (isTyping) {
        typeCycle += delta * 14;
        leftArm.rotation.x = -Math.PI / 2.8 + Math.sin(typeCycle) * 0.12;
        rightArm.rotation.x = -Math.PI / 2.8 + Math.cos(typeCycle * 1.2) * 0.12;
        headGroup.rotation.x = Math.sin(typeCycle * 0.5) * 0.04;
      } else {
        // Idle breathing at desk
        typeCycle += delta * 2;
        torso.position.y = 0.75 + Math.sin(typeCycle) * 0.015;
        headGroup.position.y = 1.25 + Math.sin(typeCycle) * 0.015;
      }
    } else {
      // Walking / running stride cycle for player
      if (isMoving) {
        walkCycle += delta * 11;
        const legSwing = Math.sin(walkCycle) * 0.65;
        const armSwing = Math.cos(walkCycle) * 0.6;

        leftLeg.rotation.x = legSwing;
        rightLeg.rotation.x = -legSwing;
        leftArm.rotation.x = -armSwing;
        rightArm.rotation.x = armSwing;

        // Subtle torso bob
        torso.position.y = 0.95 + Math.abs(Math.sin(walkCycle)) * 0.04;
        headGroup.position.y = 1.45 + Math.abs(Math.sin(walkCycle)) * 0.04;
      } else {
        // Reset to standing idle
        leftLeg.rotation.x = 0;
        rightLeg.rotation.x = 0;
        leftArm.rotation.x = 0;
        rightArm.rotation.x = 0;
        torso.position.y = 0.95;
        headGroup.position.y = 1.45;
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
    setColor,
    dispose,
  };
}
