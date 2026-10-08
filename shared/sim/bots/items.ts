// Shopping and consumables. Bots buy through sim.buy / sim.upgrade, the same calls the shop UI uses,
// and use items by pressing item buttons in their PlayerInput.
import { BAL, ITEMS, MAX_UPGRADE, UPGRADE_COST } from '../../constants.ts';
import { dist, dist2 } from '../../math.ts';
import { BTN_ITEM, UnitState, UPGRADE_STATS, type ItemId, type PlayerInput, type UpgradeStat } from '../../types.ts';
import type { Unit } from '../entities.ts';
import type { GameSim } from '../sim.ts';
import type { BotContext, Seen } from './context.ts';
import { bankOf, waterDir, type P2 } from './geom.ts';
import { Mode, type Brain, type BuildStep } from './types.ts';

const wd: P2 = { x: 0, z: 0 };
const seen: Seen = { x: 0, z: 0, vx: 0, vz: 0 };

function isUpgrade(s: BuildStep): s is UpgradeStat {
  return s === 'damage' || s === 'range' || s === 'speed' || s === 'width';
}

function slotOf(u: Unit, id: ItemId): number {
  for (let i = 0; i < 4; i++) {
    const s = u.items[i];
    if (s && s.id === id && s.charges > 0) return i;
  }
  return -1;
}

/** Walk the role's build list, then keep consumables stocked and finish the upgrades. */
export function shop(sim: GameSim, u: Unit, b: Brain): void {
  if (sim.phase === 'ended' || sim.time < b.nextShop) return;
  b.nextShop = sim.time + b.tune.shopEvery * (0.7 + 0.6 * b.rng.next());
  for (let guard = 0; guard < 6; guard++) {
    const step = b.build[b.buildIdx];
    if (step === undefined) break;
    if (isUpgrade(step)) {
      if (u.up[step] >= MAX_UPGRADE) {
        b.buildIdx++;
        continue;
      }
      if (sim.upgrade(u.id, step)) {
        b.buildIdx++;
        continue;
      }
      return; // saving up
    }
    const def = ITEMS[step];
    const owned = u.items.find((s) => s && s.id === step);
    const free = u.items.indexOf(null) >= 0;
    if ((owned && (!def.consumable || owned.charges >= def.maxCharges)) || (!owned && !free)) {
      b.buildIdx++;
      continue;
    }
    if (sim.buy(u.id, step)) {
      b.buildIdx++;
      continue;
    }
    return;
  }
  // build done (or skipped): restock, then any upgrade still missing
  for (const id of b.roleDef.restock) {
    const def = ITEMS[id];
    const owned = u.items.find((s) => s && s.id === id);
    if (owned ? owned.charges < Math.max(1, def.maxCharges >> 1) : u.items.indexOf(null) >= 0) {
      if (u.gold >= def.cost + 150 && sim.buy(u.id, id)) return;
    }
  }
  if (b.buildIdx >= b.build.length) {
    let best: UpgradeStat | null = null;
    let cost = Infinity;
    for (const s of UPGRADE_STATS) {
      const lvl = u.up[s];
      if (lvl < MAX_UPGRADE && UPGRADE_COST[lvl] < cost) {
        cost = UPGRADE_COST[lvl];
        best = s;
      }
    }
    if (best) sim.upgrade(u.id, best);
  }
}

/** Pies when hurt and safe, puffballs to escape (or to sneak up), mines on approach paths. */
export function useItems(sim: GameSim, ctx: BotContext, u: Unit, b: Brain, input: PlayerInput): void {
  const t = sim.time;
  if (sim.phase !== 'playing' || t < b.itemCdUntil || u.state !== UnitState.Alive) return;
  const foes = ctx.foes[u.team];
  let near = Infinity;
  for (const e of foes) near = Math.min(near, dist(u.x, u.z, e.x, e.z));
  const f = sim.map.fountains[u.team];
  const inFountain = dist2(u.x, u.z, f.x, f.z) < f.r * f.r;

  // Healing Pie: only when nobody is hitting us (damage spoils it)
  const pie = slotOf(u, 'pie');
  if (pie >= 0 && u.pieT <= 0 && !inFountain && u.hp < u.maxHp * 0.55 && t - u.lastDamageT > 1.2) {
    input.b |= BTN_ITEM[pie];
    b.itemCdUntil = t + 1;
    return;
  }

  // Puffball: vanish when caught low, or (tricks) sneak up to the bank edge for an ambush throw
  const puff = slotOf(u, 'puffball');
  if (puff >= 0 && u.puff <= 0 && u.ghost <= 0) {
    const stranded = b.mode === Mode.Stranded;
    const escape = (u.hp < u.maxHp * 0.3 && near < 8) || (stranded && near < 6 && u.hp < u.maxHp * 0.6);
    const ambush = b.tune.tricks && b.mode === Mode.Hold && u.cdHook <= 0.3 && u.activeHook < 0 && b.exposed > 0
      && dist(u.x, u.z, b.goalX, b.goalZ) > 2.5 && b.rng.next() < 0.25;
    if (escape || ambush) {
      input.b |= BTN_ITEM[puff];
      b.itemCdUntil = t + (escape ? 2 : 8);
      return;
    }
  }

  // Bramble Mine
  const mine = slotOf(u, 'mine');
  if (mine < 0 || t - b.lastMineT < 6) return;
  const ch = sim.world.channel(u.x, u.z);
  if (sim.river.deep) {
    // Trap: drop one just riverward of our bank spot, right where hooked enemies get delivered.
    if (b.tune.tricks && b.mode === Mode.Hold && t - b.lastMineT > 18 && ch < -1.2 && ch > -3.6
      && dist(u.x, u.z, b.goalX, b.goalZ) < 0.7 && bankOf(sim, u.x, u.z) === u.team && !ownMineNear(sim, u, 2.5)) {
      b.trapUntil = t + 0.5;
      b.lastMineT = t;
    }
    return;
  }
  // Walkable bed: plant one on the path of an enemy who is coming at us, or behind us while we run.
  for (const e of foes) {
    if (!ctx.perceive(e, u.team, b.tune.perceiveTicks, seen)) continue;
    const d = dist(u.x, u.z, seen.x, seen.z);
    if (d > 9 || d < 2.5) continue;
    const closing = (seen.vx * (u.x - seen.x) + seen.vz * (u.z - seen.z)) / d > 2;
    if (closing && (b.retreating || bankOf(sim, u.x, u.z) === u.team) && !ownMineNear(sim, u, 3)) {
      input.b |= BTN_ITEM[mine];
      b.lastMineT = t;
      b.itemCdUntil = t + 0.5;
      return;
    }
  }
}

function ownMineNear(sim: GameSim, u: Unit, r: number): boolean {
  for (const m of sim.mines) if (m.owner === u.id && dist2(m.x, m.z, u.x, u.z) < r * r) return true;
  return false;
}

/**
 * Mine trap in progress: take a step away from the river so we face inland, then drop the mine
 * (it lands behind us, on the river side). Returns true while it controls movement.
 */
export function trapStep(sim: GameSim, u: Unit, b: Brain, input: PlayerInput): boolean {
  const t = sim.time;
  if (t >= b.trapUntil) return false;
  waterDir(sim, u.x, u.z, wd);
  input.mx = -wd.x;
  input.mz = -wd.z;
  const fx = Math.sin(u.face);
  const fz = Math.cos(u.face);
  if (fx * -wd.x + fz * -wd.z > 0.75 && u.state === UnitState.Alive) {
    const mine = slotOf(u, 'mine');
    if (mine >= 0) input.b |= BTN_ITEM[mine];
    b.trapUntil = 0;
    b.itemCdUntil = t + 0.5;
    input.mx = 0;
    input.mz = 0;
  }
  return true;
}

export const MINE_REACH = BAL.mineRadius;
