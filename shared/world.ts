// Collision world built from a MapDef. Used by the sim and by client-side movement prediction,
// so everything here must be deterministic and allocation-light.
import { clamp, sweepCircle } from './math.ts';
import { channelDepthAt, riverAt } from './maps/helpers.ts';
import type { MapDef, MoverDef, Obstacle } from './maps/types.ts';
import type { RiverState } from './types.ts';

export interface Contact {
  /** fraction along the swept segment where contact happened (0..1) */
  t: number;
  /** contact normal pointing away from the obstacle */
  nx: number;
  nz: number;
  bouncy: boolean;
  /** 'obstacle' index, 'mover' index, or 'bounds' */
  what: 'obstacle' | 'mover' | 'bounds';
  index: number;
}

export interface MoverPose {
  x: number;
  z: number;
  // capsule axis endpoints (equal to x/z for circles)
  ax: number;
  az: number;
  bx: number;
  bz: number;
  r: number;
  active: boolean;
}

export class World {
  readonly map: MapDef;
  readonly halfW: number;
  readonly halfD: number;
  readonly obstacles: Obstacle[];
  readonly moverPoses: MoverPose[];
  /** mover clock in seconds: advances only while movers are floating */
  moverClock = 0;
  moversActive = true;

  constructor(map: MapDef) {
    this.map = map;
    this.halfW = map.w / 2;
    this.halfD = map.d / 2;
    this.obstacles = map.obstacles;
    this.moverPoses = map.movers.map(() => ({ x: 0, z: 0, ax: 0, az: 0, bx: 0, bz: 0, r: 0, active: false }));
    this.updateMovers(0, true);
  }

  /** Signed metres inside the river channel (> 0 = in channel), islands count as ground. */
  channel(x: number, z: number): number {
    return channelDepthAt(this.map, x, z);
  }

  /** Outward gradient of the channel field (points from water toward land). */
  channelGradient(x: number, z: number): { nx: number; nz: number } {
    const e = 0.05;
    const gx = this.channel(x + e, z) - this.channel(x - e, z);
    const gz = this.channel(x, z + e) - this.channel(x, z - e);
    const l = Math.sqrt(gx * gx + gz * gz) || 1;
    // channel increases toward the water, so land is the negative gradient
    return { nx: -gx / l, nz: -gz / l };
  }

  riverCenter(z: number): { x: number; hw: number } {
    return riverAt(this.map.river.points, z);
  }

  /** Recompute mover poses for a given mover clock. */
  updateMovers(clock: number, active: boolean): void {
    this.moverClock = clock;
    this.moversActive = active;
    const span = this.map.d + 16;
    for (let i = 0; i < this.map.movers.length; i++) {
      const m = this.map.movers[i];
      const p = this.moverPoses[i];
      p.active = active;
      p.r = m.r;
      poseMover(this, m, clock, span, p);
    }
  }

  /** Push a circle (x,z,r) out of static obstacles, movers and map bounds. Returns corrected position. */
  resolveCircle(x: number, z: number, r: number, out: { x: number; z: number; hit: boolean }): void {
    let hit = false;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < this.obstacles.length; i++) {
        const o = this.obstacles[i];
        if (o.shape === 'circle') {
          const dx = x - o.x;
          const dz = z - o.z;
          const rr = r + o.r;
          const d2 = dx * dx + dz * dz;
          if (d2 < rr * rr) {
            const d = Math.sqrt(d2) || 1e-4;
            const push = rr - d;
            x += (dx / d) * push;
            z += (dz / d) * push;
            hit = true;
          }
        } else {
          const res = pushOutOfCapsule(x, z, r, o.ax, o.az, o.bx, o.bz, o.r);
          if (res) {
            x = res.x;
            z = res.z;
            hit = true;
          }
        }
      }
      for (const p of this.moverPoses) {
        if (!p.active) continue;
        const res = pushOutOfCapsule(x, z, r, p.ax, p.az, p.bx, p.bz, p.r);
        if (res) {
          x = res.x;
          z = res.z;
          hit = true;
        }
      }
    }
    const lx = this.halfW - r;
    const lz = this.halfD - r;
    if (x < -lx) { x = -lx; hit = true; }
    if (x > lx) { x = lx; hit = true; }
    if (z < -lz) { z = -lz; hit = true; }
    if (z > lz) { z = lz; hit = true; }
    out.x = x;
    out.z = z;
    out.hit = hit;
  }

  /**
   * Sweep a circle of radius r from (x0,z0) to (x1,z1) against obstacles, movers and bounds.
   * Returns the earliest contact or null. Used by hooks.
   */
  sweep(x0: number, z0: number, x1: number, z1: number, r: number): Contact | null {
    let best: Contact | null = null;
    const consider = (t: number, nx: number, nz: number, bouncy: boolean, what: Contact['what'], index: number) => {
      if (t < 0) return;
      if (!best || t < best.t) best = { t, nx, nz, bouncy, what, index };
    };
    for (let i = 0; i < this.obstacles.length; i++) {
      const o = this.obstacles[i];
      if (o.shape === 'circle') {
        const t = sweepCircle(x0, z0, x1, z1, o.x, o.z, r + o.r);
        if (t >= 0) {
          const hx = x0 + (x1 - x0) * t - o.x;
          const hz = z0 + (z1 - z0) * t - o.z;
          const l = Math.sqrt(hx * hx + hz * hz) || 1;
          consider(t, hx / l, hz / l, !!o.bouncy, 'obstacle', i);
        }
      } else {
        const c = sweepCapsule(x0, z0, x1, z1, r, o.ax, o.az, o.bx, o.bz, o.r);
        if (c) consider(c.t, c.nx, c.nz, !!o.bouncy, 'obstacle', i);
      }
    }
    for (let i = 0; i < this.moverPoses.length; i++) {
      const p = this.moverPoses[i];
      if (!p.active) continue;
      const c = sweepCapsule(x0, z0, x1, z1, r, p.ax, p.az, p.bx, p.bz, p.r);
      if (c) consider(c.t, c.nx, c.nz, false, 'mover', i);
    }
    // bounds
    const lx = this.halfW - r;
    const lz = this.halfD - r;
    const dx = x1 - x0;
    const dz = z1 - z0;
    if (x1 > lx && dx > 0) consider(clamp((lx - x0) / dx, 0, 1), -1, 0, false, 'bounds', 0);
    if (x1 < -lx && dx < 0) consider(clamp((-lx - x0) / dx, 0, 1), 1, 0, false, 'bounds', 1);
    if (z1 > lz && dz > 0) consider(clamp((lz - z0) / dz, 0, 1), 0, -1, false, 'bounds', 2);
    if (z1 < -lz && dz < 0) consider(clamp((-lz - z0) / dz, 0, 1), 0, 1, false, 'bounds', 3);
    return best;
  }

  /** True if the straight line between two points is free of obstacles and movers (for bots). */
  lineClear(x0: number, z0: number, x1: number, z1: number, r: number): boolean {
    const c = this.sweep(x0, z0, x1, z1, r);
    return !c || c.what === 'bounds';
  }
}

function poseMover(world: World, m: MoverDef, clock: number, span: number, p: MoverPose): void {
  // travel along z, wrapping over the full map depth plus margin
  const start = -world.halfD - 8;
  let z = m.offset + m.speed * clock - start;
  z = ((z % span) + span) % span + start;
  const c = world.riverCenter(z);
  const x = c.x + m.lane * c.hw;
  p.x = x;
  p.z = z;
  if (m.len > 0) {
    // orient the capsule along the local river tangent
    const c2 = world.riverCenter(z + 0.5);
    let tx = c2.x + m.lane * c2.hw - x;
    let tz = 0.5;
    const l = Math.sqrt(tx * tx + tz * tz);
    tx /= l;
    tz /= l;
    p.ax = x - tx * m.len * 0.5;
    p.az = z - tz * m.len * 0.5;
    p.bx = x + tx * m.len * 0.5;
    p.bz = z + tz * m.len * 0.5;
  } else {
    p.ax = p.bx = x;
    p.az = p.bz = z;
  }
}

function pushOutOfCapsule(x: number, z: number, r: number, ax: number, az: number, bx: number, bz: number, cr: number): { x: number; z: number } | null {
  const abx = bx - ax;
  const abz = bz - az;
  const l2 = abx * abx + abz * abz;
  let t = l2 > 1e-9 ? ((x - ax) * abx + (z - az) * abz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + abx * t;
  const pz = az + abz * t;
  const dx = x - px;
  const dz = z - pz;
  const rr = r + cr;
  const d2 = dx * dx + dz * dz;
  if (d2 >= rr * rr) return null;
  const d = Math.sqrt(d2);
  if (d < 1e-5) {
    // centre exactly on the axis: push perpendicular
    const l = Math.sqrt(l2) || 1;
    return { x: x - (abz / l) * rr, z: z + (abx / l) * rr };
  }
  return { x: px + (dx / d) * rr, z: pz + (dz / d) * rr };
}

/** Swept circle (radius r) vs capsule. Returns earliest contact or null. */
function sweepCapsule(
  x0: number, z0: number, x1: number, z1: number, r: number,
  ax: number, az: number, bx: number, bz: number, cr: number,
): { t: number; nx: number; nz: number } | null {
  const rr = r + cr;
  // Conservative sampling: capsule sweeps are rare and short (hook substeps), so sample finely.
  const dx = x1 - x0;
  const dz = z1 - z0;
  const lenSeg = Math.sqrt(dx * dx + dz * dz);
  const steps = Math.max(1, Math.ceil(lenSeg / (rr * 0.35)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const px = x0 + dx * t;
    const pz = z0 + dz * t;
    const abx = bx - ax;
    const abz = bz - az;
    const l2 = abx * abx + abz * abz;
    let u = l2 > 1e-9 ? ((px - ax) * abx + (pz - az) * abz) / l2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const qx = ax + abx * u;
    const qz = az + abz * u;
    const ex = px - qx;
    const ez = pz - qz;
    const d2 = ex * ex + ez * ez;
    if (d2 < rr * rr) {
      // refine with circle sweep against the closest axis point
      const tt = sweepCircle(x0, z0, x1, z1, qx, qz, rr);
      const tf = tt >= 0 ? Math.min(tt, t) : t;
      const hx = x0 + dx * tf - qx;
      const hz = z0 + dz * tf - qz;
      const l = Math.sqrt(hx * hx + hz * hz) || 1;
      return { t: tf, nx: hx / l, nz: hz / l };
    }
  }
  return null;
}

/** Ground surface under a point for a given river state. */
export type Surface = 'ground' | 'channelDry' | 'shallow' | 'ice' | 'deep';

export function surfaceAt(world: World, river: RiverState, x: number, z: number): Surface {
  if (world.channel(x, z) <= 0) return 'ground';
  if (river.frozen) return 'ice';
  if (river.deep) return 'deep';
  if (river.shallow) return 'shallow';
  return 'channelDry';
}
