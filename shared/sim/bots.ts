// Bot brains. Bots act only through PlayerInput (same path as humans) plus shop calls.
// They respect stealth (only see what their team sees) and react with human-like delays.
import { BAL, BOT_TUNING, HOOK_LEVELS, UNIT_RADIUS } from '../constants.ts';
import { dist, dist2, hash01 } from '../math.ts';
import { Btn, BTN_ITEM, HookKind, HookPhase, UnitState, type ItemId, type PlayerInput, type UpgradeStat } from '../types.ts';
import type { Unit } from './entities.ts';
import type { GameSim } from './sim.ts';

interface Brain {
  nextThink: number;
  mx: number;
  mz: number;
  ax: number;
  az: number;
  pending: { kind: 'hook' | 'grapple' | 'bash'; at: number; target: number } | null;
  strafe: number;
  strafeT: number;
  prefBack: number;
  buildIdx: number;
  build: (ItemId | UpgradeStat)[];
  dodged: Set<number>;
  dodgeT: number;
  dodgeX: number;
  dodgeZ: number;
  seq: number;
}

const BUILDS: (ItemId | UpgradeStat)[][] = [
  ['range', 'damage', 'speed', 'sinker', 'wellies', 'damage', 'range', 'pie', 'width', 'ricochet', 'damage', 'irongut', 'speed', 'range', 'ember'],
  ['damage', 'speed', 'range', 'wellies', 'pie', 'damage', 'width', 'ember', 'range', 'speed', 'irongut', 'damage', 'sinker', 'range'],
  ['speed', 'range', 'width', 'ricochet', 'damage', 'mine', 'range', 'damage', 'wellies', 'speed', 'sinker', 'damage', 'irongut'],
];

function brainOf(sim: GameSim, u: Unit): Brain {
  if (!u.brain) {
    const h = hash01(u.id, sim.seed);
    const b: Brain = {
      nextThink: 0, mx: 0, mz: 0, ax: u.x, az: u.z, pending: null,
      strafe: h > 0.5 ? 1 : -1, strafeT: 0, prefBack: 0.3 + h * 2.6,
      buildIdx: 0, build: BUILDS[Math.floor(h * BUILDS.length) % BUILDS.length],
      dodged: new Set(), dodgeT: 0, dodgeX: 0, dodgeZ: 0, seq: 0,
    };
    u.brain = b;
  }
  return u.brain as Brain;
}

export function updateBots(sim: GameSim): void {
  for (const u of sim.units) {
    if (!u.isBot) continue;
    const b = brainOf(sim, u);
    shop(sim, u, b);
    const input: PlayerInput = { seq: ++b.seq, mx: 0, mz: 0, ax: b.ax, az: b.az, b: 0 };
    if (u.state !== UnitState.Dead && sim.phase !== 'ended') think(sim, u, b, input);
    u.queue.length = 0;
    u.queue.push(input);
  }
}

function shop(sim: GameSim, u: Unit, b: Brain): void {
  if (sim.tick % 15 !== (u.id % 15)) return;
  const next = b.build[b.buildIdx];
  if (!next) return;
  const ok = next === 'damage' || next === 'range' || next === 'speed' || next === 'width' ? sim.upgrade(u.id, next) : sim.buy(u.id, next as ItemId);
  if (ok) b.buildIdx++;
  else if (next !== 'damage' && next !== 'range' && next !== 'speed' && next !== 'width') {
    // item could not be bought (slots full or owned): skip it once we can afford it
    const freeSlots = u.items.filter((s) => s === null).length;
    if (freeSlots === 0) b.buildIdx++;
  }
}

function think(sim: GameSim, u: Unit, b: Brain, input: PlayerInput): void {
  const tune = BOT_TUNING[u.botDifficulty];
  const t = sim.time;
  const range = HOOK_LEVELS.range[u.up.range];
  const speed = HOOK_LEVELS.speed[u.up.speed];
  const width = HOOK_LEVELS.width[u.up.width];
  const side = u.team === 0 ? -1 : 1;

  // --- Movement intent (re-planned at thinkHz) ---
  if (t >= b.nextThink) {
    b.nextThink = t + 1 / tune.thinkHz;
    b.strafeT -= 1 / tune.thinkHz;
    if (b.strafeT <= 0) {
      b.strafe = -b.strafe;
      b.strafeT = 1.2 + hash01(u.id, sim.tick) * 2.5;
    }
    const c = sim.world.riverCenter(u.z);
    const edgeX = c.x + side * c.hw;
    let goalX = edgeX + side * (UNIT_RADIUS + 0.9 + b.prefBack);
    let goalZ = u.z + b.strafe * 4;
    const lowHp = u.hp < u.maxHp * 0.3;
    if (lowHp) {
      const f = sim.map.fountains[u.team];
      goalX = f.x;
      goalZ = f.z;
    } else if (!sim.river.deep && !sim.river.shallow && sim.river.phase !== 'rising' && sim.river.phase !== 'cracking' && u.hp > u.maxHp * 0.6) {
      // walkable bed: press forward into the channel
      goalX = c.x + side * 1.5;
    }
    goalZ = Math.max(-sim.map.d / 2 + 3, Math.min(sim.map.d / 2 - 3, goalZ));
    let mx = goalX - u.x;
    let mz = goalZ - u.z;
    const l = Math.hypot(mx, mz);
    if (l > 0.4) {
      mx /= l;
      mz /= l;
    } else mx = mz = 0;
    // drowning: swim to the nearest land
    if (u.state === UnitState.Drowning) {
      const g = sim.world.channelGradient(u.x, u.z);
      mx = g.nx;
      mz = g.nz;
    }
    b.mx = mx;
    b.mz = mz;
  }
  input.mx = b.mx;
  input.mz = b.mz;

  // --- Dodge incoming hooks ---
  if (b.dodgeT > 0) {
    b.dodgeT -= 1 / 30;
    input.mx = b.dodgeX;
    input.mz = b.dodgeZ;
  } else {
    for (const h of sim.hooks) {
      if (h.kind !== HookKind.Hook || h.phase !== HookPhase.Out || b.dodged.has(h.id)) continue;
      const o = sim.unitById.get(h.owner);
      if (!o || o.team === u.team) continue;
      const rx = u.x - h.x;
      const rz = u.z - h.z;
      const along = rx * h.dx + rz * h.dz;
      if (along <= 0) continue;
      const perp = Math.abs(rx * h.dz - rz * h.dx);
      if (perp > h.r + UNIT_RADIUS + 0.4) continue;
      const tti = along / h.speed;
      if (tti > 0.6) continue;
      b.dodged.add(h.id);
      if (hash01(h.id, u.id, sim.seed) < tune.dodge) {
        const s = rx * h.dz - rz * h.dx >= 0 ? 1 : -1;
        b.dodgeX = h.dz * s;
        b.dodgeZ = -h.dx * s;
        b.dodgeT = 0.35;
      }
    }
    if (b.dodged.size > 64) b.dodged.clear();
  }

  // --- Abilities ---
  if (sim.phase !== 'playing') return;
  const enemies = sim.units.filter((e) => e.team !== u.team && e.state !== UnitState.Dead && sim.visibleTo(e, u.team) && e.spawnProt <= 0);

  // Drowning: try to grapple out
  if (u.state === UnitState.Drowning && u.cdGrapple <= 0) {
    const anchor = nearestObstacleOnLand(sim, u);
    if (anchor) press(input, Btn.Grapple, anchor.x, anchor.z, b);
    return;
  }

  if (b.pending && t >= b.pending.at) {
    const p = b.pending;
    b.pending = null;
    const target = sim.unitById.get(p.target);
    if (p.kind === 'hook' && target && target.state !== UnitState.Dead) {
      const aim = leadAim(u, target, speed, tune.leadSkill, tune.aimError, sim.tick);
      press(input, Btn.Hook, aim.x, aim.z, b);
    } else if (p.kind === 'bash' && target) press(input, Btn.Bash, target.x, target.z, b);
    return;
  }
  if (b.pending) return;

  // Save a drowning ally
  if (u.cdHook <= 0 && u.activeHook < 0) {
    for (const a of sim.units) {
      if (a.team !== u.team || a.id === u.id || a.state !== UnitState.Drowning) continue;
      if (dist(u.x, u.z, a.x, a.z) < range && sim.world.lineClear(u.x, u.z, a.x, a.z, width)) {
        press(input, Btn.Hook, a.x, a.z, b);
        return;
      }
    }
  }

  // Bash anyone in our face
  if (u.cdBash <= 0) {
    for (const e of enemies) {
      if (dist2(u.x, u.z, e.x, e.z) < (BAL.bashRange + 0.3) ** 2 && e.state !== UnitState.Hooked) {
        b.pending = { kind: 'bash', at: t + tune.reaction * 0.5, target: e.id };
        return;
      }
    }
  }

  // Hook: best visible target in range with a clear line
  if (u.cdHook <= 0 && u.activeHook < 0 && u.state === UnitState.Alive) {
    let best: Unit | null = null;
    let bestScore = -1e9;
    for (const e of enemies) {
      const d = dist(u.x, u.z, e.x, e.z);
      if (d > range + 1) continue;
      if (!sim.world.lineClear(u.x, u.z, e.x, e.z, width * 0.8)) continue;
      const score = -d + (1 - e.hp / e.maxHp) * 8 + (e.state === UnitState.Casting ? 3 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    if (best) {
      b.pending = { kind: 'hook', at: t + tune.reaction * (0.6 + hash01(u.id, sim.tick) * 0.8), target: best.id };
      return;
    }
    // Rune within reach
    for (const r of sim.runes) {
      if (r.dragged) continue;
      if (dist(u.x, u.z, r.x, r.z) < range && sim.world.lineClear(u.x, u.z, r.x, r.z, width)) {
        press(input, Btn.Hook, r.x, r.z, b);
        return;
      }
    }
  }

  // Low health: eat a pie
  if (u.hp < u.maxHp * 0.5 && u.pieT <= 0 && t - u.lastDamageT > 1.5) {
    const i = u.items.findIndex((s) => s && s.id === 'pie');
    if (i >= 0) input.b |= BTN_ITEM[i];
  }
  // Mines: drop one near the bank now and then
  const mi = u.items.findIndex((s) => s && s.id === 'mine');
  if (mi >= 0 && hash01(u.id, sim.tick, 3) < 0.004) input.b |= BTN_ITEM[mi];
}

function press(input: PlayerInput, btn: number, ax: number, az: number, b: Brain): void {
  input.b |= btn;
  input.ax = ax;
  input.az = az;
  b.ax = ax;
  b.az = az;
}

function leadAim(u: Unit, t: Unit, speed: number, skill: number, err: number, salt: number): { x: number; z: number } {
  const d = dist(u.x, u.z, t.x, t.z);
  const tt = d / speed + BAL.hookWindup;
  let x = t.x + t.vx * tt * skill;
  let z = t.z + t.vz * tt * skill;
  const ang = (hash01(u.id, salt, 9) - 0.5) * 2 * err;
  const dx = x - u.x;
  const dz = z - u.z;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  x = u.x + dx * c - dz * s;
  z = u.z + dx * s + dz * c;
  return { x, z };
}

function nearestObstacleOnLand(sim: GameSim, u: Unit): { x: number; z: number } | null {
  let best: { x: number; z: number } | null = null;
  let bd = BAL.grappleRange * BAL.grappleRange;
  for (const o of sim.world.obstacles) {
    const x = o.shape === 'circle' ? o.x : (o.ax + o.bx) / 2;
    const z = o.shape === 'circle' ? o.z : (o.az + o.bz) / 2;
    const d2 = dist2(u.x, u.z, x, z);
    if (d2 < bd) {
      bd = d2;
      best = { x, z };
    }
  }
  return best;
}
