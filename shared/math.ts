// Small math helpers shared by the sim, server and client. No allocations in hot paths.

export interface Vec2 {
  x: number;
  z: number;
}

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function len(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

export function dist(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return Math.sqrt(dx * dx + dz * dz);
}

export function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  return dx * dx + dz * dz;
}

/** Shortest signed angle from a to b, in (-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

export function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDelta(a, b) * t;
}

/** Round to 2 decimals for compact network payloads. */
export function q2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function q3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Closest point parameter t in [0,1] on segment AB to point P. */
export function segmentT(ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const l2 = abx * abx + abz * abz;
  if (l2 < 1e-9) return 0;
  return clamp(((px - ax) * abx + (pz - az) * abz) / l2, 0, 1);
}

/** Distance from point P to segment AB. */
export function distToSegment(ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
  const t = segmentT(ax, az, bx, bz, px, pz);
  return dist(ax + (bx - ax) * t, az + (bz - az) * t, px, pz);
}

/**
 * Earliest time t in [0,1] at which a point moving from P0 to P1 comes within distance r of C.
 * Returns -1 if it never does. If P0 already starts inside, returns 0.
 */
export function sweepCircle(p0x: number, p0z: number, p1x: number, p1z: number, cx: number, cz: number, r: number): number {
  const dx = p1x - p0x;
  const dz = p1z - p0z;
  const fx = p0x - cx;
  const fz = p0z - cz;
  const c = fx * fx + fz * fz - r * r;
  if (c <= 0) return 0;
  const a = dx * dx + dz * dz;
  if (a < 1e-12) return -1;
  const b = 2 * (fx * dx + fz * dz);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t >= 0 && t <= 1 ? t : -1;
}

/** Mulberry32 seeded RNG. Deterministic across server and client. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  int(lo: number, hiInclusive: number): number {
    return lo + Math.floor(this.next() * (hiInclusive - lo + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

/** Cheap deterministic hash of integers to [0,1). Useful for per-object variation. */
export function hash01(a: number, b = 0, c = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 2D value noise in [0,1], smooth, deterministic. */
export function valueNoise2(x: number, z: number, seed = 0): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const a = hash01(xi, zi, seed);
  const b = hash01(xi + 1, zi, seed);
  const c = hash01(xi, zi + 1, seed);
  const d = hash01(xi + 1, zi + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/** Fractal value noise, roughly in [0,1]. */
export function fbm2(x: number, z: number, octaves = 4, seed = 0): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2(x * freq, z * freq, seed + i * 17) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}
