// Bot combat: picking hook shots (enemies, ally saves, runes), aiming them through the wind-up,
// the hook-then-bash combo, close-range bashes, and grappling out of the water.
// Everything is decided from what the bot's team can see, with the bot's own perception delay.
import { BAL, HOOK_LEVELS, TICK_DT, UNIT_RADIUS } from '../../constants.ts';
import { dist, dist2, distToSegment } from '../../math.ts';
import { Btn, HookKind, HookPhase, UFlag, UnitState, type PlayerInput, type RuneType } from '../../types.ts';
import type { Hook, Unit } from '../entities.ts';
import type { GameSim } from '../sim.ts';
import { HookPath, intercept, scanPath, traceHook, type Body, type Intercept, type ScanResult } from './aim.ts';
import type { BotContext, Seen } from './context.ts';
import { bankOf, bestBash, bestComboBash, moversClear, sideOf, type BashAim, type P2 } from './geom.ts';
import { cellBlocked, hookLineClear } from './mapinfo.ts';
import { compAt, NAV_LAND } from './nav.ts';
import { runeWorth } from './plan.ts';
import { Mode, type Brain, type Intent, type TargetKind } from './types.ts';

// ---------------------------------------------------------------------------------------------
// Scratch (module level, reused every call: no allocations in the hot path)
// ---------------------------------------------------------------------------------------------

const MAXB = 32;
/** body kinds */
const K_ENEMY = 0;
const K_ALLY = 1;
const K_RUNE = 2;
/** something we must not touch: an enemy our team is already reeling in, an ally being saved */
const K_AVOID = 3;

const bodies: Body[] = [];
for (let i = 0; i < MAXB; i++) bodies.push({ id: 0, kind: 0, x: 0, z: 0, vx: 0, vz: 0, r: 0, after: 0 });
const bodyUnit: (Unit | null)[] = new Array<Unit | null>(MAXB).fill(null);
const bodyRune: (RuneType | null)[] = new Array<RuneType | null>(MAXB).fill(null);
let nb = 0;

const path = new HookPath();
const scan: ScanResult = { first: -1, firstT: 0, miss: 0, side: 0, missT: 0 };
const ic: Intercept = { ax: 0, az: 0, t: 0, d: 0 };
const seen: Seen = { x: 0, z: 0, vx: 0, vz: 0 };
const bash: BashAim = { ax: 0, az: 0, score: 0, lx: 0, lz: 0 };
const p2: P2 = { x: 0, z: 0 };

export interface Shot {
  ang: number; // base aim angle (before bend and error)
  bend: number;
  t: number; // seconds from press until contact
  d: number;
  first: number; // body index the solver expects to hit
  bank: boolean;
}
const shot: Shot = { ang: 0, bend: 0, t: 0, d: 0, first: -1, bank: false };
const bankShot: Shot = { ang: 0, bend: 0, t: 0, d: 0, first: -1, bank: true };
const curveShot: Shot = { ang: 0, bend: 0, t: 0, d: 0, first: -1, bank: false };

/** Intent purposes for hooks: a solved angle that must be thrown as is. */
const P_BANK = 9;
const P_CURVE = 8;

/**
 * The hook a throw pressed now would leave with: the bot's own kit, exact. Power-up runes count only
 * if they are still running when the hook leaves the hand (`margin` covers the reaction delay).
 * Mirrors GameSim.spawnHook: Long Line multiplies range and speed, Boing Barb gives the bigger of the
 * two bounce counts, Bendy Eel steers.
 */
interface Kit {
  speed: number;
  hr: number;
  range: number;
  bounces: number;
  bendy: boolean;
  long: boolean;
  bouncy: boolean;
}
const kit: Kit = { speed: 0, hr: 0, range: 0, bounces: 0, bendy: false, long: false, bouncy: false };

function loadKit(u: Unit, margin: number): Kit {
  const left = BAL.hookWindup + margin;
  kit.long = u.longshot > left;
  kit.bouncy = u.bouncy > left;
  kit.bendy = u.bendy > left + 0.3;
  kit.speed = HOOK_LEVELS.speed[u.up.speed] * (kit.long ? BAL.longshotSpeedMul : 1);
  kit.hr = HOOK_LEVELS.width[u.up.width];
  kit.range = HOOK_LEVELS.range[u.up.range] * (kit.long ? BAL.longshotRangeMul : 1);
  kit.bounces = kit.bouncy ? Math.max(BAL.ricochetBounces, BAL.bouncyBounces) : hasItem(u, 'ricochet') ? BAL.ricochetBounces : 0;
  return kit;
}

/** Hook stats of a unit (its own, exact: it is the bot's own kit). */
function hookSpeed(u: Unit): number {
  return HOOK_LEVELS.speed[u.up.speed] * (u.longshot > BAL.hookWindup ? BAL.longshotSpeedMul : 1);
}
function hookWidth(u: Unit): number {
  return HOOK_LEVELS.width[u.up.width];
}
function hookDamage(u: Unit): number {
  return HOOK_LEVELS.damage[u.up.damage] * (u.double > 0 ? 2 : 1);
}
function hasItem(u: Unit, id: string): boolean {
  for (const s of u.items) if (s && s.id === id) return true;
  return false;
}

/** Effective hp of an enemy as a player sees it (hp bar plus a guess for the Iron Skin bubble). */
function effHp(e: Unit): number {
  return e.hp + (e.shield > 0 ? BAL.ironskinShield * 0.7 : 0);
}

/** Is this unit being reeled in by a hook of `team`? */
function hookedByTeam(sim: GameSim, e: Unit, team: number): Hook | null {
  if (e.hookedBy < 0) return null;
  const h = sim.hookById(e.hookedBy);
  if (!h) return null;
  const o = sim.unitById.get(h.owner);
  return o && o.team === team ? h : null;
}

// ---------------------------------------------------------------------------------------------
// World model
// ---------------------------------------------------------------------------------------------

/**
 * Fill the shared body list as `u` perceives the world right now: visible enemies (late by the
 * perception delay, velocities scaled by how much this bot trusts them), allies, and loose runes.
 */
export function gatherBodies(sim: GameSim, ctx: BotContext, u: Unit, b: Brain): number {
  nb = 0;
  const lead = b.tune.leadSkill;
  for (const o of sim.units) {
    if (o === u || o.state === UnitState.Dead || nb >= MAXB - 4) continue;
    const bd = bodies[nb];
    if (o.team !== u.team) {
      if (!ctx.perceive(o, u.team, b.tune.perceiveTicks, seen)) continue;
      bd.x = seen.x;
      bd.z = seen.z;
      let mob = lead;
      if (o.state === UnitState.Casting) mob *= 0.2;
      else if (o.state === UnitState.Drowning) mob *= 0.6;
      bd.vx = seen.vx * mob;
      bd.vz = seen.vz * mob;
      bd.kind = hookedByTeam(sim, o, u.team) ? K_AVOID : K_ENEMY;
    } else {
      bd.x = o.x;
      bd.z = o.z;
      bd.vx = o.vx;
      bd.vz = o.vz;
      bd.kind = hookedByTeam(sim, o, u.team) ? K_AVOID : K_ALLY;
    }
    bd.id = o.id;
    bd.r = UNIT_RADIUS;
    bd.after = ctx.spawnProtLeft(o, u);
    bodyUnit[nb] = o;
    bodyRune[nb] = null;
    nb++;
  }
  for (const r of sim.runes) {
    if (r.dragged || nb >= MAXB) continue;
    const bd = bodies[nb];
    bd.id = r.id;
    bd.kind = K_RUNE;
    bd.x = r.x;
    bd.z = r.z;
    bd.vx = bd.vz = 0;
    bd.r = BAL.runeRadius;
    bd.after = 0;
    bodyUnit[nb] = null;
    bodyRune[nb] = r.type;
    nb++;
  }
  return nb;
}

/** The body list filled by the last gatherBodies call (shared scratch). */
export function bodyList(): readonly Body[] {
  return bodies;
}
export function bodyCount(): number {
  return nb;
}

function findBody(kind: TargetKind, id: number): number {
  for (let i = 0; i < nb; i++) {
    const k = bodies[i].kind;
    if (bodies[i].id !== id) continue;
    if (kind === 0 && k === K_ENEMY) return i;
    if (kind === 1 && (k === K_ALLY || k === K_AVOID)) return i;
    if (kind === 2 && k === K_RUNE) return i;
  }
  return -1;
}

function hitIsGood(focus: number, first: number): boolean {
  if (first === focus) return true;
  // any enemy is a fine catch when we were going for an enemy anyway
  return bodies[focus].kind === K_ENEMY && bodies[first].kind === K_ENEMY;
}

/**
 * Solve a direct shot at bodies[focus] (with whirlpool bend correction). Returns false if the
 * target is out of reach, the line is blocked, or a friend / the wrong thing would be hit first.
 */
function solveDirect(sim: GameSim, ctx: BotContext, u: Unit, focus: number, windup: number, out: Shot): boolean {
  const B = bodies[focus];
  const speed = kit.speed;
  const hr = kit.hr;
  const range = kit.range;
  intercept(u.x, u.z, B.x, B.z, B.vx, B.vz, speed, windup, 1, ic);
  if (ic.d > range + BAL.hookHand + hr + B.r - 0.25) return false;
  const ang = Math.atan2(ic.ax - u.x, ic.az - u.z);
  out.ang = ang;
  out.d = ic.d;
  out.bank = false;
  const wp = sim.map.whirlpool;
  const bounces = kit.bounces;
  // static prefilter: a wall in the way means no direct shot (bank shots are searched separately)
  if (!hookLineClear(ctx.info, u.x, u.z, ic.ax, ic.az, 0.9, B.r + 0.2)) return false;
  let bend = 0;
  let prevBend = 0;
  let prevMiss = 0;
  // a bent path (whirlpool) that only grazes the target is kept as a fallback while the secant
  // search looks for one through its middle: a graze plus the usual release error is a miss
  let fbMiss = Infinity;
  let fbBend = 0;
  let fbT = 0;
  let fbFirst = -1;
  for (let it = 0; it < 5; it++) {
    const a = ang + bend;
    const dx = Math.sin(a);
    const dz = Math.cos(a);
    traceHook(sim.world, wp, u.x + dx * BAL.hookHand, u.z + dz * BAL.hookHand, dx, dz, speed, hr, range, bounces, windup, path);
    scanPath(path, hr, bodies, nb, focus, scan);
    if (scan.first >= 0) {
      if (!hitIsGood(focus, scan.first)) return fbFirst >= 0 ? useFallback(out, fbBend, fbT, fbFirst) : false;
      if (!path.bent || scan.first !== focus || scan.miss < 0.4) {
        out.bend = bend;
        out.t = scan.firstT;
        out.first = scan.first;
        return true;
      }
      if (scan.miss < fbMiss) {
        fbMiss = scan.miss;
        fbBend = bend;
        fbT = scan.firstT;
        fbFirst = scan.first;
      }
    }
    if (!path.bent || !Number.isFinite(scan.miss)) return fbFirst >= 0 ? useFallback(out, fbBend, fbT, fbFirst) : false;
    // secant step on the signed miss distance to undo the whirlpool's bend
    const m = scan.side * scan.miss;
    let next: number;
    if (it === 0) next = -Math.sign(m) * Math.min(0.5, Math.atan2(Math.abs(m), Math.max(2, ic.d * 0.6)));
    else {
      const dm = m - prevMiss;
      next = Math.abs(dm) > 1e-4 ? bend - (m * (bend - prevBend)) / dm : bend * 1.5;
    }
    prevBend = bend;
    prevMiss = m;
    bend = Math.max(-0.9, Math.min(0.9, next));
  }
  return fbFirst >= 0 ? useFallback(out, fbBend, fbT, fbFirst) : false;
}

function useFallback(out: Shot, bend: number, t: number, first: number): boolean {
  out.bend = bend;
  out.t = t;
  out.first = first;
  return true;
}

/**
 * Search for a bank shot at bodies[focus]: off bouncy posts (always), and off any wall or rock while
 * the hook bounces (Ricochet Spring, or a Boing Barb rune with its four bounces).
 */
function solveBank(sim: GameSim, u: Unit, focus: number, windup: number, out: Shot): boolean {
  const B = bodies[focus];
  const speed = kit.speed;
  const hr = kit.hr;
  const range = kit.range;
  const bounces = kit.bounces;
  const wp = sim.map.whirlpool;
  const base = Math.atan2(B.x - u.x, B.z - u.z);
  let bestT = Infinity;
  let bestA = 0;
  // Boing Barb: four bounces off anything make far more banks possible, so fan wider and finer
  const fan = kit.bouncy ? 22 : 12;
  const stepA = kit.bouncy ? 0.075 : 0.1;
  for (let i = -fan; i <= fan; i++) {
    if (i === 0) continue;
    const a = base + i * stepA;
    const dx = Math.sin(a);
    const dz = Math.cos(a);
    traceHook(sim.world, wp, u.x + dx * BAL.hookHand, u.z + dz * BAL.hookHand, dx, dz, speed, hr, range, bounces, windup, path);
    if (!path.bounced) continue;
    scanPath(path, hr, bodies, nb, focus, scan);
    if (scan.first >= 0 && hitIsGood(focus, scan.first) && scan.firstT < bestT) {
      bestT = scan.firstT;
      bestA = a;
    }
  }
  if (!Number.isFinite(bestT)) return false;
  out.ang = bestA;
  out.bend = 0;
  out.t = bestT;
  out.d = dist(u.x, u.z, B.x, B.z);
  out.first = focus;
  out.bank = true;
  return true;
}

const BENDY_STEP = 0.35;

/**
 * Fly a Bendy Eel hook the way steerBendy will steer it: straight on until the head can see the
 * target, then turn toward where the target will be at the sim's turn rate. Static obstacles come
 * from the hook grid. Returns the time from the press until it touches the target, or Infinity.
 */
function traceCurve(sim: GameSim, ctx: BotContext, u: Unit, focus: number, a0: number, windup: number): number {
  const info = ctx.info;
  const movers = sim.world.moverPoses;
  const B = bodies[focus];
  const speed = kit.speed;
  const hr = kit.hr;
  let dx = Math.sin(a0);
  let dz = Math.cos(a0);
  let x = u.x + dx * BAL.hookHand;
  let z = u.z + dz * BAL.hookHand;
  if (cellBlocked(info, info.hookGrid, x, z)) return Infinity;
  const maxTurn = BAL.bendyTurn * (BENDY_STEP / speed);
  let t = windup;
  let clear = false;
  for (let k = 0, traveled = 0; traveled < kit.range; k++, traveled += BENDY_STEP) {
    const bx = B.x + B.vx * t;
    const bz = B.z + B.vz * t;
    if (k % 3 === 0) clear = hookLineClear(info, x, z, bx, bz, 0, B.r + 0.2);
    if (clear) {
      const cur = Math.atan2(dx, dz);
      let d = Math.atan2(bx - x, bz - z) - cur;
      d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
      if (Math.abs(d) <= 2.6) {
        const a = cur + (d > maxTurn ? maxTurn : d < -maxTurn ? -maxTurn : d);
        dx = Math.sin(a);
        dz = Math.cos(a);
      }
    }
    x += dx * BENDY_STEP;
    z += dz * BENDY_STEP;
    t += BENDY_STEP / speed;
    if (cellBlocked(info, info.hookGrid, x, z)) return Infinity;
    // drifting logs and barges block a hook too (where they are now: close enough for one flight)
    for (let m = 0; m < movers.length; m++) {
      const p = movers[m];
      if (p.active && distToSegment(p.ax, p.az, p.bx, p.bz, x, z) < p.r + hr) return Infinity;
    }
    for (let j = 0; j < nb; j++) {
      const o = bodies[j];
      if (t < o.after) continue;
      const ox = o.x + o.vx * t - x;
      const oz = o.z + o.vz * t - z;
      const R = hr + o.r;
      if (ox * ox + oz * oz < R * R) return hitIsGood(focus, j) ? t : Infinity;
    }
  }
  return Infinity;
}

/** Bendy Eel: find a throw that curves around the cover between us and bodies[focus]. */
function solveCurve(sim: GameSim, ctx: BotContext, u: Unit, focus: number, windup: number, out: Shot): boolean {
  const B = bodies[focus];
  const d = dist(u.x, u.z, B.x, B.z);
  if (d > kit.range + BAL.hookHand + 1) return false;
  const base = Math.atan2(B.x - u.x, B.z - u.z);
  let bestT = Infinity;
  let bestA = 0;
  for (let i = 1; i <= 8; i++) {
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      const a = base + sgn * i * 0.13;
      const tt = traceCurve(sim, ctx, u, focus, a, windup);
      if (tt < bestT) {
        bestT = tt;
        bestA = a;
      }
    }
    if (Number.isFinite(bestT)) break; // the smallest swing that gets round is the surest
  }
  if (!Number.isFinite(bestT)) return false;
  out.ang = bestA;
  out.bend = 0;
  out.t = bestT;
  out.d = d;
  out.first = focus;
  out.bank = false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Shot value and hit chance
// ---------------------------------------------------------------------------------------------

/**
 * Chance a shot lands. If the target cannot get out of the way in the time the head needs, it is
 * nearly certain; otherwise it depends on whether they react, which gets likelier with flight time.
 */
function hitChance(e: Unit | null, t: number, hr: number, vx: number, vz: number): number {
  if (!e) return 0.96; // runes do not dodge
  let mob = 1;
  switch (e.state) {
    case UnitState.Casting:
      mob = 0.3;
      break;
    case UnitState.Drowning:
      mob = BAL.swimSpeed;
      break;
    case UnitState.Knocked:
      mob = 0.15;
      break;
    case UnitState.Hooked:
      mob = 0.25;
      break;
    case UnitState.Grappling:
      mob = 0.6;
      break;
  }
  if (e.inHazard) mob *= 0.6;
  if (e.surface === 'shallow') mob *= BAL.shallowSlow;
  if (e.surface === 'ice') mob *= 0.5; // slippery: hard to change direction
  if (e.activeHook >= 0) mob *= BAL.hookMoveSlow; // reeling in their own hook: slowed
  const speed = BAL.moveSpeed * (e.haste > 0 ? BAL.hasteMul : 1) * mob;
  const avail = Math.max(0, t - 0.22); // a sharp player needs ~0.2 s to see the throw
  const need = hr + UNIT_RADIUS;
  const ratio = (speed * avail) / need;
  let p = ratio <= 0.6 ? 0.95 : 0.95 - 0.5 * Math.min(1, (ratio - 0.6) / 1.6);
  // a moving target may change its mind mid-flight
  const sp = Math.sqrt(vx * vx + vz * vz);
  if (mob > 0.5) p *= 1 - 0.25 * Math.min(1, sp / BAL.moveSpeed) * Math.min(1, t / 0.5);
  return p;
}

function enemyValue(sim: GameSim, ctx: BotContext, u: Unit, b: Brain, e: Unit, t: number): number {
  const dmg = hookDamage(u);
  const hp = effHp(e);
  if (e.state === UnitState.Drowning) return hp <= dmg ? 2 : 0.12; // they are sinking anyway
  if (e.state === UnitState.Grappling && b.diff !== 'brutal') return 0;
  let v = 1;
  const saving = e.hookedBy >= 0 && !hookedByTeam(sim, e, u.team);
  if (saving) {
    if (!b.tune.steal) return 0;
    v += 1; // deny their save
  }
  if (hp <= dmg * 0.98) v += 2.5;
  else {
    // a catch at the bank with Bash ready is a drowning: the classic combo
    const back = t + dist(u.x, u.z, e.x, e.z) / (hookSpeed(u) * BAL.hookRetractMul);
    const edge = -sim.world.channel(u.x, u.z);
    if (sim.river.deep && u.cdBash <= back + 0.1 && edge < 3.3 && bankOf(sim, e.x, e.z) !== u.team) {
      // no grapple to climb out with: that is a drowning
      v += ctx.grappleReadyIn(e, u) > back + 2.5 ? 2.2 : 1.3;
    }
    else if (hp <= dmg + BAL.bashDamage + 120) v += 0.8;
    else if (!sim.river.deep) v += 0.25; // pull them onto our side to brawl
  }
  if (e.double > 0 || e.haste > 0) v += 0.35;
  if (ctx.hookReadyIn(e, u) <= 0.3) v += 0.25; // disarm a loaded hook
  return v;
}

function allyValue(sim: GameSim, ctx: BotContext, u: Unit, b: Brain, a: Unit, t: number): number {
  if (ctx.claimedByOther(u.team, a.id, u.id)) return 0;
  // being dragged away by an enemy hook: steal them back
  if (a.hookedBy >= 0) {
    const h = sim.hookById(a.hookedBy);
    const o = h ? sim.unitById.get(h.owner) : undefined;
    if (!o || o.team === u.team) return 0;
    return bankOf(sim, o.x, o.z) !== u.team || sim.river.deep ? 1.9 : 0.9;
  }
  if (a.state === UnitState.Drowning) {
    const left = BAL.drownTime - a.drownT;
    if (t > left - 0.05) return 0; // too late
    // can they swim out on their own?
    const depth = sim.world.channel(a.x, a.z);
    if (depth < BAL.moveSpeed * BAL.swimSpeed * left * 0.6) return 0.25;
    return 2.3;
  }
  if (a.state !== UnitState.Alive && a.state !== UnitState.Casting) return 0;
  const dry = sim.world.channel(a.x, a.z) <= 0;
  // on the far bank, or on an island or floe our side cannot walk back from
  const onEnemySide = dry && (bankOf(sim, a.x, a.z) !== u.team || (sim.river.deep && cutOff(ctx, a)));
  // stranded on the far bank in deep water: bring them home when they are hurt or done
  if (onEnemySide && sim.river.deep) {
    if (a.hp < a.maxHp * 0.55 || (a.isBot && a.cdBash > 2 && a.cdGrapple > 2)) return 1.1;
    return 0.15;
  }
  // low and in trouble: pull them to us
  if (a.hp < a.maxHp * 0.3) {
    for (const e of ctx.foes[u.team]) if (dist2(e.x, e.z, a.x, a.z) < 25) return 0.8;
  }
  return 0;
}

/** Standing on dry ground its own fountain cannot be walked to from (an island, a floe, the far bank). */
function cutOff(ctx: BotContext, a: Unit): boolean {
  const ns = ctx.nav;
  const home = ns.homeComp[a.team];
  const c = compAt(ns, NAV_LAND, a.x, a.z, 2);
  return c >= 0 && home >= 0 && c !== home;
}

function runeValue(u: Unit, t: RuneType | null): number {
  return t ? runeWorth(u, t) : 0;
}

// ---------------------------------------------------------------------------------------------
// Hook decisions
// ---------------------------------------------------------------------------------------------

function tri(b: Brain): number {
  return b.rng.next() + b.rng.next() - 1;
}

/** Look for a hook worth throwing. Creates an intent (pressed after the reaction delay). */
export function thinkHook(sim: GameSim, ctx: BotContext, u: Unit, b: Brain): void {
  const t = sim.time;
  if (!canCast(u, 'hook') || b.intent || sim.phase !== 'playing') return;
  if (b.hookReadySince < 0) b.hookReadySince = t;
  const tune = b.tune;
  const waited = t - b.hookReadySince;
  const bar = tune.throwBar * Math.max(0.45, 1 - (waited / tune.patience) * 0.55);
  gatherBodies(sim, ctx, u, b);
  const windup = BAL.hookWindup;
  // what the hook will be when the press lands after our reaction delay
  loadKit(u, tune.decide + 0.25);
  const hr = kit.hr;
  const role = b.roleDef;
  // Boing Barb makes every wall a cushion: even easy bots look for bank shots while it lasts
  const bankEvery = kit.bouncy ? Math.min(tune.bankShotEvery, 1.2) : tune.bankShotEvery;
  const canBank = (tune.bankShots > 0 || kit.bouncy) && t - b.lastBankSearch >= bankEvery
    && (kit.bounces > 0 || (tune.bankShots > 1 && ctx.info.bouncy));
  const canCurve = kit.bendy && t - b.lastBankSearch >= Math.min(bankEvery, 0.6);
  let best = -1;
  let bestScore = 0;
  let bestP = 0;
  let bestBend = 0;
  let bestAng = 0;
  let bestBank = false;
  let bestCurve = false;
  let bankTried = false;
  let curveTried = false;
  for (let i = 0; i < nb; i++) {
    const B = bodies[i];
    let v = 0;
    const unit = bodyUnit[i];
    if (B.kind === K_ENEMY && unit) {
      v = enemyValue(sim, ctx, u, b, unit, 0.45);
      if (unit.id === b.diveTarget && t < b.diveUntil) v += 3; // we flew over here for this one
    }
    else if ((B.kind === K_ALLY || B.kind === K_AVOID) && unit) v = allyValue(sim, ctx, u, b, unit, 0.4) * role.saveBias;
    else if (B.kind === K_RUNE) v = ctx.claimedByOther(u.team, B.id, u.id) ? 0 : runeValue(u, bodyRune[i]) * role.runeBias;
    if (v <= 0.05) continue;
    const reach = kit.range + 2.5;
    if (dist2(u.x, u.z, B.x, B.z) > reach * reach) continue;
    // ally being dragged by an enemy hook counts as K_AVOID for blockers, but it is our focus here
    const kindSave = B.kind;
    if (B.kind === K_AVOID) B.kind = K_ALLY;
    let ok = solveDirect(sim, ctx, u, i, windup, shot);
    let s: Shot = shot;
    let curved = false;
    // Bendy Eel: swing the throw wide of the cover and let it curve in (one target per think)
    if (!ok && canCurve && !curveTried) {
      curveTried = true;
      ok = solveCurve(sim, ctx, u, i, windup, curveShot);
      s = curveShot;
      curved = ok;
    }
    if (!ok && canBank && !bankTried && B.kind !== K_RUNE) {
      bankTried = true;
      ok = solveBank(sim, u, i, windup, bankShot);
      s = bankShot;
    }
    B.kind = kindSave;
    if (!ok) continue;
    let p = hitChance(unit, s.t, hr, B.vx, B.vz);
    if (unit && B.kind !== K_ENEMY) p = Math.min(0.95, p + 0.25); // allies hold still for a save
    if (s.bank) p *= 0.75;
    // a Bendy Eel hook keeps chasing a target that sidesteps (we steer it all the way in)
    if (kit.bendy) p = 1 - (1 - p) * (curved ? 0.55 : 0.4);
    const score = p * v;
    if (score > bestScore) {
      bestScore = score;
      best = i;
      bestP = p;
      bestBend = s.bend;
      bestAng = s.ang;
      bestBank = s.bank;
      bestCurve = curved;
    }
  }
  if (bankTried || curveTried) b.lastBankSearch = t;
  if (best < 0 || bestScore < bar) return;
  const B = bodies[best];
  const unit = bodyUnit[best];
  // Bait: with a mediocre shot and their hook loaded, make them throw first (then punish).
  if (tune.tricks && unit && B.kind === K_ENEMY && bestP < 0.6 && u.hp > u.maxHp * 0.5 && waited < tune.patience * 0.5
    && ctx.hookReadyIn(unit, u) <= 0.2 && bestScore < 1.2) {
    b.baitUntil = t + 0.4;
    return;
  }
  if (b.rng.next() < tune.hesitate) {
    b.nextThink = t + tune.reaction * (0.5 + b.rng.next());
    return;
  }
  const tk: TargetKind = B.kind === K_ENEMY ? 0 : B.kind === K_RUNE ? 2 : 1;
  const planned = B.id === b.diveTarget && t < b.diveUntil; // no hesitation: this was the plan
  b.intent = makeIntent(b, 'hook', tk, B.id, u.x + Math.sin(bestAng) * 8, u.z + Math.cos(bestAng) * 8,
    planned ? t : t + tune.decide * (0.6 + 0.8 * b.rng.next()), bestScore, bestBend + (bestBank ? bestAng - Math.atan2(B.x - u.x, B.z - u.z) : 0));
  if (planned) b.diveTarget = -1;
  if (bestBank) b.intent.purpose = P_BANK; // bank shot: keep the solved angle
  else if (bestCurve) b.intent.purpose = P_CURVE; // curve shot: keep the solved angle, steer it in
  if (tk !== 0) ctx.claim(u.team, B.id, u.id, t + 1.5);
}

function makeIntent(b: Brain, kind: Intent['kind'], tk: TargetKind, id: number, x: number, z: number, at: number, value: number, bend: number): Intent {
  const it = b.intent ?? { kind, tk, id, x, z, at, value, bend, purpose: 0 };
  it.kind = kind;
  it.tk = tk;
  it.id = id;
  it.x = x;
  it.z = z;
  it.at = at;
  it.value = value;
  it.bend = bend;
  it.purpose = 0;
  return it;
}

function press(input: PlayerInput, btn: number, ax: number, az: number): void {
  input.b |= btn;
  input.ax = ax;
  input.az = az;
}

/** True if a cast of this kind would start right now (never feed the sim's input buffer). */
export function canCast(u: Unit, kind: 'hook' | 'grapple' | 'bash'): boolean {
  if (kind === 'grapple') return (u.state === UnitState.Alive || u.state === UnitState.Drowning) && u.cdGrapple <= 0 && u.activeGrapple < 0;
  if (u.state !== UnitState.Alive || u.activeGrapple >= 0) return false; // a latch would cancel it
  return kind === 'hook' ? u.cdHook <= 0 && u.activeHook < 0 : u.cdBash <= 0;
}

/** Press a due intent. Returns true if a button was pressed. */
export function runIntent(sim: GameSim, ctx: BotContext, u: Unit, b: Brain, input: PlayerInput): boolean {
  const it = b.intent;
  if (!it || sim.time < it.at) return false;
  b.intent = null;
  if (sim.phase !== 'playing' || !canCast(u, it.kind)) return false;
  if (it.kind === 'hook') {
    gatherBodies(sim, ctx, u, b);
    const fi = findBody(it.tk, it.id);
    if (fi < 0) return false;
    const B = bodies[fi];
    const kindSave = B.kind;
    if (B.kind === K_AVOID) B.kind = K_ALLY;
    loadKit(u, 0.02);
    let ang: number;
    let bend = 0;
    const locked = it.purpose === P_BANK || it.purpose === P_CURVE;
    if (locked) {
      ang = Math.atan2(it.x - u.x, it.z - u.z);
    } else {
      const ok = solveDirect(sim, ctx, u, fi, BAL.hookWindup, shot);
      B.kind = kindSave;
      if (!ok) return false;
      ang = shot.ang;
      bend = shot.bend;
    }
    B.kind = kindSave;
    const unit = bodyUnit[fi];
    // human-like imperfection: a fixed angular error per throw, bigger when the target is moving
    let err = tri(b) * b.tune.aimError;
    if (unit && it.tk === 0) {
      const sp = Math.hypot(B.vx, B.vz) / Math.max(0.2, b.tune.leadSkill);
      err *= 0.7 + Math.min(0.6, sp / 10);
    } else err *= 0.5;
    if (kit.bendy) err *= 0.5; // the steering takes out most of a sloppy release
    const a = ang + bend + err;
    press(input, Btn.Hook, u.x + Math.sin(a) * 8, u.z + Math.cos(a) * 8);
    b.aim = { kind: 'hook', tk: it.tk, id: it.id, x: u.x + Math.sin(a) * 8, z: u.z + Math.cos(a) * 8, err, bend, lead: 1 };
    if (locked) {
      b.aim.tk = 3; // locked angle
      if (it.purpose === P_BANK) b.stats.bankShots++;
    }
    // remember what a Bendy Eel hook should chase once it is out
    b.steerTk = kit.bendy ? it.tk : -1;
    b.steerId = it.id;
    if (kit.bendy) b.stats.bendyThrows++;
    if (kit.long && dist(u.x, u.z, B.x, B.z) > HOOK_LEVELS.range[u.up.range] + BAL.hookHand) b.stats.longshots++;
    b.hookReadySince = -1;
    b.stats.hooks++;
    if (it.tk === 1) b.stats.saves++;
    if (it.tk === 2) b.stats.runes++;
    return true;
  }
  if (it.kind === 'bash') {
    if (b.reeling || b.comboTarget >= 0) return false; // the combo owns the bash
    const tg = sim.unitById.get(it.id);
    if (!tg || tg.state === UnitState.Dead || tg.state === UnitState.Hooked) return false;
    if (!ctx.perceive(tg, u.team, b.tune.perceiveTicks, seen)) return false;
    if (dist(u.x, u.z, seen.x, seen.z) > BAL.bashRange + UNIT_RADIUS - 0.2) return false;
    bestBash(sim, u, seen.x, seen.z, bash, ctx.untilDeep < 2.2);
    press(input, Btn.Bash, bash.ax, bash.az);
    b.aim = { kind: 'bash', tk: it.tk, id: it.id, x: bash.ax, z: bash.az, err: 0, bend: 0, lead: 0 };
    return true;
  }
  let gx = it.x;
  let gz = it.z;
  let gtk: TargetKind = 3;
  if (it.purpose === 3) {
    // snatch dive: fly at the enemy where they are now
    const tg = sim.unitById.get(it.id);
    if (!tg || tg.state === UnitState.Dead || !ctx.perceive(tg, u.team, b.tune.perceiveTicks, seen)) {
      b.diveTarget = -1;
      return false;
    }
    gx = seen.x;
    gz = seen.z;
    gtk = 0;
  }
  if (!moversClear(sim, u.x, u.z, gx, gz, 1.1)) {
    b.diveTarget = -1; // a log drifted into the way: not today
    return false;
  }
  press(input, Btn.Grapple, gx, gz);
  b.aim = { kind: 'grapple', tk: gtk, id: it.id, x: gx, z: gz, err: 0, bend: 0, lead: 0 };
  if (it.purpose === 1 || it.purpose === 3) {
    b.stats.dives++;
    b.diveUntil = sim.time + 2.2;
  }
  return true;
}

/** While winding up, keep the aim on the target (the sim reads the aim at release). */
export function holdAim(sim: GameSim, ctx: BotContext, u: Unit, b: Brain, input: PlayerInput): void {
  const a = b.aim;
  if (!a) return;
  input.ax = a.x;
  input.az = a.z;
  if (a.kind === 'grapple' && a.tk === 0) {
    const tg = sim.unitById.get(a.id);
    if (tg && tg.state !== UnitState.Dead && ctx.perceive(tg, u.team, 1, seen)) {
      a.x = seen.x;
      a.z = seen.z;
      input.ax = a.x;
      input.az = a.z;
    }
    return;
  }
  if (a.kind !== 'hook' || a.tk === 3) return;
  let tx = 0;
  let tz = 0;
  let vx = 0;
  let vz = 0;
  if (a.tk === 2) {
    let found = false;
    for (const r of sim.runes) {
      if (r.id === a.id && !r.dragged) {
        tx = r.x;
        tz = r.z;
        found = true;
        break;
      }
    }
    if (!found) return;
  } else {
    const tg = sim.unitById.get(a.id);
    if (!tg || tg.state === UnitState.Dead) return;
    if (tg.team === u.team) {
      tx = tg.x;
      tz = tg.z;
      vx = tg.vx;
      vz = tg.vz;
    } else {
      if (!ctx.perceive(tg, u.team, b.tune.perceiveTicks, seen)) return;
      tx = seen.x;
      tz = seen.z;
      vx = seen.vx * b.tune.leadSkill;
      vz = seen.vz * b.tune.leadSkill;
      if (tg.state === UnitState.Casting) {
        vx *= 0.2;
        vz *= 0.2;
      }
    }
  }
  intercept(u.x, u.z, tx, tz, vx, vz, hookSpeed(u), Math.max(0, u.castT), 1, ic);
  const ang = Math.atan2(ic.ax - u.x, ic.az - u.z) + a.bend + a.err;
  a.x = u.x + Math.sin(ang) * 8;
  a.z = u.z + Math.cos(ang) * 8;
  input.ax = a.x;
  input.az = a.z;
}

/**
 * Bendy Eel in flight: the sim turns our flying hook toward our live cursor (GameSim.steerHook), so
 * every tick we put the cursor where the target will be when the head gets there. Until the head
 * can see the target (it is still swinging round cover) the cursor stays dead ahead, so the hook
 * flies on instead of turning into the rock. A target that is lost or behind the head is swapped for
 * any visible enemy ahead; with nothing to chase the hook just flies straight.
 */
export function steerBendy(sim: GameSim, ctx: BotContext, u: Unit, b: Brain, input: PlayerInput): void {
  if (u.activeHook < 0) return;
  let h: Hook | null = null;
  for (const x of sim.hooks) {
    if (x.id === u.activeHook && !x.dead) {
      h = x;
      break;
    }
  }
  if (!h || !h.steer || h.phase !== HookPhase.Out || h.kind !== HookKind.Hook) return;
  const hx = h.x;
  const hz = h.z;
  let ok = bendyTarget(sim, ctx, u, b);
  if (ok) {
    // behind the head (we flew past it): the sim would refuse to loop back anyway
    const rx = seen.x - hx;
    const rz = seen.z - hz;
    const rl = Math.sqrt(rx * rx + rz * rz);
    if (rl > 1 && (rx * h.dx + rz * h.dz) / rl < -0.45) ok = false;
  }
  if (!ok && b.steerTk !== 1 && b.steerTk !== 2) {
    // anyone else in front of the head and within what is left of its flight?
    const left = h.range - h.traveled;
    let bestD = Infinity;
    let pick = -1;
    for (const e of ctx.foes[u.team]) {
      if (e.state === UnitState.Dead || e.spawnProt > 0 || hookedByTeam(sim, e, u.team)) continue;
      if (!ctx.perceive(e, u.team, b.tune.perceiveTicks, seen)) continue;
      const rx = seen.x - hx;
      const rz = seen.z - hz;
      const d = Math.sqrt(rx * rx + rz * rz);
      if (d > left + 1 || d < 0.5 || (rx * h.dx + rz * h.dz) / d < 0.35) continue;
      if (d < bestD && hookLineClear(ctx.info, hx, hz, seen.x, seen.z, 0, 0.6)) {
        bestD = d;
        pick = e.id;
      }
    }
    if (pick >= 0) {
      b.steerTk = 0;
      b.steerId = pick;
      ok = bendyTarget(sim, ctx, u, b);
    }
  }
  let ax = hx + h.dx * 30;
  let az = hz + h.dz * 30;
  if (ok) {
    const d = dist(hx, hz, seen.x, seen.z);
    const tt = d / h.speed;
    const px = seen.x + seen.vx * tt;
    const pz = seen.z + seen.vz * tt;
    // turn in only on a line that is clear of rocks and of the logs and barges drifting by
    if (hookLineClear(ctx.info, hx, hz, px, pz, 0, 0.6) && moversClear(sim, hx, hz, px, pz, h.r + 0.15)) {
      // the sim ignores a cursor within 1 m of the head: put it beyond the target, on the same line
      const dx = px - hx;
      const dz = pz - hz;
      const l = Math.sqrt(dx * dx + dz * dz) || 1;
      const k = Math.max(3, l) / l;
      ax = hx + dx * k;
      az = hz + dz * k;
      b.stats.bendySteers++;
    }
  }
  input.ax = ax;
  input.az = az;
}

/** Where the Bendy Eel's target is (as we perceive it), into `seen`. False if it is gone. */
function bendyTarget(sim: GameSim, ctx: BotContext, u: Unit, b: Brain): boolean {
  if (b.steerTk === 2) {
    for (const r of sim.runes) {
      if (r.id === b.steerId && !r.dragged) {
        seen.x = r.x;
        seen.z = r.z;
        seen.vx = 0;
        seen.vz = 0;
        return true;
      }
    }
    return false;
  }
  if (b.steerTk !== 0 && b.steerTk !== 1) return false;
  const tg = sim.unitById.get(b.steerId);
  if (!tg || tg.state === UnitState.Dead) return false;
  if (tg.team === u.team) {
    seen.x = tg.x;
    seen.z = tg.z;
    seen.vx = tg.vx;
    seen.vz = tg.vz;
    return true;
  }
  if (!ctx.perceive(tg, u.team, b.tune.perceiveTicks, seen)) return false;
  const lead = b.tune.leadSkill;
  seen.vx *= lead;
  seen.vz *= lead;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Combo: our hook is reeling in an enemy -> bash them into the river the moment they land
// ---------------------------------------------------------------------------------------------

function ticksToHand(u: Unit, h: Hook, face: number): number {
  // the head runs back through the bend points to the hand
  let L = 0;
  let x = h.x;
  let z = h.z;
  for (let i = h.pts.length - 2; i >= 0; i -= 2) {
    L += dist(x, z, h.pts[i], h.pts[i + 1]);
    x = h.pts[i];
    z = h.pts[i + 1];
  }
  const hx = u.x + Math.sin(face) * BAL.hookHand * 0.8;
  const hz = u.z + Math.cos(face) * BAL.hookHand * 0.8;
  L += dist(x, z, hx, hz);
  const m = h.speed * BAL.hookRetractMul * TICK_DT;
  return Math.ceil(L / m);
}

/**
 * Called every tick. Holds the bot still while its hook is out (so the catch lands where expected),
 * and presses Bash so it releases one tick after the catch is dropped: pressing turns the bot to
 * the bash aim, and the sim drops the catch along the facing, i.e. right in front of the shove.
 * Clumsier bots sometimes fumble the timing and bash a moment later instead.
 */
export function comboWatch(sim: GameSim, ctx: BotContext, u: Unit, b: Brain, input: PlayerInput): void {
  // plant our feet through our own hook or grapple wind-up: the throw leaves from wherever the hand
  // is at release, so walking on would bend a carefully led shot off its line
  b.holdStill = u.castKind === 'hook' || u.castKind === 'grapple';
  b.reeling = false;
  const t = sim.time;
  if (u.activeHook >= 0) {
    let h: Hook | null = null;
    for (const x of sim.hooks) {
      if (x.id === u.activeHook && !x.dead) {
        h = x;
        break;
      }
    }
    if (!h || h.kind !== HookKind.Hook) return;
    b.holdStill = true;
    if (h.phase !== HookPhase.Back || h.tg < 0) return;
    const tg = sim.unitById.get(h.tg);
    if (!tg || tg.team === u.team || tg.state === UnitState.Dead) return;
    b.reeling = true;
    if (!canCast(u, 'bash') || b.comboTarget === tg.id) return;
    if (ticksToHand(u, h, u.face) > 5) return;
    bestComboBash(sim, u, bash, p2, ctx.untilDeep < 2.2);
    // pressing turns us to the bash aim, which moves the hand: time the press with the new hand
    const k = ticksToHand(u, h, Math.atan2(bash.ax - u.x, bash.az - u.z));
    if (k > 3) return;
    if (b.rng.next() < b.tune.fumble) {
      b.comboTarget = tg.id;
      b.comboAt = t + k * TICK_DT + b.tune.comboDelay;
      return;
    }
    // dry bed with nothing to shove them into: keep them close for the wallops
    if (bash.score < 1 && effHp(tg) > BAL.bashDamage) return;
    press(input, Btn.Bash, bash.ax, bash.az);
    b.aim = { kind: 'bash', tk: 0, id: tg.id, x: bash.ax, z: bash.az, err: 0, bend: 0, lead: 0 };
    b.stats.combos++;
    return;
  }
  if (b.comboTarget < 0) return;
  const tg = sim.unitById.get(b.comboTarget);
  if (!tg || tg.state === UnitState.Dead || t > b.comboAt + 0.8) {
    b.comboTarget = -1;
    return;
  }
  b.holdStill = true;
  if (t < b.comboAt || !canCast(u, 'bash') || tg.state === UnitState.Hooked) return;
  b.comboTarget = -1;
  if (!ctx.perceive(tg, u.team, 1, seen)) return;
  if (dist(u.x, u.z, seen.x, seen.z) > BAL.bashRange + UNIT_RADIUS - 0.2) return;
  bestBash(sim, u, seen.x, seen.z, bash, ctx.untilDeep < 2.2);
  if (bash.score < 1 && effHp(tg) > BAL.bashDamage) return;
  press(input, Btn.Bash, bash.ax, bash.az);
  b.aim = { kind: 'bash', tk: 0, id: tg.id, x: bash.ax, z: bash.az, err: 0, bend: 0, lead: 0 };
  b.stats.combos++;
}

// ---------------------------------------------------------------------------------------------
// Close range: bash enemies into the water, into hazards, or out of their own wind-up
// ---------------------------------------------------------------------------------------------

export function thinkBash(sim: GameSim, ctx: BotContext, u: Unit, b: Brain): void {
  if (b.intent || !canCast(u, 'bash') || sim.phase !== 'playing') return;
  const reach = BAL.bashRange + UNIT_RADIUS - 0.35;
  let bestV = 0;
  let bx = 0;
  let bz = 0;
  let bid = -1;
  const edge = -sim.world.channel(u.x, u.z);
  for (const e of ctx.foes[u.team]) {
    if (e.state === UnitState.Hooked || e.state === UnitState.Grappling || e.spawnProt > 0) continue;
    if (!ctx.perceive(e, u.team, b.tune.perceiveTicks, seen)) continue;
    const d = dist(u.x, u.z, seen.x, seen.z);
    if (d > reach) continue;
    bestBash(sim, u, seen.x, seen.z, bash, ctx.untilDeep < 2.2);
    let v = bash.score * 0.8 + 0.15;
    if (e.state === UnitState.Casting) v += 0.8; // knock them out of their wind-up
    if (effHp(e) <= BAL.bashDamage * (u.double > 0 ? 2 : 1)) v += 2;
    // they could shove us in: get the first shove in
    if (sim.river.deep && edge < 3.2 && -sim.world.channel(seen.x, seen.z) > edge) v += 0.6;
    v *= b.roleDef.bashBias;
    if (v > bestV) {
      bestV = v;
      bx = bash.ax;
      bz = bash.az;
      bid = e.id;
    }
  }
  if (bid < 0 || bestV < 0.9) return;
  b.intent = makeIntent(b, 'bash', 0, bid, bx, bz, sim.time + b.tune.decide * (0.4 + 0.5 * b.rng.next()), bestV, 0);
}

// ---------------------------------------------------------------------------------------------
// Grapple: out of the water, home from the far bank
// ---------------------------------------------------------------------------------------------

/**
 * Find a grapple anchor whose landing point is dry land on bank `want` (or any bank if want < 0).
 * Writes the aim point to out. Prefers our own bank and short flights.
 */
export function findAnchor(sim: GameSim, ctx: BotContext, u: Unit, b: Brain, want: number, out: P2): boolean {
  const info = ctx.info;
  const r2 = (BAL.grappleRange + 0.5) ** 2;
  let best = Infinity;
  const wp = sim.map.whirlpool;
  gatherBodies(sim, ctx, u, b);
  for (let side = 0; side < 2; side++) {
    if (want >= 0 && side !== want) continue;
    const list = info.anchors[side];
    for (let k = 0; k < list.length; k++) {
      const oi = list[k];
      const ox = info.ox_[oi];
      const oz = info.oz_[oi];
      const d2v = dist2(u.x, u.z, ox, oz);
      if (d2v > r2 || d2v < 4) continue;
      const d = Math.sqrt(d2v);
      const dx = (ox - u.x) / d;
      const dz = (oz - u.z) / d;
      traceHook(sim.world, wp, u.x + dx * BAL.hookHand, u.z + dz * BAL.hookHand, dx, dz, BAL.grappleSpeed, BAL.grappleRadius, BAL.grappleRange, 0, 0, path, true);
      if (!path.blocked) continue;
      const ex = path.x[path.n - 1];
      const ez = path.z[path.n - 1];
      // a unit in the way latches first: fine if it stands on land
      scanPath(path, BAL.grappleRadius, bodies, nb, -1, scan);
      let lx = ex - dx * (UNIT_RADIUS + 0.2);
      let lz = ez - dz * (UNIT_RADIUS + 0.2);
      if (scan.first >= 0 && bodies[scan.first].kind !== K_RUNE) {
        const B = bodies[scan.first];
        lx = B.x - dx * (UNIT_RADIUS * 2 + 0.1);
        lz = B.z - dz * (UNIT_RADIUS * 2 + 0.1);
      }
      if (sim.world.channel(lx, lz) > -0.35 || !moversClear(sim, u.x, u.z, ex, ez, 0.9)) continue;
      const score = d + (side === u.team ? 0 : 6);
      if (score < best) {
        best = score;
        out.x = ox;
        out.z = oz;
      }
    }
  }
  return Number.isFinite(best);
}

/** Drowning: swim for the nearest land, grapple out if that will not be enough. */
export function escapeWater(sim: GameSim, ctx: BotContext, u: Unit, b: Brain, input: PlayerInput): void {
  const g = sim.world.channelGradient(u.x, u.z);
  input.mx = g.nx;
  input.mz = g.nz;
  if (sim.phase !== 'playing' || !canCast(u, 'grapple')) return;
  if (sim.time - b.drownSeen < b.tune.reaction * 0.6) return; // splash! where am I?
  if (b.panicked) return; // some bots just flail
  const left = BAL.drownTime - u.drownT;
  const depth = sim.world.channel(u.x, u.z);
  if (depth < BAL.moveSpeed * BAL.swimSpeed * left * 0.75) return; // we can swim out
  // an ally already throwing a save? trust them for a moment
  for (const h of sim.hooks) {
    if (h.kind === HookKind.Hook && h.phase === HookPhase.Out) {
      const o = sim.unitById.get(h.owner);
      if (o && o.team === u.team && o.id !== u.id && left > 0.7) {
        const rx = u.x - h.x;
        const rz = u.z - h.z;
        if (rx * h.dx + rz * h.dz > 0 && Math.abs(rx * h.dz - rz * h.dx) < 1.3) return;
      }
    }
  }
  if (!findAnchor(sim, ctx, u, b, -1, p2)) return;
  press(input, Btn.Grapple, p2.x, p2.z);
  b.stats.grappleEscapes++;
}

/**
 * Wading when the water is about to turn deep and we will not make it to dry ground on foot (knocked
 * or dragged out into a wide lagoon): grapple to anything that lands us on dry ground, now.
 */
export function thinkGrappleOut(sim: GameSim, ctx: BotContext, u: Unit, b: Brain): void {
  if (b.intent || sim.river.deep || sim.phase !== 'playing' || !canCast(u, 'grapple')) return;
  if (ctx.untilDeep > 3.2 || sim.world.channel(u.x, u.z) <= -0.1) return;
  const mul = sim.river.shallow ? BAL.shallowSlow : sim.river.frozen ? 0.8 : BAL.mudSlow;
  const eta = (dist(u.x, u.z, b.goalX, b.goalZ) + 0.4) / (BAL.moveSpeed * mul);
  if (ctx.untilDeep > eta + 0.25 + b.tune.tideMargin * 0.2) return;
  if (!findAnchor(sim, ctx, u, b, -1, p2)) return;
  b.intent = makeIntent(b, 'grapple', 3, -1, p2.x, p2.z, sim.time + b.tune.decide * 0.5, 1, 0);
  b.intent.purpose = 0;
  b.stats.grappleEscapes++;
}

/** Stranded on the far bank in deep water: grapple home when the way is clear. */
export function thinkGrappleHome(sim: GameSim, ctx: BotContext, u: Unit, b: Brain): void {
  if (b.intent || !canCast(u, 'grapple') || sim.phase !== 'playing' || !sim.river.deep) return;
  if ((bankOf(sim, u.x, u.z) === u.team && b.mode !== Mode.Stranded) || sim.world.channel(u.x, u.z) > 0) return;
  if (!findAnchor(sim, ctx, u, b, u.team, p2)) return;
  b.intent = makeIntent(b, 'grapple', 3, -1, p2.x, p2.z, sim.time + b.tune.decide, 1, 0);
  b.intent.purpose = 2;
}

export function sideSign(u: Unit): number {
  return sideOf(u.team);
}

/** Whether any visible enemy could shove us into the water right now (close, on our bank). */
export function enemyAdjacent(ctx: BotContext, u: Unit, r: number): Unit | null {
  let best: Unit | null = null;
  let bd = r * r;
  for (const e of ctx.foes[u.team]) {
    const d2v = dist2(u.x, u.z, e.x, e.z);
    if (d2v < bd) {
      bd = d2v;
      best = e;
    }
  }
  return best;
}

export const FLAG_STEALTH = UFlag.Stealth;
