// Procedural tileable textures for the water, generated once and cached as CPU pixel data.
//   slope map: RG = surface slope (d/du, d/dv) of a capillary wave spectrum, B = height, A = fine height
//   noise map: R = fbm, G = foam lace (cell edges), B = caustic network, A = second fbm
import * as THREE from 'three';
import { Rng } from '../../../../shared/math.ts';

const cache = new Map<string, Uint8Array>();

/** Tileable slope/height map from a sum of integer-wavenumber sines (perfectly periodic). */
function slopePixels(size: number): Uint8Array {
  const key = `slope${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const rng = new Rng(9137);
  const n = 72;
  const kx = new Float32Array(n);
  const kz = new Float32Array(n);
  const amp = new Float32Array(n);
  const ph = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let a = 0;
    let b = 0;
    let m = 0;
    while (m < 1.5 || m > 17) {
      a = rng.int(-17, 17);
      b = rng.int(-17, 17);
      m = Math.hypot(a, b);
    }
    kx[i] = a;
    kz[i] = b;
    amp[i] = Math.pow(m, -1.35) * rng.range(0.6, 1.2);
    ph[i] = rng.range(0, Math.PI * 2);
  }
  const h = new Float32Array(size * size);
  const sx = new Float32Array(size * size);
  const sz = new Float32Array(size * size);
  const fine = new Float32Array(size * size);
  const TAU = Math.PI * 2;
  // separable tables: sin(a + b) = sin a cos b + cos a sin b
  const su = new Float32Array(n * size);
  const cu = new Float32Array(n * size);
  const sv = new Float32Array(n * size);
  const cv = new Float32Array(n * size);
  const isFine = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    isFine[i] = Math.hypot(kx[i], kz[i]) > 8 ? 1 : 0;
    for (let p = 0; p < size; p++) {
      const a = (TAU * kx[i] * p) / size;
      const b = (TAU * kz[i] * p) / size + ph[i];
      su[i * size + p] = Math.sin(a);
      cu[i * size + p] = Math.cos(a);
      sv[i * size + p] = Math.sin(b);
      cv[i * size + p] = Math.cos(b);
    }
  }
  let maxS = 1e-6;
  let minH = Infinity;
  let maxH = -Infinity;
  let minF = Infinity;
  let maxF = -Infinity;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hh = 0;
      let dx = 0;
      let dz = 0;
      let ff = 0;
      for (let i = 0; i < n; i++) {
        const ia = i * size + x;
        const ib = i * size + y;
        const s = su[ia] * cv[ib] + cu[ia] * sv[ib];
        const c = cu[ia] * cv[ib] - su[ia] * sv[ib];
        const am = amp[i];
        hh += am * s;
        dx += am * TAU * kx[i] * c;
        dz += am * TAU * kz[i] * c;
        if (isFine[i]) ff += am * s;
      }
      const o = y * size + x;
      h[o] = hh;
      sx[o] = dx;
      sz[o] = dz;
      fine[o] = ff;
      maxS = Math.max(maxS, Math.abs(dx), Math.abs(dz));
      minH = Math.min(minH, hh);
      maxH = Math.max(maxH, hh);
      minF = Math.min(minF, ff);
      maxF = Math.max(maxF, ff);
    }
  }
  const out = new Uint8Array(size * size * 4);
  for (let o = 0; o < size * size; o++) {
    out[o * 4] = Math.round((sx[o] / maxS) * 127.5 + 127.5);
    out[o * 4 + 1] = Math.round((sz[o] / maxS) * 127.5 + 127.5);
    out[o * 4 + 2] = Math.round(((h[o] - minH) / (maxH - minH)) * 255);
    out[o * 4 + 3] = Math.round(((fine[o] - minF) / (maxF - minF)) * 255);
  }
  cache.set(key, out);
  return out;
}

// --- periodic value noise / worley helpers ---------------------------------------------------

function hashI(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function pvalue(u: number, v: number, period: number, seed: number): number {
  const x = u * period;
  const y = v * period;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const a = (xi % period + period) % period;
  const b = (yi % period + period) % period;
  const a1 = (a + 1) % period;
  const b1 = (b + 1) % period;
  const sx = xf * xf * (3 - 2 * xf);
  const sy = yf * yf * (3 - 2 * yf);
  const v00 = hashI(a, b, seed);
  const v10 = hashI(a1, b, seed);
  const v01 = hashI(a, b1, seed);
  const v11 = hashI(a1, b1, seed);
  return (v00 + (v10 - v00) * sx) * (1 - sy) + (v01 + (v11 - v01) * sx) * sy;
}

function pfbm(u: number, v: number, base: number, oct: number, seed: number): number {
  let sum = 0;
  let norm = 0;
  let amp = 0.5;
  let p = base;
  for (let i = 0; i < oct; i++) {
    sum += pvalue(u, v, p, seed + i * 31) * amp;
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

/** Periodic worley: returns [F1, F2] in cell units. */
function pworley(u: number, v: number, period: number, seed: number, out: Float32Array): void {
  const x = u * period;
  const y = v * period;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let f1 = 9;
  let f2 = 9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i;
      const cy = yi + j;
      const wx = (cx % period + period) % period;
      const wy = (cy % period + period) % period;
      const px = cx + 0.1 + 0.8 * hashI(wx, wy, seed);
      const py = cy + 0.1 + 0.8 * hashI(wx, wy, seed + 7);
      const d = Math.hypot(px - x, py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) f2 = d;
    }
  }
  out[0] = f1;
  out[1] = f2;
}

function noisePixels(size: number): Uint8Array {
  const key = `noise${size}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out = new Uint8Array(size * size * 4);
  const w = new Float32Array(2);
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const o = (y * size + x) * 4;
      const r = pfbm(u, v, 4, 5, 11);
      // foam lace: bubbly cell edges, two octaves
      pworley(u, v, 10, 3, w);
      let lace = 1 - smooth(0, 0.22, w[1] - w[0]);
      pworley(u, v, 23, 5, w);
      lace = Math.max(lace * 0.85, (1 - smooth(0, 0.18, w[1] - w[0])) * 0.7);
      const breakup = pfbm(u, v, 8, 3, 21);
      lace *= 0.55 + 0.6 * breakup;
      // caustic network: thin bright cell borders, slightly warped
      const wu = u + (pfbm(u, v, 4, 2, 41) - 0.5) * 0.04;
      const wv = v + (pfbm(u, v, 4, 2, 43) - 0.5) * 0.04;
      pworley(wu, wv, 7, 9, w);
      const edge = w[1] - w[0];
      const caustic = Math.pow(1 - smooth(0, 0.42, edge), 1.7);
      const a = pfbm(u, v, 8, 4, 77);
      out[o] = clamp255(r * 255);
      out[o + 1] = clamp255(lace * 255);
      out[o + 2] = clamp255(caustic * 255);
      out[o + 3] = clamp255(a * 255);
    }
  }
  // stretch fbm channels to full range
  for (const ch of [0, 3]) {
    let lo = 255;
    let hi = 0;
    for (let i = ch; i < out.length; i += 4) {
      lo = Math.min(lo, out[i]);
      hi = Math.max(hi, out[i]);
    }
    const k = 255 / Math.max(1, hi - lo);
    for (let i = ch; i < out.length; i += 4) out[i] = clamp255((out[i] - lo) * k);
  }
  cache.set(key, out);
  return out;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function makeTex(data: Uint8Array, size: number, aniso: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

export interface WaterTextures {
  slope: THREE.DataTexture;
  noise: THREE.DataTexture;
  dispose(): void;
}

export function createWaterTextures(hiRes: boolean, aniso: number): WaterTextures {
  const ss = hiRes ? 512 : 256;
  const slope = makeTex(slopePixels(ss), ss, aniso);
  const noise = makeTex(noisePixels(256), 256, aniso);
  return {
    slope,
    noise,
    dispose() {
      slope.dispose();
      noise.dispose();
    },
  };
}

/** Soft round puff with a little noise, for mist sprites. */
export function createPuffTexture(): THREE.DataTexture {
  const size = 64;
  const key = 'puff';
  let data = cache.get(key);
  if (!data) {
    data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x + 0.5) / size - 0.5;
        const v = (y + 0.5) / size - 0.5;
        const r = Math.hypot(u, v) * 2;
        const n = pfbm(x / size, y / size, 4, 3, 5);
        const a = Math.max(0, 1 - r) ** 1.6 * (0.55 + 0.6 * n);
        const o = (y * size + x) * 4;
        data[o] = 255;
        data[o + 1] = 255;
        data[o + 2] = 255;
        data[o + 3] = clamp255(a * 255);
      }
    }
    cache.set(key, data);
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}
