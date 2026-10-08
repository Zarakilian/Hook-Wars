// Bot roles and per-difficulty tuning. Roles are assigned deterministically from the team line-up,
// so the same match seed always produces the same squad (handy for tests and replays).
import { BOT_TUNING, TICK_RATE } from '../../constants.ts';
import type { BotDifficulty } from '../../types.ts';
import type { Unit } from '../entities.ts';
import type { BotRole, RoleDef, Tuning } from './types.ts';

export const ROLES: Record<BotRole, RoleDef> = {
  harpooner: {
    id: 'harpooner',
    name: 'Harpooner',
    edgeReady: 0.35,
    edgeRetreat: 4.5,
    aggression: 0.25,
    saveBias: 1,
    runeBias: 1,
    bashBias: 0.6,
    build: [
      'range', 'speed', 'sinker', 'damage', 'range', 'speed', 'wellies', 'damage', 'range', 'width', 'ricochet', 'speed',
      'damage', 'range', 'width', 'damage', 'speed', 'width', 'range', 'damage', 'width', 'speed', 'width',
    ],
    buildDry: [
      'range', 'speed', 'wellies', 'damage', 'sinker', 'range', 'speed', 'damage', 'width', 'range', 'ricochet', 'speed',
      'damage', 'range', 'width', 'damage', 'speed', 'width', 'range', 'damage', 'width', 'speed', 'width',
    ],
    restock: ['pie'],
  },
  bruiser: {
    id: 'bruiser',
    name: 'Bruiser',
    edgeReady: 0.3,
    edgeRetreat: 3,
    aggression: 0.9,
    saveBias: 0.7,
    runeBias: 0.8,
    bashBias: 1.4,
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
  lifeguard: {
    id: 'lifeguard',
    name: 'Lifeguard',
    edgeReady: 0.8,
    edgeRetreat: 4,
    aggression: 0.35,
    saveBias: 1.6,
    runeBias: 1.5,
    bashBias: 0.8,
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

const ROLE_ORDER: readonly BotRole[] = ['harpooner', 'bruiser', 'lifeguard', 'harpooner', 'bruiser'];

/**
 * Role for a bot: rank it among its team's bots by spawn slot. A lone bot is always the generalist
 * Harpooner; bigger squads get a Bruiser and a Lifeguard next.
 */
export function assignRole(units: readonly Unit[], u: Unit): BotRole {
  let rank = 0;
  for (const o of units) {
    if (o === u || !o.isBot || o.team !== u.team) continue;
    if (o.spawnIndex < u.spawnIndex || (o.spawnIndex === u.spawnIndex && o.id < u.id)) rank++;
  }
  return ROLE_ORDER[rank % ROLE_ORDER.length];
}

interface DiffExtra {
  throwBar: number;
  hesitate: number;
  planHz: number;
  bankShots: number;
  bankShotEvery: number;
  tricks: boolean;
  juke: number;
  tideMargin: number;
  shopEvery: number;
  comboDelay: number;
  perceive: number; // fraction of the reaction time spent as perception lag
}

const EXTRA: Record<BotDifficulty, DiffExtra> = {
  easy: { throwBar: 0.17, hesitate: 0.25, planHz: 2.5, bankShots: 0, bankShotEvery: 99, tricks: false, juke: 0.1, tideMargin: 2.6, shopEvery: 4, comboDelay: 0.32, perceive: 0.5 },
  normal: { throwBar: 0.27, hesitate: 0.12, planHz: 3.5, bankShots: 1, bankShotEvery: 1.2, tricks: false, juke: 0.4, tideMargin: 2.1, shopEvery: 2, comboDelay: 0.16, perceive: 0.45 },
  hard: { throwBar: 0.34, hesitate: 0.05, planHz: 5, bankShots: 2, bankShotEvery: 0.6, tricks: true, juke: 0.7, tideMargin: 1.6, shopEvery: 1, comboDelay: 0.07, perceive: 0.42 },
  brutal: { throwBar: 0.38, hesitate: 0.02, planHz: 7, bankShots: 2, bankShotEvery: 0.4, tricks: true, juke: 0.9, tideMargin: 1.3, shopEvery: 0.5, comboDelay: 0.03, perceive: 0.4 },
};

const cache = new Map<BotDifficulty, Tuning>();

export function tuningFor(d: BotDifficulty): Tuning {
  const hit = cache.get(d);
  if (hit) return hit;
  const b = BOT_TUNING[d] ?? BOT_TUNING.normal;
  const x = EXTRA[d] ?? EXTRA.normal;
  const t: Tuning = {
    reaction: b.reaction,
    aimError: b.aimError,
    leadSkill: b.leadSkill,
    dodge: b.dodge,
    thinkHz: b.thinkHz,
    perceiveTicks: Math.max(1, Math.round(b.reaction * x.perceive * TICK_RATE)),
    throwBar: x.throwBar,
    hesitate: x.hesitate,
    planHz: x.planHz,
    bankShots: x.bankShots,
    bankShotEvery: x.bankShotEvery,
    tricks: x.tricks,
    juke: x.juke,
    tideMargin: x.tideMargin,
    shopEvery: x.shopEvery,
    comboDelay: x.comboDelay,
  };
  cache.set(d, t);
  return t;
}
