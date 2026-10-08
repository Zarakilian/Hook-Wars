// Backdrop flora, rocks and set dressing outside the playable area: voxel models built in code,
// two levels of detail each, scattered by per-biome rules and drawn through BatchedMesh (one draw
// call per material with per-instance frustum culling, shadows only for the near band).
import * as THREE from 'three';
import { Rng } from '../../../../shared/math.ts';
import type { Quality } from '../../contracts.ts';
import { VoxelGrid, hashVox, mix, shade } from '../../voxel/voxel.ts';
import { meshVoxelsFast } from './vmesh.ts';

export interface BackdropRule {
  model: ModelKind;
  /** grid spacing of candidate points in metres */
  spacing: number;
  scale: [number, number];
  /** 0..1 acceptance probability at (x, z) */
  density: (x: number, z: number) => number;
  castShadow?: boolean;
  /** stand on max(ground, water level) e.g. swamp trees, moored boats */
  waterline?: boolean;
  /** float exactly on the water level (lily pads, ice floes) */
  onWater?: boolean;
  /** extra vertical offset in metres */
  yOffset?: number;
  /** allow placement on ground under the water (reeds, river-bed stones, surf rocks) */
  underwater?: boolean;
  /** keep the instance yaw fixed (radians) instead of random */
  yaw?: (x: number, z: number) => number;
}

export type ModelKind =
  | 'cypress' | 'swampoak' | 'snag' | 'bush' | 'fern' | 'mossrock' | 'log' | 'reeds' | 'lilypads'
  | 'pine' | 'snowpine' | 'icerock' | 'iceshard' | 'snowbush' | 'iceberg' | 'floe'
  | 'palm' | 'jbush' | 'sandrock' | 'searock' | 'beachgrass' | 'driftwood'
  | 'crate' | 'barrel' | 'boat' | 'crane' | 'lamp' | 'bollard' | 'chimney'
  | 'pebble' | 'root' | 'shellbits' | 'icebits' | 'cobbles';

type Mat = 'leaf' | 'shiny' | 'glow';

interface ModelDef {
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
class VB {
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

const sp = (pal: readonly number[], seed: number, amt = 0.08) => (x: number, y: number, z: number) =>
  shade(pal[Math.floor(hashVox(x, y, z, seed) * pal.length) % pal.length], 1 + (hashVox(x, y, z, seed + 1) - 0.5) * 2 * amt);

const BARK = [0x5a4632, 0x4b3a28, 0x6a5440, 0x3f3122];
const MOSSY_LEAF = [0x3d5226, 0x485e2b, 0x34481f, 0x52692f, 0x2f4219];
const OAK_LEAF = [0x44602a, 0x506d30, 0x3a5323, 0x5b7a36, 0x3a5a26];
const MOSS_STRAND = [0x8a9a72, 0x7a8a62, 0x9aa882, 0x6f7f58];
const DEAD = [0x6e6658, 0x5d564a, 0x7d7566, 0x544d42];
const PINE = [0x24402e, 0x2b4a34, 0x1e3626, 0x30523a];
const SNOW = [0xeef4fa, 0xdfe9f3, 0xf7fafd, 0xe6eef6];
const ICE = [0xa8d8f0, 0x8ec8e8, 0xc4e6f8, 0x9ad0ec];
const PALM_BARK = [0x8a6a44, 0x7a5c3a, 0x9a7a52, 0x6e5232];
const PALM_LEAF = [0x3f8a2e, 0x4c9a36, 0x5aaa40, 0x357a28, 0x2f6e24];
const JUNGLE = [0x2f7a32, 0x3a8a3a, 0x4a9a40, 0x286a2a, 0x55a548];
const SANDSTONE = [0xb8a27a, 0xa89068, 0xc8b28a, 0x9c8660];
const DARKROCK = [0x5a5a5e, 0x4a4a50, 0x6a6a6e, 0x55555a];
const GREYROCK = [0x5e5e52, 0x6b6a5c, 0x545448, 0x75735f];
const PLANK = [0x8a6a44, 0x7a5c3a, 0x96764c, 0x6e5232];
const IRON = [0x3a3c40, 0x45474c, 0x303236];
const RUST = [0x8a3a22, 0x9a4428, 0x7a3220, 0xa85030];

const MODELS: Record<ModelKind, ModelDef> = {
  cypress: {
    size: [5, 9.4, 5], vox: [0.22, 0.32], mat: 'leaf', sway: 1,
    build(b, r) {
      const lean = r.range(-0.25, 0.25);
      const h = r.range(6.2, 7.4);
      b.trunk([0, 0, 0, lean * 0.4, h * 0.5, 0, lean, h, lean * 0.3], 0.34, 0.15, sp(BARK, 1));
      b.cyl(0, 0, 0.6, 0, 0.5, sp(BARK, 2)); // buttress flare
      b.cyl(0, 0, 0.48, 0.5, 1.0, sp(BARK, 2));
      for (let k = 0; k < 4; k++) {
        const a = r.range(0, Math.PI * 2);
        const d = r.range(0.8, 1.3);
        b.cyl(Math.cos(a) * d, Math.sin(a) * d, 0.13, 0, r.range(0.25, 0.5), sp(BARK, 3)); // knees
      }
      const layers = r.int(4, 6);
      for (let i = 0; i < layers; i++) {
        const t = i / (layers - 1);
        const y = h * 0.62 + t * (h * 0.42);
        const rad = 1.7 - t * 0.8 + r.range(-0.2, 0.2);
        const ox = lean * t + r.range(-0.5, 0.5);
        const oz = r.range(-0.5, 0.5);
        b.ell(ox, y, oz, rad, r.range(0.42, 0.62), rad * r.range(0.8, 1.1), sp(MOSSY_LEAF, 4 + i, 0.1));
        // moss strands hanging under each layer
        const strands = r.int(3, 6);
        for (let s = 0; s < strands; s++) {
          const a = r.range(0, Math.PI * 2);
          const d = r.range(0.4, rad * 0.9);
          const sx = ox + Math.cos(a) * d;
          const sz = oz + Math.sin(a) * d;
          b.line(sx, y - 0.2, sz, sx + r.range(-0.1, 0.1), y - r.range(0.8, 1.9), sz, 0, sp(MOSS_STRAND, 9));
        }
      }
      b.caps((c, x, y, z) => (y > b.g.ny * 0.55 && hashVox(x, y, z, 11) < 0.6 ? shade(c, 1.18) : c));
    },
  },
  swampoak: {
    size: [7.2, 8.2, 7.2], vox: [0.26, 0.38], mat: 'leaf', sway: 0.6,
    build(b, r) {
      const h = r.range(3.4, 4.2);
      b.trunk([0, 0, 0, 0.2, h * 0.6, 0.1, 0.1, h, -0.1], 0.5, 0.32, sp(BARK, 1));
      b.cyl(0, 0, 0.72, 0, 0.4, sp(BARK, 2));
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2 + r.range(-0.4, 0.4);
        b.line(0, h * 0.8, 0, Math.cos(a) * 1.8, h + 1.2, Math.sin(a) * 1.8, 0.16, sp(BARK, 3));
      }
      const blobs = r.int(6, 8);
      for (let i = 0; i < blobs; i++) {
        const a = r.range(0, Math.PI * 2);
        const d = i === 0 ? 0 : r.range(1.0, 2.0);
        b.ell(Math.cos(a) * d, h + 1.6 + r.range(-0.5, 1.2), Math.sin(a) * d, r.range(1.3, 1.9), r.range(0.9, 1.3), r.range(1.3, 1.9), sp(OAK_LEAF, 4 + i, 0.1));
      }
      for (let s = 0; s < 14; s++) {
        const a = r.range(0, Math.PI * 2);
        const d = r.range(1.2, 2.9);
        const x = Math.cos(a) * d;
        const z = Math.sin(a) * d;
        b.line(x, h + 0.9, z, x, h - r.range(0.3, 1.6), z, 0, sp(MOSS_STRAND, 9));
      }
      b.caps((c, x, y, z) => (hashVox(x, y, z, 11) < 0.5 ? shade(c, 1.15) : c));
    },
  },
  snag: {
    size: [3, 6, 3], vox: [0.16, 0.32], mat: 'leaf', sway: 0,
    build(b, r) {
      const h = r.range(3.5, 5.2);
      b.trunk([0, 0, 0, r.range(-0.3, 0.3), h, r.range(-0.3, 0.3)], 0.28, 0.1, sp(DEAD, 1));
      for (let k = 0; k < 3; k++) {
        const y = r.range(h * 0.45, h * 0.85);
        const a = r.range(0, Math.PI * 2);
        b.line(0, y, 0, Math.cos(a) * r.range(0.7, 1.3), y + r.range(0.3, 0.9), Math.sin(a) * r.range(0.7, 1.3), 0.07, sp(DEAD, 2));
      }
      b.line(0, h * 0.7, 0, 0.6, h * 0.7 - 0.9, 0.3, 0, sp(MOSS_STRAND, 3));
    },
  },
  bush: {
    size: [2, 1.5, 2], vox: [0.12, 0.24], mat: 'leaf', sway: 0.5,
    build(b, r) {
      const n = r.int(2, 4);
      for (let i = 0; i < n; i++) b.ell(r.range(-0.35, 0.35), r.range(0.35, 0.6), r.range(-0.35, 0.35), r.range(0.45, 0.7), r.range(0.35, 0.55), r.range(0.45, 0.7), sp(OAK_LEAF, 1 + i, 0.12));
      b.caps((c, x, y, z) => (hashVox(x, y, z, 5) < 0.04 ? 0xd9c25a : hashVox(x, y, z, 6) < 0.35 ? shade(c, 1.15) : c));
    },
  },
  fern: {
    size: [1.8, 0.9, 1.8], vox: [0.08, 0.16], mat: 'leaf', sway: 0.8,
    build(b, r) {
      const n = r.int(6, 9);
      const col = sp([0x4a7a2a, 0x3f6e24, 0x568a32], 1, 0.1);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + r.range(-0.2, 0.2);
        const l = r.range(0.55, 0.8);
        const mx = Math.cos(a) * l * 0.55;
        const mz = Math.sin(a) * l * 0.55;
        b.line(0, 0.05, 0, mx, 0.55, mz, 0.04, col);
        b.line(mx, 0.55, mz, Math.cos(a) * l, 0.3, Math.sin(a) * l, 0.04, col);
      }
    },
  },
  mossrock: {
    size: [2.4, 1.6, 2.4], vox: [0.12, 0.24], mat: 'leaf', sway: 0,
    build(b, r) {
      const n = r.int(2, 3);
      for (let i = 0; i < n; i++) b.ell(r.range(-0.3, 0.3), r.range(0.25, 0.45), r.range(-0.3, 0.3), r.range(0.6, 0.95), r.range(0.45, 0.75), r.range(0.55, 0.9), sp(GREYROCK, 1 + i, 0.1));
      b.caps((c, x, y, z) => (hashVox(x, y, z, 7) < 0.75 ? sp([0x3f5f22, 0x4a6b26, 0x56762e], 8)(x, y, z) : c));
    },
  },
  log: {
    size: [3.4, 0.9, 0.9], vox: [0.12, 0.24], mat: 'leaf', sway: 0,
    build(b, r) {
      const len = r.range(2.4, 3.2);
      const rr = r.range(0.28, 0.38);
      const g = b.g;
      const col = sp(BARK, 1);
      for (let x = -len / 2; x <= len / 2; x += 1 / b.v) b.ell(x, rr, 0, 0.06, rr, rr, col);
      b.ell(-len / 2, rr, 0, 0.06, rr * 0.8, rr * 0.8, 0xa08060);
      b.ell(len / 2, rr, 0, 0.06, rr * 0.8, rr * 0.8, 0xa08060);
      b.caps((c, x, y, z) => (y > g.ny * 0.5 && hashVox(x, y, z, 3) < 0.6 ? sp([0x4a6b26, 0x3f5f22], 4)(x, y, z) : c));
    },
  },
  reeds: {
    size: [1.4, 2, 1.4], vox: [0.07, 0.14], mat: 'leaf', sway: 1.2,
    build(b, r) {
      const n = r.int(10, 16);
      for (let i = 0; i < n; i++) {
        const x = r.range(-0.5, 0.5);
        const z = r.range(-0.5, 0.5);
        const h = r.range(0.9, 1.8);
        b.line(x, 0, z, x + r.range(-0.15, 0.15), h, z + r.range(-0.15, 0.15), 0, sp([0x6f8a3a, 0x7a9442, 0x8a9a52, 0x9a9a62], 1 + i));
        if (r.chance(0.35)) b.ell(x, h * 0.85, z, 0.04, 0.12, 0.04, 0x5a3a22);
      }
    },
  },
  lilypads: {
    size: [2.2, 0.2, 2.2], vox: [0.08, 0.16], mat: 'leaf', sway: 0,
    build(b, r) {
      const n = r.int(3, 5);
      for (let i = 0; i < n; i++) {
        const x = r.range(-0.7, 0.7);
        const z = r.range(-0.7, 0.7);
        const rad = r.range(0.2, 0.42);
        b.cyl(x, z, rad, 0, 0.05, sp([0x4f7a2e, 0x5a8a34, 0x47702a], 1 + i, 0.08));
        if (i === 0 && r.chance(0.6)) b.ell(x, 0.1, z, 0.08, 0.08, 0.08, 0xf0a0c8);
      }
    },
  },
  pine: {
    size: [3.6, 8, 3.6], vox: [0.19, 0.29], mat: 'leaf', sway: 0.5,
    build(b, r) {
      const h = r.range(5.6, 7.4);
      b.cyl(0, 0, 0.2, 0, h, sp(BARK, 1));
      const tiers = r.int(5, 6);
      for (let i = 0; i < tiers; i++) {
        const t = i / tiers;
        const y0 = 1.1 + t * (h - 1.3);
        const rad = 1.55 * (1 - t * 0.78);
        for (let y = y0; y < y0 + 1.1; y += 1 / b.v) {
          const k = (y - y0) / 1.1;
          b.cyl(0, 0, Math.max(0.12, rad * (1 - k)), y, y + 1 / b.v, sp(PINE, 2 + i, 0.08));
        }
      }
      b.caps((c, x, y, z) => (y > 3 && hashVox(x, y, z, 9) < 0.78 ? sp(SNOW, 10, 0.03)(x, y, z) : c));
    },
  },
  snowpine: {
    size: [3.2, 7, 3.2], vox: [0.17, 0.26], mat: 'leaf', sway: 0.4,
    build(b, r) {
      const h = r.range(4.6, 6.4);
      b.cyl(0, 0, 0.18, 0, h, sp(BARK, 1));
      const tiers = r.int(4, 5);
      for (let i = 0; i < tiers; i++) {
        const t = i / tiers;
        const y0 = 0.8 + t * (h - 1);
        const rad = 1.35 * (1 - t * 0.75);
        for (let y = y0; y < y0 + 1.15; y += 1 / b.v) {
          const k = (y - y0) / 1.15;
          b.cyl(0, 0, Math.max(0.1, rad * (1 - k)), y, y + 1 / b.v, (x, yy, z) => (hashVox(x, yy, z, 3) < 0.45 ? sp(SNOW, 4)(x, yy, z) : sp(PINE, 5)(x, yy, z)));
        }
      }
      b.caps((c, x, y, z) => (hashVox(x, y, z, 9) < 0.9 ? sp(SNOW, 10, 0.03)(x, y, z) : c));
    },
  },
  icerock: {
    size: [2.8, 1.9, 2.8], vox: [0.13, 0.26], mat: 'leaf', sway: 0,
    build(b, r) {
      const n = r.int(2, 4);
      for (let i = 0; i < n; i++) b.ell(r.range(-0.4, 0.4), r.range(0.3, 0.6), r.range(-0.4, 0.4), r.range(0.55, 1.0), r.range(0.5, 0.85), r.range(0.55, 0.95), sp([0x7d8da0, 0x6c7c90, 0x8e9db0, 0x5f6f84], 1 + i, 0.08));
      b.caps((c, x, y, z) => (hashVox(x, y, z, 4) < 0.85 ? sp(SNOW, 5, 0.03)(x, y, z) : c));
    },
  },
  iceshard: {
    size: [1.6, 2.8, 1.6], vox: [0.1, 0.2], mat: 'shiny', sway: 0,
    build(b, r) {
      const n = r.int(2, 4);
      for (let i = 0; i < n; i++) {
        const a = r.range(0, Math.PI * 2);
        const tilt = r.range(0.1, 0.45);
        const h = r.range(1.1, 2.5);
        b.line(0, 0, 0, Math.cos(a) * h * tilt, h, Math.sin(a) * h * tilt, r.range(0.12, 0.24), sp(ICE, 1 + i, 0.06));
      }
    },
  },
  snowbush: {
    size: [2, 1.2, 2], vox: [0.12, 0.24], mat: 'leaf', sway: 0,
    build(b, r) {
      b.ell(0, 0.3, 0, r.range(0.6, 0.85), r.range(0.35, 0.55), r.range(0.6, 0.85), sp(SNOW, 1, 0.03));
      for (let i = 0; i < 4; i++) {
        const a = r.range(0, Math.PI * 2);
        b.line(Math.cos(a) * 0.3, 0.4, Math.sin(a) * 0.3, Math.cos(a) * 0.7, 0.95, Math.sin(a) * 0.7, 0, 0x4a3a2c);
      }
    },
  },
  iceberg: {
    size: [7, 4, 7], vox: [0.26, 0.5], mat: 'shiny', sway: 0,
    build(b, r) {
      const n = r.int(3, 5);
      for (let i = 0; i < n; i++) b.ell(r.range(-1.2, 1.2), r.range(0.6, 1.4), r.range(-1.2, 1.2), r.range(1.2, 2.4), r.range(0.9, 2.0), r.range(1.2, 2.4), sp(ICE, 1 + i, 0.06));
      b.caps((c, x, y, z) => sp(SNOW, 7, 0.03)(x, y, z));
    },
  },
  floe: {
    size: [4.4, 0.6, 4.4], vox: [0.2, 0.4], mat: 'shiny', sway: 0,
    build(b, r) {
      const n = r.int(2, 4);
      for (let i = 0; i < n; i++) b.cyl(r.range(-0.8, 0.8), r.range(-0.8, 0.8), r.range(0.8, 1.5), 0, 0.4, sp([0xdcebf5, 0xcfe2ef, 0xe8f2f9], 1 + i, 0.04));
    },
  },
  palm: {
    size: [6, 7.8, 6], vox: [0.16, 0.25], mat: 'leaf', sway: 1,
    build(b, r) {
      const h = r.range(5.2, 6.6);
      const bend = r.range(0.8, 1.6);
      const pts: number[] = [];
      for (let i = 0; i <= 5; i++) {
        const t = i / 5;
        pts.push(bend * t * t, h * t, 0);
      }
      const ring = (x: number, y: number, z: number) => (y % 3 === 0 ? shade(PALM_BARK[3], 0.9) : sp(PALM_BARK, 2)(x, y, z));
      b.trunk(pts, 0.26, 0.17, ring);
      const tx = bend;
      const fr = r.int(7, 9);
      for (let i = 0; i < fr; i++) {
        const a = (i / fr) * Math.PI * 2 + r.range(-0.2, 0.2);
        const l = r.range(2.0, 2.7);
        const mx = tx + Math.cos(a) * l * 0.5;
        const mz = Math.sin(a) * l * 0.5;
        const leaf = sp(PALM_LEAF, 3 + i, 0.08);
        b.line(tx, h, 0, mx, h + 0.45, mz, 0.13, leaf);
        b.line(mx, h + 0.45, mz, tx + Math.cos(a) * l, h - r.range(0.6, 1.2), Math.sin(a) * l, 0.1, leaf);
      }
      for (let i = 0; i < 3; i++) b.ell(tx + r.range(-0.2, 0.2), h - 0.25, r.range(-0.2, 0.2), 0.14, 0.14, 0.14, 0x6a4a2a);
    },
  },
  jbush: {
    size: [2.6, 1.9, 2.6], vox: [0.12, 0.24], mat: 'leaf', sway: 0.6,
    build(b, r) {
      const n = r.int(3, 5);
      for (let i = 0; i < n; i++) b.ell(r.range(-0.5, 0.5), r.range(0.45, 0.85), r.range(-0.5, 0.5), r.range(0.5, 0.85), r.range(0.4, 0.65), r.range(0.5, 0.85), sp(JUNGLE, 1 + i, 0.12));
      const flower = r.pick([0xe84a3a, 0xf2a03a, 0xe85aa0, 0xf5e04a]);
      b.caps((c, x, y, z) => (hashVox(x, y, z, 5) < 0.05 ? flower : hashVox(x, y, z, 6) < 0.4 ? shade(c, 1.15) : c));
    },
  },
  sandrock: {
    size: [3, 2.2, 3], vox: [0.13, 0.26], mat: 'leaf', sway: 0,
    build(b, r) {
      const n = r.int(2, 4);
      for (let i = 0; i < n; i++) b.ell(r.range(-0.5, 0.5), r.range(0.3, 0.7), r.range(-0.5, 0.5), r.range(0.6, 1.1), r.range(0.5, 0.95), r.range(0.6, 1.1), (x, y, z) => shade(SANDSTONE[(y >> 1) % SANDSTONE.length], 1 + (hashVox(x, y, z, 3) - 0.5) * 0.12));
      b.caps((c, x, y, z) => (hashVox(x, y, z, 4) < 0.25 ? sp([0x5a8a3a, 0x6a9a44], 5)(x, y, z) : c));
    },
  },
  searock: {
    size: [3.4, 2.6, 3.4], vox: [0.15, 0.3], mat: 'shiny', sway: 0,
    build(b, r) {
      const n = r.int(2, 4);
      for (let i = 0; i < n; i++) b.ell(r.range(-0.6, 0.6), r.range(0.4, 0.9), r.range(-0.6, 0.6), r.range(0.7, 1.3), r.range(0.6, 1.2), r.range(0.7, 1.3), sp(DARKROCK, 1 + i, 0.1));
      b.caps((c, x, y, z) => (hashVox(x, y, z, 4) < 0.15 ? 0xf2f2ee : c));
    },
  },
  beachgrass: {
    size: [1.2, 0.9, 1.2], vox: [0.07, 0.14], mat: 'leaf', sway: 1,
    build(b, r) {
      const n = r.int(8, 12);
      for (let i = 0; i < n; i++) {
        const a = r.range(0, Math.PI * 2);
        const l = r.range(0.2, 0.45);
        b.line(0, 0, 0, Math.cos(a) * l, r.range(0.4, 0.8), Math.sin(a) * l, 0, sp([0x9aa860, 0x8a9a50, 0xb0b870, 0x7f9048], 1 + i));
      }
    },
  },
  driftwood: {
    size: [3, 0.6, 1.2], vox: [0.1, 0.2], mat: 'leaf', sway: 0,
    build(b, r) {
      const l = r.range(1.8, 2.6);
      b.line(-l / 2, 0.15, r.range(-0.2, 0.2), l / 2, 0.2, r.range(-0.2, 0.2), r.range(0.1, 0.16), sp([0xb8ab95, 0xa89a82, 0xc6baa4], 1));
      b.line(0.2, 0.18, 0, 0.6, 0.35, 0.45, 0.06, sp([0xb8ab95, 0xa89a82], 2));
    },
  },
  crate: {
    size: [1.3, 1.3, 1.3], vox: [0.1, 0.2], mat: 'leaf', sway: 0,
    build(b, r) {
      const s = r.range(0.5, 0.6);
      b.box(-s, 0, -s, s, s * 2, s, (x, y, z) => (y % 4 === 0 ? shade(PLANK[3], 0.85) : sp(PLANK, 1)(x, y, z)));
    },
  },
  barrel: {
    size: [1, 1.2, 1], vox: [0.08, 0.16], mat: 'leaf', sway: 0,
    build(b, r) {
      b.cyl(0, 0, 0.36, 0, 1.0, (x, y, z) => (y % 5 === 1 ? IRON[0] : sp(PLANK, 2)(x, y, z)));
      b.cyl(0, 0, 0.4, 0.35, 0.65, sp(PLANK, 3));
      void r;
    },
  },
  boat: {
    size: [5.4, 2.4, 2.4], vox: [0.12, 0.24], mat: 'leaf', sway: 0,
    build(b, r) {
      const hull = r.pick([0x2f4a6a, 0x6a2f2f, 0x2f5a3a, 0x5a4a2a]);
      for (let x = -2.4; x <= 2.4; x += 1 / b.v) {
        const t = Math.abs(x) / 2.4;
        const w = 0.95 * Math.sqrt(Math.max(0, 1 - t * t * t));
        b.box(x, 0.0, -w, x + 1 / b.v, 0.55, w, (xx, y, z) => (y >= 4 ? 0xd8d0c0 : shade(hull, 0.9 + hashVox(xx, y, z, 3) * 0.2)));
        b.box(x, 0.45, -w + 0.12, x + 1 / b.v, 0.56, w - 0.12, sp(PLANK, 4));
      }
      b.box(-0.9, 0.5, -0.6, 0.6, 1.5, 0.6, sp([0xd8d0c0, 0xcfc6b4], 5));
      b.box(-1.0, 1.5, -0.7, 0.7, 1.65, 0.7, sp([0x5a3a2a, 0x4a3022], 6));
      b.box(-0.6, 0.95, -0.62, -0.2, 1.25, 0.62, 0x2a3a4a);
    },
  },
  crane: {
    size: [7, 15, 3.6], vox: [0.25, 0.5], mat: 'leaf', sway: 0,
    build(b, r) {
      const rust = sp(RUST, 1, 0.1);
      // legs
      b.box(-1.2, 0, -1.2, -0.8, 9, -0.8, rust);
      b.box(0.8, 0, -1.2, 1.2, 9, -0.8, rust);
      b.box(-1.2, 0, 0.8, -0.8, 9, 1.2, rust);
      b.box(0.8, 0, 0.8, 1.2, 9, 1.2, rust);
      for (let y = 1.5; y < 9; y += 2.2) b.box(-1.2, y, -1.2, 1.2, y + 0.3, 1.2, (x, yy, z) => (b.g.solid(x, yy, z) ? rust(x, yy, z) : rust(x, yy, z)));
      // cab and jib
      b.box(-1.4, 9, -1.4, 1.4, 11, 1.4, sp([0xd8a020, 0xc89018], 2));
      b.box(-0.9, 9.8, -1.45, 0.9, 10.6, -1.35, 0x203040);
      b.box(-3.4, 11, -0.3, 3.4, 11.6, 0.3, rust);
      b.line(3.2, 11, 0, 3.2, 6.5, 0, 0, sp(IRON, 3));
      b.box(2.95, 6.1, -0.25, 3.45, 6.5, 0.25, sp(IRON, 4));
      void r;
    },
  },
  lamp: {
    size: [0.8, 4.2, 0.8], vox: [0.1, 0.2], mat: 'glow', sway: 0,
    build(b, r) {
      b.cyl(0, 0, 0.18, 0, 0.3, sp(IRON, 1));
      b.cyl(0, 0, 0.08, 0.3, 3.4, sp(IRON, 2));
      b.box(-0.25, 3.4, -0.25, 0.25, 3.9, 0.25, 0xffd590);
      b.box(-0.3, 3.9, -0.3, 0.3, 4.0, 0.3, sp(IRON, 3));
      void r;
    },
  },
  bollard: {
    size: [0.7, 0.8, 0.7], vox: [0.08, 0.16], mat: 'leaf', sway: 0,
    build(b, r) {
      b.cyl(0, 0, 0.22, 0, 0.6, sp(IRON, 1));
      b.cyl(0, 0, 0.3, 0.6, 0.7, sp(IRON, 2));
      void r;
    },
  },
  chimney: {
    size: [1.2, 2.4, 1.2], vox: [0.12, 0.24], mat: 'leaf', sway: 0,
    build(b, r) {
      b.box(-0.45, 0, -0.45, 0.45, 2.0, 0.45, (x, y, z) => shade((x + y) % 2 ? 0x7a4332 : 0x6e3b2c, 0.9 + hashVox(x, y, z, 3) * 0.2));
      b.box(-0.55, 2.0, -0.55, 0.55, 2.2, 0.55, 0x4a4a4e);
      void r;
    },
  },
  pebble: {
    size: [0.8, 0.3, 0.8], vox: [0.05, 0.05], mat: 'leaf', sway: 0,
    build(b, r) {
      const n = r.int(2, 5);
      for (let i = 0; i < n; i++) b.ell(r.range(-0.25, 0.25), 0.03, r.range(-0.25, 0.25), r.range(0.05, 0.11), r.range(0.04, 0.08), r.range(0.05, 0.1), sp([0x8a877c, 0x77756b, 0x9d9a8e, 0x6a685f], 1 + i, 0.08));
    },
  },
  root: {
    size: [1.6, 0.5, 1.2], vox: [0.06, 0.06], mat: 'leaf', sway: 0,
    build(b, r) {
      const col = sp([0x4a3824, 0x3f2f1e, 0x55402a], 1, 0.08);
      for (let i = 0; i < 2; i++) {
        const z = r.range(-0.3, 0.3);
        b.line(-0.6, 0.02, z, 0, r.range(0.18, 0.3), z + r.range(-0.2, 0.2), 0.05, col);
        b.line(0, 0.22, z, 0.65, 0.0, z + r.range(-0.25, 0.25), 0.045, col);
      }
    },
  },
  shellbits: {
    size: [0.8, 0.2, 0.8], vox: [0.05, 0.05], mat: 'leaf', sway: 0,
    build(b, r) {
      const n = r.int(2, 5);
      for (let i = 0; i < n; i++) b.ell(r.range(-0.25, 0.25), 0.02, r.range(-0.25, 0.25), r.range(0.04, 0.08), 0.03, r.range(0.04, 0.08), sp([0xf4e6d4, 0xf0c8b8, 0xe8d8c0, 0xd8a890], 1 + i, 0.05));
    },
  },
  icebits: {
    size: [0.8, 0.4, 0.8], vox: [0.05, 0.05], mat: 'shiny', sway: 0,
    build(b, r) {
      const n = r.int(2, 4);
      for (let i = 0; i < n; i++) b.line(r.range(-0.2, 0.2), 0, r.range(-0.2, 0.2), r.range(-0.25, 0.25), r.range(0.1, 0.3), r.range(-0.25, 0.25), 0.04, sp(ICE, 1 + i, 0.05));
    },
  },
  cobbles: {
    size: [0.9, 0.2, 0.9], vox: [0.05, 0.05], mat: 'leaf', sway: 0,
    build(b, r) {
      const n = r.int(2, 4);
      for (let i = 0; i < n; i++) b.box(r.range(-0.3, 0.15), 0, r.range(-0.3, 0.15), r.range(0.2, 0.32), 0.08, r.range(0.2, 0.32), sp([0x5a5a5e, 0x4e4e52, 0x66666a], 1 + i, 0.06));
    },
  },
};

const VARIANTS = 3;
const TEMPLATES = new Map<string, THREE.BufferGeometry>();

interface Placed {
  model: ModelKind;
  lod: 0 | 1;
  variant: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  shadow: boolean;
}

export interface BackdropEnv {
  ground: (x: number, z: number) => number;
  water: () => number; // backdrop water level at build time
  /** distance outside the play rectangle */
  outside: (x: number, z: number) => number;
  quality: Quality;
  bounds: { x0: number; x1: number; z0: number; z1: number };
  /** play area half extents: keeps canopies off the sides and tall models off the near edge */
  halfW: number;
  halfD: number;
  /** skip the play-area guards (micro detail inside the map) */
  inside?: boolean;
}

export interface FloraView {
  group: THREE.Group;
  update(time: number): void;
  dispose(): void;
}

export function buildFlora(rules: BackdropRule[], env: BackdropEnv, seed: number): FloraView {
  const q = env.quality;
  const densityMul = q === 'low' ? 0.5 : q === 'medium' ? 0.8 : q === 'high' ? 1 : 1.15;
  const hiDist = q === 'low' ? -1 : q === 'medium' ? 4 : q === 'high' ? 9 : 16;
  const shadows = q === 'high' || q === 'ultra';
  const placed: Placed[] = [];
  rules.forEach((rule, ri) => {
    const rng = new Rng((seed * 31 + ri * 977) >>> 0);
    const s = rule.spacing / Math.sqrt(densityMul);
    for (let z = env.bounds.z0; z < env.bounds.z1; z += s) {
      for (let x = env.bounds.x0; x < env.bounds.x1; x += s) {
        const px = x + rng.range(0.1, 0.9) * s;
        const pz = z + rng.range(0.1, 0.9) * s;
        const roll = rng.next();
        const yawR = rng.range(0, Math.PI * 2);
        const scR = rng.next();
        const vr = rng.int(0, VARIANTS - 1);
        const d = rule.density(px, pz);
        if (d <= 0 || roll > d) continue;
        let y = env.ground(px, pz);
        if (rule.onWater) {
          if (y > env.water() - 0.3) continue; // needs water under it
          y = env.water();
        } else if (rule.waterline) y = Math.max(y, env.water() - 0.25);
        else if (!rule.underwater && y < env.water() + 0.08) continue; // dry-land model, never in the water
        y += rule.yOffset ?? 0;
        const o = env.outside(px, pz);
        const sc = rule.scale[0] + (rule.scale[1] - rule.scale[0]) * scR;
        if (!env.inside) {
          const def = MODELS[rule.model];
          // the camera sits on the +Z side: nothing tall just past the near edge
          if (pz > env.halfD && def.size[1] * sc > 1.2 * (pz - env.halfD) + 0.4) continue;
          // canopies must not hang over units standing at the side edges
          const rad = Math.max(def.size[0], def.size[2]) * 0.5 * sc * 0.85;
          if (Math.abs(pz) < env.halfD + rad && Math.abs(px) - env.halfW < rad - 0.4 && def.size[1] > 1.6) continue;
        }
        placed.push({
          model: rule.model,
          lod: o < hiDist ? 0 : 1,
          variant: vr,
          x: px,
          y,
          z: pz,
          yaw: rule.yaw ? rule.yaw(px, pz) : yawR,
          scale: sc,
          shadow: shadows && !!rule.castShadow && o < 14,
        });
      }
    }
  });

  // build only the geometries that are used (CPU-side templates, cached for later matches;
  // BatchedMesh copies them into its own GPU buffers)
  const geoKey = (p: Placed) => `${p.model}:${p.lod}:${p.variant}`;
  for (const p of placed) {
    const k = geoKey(p);
    if (TEMPLATES.has(k)) continue;
    const def = MODELS[p.model];
    const b = new VB(def.size, def.vox[p.lod]);
    def.build(b, new Rng(hashSeed(p.model, p.variant)));
    TEMPLATES.set(k, meshVoxelsFast(b.g, def.vox[p.lod], 0.45));
  }
  const geoms = TEMPLATES;

  const mats: Record<Mat, THREE.MeshStandardMaterial> = {
    leaf: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0 }),
    shiny: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 0.05 }),
    glow: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2, emissive: new THREE.Color(0xffb050), emissiveIntensity: 0.35 }),
  };
  const sway = { uTime: { value: 0 } };
  const patchSway = (m: THREE.MeshStandardMaterial) => {
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = sway.uTime;
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;').replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
{
  vec3 hwIP = vec3(0.0);
  #ifdef USE_BATCHING
  hwIP = batchingMatrix[3].xyz;
  #endif
  float hwS = max(0.0, transformed.y - 1.0);
  transformed.x += sin(uTime * 1.25 + hwIP.x * 0.37 + hwIP.z * 0.21) * 0.018 * hwS;
  transformed.z += cos(uTime * 1.05 + hwIP.z * 0.31 + hwIP.x * 0.13) * 0.013 * hwS;
}`,
      );
    };
    m.customProgramCacheKey = () => 'hw-flora-sway';
  };
  patchSway(mats.leaf);

  const group = new THREE.Group();
  group.name = 'backdrop-flora';
  const meshes: THREE.BatchedMesh[] = [];
  const mtx = new THREE.Matrix4();
  const qt = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const tint = new THREE.Color();
  for (const matKey of ['leaf', 'shiny', 'glow'] as Mat[]) {
    for (const shadow of [true, false]) {
      const list = placed.filter((p) => MODELS[p.model].mat === matKey && p.shadow === shadow);
      if (!list.length) continue;
      const used = new Map<string, number>();
      let vCount = 0;
      let iCount = 0;
      for (const p of list) {
        const k = geoKey(p);
        if (used.has(k)) continue;
        used.set(k, -1);
        const g = geoms.get(k)!;
        vCount += g.attributes.position.count;
        iCount += g.index ? g.index.count : g.attributes.position.count;
      }
      const bm = new THREE.BatchedMesh(list.length, vCount, iCount, mats[matKey]);
      for (const k of used.keys()) used.set(k, bm.addGeometry(geoms.get(k)!));
      for (const p of list) {
        const id = bm.addInstance(used.get(geoKey(p))!);
        qt.setFromAxisAngle(up, p.yaw);
        pos.set(p.x, p.y, p.z);
        scl.setScalar(p.scale);
        mtx.compose(pos, qt, scl);
        bm.setMatrixAt(id, mtx);
        const t = 0.9 + hashVox(Math.round(p.x * 10), 0, Math.round(p.z * 10), 5) * 0.2;
        bm.setColorAt(id, tint.setRGB(t, t, t));
      }
      bm.castShadow = shadow;
      bm.receiveShadow = true;
      bm.name = `flora-${matKey}${shadow ? '-cast' : ''}`;
      meshes.push(bm);
      group.add(bm);
    }
  }
  return {
    group,
    update(time: number) {
      sway.uTime.value = time;
    },
    dispose() {
      for (const m of meshes) m.dispose();
      for (const m of Object.values(mats)) m.dispose();
    },
  };
}

function hashSeed(model: string, variant: number): number {
  let h = 2166136261;
  for (let i = 0; i < model.length; i++) h = Math.imul(h ^ model.charCodeAt(i), 16777619);
  return (h ^ (variant * 0x9e3779b1)) >>> 0;
}

export { mix };

