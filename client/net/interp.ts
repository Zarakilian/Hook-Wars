// Snapshot buffer with a smoothed server clock, for entity interpolation and timed event playback.
import { TICK_DT } from '../../shared/constants.ts';
import { lerp, lerpAngle } from '../../shared/math.ts';
import type { GameEvent, HookSnap, RuneSnap, Snapshot, UnitSnap } from '../../shared/types.ts';

const TICK_MS = TICK_DT * 1000;

export interface Frame {
  tick: number; // fractional render tick
  units: Map<number, UnitSnap>;
  hooks: HookSnap[];
  runes: RuneSnap[];
  newer: Snapshot; // the snapshot at or after the render tick (scalars like score, river)
}

export class SnapshotBuffer {
  private snaps: Snapshot[] = [];
  private clock = -1;
  private lastTick = -1;
  private lastArrival = 0;
  private firedThrough = -1;
  private jitter = 0;
  private lastInterval = TICK_MS;
  /** interpolation delay in ticks */
  delay: number;
  private readonly minDelay: number;

  constructor(local: boolean) {
    this.minDelay = local ? 1 : 2.5;
    this.delay = this.minDelay;
  }

  push(s: Snapshot, now: number): void {
    if (s.t <= this.lastTick) return; // stale or duplicate
    if (this.lastTick >= 0) {
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
    this.delay = Math.min(8, Math.max(this.minDelay, this.minDelay + this.jitter / TICK_MS * 2.5));
  }

  get latest(): Snapshot | null {
    return this.snaps.length ? this.snaps[this.snaps.length - 1] : null;
  }

  /** Advance the local estimate of the server clock. Returns the render tick. */
  advance(now: number, dtMs: number): number {
    if (this.clock < 0) return -1;
    this.clock += dtMs / TICK_MS;
    const target = this.lastTick + (now - this.lastArrival) / TICK_MS;
    const diff = target - this.clock;
    if (Math.abs(diff) > 12) this.clock = target;
    else this.clock += diff * 0.08;
    // never render past what we have
    return Math.min(this.clock - this.delay, this.lastTick);
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
    const hooks = nb.h.map((h) => {
      const p = prevHooks.get(h.i);
      if (!p) return h;
      return { ...h, x: lerp(p.x, h.x, t), z: lerp(p.z, h.z, t) };
    });
    const prevRunes = new Map<number, RuneSnap>();
    for (const r of na.r) prevRunes.set(r.i, r);
    const runes = nb.r.map((r) => {
      const p = prevRunes.get(r.i);
      if (!p) return r;
      return { ...r, x: lerp(p.x, r.x, t), z: lerp(p.z, r.z, t) };
    });
    return { tick: renderTick, units, hooks, runes, newer: nb };
  }
}
