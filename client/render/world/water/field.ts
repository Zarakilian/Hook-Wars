// Baked channel field: bed height, signed channel distance and a puddle mask over the river region.
// One RGBA8 texture feeds every water shader; a CPU copy answers surfaceHeight() without noise calls.
import * as THREE from 'three';
import { channelDepthAt, riverAt } from '../../../../shared/maps/helpers.ts';
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

export function bakeField(map: MapDef, ground: (x: number, z: number) => number, cell: number, withStream = false): WaterField {
  const pts = map.river.points;
  const ext = Math.min(map.river.bank, 2.4) + 0.4;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x - p.hw - ext - 1);
    maxX = Math.max(maxX, p.x + p.hw + ext + 1);
  }
  const minZ = pts[0].z;
  const maxZ = pts[pts.length - 1].z;
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
      const c = channelDepthAt(map, x, z);
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
}

/**
 * River-following grid: rows of constant z, each row spanning the channel plus `ext` on both sides.
 * Spans are separate patches (no shared vertices) so lock reservoirs can sit at a different level.
 */
export function buildRiverGrid(map: MapDef, step: number, ext: number, spans: GridSpan[], withChan = false): THREE.BufferGeometry {
  const pts = map.river.points;
  let maxW = 0;
  for (const p of pts) maxW = Math.max(maxW, p.hw * 2 + ext * 2);
  const cols = Math.max(8, Math.ceil(maxW / step));
  const pos: number[] = [];
  const fixed: number[] = [];
  const chanA: number[] = [];
  const idx: number[] = [];
  for (const s of spans) {
    const rows = Math.max(2, Math.ceil((s.z1 - s.z0) / step) + 1);
    const base = pos.length / 3;
    for (let j = 0; j < rows; j++) {
      const z = s.z0 + ((s.z1 - s.z0) * j) / (rows - 1);
      const r = riverAt(pts, z);
      const x0 = r.x - r.hw - ext;
      const x1 = r.x + r.hw + ext;
      for (let i = 0; i <= cols; i++) {
        // cluster columns a little toward the edges, where shore detail lives
        const t = i / cols;
        const e = t - 0.5;
        const tt = 0.5 + e * (0.82 + 0.72 * e * e);
        const x = x0 + (x1 - x0) * tt;
        pos.push(x, 0, z);
        fixed.push(s.fixed);
        if (withChan) chanA.push(channelDepthAt(map, x, z));
      }
    }
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols; i++) {
        const a = base + j * (cols + 1) + i;
        const b = a + 1;
        const c = a + cols + 1;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const nrm = new Float32Array(pos.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('aFixed', new THREE.Float32BufferAttribute(fixed, 1));
  if (withChan) g.setAttribute('aChan', new THREE.Float32BufferAttribute(chanA, 1));
  // uv = world xz (handy for MeshStandardMaterial based ice)
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
