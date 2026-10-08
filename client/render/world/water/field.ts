// Baked channel field: bed height, signed water distance and a puddle mask over every bit of water the
// map has: the main river (plus a margin past its ends for the seam caps), braided side channels and
// pools. One RGBA8 texture feeds every water shader; a CPU copy answers surfaceHeight() without noise.
// Channel distance comes from waterDepthAt (platforms ignored), so the water runs on under docks.
import * as THREE from 'three';
import { riverAt, waterDepthAt } from '../../../../shared/maps/helpers.ts';
import type { MapDef } from '../../../../shared/maps/types.ts';
import { fbm2 } from '../../../../shared/math.ts';
import { bedY, groundY } from '../../contracts.ts';

export interface WaterField {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  cell: number;
  nx: number;
  nz: number;
  bed: Float32Array;
  chan: Float32Array;
  puddle: Float32Array;
  /** low-tide stream that keeps running from a waterfall down the bed (0 when the map has none) */
  stream: Float32Array;
  bedLo: number;
  bedRange: number;
  chanLo: number;
  chanRange: number;
  /** how far the water sheet reaches past the channel edge, metres */
  ext: number;
  texture: THREE.DataTexture;
  /** max channel distance (centre of the widest part) */
  maxChan: number;
}

/** How far the water sheet reaches past the channel edge (metres): the bank margin the surface covers. */
export function waterExt(map: MapDef): number {
  return Math.min(map.river.bank, 2.4) + 0.4;
}

/** Metres the box reaches past the sheet margin: room for the end-zone side bands (water.ts END_PAD + END_BAND). */
const BOX_PAD = 3;

/** Bounding box of every water body plus the sheet margin. z covers the river points plus `capZ` metres past each end. */
export function waterBox(map: MapDef, ext: number, capN: number, capS: number): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const pts = map.river.points;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x - p.hw - ext - BOX_PAD);
    maxX = Math.max(maxX, p.x + p.hw + ext + BOX_PAD);
  }
  for (const ch of map.channels ?? []) {
    for (const p of ch.points) {
      minX = Math.min(minX, p.x - p.hw - ext - BOX_PAD);
      maxX = Math.max(maxX, p.x + p.hw + ext + BOX_PAD);
    }
  }
  for (const pl of map.pools ?? []) {
    const r = Math.max(pl.rx, pl.rz) + ext + BOX_PAD;
    minX = Math.min(minX, pl.x - r);
    maxX = Math.max(maxX, pl.x + r);
  }
  // never wider than the play area plus a margin (a stray channel point must not blow up the texture)
  minX = Math.max(minX, -map.w / 2 - 6);
  maxX = Math.min(maxX, map.w / 2 + 6);
  return { minX, maxX, minZ: pts[0].z - capN, maxZ: pts[pts.length - 1].z + capS };
}

export function bakeField(map: MapDef, ground: (x: number, z: number) => number, cell: number, withStream = false, capN = 0, capS = 0): WaterField {
  const pts = map.river.points;
  const ext = waterExt(map);
  const box = waterBox(map, ext, capN, capS);
  const minX = box.minX;
  const maxX = box.maxX;
  const minZ = box.minZ;
  const maxZ = box.maxZ;
  const nx = Math.ceil((maxX - minX) / cell) + 1;
  const nz = Math.ceil((maxZ - minZ) / cell) + 1;
  const bed = new Float32Array(nx * nz);
  const chan = new Float32Array(nx * nz);
  const puddle = new Float32Array(nx * nz);
  const stream = new Float32Array(nx * nz);
  const bY = bedY(map);
  const gY = groundY(map);
  const seed = map.id.length * 131 + 7;
  let maxChan = 0;
  for (let j = 0; j < nz; j++) {
    const z = minZ + j * cell;
    for (let i = 0; i < nx; i++) {
      const x = minX + i * cell;
      const o = j * nx + i;
      const h = ground(x, z);
      const c = waterDepthAt(map, x, z);
      bed[o] = h;
      chan[o] = c;
      maxChan = Math.max(maxChan, c);
      // puddles: noise blobs on the floor of the channel (they hug the bed, so any bed shape works)
      const inner = smooth(1.1, 2.2, c);
      const n = fbm2(x * 0.33 + 3.1, z * 0.33 - 1.7, 3, seed) * 0.75 + fbm2(x * 1.1, z * 1.1, 2, seed + 9) * 0.25;
      puddle[o] = inner * smooth(0.56, 0.67, n);
      if (withStream) {
        const r = riverAt(pts, z);
        const mid = r.x + Math.sin(z * 0.21 + 1.3) * Math.min(1.6, r.hw * 0.3) + Math.sin(z * 0.53) * 0.4;
        const half = 0.75 + 0.3 * Math.sin(z * 0.37 + 0.8) + (fbm2(x * 0.7, z * 0.7, 2, seed + 3) - 0.5) * 0.5;
        stream[o] = (1 - smooth(half * 0.6, half, Math.abs(x - mid))) * smooth(0.6, 1.2, c);
      }
    }
  }
  // encode the bed over its real range (whatever the terrain module does), ~1-2 cm per step
  let minB = Infinity;
  let maxB = -Infinity;
  for (let o = 0; o < nx * nz; o++) {
    minB = Math.min(minB, bed[o]);
    maxB = Math.max(maxB, bed[o]);
  }
  const bedLo = Math.min(bY - 0.3, minB) - 0.05;
  const bedRange = Math.max(gY + 0.6, maxB) + 0.05 - bedLo;
  const chanLo = -6;
  const chanRange = 18;
  const data = new Uint8Array(nx * nz * 4);
  for (let o = 0; o < nx * nz; o++) {
    data[o * 4] = q8((bed[o] - bedLo) / bedRange);
    data[o * 4 + 1] = q8((chan[o] - chanLo) / chanRange);
    data[o * 4 + 2] = q8(puddle[o]);
    data[o * 4 + 3] = q8(stream[o]);
  }
  const texture = new THREE.DataTexture(data, nx, nz, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return {
    minX, minZ, maxX: minX + (nx - 1) * cell, maxZ: minZ + (nz - 1) * cell, cell, nx, nz, bed, chan, puddle, stream,
    bedLo, bedRange, chanLo, chanRange, ext, texture, maxChan,
  };
}

function q8(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Bilinear sample of a field array. Returns NaN outside the baked box. */
export function sampleField(f: WaterField, arr: Float32Array, x: number, z: number): number {
  const fx = (x - f.minX) / f.cell;
  const fz = (z - f.minZ) / f.cell;
  if (fx < 0 || fz < 0 || fx > f.nx - 1 || fz > f.nz - 1) return NaN;
  const i = Math.min(f.nx - 2, Math.floor(fx));
  const j = Math.min(f.nz - 2, Math.floor(fz));
  const tx = fx - i;
  const tz = fz - j;
  const o = j * f.nx + i;
  const a = arr[o];
  const b = arr[o + 1];
  const c = arr[o + f.nx];
  const d = arr[o + f.nx + 1];
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}

/** Uniform values that let shaders sample the field texture with world x/z. */
export function fieldUniforms(f: WaterField): { box: THREE.Vector4; range: THREE.Vector4 } {
  // uv = (xz - min) / span, with half-texel centring
  const spanX = (f.nx - 1) * f.cell;
  const spanZ = (f.nz - 1) * f.cell;
  const box = new THREE.Vector4(f.minX, f.minZ, 1 / spanX, 1 / spanZ);
  const range = new THREE.Vector4(f.bedLo, f.bedRange, f.chanLo, f.chanRange);
  return { box, range };
}

/** GLSL that converts world xz to field uv with texel centring. Needs uFieldBox, uFieldTexel. */
export const FIELD_GLSL = /* glsl */ `
uniform sampler2D uField;
uniform vec4 uFieldBox;
uniform vec4 uFieldRange;
uniform vec2 uFieldTexel;
vec4 fieldAt(vec2 xz) {
  vec2 uv = (xz - uFieldBox.xy) * uFieldBox.zw;
  uv = uv * (1.0 - uFieldTexel) + 0.5 * uFieldTexel;
  return texture2D(uField, uv);
}
float fieldBed(vec4 f) { return uFieldRange.x + f.r * uFieldRange.y; }
float fieldChan(vec4 f) { return uFieldRange.z + f.g * uFieldRange.w; }
`;

export interface GridSpan {
  z0: number;
  z1: number;
  /** vertex attribute aFixed for this span: 1 = reservoir held at full level */
  fixed: number;
  /** keep cells within this many metres past the channel edge (default: the grid's reach) */
  reach?: number;
  /** skip cells whose four corners all have a channel distance above -hollow, so a side band leaves
   *  the middle (already covered by the main sheet) out */
  hollow?: number;
  /** skip cells whose four corners all have ground (bedAt) higher than this: a side band only
   *  needs to exist where the backdrop water can be */
  dryAbove?: number;
}

/**
 * Water grid: a regular grid over the water box, keeping only the cells within `ext` metres of water
 * (main river, side channels, pools; platforms ignored so the sheet runs on under docks and bridges).
 * Spans are separate patches (no shared vertices) so lock reservoirs can sit at a different level.
 * The `uv` attribute is world xz (handy for MeshStandardMaterial based ice).
 * `reachAt(z)` (optional) widens the kept margin row by row for spans without their own `reach`;
 * `bedAt(x, z)` is the ground height, needed by spans with `dryAbove`.
 */
export function buildWaterGrid(
  map: MapDef,
  box: { minX: number; maxX: number },
  step: number,
  ext: number,
  spans: GridSpan[],
  reachAt?: (z: number) => number,
  bedAt?: (x: number, z: number) => number,
): THREE.BufferGeometry {
  const cols = Math.max(2, Math.ceil((box.maxX - box.minX) / step));
  const dx = (box.maxX - box.minX) / cols;
  const pos: number[] = [];
  const fixed: number[] = [];
  const idx: number[] = [];
  for (const s of spans) {
    if (!(s.z1 > s.z0 + 1e-3)) continue;
    const rows = Math.max(2, Math.ceil((s.z1 - s.z0) / step) + 1);
    const dz = (s.z1 - s.z0) / (rows - 1);
    const stride = cols + 1;
    const chan = new Float32Array(rows * stride);
    const reach = new Float32Array(rows);
    // exact end rows, so neighbouring spans (river and cap) share bit-identical edge vertices
    const rowZ = (j: number): number => (j === rows - 1 ? s.z1 : j === 0 ? s.z0 : s.z0 + dz * j);
    for (let j = 0; j < rows; j++) {
      const z = rowZ(j);
      reach[j] = s.reach ?? (reachAt ? reachAt(z) : ext);
      for (let i = 0; i <= cols; i++) chan[j * stride + i] = waterDepthAt(map, box.minX + dx * i, z);
    }
    const hollow = s.hollow;
    const dryAbove = bedAt ? s.dryAbove : undefined;
    const bedG = dryAbove !== undefined && bedAt ? new Float32Array(rows * stride) : null;
    if (bedG && bedAt) {
      for (let j = 0; j < rows; j++) {
        const z = rowZ(j);
        for (let i = 0; i <= cols; i++) bedG[j * stride + i] = bedAt(box.minX + dx * i, z);
      }
    }
    const vid = new Int32Array(rows * stride).fill(-1);
    const vert = (i: number, j: number): number => {
      const k = j * stride + i;
      let v = vid[k];
      if (v < 0) {
        v = pos.length / 3;
        pos.push(box.minX + dx * i, 0, rowZ(j));
        fixed.push(s.fixed);
        vid[k] = v;
      }
      return v;
    };
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols; i++) {
        const k = j * stride + i;
        const c = Math.max(chan[k], chan[k + 1], chan[k + stride], chan[k + stride + 1]);
        if (!(c > -Math.max(reach[j], reach[j + 1]))) continue;
        if (hollow !== undefined && Math.min(chan[k], chan[k + 1], chan[k + stride], chan[k + stride + 1]) > -hollow) continue;
        if (bedG && dryAbove !== undefined && Math.min(bedG[k], bedG[k + 1], bedG[k + stride], bedG[k + stride + 1]) > dryAbove) continue;
        const a = vert(i, j);
        const b = vert(i + 1, j);
        const cc = vert(i, j + 1);
        const d = vert(i + 1, j + 1);
        // alternate the diagonal so long straight shores never show a sawtooth
        if ((i + j) & 1) idx.push(a, cc, d, a, d, b);
        else idx.push(a, cc, b, b, cc, d);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const nrm = new Float32Array(pos.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('aFixed', new THREE.Float32BufferAttribute(fixed, 1));
  const uv = new Float32Array((pos.length / 3) * 2);
  for (let v = 0; v < pos.length / 3; v++) {
    uv[v * 2] = pos[v * 3];
    uv[v * 2 + 1] = pos[v * 3 + 2];
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-map.w, -10, -map.d), new THREE.Vector3(map.w, 10, map.d));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), Math.hypot(map.w, map.d));
  return g;
}
