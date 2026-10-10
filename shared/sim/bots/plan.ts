// Positioning: where to stand, re-planned a few times per second.
// Holding the bank is a dance: step up to the edge when the hook is (nearly) ready, fall back out of
// reach or behind cover while it cools down, keep spacing from teammates, never stand in hazards or
// near the enemy fountain. Walkable beds open up pushes for bruisers; tides chase everyone out.
import { BAL, HOOK_LEVELS } from '../../constants.ts';
import { platformAt } from '../../maps/helpers.ts';
import { dist, dist2 } from '../../math.ts';
import { UnitState, type RuneType, type Team } from '../../types.ts';
import type { Unit } from '../entities.ts';
import type { GameSim } from '../sim.ts';
import type { BotContext } from './context.ts';
import { bankOf, bankPoint, sideOf, type P2 } from './geom.ts';
import { hookLineClear, standable } from './mapinfo.ts';
import { compAt, edgeDist, holdSpot, inComp, nearestDry, NAV_LAND } from './nav.ts';
import { bankBefore } from './roles.ts';
import { Mode, type Brain } from './types.ts';

const MAXF = 8;
const fx = new Float64Array(MAXF);
const fz = new Float64Array(MAXF);
const freach = new Float64Array(MAXF);
const fready = new Float64Array(MAXF);
const fval = new Float64Array(MAXF);
/** 1 if that foe carries a Bendy Eel (public glow): its hook curves round cover. */
const fbend = new Uint8Array(MAXF);
let nf = 0;
const cand: P2 = { x: 0, z: 0 };
const esc: P2 = { x: 0, z: 0 };
const ZOFF = [0, -3, 3, -6, 6];

/**
 * Lane (z) for a unit: teammates spread evenly along the bank in the order their spawn points stand
 * (bankOrder), team 1's lanes mirroring team 0's like the maps. By id order, team 1 (whose spawn list is
 * team 0's point mirror) crossed its whole fountain to the opposite lanes and piled up on the way out.
 */
export function laneOf(ctx: BotContext, u: Unit, halfD: number): number {
  const m = ctx.members[u.team];
  const n = Math.max(1, m.length);
  if (n === 1) return 0;
  let rank = 0;
  for (const o of m) if (o !== u && bankBefore(ctx.sim, o, u)) rank++;
  const L = Math.min(15, halfD - 6);
  return (u.team === 0 ? 1 : -1) * (-L + (rank + 0.5) * ((2 * L) / n));
}

function inHazard(sim: GameSim, x: number, z: number, pad: number): boolean {
  for (const hz of sim.hazards) {
    if (!sim.hazardActive(hz)) continue;
    if (dist2(x, z, hz.x, hz.z) < (hz.r + pad) ** 2) return true;
  }
  return false;
}

function nearEnemyFountain(sim: GameSim, team: Team, x: number, z: number, pad: number): boolean {
  const f = sim.map.fountains[team === 0 ? 1 : 0];
  return dist2(x, z, f.x, f.z) < (f.r + pad) ** 2;
}

/** Seconds to walk from here to `team`'s bank (crossing the bed if needed). */
function timeToBank(sim: GameSim, u: Unit, team: Team): number {
  const c = sim.world.riverCenter(u.z);
  const edgeX = c.x + sideOf(team) * c.hw;
  const dx = (edgeX - u.x) * sideOf(team);
  if (dx <= 0) return 0;
  const mul = sim.river.shallow ? BAL.shallowSlow : sim.river.frozen ? 0.8 : BAL.mudSlow;
  return (dx + 0.6) / (BAL.moveSpeed * mul);
}

function gatherFoes(sim: GameSim, ctx: BotContext, u: Unit): void {
  nf = 0;
  for (const e of ctx.foes[u.team]) {
    if (nf >= MAXF) break;
    if (e.state === UnitState.Hooked) continue;
    fx[nf] = e.x;
    fz[nf] = e.z;
    freach[nf] = ctx.reachOf(e) + 1.3;
    fready[nf] = ctx.hookReadyIn(e, u);
    fval[nf] = 1 + (1 - e.hp / e.maxHp) * 1.2 + (fready[nf] > 1.5 ? 0.5 : 0);
    fbend[nf] = e.bendy > 0 ? 1 : 0;
    nf++;
  }
}

/** Count enemy hooks that are (about to be) ready and have a line to (x, z). */
export function exposureAt(ctx: BotContext, x: number, z: number, within: number): number {
  let n = 0;
  for (let i = 0; i < nf; i++) {
    if (fready[i] > within) continue;
    const d = dist(x, z, fx[i], fz[i]);
    if (d > freach[i]) continue;
    if (fbend[i] === 1 || hookLineClear(ctx.info, fx[i], fz[i], x, z, 0.9, 0.6)) n++;
  }
  return n;
}

function scoreSpot(sim: GameSim, ctx: BotContext, u: Unit, b: Brain, x: number, z: number, hookSoon: boolean, myReach: number): number {
  let s = -dist(u.x, u.z, x, z) * 0.05 - Math.abs(z - b.laneZ) * 0.03;
  for (const a of ctx.alive[u.team]) {
    if (a === u) continue;
    const ab = a.isBot && a.brain ? (a.brain as Brain) : null;
    const ax = ab ? ab.goalX : a.x;
    const az = ab ? ab.goalZ : a.z;
    const d = dist(x, z, ax, az);
    if (d < 4.5) s -= (4.5 - d) * 0.3;
  }
  const eta = dist(u.x, u.z, x, z) / BAL.moveSpeed;
  for (let i = 0; i < nf; i++) {
    const d = dist(x, z, fx[i], fz[i]);
    if (d < freach[i] && (fbend[i] === 1 || hookLineClear(ctx.info, fx[i], fz[i], x, z, 0.9, 0.6))) {
      const w = fready[i] <= eta + 0.5 ? 1 : 0.3;
      s -= w * (hookSoon ? 0.4 : 1.25) * (1.3 - d / freach[i]);
    }
    if (hookSoon && d < myReach + 1.2 && hookLineClear(ctx.info, x, z, fx[i], fz[i], 0.9, 0.6)) {
      const k = 1.25 - d / (myReach + 1.2);
      s += 1.1 * fval[i] * (k < 0.3 ? 0.3 : k > 1 ? 1 : k);
    }
  }
  if (hookSoon && b.roleDef.runeBias > 0) {
    for (const r of sim.runes) {
      if (r.dragged) continue;
      if (dist2(x, z, r.x, r.z) < myReach * myReach && hookLineClear(ctx.info, x, z, r.x, r.z, 0.9, 0.6)) s += 0.25 * b.roleDef.runeBias * runeWorth(u, r.type);
    }
  }
  return s;
}

function setGoal(b: Brain, mode: (typeof Mode)[keyof typeof Mode], x: number, z: number): void {
  b.mode = mode;
  b.goalX = x;
  b.goalZ = z;
}

/** Choose where to go. Writes b.mode, b.goalX/Z, b.exposed. */
export function plan(sim: GameSim, ctx: BotContext, u: Unit, b: Brain): void {
  const role = b.roleDef;
  const tune = b.tune;
  const team = u.team;
  const halfD = sim.map.d / 2;
  const ch = sim.world.channel(u.x, u.z);
  const myBank = bankOf(sim, u.x, u.z);
  const deep = sim.river.deep;
  const myReach = HOOK_LEVELS.range[u.up.range] * (u.longshot > 1 ? BAL.longshotRangeMul : 1);
  const ns = ctx.nav;
  /** The walk component we stand in (dry ground only): every spot we pick must be in it. */
  const myComp = compAt(ns, NAV_LAND, u.x, u.z, 4);
  b.laneZ = laneOf(ctx, u, halfD);
  b.pushKill = false;
  gatherFoes(sim, ctx, u);
  b.exposed = exposureAt(ctx, u.x, u.z, 0.4);

  const hpFrac = u.hp / u.maxHp;
  if (hpFrac < role.retreatHp && u.pieT <= 0) b.retreating = true;
  if (hpFrac > 0.88 || (b.retreating && u.pieT > 0 && hpFrac > 0.6)) b.retreating = false;

  // 1. The water is coming back: get out of whatever channel we stand in while there is time.
  //    (Nobody needs 14 s to wade out, so the search only runs once the turn is near.)
  if (ch > -0.4 && !deep && ctx.untilDeep < 14 + tune.tideMargin) {
    const mul = sim.river.shallow ? BAL.shallowSlow : sim.river.frozen ? 0.8 : BAL.mudSlow;
    const speed = BAL.moveSpeed * mul;
    // walking distance to dry ground, preferring our own side of the main river
    const dOwn = nearestDry(ns, u.x, u.z, team, 40, 45, esc);
    const ownT = Number.isFinite(dOwn) ? (dOwn + 0.6) / speed : timeToBank(sim, u, team);
    const margin = tune.tideMargin + 1.2;
    if (ctx.untilDeep < ownT + margin || (b.crossing && ctx.untilDeep < ownT + margin + 3)) {
      // home if we can make it, otherwise the nearest dry ground (the far bank beats drowning)
      const home = ctx.untilDeep > ownT + 0.6;
      if (!home || !Number.isFinite(dOwn)) {
        const dAny = nearestDry(ns, u.x, u.z, team, 0, 45, esc);
        if (!Number.isFinite(dAny)) bankPoint(sim, home ? team : myBank, u.z, 1.8, esc);
      }
      if (home) b.crossing = false;
      // step a little past the first dry cell, inland, so we are clear of the water when it comes
      let ix = esc.x - u.x;
      let iz = esc.z - u.z;
      const il = Math.sqrt(ix * ix + iz * iz);
      if (il > 0.1) {
        ix /= il;
        iz /= il;
        const fx = esc.x + ix * 1.3;
        const fz = esc.z + iz * 1.3;
        if (sim.world.channel(fx, fz) < -0.6 && standable(ctx.info, fx, fz)) {
          esc.x = fx;
          esc.z = fz;
        }
      }
      setGoal(b, Mode.Leave, esc.x, esc.z);
      return;
    }
  }

  // 2. Stranded on the far bank of a deep river (after a dive, or delivered alive): stay near the
  //    water where our lifeguards can hook us home, fight if they come close, keep off their fountain.
  //    (A bridge or a chain of docks home means we are not stranded: just walk back.)
  //    Knocked onto an island, a floe or a cut-off pier on our own side is the same story.
  const homeComp = ns.homeComp[team];
  const walkHome = myComp >= 0 && myComp === homeComp;
  if (deep && ch <= 0 && !walkHome && (myBank !== team || (myComp >= 0 && homeComp >= 0))) {
    if (myBank !== team) {
      const z = Math.max(-halfD + 4, Math.min(halfD - 4, u.z * 0.6 + b.laneZ * 0.4));
      bankPoint(sim, myBank, z, 1.6, cand);
      setGoal(b, Mode.Stranded, cand.x, cand.z);
    } else setGoal(b, Mode.Stranded, u.x, u.z); // a little island: wait for a hook or the grapple
    return;
  }

  // 3. Hurt: go home to the fountain (or across the bed first).
  if (b.retreating) {
    const f = sim.map.fountains[team];
    const off = Math.min(2.5, f.r * 0.4);
    setGoal(b, Mode.Retreat, f.x, f.z + (b.laneZ > 0 ? off : -off));
    return;
  }

  const walkable = !deep;
  const window = ctx.untilDeep; // Infinity on a dry bed
  const crossT = 2 * sim.world.riverCenter(u.z).hw / (BAL.moveSpeed * (sim.river.shallow ? BAL.shallowSlow : BAL.mudSlow)) + 1;

  // 4. Walkable bed: bruisers push across while the window lasts.
  if (walkable && role.aggression >= 0.6 && hpFrac > 0.45) {
    const enough = window === Infinity || (myBank === team ? window > crossT * 2 + 7 : window > timeToBank(sim, u, team) + tune.tideMargin + 1.5);
    if (enough) {
      let best: Unit | null = null;
      let bestS = -1e9;
      for (const e of ctx.foes[team]) {
        if (e.state === UnitState.Dead || ctx.spawnProtLeft(e, u) > 0.5) continue;
        // out on the bed and up on a bridge, or up on a deck and on the bed under it: walking to them keeps
        // us on our layer, so no wallop or bash ever reaches them. One out on the open bed beside a deck
        // (outside any footprint) is reachable: we step off the deck's side onto their layer.
        if (!sim.sameLayer(u, e) && platformAt(sim.map, e.x, e.z)) continue;
        const low = e.hp < e.maxHp * 0.25 && hpFrac > 0.6;
        if (nearEnemyFountain(sim, team, e.x, e.z, 2.5) && !low) continue;
        const s = -dist(u.x, u.z, e.x, e.z) * 0.12 + (1 - e.hp / e.maxHp) * 2 + (low ? 1.5 : 0);
        if (s > bestS) {
          bestS = s;
          best = e;
        }
      }
      if (best) {
        b.pushTarget = best.id;
        b.pushKill = best.hp < best.maxHp * 0.25 && hpFrac > 0.6;
        b.crossing = true;
        setGoal(b, Mode.Push, best.x, best.z);
        return;
      }
      b.crossing = true;
      const z = Math.max(-halfD + 4, Math.min(halfD - 4, b.laneZ));
      bankPoint(sim, team === 0 ? 1 : 0, z, 2.5, cand);
      if (!nearEnemyFountain(sim, team, cand.x, cand.z, 3)) {
        setGoal(b, Mode.Push, cand.x, cand.z);
        return;
      }
    }
  }
  if (myBank === team || deep) b.crossing = false;

  // 5. Walk over runes that are close (nobody has to hook them): on a walkable bed, or on dry ground
  //    we can reach (a rune parked by a pier or an island bridge).
  const bedOpen = walkable && window > 6;
  if (bedOpen || deep) {
    for (const r of sim.runes) {
      if (r.dragged) continue;
      if (!bedOpen && (myComp < 0 || !inComp(ns, NAV_LAND, r.x, r.z, myComp))) continue;
      const d = dist(u.x, u.z, r.x, r.z);
      const want = Math.max(0.6, Math.min(1.3, runeWorth(u, r.type) / 1.1));
      if (d < 9 * (0.5 + role.runeBias * 0.5) * want && !ctx.claimedByOther(team, r.id, u.id)) {
        ctx.claim(team, r.id, u.id, sim.time + 1);
        setGoal(b, Mode.Rune, r.x, r.z);
        return;
      }
    }
  }

  // 6. Hold the bank: score candidate spots.
  const hookSoon = u.cdHook < 0.9 && u.activeHook < 0;
  let safe = 0;
  for (let i = 0; i < nf; i++) safe = Math.max(safe, freach[i]);
  const cw = sim.world.riverCenter(b.laneZ).hw * 2;
  const waitS = Math.max(role.standWait, Math.min(14, safe - cw - 1.5));
  const s0 = hookSoon ? role.standReady : waitS;
  const s1 = hookSoon ? role.standReady + 0.7 : waitS + 3.5;
  let bestScore = -1e9;
  let bx = b.goalX;
  let bz = b.goalZ;
  // keep the old goal unless something is clearly better (hysteresis stops dithering)
  if (b.mode === Mode.Hold && standable(ctx.info, b.goalX, b.goalZ) && bankOf(sim, b.goalX, b.goalZ) === team
    && sim.world.channel(b.goalX, b.goalZ) <= -0.4 && (myComp < 0 || inComp(ns, NAV_LAND, b.goalX, b.goalZ, myComp))) {
    const edge = edgeDist(ns, team, b.goalX, b.goalZ);
    if (edge > 0.5 && (hookSoon ? edge < s1 + 0.6 : edge > s0 - 0.6)) bestScore = scoreSpot(sim, ctx, u, b, b.goalX, b.goalZ, hookSoon, myReach) + 0.15;
  }
  const zmax = halfD - 4;
  // a loose rune within hook range of our bank is worth a candidate spot right across from it
  let runeZ = NaN;
  if (hookSoon && role.runeBias > 0) {
    let bestR = 0;
    for (const r of sim.runes) {
      if (r.dragged || Math.abs(r.z - b.laneZ) > 12) continue;
      const w = runeWorth(u, r.type) * role.runeBias - Math.abs(r.z - u.z) * 0.03;
      if (w > bestR && !ctx.claimedByOther(team, r.id, u.id)) {
        bestR = w;
        runeZ = r.z;
      }
    }
  }
  let found = false;
  const NZ = ZOFF.length + 2 + (Number.isFinite(runeZ) ? 1 : 0);
  for (let zi = 0; zi < NZ; zi++) {
    let z = zi < ZOFF.length ? b.laneZ + ZOFF[zi] : zi < ZOFF.length + 2 ? u.z + (zi === ZOFF.length ? -2 : 2) : runeZ;
    z = Math.max(-zmax, Math.min(zmax, z));
    for (let si = 0; si < 2; si++) {
      let s = si === 0 ? s0 : s1;
      // on the forward strip of the main river (or the nearest ground we can reach behind a channel)
      if (!holdSpot(ns, team, z, s, myComp, cand)) continue;
      if (!standable(ctx.info, cand.x, cand.z)) {
        s += 0.8;
        if (!holdSpot(ns, team, z, s, myComp, cand) || !standable(ctx.info, cand.x, cand.z)) continue;
      }
      if (sim.world.channel(cand.x, cand.z) > -0.4) continue;
      if (myComp >= 0 && !inComp(ns, NAV_LAND, cand.x, cand.z, myComp)) continue;
      found = true;
      if (inHazard(sim, cand.x, cand.z, 1) || nearEnemyFountain(sim, team, cand.x, cand.z, 3)) continue;
      const sc = scoreSpot(sim, ctx, u, b, cand.x, cand.z, hookSoon, myReach);
      if (sc > bestScore) {
        bestScore = sc;
        bx = cand.x;
        bz = cand.z;
      }
    }
  }
  // cover: hide behind a rock or tree near our lane while the hook cools down
  if (!hookSoon && nf > 0) {
    const cover = ctx.info.cover[team];
    for (let k = 0; k < cover.length; k++) {
      const oi = cover[k];
      const ox = ctx.info.ox_[oi];
      const oz = ctx.info.oz_[oi];
      if (Math.abs(oz - b.laneZ) > 8) continue;
      const o = sim.map.obstacles[oi];
      const r = o.shape === 'circle' ? o.r : 0.6;
      // stand on the far side of the cover from the river
      const sx = ox + sideOf(team) * (r + 1.0);
      if (!standable(ctx.info, sx, oz) || inHazard(sim, sx, oz, 1) || sim.world.channel(sx, oz) > -0.4) continue;
      if (myComp >= 0 && !inComp(ns, NAV_LAND, sx, oz, myComp)) continue;
      const sc = scoreSpot(sim, ctx, u, b, sx, oz, false, myReach);
      if (sc > bestScore) {
        bestScore = sc;
        bx = sx;
        bz = oz;
      }
    }
  }
  if (!found && bestScore < -1e8) {
    // nothing on any lane fits (a map edit cut us off): old behaviour, straight back from the centreline
    bankPoint(sim, team, b.laneZ, s0, cand);
    bx = cand.x;
    bz = cand.z;
  }
  b.goalScore = bestScore;
  setGoal(b, Mode.Hold, bx, bz);
}

/** How much a rune is worth to this bot right now (power-up runes count less while we still have one). */
export function runeWorth(u: Unit, t: RuneType): number {
  switch (t) {
    case 'double':
      return u.double > 2 ? 0.5 : 1.5;
    case 'haste':
      return u.haste > 2 ? 0.4 : 1.25;
    case 'bendy':
      return u.bendy > 3 ? 0.4 : 1.25;
    case 'longshot':
      return u.longshot > 3 ? 0.4 : 1.15;
    case 'ironskin':
      return u.shield > 60 ? 0.4 : 0.95;
    case 'bouncy':
      return u.bouncy > 3 ? 0.3 : 0.9;
    case 'ghost':
      return 0.85;
    case 'bounty':
      return 0.8;
    default:
      return 0.5;
  }
}
