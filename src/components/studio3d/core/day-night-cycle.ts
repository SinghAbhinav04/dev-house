import * as THREE from 'three';

export type TimeOfDayMode = 'day' | 'sunset' | 'night';

export interface DayNightCycleResult {
  sunLight: THREE.DirectionalLight;
  moonLight: THREE.DirectionalLight;
  hemiLight: THREE.HemisphereLight;
  ambientLight: THREE.AmbientLight;
  mode: TimeOfDayMode;
  setTimeMode: (mode: TimeOfDayMode) => void;
  update: (delta: number, scene: THREE.Scene, cameraRigDist: number) => void;
  isNight: boolean;
  dispose: () => void;
}

/**
 * Day/Night Lighting and Atmosphere Manager.
 * Orchestrates sun/moon trajectories, sky color gradients, soft PBR shadows,
 * and seamless atmospheric transitions for Day, Golden Sunset, and Midnight.
 */
export function createDayNightCycle(): DayNightCycleResult {
  let mode: TimeOfDayMode = 'day';
  let targetProgress = 0.0; // 0.0 = Day, 0.5 = Sunset, 1.0 = Night
  let currentProgress = 0.0;

  // 1. Sun Directional Light (Dominant during Day & Sunset - Optimized 1024x1024 for high framerate)
  const sunLight = new THREE.DirectionalLight('#fff8ee', 1.8);
  sunLight.position.set(18, 30, 16);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.width = 1024;
  sunLight.shadow.mapSize.height = 1024;
  sunLight.shadow.camera.near = 0.5;
  sunLight.shadow.camera.far = 120;
  sunLight.shadow.camera.left = -35;
  sunLight.shadow.camera.right = 35;
  sunLight.shadow.camera.top = 35;
  sunLight.shadow.camera.bottom = -35;
  sunLight.shadow.bias = -0.0003;
  sunLight.shadow.normalBias = 0.02;

  // 2. Moon Directional Light (Soft blue fill during Night)
  const moonLight = new THREE.DirectionalLight('#93c5fd', 0.0);
  moonLight.position.set(-18, 25, -20);
  moonLight.castShadow = false;

  // 3. Hemisphere Ambient Bounce
  const hemiLight = new THREE.HemisphereLight(0xfff5ea, 0x221a15, 0.95);

  // 4. Ambient Fill Light
  const ambientLight = new THREE.AmbientLight(0xfff1e0, 0.65);

  const daySkyColor = new THREE.Color('#386b9e');
  const sunsetSkyColor = new THREE.Color('#944430');
  const nightSkyColor = new THREE.Color('#08060f');
  const currentSkyColor = new THREE.Color();

  const setTimeMode = (newMode: TimeOfDayMode) => {
    mode = newMode;
    if (newMode === 'day') targetProgress = 0.0;
    else if (newMode === 'sunset') targetProgress = 0.5;
    else targetProgress = 1.0;
  };

  const update = (delta: number, scene: THREE.Scene, cameraDist: number) => {
    // Smooth transition between day, sunset, and night
    currentProgress = THREE.MathUtils.lerp(currentProgress, targetProgress, delta * 3.5);

    // Calculate light colors & intensities based on progress
    if (currentProgress < 0.5) {
      // Day (0.0) -> Sunset (0.5)
      const t = currentProgress / 0.5;
      sunLight.color.lerpColors(new THREE.Color('#fff8ee'), new THREE.Color('#f59e0b'), t);
      sunLight.intensity = THREE.MathUtils.lerp(1.8, 1.4, t);
      sunLight.position.set(
        THREE.MathUtils.lerp(18, 42, t),
        THREE.MathUtils.lerp(30, 10, t),
        THREE.MathUtils.lerp(16, 8, t)
      );

      hemiLight.color.lerpColors(new THREE.Color(0xfff5ea), new THREE.Color(0xfde68a), t);
      hemiLight.groundColor.lerpColors(new THREE.Color(0x221a15), new THREE.Color(0x2a1910), t);
      hemiLight.intensity = THREE.MathUtils.lerp(0.95, 0.75, t);

      ambientLight.color.lerpColors(new THREE.Color(0xfff1e0), new THREE.Color(0xfcd34d), t);
      ambientLight.intensity = THREE.MathUtils.lerp(0.65, 0.45, t);

      moonLight.intensity = 0.0;
      currentSkyColor.lerpColors(daySkyColor, sunsetSkyColor, t);
    } else {
      // Sunset (0.5) -> Night (1.0)
      const t = (currentProgress - 0.5) / 0.5;
      sunLight.color.lerpColors(new THREE.Color('#f59e0b'), new THREE.Color('#451a03'), t);
      sunLight.intensity = THREE.MathUtils.lerp(1.4, 0.05, t);

      hemiLight.color.lerpColors(new THREE.Color(0xfde68a), new THREE.Color(0x1e293b), t);
      hemiLight.groundColor.lerpColors(new THREE.Color(0x2a1910), new THREE.Color(0x0f172a), t);
      hemiLight.intensity = THREE.MathUtils.lerp(0.75, 0.35, t);

      ambientLight.color.lerpColors(new THREE.Color(0xfcd34d), new THREE.Color(0x1e1b4b), t);
      ambientLight.intensity = THREE.MathUtils.lerp(0.45, 0.18, t);

      moonLight.intensity = THREE.MathUtils.lerp(0.0, 0.45, t);
      currentSkyColor.lerpColors(sunsetSkyColor, nightSkyColor, t);
    }

    // Update Fog and Sky Color (Zero shader recompiles: fog remains permanently attached to scene, only uniforms update!)
    if (scene.fog && scene.fog instanceof THREE.Fog) {
      scene.fog.color.copy(currentSkyColor);
      if (cameraDist > 20) {
        scene.fog.near = 75;
        scene.fog.far = 260;
      } else {
        // Pushed far out when inside room so room is 100% crisp with zero fog tint
        scene.fog.near = 1500;
        scene.fog.far = 3000;
      }
    }

    if (cameraDist > 20) {
      scene.background = currentSkyColor;
    } else {
      const zoomFactor = THREE.MathUtils.clamp((cameraDist - 15) / 5, 0, 1);
      const interiorColor = new THREE.Color('#0a0807');
      scene.background = new THREE.Color().lerpColors(interiorColor, currentSkyColor, zoomFactor);
    }
  };

  const dispose = () => {
    sunLight.dispose();
    moonLight.dispose();
    hemiLight.dispose();
    ambientLight.dispose();
  };

  return {
    sunLight,
    moonLight,
    hemiLight,
    ambientLight,
    get mode() { return mode; },
    setTimeMode,
    update,
    get isNight() { return currentProgress > 0.6; },
    dispose,
  };
}
