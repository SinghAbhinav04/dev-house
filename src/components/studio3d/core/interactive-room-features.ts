import * as THREE from 'three';
import type { TextureCache } from './texture-cache';
import type { AABB } from '../types';

export interface InteractiveRoomFeaturesResult {
  group: THREE.Group;
  lightSwitchMesh: THREE.Mesh;
  acUnitMesh: THREE.Mesh;
  coffeeMachineMesh: THREE.Mesh;
  coffeeCupMesh: THREE.Mesh;
  obstacle: AABB;
  // Interaction positions
  switchPos: THREE.Vector3;
  acPos: THREE.Vector3;
  coffeePos: THREE.Vector3;
  // States & toggles
  readonly isLightsOn: boolean;
  toggleLights: () => boolean;
  setLights: (on: boolean) => void;
  readonly isACOn: boolean;
  toggleAC: () => boolean;
  setAC: (on: boolean) => void;
  readonly hasBrewedCup: boolean;
  brewCoffee: () => { success: boolean; message: string };
  drinkCoffee: () => { success: boolean; buffSeconds: number };
  readonly caffeineTimer: number;
  update: (delta: number) => void;
  dispose: () => void;
}

/**
 * Interactive In-Room Environmental Props:
 * 1. Wall Light Switch: toggles room downlights ON / OFF (mood lighting vs bright studio).
 * 2. Wall AC Unit: modern mini-split AC with louvers, status LED, and cool airflow.
 * 3. Espresso Coffee Bar: brew fresh coffee, drink it, and gain a +40% sprint speed & focus boost!
 */
export function buildInteractiveRoomFeatures(
  textureCache: TextureCache,
  roomLights: THREE.Light[]
): InteractiveRoomFeaturesResult {
  const rootGroup = new THREE.Group();
  rootGroup.name = 'InteractiveRoomFeatures';

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  // --- Warm Studio Materials ---
  const bronzeMat = textureCache.getMaterial('mat:switch_bronze', () =>
    new THREE.MeshStandardMaterial({ color: '#27221d', roughness: 0.35, metalness: 0.7 })
  );
  const wallPlateMat = textureCache.getMaterial('mat:wall_plate', () =>
    new THREE.MeshStandardMaterial({ color: '#1a1613', roughness: 0.6 })
  );
  const acChassisMat = textureCache.getMaterial('mat:ac_chassis', () =>
    new THREE.MeshStandardMaterial({ color: '#1e1b18', roughness: 0.4, metalness: 0.2 })
  );
  const stainlessSteelMat = textureCache.getMaterial('mat:espresso_steel', () =>
    new THREE.MeshStandardMaterial({ color: '#71717a', roughness: 0.2, metalness: 0.9 })
  );
  const woodCounterMat = textureCache.getMaterial('mat:coffee_counter', () =>
    new THREE.MeshStandardMaterial({ color: '#3d2b1f', roughness: 0.5 })
  );
  const ceramicMugMat = textureCache.getMaterial('mat:ceramic_cup', () =>
    new THREE.MeshStandardMaterial({ color: '#f4ece2', roughness: 0.2 })
  );

  // --- 1. Wall Light Switch (Mounted flush on back plaster wall to the right of lift) ---
  const switchGroup = new THREE.Group();
  const switchPos = new THREE.Vector3(2.4, 1.4, -7.38);
  switchGroup.position.copy(switchPos);
  switchGroup.userData = { isLightSwitch: true };

  const plateGeom = new THREE.BoxGeometry(0.18, 0.28, 0.02);
  const rockerGeom = new THREE.BoxGeometry(0.08, 0.12, 0.03);
  geometries.push(plateGeom, rockerGeom);

  const plateMesh = new THREE.Mesh(plateGeom, wallPlateMat);
  switchGroup.add(plateMesh);

  const rockerMesh = new THREE.Mesh(rockerGeom, bronzeMat);
  rockerMesh.position.set(0, 0, 0.015);
  rockerMesh.userData = { isLightSwitch: true };
  switchGroup.add(rockerMesh);

  // Little warm LED status pip on the switch
  const ledGeom = new THREE.SphereGeometry(0.015, 8, 8);
  geometries.push(ledGeom);
  const switchLedMat = new THREE.MeshBasicMaterial({ color: '#8fae60' }); // Green when ON
  materials.push(switchLedMat);
  const switchLed = new THREE.Mesh(ledGeom, switchLedMat);
  switchLed.position.set(0, 0.09, 0.018);
  switchGroup.add(switchLed);

  rootGroup.add(switchGroup);

  // --- 2. Wall-Mounted Air Conditioner (Mini-Split - High on back plaster wall to the left of lift) ---
  const acGroup = new THREE.Group();
  const acPos = new THREE.Vector3(-4.5, 3.3, -7.34);
  acGroup.position.copy(acPos);
  acGroup.userData = { isACUnit: true };

  const acBodyGeom = new THREE.BoxGeometry(1.6, 0.45, 0.32);
  const acLouverGeom = new THREE.BoxGeometry(1.4, 0.06, 0.02);
  geometries.push(acBodyGeom, acLouverGeom);

  const acBody = new THREE.Mesh(acBodyGeom, acChassisMat);
  acBody.userData = { isACUnit: true };
  acGroup.add(acBody);

  const acLouver = new THREE.Mesh(acLouverGeom, bronzeMat);
  acLouver.position.set(0, -0.16, 0.16);
  acLouver.rotation.x = -0.3; // slightly open
  acGroup.add(acLouver);

  // Digital LED temperature display (70°F)
  const acDisplayMat = new THREE.MeshBasicMaterial({ color: '#7fa8a0' }); // Sage cool display
  materials.push(acDisplayMat);
  const acDisplayGeom = new THREE.PlaneGeometry(0.2, 0.08);
  geometries.push(acDisplayGeom);
  const acDisplay = new THREE.Mesh(acDisplayGeom, acDisplayMat);
  acDisplay.position.set(0.5, 0.05, 0.162);
  acGroup.add(acDisplay);

  // Cool Airflow particle points
  const airParticleCount = 28;
  const airGeom = new THREE.BufferGeometry();
  const airPositions = new Float32Array(airParticleCount * 3);
  for (let i = 0; i < airParticleCount; i++) {
    airPositions[i * 3] = (Math.random() - 0.5) * 1.3;
    airPositions[i * 3 + 1] = -0.2 - Math.random() * 1.2;
    airPositions[i * 3 + 2] = 0.2 + Math.random() * 0.8;
  }
  airGeom.setAttribute('position', new THREE.BufferAttribute(airPositions, 3));
  geometries.push(airGeom);

  const airMat = new THREE.PointsMaterial({
    color: '#bae6fd',
    size: 0.06,
    transparent: true,
    opacity: 0.6,
  });
  materials.push(airMat);
  const airParticles = new THREE.Points(airGeom, airMat);
  acGroup.add(airParticles);

  rootGroup.add(acGroup);

  // --- 3. Espresso Coffee Bar & Machine (Positioned against right wall, away from lift path) ---
  const coffeeBarGroup = new THREE.Group();
  const coffeePos = new THREE.Vector3(6.2, 0, -5.2);
  coffeeBarGroup.position.copy(coffeePos);
  coffeeBarGroup.userData = { isCoffeeMachine: true };

  // Countertop
  const counterGeom = new THREE.BoxGeometry(1.6, 0.82, 0.9);
  geometries.push(counterGeom);
  const counter = new THREE.Mesh(counterGeom, woodCounterMat);
  counter.position.y = 0.41;
  counter.castShadow = true;
  counter.receiveShadow = true;
  coffeeBarGroup.add(counter);

  // Espresso Machine Body
  const machineBaseGeom = new THREE.BoxGeometry(0.7, 0.45, 0.5);
  const groupHeadGeom = new THREE.CylinderGeometry(0.04, 0.05, 0.1, 8);
  const portafilterGeom = new THREE.CylinderGeometry(0.015, 0.015, 0.2, 6);
  geometries.push(machineBaseGeom, groupHeadGeom, portafilterGeom);

  const machineBody = new THREE.Mesh(machineBaseGeom, stainlessSteelMat);
  machineBody.position.set(0, 0.82 + 0.225, 0);
  machineBody.userData = { isCoffeeMachine: true };
  coffeeBarGroup.add(machineBody);

  // 2 Dual Group Heads
  [-0.14, 0.14].forEach((gx) => {
    const head = new THREE.Mesh(groupHeadGeom, bronzeMat);
    head.position.set(gx, 0.95, 0.22);
    coffeeBarGroup.add(head);

    const handle = new THREE.Mesh(portafilterGeom, bronzeMat);
    handle.rotation.x = Math.PI / 2;
    handle.position.set(gx, 0.92, 0.32);
    coffeeBarGroup.add(handle);
  });

  // Pressure Gauge
  const gaugeGeom = new THREE.CircleGeometry(0.04, 12);
  geometries.push(gaugeGeom);
  const gaugeMat = new THREE.MeshBasicMaterial({ color: '#fef08a' });
  materials.push(gaugeMat);
  const gauge = new THREE.Mesh(gaugeGeom, gaugeMat);
  gauge.position.set(0, 1.18, 0.252);
  coffeeBarGroup.add(gauge);

  // Fresh Steaming Cup of Espresso on the tray
  const cupGeom = new THREE.CylinderGeometry(0.05, 0.04, 0.08, 8);
  geometries.push(cupGeom);
  const cupMesh = new THREE.Mesh(cupGeom, ceramicMugMat);
  cupMesh.position.set(-0.14, 0.82 + 0.04, 0.22);
  cupMesh.userData = { isCoffeeCup: true };
  coffeeBarGroup.add(cupMesh);

  // Rising Steam Particles from cup
  const steamCount = 14;
  const steamGeom = new THREE.BufferGeometry();
  const steamPosArr = new Float32Array(steamCount * 3);
  for (let i = 0; i < steamCount; i++) {
    steamPosArr[i * 3] = -0.14 + (Math.random() - 0.5) * 0.06;
    steamPosArr[i * 3 + 1] = 0.9 + Math.random() * 0.35;
    steamPosArr[i * 3 + 2] = 0.22 + (Math.random() - 0.5) * 0.06;
  }
  steamGeom.setAttribute('position', new THREE.BufferAttribute(steamPosArr, 3));
  geometries.push(steamGeom);

  const steamMat = new THREE.PointsMaterial({
    color: '#f4ece2',
    size: 0.04,
    transparent: true,
    opacity: 0.45,
  });
  materials.push(steamMat);
  const steamParticles = new THREE.Points(steamGeom, steamMat);
  coffeeBarGroup.add(steamParticles);

  rootGroup.add(coffeeBarGroup);

  // --- Environmental States ---
  let isLightsOn = true;
  let isACOn = true;
  let hasBrewedCup = true;
  let caffeineTimer = 0; // seconds remaining on sprint & focus buff

  // Set all lights to bright studio intensity initially
  roomLights.forEach((light) => {
    const onVal = (light.userData?.onIntensity as number) ?? 3.0;
    light.intensity = onVal;
  });

  const toggleLights = (): boolean => {
    isLightsOn = !isLightsOn;
    roomLights.forEach((light) => {
      const onVal = (light.userData?.onIntensity as number) ?? 3.0;
      const offVal = (light.userData?.offIntensity as number) ?? 0.25;
      light.intensity = isLightsOn ? onVal : offVal;
    });
    switchLedMat.color.set(isLightsOn ? '#8fae60' : '#cf6c5a');
    rockerMesh.rotation.x = isLightsOn ? 0.1 : -0.1;
    return isLightsOn;
  };

  const setLights = (on: boolean) => {
    isLightsOn = on;
    roomLights.forEach((light) => {
      const onVal = (light.userData?.onIntensity as number) ?? 3.0;
      const offVal = (light.userData?.offIntensity as number) ?? 0.25;
      light.intensity = isLightsOn ? onVal : offVal;
    });
    switchLedMat.color.set(isLightsOn ? '#8fae60' : '#cf6c5a');
    rockerMesh.rotation.x = isLightsOn ? 0.1 : -0.1;
  };

  const toggleAC = (): boolean => {
    isACOn = !isACOn;
    acLouver.rotation.x = isACOn ? -0.3 : 0;
    acDisplayMat.color.set(isACOn ? '#7fa8a0' : '#4a3f35');
    airParticles.visible = isACOn;
    return isACOn;
  };

  const setAC = (on: boolean) => {
    isACOn = on;
    acLouver.rotation.x = isACOn ? -0.3 : 0;
    acDisplayMat.color.set(isACOn ? '#7fa8a0' : '#4a3f35');
    airParticles.visible = isACOn;
  };

  const brewCoffee = (): { success: boolean; message: string } => {
    hasBrewedCup = true;
    cupMesh.visible = true;
    steamParticles.visible = true;
    return {
      success: true,
      message: 'Fresh espresso brewed. Press E on the cup to drink it.',
    };
  };

  const drinkCoffee = (): { success: boolean; buffSeconds: number } => {
    if (!hasBrewedCup) {
      return { success: false, buffSeconds: 0 };
    }
    hasBrewedCup = false;
    cupMesh.visible = false;
    steamParticles.visible = false;
    caffeineTimer = 45; // 45 seconds of +40% speed boost
    return { success: true, buffSeconds: 45 };
  };

  // Animation Loop for Airflow & Coffee Steam
  const update = (delta: number) => {
    // Countdown caffeine buff
    if (caffeineTimer > 0) {
      caffeineTimer = Math.max(0, caffeineTimer - delta);
    }

    // Animate AC airflow particles
    if (isACOn && airParticles.visible) {
      const posAttr = airGeom.attributes.position as THREE.BufferAttribute;
      const arr = posAttr.array as Float32Array;
      for (let i = 0; i < airParticleCount; i++) {
        arr[i * 3 + 1] -= delta * 0.9; // move downward
        arr[i * 3 + 2] += delta * 0.5; // push outward
        if (arr[i * 3 + 1] < -1.8) {
          arr[i * 3 + 1] = -0.2;
          arr[i * 3 + 2] = 0.2;
        }
      }
      posAttr.needsUpdate = true;
    }

    // Animate Coffee Steam
    if (hasBrewedCup && steamParticles.visible) {
      const steamAttr = steamGeom.attributes.position as THREE.BufferAttribute;
      const arr = steamAttr.array as Float32Array;
      for (let i = 0; i < steamCount; i++) {
        arr[i * 3 + 1] += delta * 0.25; // drift upward
        arr[i * 3] += (Math.random() - 0.5) * delta * 0.04;
        if (arr[i * 3 + 1] > 1.35) {
          arr[i * 3 + 1] = 0.9;
          arr[i * 3] = -0.14 + (Math.random() - 0.5) * 0.04;
        }
      }
      steamAttr.needsUpdate = true;
    }
  };

  const dispose = () => {
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
  };

  return {
    group: rootGroup,
    lightSwitchMesh: rockerMesh,
    acUnitMesh: acBody,
    coffeeMachineMesh: machineBody,
    coffeeCupMesh: cupMesh,
    obstacle: { minX: 5.5, maxX: 6.9, minZ: -5.55, maxZ: -4.85, label: 'Espresso Coffee Bar' },
    switchPos,
    acPos,
    coffeePos,
    get isLightsOn() { return isLightsOn; },
    toggleLights,
    setLights,
    get isACOn() { return isACOn; },
    toggleAC,
    setAC,
    get hasBrewedCup() { return hasBrewedCup; },
    brewCoffee,
    drinkCoffee,
    get caffeineTimer() { return caffeineTimer; },
    update,
    dispose,
  };
}
