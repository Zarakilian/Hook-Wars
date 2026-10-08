// Path following for one bot: turns "go to the planned goal" into "head for this point now".
// If the straight line to the goal is walkable on the current variant, the bot steers straight at it
// (the common case on open banks). Otherwise it plans an A* path (capped per tick for the whole
// match) and walks its string-pulled waypoints. Paths are re-planned when the goal moves, the river
// state flips the variant, the bot is knocked off course or the path goes stale.
import { BAL, TICK_DT } from '../../constants.ts';
import type { Unit } from '../entities.ts';
import type { GameSim } from '../sim.ts';
import type { BotContext } from './context.ts';
import type { P2 } from './geom.ts';
import { findPath, lineWalk, NAV_LAND, NAV_MAXWP, NAV_WADE, newNavPath, type NavVariant } from './nav.ts';
import { Mode, type Brain } from './types.ts';

const scratch = newNavPath();
const keep = { x: 0, z: 0, r: 0 };

/** Fresh per-brain path buffer. */
export function newWaypoints(): Float32Array {
  return new Float32Array(NAV_MAXWP * 2);
}

/** Forget the current path (after being moved by something other than our own feet). */
export function navReset(b: Brain): void {
  b.navN = 0;
  b.navI = 0;
  b.navCheck = 0;
  b.navDirect = false;
  b.navFail = 0;
}

/**
 * Which walkability applies to this bot right now. Water is walkable only when the river is not
 * deep and will not turn deep before we could wade through, and never while we hold the bank
 * (steering keeps holders out of the water, so their paths must too).
 */
export function navVariant(sim: GameSim, ctx: BotContext, u: Unit, b: Brain): NavVariant {
  if (sim.river.deep) return NAV_LAND;
  if (sim.world.channel(u.x, u.z) > -0.05) return NAV_WADE; // already wading: walk out on wet cells
  const m = b.mode;
  if ((m === Mode.Hold || m === Mode.Stranded || m === Mode.Trap) && !b.crossing) return NAV_LAND;
  if (ctx.untilDeep < b.tune.tideMargin + 6) return NAV_LAND;
  return NAV_WADE;
}

function waterCost(sim: GameSim): number {
  const r = sim.river;
  if (r.frozen) return 1.15;
  if (r.shallow) return 1 / BAL.shallowSlow + 0.15;
  return 1 / BAL.mudSlow + 0.15;
}

/**
 * Where to head this tick on the way to (gx, gz). Writes out; equals the goal when the way is
 * straight (or no path could be found, in which case the old steering filters cope as before).
 */
export function navTarget(sim: GameSim, ctx: BotContext, u: Unit, b: Brain, gx: number, gz: number, out: P2): void {
  const t = sim.time;
  const ns = ctx.nav;
  const v = navVariant(sim, ctx, u, b);
  const mdx = gx - b.navGX;
  const mdz = gz - b.navGZ;
  let moved = mdx * mdx + mdz * mdz > 2.25;
  if (moved && !b.navDirect && b.navN > 0 && b.navDone && v === b.navVar) {
    // a holder's goal shuffles along the bank every plan: if the new goal is a straight walk from
    // the path's last waypoint, keep the path and just move its end (no new search)
    const k = b.navN - 1;
    const lx = k > 0 ? b.navWp[k * 2 - 2] : u.x;
    const lz = k > 0 ? b.navWp[k * 2 - 1] : u.z;
    if (b.navI <= k && lineWalk(ns, v, lx, lz, gx, gz)) {
      b.navWp[k * 2] = gx;
      b.navWp[k * 2 + 1] = gz;
      b.navGX = gx;
      b.navGZ = gz;
      moved = false;
    }
  }
  if (v !== b.navVar || moved) b.navCheck = Math.min(b.navCheck, t);
  if (t >= b.navCheck) {
    b.navCheck = t + 0.3 + ((u.id * 7) % 5) * TICK_DT; // stagger the line tests between bots
    if (lineWalk(ns, v, u.x, u.z, gx, gz)) {
      b.navDirect = true;
      b.navN = 0;
      b.navVar = v;
      b.navGX = gx;
      b.navGZ = gz;
    } else {
      b.navDirect = false;
      const stale = b.navN === 0 || v !== b.navVar || moved || t - b.navAt > 4 || (b.navI >= b.navN && !b.navDone);
      if (stale && t >= b.navFail) {
        if (ctx.navBudget > 0) {
          ctx.navBudget--;
          b.navAt = t;
          b.navVar = v;
          b.navGX = gx;
          b.navGZ = gz;
          b.navI = 0;
          b.stats.paths++;
          const ef = sim.map.fountains[u.team === 0 ? 1 : 0];
          keep.x = ef.x;
          keep.z = ef.z;
          keep.r = ef.r + 1.2;
          if (findPath(ns, v, u.x, u.z, gx, gz, waterCost(sim), ctx.navAvoid, scratch, b.pushKill ? null : keep) && scratch.n > 0) {
            b.navWp.set(scratch.wp.subarray(0, scratch.n * 2));
            b.navN = scratch.n;
            b.navDone = scratch.complete;
          } else {
            b.navN = 0;
            b.navFail = t + 1.5; // unreachable from here: do not flood the grid every tick
          }
        } else b.navCheck = t; // out of searches this tick: ask again next tick
      }
    }
  }
  if (b.navDirect || b.navN === 0) {
    out.x = gx;
    out.z = gz;
    return;
  }
  const wp = b.navWp;
  while (b.navI < b.navN) {
    const dx = wp[b.navI * 2] - u.x;
    const dz = wp[b.navI * 2 + 1] - u.z;
    if (dx * dx + dz * dz > 0.36) break;
    b.navI++;
  }
  // cut corners when the next waypoint is already in a straight line (a few bots per tick)
  if (b.navI + 1 < b.navN && (sim.tick + u.id) % 4 === 0 && lineWalk(ns, b.navVar as NavVariant, u.x, u.z, wp[b.navI * 2 + 2], wp[b.navI * 2 + 3])) b.navI++;
  if (b.navI >= b.navN) {
    out.x = gx;
    out.z = gz;
    if (!b.navDone) b.navCheck = t; // a partial path ran out: plan the rest
    return;
  }
  out.x = wp[b.navI * 2];
  out.z = wp[b.navI * 2 + 1];
}

export { NAV_LAND, NAV_WADE };
