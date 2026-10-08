// Bot combat: picking hook shots (enemies, ally saves, runes), aiming them through the wind-up,
// the hook-then-bash combo, close-range bashes, and grappling out of the water.
// Everything is decided from what the bot's team can see, with the bot's own perception delay.
import { BAL, HOOK_LEVELS, TICK_DT, UNIT_RADIUS } from '../../constants.ts';
import { dist, dist2 } from '../../math.ts';
import { Btn, HookKind, HookPhase, UFlag, UnitState, type PlayerInput, type RuneType } from '../../types.ts';
import type { Hook, Unit } from '../entities.ts';
import type { GameSim } from '../sim.ts';
import { HookPath, intercept, scanPath, traceHook, type Body, type Intercept, type ScanResult } from './aim.ts';
import type { BotContext, Seen } from './context.ts';
import { bankOf, bestBash, bestComboBash, moversClear, sideOf, type BashAim, type P2 } from './geom.ts';
import { hookLineClear } from './mapinfo.ts';
import type { Brain, Intent, TargetKind } from './types.ts';

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

/** Hook stats of a unit (its own, exact: it is the bot's own kit). */
function hookSpeed(u: Unit): number {
  return HOOK_LEVELS.speed[u.up.speed];
}
function hookWidth(u: Unit): number {
  return HOOK_LEVELS.width[u.up.width];
}
function hookRange(u: Unit): number {
  return HOOK_LEVELS.range[u.up.range];
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
  const speed = hookSpeed(u);
  const hr = hookWidth(u);
  const range = hookRange(u);
  intercept(u.x, u.z, B.x, B.z, B.vx, B.vz, speed, windup, 1, ic);
  if (ic.d > range + BAL.hookHand + hr + B.r - 0.25) return false;
  const ang = Math.atan2(ic.ax - u.x, ic.az - u.z);
  out.ang = ang;
  out.d = ic.d;
  out.bank = false;
  const wp = sim.map.whirlpool;
  const bounces = u.items.some((s) => s && s.id === 'ricochet') ? BAL.ricochetBounces : 0;
  // static prefilter: a wall in the way means no direct shot (bank shots are searched separately)
  if (!hookLineClear(ctx.info, u.x, u.z, ic.ax, ic.az, 0.9, B.r + 0.2)) return false;
  let bend = 0;
  let prevBend = 0;
  let prevMiss = 0;
  for (let it = 0; it < 4; it++) {
    const a = ang + bend;
    const dx = Math.sin(a);
    const dz = Math.cos(a);
    traceHook(sim.world, wp, u.x + dx * BAL.hookHand, u.z + dz * BAL.hookHand, dx, dz, speed, hr, range, bounces, windup, path);
    scanPath(path, hr, bodies, nb, focus, scan);
    if (scan.first >= 0) {
      if (!hitIsGood(focus, scan.first)) return false;
      out.bend = bend;
      out.t = scan.firstT;
      out.first = scan.first;
      return true;
    }
    if (!path.bent || !Number.isFinite(scan.miss)) return false;
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
  return false;
}

/** Search for a bank shot (Ricochet bounces or bouncy posts) at bodies[focus]. */
function solveBank(sim: GameSim, u: Unit, focus: number, windup: number, bouncyOnly: boolean, out: Shot): boolean {
  const B = bodies[focus];
  const speed = hookSpeed(u);
  const hr = hookWidth(u);
  const range = hookRange(u);
  const bounces = bouncyOnly ? 0 : BAL.ricochetBounces;
  const wp = sim.map.whirlpool;
  const base = Math.atan2(B.x - u.x, B.z - u.z);
  let bestT = Infinity;
  let bestA = 0;
  for (let i = -12; i <= 12; i++) {
    if (i === 0) continue;
    const a = base + i * 0.1;
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
  const onEnemySide = bankOf(sim, a.x, a.z) !== u.team && sim.world.channel(a.x, a.z) <= 0;
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

function runeValue(t: RuneType | null): number {
  switch (t) {
    case 'double':
      return 1.5;
    case 'haste':
      return 1.25;
    case 'ironskin':
      return 0.95;
    case 'ghost':
      return 0.85;
    case 'bounty':
      return 0.8;
    default:
      return 0;
  }
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
  const hr = hookWidth(u);
  const role = b.roleDef;
  const canBank = tune.bankShots > 0 && t - b.lastBankSearch >= tune.bankShotEvery
    && (hasItem(u, 'ricochet') || (tune.bankShots > 1 && ctx.info.bouncy));
  let best = -1;
  let bestScore = 0;
  let bestP = 0;
  let bestBend = 0;
  let bestAng = 0;
  let bestBank = false;
  let bankTried = false;
  for (let i = 0; i < nb; i++) {
    const B = bodies[i];
    let v = 0;
    const unit = bodyUnit[i];
    if (B.kind === K_ENEMY && unit) {
      v = enemyValue(sim, ctx, u, b, unit, 0.45);
      if (unit.id === b.diveTarget && t < b.diveUntil) v += 3; // we flew over here for this one
    }
    else if ((B.kind === K_ALLY || B.kind === K_AVOID) && unit) v = allyValue(sim, ctx, u, b, unit, 0.4) * role.saveBias;
    else if (B.kind === K_RUNE) v = ctx.claimedByOther(u.team, B.id, u.id) ? 0 : runeValue(bodyRune[i]) * role.runeBias;
    if (v <= 0.05) continue;
    const reach = hookRange(u) + 2.5;
    if (dist2(u.x, u.z, B.x, B.z) > reach * reach) continue;
    // ally being dragged by an enemy hook counts as K_AVOID for blockers, but it is our focus here
    const kindSave = B.kind;
    if (B.kind === K_AVOID) B.kind = K_ALLY;
    let ok = solveDirect(sim, ctx, u, i, windup, shot);
    let s: Shot = shot;
    if (!ok && canBank && !bankTried && B.kind !== K_RUNE) {
      bankTried = true;
      ok = solveBank(sim, u, i, windup, !hasItem(u, 'ricochet'), bankShot);
      s = bankShot;
    }
    B.kind = kindSave;
    if (!ok) continue;
    let p = hitChance(unit, s.t, hr, B.vx, B.vz);
    if (unit && B.kind !== K_ENEMY) p = Math.min(0.95, p + 0.25); // allies hold still for a save
    if (s.bank) p *= 0.75;
    const score = p * v;
    if (score > bestScore) {
      bestScore = score;
      best = i;
      bestP = p;
      bestBend = s.bend;
      bestAng = s.ang;
      bestBank = s.bank;
    }
  }
  if (bankTried) b.lastBankSearch = t;
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
  if (bestBank) b.intent.purpose = 9; // bank shot: keep the solved angle
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
    let ang: number;
    let bend = 0;
    if (it.purpose === 9) {
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
    const a = ang + bend + err;
    press(input, Btn.Hook, u.x + Math.sin(a) * 8, u.z + Math.cos(a) * 8);
    b.aim = { kind: 'hook', tk: it.tk, id: it.id, x: u.x + Math.sin(a) * 8, z: u.z + Math.cos(a) * 8, err, bend, lead: 1 };
    if (it.purpose === 9) {
      b.aim.tk = 3; // locked angle
      b.stats.bankShots++;
    }
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
  b.holdStill = false;
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

/** Stranded on the far bank in deep water: grapple home when the way is clear. */
export function thinkGrappleHome(sim: GameSim, ctx: BotContext, u: Unit, b: Brain): void {
  if (b.intent || !canCast(u, 'grapple') || sim.phase !== 'playing' || !sim.river.deep) return;
  if (bankOf(sim, u.x, u.z) === u.team || sim.world.channel(u.x, u.z) > 0) return;
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
