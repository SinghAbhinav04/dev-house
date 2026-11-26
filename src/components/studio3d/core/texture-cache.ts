import * as THREE from 'three';

/**
 * Texture & Material Cache.
 * Prevents redundant GPU texture uploads, creates procedural materials on-the-fly,
 * and configures pixel-art textures with crisp NearestFilter sampling.
 */
export class TextureCache {
  private textures = new Map<string, THREE.Texture>();
  private materials = new Map<string, THREE.Material>();
  private loader = new THREE.TextureLoader();

  /**
   * Generates a procedural chevron / parquet hardwood floor texture.
   * Produces an architectural herringbone pattern with plank seams and subtle wood grain.
   */
  public getWoodFloorTexture(): THREE.Texture {
    const key = 'procedural:wood_floor';
    if (this.textures.has(key)) return this.textures.get(key)!;

    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    if (ctx) {
      // Warm honey-amber oak hardwood base
      ctx.fillStyle = '#6e4c30';
      ctx.fillRect(0, 0, size, size);

      const plankW = 64;
      const plankH = 16;
      const colors = ['#7c5639', '#896040', '#734e34', '#936846', '#825b3c'];

      // Draw alternating herringbone/parquet slats
      for (let y = 0; y < size; y += plankH) {
        const row = Math.floor(y / plankH);
        const offset = (row % 2) * (plankW / 2);
        for (let x = -plankW; x < size + plankW; x += plankW) {
          const colorIdx = Math.abs((x * 7 + y * 13) % colors.length);
          ctx.fillStyle = colors[colorIdx];
          ctx.fillRect(x + offset, y, plankW - 2, plankH - 2);

          // Subtle wood grain line
          ctx.strokeStyle = 'rgba(0,0,0,0.15)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x + offset, y + plankH / 2);
          ctx.lineTo(x + offset + plankW - 2, y + plankH / 2);
          ctx.stroke();
        }
      }

      // Outer seam border
      ctx.strokeStyle = '#543924';
      ctx.lineWidth = 2;
      ctx.strokeRect(0, 0, size, size);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(4, 4);
    texture.colorSpace = THREE.SRGBColorSpace;

    this.textures.set(key, texture);
    return texture;
  }

  /**
   * Loads a sprite sheet texture configured specifically for pixel art.
   * Uses NearestFilter to eliminate bilinear blur and keep pixels crisp.
   */
  public loadPixelSpriteTexture(src: string): THREE.Texture {
    if (this.textures.has(src)) return this.textures.get(src)!;

    const texture = this.loader.load(src);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.SRGBColorSpace;

    this.textures.set(src, texture);
    return texture;
  }

  /**
   * Cache and return reusable PBR materials
   */
  public getMaterial<T extends THREE.Material>(key: string, create: () => T): T {
    if (this.materials.has(key)) return this.materials.get(key) as T;
    const mat = create();
    this.materials.set(key, mat);
    return mat;
  }

  /**
   * Releases all textures and materials from GPU memory.
   */
  public dispose(): void {
    for (const texture of this.textures.values()) {
      texture.dispose();
    }
    this.textures.clear();

    for (const material of this.materials.values()) {
      material.dispose();
    }
    this.materials.clear();
  }
}
