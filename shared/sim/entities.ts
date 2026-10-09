// Mutable simulation entities. Only the sim mutates these; snapshots are built from them.
import type {
  BotDifficulty, CastKind, FamilyId, Loadout, HazardKind, ItemSlot, PlayerInput, RuneType, Team, UnitStateId, UpgradeStat,
} from '../types.ts';

export interface UnitStats {
  k: number;
  d: number;
  a: number;
  hh: number;
  ht: number;
  bs: number;
  dr: number;
  sv: number;
  dmg: number;
  g: number;
}

export interface Unit {
  id: number;
  team: Team;
  family: FamilyId;
  name: string;
  loadout: Loadout;
  isBot: boolean;
  botDifficulty: BotDifficulty;
  spawnIndex: number;

  x: number;
  z: number;
  vx: number;
  vz: number;
  y: number;
  face: number; // facing angle: direction = (sin face, cos face)

  hp: number;
  maxHp: number;
  state: UnitStateId;
  stateT: number;

  castKind: CastKind | null;
  castT: number;
  castAx: number;
  castAz: number;
  buffered: { kind: 'hook' | 'grapple' | 'bash'; ax: number; az: number; t: number } | null;

  cdHook: number;
  cdGrapple: number;
  cdBash: number;
  cdMelee: number;
  meleeT: number; // > 0 while a wallop is winding up
  meleeTarget: number;

  knockVx: number;
  knockVz: number;
  knockT: number;
  knockDur: number;
  knockH: number;

  hookedBy: number; // hook id dragging this unit, or -1
  activeHook: number; // own hook id or -1
  activeGrapple: number; // own grapple id or -1

  drownT: number;
  /** under a deck (dock, bridge, pier) on the bed below it, see deckLayer() in sim/movement.ts */
  under: boolean;
  /** position at the start of the tick, for the deck layer */
  tickX: number;
  tickZ: number;
  respawnT: number;
  spawnProt: number;

  haste: number;
  double: number;
  bendy: number; // hook power-up timers (seconds)
  bouncy: number;
  longshot: number;
  shield: number;
  shieldT: number;
  ghost: number;
  puff: number;
  pieT: number;
  burnT: number;
  burnDps: number;
  burnSrc: number;

  lastDamageT: number;
  damagers: Map<number, number>; // enemy unit id -> last time it damaged us

  gold: number;
  up: Record<UpgradeStat, number>;
  items: (ItemSlot | null)[];

  stats: UnitStats;
  streak: number;
  multi: number;
  lastKillT: number;

  input: PlayerInput;
  queue: PlayerInput[];
  ack: number;
  idleTicks: number; // ticks without a fresh input
  moveMul: number; // last computed movement multiplier, sent to the owner for prediction

  healAcc: number; // visible healing (pie, fountain) waiting to be shown as a number
  hazardT: number; // seconds standing in quicksand
  bristleCd: number;
  inHazard: boolean;
  surface: string;

  /** Scratch for bots: brain state lives here, owned by shared/sim/bots.ts. */
  brain: unknown;
}

export interface Hook {
  id: number;
  owner: number;
  kind: 0 | 1; // HookKind
  phase: 0 | 1 | 2; // HookPhase
  x: number;
  z: number;
  dx: number;
  dz: number;
  speed: number;
  r: number;
  range: number;
  traveled: number;
  pts: number[]; // fixed bend points from hand to head
  bounces: number;
  tg: number;
  ru: number;
  ember: boolean;
  ricochet: boolean;
  steer: boolean; // Bendy Eel: curves toward the thrower's cursor while flying out
  longshot: boolean;
  dmg: number;
  anchorUnit: number; // grapple attached to a unit
  flightT: number;
  dead: boolean;
  bendAcc: number; // whirlpool bend accumulator
  /** deck tier of the throw (hookTierOf in sim/movement.ts): who it can catch inside a deck footprint */
  tier: 0 | 1 | 2;
}

export interface Rune {
  id: number;
  type: RuneType;
  x: number;
  z: number;
  spot: number;
  dragged: boolean;
}

export interface Mine {
  id: number;
  owner: number;
  team: Team;
  x: number;
  z: number;
  armT: number;
  dead: boolean;
  /** dropped from under a deck (the dropper's layer); the mine's deck tier comes from this and its position */
  under?: boolean;
}

export interface HazardInst {
  id: number;
  kind: HazardKind;
  x: number;
  z: number;
  r: number;
  channel: boolean;
  period: number; // 0 = continuous hazard
  offset: number; // seconds
  telegraph: number; // seconds of warning before a periodic burst
}

export interface MatchStartInfo {
  hazards: HazardInst[];
}
