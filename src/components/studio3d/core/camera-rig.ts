import * as THREE from 'three';

export interface CameraRigOptions {
  fov?: number;
  aspect?: number;
  near?: number;
  far?: number;
  initialDistance?: number;
  initialTarget?: THREE.Vector3;
}

export interface CameraRigResult {
  camera: THREE.PerspectiveCamera;
  update: (targetPos: THREE.Vector3, delta: number) => void;
  setAspect: (aspect: number) => void;
  attachDomEvents: (domElement: HTMLElement, onCanvasClick?: (e: MouseEvent) => void) => () => void;
  zoom: (deltaY: number) => void;
  getDistance: () => number;
  /** Take the camera for a scripted move (recording); null hands it back. */
  setShot: (shot: CameraShot | null) => void;
  dispose: () => void;
}

/**
 * A scripted camera move: glide (eased) to this framing over `seconds`, then
 * hold it, keeping `focus()` (or the player, when it returns null) in frame.
 */
export interface CameraShot {
  distance: number;
  yaw: number;
  pitch: number;
  seconds: number;
  /** Height of the look-at point above the focus. Default 1.2. */
  lift?: number;
  /** A slow orbit (radians per second) that keeps going once the glide lands. */
  drift?: number;
  focus?: () => THREE.Vector3 | null;
}

/**
 * Game-grade 3rd-person follow camera with dual-axis orbital rotation,
 * spring-damper following, mouse-wheel cosmic zoom, and click-vs-drag distinction.
 */
export function createCameraRig(options: CameraRigOptions = {}): CameraRigResult {
  const {
    fov = 40,
    aspect = 16 / 9,
    near = 0.1,
    far = 300,
    initialDistance = 17,
    initialTarget,
  } = options;

  const camera = new THREE.PerspectiveCamera(fov, aspect, near, far);

  // Orbital spherical coordinates
  let distance = initialDistance;
  let targetDistance = initialDistance;
  const minDistance = 6.5;
  const maxDistance = 58;

  let yawAngle = 0;       // horizontal orbit angle (radians)
  let targetYaw = 0;

  let pitchAngle = Math.PI / 4.4; // vertical elevation angle (~41 degrees)
  let targetPitch = Math.PI / 4.4;
  const minPitch = Math.PI / 12;  // ~15 degrees
  const maxPitch = Math.PI / 2.3; // ~78 degrees

  const currentLookAt = initialTarget
    ? new THREE.Vector3(initialTarget.x, initialTarget.y + 1.2, initialTarget.z)
    : new THREE.Vector3(0, 1.2, 0);

  /**
   * Smoothly updates camera position and look-at target with spring damping.
   * Includes micro-jitter deadzones to prevent front-to-back camera shake.
   */
  let shot: CameraShot | null = null;
  let shotT = 0;
  let shotAge = 0;
  const shotFrom = { distance: 0, yaw: 0, pitch: 0, look: new THREE.Vector3() };
  const shotLook = new THREE.Vector3();
  const smooth = (k: number) => k * k * k * (k * (k * 6 - 15) + 10); // smootherstep

  const setShot = (next: CameraShot | null) => {
    if (!next) {
      // Hand back without a jump: the follow camera starts from here.
      if (shot) {
        targetDistance = Math.max(minDistance, Math.min(maxDistance, distance));
        targetYaw = yawAngle;
        targetPitch = Math.max(minPitch, Math.min(maxPitch, pitchAngle));
      }
      shot = null;
      return;
    }
    shot = next;
    shotT = 0;
    shotAge = 0;
    shotFrom.distance = distance;
    shotFrom.yaw = yawAngle;
    shotFrom.pitch = pitchAngle;
    shotFrom.look.copy(currentLookAt);
  };

  const updateShot = (active: CameraShot, targetPos: THREE.Vector3, delta: number) => {
    shotT = Math.min(1, shotT + delta / Math.max(0.001, active.seconds));
    shotAge += delta;
    const k = smooth(shotT);
    distance = THREE.MathUtils.lerp(shotFrom.distance, active.distance, k);
    // The drift ramps in with the glide, so the move never jerks.
    yawAngle = THREE.MathUtils.lerp(shotFrom.yaw, active.yaw, k) + (active.drift ?? 0) * shotAge * k;
    pitchAngle = THREE.MathUtils.lerp(shotFrom.pitch, active.pitch, k);
    const focus = active.focus?.() ?? targetPos;
    shotLook.set(focus.x, focus.y + (active.lift ?? 1.2), focus.z);
    if (shotT < 1) {
      currentLookAt.lerpVectors(shotFrom.look, shotLook, k);
      // A moving subject keeps pulling the start along, so the glide lands on it.
      shotFrom.look.lerp(shotLook, Math.min(1, delta * 1.5));
    } else {
      currentLookAt.lerp(shotLook, 1 - Math.exp(-delta * 2.5));
    }
  };

  const update = (targetPos: THREE.Vector3, delta: number) => {
    if (shot) {
      updateShot(shot, targetPos, delta);
      const h = distance * Math.cos(pitchAngle);
      camera.position.set(
        currentLookAt.x + h * Math.sin(yawAngle),
        currentLookAt.y + distance * Math.sin(pitchAngle),
        currentLookAt.z + h * Math.cos(yawAngle),
      );
      camera.lookAt(currentLookAt);
      return;
    }
    // 1. Lerp distance and orbital angles smoothly with epsilon lock
    if (Math.abs(distance - targetDistance) < 0.002) {
      distance = targetDistance;
    } else {
      distance = THREE.MathUtils.lerp(distance, targetDistance, delta * 9);
    }

    if (Math.abs(yawAngle - targetYaw) < 0.0005) {
      yawAngle = targetYaw;
    } else {
      yawAngle = THREE.MathUtils.lerp(yawAngle, targetYaw, delta * 12);
    }

    if (Math.abs(pitchAngle - targetPitch) < 0.0005) {
      pitchAngle = targetPitch;
    } else {
      pitchAngle = THREE.MathUtils.lerp(pitchAngle, targetPitch, delta * 12);
    }

    // 2. Smoothly track player avatar with epsilon lock to eliminate vibration
    const targetLookAtY = targetPos.y + 1.2;
    if (Math.abs(currentLookAt.x - targetPos.x) < 0.001) {
      currentLookAt.x = targetPos.x;
    } else {
      currentLookAt.x = THREE.MathUtils.lerp(currentLookAt.x, targetPos.x, delta * 10);
    }

    if (Math.abs(currentLookAt.y - targetLookAtY) < 0.001) {
      currentLookAt.y = targetLookAtY;
    } else {
      currentLookAt.y = THREE.MathUtils.lerp(currentLookAt.y, targetLookAtY, delta * 10);
    }

    if (Math.abs(currentLookAt.z - targetPos.z) < 0.001) {
      currentLookAt.z = targetPos.z;
    } else {
      currentLookAt.z = THREE.MathUtils.lerp(currentLookAt.z, targetPos.z, delta * 10);
    }

    // 3. Spherical to Cartesian coordinate conversion
    const horizontalDist = distance * Math.cos(pitchAngle);
    const camY = currentLookAt.y + distance * Math.sin(pitchAngle);
    const camX = currentLookAt.x + horizontalDist * Math.sin(yawAngle);
    const camZ = currentLookAt.z + horizontalDist * Math.cos(yawAngle);

    camera.position.set(camX, camY, camZ);
    camera.lookAt(currentLookAt);
  };

  const setAspect = (newAspect: number) => {
    camera.aspect = newAspect;
    camera.updateProjectionMatrix();
  };

  const zoom = (deltaY: number) => {
    // Deadzone to prevent scroll micro-jitter from precision touchpads
    if (Math.abs(deltaY) < 1.0) return;
    targetDistance = Math.max(minDistance, Math.min(maxDistance, targetDistance + deltaY * 0.014));
  };

  /**
   * Attaches mouse look, drag rotation, and zoom controls.
   * Right-click/Middle-click: dedicated camera orbit.
   * Left-click: click-to-move / interact (only orbits if dragged > 10px).
   */
  const attachDomEvents = (domElement: HTMLElement, onCanvasClick?: (e: MouseEvent) => void) => {
    let isDragging = false;
    let dragButton = 0;
    let startX = 0;
    let startY = 0;
    let prevX = 0;
    let prevY = 0;
    let hasExceededClickThreshold = false;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoom(e.deltaY);
    };

    const onPointerDown = (e: PointerEvent) => {
      isDragging = true;
      dragButton = e.button;
      startX = e.clientX;
      startY = e.clientY;
      prevX = e.clientX;
      prevY = e.clientY;
      hasExceededClickThreshold = e.button === 2 || e.button === 1; // Right/Middle click rotates immediately

      try {
        domElement.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!isDragging) return;

      const totalDistSq = Math.pow(e.clientX - startX, 2) + Math.pow(e.clientY - startY, 2);
      if (!hasExceededClickThreshold && totalDistSq > 100) { // 10px threshold for left-click drag
        hasExceededClickThreshold = true;
      }

      if (hasExceededClickThreshold) {
        const deltaX = e.clientX - prevX;
        const deltaY = e.clientY - prevY;

        targetYaw -= deltaX * 0.0055;
        targetPitch = Math.max(minPitch, Math.min(maxPitch, targetPitch + deltaY * 0.0045));
      }

      prevX = e.clientX;
      prevY = e.clientY;
    };

    const onPointerUp = (e: PointerEvent) => {
      if (isDragging) {
        isDragging = false;
        try {
          domElement.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }

        const moveDistSq = Math.pow(e.clientX - startX, 2) + Math.pow(e.clientY - startY, 2);
        // If left click moved less than 10px, treat as intentional click!
        if (dragButton === 0 && moveDistSq < 100 && onCanvasClick) {
          onCanvasClick(e as unknown as MouseEvent);
        }
      }
    };

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    domElement.addEventListener('wheel', onWheel, { passive: false });
    domElement.addEventListener('pointerdown', onPointerDown);
    domElement.addEventListener('pointermove', onPointerMove);
    domElement.addEventListener('pointerup', onPointerUp);
    domElement.addEventListener('contextmenu', onContextMenu);

    return () => {
      domElement.removeEventListener('wheel', onWheel);
      domElement.removeEventListener('pointerdown', onPointerDown);
      domElement.removeEventListener('pointermove', onPointerMove);
      domElement.removeEventListener('pointerup', onPointerUp);
      domElement.removeEventListener('contextmenu', onContextMenu);
    };
  };

  const dispose = () => {
    // Camera disposal
  };

  return {
    camera,
    update,
    setAspect,
    attachDomEvents,
    zoom,
    getDistance: () => distance,
    setShot,
    dispose,
  };
}
