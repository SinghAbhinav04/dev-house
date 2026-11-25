import * as THREE from 'three';
import type { FacingDirection } from '../types';
import type { TextureCache } from './texture-cache';

export interface BillboardSpriteOptions {
  spritePath: string;
  width?: number;
  height?: number;
  colorTint?: string;
}

export interface BillboardSpriteResult {
  mesh: THREE.Mesh;
  setFrame: (frame: number, facing: FacingDirection) => void;
  updateOrientation: (camera: THREE.Camera) => void;
  dispose: () => void;
}

/**
 * Creates a camera-facing 3D billboard quad that renders a pixel-art character sprite.
 * Animates walk frames and directional facings using UV offsets on the 8x4 sprite sheet.
 */
export function createBillboardSprite(
  options: BillboardSpriteOptions,
  textureCache: TextureCache
): BillboardSpriteResult {
  const { spritePath, width = 1.2, height = 1.2, colorTint } = options;

  // Clone texture so offset updates are independent per sprite instance
  const baseTexture = textureCache.loadPixelSpriteTexture(spritePath);
  const texture = baseTexture.clone();
  texture.needsUpdate = true;

  // 8 columns, 4 rows
  const COLS = 8;
  const ROWS = 4;
  texture.repeat.set(1 / COLS, 1 / ROWS);

  const geometry = new THREE.PlaneGeometry(width, height);
  // Shift origin so (0,0,0) is at character's feet
  geometry.translate(0, height / 2, 0);

  const material = new THREE.MeshStandardMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.1,
    roughness: 0.8,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });

  if (colorTint) {
    material.color.set(colorTint);
  }

  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = false;

  /**
   * Updates the UV offset for the given walk frame and facing direction.
   */
  const setFrame = (frame: number, facing: FacingDirection) => {
    let rowIdx = 0;
    switch (facing) {
      case 'back':
        rowIdx = 1;
        break;
      case 'left':
        rowIdx = 2;
        break;
      case 'right':
        rowIdx = 3;
        break;
      default:
        rowIdx = 0; // front
    }

    // In Three.js UV space, Y starts at 0 at the bottom and 1 at the top
    texture.offset.x = (frame % COLS) * (1 / COLS);
    texture.offset.y = (ROWS - 1 - rowIdx) * (1 / ROWS);
  };

  // Initial front frame
  setFrame(0, 'front');

  /**
   * Constrains billboard rotation to Y axis so the sprite faces the camera upright.
   */
  const updateOrientation = (camera: THREE.Camera) => {
    mesh.rotation.y = camera.rotation.y;
  };

  const dispose = () => {
    geometry.dispose();
    material.dispose();
    texture.dispose();
  };

  return { mesh, setFrame, updateOrientation, dispose };
}
