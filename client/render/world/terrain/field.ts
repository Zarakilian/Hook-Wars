// Heightfield of square voxel columns. One sampled array drives both the rendered mesh and
// groundHeight(), so units always stand on what is drawn.
//
// Each column has a flat top at a quantised height, a top colour (stored in a DataTexture so the
// mesher can merge equal-height runs into big quads), a roughness / sparkle value and a side
// material id that the biome turns into stacked voxel colours on exposed side faces.
import * as THREE from 'three';

/** What a biome writes for one column. */
export interface Cell {
  /** surface height in metres (unquantised) */
  h: number;
  /** vertical quantum for this column (top snaps to base + k * q) */
  q: number;
  /** top colour 0xRRGGBB (sRGB) */
  top: number;
  /** top roughness 0..1 */
  rough: number;
  /** 0..1 snow / sand glints (shader) */
  sparkle: number;
  /** biome side material id (0..255) */
  side: number;
  /** biome-defined extra byte, passed back to sideColor (e.g. building id, strata seed) */
  tag: number;
}

export function newCell(): Cell {
  return { h: 0, q: 1 / 16, top: 0x808080, rough: 0.9, sparkle: 0, side: 0, tag: 0 };
}

export interface SideOut {
  color: number;
  rough: number;
  emit: number;
}

/** A biome is the per-map terrain author: shape + colours for every column, and side colours. */
export interface Biome {
  /** Quantisation base. Plazas and flat land land exactly on this height. */
  readonly base: number;
  /** Fill `out` for the column centred at (x, z). ix/iz are world-aligned column indices (stable hashing). */
  sample(x: number, z: number, ix: number, iz: number, cellSize: number, out: Cell): void;
  /** Colour of one side-face voxel segment. y0..y1 is the segment, top is the column top. */
  sideColor(side: number, tag: number, ix: number, iy: number, iz: number, dir: number, y0: number, y1: number, top: number, cellSize: number, out: SideOut): void;
}

export class HeightField {
  readonly nx: number;
  readonly nz: number;
  readonly s: number;
  readonly x0: number;
  readonly z0: number;
  /** quantised column tops */
  readonly h: Float32Array;
  readonly side: Uint8Array;
  readonly tag: Uint8Array;
  readonly present: Uint8Array;
  /** world index offsets so hashes are stable across fields */
  readonly ix0: number;
  readonly iz0: number;
  /** RGBA, width nx + 1 (last texel column is white, used by side faces) */
  readonly colorData: Uint8Array;
  /** RGBA: R = baked lamp light (bakeLamps), G = roughness, B = sparkle; last column G = 255 */
  readonly roughData: Uint8Array;
  colorTex: THREE.DataTexture | null = null;
  roughTex: THREE.DataTexture | null = null;

  constructor(x0: number, z0: number, nx: number, nz: number, s: number) {
    this.x0 = x0;
    this.z0 = z0;
    this.nx = nx;
    this.nz = nz;
    this.s = s;
    this.ix0 = Math.round(x0 / s);
    this.iz0 = Math.round(z0 / s);
    const n = nx * nz;
    this.h = new Float32Array(n);
    this.side = new Uint8Array(n);
    this.tag = new Uint8Array(n);
    this.present = new Uint8Array(n);
    this.colorData = new Uint8Array((nx + 1) * nz * 4);
    this.roughData = new Uint8Array((nx + 1) * nz * 4);
  }

  /**
   * Sample every column from the biome. `skip(x, z)` excludes columns (left empty, e.g. where a
   * finer field covers the area).
   */
  fill(biome: Biome, skip?: (x: number, z: number) => boolean): void {
    const cell = newCell();
    const tw = this.nx + 1;
    const base = biome.base;
    for (let j = 0; j < this.nz; j++) {
      const z = this.z0 + (j + 0.5) * this.s;
      for (let i = 0; i < this.nx; i++) {
        const x = this.x0 + (i + 0.5) * this.s;
        const k = i + j * this.nx;
        if (skip && skip(x, z)) {
          this.present[k] = 0;
          this.h[k] = -50;
          continue;
        }
        cell.q = 1 / 16;
        cell.rough = 0.9;
        cell.sparkle = 0;
        cell.side = 0;
        cell.tag = 0;
        biome.sample(x, z, this.ix0 + i, this.iz0 + j, this.s, cell);
        const q = cell.q;
        this.h[k] = base + Math.round((cell.h - base) / q) * q;
        this.side[k] = cell.side;
        this.tag[k] = cell.tag;
        this.present[k] = 1;
        const t = (i + j * tw) * 4;
        this.colorData[t] = (cell.top >> 16) & 255;
        this.colorData[t + 1] = (cell.top >> 8) & 255;
        this.colorData[t + 2] = cell.top & 255;
        this.colorData[t + 3] = 255;
        this.roughData[t] = 0;
        this.roughData[t + 1] = Math.max(0, Math.min(255, Math.round(cell.rough * 255)));
        this.roughData[t + 2] = Math.max(0, Math.min(255, Math.round(cell.sparkle * 255)));
        this.roughData[t + 3] = 255;
      }
      // white texel column for side faces
      const t = (this.nx + j * tw) * 4;
      this.colorData[t] = this.colorData[t + 1] = this.colorData[t + 2] = this.colorData[t + 3] = 255;
      this.roughData[t + 1] = this.roughData[t + 3] = 255;
      this.roughData[t] = this.roughData[t + 2] = 0;
    }
  }

  /**
   * Bake warm pools of lamp light into the R channel (column tops only): each lamp is (x, z, radius,
   * strength 0..1), smooth quadratic falloff, summed and clamped. Call before textures().
   */
  bakeLamps(lamps: readonly { x: number; z: number; r: number; k: number }[]): void {
    const tw = this.nx + 1;
    for (const l of lamps) {
      const i0 = Math.max(0, Math.floor((l.x - l.r - this.x0) / this.s));
      const i1 = Math.min(this.nx - 1, Math.ceil((l.x + l.r - this.x0) / this.s));
      const j0 = Math.max(0, Math.floor((l.z - l.r - this.z0) / this.s));
      const j1 = Math.min(this.nz - 1, Math.ceil((l.z + l.r - this.z0) / this.s));
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const dx = this.x0 + (i + 0.5) * this.s - l.x;
          const dz = this.z0 + (j + 0.5) * this.s - l.z;
          const d = Math.sqrt(dx * dx + dz * dz) / l.r;
          if (d >= 1) continue;
          const f = (1 - d) * (1 - d) * l.k;
          const t = (i + j * tw) * 4;
          this.roughData[t] = Math.min(255, this.roughData[t] + Math.round(f * 255));
        }
    }
  }

  index(i: number, j: number): number {
    return i + j * this.nx;
  }

  /** Column top or NaN when the column is missing / outside. */
  top(i: number, j: number): number {
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return NaN;
    const k = i + j * this.nx;
    return this.present[k] ? this.h[k] : NaN;
  }

  contains(x: number, z: number): boolean {
    return x >= this.x0 && z >= this.z0 && x < this.x0 + this.nx * this.s && z < this.z0 + this.nz * this.s;
  }

  /** Bilinear height between column centres. Exact on column centres, continuous everywhere. */
  heightAt(x: number, z: number): number {
    const fx = (x - this.x0) / this.s - 0.5;
    const fz = (z - this.z0) / this.s - 0.5;
    let i = Math.floor(fx);
    let j = Math.floor(fz);
    let tx = fx - i;
    let tz = fz - j;
    if (i < 0) { i = 0; tx = 0; }
    if (j < 0) { j = 0; tz = 0; }
    if (i >= this.nx - 1) { i = this.nx - 2; tx = 1; }
    if (j >= this.nz - 1) { j = this.nz - 2; tz = 1; }
    const k = i + j * this.nx;
    const nx = this.nx;
    const p = this.present;
    const h = this.h;
    // missing neighbours fall back to the present ones
    const a = p[k] ? h[k] : NaN;
    const b = p[k + 1] ? h[k + 1] : NaN;
    const c = p[k + nx] ? h[k + nx] : NaN;
    const d = p[k + nx + 1] ? h[k + nx + 1] : NaN;
    if (a === a && b === b && c === c && d === d) {
      const ab = a + (b - a) * tx;
      const cd = c + (d - c) * tx;
      return ab + (cd - ab) * tz;
    }
    let sum = 0;
    let w = 0;
    if (a === a) { const ww = (1 - tx) * (1 - tz) + 1e-4; sum += a * ww; w += ww; }
    if (b === b) { const ww = tx * (1 - tz) + 1e-4; sum += b * ww; w += ww; }
    if (c === c) { const ww = (1 - tx) * tz + 1e-4; sum += c * ww; w += ww; }
    if (d === d) { const ww = tx * tz + 1e-4; sum += d * ww; w += ww; }
    return w > 0 ? sum / w : NaN;
  }

  /** Exact top of the column containing (x, z), NaN if none. */
  columnAt(x: number, z: number): number {
    const i = Math.floor((x - this.x0) / this.s);
    const j = Math.floor((z - this.z0) / this.s);
    return this.top(i, j);
  }

  textures(): { color: THREE.DataTexture; rough: THREE.DataTexture } {
    if (!this.colorTex || !this.roughTex) {
      const mk = (data: Uint8Array, srgb: boolean) => {
        const t = new THREE.DataTexture(data, this.nx + 1, this.nz, THREE.RGBAFormat, THREE.UnsignedByteType);
        t.magFilter = THREE.NearestFilter;
        t.minFilter = THREE.NearestFilter;
        t.generateMipmaps = false;
        t.wrapS = THREE.ClampToEdgeWrapping;
        t.wrapT = THREE.ClampToEdgeWrapping;
        t.flipY = false;
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        t.needsUpdate = true;
        return t;
      };
      this.colorTex = mk(this.colorData, true);
      this.roughTex = mk(this.roughData, false);
    }
    return { color: this.colorTex, rough: this.roughTex };
  }

  dispose(): void {
    this.colorTex?.dispose();
    this.roughTex?.dispose();
    this.colorTex = null;
    this.roughTex = null;
  }
}
