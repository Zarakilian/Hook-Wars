// Network rates and the full balance table. Tune gameplay here, nowhere else.
import type { FamilyId, ItemId, MatchConfig, RuneType, UpgradeStat } from './types.ts';

export const GAME_VERSION = '0.1.0';
export const PROTOCOL_VERSION = 1;

export const TICK_RATE = 30;
export const TICK_DT = 1 / TICK_RATE;
/** Snapshots per second sent to each client. */
export const SNAPSHOT_RATE = 30;
/** Scoreboard rows are attached every N ticks. */
export const SCOREBOARD_EVERY = 15;

export const MAX_TEAM_SIZE = 5;
export const MAX_NAME_LEN = 16;
export const MAX_CHAT_LEN = 120;

export const DEFAULT_CONFIG: MatchConfig = {
  mapId: 'muckmire',
  riverMode: 'deep',
  hazards: 'none',
  killsToWin: 30,
  timeLimitSec: 900,
  teamSize: 5,
  botFill: true,
  botDifficulty: 'normal',
};

export const UNIT_RADIUS = 0.75;
export const COUNTDOWN_SEC = 4;

export const BAL = {
  maxHp: 1000,
  moveSpeed: 6.2,
  accel: 75, // m/s^2 on normal ground: reaches top speed in ~0.08 s
  iceAccel: 9,
  iceFriction: 1.6, // velocity decay per second on ice when no input
  shallowSlow: 0.62, // speed multiplier wading
  mudSlow: 0.9, // dry river bed
  swimSpeed: 0.25, // multiplier while drowning: falling in is meant to be fatal
  drownTime: 2,
  respawnBase: 5,
  respawnPerDeath: 0.35,
  respawnMax: 10,
  spawnProt: 2,
  creditWindow: 8, // seconds a damager keeps kill credit (drown, hazard, burn)
  assistWindow: 10,

  // Chain Hook
  hookCooldown: 4,
  hookWindup: 0.12,
  hookRetractMul: 1.15,
  hookMoveSlow: 0.85, // caster speed while own hook is out: you keep walking while it flies
  castMoveMul: 0.85, // walking speed during the Hook / Grapple wind-up (they no longer root you)
  hookHand: 0.95, // hand offset from unit centre
  hookDeliver: 1.7, // release distance in front of the caster

  // Grapple
  grappleCooldown: 12,
  grappleWindup: 0.1,
  grappleRange: 17,
  grappleSpeed: 44,
  grappleRadius: 0.35,
  grapplePull: 30, // caster flight speed
  grappleMaxFlight: 1.2,

  // Belly Bash
  bashCooldown: 7,
  bashWindup: 0.12,
  bashRange: 2.9,
  bashArc: 2.1, // radians, full cone width
  bashDamage: 70,
  bashKnock: 6, // metres
  bashKnockTime: 0.32,

  // Wallop (auto melee)
  meleeRange: 2.35,
  meleeDamage: 45,
  meleeCooldown: 1,
  meleeWindup: 0.22,

  // Fountain
  fountainHeal: 0.1, // fraction of max hp per second for allies
  fountainBurn: 0.28, // fraction of max hp per second for enemies

  // Economy
  startGold: 400,
  goldPerSec: 3,
  goldKill: 250,
  goldStreakBonus: 60, // per streak level of the victim
  goldAssist: 90,
  goldHookHit: 20,
  goldBounty: 175,

  // Runes
  runeEvery: 40,
  runeFirstAt: 20,
  runeRadius: 0.6,
  hasteMul: 1.4,
  hasteTime: 8,
  doubleTime: 10,
  ironskinShield: 300,
  ironskinTime: 10,
  ghostTime: 8,
  // hook power-up runes
  powerHookTime: 15,
  bendyTurn: 3.4, // radians per second the Bendy Eel hook can curve toward the cursor
  bouncyBounces: 4,
  longshotRangeMul: 1.5,
  longshotSpeedMul: 1.15,

  // Items
  ricochetBounces: 2,
  emberDps: 32,
  emberTime: 4,
  sinkerChance: 0.15,
  sinkerMul: 2,
  irongutHp: 250,
  welliesMul: 1.12,
  mineDamage: 220,
  mineRadius: 1.7,
  mineArmTime: 1,
  mineKnock: 4,
  maxMines: 3,
  pieHeal: 420,
  pieTime: 8,
  puffTime: 3,
  stealthRevealDist: 2.6,
} as const;

/** Hook upgrade values per level 0..5. */
export const HOOK_LEVELS: Record<UpgradeStat, readonly number[]> = {
  damage: [180, 220, 260, 300, 345, 400],
  range: [16, 18, 20, 22, 24, 26],
  speed: [30, 33, 36, 39, 42, 46],
  width: [0.45, 0.52, 0.59, 0.66, 0.73, 0.8],
};
export const UPGRADE_COST: readonly number[] = [150, 250, 350, 450, 600]; // cost to reach level 1..5
export const MAX_UPGRADE = 5;

export interface ItemDef {
  id: ItemId;
  name: string;
  cost: number;
  consumable: boolean;
  charges: number; // charges granted per purchase (consumables)
  maxCharges: number;
  blurb: string;
}

export const ITEMS: Record<ItemId, ItemDef> = {
  ricochet: { id: 'ricochet', name: 'Ricochet Spring', cost: 500, consumable: false, charges: 0, maxCharges: 0, blurb: 'Your hook bounces off walls, rocks and trees twice.' },
  ember: { id: 'ember', name: 'Ember Barb', cost: 450, consumable: false, charges: 0, maxCharges: 0, blurb: 'Hooked enemies burn for 32 damage a second for 4 s.' },
  sinker: { id: 'sinker', name: 'Lucky Sinker', cost: 400, consumable: false, charges: 0, maxCharges: 0, blurb: '15% chance for a BULLSEYE: double hook damage.' },
  irongut: { id: 'irongut', name: 'Iron Gut', cost: 400, consumable: false, charges: 0, maxCharges: 0, blurb: '+250 max health.' },
  wellies: { id: 'wellies', name: 'Swift Wellies', cost: 350, consumable: false, charges: 0, maxCharges: 0, blurb: '+12% move speed.' },
  mine: { id: 'mine', name: 'Bramble Mine', cost: 120, consumable: true, charges: 2, maxCharges: 6, blurb: 'Drop a hidden mine: 220 damage and a big knockback.' },
  pie: { id: 'pie', name: 'Healing Pie', cost: 90, consumable: true, charges: 1, maxCharges: 4, blurb: 'Heal 420 over 8 s. Taking damage spoils it.' },
  puffball: { id: 'puffball', name: 'Puffball', cost: 160, consumable: true, charges: 1, maxCharges: 3, blurb: '3 s of stealth. Casting reveals you.' },
};
export const ITEM_IDS = Object.keys(ITEMS) as ItemId[];

export interface FamilyDef {
  id: FamilyId;
  name: string;
  title: string;
  passive: string;
  passiveBlurb: string;
  hpMul: number;
  speedMul: number;
  hookCdMul: number;
  regenOutOfCombat: number; // hp per second after 4 s without damage
}

export const FAMILY_DEFS: Record<FamilyId, FamilyDef> = {
  brawler: { id: 'brawler', name: 'Harbour Brawler', title: 'Fishmonger of the Docks', passive: 'Sea Legs', passiveBlurb: '+8% move speed.', hpMul: 1, speedMul: 1.08, hookCdMul: 1, regenOutOfCombat: 6 },
  ogre: { id: 'ogre', name: 'Swamp Ogre', title: 'Bogmaw of the Mire', passive: 'Mudskin', passiveBlurb: 'Out of combat regeneration is doubled.', hpMul: 1, speedMul: 1, hookCdMul: 1, regenOutOfCombat: 12 },
  bot: { id: 'bot', name: 'Butcher-Bot', title: 'Rivet-Ribbed Reclaimer', passive: 'Overclock', passiveBlurb: 'Chain Hook cooldown -8%.', hpMul: 1, speedMul: 1, hookCdMul: 0.92, regenOutOfCombat: 6 },
};

export const RUNE_NAMES: Record<RuneType, string> = {
  haste: 'Haste',
  double: 'Double Damage',
  ironskin: 'Iron Skin',
  ghost: 'Ghost',
  bounty: 'Bounty',
  bendy: 'Bendy Eel',
  bouncy: 'Boing Barb',
  longshot: 'Long Line',
};

/** Per-difficulty bot tuning. Read by shared/sim/bots.ts. */
export const BOT_TUNING = {
  easy: { reaction: 0.55, aimError: 0.22, leadSkill: 0.2, dodge: 0.1, thinkHz: 4 },
  normal: { reaction: 0.35, aimError: 0.12, leadSkill: 0.6, dodge: 0.35, thinkHz: 6 },
  hard: { reaction: 0.22, aimError: 0.06, leadSkill: 0.85, dodge: 0.6, thinkHz: 10 },
  brutal: { reaction: 0.12, aimError: 0.025, leadSkill: 1, dodge: 0.85, thinkHz: 15 },
} as const;

export const BOT_NAMES: readonly string[] = [
  'Gutsy Gus', 'Barnacle Bev', 'Old Chumley', 'Sir Reels', 'Mudge', 'Kipper', 'Ratchet', 'Bogsworth',
  'Captain Flop', 'Bilge Betty', 'Tusk Tom', 'Sprocket', 'Hooky Hal', 'Marsh Mags', 'Rivet Rita',
  'Big Haddock', 'Snaggle', 'Gristle', 'Puddle Pete', 'Cogsby', 'Wobbles', 'Lardo', 'Salty Sue', 'Clank',
];
