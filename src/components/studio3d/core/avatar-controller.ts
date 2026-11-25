import * as THREE from 'three';
import type { AABB, FacingDirection } from '../types';
import { resolveAllObstacles, type RoomBounds } from '../math/collision';
import { createBillboardSprite, type BillboardSpriteResult } from './billboard-sprite';
import type { TextureCache } from './texture-cache';

export interface AvatarControllerOptions {
  spritePath: string;
  roomBounds: RoomBounds;
  obstacles: readonly AABB[];
  initialPosition?: [number, number, number];
  speed?: number;
}

export interface AvatarControllerResult {
  group: THREE.Group;
  getPosition: () => THREE.Vector3;
  setPosition: (x: number, z: number) => void;
  update: (delta: number, camera: THREE.Camera) => void;
  isMoving: () => boolean;
  dispose: () => void;
}

/**
 * Handles avatar movement, keyboard inputs, velocity physics, collision resolution,
 * and walk cycle animations for the controllable player character.
 */
export function createAvatarController(
  options: AvatarControllerOptions,
  textureCache: TextureCache
): AvatarControllerResult {
  const {
    spritePath,
    roomBounds,
    obstacles,
    initialPosition = [0, 0, 2],
    speed = 6.2,
  } = options;

  const group = new THREE.Group();
  group.name = 'PlayerAvatar';

  // Current physics state
  const position = new THREE.Vector3(initialPosition[0], initialPosition[1], initialPosition[2]);
  const velocity = new THREE.Vector3();
  let facing: FacingDirection = 'front';
  let isWalking = false;
  let animTimer = 0;
  let currentFrame = 0;
  const avatarRadius = 0.35;

  // Visual billboard sprite
  const sprite: BillboardSpriteResult = createBillboardSprite(
    { spritePath, width: 1.3, height: 1.3 },
    textureCache
  );
  group.add(sprite.mesh);
  group.position.copy(position);

  // Subtle circular ground shadow under avatar feet
  const shadowGeom = new THREE.CircleGeometry(0.35, 16);
  const shadowMat = new THREE.MeshBasicMaterial({
    color: '#000000',
    transparent: true,
    opacity: 0.3,
  });
  const shadow = new THREE.Mesh(shadowGeom, shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  group.add(shadow);

  // Keyboard input state
  const keys = {
    up: false,
    down: false,
    left: false,
    right: false,
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Ignore input if user is typing in a textarea or input field
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }

    switch (e.key.toLowerCase()) {
      case 'w':
      case 'arrowup':
        keys.up = true;
        break;
      case 's':
      case 'arrowdown':
        keys.down = true;
        break;
      case 'a':
      case 'arrowleft':
        keys.left = true;
        break;
      case 'd':
      case 'arrowright':
        keys.right = true;
        break;
    }
  };

  const onKeyUp = (e: KeyboardEvent) => {
    switch (e.key.toLowerCase()) {
      case 'w':
      case 'arrowup':
        keys.up = false;
        break;
      case 's':
      case 'arrowdown':
        keys.down = false;
        break;
      case 'a':
      case 'arrowleft':
        keys.left = false;
        break;
      case 'd':
      case 'arrowright':
        keys.right = false;
        break;
    }
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
  }

  /**
   * Physics & animation update step called every frame.
   */
  const update = (delta: number, camera: THREE.Camera) => {
    // 1. Calculate input movement vector
    const moveDir = new THREE.Vector3(0, 0, 0);

    if (keys.up) moveDir.z -= 1;
    if (keys.down) moveDir.z += 1;
    if (keys.left) moveDir.x -= 1;
    if (keys.right) moveDir.x += 1;

    const hasInput = moveDir.lengthSq() > 0;

    if (hasInput) {
      moveDir.normalize();

      // Determine facing direction based on primary movement axis
      if (Math.abs(moveDir.x) > Math.abs(moveDir.z)) {
        facing = moveDir.x < 0 ? 'left' : 'right';
      } else {
        facing = moveDir.z < 0 ? 'back' : 'front';
      }

      // Smooth acceleration
      velocity.x = THREE.MathUtils.lerp(velocity.x, moveDir.x * speed, delta * 12);
      velocity.z = THREE.MathUtils.lerp(velocity.z, moveDir.z * speed, delta * 12);
      isWalking = true;
    } else {
      // Smooth deceleration / friction
      velocity.x = THREE.MathUtils.lerp(velocity.x, 0, delta * 14);
      velocity.z = THREE.MathUtils.lerp(velocity.z, 0, delta * 14);
      if (velocity.lengthSq() < 0.001) {
        velocity.set(0, 0, 0);
        isWalking = false;
      }
    }

    // 2. Integrate position and resolve collisions
    if (velocity.lengthSq() > 0.0001) {
      const nextX = position.x + velocity.x * delta;
      const nextZ = position.z + velocity.z * delta;

      const resolved = resolveAllObstacles(nextX, nextZ, avatarRadius, obstacles, roomBounds);
      position.x = resolved.x;
      position.z = resolved.z;
    }

    group.position.x = position.x;
    group.position.z = position.z;

    // 3. Update sprite walk animation
    if (isWalking) {
      animTimer += delta;
      if (animTimer >= 0.12) {
        currentFrame = (currentFrame + 1) % 8;
        animTimer = 0;
      }
    } else {
      currentFrame = 0;
      animTimer = 0;
    }

    sprite.setFrame(currentFrame, facing);
    sprite.updateOrientation(camera);
  };

  const getPosition = () => position.clone();

  const setPosition = (x: number, z: number) => {
    position.x = x;
    position.z = z;
    group.position.x = x;
    group.position.z = z;
  };

  const isMoving = () => isWalking;

  const dispose = () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    }
    sprite.dispose();
    shadowGeom.dispose();
    shadowMat.dispose();
  };

  return {
    group,
    getPosition,
    setPosition,
    update,
    isMoving,
    dispose,
  };
}
