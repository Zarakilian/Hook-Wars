// Per-match bot blackboard, updated once per tick before any bot thinks.
// It only records what a player could observe: positions as they were seen (with per-team stealth),
// hooks in flight (all hooks are public), unit states, and the public tide schedule.
// Bots then read it with a perception delay, so they react to the world a little late, like people do.
import { BAL, FAMILY_DEFS, HOOK_LEVELS, TICK_DT } from '../../constants.ts';
import { dist } from '../../math.ts';
import { HookKind, HookPhase, UnitState, type RiverState, type Team } from '../../types.ts';
import type { Unit } from '../entities.ts';
import { riverStateAt, tidalActive } from '../river.ts';
import type { GameSim } from '../sim.ts';
import { mapInfo, type MapInfo } from './mapinfo.ts';

/** Ticks of position history kept per unit (about 1 s). */
export const HIST = 32;

export interface Track {
  x: Float32Array;
  z: Float32Array;
  /** bit 0: team 0 could see it, bit 1: team 1 could see it (dead units are never visible). */
  vis: Uint8Array;
  n: number;
  lastState: number;
  /** Public estimate of when this unit's hook is ready again (from its last observed throw). */
  hookReadyAt: number;
  /** Longest hook reach seen from this unit. */
  reach: number;
  hookSpeed: number;
  hookR: number;
  respawnAt: number;
  /** Public estimates from observed wind-ups (bash and grapple casts are visible). */
  bashReadyAt: number;
  grappleReadyAt: number;
  /** When this unit started drowning (public: the splash and the swim flag). */
  drownAt: number;
  /** Tick this unit last started a wind-up. */
  castAt: number;
  tick: number;
}

/** Scratch output of BotContext.perceive. */
export interface Seen {
  x: number;
  z: number;
  vx: number;
  vz: number;
}

interface HookObs {
  owner: number;
  lx: number;
  lz: number;
  first: number;
  tick: number;
}

interface Claim {
  by: number;
  until: number;
}

export class BotContext {
  readonly sim: GameSim;
  readonly info: MapInfo;
  tick = -1;
  head = 0;
  readonly tracks = new Map<number, Track>();
  private readonly hooksSeen = new Map<number, HookObs>();
  private readonly claims: [Map<number, Claim>, Map<number, Claim>] = [new Map(), new Map()];
  /** Living enemies that team t can see right now. */
  readonly foes: [Unit[], Unit[]] = [[], []];
  /** Living members of team t. */
  readonly alive: [Unit[], Unit[]] = [[], []];
  /** Every member of team t, dead or alive. */
  readonly members: [Unit[], Unit[]] = [[], []];

  /** Seconds until the channel becomes lethal deep water (0 = it is deep now). */
  untilDeep = 0;
  /** Seconds until the channel is walkable (0 = walkable now). */
  untilWalk = Infinity;
  /** Length of the current (or next) walkable window in seconds. */
  walkFor = 0;
  private forecastTick = -999;
  private lastDeep = true;
  private readonly scratch: RiverState = { level: 1, deep: true, shallow: false, frozen: false, phase: 'none', phaseLeft: 0, cycle: false };

  constructor(sim: GameSim) {
    this.sim = sim;
    this.info = mapInfo(sim.map);
  }

  update(): void {
    const sim = this.sim;
    if (this.tick === sim.tick) return;
    const elapsed = this.tick < 0 ? 0 : (sim.tick - this.tick) * TICK_DT;
    this.tick = sim.tick;
    this.head = (this.head + 1) % HIST;
    const h = this.head;
    for (let t = 0; t < 2; t++) {
      this.foes[t].length = 0;
      this.alive[t].length = 0;
      this.members[t].length = 0;
    }
    for (const u of sim.units) {
      let tr = this.tracks.get(u.id);
      if (!tr) {
        tr = {
          x: new Float32Array(HIST), z: new Float32Array(HIST), vis: new Uint8Array(HIST), n: 0, lastState: u.state,
          hookReadyAt: 0, reach: HOOK_LEVELS.range[0], hookSpeed: HOOK_LEVELS.speed[0], hookR: HOOK_LEVELS.width[0], respawnAt: -99,
          bashReadyAt: 0, grappleReadyAt: 0, drownAt: -99, castAt: -1, tick: 0,
        };
        this.tracks.set(u.id, tr);
      }
      const dead = u.state === UnitState.Dead;
      tr.x[h] = u.x;
      tr.z[h] = u.z;
      tr.vis[h] = dead ? 0 : (sim.visibleTo(u, 0) ? 1 : 0) | (sim.visibleTo(u, 1) ? 2 : 0);
      if (tr.lastState === UnitState.Dead && !dead) {
        tr.respawnAt = sim.time;
        tr.hookReadyAt = sim.time; // respawn resets the hook
        tr.bashReadyAt = Math.min(tr.bashReadyAt, sim.time + 1);
        tr.grappleReadyAt = Math.min(tr.grappleReadyAt, sim.time + 2);
      }
      if (u.state !== tr.lastState) {
        if (u.state === UnitState.Casting) {
          tr.castAt = sim.tick;
          if (u.castKind === 'bash') tr.bashReadyAt = sim.time + BAL.bashCooldown;
          else if (u.castKind === 'grapple') tr.grappleReadyAt = sim.time + BAL.grappleCooldown;
        } else if (u.state === UnitState.Grappling && tr.lastState === UnitState.Drowning) {
          tr.grappleReadyAt = sim.time + BAL.grappleCooldown; // grapple out of the water has no wind-up
        } else if (u.state === UnitState.Drowning) tr.drownAt = sim.time;
      }
      tr.lastState = u.state;
      tr.tick = this.tick;
      if (tr.n < 1e9) tr.n++;
      this.members[u.team].push(u);
      if (!dead) this.alive[u.team].push(u);
    }
    for (let t = 0 as Team; t < 2; t = (t + 1) as Team) {
      const foes = this.foes[t];
      const bit = 1 << t;
      for (const e of this.alive[t === 0 ? 1 : 0]) {
        const tr = this.tracks.get(e.id)!;
        if (tr.vis[h] & bit) foes.push(e);
      }
    }
    if (this.tick % 300 === 0) {
      for (const [id, tr] of this.tracks) if (tr.tick !== this.tick) this.tracks.delete(id);
      for (const m of this.claims) for (const [id, c] of m) if (c.until < sim.time) m.delete(id);
    }
    this.observeHooks();
    this.forecast(elapsed);
  }

  /** Watch hooks in flight: who threw, when, how far they reach. All of this is public. */
  private observeHooks(): void {
    const sim = this.sim;
    for (const hk of sim.hooks) {
      if (hk.kind !== HookKind.Hook || hk.dead) continue;
      let obs = this.hooksSeen.get(hk.id);
      const owner = sim.unitById.get(hk.owner);
      if (!owner) continue;
      const tr = this.tracks.get(owner.id);
      if (!obs) {
        obs = { owner: owner.id, lx: owner.x, lz: owner.z, first: this.tick, tick: this.tick };
        this.hooksSeen.set(hk.id, obs);
        if (tr) {
          const cd = BAL.hookCooldown * (FAMILY_DEFS[owner.family]?.hookCdMul ?? 1);
          tr.hookReadyAt = sim.time + cd - BAL.hookWindup - TICK_DT;
          tr.hookSpeed = hk.speed;
          tr.hookR = hk.r;
        }
      }
      obs.tick = this.tick;
      if (tr && hk.phase === HookPhase.Out) {
        const d = dist(obs.lx, obs.lz, hk.x, hk.z) + 0.2;
        if (d > tr.reach) tr.reach = d;
      }
    }
    if (this.hooksSeen.size > 0) for (const [id, o] of this.hooksSeen) if (o.tick !== this.tick) this.hooksSeen.delete(id);
  }

  /** Seconds since a hook in flight was first seen (0 if unknown). */
  hookAge(id: number): number {
    const o = this.hooksSeen.get(id);
    return o ? (this.tick - o.first) * TICK_DT : 0;
  }

  /** Metres a hook in flight has covered since it left its owner (from where the throw was seen). */
  hookTravel(id: number, hx: number, hz: number): number {
    const o = this.hooksSeen.get(id);
    return o ? Math.max(0, dist(o.lx, o.lz, hx, hz) - BAL.hookHand) : 0;
  }

  /**
   * Spawn protection left on `u` as a player can tell it: the shimmer is visible, and respawns are
   * public, so the remaining time follows from when we saw them pop back in.
   */
  spawnProtLeft(u: Unit, viewer: Unit): number {
    if (u.spawnProt <= 0) return 0;
    if (u.team === viewer.team) return u.spawnProt;
    const tr = this.tracks.get(u.id);
    return tr ? Math.max(0.05, tr.respawnAt + BAL.spawnProt - this.sim.time) : BAL.spawnProt;
  }

  /** Public estimate of when `u` can bash again. Bots know their bot allies exactly. */
  bashReadyIn(u: Unit, viewer: Unit): number {
    if (u.team === viewer.team && u.isBot) return u.cdBash;
    const tr = this.tracks.get(u.id);
    return tr ? Math.max(0, tr.bashReadyAt - this.sim.time) : 0;
  }

  grappleReadyIn(u: Unit, viewer: Unit): number {
    if (u.team === viewer.team && u.isBot) return u.cdGrapple;
    const tr = this.tracks.get(u.id);
    return tr ? Math.max(0, tr.grappleReadyAt - this.sim.time) : 0;
  }

  /** Expected reach of a unit's hook: what we have seen, or what an upgraded hook would do by now. */
  reachOf(u: Unit): number {
    const tr = this.tracks.get(u.id);
    const guess = HOOK_LEVELS.range[Math.min(5, Math.floor(this.sim.matchTime / 75))];
    return Math.max(tr ? tr.reach : HOOK_LEVELS.range[0], guess);
  }

  /** Seconds until `u`'s hook is ready, as `viewer` would know it. Bots know their bot allies' cooldowns exactly. */
  hookReadyIn(u: Unit, viewer: Unit): number {
    if (u.team === viewer.team && u.isBot) return u.activeHook >= 0 ? Math.max(u.cdHook, 0.3) : u.cdHook;
    const tr = this.tracks.get(u.id);
    if (!tr) return 0;
    if (this.sim.hooks.some((hk) => hk.owner === u.id && hk.kind === HookKind.Hook && !hk.dead)) return Math.max(0.3, tr.hookReadyAt - this.sim.time);
    return Math.max(0, tr.hookReadyAt - this.sim.time);
  }

  hookSpeedOf(u: Unit): number {
    return this.tracks.get(u.id)?.hookSpeed ?? HOOK_LEVELS.speed[0];
  }

  /**
   * Position and velocity of `u` as `viewer` saw it `delay` ticks ago. Velocity is a finite difference
   * of observed positions. Returns false if the viewer could not see it then.
   */
  perceive(u: Unit, viewer: Team, delay: number, out: Seen): boolean {
    const tr = this.tracks.get(u.id);
    const bit = 1 << viewer;
    if (!tr || tr.n < 2) {
      out.x = u.x;
      out.z = u.z;
      out.vx = 0;
      out.vz = 0;
      return u.team === viewer || this.sim.visibleTo(u, viewer);
    }
    const d = Math.min(delay, tr.n - 1, HIST - 6);
    const i = (this.head - d + HIST) % HIST;
    if (!(tr.vis[i] & bit)) {
      // just revealed: take the freshest sample we are allowed to see
      if (!(tr.vis[this.head] & bit)) return false;
      out.x = tr.x[this.head];
      out.z = tr.z[this.head];
      out.vx = 0;
      out.vz = 0;
      return true;
    }
    out.x = tr.x[i];
    out.z = tr.z[i];
    const k = Math.min(4, tr.n - 1 - d);
    out.vx = 0;
    out.vz = 0;
    if (k >= 1 && this.sim.time - tr.respawnAt > (d + k + 1) * TICK_DT) {
      const j = (i - k + HIST) % HIST;
      if (tr.vis[j] & bit) {
        let vx = (tr.x[i] - tr.x[j]) / (k * TICK_DT);
        let vz = (tr.z[i] - tr.z[j]) / (k * TICK_DT);
        const s = Math.sqrt(vx * vx + vz * vz);
        if (s > 40) {
          vx *= 40 / s;
          vz *= 40 / s;
        }
        out.vx = vx;
        out.vz = vz;
      }
    }
    return true;
  }

  // ---- team claims (two bots never race for the same save or rune) ----

  claim(team: Team, target: number, by: number, until: number): void {
    this.claims[team].set(target, { by, until });
  }

  claimedByOther(team: Team, target: number, by: number): boolean {
    const c = this.claims[team].get(target);
    return !!c && c.by !== by && c.until >= this.sim.time;
  }

  // ---- river forecast from the public tide schedule ----

  private forecast(elapsed: number): void {
    const sim = this.sim;
    const deep = sim.river.deep;
    const playing = sim.phase === 'playing';
    if (this.tick - this.forecastTick < 6 && deep === this.lastDeep) {
      if (playing && elapsed > 0) {
        this.untilDeep = Math.max(0, this.untilDeep - elapsed);
        this.untilWalk = Math.max(0, this.untilWalk - elapsed);
        if (!deep) this.walkFor = Math.max(0, this.walkFor - elapsed);
      }
      return;
    }
    this.forecastTick = this.tick;
    this.lastDeep = deep;
    const cfg = sim.config;
    if (cfg.riverMode === 'dry') {
      this.untilDeep = Infinity;
      this.untilWalk = 0;
      this.walkFor = Infinity;
      return;
    }
    if (!tidalActive(sim.map, cfg)) {
      this.untilDeep = 0;
      this.untilWalk = Infinity;
      this.walkFor = 0;
      return;
    }
    const pre = sim.phase === 'countdown' ? sim.countdown : 0;
    const now = sim.matchTime;
    const flip = this.findFlip(now, deep);
    if (deep) {
      this.untilDeep = 0;
      this.untilWalk = flip + pre;
      this.walkFor = this.findFlip(now + flip + 0.02, false);
    } else {
      this.untilWalk = 0;
      this.untilDeep = flip + pre;
      this.walkFor = this.untilDeep;
    }
  }

  /** Seconds from match time t0 until river.deep stops being `state` (bisected to ~0.03 s). */
  private findFlip(t0: number, state: boolean): number {
    const sim = this.sim;
    const s = this.scratch;
    let lo = 0;
    let hi = -1;
    for (let k = 0.5; k <= 120; k += 0.5) {
      riverStateAt(sim.map, sim.config, t0 + k, s);
      if (s.deep !== state) {
        hi = k;
        break;
      }
      lo = k;
    }
    if (hi < 0) return Infinity;
    for (let i = 0; i < 4; i++) {
      const mid = (lo + hi) / 2;
      riverStateAt(sim.map, sim.config, t0 + mid, s);
      if (s.deep !== state) hi = mid;
      else lo = mid;
    }
    return lo;
  }
}

const contexts = new WeakMap<GameSim, BotContext>();

export function contextFor(sim: GameSim): BotContext {
  let c = contexts.get(sim);
  if (!c) {
    c = new BotContext(sim);
    contexts.set(sim, c);
  }
  return c;
}
