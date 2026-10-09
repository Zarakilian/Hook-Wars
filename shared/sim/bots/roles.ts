// Bot roles and per-difficulty tuning. Roles are assigned deterministically from the team line-up,
// so the same match seed always produces the same squad (handy for tests and replays).
import { BOT_TUNING, TICK_RATE } from '../../constants.ts';
import type { BotDifficulty } from '../../types.ts';
import type { Unit } from '../entities.ts';
import type { GameSim } from '../sim.ts';
import type { BotRole, RoleDef, Tuning } from './types.ts';

export const ROLES: Record<BotRole, RoleDef> = {
  // Long-range hooker: holds the bank, picks shots, buys range and the Lucky Sinker.
  harpooner: {
    id: 'harpooner',
    name: 'Harpooner',
    standReady: 2.1,
    standWait: 5.5,
    aggression: 0.25,
    saveBias: 1,
    runeBias: 1,
    bashBias: 0.8,
    retreatHp: 0.33,
    build: [
      'range', 'speed', 'sinker', 'damage', 'range', 'speed', 'wellies', 'damage', 'range', 'width', 'ricochet', 'speed',
      'damage', 'range', 'width', 'damage', 'speed', 'width', 'range', 'damage', 'width', 'speed', 'width', 'pie',
    ],
    buildDry: [
      'range', 'speed', 'wellies', 'damage', 'sinker', 'range', 'speed', 'damage', 'width', 'range', 'ricochet', 'speed',
      'damage', 'range', 'width', 'damage', 'speed', 'width', 'range', 'damage', 'width', 'speed', 'width', 'pie',
    ],
    restock: ['pie'],
  },
  // Aggressive basher: tanky, presses across a walkable bed, grapples in to shove people into the river.
  bruiser: {
    id: 'bruiser',
    name: 'Bruiser',
    standReady: 2.25,
    standWait: 4,
    aggression: 0.9,
    saveBias: 0.7,
    runeBias: 0.8,
    bashBias: 1.4,
    retreatHp: 0.22,
    build: [
      'damage', 'irongut', 'mine', 'speed', 'wellies', 'damage', 'range', 'ember', 'damage', 'speed', 'width', 'range',
      'damage', 'speed', 'width', 'range', 'damage', 'width', 'speed', 'range', 'width', 'speed', 'range',
    ],
    buildDry: [
      'wellies', 'damage', 'irongut', 'mine', 'speed', 'damage', 'ember', 'range', 'damage', 'speed', 'width', 'range',
      'damage', 'speed', 'width', 'range', 'damage', 'width', 'speed', 'range', 'width', 'speed', 'range',
    ],
    restock: ['mine'],
  },
  // Support: saves drowning and dragged allies, grabs runes, carries pies and a puffball.
  lifeguard: {
    id: 'lifeguard',
    name: 'Lifeguard',
    standReady: 2.5,
    standWait: 5,
    aggression: 0.35,
    saveBias: 1.7,
    runeBias: 1.5,
    bashBias: 0.9,
    retreatHp: 0.35,
    build: [
      'speed', 'width', 'pie', 'range', 'puffball', 'speed', 'wellies', 'width', 'range', 'irongut', 'damage', 'speed',
      'width', 'range', 'damage', 'speed', 'width', 'range', 'damage', 'speed', 'range', 'damage', 'damage',
    ],
    buildDry: [
      'speed', 'width', 'wellies', 'pie', 'range', 'puffball', 'speed', 'width', 'range', 'irongut', 'damage', 'speed',
      'width', 'range', 'damage', 'speed', 'width', 'range', 'damage', 'speed', 'range', 'damage', 'damage',
    ],
    restock: ['pie', 'puffball'],
  },
};

/** A full 6-bot squad is two of each role; 5v5 keeps its 2 Harpooners, 2 Bruisers and 1 Lifeguard. */
const ROLE_ORDER: readonly BotRole[] = ['harpooner', 'bruiser', 'lifeguard', 'harpooner', 'bruiser', 'lifeguard'];

/**
 * Where a unit's spawn point stands along its own bank: z for team 0, mirrored for team 1 (whose spawn
 * list is team 0's point mirror). Lanes and roles both go in this order, so team 1 plays team 0's
 * game mirrored, and nobody walks across a teammate's path from the fountain to the river.
 */
export function bankOrder(sim: GameSim, u: Unit): number {
  return (u.team === 0 ? 1 : -1) * sim.spawnPoint(u.team, u.spawnIndex).z;
}

/** a comes before b along their bank (spawn points level in z, the 6th and the middle one, go by slot) */
export function bankBefore(sim: GameSim, a: Unit, b: Unit): boolean {
  const ka = bankOrder(sim, a);
  const kb = bankOrder(sim, b);
  return ka < kb || (ka === kb && (a.spawnIndex < b.spawnIndex || (a.spawnIndex === b.spawnIndex && a.id < b.id)));
}

/**
 * Role for a bot: rank it among its team's bots along the bank (the lane order). A lone bot is always
 * the generalist Harpooner; bigger squads get a Bruiser and a Lifeguard next, so the roles alternate
 * along the bank. Up to 5v5 this is the spawn slot order; the 6th spawn stands mid-bank.
 */
export function assignRole(sim: GameSim, u: Unit): BotRole {
  let rank = 0;
  for (const o of sim.units) {
    if (o === u || !o.isBot || o.team !== u.team) continue;
    if (bankBefore(sim, o, u)) rank++;
  }
  return ROLE_ORDER[rank % ROLE_ORDER.length];
}

interface DiffExtra {
  throwBar: number;
  patience: number;
  hesitate: number;
  planHz: number;
  bankShots: number;
  bankShotEvery: number;
  tricks: boolean;
  dives: number;
  juke: number;
  tideMargin: number;
  shopEvery: number;
  comboDelay: number;
  fumble: number;
  escape: number;
  perceive: number; // fraction of the reaction time spent as perception lag
  dodgeReact: number; // fraction of the reaction time before an incoming hook is noticed
  steal: boolean;
  predodge: boolean;
}

const EXTRA: Record<BotDifficulty, DiffExtra> = {
  easy: {
    throwBar: 0.25, patience: 2.5, hesitate: 0.3, planHz: 2, bankShots: 0, bankShotEvery: 99, tricks: false, dives: 0, juke: 0.1,
    tideMargin: 2.6, shopEvery: 4, comboDelay: 0.3, fumble: 0.4, escape: 0.45, perceive: 0.5, dodgeReact: 0.8, steal: false, predodge: false,
  },
  normal: {
    throwBar: 0.4, patience: 3, hesitate: 0.12, planHz: 3, bankShots: 1, bankShotEvery: 1.4, tricks: false, dives: 0.15, juke: 0.4,
    tideMargin: 2.1, shopEvery: 2, comboDelay: 0.15, fumble: 0.15, escape: 0.7, perceive: 0.45, dodgeReact: 0.75, steal: false, predodge: false,
  },
  hard: {
    throwBar: 0.55, patience: 4, hesitate: 0.05, planHz: 4.5, bankShots: 2, bankShotEvery: 0.8, tricks: true, dives: 0.35, juke: 0.7,
    tideMargin: 1.6, shopEvery: 1, comboDelay: 0.08, fumble: 0.05, escape: 0.9, perceive: 0.42, dodgeReact: 0.7, steal: true, predodge: true,
  },
  brutal: {
    throwBar: 0.65, patience: 5, hesitate: 0.02, planHz: 6, bankShots: 2, bankShotEvery: 0.5, tricks: true, dives: 0.5, juke: 0.9,
    tideMargin: 1.3, shopEvery: 0.5, comboDelay: 0.05, fumble: 0, escape: 1, perceive: 0.4, dodgeReact: 0.7, steal: true, predodge: true,
  },
};

const cache = new Map<BotDifficulty, Tuning>();

export function tuningFor(d: BotDifficulty): Tuning {
  const hit = cache.get(d);
  if (hit) return hit;
  const b = BOT_TUNING[d] ?? BOT_TUNING.normal;
  const x = EXTRA[d] ?? EXTRA.normal;
  const perceiveTicks = Math.max(1, Math.round(b.reaction * x.perceive * TICK_RATE));
  const t: Tuning = {
    reaction: b.reaction,
    aimError: b.aimError,
    leadSkill: b.leadSkill,
    dodge: b.dodge,
    thinkHz: b.thinkHz,
    perceiveTicks,
    decide: Math.max(0, b.reaction - perceiveTicks / TICK_RATE),
    dodgeReact: b.reaction * x.dodgeReact,
    throwBar: x.throwBar,
    patience: x.patience,
    hesitate: x.hesitate,
    planHz: x.planHz,
    bankShots: x.bankShots,
    bankShotEvery: x.bankShotEvery,
    tricks: x.tricks,
    dives: x.dives,
    juke: x.juke,
    tideMargin: x.tideMargin,
    shopEvery: x.shopEvery,
    comboDelay: x.comboDelay,
    fumble: x.fumble,
    escape: x.escape,
    steal: x.steal,
    predodge: x.predodge,
  };
  cache.set(d, t);
  return t;
}
