// Snapshot buffer with a smoothed server clock, for entity interpolation and timed event playback.
import { TICK_DT } from '../../shared/constants.ts';
import { clamp, lerp, lerpAngle } from '../../shared/math.ts';
import type { GameEvent, HookSnap, RuneSnap, Snapshot, UnitSnap } from '../../shared/types.ts';

const TICK_MS = TICK_DT * 1000;

/** Longest frame the client catches up on: inputs (GameClient), local ticks (LocalSession.pump) and the solo render clock. */
export const CATCH_UP_MS = 500;
/** Most ticks stepped (and inputs sent) in one frame: CATCH_UP_MS worth. */
export const CATCH_UP_TICKS = 15;
/** Longest frame step for animation, the camera and the online render clock. */
export const FRAME_CLAMP_MS = 100;

/**
 * Online render clock: how fast the drawn picture may run against real time while it follows the
 * server clock estimate (1 = real time). It never runs backwards: a delay that grows (jitter) or a
 * snapshot that lands early slows it down, a stream that comes back after a gap speeds it up.
 */
export const RENDER_RATE_MIN = 0.5;
export const RENDER_RATE_MAX = 2;
/** Rate change per tick the picture is off the estimate (0.25: off by 1 tick, run at 0.75 or 1.25). */
const RENDER_RATE_GAIN = 0.25;
/** Further behind than this (a long stall) and the picture jumps forward instead of catching up. */
const RENDER_SNAP_TICKS = 12;

/**
 * How far the render clock moves in one frame. Online the clock follows snapshot arrivals and a long
 * frame is clamped like everything else. Solo the sim steps up to CATCH_UP_MS of ticks in that same
 * frame, so the clock has to move as far, or every other unit, hook and rune is drawn up to 12 ticks
 * late and then fast-forwards.
 */
export function clockStepMs(local: boolean, rawMs: number): number {
  return clamp(rawMs, 0, local ? CATCH_UP_MS : FRAME_CLAMP_MS);
}

export interface Frame {
  tick: number; // fractional render tick
  units: Map<number, UnitSnap>;
  hooks: HookSnap[];
  runes: RuneSnap[];
  newer: Snapshot; // the snapshot at or after the render tick (scalars like score, river)
  /**
   * Hooks only in the newer snapshot (launched after the older one): drawn standing at the newer
   * position, not interpolated, until the render tick passes that snapshot.
   */
  freshHooks: ReadonlySet<number>;
  /** the newest snapshot received (ahead of the render tick by the interpolation delay) */
  latest: Snapshot;
}

export class SnapshotBuffer {
  private snaps: Snapshot[] = [];
  private clock = -1;
  /** online: the render tick handed out last frame (the picture only moves forward); NaN before the first */
  private render = Number.NaN;
  private lastTick = -1;
  private lastArrival = 0;
  private firedThrough = -1;
  private jitter = 0;
  private lastInterval = TICK_MS;
  /** interpolation delay in ticks */
  delay: number;
  private readonly minDelay: number;
  /** solo: snapshots come from the sim in this page, stepped inside the frame */
  private readonly local: boolean;

  constructor(local: boolean) {
    this.local = local;
    this.minDelay = local ? 1 : 2.5;
    this.delay = this.minDelay;
  }

  push(s: Snapshot, now: number): void {
    if (s.t <= this.lastTick) return; // stale or duplicate
    // Online, arrival spacing is network jitter and the delay grows to cover it. Solo snapshots are
    // stepped inside frame(), several at the same 'now' after a long frame: their spacing measures the
    // frame rate, not a network, so the delay stays at its minimum.
    if (this.lastTick >= 0 && !this.local) {
      const interval = (now - this.lastArrival) / Math.max(1, s.t - this.lastTick);
      this.jitter = this.jitter * 0.9 + Math.abs(interval - TICK_MS) * 0.1;
      this.lastInterval = interval;
    }
    this.lastTick = s.t;
    this.lastArrival = now;
    this.snaps.push(s);
    if (this.clock < 0) {
      this.clock = s.t;
      this.firedThrough = s.t - 1;
    }
    // keep ~2 seconds
    while (this.snaps.length > 64) this.snaps.shift();
    if (!this.local) this.delay = Math.min(8, Math.max(this.minDelay, this.minDelay + this.jitter / TICK_MS * 2.5));
  }

  get latest(): Snapshot | null {
    return this.snaps.length ? this.snaps[this.snaps.length - 1] : null;
  }

  /**
   * One frame of the render clock, the way GameClient.frame drives it. Returns the render tick.
   * Solo pause (`paused`): the match stands still, so the clock holds and the newest snapshot counts as
   * just arrived. On resume the picture carries on from where it stopped, with no catch-up and no
   * frames stuck on the newest snapshot.
   */
  frameTick(now: number, rawMs: number, paused = false): number {
    if (paused && this.local) {
      if (this.clock < 0) return -1;
      this.lastArrival = now;
      return Math.min(this.clock - this.delay, this.lastTick);
    }
    return this.advance(now, clockStepMs(this.local, rawMs));
  }

  /**
   * Advance the local estimate of the server clock. Returns the render tick.
   * The estimate itself wobbles with network jitter, and the delay grows in steps when a snapshot is
   * late: followed directly, the picture stepped back (2398 -> 2395 under heavy jitter) and every
   * interpolated unit, hook and rune with it. Online the render tick therefore follows the estimate at
   * a rate between RENDER_RATE_MIN and RENDER_RATE_MAX of real time and never goes back. Solo is
   * unchanged (its snapshots come from this page and its delay is fixed).
   */
  advance(now: number, dtMs: number): number {
    if (this.clock < 0) return -1;
    const step = dtMs / TICK_MS;
    this.clock += step;
    const target = this.lastTick + (now - this.lastArrival) / TICK_MS;
    const diff = target - this.clock;
    if (Math.abs(diff) > 12) this.clock = target;
    else this.clock += diff * 0.08;
    // never render past what we have
    const want = Math.min(this.clock - this.delay, this.lastTick);
    if (this.local) return want;
    const prev = this.render;
    if (Number.isNaN(prev) || want - prev > RENDER_SNAP_TICKS) {
      this.render = Number.isNaN(prev) ? want : Math.max(prev, want);
      return this.render;
    }
    // how far a picture running at real time would be off the estimate after this frame
    const off = want - (prev + step);
    let r = prev + step * clamp(1 + off * RENDER_RATE_GAIN, RENDER_RATE_MIN, RENDER_RATE_MAX);
    // never past the estimate when catching up, never behind it when slowing down
    r = off >= 0 ? Math.min(r, want) : Math.max(r, want);
    this.render = Math.max(prev, Math.min(r, this.lastTick));
    return this.render;
  }

  /** Events whose tick is now in the past of the render clock, oldest first. */
  takeEvents(renderTick: number, out: { tick: number; ev: GameEvent }[]): void {
    for (const s of this.snaps) {
      if (s.t <= this.firedThrough) continue;
      if (s.t > renderTick) break;
      for (const ev of s.ev) out.push({ tick: s.t, ev });
      this.firedThrough = s.t;
    }
  }

  sample(renderTick: number): Frame | null {
    const n = this.snaps.length;
    if (n === 0) return null;
    let b = n - 1;
    while (b > 0 && this.snaps[b - 1].t >= renderTick) b--;
    const nb = this.snaps[b];
    const na = b > 0 ? this.snaps[b - 1] : nb;
    const span = nb.t - na.t;
    const t = span > 0 ? Math.max(0, Math.min(1, (renderTick - na.t) / span)) : 1;
    const prev = new Map<number, UnitSnap>();
    for (const u of na.u) prev.set(u.i, u);
    const units = new Map<number, UnitSnap>();
    for (const u of nb.u) {
      const p = prev.get(u.i);
      if (!p || Math.abs(p.x - u.x) + Math.abs(p.z - u.z) > 8) {
        units.set(u.i, u);
        continue;
      }
      units.set(u.i, { ...u, x: lerp(p.x, u.x, t), z: lerp(p.z, u.z, t), y: lerp(p.y, u.y, t), f: lerpAngle(p.f, u.f, t), hp: t < 0.5 ? p.hp : u.hp });
    }
    const prevHooks = new Map<number, HookSnap>();
    for (const h of na.h) prevHooks.set(h.i, h);
    const freshHooks = new Set<number>();
    const hooks = nb.h.map((h) => {
      const p = prevHooks.get(h.i);
      if (!p) {
        freshHooks.add(h.i);
        return h;
      }
      return { ...h, x: lerp(p.x, h.x, t), z: lerp(p.z, h.z, t) };
    });
    const prevRunes = new Map<number, RuneSnap>();
    for (const r of na.r) prevRunes.set(r.i, r);
    const runes = nb.r.map((r) => {
      const p = prevRunes.get(r.i);
      if (!p) return r;
      return { ...r, x: lerp(p.x, r.x, t), z: lerp(p.z, r.z, t) };
    });
    return { tick: renderTick, units, hooks, runes, newer: nb, freshHooks, latest: this.snaps[n - 1] };
  }
}
