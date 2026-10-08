// Bruiser dives (deep river only). Two plays, both readable from across the map:
//  - Shove: grapple onto a rock or tree beside an enemy loitering at their bank edge, land on the
//    landward side of them and belly-bash them into their own river.
//  - Snatch: grapple straight onto an enemy who backed off to wait out their hook cooldown. We land
//    between them and the river, hook them point blank and the usual combo shoves them in behind us.
// Either way the bruiser is then stranded on the far bank until a teammate hooks it home or the
// grapple is back for the trip home. It is a gamble, so it is rationed per difficulty.
import { BAL, UNIT_RADIUS } from '../../constants.ts';
import { dist, dist2 } from '../../math.ts';
import { Btn, UnitState, type PlayerInput } from '../../types.ts';
import type { Unit } from '../entities.ts';
import type { GameSim } from '../sim.ts';
import { HookPath, scanPath, traceHook, type ScanResult } from './aim.ts';
import { bodyCount, bodyList, gatherBodies } from './combat.ts';
import type { BotContext, Seen } from './context.ts';
import { bankOf, bestBash, bestBashFrom, moversClear, type BashAim } from './geom.ts';
import type { Brain } from './types.ts';

/** Intent purposes used by dives (see Intent.purpose). */
export const DIVE_SHOVE = 1;
export const DIVE_SNATCH = 3;

const path = new HookPath();
const scan: ScanResult = { first: -1, firstT: 0, miss: 0, side: 0, missT: 0 };
const seen: Seen = { x: 0, z: 0, vx: 0, vz: 0 };
const bash: BashAim = { ax: 0, az: 0, score: 0, lx: 0, lz: 0 };

let bodiesFor = -1;

function ensureBodies(sim: GameSim, ctx: BotContext, u: Unit, b: Brain): void {
  if (bodiesFor === sim.tick * 4096 + u.id) return;
  gatherBodies(sim, ctx, u, b);
  bodiesFor = sim.tick * 4096 + u.id;
}

/** True if a grapple from u along (dx, dz) reaches the body with this unit id before anything else. */
function grappleReaches(sim: GameSim, ctx: BotContext, u: Unit, b: Brain, dx: number, dz: number, id: number): boolean {
  traceHook(sim.world, sim.map.whirlpool, u.x + dx * BAL.hookHand, u.z + dz * BAL.hookHand, dx, dz,
    BAL.grappleSpeed, BAL.grappleRadius, BAL.grappleRange, 0, BAL.grappleWindup, path, true);
  ensureBodies(sim, ctx, u, b);
  const bl = bodyList();
  let fi = -1;
  for (let i = 0; i < bodyCount(); i++) if (bl[i].id === id && bl[i].kind === 0) fi = i;
  scanPath(path, BAL.grappleRadius, bl, bodyCount(), fi, scan);
  return fi >= 0 && scan.first === fi;
}

export function thinkDive(sim: GameSim, ctx: BotContext, u: Unit, b: Brain): void {
  const t = sim.time;
  bodiesFor = -1; // the body cache only lives inside one call (several sims can share this module)
  if (b.tune.dives <= 0 || b.roleDef.aggression < 0.6 || t < b.nextDiveCheck || b.intent) return;
  if (!sim.river.deep || sim.phase !== 'playing' || u.state !== UnitState.Alive) return;
  b.nextDiveCheck = t + 0.6 + b.rng.next() * 0.5;
  if (u.cdGrapple > 0 || u.activeGrapple >= 0 || u.activeHook >= 0 || u.cdBash > 0.2 || u.hp < u.maxHp * 0.55) return;
  if (bankOf(sim, u.x, u.z) !== u.team || sim.world.channel(u.x, u.z) > -0.3) return;
  const enemyTeam = u.team === 0 ? 1 : 0;
  const ef = sim.map.fountains[enemyTeam];
  const info = ctx.info;
  const anchors = info.anchors[enemyTeam];
  const foes = ctx.foes[u.team];
  const hookReady = u.cdHook <= 0.2;
  let bestScore = 0;
  let bestPurpose = 0;
  let bestE = -1;
  let bestX = 0;
  let bestZ = 0;
  for (const e of foes) {
    if (e.state !== UnitState.Alive && e.state !== UnitState.Casting) continue;
    if (e.spawnProt > 0 || !ctx.perceive(e, u.team, b.tune.perceiveTicks, seen)) continue;
    const ex = seen.x;
    const ez = seen.z;
    if (bankOf(sim, ex, ez) !== enemyTeam) continue;
    if (dist2(ex, ez, ef.x, ef.z) < (ef.r + 4.5) ** 2) continue;
    const ed = dist(u.x, u.z, ex, ez);
    if (ed > BAL.grappleRange + 4) continue;
    let crowd = 0;
    for (const o of foes) if (o !== e && dist2(o.x, o.z, ex, ez) < 36) crowd++;
    if (crowd > (b.diff === 'brutal' ? 2 : 1)) continue;
    // only worth it if they cannot grapple straight back out of the water (or are nearly dead)
    if (ctx.grappleReadyIn(e, u) < 2 && e.hp > e.maxHp * 0.4) continue;
    const edge = -sim.world.channel(ex, ez);
    const value = 1 - e.hp / e.maxHp - crowd * 0.8;

    // Snatch: they backed off from the edge; land riverward of them and hook them in.
    if (hookReady && edge > 3.4 && edge < 9 && ed > 4 && ed < BAL.grappleRange + BAL.hookHand + BAL.grappleRadius + UNIT_RADIUS - 0.25) {
      const dx = (ex - u.x) / ed;
      const dz = (ez - u.z) / ed;
      const lx = ex - dx * (UNIT_RADIUS * 2 + 0.1);
      const lz = ez - dz * (UNIT_RADIUS * 2 + 0.1);
      // we need room behind us for the catch to land on dry ground before the shove
      const loaded = ctx.hookReadyIn(e, u) < 1.2; // never fly at a loaded hook
      if (sim.world.channel(lx, lz) < -1.9 && !loaded && moversClear(sim, u.x, u.z, ex, ez, 1.4) && grappleReaches(sim, ctx, u, b, dx, dz, e.id)) {
        const score = 3 + value;
        if (score > bestScore) {
          bestScore = score;
          bestPurpose = DIVE_SNATCH;
          bestE = e.id;
          bestX = ex;
          bestZ = ez;
        }
      }
    }

    // Shove: they stand at the edge; land on a rock beside them and bash them in.
    if (edge < 0 || edge > 3.4) continue;
    for (let k = 0; k < anchors.length; k++) {
      const oi = anchors[k];
      const ox = info.ox_[oi];
      const oz = info.oz_[oi];
      if (dist2(ox, oz, ex, ez) > 30) continue;
      const od = dist(u.x, u.z, ox, oz);
      const o = sim.map.obstacles[oi];
      const orad = o.shape === 'circle' ? o.r : 0.4;
      if (od - orad > BAL.grappleRange + BAL.hookHand - 0.4 || od < 3) continue;
      const dx = (ox - u.x) / od;
      const dz = (oz - u.z) / od;
      traceHook(sim.world, sim.map.whirlpool, u.x + dx * BAL.hookHand, u.z + dz * BAL.hookHand, dx, dz,
        BAL.grappleSpeed, BAL.grappleRadius, BAL.grappleRange, 0, BAL.grappleWindup, path, true);
      if (!path.blocked) continue;
      // whatever we latch onto first is where we land: it must be dry ground next to the target
      const hx = path.x[path.n - 1];
      const hz = path.z[path.n - 1];
      const lx = hx - dx * (UNIT_RADIUS + 0.2);
      const lz = hz - dz * (UNIT_RADIUS + 0.2);
      if (sim.world.channel(lx, lz) > -0.4 || !moversClear(sim, u.x, u.z, hx, hz, 1.4)) continue;
      const bd = dist(lx, lz, ex, ez);
      if (bd < 1 || bd > BAL.bashRange + UNIT_RADIUS - 0.35) continue;
      bestBashFrom(sim, u.team, lx, lz, Math.atan2(dx, dz), ex, ez, bash);
      if (bash.score < 3) continue; // must shove them at least ~1.5 m out into the river
      ensureBodies(sim, ctx, u, b);
      scanPath(path, BAL.grappleRadius, bodyList(), bodyCount(), -1, scan);
      if (scan.first >= 0) continue; // somebody would catch the grapple first
      const score = bash.score - bd * 0.2 + value;
      if (score > bestScore) {
        bestScore = score;
        bestPurpose = DIVE_SHOVE;
        bestE = e.id;
        bestX = ox;
        bestZ = oz;
      }
    }
  }
  if (bestE < 0 || b.rng.next() >= b.tune.dives) return;
  b.nextDiveCheck = t + 14 + b.rng.next() * 8;
  b.diveTarget = bestE;
  b.divePurpose = bestPurpose;
  b.diveUntil = t + 2.5;
  b.intent = { kind: 'grapple', tk: 3, id: bestE, x: bestX, z: bestZ, at: t + b.tune.decide * 0.6, value: bestScore, bend: 0, purpose: bestPurpose };
}

/** Just landed from a shove dive: bash the target into the river before they react. */
export function diveFollowUp(sim: GameSim, ctx: BotContext, u: Unit, b: Brain, input: PlayerInput): void {
  if (b.diveTarget < 0) return;
  if (sim.time > b.diveUntil) {
    b.diveTarget = -1;
    return;
  }
  if (b.divePurpose !== DIVE_SHOVE) return; // snatches are finished by the hook logic
  if (u.state !== UnitState.Alive || u.cdBash > 0 || u.activeGrapple >= 0) return;
  const e = sim.unitById.get(b.diveTarget);
  if (!e || e.state === UnitState.Dead || e.state === UnitState.Hooked || e.state === UnitState.Grappling) return;
  if (!ctx.perceive(e, u.team, 1, seen)) return;
  if (dist(u.x, u.z, seen.x, seen.z) > BAL.bashRange + UNIT_RADIUS - 0.25) return;
  bestBash(sim, u, seen.x, seen.z, bash);
  input.b |= Btn.Bash;
  input.ax = bash.ax;
  input.az = bash.az;
  b.aim = { kind: 'bash', tk: 0, id: e.id, x: bash.ax, z: bash.az, err: 0, bend: 0, lead: 0 };
  b.diveTarget = -1;
}

/** Last look before pressing the dive grapple: is the way still clear of drifting movers? */
export function diveStillSafe(sim: GameSim, u: Unit, x: number, z: number): boolean {
  return moversClear(sim, u.x, u.z, x, z, 1.1);
}
