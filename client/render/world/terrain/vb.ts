// Voxel builder for backdrop models (flora.ts, floraextra.ts): metres in, VoxelGrid out.
import type { Rng } from '../../../../shared/math.ts';
import { VoxelGrid, hashVox, shade } from '../../voxel/voxel.ts';

export type Mat = 'leaf' | 'shiny' | 'glow';

export interface ModelDef {
  /** model bounds in metres [w, h, d] (grid size) */
  size: [number, number, number];
  /** voxel size for the near and far levels of detail */
  vox: [number, number];
  mat: Mat;
  /** sway strength for wind (0 = static) */
  sway: number;
  build: (b: VB, rnd: Rng) => void;
}

/** Voxel builder in metres: origin at the bottom centre of the grid. */
export class VB {
  readonly g: VoxelGrid;
  readonly v: number; // voxels per metre
  readonly cx: number;
  readonly cz: number;
  constructor(size: [number, number, number], vox: number) {
    this.v = 1 / vox;
    const nx = Math.max(2, Math.ceil(size[0] * this.v));
    const ny = Math.max(2, Math.ceil(size[1] * this.v));
    const nz = Math.max(2, Math.ceil(size[2] * this.v));
    this.g = new VoxelGrid(nx, ny, nz);
    this.cx = nx / 2;
    this.cz = nz / 2;
  }
  private X(x: number): number {
    return x * this.v + this.cx;
  }
  private Z(z: number): number {
    return z * this.v + this.cz;
  }
  ell(x: number, y: number, z: number, rx: number, ry: number, rz: number, c: number | ((x: number, y: number, z: number) => number)): void {
    const v = this.v;
    this.g.ellipsoid(this.X(x), y * v, this.Z(z), Math.max(0.5, rx * v), Math.max(0.5, ry * v), Math.max(0.5, rz * v), c);
  }
  cyl(x: number, z: number, r: number, y0: number, y1: number, c: number | ((x: number, y: number, z: number) => number)): void {
    const v = this.v;
    this.g.cylinder(this.X(x), this.Z(z), Math.max(0.5, r * v), Math.floor(y0 * v), Math.max(Math.floor(y0 * v), Math.ceil(y1 * v) - 1), c);
  }
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: number | ((x: number, y: number, z: number) => number)): void {
    const v = this.v;
    this.g.box(Math.floor(this.X(x0)), Math.floor(y0 * v), Math.floor(this.Z(z0)), Math.ceil(this.X(x1)) - 1, Math.ceil(y1 * v) - 1, Math.ceil(this.Z(z1)) - 1, c);
  }
  line(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number, c: number | ((x: number, y: number, z: number) => number)): void {
    const v = this.v;
    this.g.line(this.X(x0), y0 * v, this.Z(z0), this.X(x1), y1 * v, this.Z(z1), r * v, c);
  }
  /** Tapered trunk along a polyline of points [x,y,z,...] with radius r0 -> r1. */
  trunk(pts: number[], r0: number, r1: number, c: (x: number, y: number, z: number) => number): void {
    const n = pts.length / 3;
    for (let i = 0; i < n - 1; i++) {
      const steps = 6;
      for (let s = 0; s < steps; s++) {
        const t = (i + s / steps) / (n - 1);
        const a = i * 3;
        const k = s / steps;
        const x = pts[a] + (pts[a + 3] - pts[a]) * k;
        const y = pts[a + 1] + (pts[a + 4] - pts[a + 1]) * k;
        const z = pts[a + 2] + (pts[a + 5] - pts[a + 2]) * k;
        const r = r0 + (r1 - r0) * t;
        const yy = pts[a + 1] + (pts[a + 4] - pts[a + 1]) * Math.min(1, k + 1 / steps);
        this.cyl(x, z, r, y, yy + 0.02, c);
      }
    }
  }
  /** Recolour exposed tops (voxel with empty space above) through fn. */
  caps(fn: (c: number, x: number, y: number, z: number) => number): void {
    const g = this.g;
    for (let z = 0; z < g.nz; z++)
      for (let y = 0; y < g.ny; y++)
        for (let x = 0; x < g.nx; x++) {
          const c = g.get(x, y, z);
          if (c < 0) continue;
          if (!g.solid(x, y + 1, z)) g.set(x, y, z, fn(c, x, y, z));
        }
  }
}

export const sp = (pal: readonly number[], seed: number, amt = 0.08) => (x: number, y: number, z: number) =>
  shade(pal[Math.floor(hashVox(x, y, z, seed) * pal.length) % pal.length], 1 + (hashVox(x, y, z, seed + 1) - 0.5) * 2 * amt);

