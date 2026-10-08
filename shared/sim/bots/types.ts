// Shared bot types: roles, per-difficulty tuning and the per-unit brain.
// Everything here is plain data so a brain can be created mid-match (controller swaps, joins).
import type { Rng } from '../../math.ts';
import type { BotDifficulty, ItemId, UpgradeStat } from '../../types.ts';

export type BotRole = 'harpooner' | 'bruiser' | 'lifeguard';
export type BuildStep = ItemId | UpgradeStat;

export interface RoleDef {
  id: BotRole;
  name: string;
  /**
   * Metres from the unit centre back to the water's edge while the hook is ready. About 2.2 m is the
   * sweet spot: a hooked enemy is delivered straight in front, and a riverward bash then lands them
   * more than 3 m out in the river, beyond swimming distance.
   */
  standReady: number;
  /** Minimum metres back from the edge while the hook cools down. */
  standWait: number;
  /** 0..1: willingness to cross a walkable bed, dive and brawl. */
  aggression: number;
  /** Multiplier on the value of hooking an ally to safety. */
  saveBias: number;
  /** Multiplier on the value of hooking runes. */
  runeBias: number;
  /** Multiplier on plain bash value (bruisers love a shove). */
  bashBias: number;
  /** Go and heal below this fraction of max hp. */
  retreatHp: number;
  build: BuildStep[];
  buildDry: BuildStep[];
  /** Consumables this role keeps topped up once its build is done. */
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
  /** Perception delay in ticks: the bot sees enemies this many ticks late. */
  perceiveTicks: number;
  /** Seconds from a decision to the button press (the rest of the reaction time). */
  decide: number;
  /** Seconds after an enemy hook leaves the hand before the bot can notice it. */
  dodgeReact: number;
  /** Minimum shot score (hit chance x value) before the bot throws. */
  throwBar: number;
  /** Seconds of waiting with a ready hook before the bar relaxes to its floor. */
  patience: number;
  /** Chance to hesitate when an opportunity appears. */
  hesitate: number;
  /** Positioning re-plans per second. */
  planHz: number;
  /** 0 = never, 1 = only with the Ricochet Spring, 2 = also off bouncy posts. */
  bankShots: number;
  /** Seconds between bank-shot searches. */
  bankShotEvery: number;
  /** Uses hook baiting, mine traps and puffball ambushes. */
  tricks: boolean;
  /** Chance per good opportunity that a bruiser grapples across to bash someone in. */
  dives: number;
  /** 0..1 how much the bot jukes while exposed to a ready enemy hook. */
  juke: number;
  /** Extra seconds of margin before tides turn. */
  tideMargin: number;
  /** Seconds between shop visits. */
  shopEvery: number;
  /** Extra delay (s) before a fumbled combo bash. */
  comboDelay: number;
  /** Chance to fumble the hook-then-bash timing (the bash then comes late, if at all). */
  fumble: number;
  /** Chance to remember the grapple when dunked in deep water. */
  escape: number;
  /** Hooks enemies their own team is dragging to safety. */
  steal: boolean;
  /** Reads enemy hook wind-ups (facing) and starts moving early. */
  predodge: boolean;
}

/** Positioning modes, for debugging and tests. */
export const Mode = {
  Hold: 0,
  Retreat: 1,
  Push: 2,
  Rune: 3,
  Leave: 4,
  Stranded: 5,
  Trap: 6,
  Swim: 7,
} as const;
export type ModeId = (typeof Mode)[keyof typeof Mode];

export type IntentKind = 'hook' | 'bash' | 'grapple';
/** 0 = enemy, 1 = ally, 2 = rune, 3 = point (grapple anchor) */
export type TargetKind = 0 | 1 | 2 | 3;

/** A decided action waiting for the bot's reaction delay to pass. */
export interface Intent {
  kind: IntentKind;
  tk: TargetKind;
  id: number;
  x: number;
  z: number;
  at: number;
  value: number;
  /** Extra angle found by the path solver (whirlpool bend, bank shot), radians. */
  bend: number;
  /** grapple: what the flight is for (0 = escape water, 1 = dive, 2 = go home) */
  purpose: number;
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
  bend: number;
  /** Fraction of the target's velocity this shot leads by. */
  lead: number;
}

export interface Brain {
  role: BotRole;
  roleDef: RoleDef;
  diff: BotDifficulty;
  tune: Tuning;
  rng: Rng;
  seq: number;
  /** Stagger offset (s) so bots do not all think on the same tick. */
  phase: number;

  nextThink: number;
  nextPlan: number;
  nextShop: number;
  buildIdx: number;
  build: BuildStep[];

  // positioning
  mode: ModeId;
  goalX: number;
  goalZ: number;
  goalScore: number;
  laneZ: number;
  /** Number of enemy hooks that are ready and have a line to us (updated at think rate). */
  exposed: number;
  jukeDir: number;
  jukeUntil: number;
  pushTarget: number;
  pushKill: boolean;
  retreating: boolean;
  /** Seconds of the current walkable window we plan to spend across the river. */
  crossing: boolean;

  // dodging
  dodgeUntil: number;
  dodgeX: number;
  dodgeZ: number;
  judged: Int32Array; // ring of hook ids (or -unit ids for wind-ups) already judged
  judgedHead: number;

  // actions
  intent: Intent | null;
  aim: AimLock | null;
  hookReadySince: number;
  baitUntil: number;
  lastBankSearch: number;
  comboTarget: number;
  comboAt: number;
  holdStill: boolean;
  /** Our hook is dragging an enemy home right now. */
  reeling: boolean;
  diveTarget: number;
  /** DIVE_SHOVE or DIVE_SNATCH (dive.ts) */
  divePurpose: number;
  diveUntil: number;
  nextDiveCheck: number;
  trapUntil: number;
  lastMineT: number;
  itemCdUntil: number;
  drownSeen: number;
  /** This dunking, the bot forgot it has a grapple. */
  panicked: boolean;

  // stuck detection
  stuckX: number;
  stuckZ: number;
  stuckCheck: number;
  stuckHits: number;
  detourUntil: number;
  detourX: number;
  detourZ: number;
  detourSide: number;

  // navigation (navigate.ts): the current path toward the goal
  /** Waypoints x0, z0, x1, z1, ... (NAV_MAXWP pairs). */
  navWp: Float32Array;
  navN: number;
  navI: number;
  /** The goal the current path (or straight line) was checked for. */
  navGX: number;
  navGZ: number;
  /** Walkability variant of the current path (-1 = none yet). */
  navVar: number;
  /** Next time to re-test the straight line to the goal. */
  navCheck: number;
  /** The straight line to the goal is walkable: no path needed. */
  navDirect: boolean;
  /** The path reaches the goal (false: it stops at the closest point found). */
  navDone: boolean;
  /** Do not search again before this time (the goal was unreachable). */
  navFail: number;
  navAt: number;

  // Bendy Eel: what our steering hook is chasing (TargetKind and id, tk -1 = nothing)
  steerTk: number;
  steerId: number;

  // bookkeeping
  lastState: number;
  stats: BotStats;
}

/** Per-bot counters, handy for tests and tuning. Never read by the sim. */
export interface BotStats {
  hooks: number;
  saves: number;
  runes: number;
  dodges: number;
  combos: number;
  dives: number;
  bankShots: number;
  grappleEscapes: number;
  /** Hooks thrown while Bendy Eel was active, and ticks spent steering one in flight. */
  bendyThrows: number;
  bendySteers: number;
  /** Hooks thrown with Long Line active from beyond the normal hook range. */
  longshots: number;
  /** A* searches this bot ran. */
  paths: number;
}
