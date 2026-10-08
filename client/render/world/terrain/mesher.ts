// Column mesher for a HeightField chunk: greedy-merged top faces (colour comes from the field's
// DataTexture, so equal-height runs merge into big quads), per-vertex ambient occlusion baked into
// vertex colours, and exposed side faces split into stacked voxel segments coloured by the biome.
// Allocation-light: one growable typed buffer set is reused for every chunk.
import * as THREE from 'three';
import type { Biome, HeightField, SideOut } from './field.ts';

export interface MeshOpts {
  /** strata height for side segments (usually the cell size, so sides read as cubes) */
  segH: number;
  /** 0..1 darkness of fully occluded top corners */
  aoTop: number;
  /** 0..1 darkness at the foot of side faces */
  aoSide: number;
  /** height of the neighbour where the field has no column (outside or skipped). NaN = open edge. */
  floor: (x: number, z: number) => number;
  /** how far skirts drop below the lower edge at field borders */
  skirt: number;
  /**
   * Skip side faces whose normal points to -Z. The game camera always sits on the +Z side of
   * everything it can see, so those faces are never visible (shadows use the +Z faces).
   */
  cullAway?: boolean;
}

const AO_LIT = [1, 0.72, 0.5, 0.32];
const tmpColor = new THREE.Color();
const sideOut: SideOut = { color: 0, rough: 0.9, emit: 0 };

/** Growable vertex buffer: pos3 nrm3 col3 uv2 rough1 emit1 + indices. */
class Buf {
  pos = new Float32Array(1 << 16);
  nrm = new Float32Array(1 << 16);
  col = new Float32Array(1 << 16);
  uv = new Float32Array(1 << 15);
  rough = new Float32Array(1 << 14);
  emit = new Float32Array(1 << 14);
  idx = new Uint32Array(1 << 15);
  nv = 0;
  ni = 0;
  reset(): void {
    this.nv = 0;
    this.ni = 0;
  }
  ensure(verts: number, inds: number): void {
    const need = this.nv + verts;
    if (need > this.rough.length) {
      let n = this.rough.length;
      while (n < need) n *= 2;
      const grow = (a: Float32Array, k: number) => {
        const b = new Float32Array(n * k);
        b.set(a.subarray(0, this.nv * k));
        return b;
      };
      this.pos = grow(this.pos, 3);
      this.nrm = grow(this.nrm, 3);
      this.col = grow(this.col, 3);
      this.uv = grow(this.uv, 2);
      this.rough = grow(this.rough, 1);
      this.emit = grow(this.emit, 1);
    }
    if (this.ni + inds > this.idx.length) {
      let n = this.idx.length;
      while (n < this.ni + inds) n *= 2;
      const b = new Uint32Array(n);
      b.set(this.idx.subarray(0, this.ni));
      this.idx = b;
    }
  }
  /** Append one vertex. */
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, r: number, g: number, b: number, u: number, vv: number, ro: number, em: number): void {
    const i = this.nv++;
    const i3 = i * 3;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.nrm[i3] = nx;
    this.nrm[i3 + 1] = ny;
    this.nrm[i3 + 2] = nz;
    this.col[i3] = r;
    this.col[i3 + 1] = g;
    this.col[i3 + 2] = b;
    this.uv[i * 2] = u;
    this.uv[i * 2 + 1] = vv;
    this.rough[i] = ro;
    this.emit[i] = em;
  }
  tri(a: number, b: number, c: number): void {
    this.idx[this.ni++] = a;
    this.idx[this.ni++] = b;
    this.idx[this.ni++] = c;
  }
}

const buf = new Buf();
let maskBuf = new Float64Array(64 * 64);
let aoBuf = new Uint8Array(64 * 64);
// side segments (parallel arrays, reused)
const SEG_MAX = 1024;
const segY0 = new Float64Array(SEG_MAX);
const segY1 = new Float64Array(SEG_MAX);
const segC = new Int32Array(SEG_MAX);
const segR = new Float64Array(SEG_MAX);
const segE = new Float64Array(SEG_MAX);

function occ(d: number): number {
  return !(d > 0) ? 0 : d >= 0.25 ? 1 : d / 0.25;
}

/** Build geometry for columns [i0, i1) x [j0, j1). Returns null when empty. */
export function meshChunk(f: HeightField, biome: Biome, i0: number, j0: number, i1: number, j1: number, o: MeshOpts): THREE.BufferGeometry | null {
  const b = buf;
  b.reset();
  const s = f.s;
  const nx = f.nx;
  const nz = f.nz;
  const tw = nx + 1;
  const W = i1 - i0;
  const H = j1 - j0;
  const fh = f.h;
  const fp = f.present;
  const x0 = f.x0;
  const z0 = f.z0;

  const nb = (i: number, j: number): number => {
    if (i >= 0 && j >= 0 && i < nx && j < nz) {
      const k = i + j * nx;
      if (fp[k]) return fh[k];
    }
    return o.floor(x0 + (i + 0.5) * s, z0 + (j + 0.5) * s);
  };

  // ---------------------------------------------------------------- tops (greedy)
  if (maskBuf.length < W * H) {
    maskBuf = new Float64Array(W * H);
    aoBuf = new Uint8Array(W * H);
  }
  const mask = maskBuf;
  const aoOf = aoBuf;
  for (let j = 0; j < H; j++) {
    const gj = j0 + j;
    for (let i = 0; i < W; i++) {
      const gi = i0 + i;
      const k = gi + gj * nx;
      const m = i + j * W;
      if (!fp[k]) {
        mask[m] = 0;
        continue;
      }
      const h = fh[k];
      // neighbour heights (8)
      const hW = nb(gi - 1, gj) - h;
      const hE = nb(gi + 1, gj) - h;
      const hS = nb(gi, gj - 1) - h;
      const hN = nb(gi, gj + 1) - h;
      const oW = occ(hW);
      const oE = occ(hE);
      const oS = occ(hS);
      const oN = occ(hN);
      const oSW = occ(nb(gi - 1, gj - 1) - h);
      const oSE = occ(nb(gi + 1, gj - 1) - h);
      const oNE = occ(nb(gi + 1, gj + 1) - h);
      const oNW = occ(nb(gi - 1, gj + 1) - h);
      const ao = lvl(oW, oS, oSW) | (lvl(oE, oS, oSE) << 2) | (lvl(oE, oN, oNE) << 4) | (lvl(oW, oN, oNW) << 6);
      aoOf[m] = ao;
      mask[m] = (Math.round((h - biome.base) * 64) + 100000) * 256 + ao + 1;
    }
  }
  const aoT = o.aoTop;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; ) {
      const key = mask[i + j * W];
      if (key === 0) {
        i++;
        continue;
      }
      let w = 1;
      while (i + w < W && mask[i + w + j * W] === key) w++;
      let hh = 1;
      outer: while (j + hh < H) {
        const row = (j + hh) * W;
        for (let k = 0; k < w; k++) if (mask[i + k + row] !== key) break outer;
        hh++;
      }
      for (let l = 0; l < hh; l++) {
        const row = (j + l) * W;
        for (let k = 0; k < w; k++) mask[i + k + row] = 0;
      }
      const gi = i0 + i;
      const gj = j0 + j;
      const y = fh[gi + gj * nx];
      const ao = aoOf[i + j * W];
      const xa = x0 + gi * s;
      const xb = xa + w * s;
      const za = z0 + gj * s;
      const zb = za + hh * s;
      const ua = gi / tw;
      const ub = (gi + w) / tw;
      const va = gj / nz;
      const vb = (gj + hh) / nz;
      const l0 = 1 - aoT * (1 - AO_LIT[ao & 3]);
      const l1 = 1 - aoT * (1 - AO_LIT[(ao >> 2) & 3]);
      const l2 = 1 - aoT * (1 - AO_LIT[(ao >> 4) & 3]);
      const l3 = 1 - aoT * (1 - AO_LIT[(ao >> 6) & 3]);
      b.ensure(4, 6);
      const base = b.nv;
      b.v(xa, y, za, 0, 1, 0, l0, l0, l0, ua, va, 1, 0);
      b.v(xb, y, za, 0, 1, 0, l1, l1, l1, ub, va, 1, 0);
      b.v(xb, y, zb, 0, 1, 0, l2, l2, l2, ub, vb, 1, 0);
      b.v(xa, y, zb, 0, 1, 0, l3, l3, l3, ua, vb, 1, 0);
      if (l0 + l2 < l1 + l3) {
        b.tri(base + 1, base, base + 3);
        b.tri(base + 1, base + 3, base + 2);
      } else {
        b.tri(base, base + 2, base + 1);
        b.tri(base, base + 3, base + 2);
      }
      i += w;
    }
  }

  // ---------------------------------------------------------------- sides
  // Each column side becomes a list of quads (strata segments merged vertically). Neighbouring
  // columns along a wall whose lists are identical merge horizontally into one run.
  const wu = (nx + 0.5) / tw;
  const wv = 0.5;
  const segH = o.segH;
  const bbase = biome.base;
  const dirs = o.cullAway === false ? 4 : 3;
  for (let d = 0; d < dirs; d++) {
    const dx = d === 0 ? 1 : d === 1 ? -1 : 0;
    const dz = d === 2 ? 1 : d === 3 ? -1 : 0;
    const alongZ = dx !== 0;
    const lineA = alongZ ? i0 : j0;
    const lineB = alongZ ? i1 : j1;
    const runA = alongZ ? j0 : i0;
    const runB = alongZ ? j1 : i1;
    for (let line = lineA; line < lineB; line++) {
      pendN = 0;
      let pendStart = 0;
      let pendEnd = 0;
      for (let r = runA; r <= runB; r++) {
        let n = 0;
        if (r < runB) {
          const i = alongZ ? line : r;
          const j = alongZ ? r : line;
          n = faceList(f, biome, o, i, j, dx, dz, d, segH, bbase);
        }
        // compare with the pending run
        let same = n > 0 && n === pendN;
        for (let k = 0; same && k < n; k++) {
          if (curY0[k] !== pendY0[k] || curY1[k] !== pendY1[k] || curC[k] !== pendC[k] || curR[k] !== pendR[k] || curE[k] !== pendE[k] || curLT[k] !== pendLT[k] || curLB[k] !== pendLB[k]) same = false;
        }
        if (same) {
          pendEnd = r + 1;
          continue;
        }
        // flush
        if (pendN > 0) {
          let ax: number, az: number, bx: number, bz: number;
          if (alongZ) {
            ax = bx = x0 + (dx > 0 ? line + 1 : line) * s;
            az = z0 + pendStart * s;
            bz = z0 + pendEnd * s;
          } else {
            az = bz = z0 + (dz > 0 ? line + 1 : line) * s;
            ax = x0 + pendStart * s;
            bx = x0 + pendEnd * s;
          }
          for (let k = 0; k < pendN; k++) emitSide(b, ax, az, bx, bz, pendY0[k], pendY1[k], dx, dz, pendC[k], pendLT[k], pendLB[k], pendR[k], pendE[k], wu, wv);
        }
        pendN = n;
        pendStart = r;
        pendEnd = r + 1;
        for (let k = 0; k < n; k++) {
          pendY0[k] = curY0[k];
          pendY1[k] = curY1[k];
          pendC[k] = curC[k];
          pendR[k] = curR[k];
          pendE[k] = curE[k];
          pendLT[k] = curLT[k];
          pendLB[k] = curLB[k];
        }
      }
    }
  }

  if (b.nv === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(b.pos.slice(0, b.nv * 3), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(b.nrm.slice(0, b.nv * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(b.col.slice(0, b.nv * 3), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(b.uv.slice(0, b.nv * 2), 2));
  geo.setAttribute('aRough', new THREE.BufferAttribute(b.rough.slice(0, b.nv), 1));
  geo.setAttribute('aEmit', new THREE.BufferAttribute(b.emit.slice(0, b.nv), 1));
  if (b.nv > 65535) geo.setIndex(new THREE.BufferAttribute(b.idx.slice(0, b.ni), 1));
  else geo.setIndex(new THREE.BufferAttribute(Uint16Array.from(b.idx.subarray(0, b.ni)), 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

const curY0 = new Float64Array(SEG_MAX);
const curY1 = new Float64Array(SEG_MAX);
const curC = new Int32Array(SEG_MAX);
const curR = new Float64Array(SEG_MAX);
const curE = new Float64Array(SEG_MAX);
const curLT = new Float64Array(SEG_MAX);
const curLB = new Float64Array(SEG_MAX);
const pendY0 = new Float64Array(SEG_MAX);
const pendY1 = new Float64Array(SEG_MAX);
const pendC = new Int32Array(SEG_MAX);
const pendR = new Float64Array(SEG_MAX);
const pendE = new Float64Array(SEG_MAX);
const pendLT = new Float64Array(SEG_MAX);
const pendLB = new Float64Array(SEG_MAX);
let pendN = 0;

/** Quads of one column side into the cur* arrays (top down). Returns the count. */
function faceList(f: HeightField, biome: Biome, o: MeshOpts, i: number, j: number, dx: number, dz: number, d: number, segH: number, bbase: number): number {
  const nx = f.nx;
  const k = i + j * nx;
  if (!f.present[k]) return 0;
  const top = f.h[k];
  const ni = i + dx;
  const nj = j + dz;
  let missing = true;
  let floor: number;
  if (ni >= 0 && nj >= 0 && ni < nx && nj < f.nz && f.present[ni + nj * nx]) {
    missing = false;
    floor = f.h[ni + nj * nx];
    if (floor >= top - 1e-4) return 0;
  } else {
    floor = o.floor(f.x0 + (ni + 0.5) * f.s, f.z0 + (nj + 0.5) * f.s);
    if (floor !== floor) floor = top;
  }
  const sideId = f.side[k];
  const tag = f.tag[k];
  let ix = f.ix0 + i;
  let iz = f.iz0 + j;
  // tiny lips share colours in groups of four so terrace edges merge into long runs
  if (top - floor < 0.13) {
    ix &= ~3;
    iz &= ~3;
  }
  let n = 0;
  if (floor < top - 1e-4) {
    let yt = top;
    while (yt > floor + 1e-4 && n < SEG_MAX) {
      let yb = bbase + Math.floor((yt - 1e-4 - bbase) / segH) * segH;
      if (yb < floor) yb = floor;
      const iy = Math.floor(((yt + yb) * 0.5 - bbase) / segH);
      biome.sideColor(sideId, tag, ix, iy, iz, d, yb, yt, top, f.s, sideOut);
      segY0[n] = yb;
      segY1[n] = yt;
      segC[n] = sideOut.color;
      segR[n] = sideOut.rough;
      segE[n] = sideOut.emit;
      n++;
      yt = yb;
    }
  }
  // merge vertical runs (never into the bottom segment, it carries the contact shadow)
  let m = 0;
  let a = 0;
  while (a < n) {
    let e = a;
    while (e + 1 < n - 1 && segC[e + 1] === segC[a] && segE[e + 1] === segE[a] && segR[e + 1] === segR[a]) e++;
    const yTop = segY1[a];
    const yBot = segY0[e];
    const isBottom = e === n - 1;
    const contact = isBottom && !missing ? o.aoSide * Math.max(0.35, Math.min(1, (yTop - yBot) / segH)) : 0;
    curY0[m] = yBot;
    curY1[m] = yTop;
    curC[m] = segC[a];
    curR[m] = segR[a];
    curE[m] = segE[a];
    curLT[m] = 1 - 0.22 * Math.min(1, Math.max(0, (top - yTop) / 3));
    curLB[m] = (1 - 0.22 * Math.min(1, Math.max(0, (top - yBot) / 3))) * (1 - contact);
    m++;
    a = e + 1;
  }
  if (missing && o.skirt > 0 && m < SEG_MAX) {
    const yTop = Math.min(top, floor);
    biome.sideColor(sideId, tag, ix, -999, iz, d, yTop - o.skirt, yTop, top, f.s, sideOut);
    curY0[m] = yTop - o.skirt;
    curY1[m] = yTop;
    curC[m] = sideOut.color;
    curR[m] = 1;
    curE[m] = 0;
    curLT[m] = 0.55;
    curLB[m] = 0.3;
    m++;
  }
  return m;
}

function lvl(s1: number, s2: number, c: number): number {
  if (s1 >= 0.99 && s2 >= 0.99) return 3;
  const v = Math.round(((s1 + s2 + c * 0.5) / 2.5) * 3);
  return v > 3 ? 3 : v;
}

function emitSide(
  b: Buf, ax: number, az: number, bx: number, bz: number, y0: number, y1: number, nx: number, nz: number,
  color: number, litTop: number, litBot: number, rough: number, emit: number, u: number, v: number,
): void {
  tmpColor.setHex(color, THREE.SRGBColorSpace);
  const r = tmpColor.r;
  const g = tmpColor.g;
  const bl = tmpColor.b;
  b.ensure(4, 6);
  const base = b.nv;
  // 0 (a, y0) 1 (b, y0) 2 (b, y1) 3 (a, y1)
  b.v(ax, y0, az, nx, 0, nz, r * litBot, g * litBot, bl * litBot, u, v, rough, emit);
  b.v(bx, y0, bz, nx, 0, nz, r * litBot, g * litBot, bl * litBot, u, v, rough, emit);
  b.v(bx, y1, bz, nx, 0, nz, r * litTop, g * litTop, bl * litTop, u, v, rough, emit);
  b.v(ax, y1, az, nx, 0, nz, r * litTop, g * litTop, bl * litTop, u, v, rough, emit);
  // winding: cross((b - a), up) = (-ez, 0, ex) must point along the normal
  const dot = -(bz - az) * nx + (bx - ax) * nz;
  if (dot > 0) {
    b.tri(base, base + 1, base + 2);
    b.tri(base, base + 2, base + 3);
  } else {
    b.tri(base, base + 2, base + 1);
    b.tri(base, base + 3, base + 2);
  }
}
