import type { Loadout } from './cosmetics.ts';

export type { Loadout };

// Core shared types. The sim, server, client and every render module agree on these.
// Erasable syntax only (no enums): Node runs this file with type stripping.

export type Team = 0 | 1;
export type FamilyId = 'brawler' | 'ogre' | 'bot';
export type MapId = 'muckmire' | 'frostfang' | 'coralcove' | 'cogwater' | 'mirelight' | 'aurora' | 'maelstrom' | 'lanternwharf';
export type RiverMode = 'deep' | 'dry' | 'tidal';
export type HazardMode = 'none' | 'thorns' | 'bristles' | 'special' | 'mixed';
export type BotDifficulty = 'easy' | 'normal' | 'hard' | 'brutal';
export type ControlScheme = 'modern' | 'classic';

export const FAMILIES: readonly FamilyId[] = ['brawler', 'ogre', 'bot'];
export const MAP_IDS: readonly MapId[] = ['muckmire', 'frostfang', 'coralcove', 'cogwater', 'mirelight', 'aurora', 'maelstrom', 'lanternwharf'];
export const RIVER_MODES: readonly RiverMode[] = ['deep', 'dry', 'tidal'];
export const HAZARD_MODES: readonly HazardMode[] = ['none', 'thorns', 'bristles', 'special', 'mixed'];
export const BOT_DIFFICULTIES: readonly BotDifficulty[] = ['easy', 'normal', 'hard', 'brutal'];

/** @deprecated legacy index-based cosmetics, kept only for the old character builders. Use Loadout. */
export interface Cosmetics {
  hat: number;
  accent: number;
  face: number;
}

export interface MatchConfig {
  mapId: MapId;
  riverMode: RiverMode;
  hazards: HazardMode;
  killsToWin: number; // 5..50
  timeLimitSec: number; // 180..1800
  teamSize: number; // 1..5 slots per side
  botFill: boolean; // fill empty slots with bots
  botDifficulty: BotDifficulty;
}

export interface PlayerInfo {
  id: number; // unit id == player id, stable for the match
  name: string;
  team: Team;
  family: FamilyId;
  loadout: Loadout; // one cosmetic per slot, see shared/cosmetics.ts
  isBot: boolean;
  botDifficulty?: BotDifficulty;
}

/** Button bits in PlayerInput.buttons. "Pressed this tick" edges, OR-ed when inputs are merged. */
export const Btn = {
  Hook: 1,
  Grapple: 2,
  Bash: 4,
  Item1: 8,
  Item2: 16,
  Item3: 32,
  Item4: 64,
} as const;
export const BTN_ITEM = [Btn.Item1, Btn.Item2, Btn.Item3, Btn.Item4] as const;
export const BTN_ALL = 127;

/** One tick of player intent. Movement is a direction, aim is a world point. */
export interface PlayerInput {
  seq: number; // client sequence number, monotonically increasing
  mx: number; // move dir x, clamped to unit length
  mz: number; // move dir z
  ax: number; // aim world x
  az: number; // aim world z
  b: number; // Btn bits pressed this tick
}

export const UnitState = {
  Alive: 0,
  Dead: 1,
  Hooked: 2, // being dragged by a hook
  Knocked: 3, // flying from a bash or mine
  Grappling: 4, // flying toward own grapple anchor
  Drowning: 5, // in deep water, timer running
  Casting: 6, // ability wind-up, rooted
} as const;
export type UnitStateId = (typeof UnitState)[keyof typeof UnitState];

/** Unit flag bits in UnitSnap.fl. */
export const UFlag = {
  SpawnProt: 1,
  Stealth: 2, // only ever sent to own team; enemies do not receive stealthed units at all
  Shield: 4,
  Burning: 8,
  Haste: 16,
  DoubleDmg: 32,
  OnIce: 64,
  Shallow: 128, // wading in shallow water
  Healing: 256,
  InHazard: 512,
  Swimming: 1024, // in deep water (drowning)
  Overtime: 2048,
  Bendy: 4096, // hook power-ups, visible to everyone
  Bouncy: 8192,
  Longshot: 16384,
} as const;

export const HookKind = { Hook: 0, Grapple: 1 } as const;
export const HookPhase = { Out: 0, Back: 1, Pull: 2 } as const;

export type CastKind = 'hook' | 'grapple' | 'bash' | 'melee';

export type ItemId =
  | 'ricochet' // Ricochet Spring: hook bounces off walls
  | 'ember' // Ember Barb: burn on hook hit
  | 'sinker' // Lucky Sinker: bullseye crit chance
  | 'irongut' // Iron Gut: +max HP
  | 'wellies' // Swift Wellies: +move speed
  | 'mine' // Bramble Mine: consumable
  | 'pie' // Healing Pie: consumable
  | 'puffball'; // Puffball: consumable stealth

export type UpgradeStat = 'damage' | 'range' | 'speed' | 'width';
export const UPGRADE_STATS: readonly UpgradeStat[] = ['damage', 'range', 'speed', 'width'];

/**
 * Runes float on the river; hook one (or walk over it on a dry bed) to claim it.
 * The last three are hook power-ups: bendy (the flying hook curves toward your cursor),
 * bouncy (ricochets off everything it hits), longshot (much longer, faster hook).
 */
export type RuneType = 'haste' | 'double' | 'ironskin' | 'ghost' | 'bounty' | 'bendy' | 'bouncy' | 'longshot';
export const RUNE_TYPES: readonly RuneType[] = ['haste', 'double', 'ironskin', 'ghost', 'bounty', 'bendy', 'bouncy', 'longshot'];

export type HazardKind =
  | 'thorns'
  | 'bristles'
  | 'quicksand' // Muckmire special
  | 'icespikes' // Frostfang special
  | 'jellyfish' // Coral Cove special
  | 'steamvent'; // Cogwater special

export type TidePhase = 'none' | 'low' | 'rising' | 'high' | 'falling' | 'frozen' | 'cracking' | 'thawed' | 'freezing';

/** Water state for one tick. level 0 = dry bed, 1 = full deep water. */
export interface RiverState {
  level: number; // 0..1 visual + gameplay water level
  deep: boolean; // channel is lethal right now
  shallow: boolean; // channel is wadeable (slow) right now
  frozen: boolean; // channel is walkable ice (slippery)
  phase: TidePhase;
  phaseLeft: number; // seconds until next phase change (0 when no cycle)
  cycle: boolean; // this match has a tide cycle
}

export type KillCause = 'hook' | 'melee' | 'bash' | 'drown' | 'mine' | 'burn' | 'hazard' | 'fountain';

// ---------------------------------------------------------------------------------------------
// Snapshot (server -> client, per team view). Short keys keep payloads small.
// ---------------------------------------------------------------------------------------------

export interface UnitSnap {
  i: number; // id
  x: number;
  z: number;
  y: number; // vertical offset for arcs / sinking
  f: number; // facing radians
  hp: number;
  mhp: number;
  st: UnitStateId;
  fl: number; // UFlag bits
  ck?: CastKind; // current wind-up (state Casting)
  rt?: number; // respawn seconds left (dead only)
}

export interface HookSnap {
  i: number;
  o: number; // owner unit id
  k: 0 | 1; // HookKind
  p: 0 | 1 | 2; // HookPhase
  x: number;
  z: number;
  r: number; // head radius
  pts: number[]; // fixed chain bend points [x0,z0,x1,z1,...] between the owner's hand and the head
  tg: number; // dragged unit id or -1
  ru: number; // dragged rune id or -1
  fx: number; // bit 1 = ember, bit 2 = ricochet
}

export interface RuneSnap {
  i: number;
  t: RuneType;
  x: number;
  z: number;
  d: 0 | 1; // being dragged
}

export interface MineSnap {
  i: number;
  o: number;
  x: number;
  z: number;
  a: 0 | 1; // armed
}

export interface ItemSlot {
  id: ItemId;
  charges: number; // consumables only, 0 for passive items
}

export interface BuffSnap {
  t: RuneType | 'pie' | 'puffball' | 'burn' | 'spawn';
  left: number;
}

/** Private block, only sent to the owning client. */
export interface YouSnap {
  id: number;
  ack: number; // last input seq the server processed for you
  gold: number;
  cd: [number, number, number]; // seconds left: hook, grapple, bash
  cdMax: [number, number, number];
  items: (ItemSlot | null)[]; // length 4
  up: Record<UpgradeStat, number>; // levels 0..5
  buffs: BuffSnap[];
  drown: number; // drown seconds left while swimming, else 0
  hookRange: number;
  mm: number; // current movement multiplier (prediction uses it)
  vx: number; // authoritative velocity (prediction resync)
  vz: number;
}

export interface ScoreRow {
  i: number;
  k: number;
  d: number;
  a: number;
  hh: number; // hooks hit
  ht: number; // hooks thrown
  bs: number; // bullseyes
  dr: number; // drownings caused
  sv: number; // ally saves
  dmg: number;
  g: number; // gold earned total
}

export type MatchPhase = 'countdown' | 'playing' | 'ended';

export interface Snapshot {
  t: number; // tick
  ph: MatchPhase;
  cd: number; // countdown seconds left (countdown phase)
  tl: number; // match seconds left
  ot: 0 | 1; // overtime: next kill wins
  s: [number, number]; // team scores
  mc: number; // mover clock (seconds) for drifting floes, barges and logs
  mt: number; // match seconds elapsed while playing (drives tides and hazard timers)
  u: UnitSnap[];
  h: HookSnap[];
  r: RuneSnap[];
  m: MineSnap[]; // only own team's mines
  w: RiverState;
  ev: GameEvent[];
  you?: YouSnap;
  sb?: ScoreRow[]; // scoreboard, sent every ~0.5 s
}

// ---------------------------------------------------------------------------------------------
// Game events, for VFX, audio and UI. Positions are world x/z.
// ---------------------------------------------------------------------------------------------

export type GameEvent =
  | { e: 'cast'; u: number; k: CastKind; x: number; z: number; ax: number; az: number }
  | { e: 'hookLaunch'; u: number; h: number; k: 0 | 1; x: number; z: number; dx: number; dz: number }
  | { e: 'hookHit'; u: number; tg: number; ally: boolean; dmg: number; bull: boolean; x: number; z: number }
  | { e: 'hookWall'; u: number; x: number; z: number }
  | { e: 'hookBounce'; u: number; x: number; z: number }
  | { e: 'hookClash'; a: number; b: number; x: number; z: number }
  | { e: 'hookSteal'; u: number; from: number; tg: number }
  | { e: 'hookBreak'; u: number; tg: number; x: number; z: number }
  | { e: 'hookDone'; u: number; tg: number; x: number; z: number }
  | { e: 'runeGrab'; u: number; r: number; t: RuneType }
  | { e: 'grappleHit'; u: number; x: number; z: number }
  | { e: 'grappleLand'; u: number; x: number; z: number }
  | { e: 'bash'; u: number; x: number; z: number; dx: number; dz: number; hits: number[] }
  | { e: 'melee'; u: number; tg: number; dmg: number }
  | { e: 'dmg'; tg: number; src: number; amt: number; kind: KillCause | 'shield' }
  | { e: 'heal'; tg: number; amt: number }
  | { e: 'kill'; k: number; v: number; as: number[]; cause: KillCause; x: number; z: number }
  | { e: 'corpse'; v: number; x: number; z: number } // corpse delivered or burst, spawn debris
  | { e: 'respawn'; u: number; x: number; z: number }
  | { e: 'drownStart'; u: number; x: number; z: number }
  | { e: 'drownSave'; u: number }
  | { e: 'splash'; u: number; x: number; z: number; s: number } // s = strength 0..1, u = who splashed
  | { e: 'runeSpawn'; r: number; t: RuneType; x: number; z: number }
  | { e: 'rune'; u: number; t: RuneType }
  | { e: 'mineArm'; o: number; m: number; x: number; z: number }
  | { e: 'mineBoom'; m: number; x: number; z: number }
  | { e: 'buy'; u: number; item: ItemId | UpgradeStat }
  | { e: 'useItem'; u: number; item: ItemId; x: number; z: number }
  | { e: 'tide'; phase: TidePhase; left: number }
  | { e: 'hazard'; h: number; x: number; z: number } // periodic hazard fired (ice spike, steam vent)
  | { e: 'announce'; key: AnnounceKey; u: number; n: number }
  | { e: 'phase'; ph: MatchPhase }
  | { e: 'end'; winner: Team | -1 };

export type AnnounceKey =
  | 'firstBlood'
  | 'doubleHook'
  | 'tripleHook'
  | 'ultraHook'
  | 'spree3' // Reel Deal
  | 'spree5' // Catch of the Day
  | 'spree8' // Kraken Unleashed
  | 'shutdown'
  | 'bullseye'
  | 'save'
  | 'drowned'
  | 'overtime';

export function otherTeam(t: Team): Team {
  return t === 0 ? 1 : 0;
}
