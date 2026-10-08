// Dodging: read enemy hooks in flight (every hook is public) and enemy wind-ups (their facing is
// public), then sidestep. Each threat is judged once, so a slow bot that misses its chance does not
// get a second roll: that is what makes easy bots catchable and brutal bots slippery.
import { UNIT_RADIUS } from '../../constants.ts';
import { dist2 } from '../../math.ts';
import { HookKind, HookPhase, UnitState } from '../../types.ts';
import type { Unit } from '../entities.ts';
import type { GameSim } from '../sim.ts';
import type { BotContext } from './context.ts';
import { standable } from './mapinfo.ts';
import type { Brain } from './types.ts';

export const JUDGED = 16;

function judged(b: Brain, key: number): boolean {
  const j = b.judged;
  for (let i = 0; i < JUDGED; i++) if (j[i] === key) return true;
  return false;
}

function markJudged(b: Brain, key: number): void {
  b.judged[b.judgedHead] = key;
  b.judgedHead = (b.judgedHead + 1) % JUDGED;
}

/** Is stepping 1.4 m along (dx, dz) safe: standable, dry (when the river is deep), clear of hazards? */
export function stepSafe(sim: GameSim, ctx: BotContext, u: Unit, dx: number, dz: number): boolean {
  const x = u.x + dx * 1.4;
  const z = u.z + dz * 1.4;
  if (!standable(ctx.info, x, z)) return false;
  const ch = sim.world.channel(x, z);
  if (ch > -0.15 && sim.world.channel(u.x, u.z) <= 0 && (sim.river.deep || ctx.untilDeep < 3)) return false;
  for (const hz of sim.hazards) {
    if (sim.hazardActive(hz) && dist2(x, z, hz.x, hz.z) < (hz.r + 0.5) ** 2) return false;
  }
  return true;
}

/** Called every tick while the bot can move. Starts a sidestep when a hook is about to hit us. */
export function checkDodge(sim: GameSim, ctx: BotContext, u: Unit, b: Brain): void {
  const t = sim.time;
  if (u.state !== UnitState.Alive || t < b.dodgeUntil) return;
  const tune = b.tune;
  for (const h of sim.hooks) {
    if (h.dead || h.kind !== HookKind.Hook || h.phase !== HookPhase.Out) continue;
    const o = sim.unitById.get(h.owner);
    if (!o || o.team === u.team) continue;
    if (ctx.hookAge(h.id) < tune.dodgeReact) continue; // not noticed yet
    if (judged(b, h.id)) continue;
    const rx = u.x - h.x;
    const rz = u.z - h.z;
    const along = rx * h.dx + rz * h.dz;
    if (along < -0.3) continue;
    // how far it can still fly: the longest throw we have seen from them, minus what it has flown
    const left = ctx.reachOf(o) - ctx.hookTravel(h.id, h.x, h.z);
    if (along > left + 1.4) continue;
    const tti = Math.max(0, along) / h.speed;
    if (tti > 1) continue;
    const perp = rx * h.dz - rz * h.dx;
    const vperp = u.vx * h.dz - u.vz * h.dx;
    const fut = perp + vperp * tti;
    const hitR = h.r + UNIT_RADIUS + 0.2;
    if (Math.abs(fut) > hitR && Math.abs(perp) > hitR) continue;
    markJudged(b, h.id);
    if (b.rng.next() >= tune.dodge) continue; // froze
    let s = Math.abs(fut) > 0.15 ? Math.sign(fut) : b.rng.next() < 0.5 ? 1 : -1;
    if (!stepSafe(sim, ctx, u, h.dz * s, -h.dx * s) && stepSafe(sim, ctx, u, -h.dz * s, h.dx * s)) s = -s;
    b.dodgeX = h.dz * s;
    b.dodgeZ = -h.dx * s;
    b.dodgeUntil = t + Math.max(0.2, Math.min(0.6, tti + 0.12));
    b.stats.dodges++;
    return;
  }
  if (!tune.predodge) return;
  // Read wind-ups: an enemy winding up a hook at us is about to throw at us. Hooks wind up on the
  // move, so read where they aimed (the cast is public: wind-up animation and cast event), not the
  // way they are walking.
  for (const e of ctx.foes[u.team]) {
    if (e.castKind !== 'hook' || (e.state !== UnitState.Alive && e.state !== UnitState.Casting)) continue;
    const tr = ctx.tracks.get(e.id);
    if (!tr) continue;
    const key = -(e.id * 100000 + (tr.castAt % 100000)) - 1;
    if (judged(b, key)) continue;
    let fx = e.castAx - e.x;
    let fz = e.castAz - e.z;
    const fl = Math.sqrt(fx * fx + fz * fz);
    if (fl < 0.3) {
      fx = Math.sin(e.face);
      fz = Math.cos(e.face);
    } else {
      fx /= fl;
      fz /= fl;
    }
    const rx = u.x - e.x;
    const rz = u.z - e.z;
    const along = rx * fx + rz * fz;
    if (along <= 0 || along > ctx.reachOf(e) + 2) continue;
    const perp = rx * fz - rz * fx;
    if (Math.abs(perp) > 1.6) continue;
    markJudged(b, key);
    if (b.rng.next() >= tune.dodge * 0.55) continue;
    let s = Math.abs(perp) > 0.2 ? Math.sign(perp) : b.rng.next() < 0.5 ? 1 : -1;
    if (!stepSafe(sim, ctx, u, fz * s, -fx * s) && stepSafe(sim, ctx, u, -fz * s, fx * s)) s = -s;
    b.dodgeX = fz * s;
    b.dodgeZ = -fx * s;
    b.dodgeUntil = t + 0.28;
    return;
  }
}
