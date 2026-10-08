// Geometry helpers for bots: bank positions, water direction, hook delivery and bash landing prediction.
// All of these mirror sim rules that a player can see (where a hooked enemy lands, how far a bash shoves).
import { BAL, UNIT_RADIUS } from '../../constants.ts';
import { dist2, distToSegment } from '../../math.ts';
import type { Team } from '../../types.ts';
import type { HazardInst, Unit } from '../entities.ts';
import type { GameSim } from '../sim.ts';

export interface P2 {
  x: number;
  z: number;
}

/** -1 for team 0 (west bank), +1 for team 1 (east bank). */
export function sideOf(team: Team): number {
  return team === 0 ? -1 : 1;
}

/** Point on `team`'s bank at depth z, `s` metres back from the water's edge (unit centre). */
export function bankPoint(sim: GameSim, team: Team, z: number, s: number, out: P2): P2 {
  const c = sim.world.riverCenter(z);
  out.x = c.x + sideOf(team) * (c.hw + s);
  out.z = z;
  return out;
}

/** Which bank a point is on: 0 west, 1 east (by the river centreline). */
export function bankOf(sim: GameSim, x: number, z: number): Team {
  return x < sim.world.riverCenter(z).x ? 0 : 1;
}

/** Unit vector pointing toward deeper water at (x, z). */
export function waterDir(sim: GameSim, x: number, z: number, out: P2): P2 {
  const w = sim.world;
  const e = 0.12;
  const gx = w.channel(x + e, z) - w.channel(x - e, z);
  const gz = w.channel(x, z + e) - w.channel(x, z - e);
  const l = Math.sqrt(gx * gx + gz * gz);
  if (l < 1e-6) {
    out.x = x < w.riverCenter(z).x ? 1 : -1;
    out.z = 0;
  } else {
    out.x = gx / l;
    out.z = gz / l;
  }
  return out;
}

const tmpR = { x: 0, z: 0, hit: false };

/** Seconds until a periodic hazard (ice spike, steam vent) next fires; Infinity for continuous ones. */
export function hazardFiresIn(sim: GameSim, hz: HazardInst): number {
  if (hz.period <= 0) return Infinity;
  const c = (((sim.matchTime + hz.offset) % hz.period) + hz.period) % hz.period;
  return hz.period - c;
}

/**
 * Would standing in this hazard hurt within `within` seconds? Continuous hazards always do; periodic
 * ones only around their burst (they crack or hiss first, which is the telegraph players read).
 */
export function hazardHot(sim: GameSim, hz: HazardInst, within: number): boolean {
  if (!sim.hazardActive(hz)) return false;
  if (hz.period <= 0) return true;
  const left = hazardFiresIn(sim, hz);
  return left < within || hz.period - left < 0.15;
}

/**
 * Where a unit we are reeling in will be dropped: the sim's delivery rule, with the hand along `face`.
 * (Pressing Bash during the reel turns the face, so the victim lands right in front of the bash.)
 */
export function predictDelivery(sim: GameSim, owner: Unit, face: number, out: P2): boolean {
  const ownerDry = sim.world.channel(owner.x, owner.z) <= 0;
  for (let i = 0; i < 12; i++) {
    const sign = i % 2 === 0 ? 1 : -1;
    const a = face + sign * Math.ceil(i / 2) * (Math.PI / 6);
    const px = owner.x + Math.sin(a) * BAL.hookDeliver;
    const pz = owner.z + Math.cos(a) * BAL.hookDeliver;
    sim.world.resolveCircle(px, pz, UNIT_RADIUS, tmpR);
    if (Math.abs(tmpR.x - px) + Math.abs(tmpR.z - pz) > 0.3) continue;
    if (sim.river.deep && ownerDry && sim.world.channel(px, pz) > -0.1) continue;
    out.x = px;
    out.z = pz;
    return i === 0;
  }
  out.x = owner.x + Math.sin(face) * 0.4;
  out.z = owner.z + Math.cos(face) * 0.4;
  return false;
}

/**
 * How good a spot is to shove an enemy of `team` onto: deep water (by depth), our fountain,
 * damaging hazards. Higher is better; 0 = plain ground.
 */
export function landingScore(sim: GameSim, team: Team, x: number, z: number, deepSoon = false): number {
  let s = 0;
  const ch = sim.world.channel(x, z);
  if ((sim.river.deep || deepSoon) && ch > 0) s += 1.5 + Math.min(ch, 3.5);
  else if (ch > 0) s += 0.2; // into the bed, at least it is slow
  const f = sim.map.fountains[team];
  if (dist2(x, z, f.x, f.z) < (f.r - 0.4) ** 2) s += 2.5;
  const ef = sim.map.fountains[team === 0 ? 1 : 0];
  if (dist2(x, z, ef.x, ef.z) < (ef.r + 1) ** 2) s -= 1.5;
  for (const hz of sim.hazards) {
    if (!sim.hazardActive(hz)) continue;
    if (dist2(x, z, hz.x, hz.z) > (hz.r + 0.3) ** 2) continue;
    if (hz.period > 0) {
      // a vent or spike that blows right after they land is the jackpot
      const left = hazardFiresIn(sim, hz);
      s += left > 0.3 && left < 1.1 ? 1.4 : 0.3;
    } else s += hz.kind === 'bristles' ? 0.8 : 1;
  }
  return s;
}

export interface BashAim {
  ax: number;
  az: number;
  score: number;
  /** landing point */
  lx: number;
  lz: number;
}

/**
 * Best direction to bash an enemy standing at (tx, tz): samples aim angles inside the bash cone and
 * scores where the 6 m shove lands. Knock direction = 0.6 aim + 0.4 radial, like the sim.
 */
export function bestBash(sim: GameSim, u: Unit, tx: number, tz: number, out: BashAim, deepSoon = false): BashAim {
  return bestBashFrom(sim, u.team, u.x, u.z, u.face, tx, tz, out, deepSoon);
}

/** bestBash for a bot standing at (ox, oz) (used to plan dives before we get there). */
export function bestBashFrom(
  sim: GameSim, team: Team, ox: number, oz: number, face: number, tx: number, tz: number, out: BashAim, deepSoon = false,
): BashAim {
  let rx = tx - ox;
  let rz = tz - oz;
  const d = Math.sqrt(rx * rx + rz * rz);
  if (d > 1e-3) {
    rx /= d;
    rz /= d;
  } else {
    rx = Math.sin(face);
    rz = Math.cos(face);
  }
  const base = Math.atan2(rx, rz);
  const wide = d <= 1.2; // point blank: the cone does not matter
  out.score = -1e9;
  out.ax = tx;
  out.az = tz;
  out.lx = tx;
  out.lz = tz;
  for (let k = -5; k <= 5; k++) {
    const off = k * (wide ? 0.55 : 0.2);
    const a = base + off;
    const ax = Math.sin(a);
    const az = Math.cos(a);
    let kx = ax * 0.6 + rx * 0.4;
    let kz = az * 0.6 + rz * 0.4;
    const kl = Math.sqrt(kx * kx + kz * kz) || 1;
    kx /= kl;
    kz /= kl;
    const lx = tx + kx * BAL.bashKnock;
    const lz = tz + kz * BAL.bashKnock;
    // prefer the straight shove a little: off-centre aims risk missing a target that steps aside
    const s = landingScore(sim, team, lx, lz, deepSoon) - Math.abs(off) * 0.15;
    if (s > out.score) {
      out.score = s;
      out.ax = ox + ax * 3;
      out.az = oz + az * 3;
      out.lx = lx;
      out.lz = lz;
    }
  }
  return out;
}

/** Best bash aim for the combo: pick the facing whose delivery point plus shove ends deepest. */
export function bestComboBash(sim: GameSim, u: Unit, out: BashAim, tmp: P2, deepSoon = false): BashAim {
  const wd = waterDir(sim, u.x, u.z, tmp);
  const base = sim.river.deep || deepSoon ? Math.atan2(wd.x, wd.z) : u.face;
  out.score = -1e9;
  out.ax = u.x + Math.sin(base) * 3;
  out.az = u.z + Math.cos(base) * 3;
  out.lx = u.x;
  out.lz = u.z;
  for (let k = -3; k <= 3; k++) {
    const a = base + k * 0.3;
    const straight = predictDelivery(sim, u, a, tmp);
    const px = tmp.x;
    const pz = tmp.z;
    let rx = px - u.x;
    let rz = pz - u.z;
    const rl = Math.sqrt(rx * rx + rz * rz) || 1;
    rx /= rl;
    rz /= rl;
    const ax = Math.sin(a);
    const az = Math.cos(a);
    // outside the cone the bash misses the delivered target entirely
    if (rl > 1.2 && rx * ax + rz * az < Math.cos(BAL.bashArc / 2) - 0.02) continue;
    let kx = ax * 0.6 + rx * 0.4;
    let kz = az * 0.6 + rz * 0.4;
    const kl = Math.sqrt(kx * kx + kz * kz) || 1;
    kx /= kl;
    kz /= kl;
    const lx = px + kx * BAL.bashKnock;
    const lz = pz + kz * BAL.bashKnock;
    const s = landingScore(sim, u.team, lx, lz, deepSoon) - Math.abs(k) * 0.05 + (straight ? 0.1 : 0);
    if (s > out.score) {
      out.score = s;
      out.ax = u.x + ax * 3;
      out.az = u.z + az * 3;
      out.lx = lx;
      out.lz = lz;
    }
  }
  return out;
}

/**
 * True if no drifting mover (log, floe, barge, raft) comes within `margin` of the segment.
 * Grapples latch onto movers, which float in the river: flying there means a swim.
 */
export function moversClear(sim: GameSim, x0: number, z0: number, x1: number, z1: number, margin: number): boolean {
  for (const p of sim.world.moverPoses) {
    if (!p.active) continue;
    const R = p.r + margin;
    for (let i = 0; i <= 4; i++) {
      const k = i / 4;
      const mx = p.ax + (p.bx - p.ax) * k;
      const mz = p.az + (p.bz - p.az) * k;
      if (distToSegment(x0, z0, x1, z1, mx, mz) < R) return false;
    }
  }
  return true;
}
