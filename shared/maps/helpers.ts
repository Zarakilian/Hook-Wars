// Deterministic helpers for authoring maps: river shapes, scatter, mirrored layouts.
import { Rng } from '../math.ts';
import type { Circle, Decor, DecorKind, MapDef, Obstacle, RiverPoint } from './types.ts';

/** Sample a gently curving river centreline from z = -d/2 - 2 to d/2 + 2. */
export function curvyRiver(d: number, opts: { amp: number; freq: number; phase: number; hw: number; hwVar: number; step?: number }): RiverPoint[] {
  const pts: RiverPoint[] = [];
  const step = opts.step ?? 2;
  for (let z = -d / 2 - 4; z <= d / 2 + 4 + 1e-6; z += step) {
    const x = Math.sin(z * opts.freq + opts.phase) * opts.amp;
    const hw = opts.hw + Math.sin(z * opts.freq * 1.7 + opts.phase * 2.3) * opts.hwVar;
    pts.push({ z, x, hw });
  }
  return pts;
}

/**
 * Point-symmetric river centreline: x(-z) = -x(z) and hw(-z) = hw(z), so both banks are the same
 * shape under the (x, z) -> (-x, -z) mirror that withMirrors() uses for obstacles.
 * x = amp sin(f z) + amp3 sin(2.7 f z); hw = hw + hwVar cos(hwFreq z). Samples from -d/2-4 to d/2+4.
 */
export function symmetricRiver(
  d: number,
  opts: { amp: number; freq: number; amp3?: number; hw: number; hwVar: number; hwFreq?: number; step?: number },
): RiverPoint[] {
  const pts: RiverPoint[] = [];
  const step = opts.step ?? 2;
  const n = Math.ceil((d / 2 + 4) / step);
  const hf = opts.hwFreq ?? opts.freq * 1.7;
  for (let i = -n; i <= n; i++) {
    const z = i * step;
    const x = Math.sin(z * opts.freq) * opts.amp + Math.sin(z * opts.freq * 2.7) * (opts.amp3 ?? 0);
    const hw = opts.hw + Math.cos(z * hf) * opts.hwVar;
    pts.push({ z, x: Math.abs(x) < 1e-9 ? 0 : x, hw });
  }
  return pts;
}

/** A list of points plus their point mirrors (-x, -z). Use for hazard slots and rune spots. */
export function withMirroredPoints<T extends { x: number; z: number }>(list: T[]): T[] {
  const out = [...list];
  for (const p of list) if (Math.abs(p.x) > 1e-6 || Math.abs(p.z) > 1e-6) out.push({ ...p, x: -p.x, z: -p.z });
  return out;
}

/** Centreline x and half width at z (linear between samples). */
export function riverAt(points: RiverPoint[], z: number): { x: number; hw: number } {
  if (z <= points[0].z) return { x: points[0].x, hw: points[0].hw };
  const last = points[points.length - 1];
  if (z >= last.z) return { x: last.x, hw: last.hw };
  // binary search
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].z <= z) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const t = (z - a.z) / (b.z - a.z);
  return { x: a.x + (b.x - a.x) * t, hw: a.hw + (b.hw - a.hw) * t };
}

/** Mirror an obstacle across x = 0 and z = 0 (point symmetry) so both teams get the same layout. */
export function mirrorObstacle(o: Obstacle): Obstacle {
  if (o.shape === 'circle') return { ...o, x: -o.x, z: -o.z, rot: (o.rot ?? 0) + Math.PI };
  return { ...o, ax: -o.ax, az: -o.az, bx: -o.bx, bz: -o.bz };
}

export function withMirrors(list: Obstacle[]): Obstacle[] {
  return [...list, ...list.map(mirrorObstacle)];
}

export interface ScatterOpts {
  kind: DecorKind;
  count: number;
  seed: number;
  scale: [number, number];
  /** Accept predicate on candidate positions. */
  accept: (x: number, z: number) => boolean;
  minX?: number;
  maxX?: number;
  minZ?: number;
  maxZ?: number;
}

/** Scatter decor deterministically inside the map, filtered by `accept`. */
export function scatter(map: Pick<MapDef, 'w' | 'd'>, o: ScatterOpts): Decor[] {
  const rng = new Rng(o.seed);
  const out: Decor[] = [];
  const minX = o.minX ?? -map.w / 2;
  const maxX = o.maxX ?? map.w / 2;
  const minZ = o.minZ ?? -map.d / 2;
  const maxZ = o.maxZ ?? map.d / 2;
  let tries = 0;
  while (out.length < o.count && tries < o.count * 30) {
    tries++;
    const x = rng.range(minX, maxX);
    const z = rng.range(minZ, maxZ);
    if (!o.accept(x, z)) continue;
    out.push({ kind: o.kind, x, z, rot: rng.range(0, Math.PI * 2), scale: rng.range(o.scale[0], o.scale[1]), seed: rng.int(0, 1 << 30) });
  }
  return out;
}

/** True if (x,z) is clear of all obstacles by `pad` metres. */
export function clearOf(obstacles: Obstacle[], x: number, z: number, pad: number): boolean {
  for (const o of obstacles) {
    if (o.shape === 'circle') {
      const dx = x - o.x;
      const dz = z - o.z;
      if (dx * dx + dz * dz < (o.r + pad) * (o.r + pad)) return false;
    } else {
      const abx = o.bx - o.ax;
      const abz = o.bz - o.az;
      const l2 = abx * abx + abz * abz;
      let t = l2 > 0 ? ((x - o.ax) * abx + (z - o.az) * abz) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = o.ax + abx * t;
      const pz = o.az + abz * t;
      const dx = x - px;
      const dz = z - pz;
      if (dx * dx + dz * dz < (o.r + pad) * (o.r + pad)) return false;
    }
  }
  return true;
}

export function inCircles(circles: Circle[], x: number, z: number, pad = 0): boolean {
  for (const c of circles) {
    const dx = x - c.x;
    const dz = z - c.z;
    if (dx * dx + dz * dz < (c.r + pad) * (c.r + pad)) return true;
  }
  return false;
}

/** Signed distance into the channel (> 0 inside water area), islands excluded. */
export function channelDepthAt(map: Pick<MapDef, 'river' | 'islands'> & Partial<Pick<MapDef, 'channels' | 'pools' | 'platforms'>>, x: number, z: number): number {
  const r = riverAt(map.river.points, z);
  let c = r.hw - Math.abs(x - r.x);
  // braided side channels: only inside their own z range
  if (map.channels) {
    for (const ch of map.channels) {
      const pts = ch.points;
      if (z < pts[0].z || z > pts[pts.length - 1].z) continue;
      const q = riverAt(pts, z);
      const cc = q.hw - Math.abs(x - q.x);
      if (cc > c) c = cc;
    }
  }
  // lagoons and basins: rotated ellipses, metres inside the rim (approximate near the rim, exact on the axes)
  if (map.pools) {
    for (const p of map.pools) {
      const dx = x - p.x;
      const dz = z - p.z;
      const cs = Math.cos(p.rot);
      const sn = Math.sin(p.rot);
      const lx = dx * cs - dz * sn;
      const lz = dx * sn + dz * cs;
      const k = Math.sqrt((lx / p.rx) ** 2 + (lz / p.rz) ** 2);
      const cc = (1 - k) * Math.min(p.rx, p.rz);
      if (cc > c) c = cc;
    }
  }
  // decks over the water are dry ground
  if (map.platforms) {
    for (const p of map.platforms) {
      const dx = x - p.x;
      const dz = z - p.z;
      const cs = Math.cos(p.rot);
      const sn = Math.sin(p.rot);
      const lx = dx * cs - dz * sn;
      const lz = dx * sn + dz * cs;
      const inside = Math.min(p.w / 2 - Math.abs(lx), p.d / 2 - Math.abs(lz));
      if (-inside < c) c = -inside;
    }
  }
  for (const isl of map.islands) {
    const dx = x - isl.x;
    const dz = z - isl.z;
    const d = Math.sqrt(dx * dx + dz * dz) - isl.r;
    if (d < c) c = d;
  }
  return c;
}
