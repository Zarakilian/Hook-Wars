// Voxel grid for Pudgy parts. Same VoxelGrid / meshVoxels pipeline as every other model, plus a
// per-voxel surface channel (skin, cloth, rubber, iron, brass, wet, glow, pulse-glow).
// The channel lives in the lowest 3 bits of each voxel colour, so the greedy mesher never merges
// faces across channels, and after meshing each quad looks its channel up again to write a
// `surf` vertex attribute (roughness, metalness, glow A weight, glow B weight).
// One shared shader reads `surf`, so every part is a single draw call whatever it is made of.
import * as THREE from 'three';
import { hashVox, meshVoxels, mix, shade, VoxelGrid } from '../../voxel/voxel.ts';

/** metres per voxel for every Pudgy part */
export const VOX = 0.06;

/** Surface channels. */
export const CH = {
  cloth: 0, // fabric, hair, moss, wood: very rough
  skin: 1, // skin, leather: soft sheen
  rubber: 2, // rubber apron, wellies, gloss paint, plates
  iron: 3, // iron, steel
  brass: 4, // brass, gold, copper
  wet: 5, // eyes, teeth, slime: glossy
  glow: 6, // emissive, steady (visor, lamps) scaled by the glowA uniform
  pulse: 7, // emissive, pulsing (steam vents, glow spots, fireflies) scaled by glowB
} as const;
export type Channel = (typeof CH)[keyof typeof CH];

// roughness, metalness, glowA, glowB per channel. Metalness stays moderate: the scene may not
// have an environment map, and full metal reads as black without one.
const SURF: readonly (readonly [number, number, number, number])[] = [
  [0.9, 0, 0, 0],
  [0.6, 0, 0, 0],
  [0.32, 0, 0, 0],
  [0.36, 0.55, 0, 0],
  [0.28, 0.65, 0, 0],
  [0.12, 0, 0, 0],
  [0.5, 0, 1, 0],
  [0.5, 0, 0, 1],
];

export type ColorFn = (x: number, y: number, z: number) => number;
export type Paint = number | ColorFn;

/**
 * Grid painted in "skeleton" voxel coordinates: (0,0,0) is the ground under the character's centre,
 * +x is the character's left, +y up, +z forward. The grid covers [ox, ox+nx) etc. Inherited
 * VoxelGrid shape helpers (box, ellipsoid, cylinder, line) also paint in skeleton coordinates because
 * they all go through set(); get()/solid() stay local for the mesher.
 */
export class RGrid extends VoxelGrid {
  /** channel written by every set() */
  ch: Channel = CH.cloth;
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;

  constructor(nx: number, ny: number, nz: number, ox = -nx / 2, oy = 0, oz = -nz / 2) {
    super(nx, ny, nz);
    this.ox = Math.floor(ox);
    this.oy = Math.floor(oy);
    this.oz = Math.floor(oz);
  }

  override set(x: number, y: number, z: number, color: number): void {
    super.set(Math.floor(x) - this.ox, Math.floor(y) - this.oy, Math.floor(z) - this.oz, color < 0 ? color : (color & 0xfffff8) | this.ch);
  }

  /** Colour at skeleton coordinates (-1 when empty). */
  sget(x: number, y: number, z: number): number {
    return this.get(Math.floor(x) - this.ox, Math.floor(y) - this.oy, Math.floor(z) - this.oz);
  }

  has(x: number, y: number, z: number): boolean {
    return this.sget(x, y, z) >= 0;
  }

  /** Paint with channel `ch` inside fn. */
  on(ch: Channel, fn: () => void): this {
    const prev = this.ch;
    this.ch = ch;
    fn();
    this.ch = prev;
    return this;
  }

  /** Set only where a voxel already exists. */
  paint(x: number, y: number, z: number, color: number): void {
    if (this.has(x, y, z)) this.set(x, y, z, color);
  }

  /** Set only where the cell is empty. */
  add(x: number, y: number, z: number, color: number): void {
    if (!this.has(x, y, z)) this.set(x, y, z, color);
  }

  /** True when at least one of the 6 neighbours is empty. */
  surface(x: number, y: number, z: number): boolean {
    return (
      this.has(x, y, z) &&
      (!this.has(x + 1, y, z) || !this.has(x - 1, y, z) || !this.has(x, y + 1, z) || !this.has(x, y - 1, z) || !this.has(x, y, z + 1) || !this.has(x, y, z - 1))
    );
  }

  /** Mirror the half with skeleton x < 0 onto x >= 0, keeping channels (grid must be centred: ox = -nx/2). */
  mirror(): void {
    for (let z = 0; z < this.nz; z++)
      for (let y = 0; y < this.ny; y++)
        for (let x = 0; x < Math.floor(this.nx / 2); x++) {
          const c = this.data[this.index(x, y, z)];
          this.data[this.index(this.nx - 1 - x, y, z)] = c;
        }
  }

  /** Visit every solid voxel. fn returns a new colour (channel kept unless it returns a channel too). */
  each(fn: (c: number, x: number, y: number, z: number) => number | void, onlySurface = false): void {
    for (let z = 0; z < this.nz; z++)
      for (let y = 0; y < this.ny; y++)
        for (let x = 0; x < this.nx; x++) {
          const i = this.index(x, y, z);
          const c = this.data[i];
          if (c < 0) continue;
          const sx = x + this.ox;
          const sy = y + this.oy;
          const sz = z + this.oz;
          if (onlySurface && !this.surface(sx, sy, sz)) continue;
          const r = fn(c, sx, sy, sz);
          if (r !== undefined) this.data[i] = (r & 0xfffff8) | (c & 7);
        }
  }

  /** Visit every solid voxel and repaint it with a new colour and channel. */
  repaint(test: (x: number, y: number, z: number) => boolean, ch: Channel, color: Paint, onlySurface = false): void {
    for (let z = 0; z < this.nz; z++)
      for (let y = 0; y < this.ny; y++)
        for (let x = 0; x < this.nx; x++) {
          const i = this.index(x, y, z);
          if (this.data[i] < 0) continue;
          const sx = x + this.ox;
          const sy = y + this.oy;
          const sz = z + this.oz;
          if (!test(sx, sy, sz)) continue;
          if (onlySurface && !this.surface(sx, sy, sz)) continue;
          this.data[i] = (pick(color, sx, sy, sz) & 0xfffff8) | ch;
        }
  }

  /** Ellipsoid shell between an inner and outer radius offset, filtered. */
  shell(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, outer: number, inner: number, test: (x: number, y: number, z: number) => boolean, color: Paint): void {
    const ox = rx + outer;
    const oy = ry + outer;
    const oz = rz + outer;
    const ix = Math.max(0.1, rx - inner);
    const iy = Math.max(0.1, ry - inner);
    const iz = Math.max(0.1, rz - inner);
    for (let z = Math.floor(cz - oz); z <= Math.ceil(cz + oz); z++)
      for (let y = Math.floor(cy - oy); y <= Math.ceil(cy + oy); y++)
        for (let x = Math.floor(cx - ox); x <= Math.ceil(cx + ox); x++) {
          const dx = x + 0.5 - cx;
          const dy = y + 0.5 - cy;
          const dz = z + 0.5 - cz;
          const o = (dx / ox) ** 2 + (dy / oy) ** 2 + (dz / oz) ** 2;
          if (o > 1) continue;
          const n = (dx / ix) ** 2 + (dy / iy) ** 2 + (dz / iz) ** 2;
          if (n < 1) continue;
          if (!test(x, y, z)) continue;
          this.set(x, y, z, pick(color, x, y, z));
        }
  }

  /** Filled ellipsoid, filtered. */
  blob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, color: Paint, test?: (x: number, y: number, z: number) => boolean): void {
    for (let z = Math.floor(cz - rz); z <= Math.ceil(cz + rz); z++)
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++)
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
          const dx = (x + 0.5 - cx) / rx;
          const dy = (y + 0.5 - cy) / ry;
          const dz = (z + 0.5 - cz) / rz;
          if (dx * dx + dy * dy + dz * dz > 1) continue;
          if (test && !test(x, y, z)) continue;
          this.set(x, y, z, pick(color, x, y, z));
        }
  }

  /** Cylinder along an axis ('x' | 'y' | 'z') through centre (a, b) on the other two axes, from t0 to t1 inclusive. */
  cyl(axis: 'x' | 'y' | 'z', a: number, b: number, r: number, t0: number, t1: number, color: Paint, rb = r): void {
    for (let t = Math.min(t0, t1); t <= Math.max(t0, t1); t++)
      for (let j = Math.floor(b - rb); j <= Math.ceil(b + rb); j++)
        for (let i = Math.floor(a - r); i <= Math.ceil(a + r); i++) {
          const di = (i + 0.5 - a) / r;
          const dj = (j + 0.5 - b) / rb;
          if (di * di + dj * dj > 1) continue;
          if (axis === 'y') this.set(i, t, j, pick(color, i, t, j));
          else if (axis === 'x') this.set(t, i, j, pick(color, t, i, j));
          else this.set(i, j, t, pick(color, i, j, t));
        }
  }

  /** Thick line between two points (radius in voxels, may be fractional). */
  tube(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number, color: Paint): void {
    const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    const steps = Math.max(1, Math.ceil(len * 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      const z = z0 + (z1 - z0) * t;
      if (r <= 0.55) {
        const xi = Math.floor(x);
        const yi = Math.floor(y);
        const zi = Math.floor(z);
        this.set(xi, yi, zi, pick(color, xi, yi, zi));
      } else this.blob(x, y, z, r, r, r, color);
    }
  }

  /** Inclusive box with a paint (function or colour). */
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: Paint): void {
    this.box(x0, y0, z0, x1, y1, z1, color);
  }

  /** Remove voxels matching a test. */
  carve(test: (x: number, y: number, z: number) => boolean): void {
    for (let z = 0; z < this.nz; z++)
      for (let y = 0; y < this.ny; y++)
        for (let x = 0; x < this.nx; x++) if (test(x + this.ox, y + this.oy, z + this.oz)) this.data[this.index(x, y, z)] = -1;
  }
}

function pick(c: Paint, x: number, y: number, z: number): number {
  return typeof c === 'function' ? c(x, y, z) : c;
}

// ---------------------------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------------------------

/** Palette pick with per-voxel hash and a gentle top-lit gradient. */
export function tone(palette: readonly number[], seed: number, grad = 0, y0 = 0, y1 = 1): ColorFn {
  return (x, y, z) => {
    const h = hashVox(x, y, z, seed);
    const c = palette[Math.floor(h * palette.length) % palette.length];
    if (grad === 0) return c;
    const t = Math.max(0, Math.min(1, (y - y0) / Math.max(1, y1 - y0)));
    return shade(c, 1 - grad + 2 * grad * t);
  };
}

/** Base colour with brightness noise and an optional vertical gradient (lighter towards y1). */
export function jitter(base: number, amount: number, seed: number, grad = 0, y0 = 0, y1 = 1): ColorFn {
  return (x, y, z) => {
    const h = hashVox(x, y, z, seed) - 0.5;
    const t = Math.max(0, Math.min(1, (y - y0) / Math.max(1, y1 - y0)));
    return shade(base, 1 + h * 2 * amount + (t - 0.5) * 2 * grad);
  };
}

/** Three-tone ramp: dark / mid / light chosen by hash, for fabrics and skin. */
export function ramp(base: number, seed: number, spread = 0.08, grad = 0, y0 = 0, y1 = 1): ColorFn {
  const pal = [shade(base, 1 - spread), base, shade(base, 1 + spread * 0.8)];
  return tone(pal, seed, grad, y0, y1);
}

export { hashVox, mix, shade };

// ---------------------------------------------------------------------------------------------
// Meshing
// ---------------------------------------------------------------------------------------------

/**
 * Greedy-mesh a part with voxel.ts meshVoxels (baked AO), then add the `surf` attribute by looking
 * each quad's channel up in the grid. `joint` is the part's pivot in skeleton voxel coordinates.
 */
export function meshPart(g: RGrid, joint: readonly [number, number, number], aoStrength = 0.52): THREE.BufferGeometry {
  const pivot: [number, number, number] = [joint[0] - g.ox, joint[1] - g.oy, joint[2] - g.oz];
  const geo = meshVoxels(g, { size: VOX, pivot, aoStrength });
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const n = pos.count;
  const surf = new Float32Array(n * 4);
  const inv = 1 / VOX;
  for (let q = 0; q + 3 < n; q += 4) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let k = 0; k < 4; k++) {
      cx += pos.getX(q + k);
      cy += pos.getY(q + k);
      cz += pos.getZ(q + k);
    }
    cx *= 0.25;
    cy *= 0.25;
    cz *= 0.25;
    const vx = Math.floor((cx - nrm.getX(q) * VOX * 0.5) * inv + pivot[0] + 1e-4);
    const vy = Math.floor((cy - nrm.getY(q) * VOX * 0.5) * inv + pivot[1] + 1e-4);
    const vz = Math.floor((cz - nrm.getZ(q) * VOX * 0.5) * inv + pivot[2] + 1e-4);
    const c = g.get(vx, vy, vz);
    const s = SURF[c < 0 ? 0 : c & 7];
    for (let k = 0; k < 4; k++) {
      const o = (q + k) * 4;
      surf[o] = s[0];
      surf[o + 1] = s[1];
      surf[o + 2] = s[2];
      surf[o + 3] = s[3];
    }
  }
  geo.setAttribute('surf', new THREE.BufferAttribute(surf, 4));
  return geo;
}
