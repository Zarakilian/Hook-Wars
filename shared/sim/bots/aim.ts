// Hook aiming: intercept prediction, a hook path tracer that mirrors the sim (whirlpool bend,
// bouncy posts, Ricochet bounces), and a solver that finds an aim angle whose path meets the target.
import { BAL, UNIT_RADIUS } from '../../constants.ts';
import type { Whirlpool } from '../../maps/types.ts';
import type { World } from '../../world.ts';

const HOOK_SUBSTEP = 0.35; // same as the sim
const MAXP = 160;

/** A traced hook path: polyline points with the time (from the press) the head reaches each one. */
export class HookPath {
  n = 0;
  readonly x = new Float64Array(MAXP);
  readonly z = new Float64Array(MAXP);
  readonly t = new Float64Array(MAXP);
  bent = false;
  bounced = false;
  push(x: number, z: number, t: number): void {
    if (this.n >= MAXP) return;
    this.x[this.n] = x;
    this.z[this.n] = z;
    this.t[this.n] = t;
    this.n++;
  }
}

/** Result of an intercept solve. */
export interface Intercept {
  ax: number;
  az: number;
  /** Seconds from the press until the head reaches the aim point. */
  t: number;
  /** Distance from the shooter to the aim point. */
  d: number;
}

/**
 * Where to aim so a hook (wind-up, then `speed` m/s from the hand) meets a target at (px, pz) moving
 * at (vx, vz). `lead` scales how much of the velocity the shooter trusts (0 = aim at the body).
 */
export function intercept(sx: number, sz: number, px: number, pz: number, vx: number, vz: number, speed: number, windup: number, lead: number, out: Intercept): Intercept {
  let d = Math.hypot(px - sx, pz - sz);
  let t = windup + Math.max(0, d - BAL.hookHand) / speed;
  let ax = px;
  let az = pz;
  for (let i = 0; i < 4; i++) {
    ax = px + vx * lead * t;
    az = pz + vz * lead * t;
    d = Math.hypot(ax - sx, az - sz);
    t = windup + Math.max(0, d - BAL.hookHand) / speed;
  }
  out.ax = ax;
  out.az = az;
  out.t = t;
  out.d = d;
  return out;
}

/** Distance along the ray (x,z)+(dx,dz)s to where it enters circle (cx,cz,r), or -1. */
function rayEnter(x: number, z: number, dx: number, dz: number, cx: number, cz: number, r: number): number {
  const fx = x - cx;
  const fz = z - cz;
  const b = fx * dx + fz * dz;
  const c = fx * fx + fz * fz - r * r;
  if (c <= 0) return 0;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = -b - Math.sqrt(disc);
  return s >= 0 ? s : -1;
}

/**
 * Trace a hook head from the hand point (sx, sz) in direction (dx, dz) exactly the way the sim moves it:
 * straight runs, 0.35 m substeps with bend inside the whirlpool, bounces off bouncy obstacles and,
 * with Ricochet, off anything. Unit and rune hits are checked separately (scanPath).
 */
export function traceHook(
  world: World, wp: Whirlpool | undefined, sx: number, sz: number, dx: number, dz: number,
  speed: number, r: number, range: number, bounces: number, t0: number, out: HookPath,
): HookPath {
  out.n = 0;
  out.bent = false;
  out.bounced = false;
  out.push(sx, sz, t0);
  let x = sx;
  let z = sz;
  let traveled = 0;
  let left = bounces;
  let guard = 0;
  while (traveled < range - 1e-4 && guard++ < 300) {
    let inWp = false;
    let wd = 0;
    if (wp) {
      wd = Math.hypot(x - wp.x, z - wp.z);
      inWp = wd < wp.r;
    }
    let step: number;
    if (inWp) {
      step = Math.min(HOOK_SUBSTEP, range - traveled);
      const w = wp!.strength * (1 - wd / wp!.r);
      const a = w * (step / speed);
      const c = Math.cos(a);
      const s = Math.sin(a);
      const ndx = dx * c - dz * s;
      const ndz = dx * s + dz * c;
      dx = ndx;
      dz = ndz;
      out.bent = true;
    } else {
      step = range - traveled;
      if (wp) {
        const e = rayEnter(x, z, dx, dz, wp.x, wp.z, wp.r);
        if (e >= 0 && e < step) step = Math.max(e + 0.01, 0.01);
      }
    }
    const nx = x + dx * step;
    const nz = z + dz * step;
    const c = world.sweep(x, z, nx, nz, r);
    if (c) {
      const hx = x + dx * step * c.t;
      const hz = z + dz * step * c.t;
      traveled += step * c.t;
      out.push(hx, hz, t0 + traveled / speed);
      if (c.bouncy || left > 0) {
        if (!c.bouncy) left--;
        const dot = dx * c.nx + dz * c.nz;
        dx -= 2 * dot * c.nx;
        dz -= 2 * dot * c.nz;
        const l = Math.hypot(dx, dz) || 1;
        dx /= l;
        dz /= l;
        x = hx + c.nx * 0.02;
        z = hz + c.nz * 0.02;
        out.bounced = true;
        // the sim keeps stepping the remainder of the substep; close enough to restart here
        if (step * c.t < 1e-4) traveled += 0.02;
        continue;
      }
      return out;
    }
    x = nx;
    z = nz;
    traveled += step;
    if (inWp || traveled >= range - 1e-4) out.push(x, z, t0 + traveled / speed);
  }
  if (out.n === 1) out.push(x, z, t0 + traveled / speed);
  return out;
}

/** A unit or rune that may sit in a hook's way, with linear motion prediction. */
export interface Body {
  id: number;
  /** 0 = enemy, 1 = ally, 2 = rune */
  kind: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  r: number;
  /** body can only be hit after this many seconds (spawn protection) */
  after: number;
}

export interface ScanResult {
  /** index into bodies of the first thing the hook touches, -1 if none */
  first: number;
  firstT: number;
  /** closest approach to the focus body (centre distance) and which side it passes on */
  miss: number;
  side: number;
  /** time of that closest approach */
  missT: number;
}

/**
 * Walk a traced path and find the first body it touches (exact for linear motion within each segment).
 * Also reports the closest approach to bodies[focus] even if something else is hit first.
 */
export function scanPath(path: HookPath, hookR: number, bodies: readonly Body[], nb: number, focus: number, out: ScanResult): ScanResult {
  out.first = -1;
  out.firstT = Infinity;
  out.miss = Infinity;
  out.side = 0;
  out.missT = 0;
  for (let i = 0; i + 1 < path.n; i++) {
    const t0 = path.t[i];
    const t1 = path.t[i + 1];
    const dt = t1 - t0;
    if (dt <= 1e-6) continue;
    if (t0 >= out.firstT) break; // the hook already caught something and is coming back
    const px = path.x[i];
    const pz = path.z[i];
    const hvx = (path.x[i + 1] - px) / dt;
    const hvz = (path.z[i + 1] - pz) / dt;
    for (let k = 0; k < nb; k++) {
      const b = bodies[k];
      // relative position at segment start and relative velocity
      const ax = px - (b.x + b.vx * t0);
      const az = pz - (b.z + b.vz * t0);
      const bx = hvx - b.vx;
      const bz = hvz - b.vz;
      const bb = bx * bx + bz * bz;
      if (k === focus) {
        let s = bb > 1e-9 ? -(ax * bx + az * bz) / bb : 0;
        s = s < 0 ? 0 : s > dt ? dt : s;
        const rx = ax + bx * s;
        const rz = az + bz * s;
        const m = Math.sqrt(rx * rx + rz * rz);
        if (m < out.miss) {
          out.miss = m;
          // which side of the head's path the body passes: cross(head velocity, body - head)
          out.side = hvx * -rz - hvz * -rx >= 0 ? 1 : -1;
          out.missT = t0 + s;
        }
      }
      const R = hookR + b.r;
      const c = ax * ax + az * az - R * R;
      let s: number;
      if (c <= 0) s = 0;
      else {
        if (bb < 1e-9) continue;
        const hb = ax * bx + az * bz;
        const disc = hb * hb - bb * c;
        if (disc < 0) continue;
        s = (-hb - Math.sqrt(disc)) / bb;
        if (s < 0 || s > dt) continue;
      }
      const tt = t0 + s;
      if (tt < b.after) continue;
      if (tt < out.firstT) {
        out.firstT = tt;
        out.first = k;
      }
    }
  }
  return out;
}

export const UNIT_BODY_R = UNIT_RADIUS;
export const RUNE_BODY_R = BAL.runeRadius;
