// Shared bot types: roles, per-difficulty tuning and the per-unit brain.
// Everything here is plain data so a brain can be created mid-match (controller swaps, joins).
import type { Rng } from '../../math.ts';
import type { BotDifficulty, ItemId, UpgradeStat } from '../../types.ts';

export type BotRole = 'harpooner' | 'bruiser' | 'lifeguard';
export type BuildStep = ItemId | UpgradeStat;

export interface RoleDef {
  id: BotRole;
  name: string;
  /** Metres back from the bank edge while the hook is ready. */
  edgeReady: number;
  /** Preferred metres back from the bank edge while the hook is cooling down. */
  edgeRetreat: number;
  /** 0..1: willingness to cross a walkable bed, dive and brawl. */
  aggression: number;
  /** Multiplier on the value of hooking an ally to safety. */
  saveBias: number;
  /** Multiplier on the value of hooking runes. */
  runeBias: number;
  /** Multiplier on plain melee bash value (bruisers love a shove). */
  bashBias: number;
  build: BuildStep[];
  buildDry: BuildStep[];
  /** Consumables this role keeps topped up once its core build is under way. */
  restock: ItemId[];
}

export interface Tuning {
  // straight from BOT_TUNING
  reaction: number;
  aimError: number;
  leadSkill: number;
  dodge: number;
  thinkHz: number;
  // derived
  /** Perception delay in ticks: the bot sees the world this many ticks late. */
  perceiveTicks: number;
  /** Minimum shot score (hit chance x value) before the bot throws. */
  throwBar: number;
  /** Chance to hesitate when an opportunity appears. */
  hesitate: number;
  /** Positioning re-plans per second. */
  planHz: number;
  /** 0 = never, 1 = only with the Ricochet Spring, 2 = also off bouncy posts. */
  bankShots: number;
  /** Seconds between full bank-shot searches. */
  bankShotEvery: number;
  /** Uses hook baiting, mine traps and dives. */
  tricks: boolean;
  /** 0..1 how jittery the bot is while exposed to a ready enemy hook. */
  juke: number;
  /** Extra seconds of margin before tides turn. */
  tideMargin: number;
  /** Seconds between shop visits. */
  shopEvery: number;
  /** Delay before follow-up combos (bash after a hook lands). */
  comboDelay: number;
}

export type IntentKind = 'hook' | 'bash' | 'grapple';
export type TargetKind = 'enemy' | 'ally' | 'rune' | 'point';

/** A decided action waiting for the bot's reaction delay to pass. */
export interface Intent {
  kind: IntentKind;
  tk: TargetKind;
  id: number;
  x: number;
  z: number;
  at: number;
  value: number;
}

/** Keeps the aim on target through the wind-up (the sim lets the aim track until release). */
export interface AimLock {
  kind: IntentKind;
  tk: TargetKind;
  id: number;
  x: number;
  z: number;
  /** Fixed angular aim error for this shot, radians. */
  err: number;
  /** Extra angle found by the path solver (whirlpool bend, bank shot). */
  bend: number;
  until: number;
}

export interface Brain {
  role: BotRole;
  roleDef: RoleDef;
  diff: BotDifficulty;
  tune: Tuning;
  rng: Rng;
  seq: number;

  nextThink: number;
  nextPlan: number;
  nextShop: number;
  buildIdx: number;

  // positioning
  goalX: number;
  goalZ: number;
  goalScore: number;
  goalKind: number;
  laneZ: number;
  laneRank: number;
  strafe: number;
  strafeUntil: number;
  jukeX: number;
  jukeZ: number;
  jukeUntil: number;
  pauseUntil: number;

  // dodging
  dodgeUntil: number;
  dodgeX: number;
  dodgeZ: number;
  judged: number[]; // recent enemy hook ids already judged (ring)
  judgedHead: number;
  preDodgeUntil: number;

  // actions
  intent: Intent | null;
  aim: AimLock | null;
  hookReadySince: number;
  hesitateUntil: number;
  lastBankSearch: number;
  comboTarget: number;
  comboUntil: number;
  ownHookTarget: number;
  lastHookId: number;
  diveCdUntil: number;
  ambushUntil: number;
  mineStep: number; // > 0 while walking landward to drop a trap mine
  lastMineT: number;
  itemCdUntil: number;

  // stuck detection
  stuckX: number;
  stuckZ: number;
  stuckCheck: number;
  stuckHits: number;
  detourUntil: number;
  detourX: number;
  detourZ: number;

  // bookkeeping
  lastState: number;
  freeSince: number;
  retreating: boolean;
}
