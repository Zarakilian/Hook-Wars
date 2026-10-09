// Voxel grid for Pudgy parts. Same VoxelGrid / meshVoxels pipeline as every other model, plus a
// per-voxel surface channel (skin, cloth, rubber, iron, brass, wet, glow, pulse-glow) and a premium
// flag (gilded, chrome, pearl, amethyst: shinier and sparkling, used by premium items).
// Voxel value layout: bits 0-2 channel, bit 3 premium, bits 4-23 colour (the lowest blue nibble is
// dropped), bit 24 team colour (TEAM_BIT). The greedy mesher never merges faces across channels, and after meshing each quad looks
// its voxel up again to write a `surf` vertex attribute (roughness, metalness, glow A, glow B).
// One shared shader reads `surf`, so every part is a single draw call whatever it is made of.
//
// Resolution: grids are authored in skeleton units (VOX metres) but can be sampled finer
// (res = fine voxels per unit, 2 for the showcase detail). Coarse calls (set, box, paint, add)
// cover whole unit cells so details keep their physical size; shape helpers (blob, shell, cyl, tube)
// sample at the fine resolution so curves get smoother; dot()/setF() paint single fine voxels for
// showcase-only extras. Colour and test callbacks always receive integer unit-cell coordinates;
// hv() gives per-fine-voxel noise inside them, and P holds the precise centre of the voxel.
import * as THREE from 'three';
import { cinematicEnabled } from '../../cinematic.ts';
import { hashVox, meshVoxels, mix, shade, VoxelGrid } from '../../voxel/voxel.ts';

/** metres per skeleton unit (one voxel at 'game' detail) */
export const VOX = 0.05;

/** Surface channels. */
export const CH = {
  cloth: 0, // fabric, hair, moss, wood: very rough
  skin: 1, // skin, leather: soft sheen
  rubber: 2, // rubber, oilskin, gloss paint, plates
  iron: 3, // iron, steel
  brass: 4, // brass, gold, copper
  wet: 5, // eyes, teeth, slime, bone gloss
  glow: 6, // emissive, steady (visor, lamps) scaled by the glowA uniform
  pulse: 7, // emissive, pulsing (steam vents, glow spots, fireflies, cigar ember) scaled by glowB
} as const;
export type Channel = (typeof CH)[keyof typeof CH];

// roughness, metalness, glowA, glowB per channel. The engine always sets a sky environment map,
// so metals can be properly metallic.
const SURF: readonly (readonly [number, number, number, number])[] = [
  [0.92, 0, 0, 0],
  [0.62, 0, 0, 0],
  [0.3, 0, 0, 0],
  // iron: weathered, satin steel. Voxel faces are flat, so a glossier iron mirrors the key light and
  // the Locker's bright room environment across a whole co-planar face and a dark forearm reads white
  // (finding 34: the bot's left arm read pale grey at roughness 0.42 to 0.56; 0.72 keeps a soft sheen)
  [0.72, 0.5, 0, 0],
  [0.3, 0.85, 0, 0],
  [0.14, 0, 0, 0],
  [0.5, 0, 1, 0],
  [0.5, 0, 0, 1],
];
// premium variants; roughness + 2 marks the sparkle (decoded in material.ts)
const SURF_PREMIUM: readonly (readonly [number, number, number, number])[] = [
  [2.7, 0, 0, 0],
  [2.4, 0.1, 0, 0],
  [2.12, 0.2, 0, 0],
  [2.05, 1, 0, 0], // mirror chrome
  [2.12, 1, 0, 0], // gilded
  [2.06, 0.15, 0, 0], // pearl
  [2.2, 0.1, 1, 0], // amethyst, ruby lamps
  [2.3, 0, 0, 1],
];

export type ColorFn = (x: number, y: number, z: number) => number;
export type Paint = number | ColorFn;
export type Test = (x: number, y: number, z: number) => boolean;

// ---------------------------------------------------------------------------------------------
// Build resolution and the paint context
// ---------------------------------------------------------------------------------------------

let BUILD_RES = 1;

/** Run fn with every new RGrid sampled at `res` fine voxels per unit. */
export function atRes<T>(res: number, fn: () => T): T {
  const prev = BUILD_RES;
  BUILD_RES = res;
  try {
    return fn();
  } finally {
    BUILD_RES = prev;
  }
}

/** Resolution of grids built right now (1 = game, 2 = showcase). */
export function buildRes(): number {
  return BUILD_RES;
}

/** Precise centre (unit coordinates) of the voxel being painted; valid inside colour / test callbacks. */
export const P = { x: 0, y: 0, z: 0 };
let CR = 1;
let CX = 0;
let CY = 0;
let CZ = 0;
let FI = 0;
let FJ = 0;
let FK = 0;

function ctx(res: number, fi: number, fj: number, fk: number): void {
  CR = res;
  FI = fi;
  FJ = fj;
  FK = fk;
  CX = Math.floor(fi / res);
  CY = Math.floor(fj / res);
  CZ = Math.floor(fk / res);
  P.x = (fi + 0.5) / res;
  P.y = (fj + 0.5) / res;
  P.z = (fk + 0.5) / res;
}

/** Hash noise 0..1 that varies per fine voxel when called with the cell being painted. */
export function hv(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  if (CR > 1 && xi === CX && yi === CY && zi === CZ) return hashVox(FI, FJ, FK, seed);
  return hashVox(xi, yi, zi, seed);
}

function pick(c: Paint, x: number, y: number, z: number): number {
  return typeof c === 'function' ? c(x, y, z) : c;
}

/**
 * Bit 24: a team-coloured voxel (team cloth, paint and trims; paints made with teamTone). meshPart
 * flags it in `surf` (metalness + 2) and the shader adds a small self-lit team term, so the team
 * hue survives tinted map light (Mirelight's sunset, Lanternwharf's moonlight).
 */
export const TEAM_BIT = 1 << 24;
const KEEP = 0xf | TEAM_BIT; // channel, premium and team bits
const RGB = 0xfffff0;

type TeamTagged = ColorFn & { team?: true };

/** Mark a paint as team colour: every voxel it paints carries TEAM_BIT. Returns the same function. */
export function teamTone(fn: ColorFn): ColorFn {
  (fn as TeamTagged).team = true;
  return fn;
}

function teamBitOf(c: Paint): number {
  return typeof c === 'function' && (c as TeamTagged).team ? TEAM_BIT : 0;
}

/**
 * Grid painted in skeleton unit coordinates: (0,0,0) is the ground under the character's centre,
 * +x is the character's left, +y up, +z forward. The grid covers [ox, ox+nx) units etc.
 */
export class RGrid extends VoxelGrid {
  /** channel written by every paint call */
  ch: Channel = CH.cloth;
  /** premium flag written by every paint call (0 | 1) */
  prem = 0;
  readonly res: number;
  /** size in units */
  readonly ux: number;
  readonly uy: number;
  readonly uz: number;
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;

  constructor(nx: number, ny: number, nz: number, ox = -nx / 2, oy = 0, oz = -nz / 2, res = BUILD_RES) {
    super(nx * res, ny * res, nz * res);
    this.res = res;
    this.ux = nx;
    this.uy = ny;
    this.uz = nz;
    this.ox = Math.floor(ox);
    this.oy = Math.floor(oy);
    this.oz = Math.floor(oz);
  }

  private code(color: number): number {
    return (color & RGB) | (this.prem << 3) | this.ch;
  }

  /** local fine index of absolute fine coords, -1 outside */
  private li(fi: number, fj: number, fk: number): number {
    const i = fi - this.ox * this.res;
    const j = fj - this.oy * this.res;
    const k = fk - this.oz * this.res;
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return -1;
    return i + this.nx * (j + this.ny * k);
  }

  private emit(fi: number, fj: number, fk: number, c: Paint): void {
    const i = this.li(fi, fj, fk);
    if (i < 0) return;
    let col: number;
    if (typeof c === 'function') {
      ctx(this.res, fi, fj, fk);
      col = c(CX, CY, CZ);
    } else col = c;
    this.data[i] = col < 0 ? -1 : this.code(col) | teamBitOf(c);
  }

  /** Paint one fine voxel (absolute fine coordinates). */
  setF(fi: number, fj: number, fk: number, color: Paint): void {
    this.emit(fi, fj, fk, color);
  }

  hasF(fi: number, fj: number, fk: number): boolean {
    const i = this.li(fi, fj, fk);
    return i >= 0 && this.data[i] >= 0;
  }

  /** Paint the fine voxel containing a point (unit coordinates). At res 1 this is a whole cell. */
  dot(x: number, y: number, z: number, color: Paint): void {
    const r = this.res;
    this.emit(Math.floor(x * r), Math.floor(y * r), Math.floor(z * r), color);
  }

  /** Fill a whole unit cell. */
  override set(x: number, y: number, z: number, color: number): void {
    this.put(x, y, z, color);
  }

  /** Fill a whole unit cell with a paint. */
  put(x: number, y: number, z: number, color: Paint): void {
    const r = this.res;
    const bx = Math.floor(x) * r;
    const by = Math.floor(y) * r;
    const bz = Math.floor(z) * r;
    for (let k = 0; k < r; k++) for (let j = 0; j < r; j++) for (let i = 0; i < r; i++) this.emit(bx + i, by + j, bz + k, color);
  }

  /** Colour at a unit cell (first filled fine voxel, -1 when empty). */
  sget(x: number, y: number, z: number): number {
    const r = this.res;
    const bx = Math.floor(x) * r;
    const by = Math.floor(y) * r;
    const bz = Math.floor(z) * r;
    for (let k = 0; k < r; k++)
      for (let j = 0; j < r; j++)
        for (let i = 0; i < r; i++) {
          const li = this.li(bx + i, by + j, bz + k);
          if (li >= 0 && this.data[li] >= 0) return this.data[li];
        }
    return -1;
  }

  /** Any fine voxel filled in this unit cell. */
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

  /** Paint premium (gilded / chrome / pearl / amethyst, sparkling) inside fn. */
  premium(fn: () => void): this {
    const prev = this.prem;
    this.prem = 1;
    fn();
    this.prem = prev;
    return this;
  }

  /** Recolour the filled fine voxels of a unit cell. */
  paint(x: number, y: number, z: number, color: Paint): void {
    this.cell(x, y, z, (filled) => filled, color);
  }

  /** Fill the empty fine voxels of a unit cell. */
  add(x: number, y: number, z: number, color: Paint): void {
    this.cell(x, y, z, (filled) => !filled, color);
  }

  private cell(x: number, y: number, z: number, want: (filled: boolean) => boolean, color: Paint): void {
    const r = this.res;
    const bx = Math.floor(x) * r;
    const by = Math.floor(y) * r;
    const bz = Math.floor(z) * r;
    for (let k = 0; k < r; k++)
      for (let j = 0; j < r; j++)
        for (let i = 0; i < r; i++) {
          const li = this.li(bx + i, by + j, bz + k);
          if (li < 0 || !want(this.data[li] >= 0)) continue;
          this.emit(bx + i, by + j, bz + k, color);
        }
  }

  private surfF(fi: number, fj: number, fk: number): boolean {
    return !this.hasF(fi + 1, fj, fk) || !this.hasF(fi - 1, fj, fk) || !this.hasF(fi, fj + 1, fk) || !this.hasF(fi, fj - 1, fk) || !this.hasF(fi, fj, fk + 1) || !this.hasF(fi, fj, fk - 1);
  }

  /** Mirror the half with skeleton x < 0 onto x >= 0 (grid must be centred: ox = -nx/2). */
  mirror(): void {
    for (let k = 0; k < this.nz; k++)
      for (let j = 0; j < this.ny; j++)
        for (let i = 0; i < Math.floor(this.nx / 2); i++) this.data[this.index(this.nx - 1 - i, j, k)] = this.data[this.index(i, j, k)];
  }

  /** Visit every filled fine voxel. fn returns a new colour (channel and premium kept). */
  each(fn: (c: number, x: number, y: number, z: number) => number | void, onlySurface = false): void {
    const r = this.res;
    const fo = this.ox * r;
    const fp = this.oy * r;
    const fq = this.oz * r;
    const touched: number[] = [];
    for (let k = 0; k < this.nz; k++)
      for (let j = 0; j < this.ny; j++)
        for (let i = 0; i < this.nx; i++) {
          const li = i + this.nx * (j + this.ny * k);
          const c = this.data[li];
          if (c < 0) continue;
          if (onlySurface && !this.surfF(i + fo, j + fp, k + fq)) continue;
          ctx(r, i + fo, j + fp, k + fq);
          const out = fn(c, CX, CY, CZ);
          if (out !== undefined) touched.push(li, (out & RGB) | (c & KEEP));
        }
    // write after the scan so surface tests see the original shape
    for (let n = 0; n < touched.length; n += 2) this.data[touched[n]] = touched[n + 1];
  }

  /** Change the channel of filled voxels: fn gets the stored value, returns a channel or -1 to keep it. */
  rechannel(fn: (c: number) => number): void {
    for (let i = 0; i < this.data.length; i++) {
      const c = this.data[i];
      if (c < 0) continue;
      const ch = fn(c);
      if (ch >= 0) this.data[i] = (c & ~7) | ch;
    }
  }

  /** Repaint filled fine voxels passing a test with a new colour and channel. */
  repaint(test: Test, ch: Channel, color: Paint, onlySurface = false): void {
    const r = this.res;
    const fo = this.ox * r;
    const fp = this.oy * r;
    const fq = this.oz * r;
    const touched: number[] = [];
    const tb = teamBitOf(color);
    for (let k = 0; k < this.nz; k++)
      for (let j = 0; j < this.ny; j++)
        for (let i = 0; i < this.nx; i++) {
          const li = i + this.nx * (j + this.ny * k);
          if (this.data[li] < 0) continue;
          ctx(r, i + fo, j + fp, k + fq);
          if (!test(CX, CY, CZ)) continue;
          if (onlySurface && !this.surfF(i + fo, j + fp, k + fq)) continue;
          ctx(r, i + fo, j + fp, k + fq);
          touched.push(li, (pick(color, CX, CY, CZ) & RGB) | (this.prem << 3) | ch | tb);
        }
    for (let n = 0; n < touched.length; n += 2) this.data[touched[n]] = touched[n + 1];
  }

  /** Iterate fine voxels whose centres lie in [x0,x1]x[y0,y1]x[z0,z1] (unit coords). */
  private scan(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, fn: (fi: number, fj: number, fk: number, px: number, py: number, pz: number) => void): void {
    const r = this.res;
    const i0 = Math.max(this.ox * r, Math.floor(x0 * r));
    const i1 = Math.min((this.ox + this.ux) * r - 1, Math.ceil(x1 * r));
    const j0 = Math.max(this.oy * r, Math.floor(y0 * r));
    const j1 = Math.min((this.oy + this.uy) * r - 1, Math.ceil(y1 * r));
    const k0 = Math.max(this.oz * r, Math.floor(z0 * r));
    const k1 = Math.min((this.oz + this.uz) * r - 1, Math.ceil(z1 * r));
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) fn(i, j, k, (i + 0.5) / r, (j + 0.5) / r, (k + 0.5) / r);
  }

  private fineTest(test: Test | undefined, fi: number, fj: number, fk: number): boolean {
    if (!test) return true;
    ctx(this.res, fi, fj, fk);
    return test(CX, CY, CZ);
  }

  /** Ellipsoid shell between an inner and outer radius offset, filtered. */
  shell(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, outer: number, inner: number, test: Test, color: Paint): void {
    const ox = rx + outer;
    const oy = ry + outer;
    const oz = rz + outer;
    const ix = Math.max(0.1, rx - inner);
    const iy = Math.max(0.1, ry - inner);
    const iz = Math.max(0.1, rz - inner);
    this.scan(cx - ox, cx + ox, cy - oy, cy + oy, cz - oz, cz + oz, (fi, fj, fk, px, py, pz) => {
      const dx = px - cx;
      const dy = py - cy;
      const dz = pz - cz;
      if ((dx / ox) ** 2 + (dy / oy) ** 2 + (dz / oz) ** 2 > 1) return;
      if ((dx / ix) ** 2 + (dy / iy) ** 2 + (dz / iz) ** 2 < 1) return;
      if (!this.fineTest(test, fi, fj, fk)) return;
      this.emit(fi, fj, fk, color);
    });
  }

  /** Filled ellipsoid, filtered. */
  blob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, color: Paint, test?: Test): void {
    this.scan(cx - rx, cx + rx, cy - ry, cy + ry, cz - rz, cz + rz, (fi, fj, fk, px, py, pz) => {
      const dx = (px - cx) / rx;
      const dy = (py - cy) / ry;
      const dz = (pz - cz) / rz;
      if (dx * dx + dy * dy + dz * dz > 1) return;
      if (!this.fineTest(test, fi, fj, fk)) return;
      this.emit(fi, fj, fk, color);
    });
  }

  /** Superellipsoid (boxier blob, power p > 2), filtered. */
  sblob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, p: number, color: Paint, test?: Test): void {
    this.scan(cx - rx, cx + rx, cy - ry, cy + ry, cz - rz, cz + rz, (fi, fj, fk, px, py, pz) => {
      const dx = Math.abs((px - cx) / rx);
      const dy = Math.abs((py - cy) / ry);
      const dz = Math.abs((pz - cz) / rz);
      if (dx ** p + dy ** p + dz ** p > 1) return;
      if (!this.fineTest(test, fi, fj, fk)) return;
      this.emit(fi, fj, fk, color);
    });
  }

  override ellipsoid(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, color: Paint): void {
    this.blob(cx, cy, cz, rx, ry, rz, color);
  }

  /**
   * Cylinder along an axis through centre (a, b) on the other two axes (x,z for 'y'; y,z for 'x';
   * x,y for 'z'), covering unit cells t0..t1 inclusive along the axis.
   */
  cyl(axis: 'x' | 'y' | 'z', a: number, b: number, r: number, t0: number, t1: number, color: Paint, rb = r, test?: Test): void {
    const lo = Math.min(t0, t1);
    const hi = Math.max(t0, t1) + 0.999;
    const inside = (u: number, v: number) => {
      const du = (u - a) / r;
      const dv = (v - b) / rb;
      return du * du + dv * dv <= 1;
    };
    if (axis === 'y')
      this.scan(a - r, a + r, lo, hi, b - rb, b + rb, (fi, fj, fk, px, _py, pz) => {
        if (inside(px, pz) && this.fineTest(test, fi, fj, fk)) this.emit(fi, fj, fk, color);
      });
    else if (axis === 'x')
      this.scan(lo, hi, a - r, a + r, b - rb, b + rb, (fi, fj, fk, _px, py, pz) => {
        if (inside(py, pz) && this.fineTest(test, fi, fj, fk)) this.emit(fi, fj, fk, color);
      });
    else
      this.scan(a - r, a + r, b - rb, b + rb, lo, hi, (fi, fj, fk, px, py) => {
        if (inside(px, py) && this.fineTest(test, fi, fj, fk)) this.emit(fi, fj, fk, color);
      });
  }

  /** Thick line between two points (radius in units). Thin lines fill whole cells. */
  tube(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, r: number, color: Paint, r1 = r): void {
    const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    const steps = Math.max(1, Math.ceil(len * 2 * this.res));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      const z = z0 + (z1 - z0) * t;
      const rr = r + (r1 - r) * t;
      if (rr <= 0.55) this.put(x, y, z, color);
      else this.blob(x, y, z, rr, rr, rr, color);
    }
  }

  /** Thin line of single fine voxels (showcase hairlines, stitching). */
  fineLine(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: Paint): void {
    const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    const steps = Math.max(1, Math.ceil(len * 2 * this.res));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.dot(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t, color);
    }
  }

  /** Inclusive box of unit cells. */
  override box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: Paint): void {
    const ax = Math.floor(Math.min(x0, x1));
    const bx = Math.floor(Math.max(x0, x1));
    const ay = Math.floor(Math.min(y0, y1));
    const by = Math.floor(Math.max(y0, y1));
    const az = Math.floor(Math.min(z0, z1));
    const bz = Math.floor(Math.max(z0, z1));
    const r = this.res;
    for (let k = az * r; k < (bz + 1) * r; k++) for (let j = ay * r; j < (by + 1) * r; j++) for (let i = ax * r; i < (bx + 1) * r; i++) this.emit(i, j, k, color);
  }

  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: Paint): void {
    this.box(x0, y0, z0, x1, y1, z1, color);
  }

  /** Remove fine voxels whose cell matches a test. */
  carve(test: Test): void {
    const r = this.res;
    const fo = this.ox * r;
    const fp = this.oy * r;
    const fq = this.oz * r;
    for (let k = 0; k < this.nz; k++)
      for (let j = 0; j < this.ny; j++)
        for (let i = 0; i < this.nx; i++) {
          const li = i + this.nx * (j + this.ny * k);
          if (this.data[li] < 0) continue;
          ctx(r, i + fo, j + fp, k + fq);
          if (test(CX, CY, CZ)) this.data[li] = -1;
        }
  }

  /** Remove fine voxels by their precise centre (smooth carving). */
  carveP(test: (px: number, py: number, pz: number) => boolean): void {
    const r = this.res;
    const fo = this.ox * r;
    const fp = this.oy * r;
    const fq = this.oz * r;
    for (let k = 0; k < this.nz; k++)
      for (let j = 0; j < this.ny; j++)
        for (let i = 0; i < this.nx; i++) {
          const li = i + this.nx * (j + this.ny * k);
          if (this.data[li] < 0) continue;
          if (test((i + fo + 0.5) / r, (j + fp + 0.5) / r, (k + fq + 0.5) / r)) this.data[li] = -1;
        }
  }

  /** Copy every filled voxel of another grid (same res) into this one. */
  merge(o: RGrid): void {
    if (o.res !== this.res) throw new Error('RGrid.merge: resolution mismatch');
    const r = this.res;
    for (let k = 0; k < o.nz; k++)
      for (let j = 0; j < o.ny; j++)
        for (let i = 0; i < o.nx; i++) {
          const c = o.data[i + o.nx * (j + o.ny * k)];
          if (c < 0) continue;
          const li = this.li(i + o.ox * r, j + o.oy * r, k + o.oz * r);
          if (li >= 0) this.data[li] = c;
        }
  }
}

// ---------------------------------------------------------------------------------------------
// Colour helpers (all use hv, so they get finer in the showcase)
// ---------------------------------------------------------------------------------------------

/** Palette pick with per-voxel hash and a gentle top-lit gradient. */
export function tone(palette: readonly number[], seed: number, grad = 0, y0 = 0, y1 = 1): ColorFn {
  return (x, y, z) => {
    const h = hv(x, y, z, seed);
    const c = palette[Math.floor(h * palette.length) % palette.length];
    if (grad === 0) return c;
    const t = Math.max(0, Math.min(1, (y - y0) / Math.max(1, y1 - y0)));
    return shade(c, 1 - grad + 2 * grad * t);
  };
}

/** Base colour with brightness noise and an optional vertical gradient (lighter towards y1). */
export function jitter(base: number, amount: number, seed: number, grad = 0, y0 = 0, y1 = 1): ColorFn {
  return (x, y, z) => {
    const h = hv(x, y, z, seed) - 0.5;
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
 * each quad's voxel up in the grid. `joint` is the part's pivot in skeleton unit coordinates.
 */
export function meshPart(g: RGrid, joint: readonly [number, number, number], aoStrength = 0.52): THREE.BufferGeometry {
  const r = g.res;
  const pivot: [number, number, number] = [(joint[0] - g.ox) * r, (joint[1] - g.oy) * r, (joint[2] - g.oz) * r];
  const size = VOX / r;
  const geo = meshVoxels(g, { size, pivot, aoStrength });
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const n = pos.count;
  const surf = new Float32Array(n * 4);
  const inv = 1 / size;
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
    const vx = Math.floor((cx - nrm.getX(q) * size * 0.5) * inv + pivot[0] + 1e-4);
    const vy = Math.floor((cy - nrm.getY(q) * size * 0.5) * inv + pivot[1] + 1e-4);
    const vz = Math.floor((cz - nrm.getZ(q) * size * 0.5) * inv + pivot[2] + 1e-4);
    const c = g.get(vx, vy, vz);
    const s = c < 0 ? SURF[0] : (c & 8 ? SURF_PREMIUM : SURF)[c & 7];
    // team voxels: metalness + 2 flags the self-lit team term (decoded in material.ts)
    const team = c >= 0 && (c & TEAM_BIT) !== 0 ? 2 : 0;
    for (let k = 0; k < 4; k++) {
      const o = (q + k) * 4;
      surf[o] = s[0];
      surf[o + 1] = s[1] + team;
      surf[o + 2] = s[2];
      surf[o + 3] = s[3];
    }
  }
  geo.setAttribute('surf', new THREE.BufferAttribute(surf, 4));
  // Epic only: smooth outward normals of the whole shape for the rim and back light (material.ts)
  if (cinematicEnabled()) geo.setAttribute('pudgyN', new THREE.Int8BufferAttribute(macroNormals(g, pos, nrm, pivot, size), 4, true));
  return geo;
}

/** blur radius of the macro normals, in skeleton units (one game voxel each) */
const MACRO_R = 2;

/**
 * Epic only: a smooth "macro" normal per vertex (xyz), the outward gradient of the part's occupancy at
 * game resolution blurred over about two skeleton units, and how much bulk is behind the surface there
 * (w: 1 on bodies and heads, toward 0 on strands, drapes, straps and fingers). Voxel faces are axis
 * aligned, so a fresnel rim on them lights every grazing face of every voxel step across the whole body
 * (stripes); on the macro normal it follows the silhouette of the shape, like the rim in the reference
 * sheets, and the bulk keeps thin strands from glowing all over.
 */
function macroNormals(g: RGrid, pos: THREE.BufferAttribute, nrm: THREE.BufferAttribute, pivot: readonly number[], size: number): Int8Array {
  const r = g.res;
  const P = MACRO_R + 2;
  const X = g.ux + 2 * P;
  const Y = g.uy + 2 * P;
  const Z = g.uz + 2 * P;
  const XY = X * Y;
  const N = XY * Z;
  // occupancy of each unit cell (share of its fine voxels filled), in a padded box
  let a = new Float32Array(N);
  const share = 1 / (r * r * r);
  const nx = g.nx;
  const ny = g.ny;
  const nz = g.nz;
  const data = g.data;
  for (let k = 0; k < nz; k++) {
    const ck = ((k / r) | 0) + P;
    for (let j = 0; j < ny; j++) {
      const row = X * (((j / r) | 0) + P) + XY * ck + P;
      const src = nx * (j + ny * k);
      for (let i = 0; i < nx; i++) if (data[src + i] >= 0) a[row + ((i / r) | 0)] += share;
    }
  }
  // separable box blur, width 2 * MACRO_R + 1, as running sums along x, y and z
  const W = 2 * MACRO_R + 1;
  const dims = [X, Y, Z];
  const strides = [1, X, XY];
  for (let axis = 0; axis < 3; axis++) {
    const out = new Float32Array(N);
    const len = dims[axis];
    const st = strides[axis];
    // every line along this axis starts at an index whose coordinate on the axis is 0
    for (let base = 0; base < N; base++) {
      if (Math.floor(base / st) % len !== 0) continue;
      let sum = 0;
      for (let d = 0; d <= MACRO_R && d < len; d++) sum += a[base + d * st];
      for (let c = 0; c < len; c++) {
        out[base + c * st] = sum / W;
        const add = c + MACRO_R + 1;
        const sub = c - MACRO_R;
        if (add < len) sum += a[base + add * st];
        if (sub >= 0) sum -= a[base + sub * st];
      }
    }
    a = out;
  }
  // outward gradient (central differences) and density per cell; the padding is empty, so the border is 0
  const G = new Float32Array(N * 4);
  for (let z = 1; z < Z - 1; z++)
    for (let y = 1; y < Y - 1; y++)
      for (let x = 1; x < X - 1; x++) {
        const i = x + X * y + XY * z;
        G[i * 4] = a[i - 1] - a[i + 1];
        G[i * 4 + 1] = a[i - X] - a[i + X];
        G[i * 4 + 2] = a[i - XY] - a[i + XY];
        G[i * 4 + 3] = a[i];
      }
  const cnt = pos.count;
  // packed as normalized bytes (4 bytes a vertex): plenty for a rim light
  const out = new Int8Array(cnt * 4);
  const inv = 1 / size;
  const p = pos.array as Float32Array;
  for (let v = 0; v < cnt; v++) {
    // vertex = fine lattice corner (grid-local fine index) -> unit cell coordinates (cell c centred at c)
    const ux = (p[v * 3] * inv + pivot[0]) / r + P - 0.5;
    const uy = (p[v * 3 + 1] * inv + pivot[1]) / r + P - 0.5;
    const uz = (p[v * 3 + 2] * inv + pivot[2]) / r + P - 0.5;
    const x0 = Math.floor(ux);
    const y0 = Math.floor(uy);
    const z0 = Math.floor(uz);
    const fx = ux - x0;
    const fy = uy - y0;
    const fz = uz - z0;
    let gx = 0;
    let gy = 0;
    let gz = 0;
    let dd = 0;
    for (let c = 0; c < 8; c++) {
      const dx = c & 1;
      const dy = (c >> 1) & 1;
      const dz = c >> 2;
      const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
      const i = (x0 + dx + X * (y0 + dy) + XY * (z0 + dz)) * 4;
      gx += G[i] * w;
      gy += G[i + 1] * w;
      gz += G[i + 2] * w;
      dd += G[i + 3] * w;
    }
    const l = Math.hypot(gx, gy, gz);
    const o = v * 4;
    if (l < 1e-4) {
      out[o] = Math.round(nrm.getX(v) * 127);
      out[o + 1] = Math.round(nrm.getY(v) * 127);
      out[o + 2] = Math.round(nrm.getZ(v) * 127);
    } else {
      out[o] = Math.round((gx / l) * 127);
      out[o + 1] = Math.round((gy / l) * 127);
      out[o + 2] = Math.round((gz / l) * 127);
    }
    // a flat bulk surface has about half the blur kernel inside it; a one-voxel strand a few percent
    out[o + 3] = Math.round(Math.max(0, Math.min(1, (dd - 0.12) / 0.26)) * 127);
  }
  return out;
}
