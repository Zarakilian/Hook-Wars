// Wire protocol. JSON text frames. Every client message is validated field by field on the
// server with parseClientMessage(); anything malformed returns null and the server drops it.
import { DEFAULT_CONFIG, ITEM_IDS, MAX_CHAT_LEN, MAX_NAME_LEN, MAX_TEAM_SIZE, PROTOCOL_VERSION } from './constants.ts';
import { mapSupportsTidal } from './maps/index.ts';
import {
  BOT_DIFFICULTIES, BTN_ALL, FAMILIES, HAZARD_MODES, MAP_IDS, RIVER_MODES, UPGRADE_STATS,
  type BotDifficulty, type Cosmetics, type FamilyId, type ItemId, type MatchConfig, type PlayerInfo, type PlayerInput, type ScoreRow,
  type Snapshot, type Team, type UpgradeStat,
} from './types.ts';
import type { HazardInst } from './sim/entities.ts';

// ---------------------------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------------------------

export interface Profile {
  name: string;
  family: FamilyId;
  cosmetics: Cosmetics;
}

export type ClientMsg =
  | { t: 'hello'; v: number; profile: Profile }
  | { t: 'listRooms' }
  | { t: 'createRoom'; name: string; isPrivate: boolean; config: MatchConfig }
  | { t: 'joinRoom'; code: string }
  | { t: 'quickPlay' }
  | { t: 'leaveRoom' }
  | { t: 'setProfile'; profile: Profile }
  | { t: 'setTeam'; team: Team | -1 } // -1 = spectate
  | { t: 'setConfig'; config: MatchConfig }
  | { t: 'ready'; ready: boolean }
  | { t: 'start' }
  | { t: 'input'; i: PlayerInput }
  | { t: 'buy'; item: ItemId }
  | { t: 'sell'; slot: number }
  | { t: 'upgrade'; stat: UpgradeStat }
  | { t: 'chat'; text: string; team: boolean }
  | { t: 'ping'; c: number };

// ---------------------------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------------------------

export interface RoomSummary {
  code: string;
  name: string;
  mapId: MatchConfig['mapId'];
  riverMode: MatchConfig['riverMode'];
  humans: number;
  slots: number; // teamSize * 2
  phase: 'lobby' | 'match';
}

export interface LobbySlot {
  id: number; // player id (also the unit id in a match)
  name: string;
  team: Team | -1;
  family: FamilyId;
  cosmetics: Cosmetics;
  isBot: boolean;
  ready: boolean;
  host: boolean;
  ping: number;
}

export interface RoomState {
  code: string;
  name: string;
  isPrivate: boolean;
  hostId: number;
  config: MatchConfig;
  players: LobbySlot[];
  phase: 'lobby' | 'match';
}

export interface MatchStart {
  config: MatchConfig;
  seed: number;
  players: PlayerInfo[];
  hazards: HazardInst[];
  you: number; // your unit id, -1 if spectating
  tick: number; // server tick at start (for mid-match joins)
}

export interface MatchEnd {
  winner: Team | -1;
  score: [number, number];
  rows: ScoreRow[];
  players: PlayerInfo[];
}

export type ServerMsg =
  | { t: 'welcome'; id: number; v: number; serverName: string; motd: string }
  | { t: 'rooms'; rooms: RoomSummary[] }
  | { t: 'room'; room: RoomState }
  | { t: 'leftRoom' }
  | { t: 'start'; m: MatchStart }
  | { t: 'players'; players: PlayerInfo[] } // roster changed mid-match
  | { t: 's'; s: Snapshot }
  | { t: 'end'; e: MatchEnd }
  | { t: 'chat'; from: string; fromId: number; text: string; team: boolean; teamId: Team | -1 }
  | { t: 'pong'; c: number; s: number }
  | { t: 'error'; code: string; message: string };

// ---------------------------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, lo: number, hi: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < lo || v > hi) return null;
  return v;
}

function int(v: unknown, lo: number, hi: number): number | null {
  const n = num(v, lo, hi);
  return n !== null && Number.isInteger(n) ? n : null;
}

function oneOf<T extends string>(v: unknown, list: readonly T[]): T | null {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;
}

/** Control, zero-width, bidi-override and angle-bracket characters, built from code points. */
const UNSAFE_CHARS = new RegExp(
  '[' + [[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069]].map(([a, b]) => `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`).join('') + '<>]',
  'gu',
);

/** Strip control characters and markup-ish characters, collapse spaces, clamp length. */
export function cleanText(v: unknown, maxLen: number): string | null {
  if (typeof v !== 'string') return null;
  let s = v.replace(/[\t\n\r]/g, ' ').replace(UNSAFE_CHARS, '').replace(/\s+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

export function cleanName(v: unknown): string | null {
  const s = cleanText(v, MAX_NAME_LEN);
  if (!s) return null;
  return s;
}

export function parseCosmetics(v: unknown): Cosmetics | null {
  if (!isObj(v)) return null;
  const hat = int(v.hat, 0, 63);
  const accent = int(v.accent, 0, 63);
  const face = int(v.face, 0, 63);
  if (hat === null || accent === null || face === null) return null;
  return { hat, accent, face };
}

export function parseProfile(v: unknown): Profile | null {
  if (!isObj(v)) return null;
  const name = cleanName(v.name);
  const family = oneOf(v.family, FAMILIES);
  const cosmetics = parseCosmetics(v.cosmetics);
  if (!name || !family || !cosmetics) return null;
  return { name, family, cosmetics };
}

/** Validate and normalise a match config. Tidal on a map without tides falls back to Deep Water. */
export function parseConfig(v: unknown): MatchConfig | null {
  if (!isObj(v)) return null;
  const mapId = oneOf(v.mapId, MAP_IDS);
  const riverMode = oneOf(v.riverMode, RIVER_MODES);
  const hazards = oneOf(v.hazards, HAZARD_MODES);
  const killsToWin = int(v.killsToWin, 5, 50);
  const timeLimitSec = int(v.timeLimitSec, 180, 1800);
  const teamSize = int(v.teamSize, 1, MAX_TEAM_SIZE);
  const botFill = typeof v.botFill === 'boolean' ? v.botFill : null;
  const botDifficulty = oneOf<BotDifficulty>(v.botDifficulty, BOT_DIFFICULTIES);
  if (!mapId || !riverMode || !hazards || killsToWin === null || timeLimitSec === null || teamSize === null || botFill === null || !botDifficulty) {
    return null;
  }
  return {
    mapId,
    riverMode: riverMode === 'tidal' && !mapSupportsTidal(mapId) ? 'deep' : riverMode,
    hazards,
    killsToWin,
    timeLimitSec,
    teamSize,
    botFill,
    botDifficulty,
  };
}

export function parseInput(v: unknown): PlayerInput | null {
  if (!isObj(v)) return null;
  const seq = int(v.seq, 0, 2 ** 31);
  let mx = num(v.mx, -1.01, 1.01);
  let mz = num(v.mz, -1.01, 1.01);
  const ax = num(v.ax, -500, 500);
  const az = num(v.az, -500, 500);
  const b = int(v.b, 0, BTN_ALL);
  if (seq === null || mx === null || mz === null || ax === null || az === null || b === null) return null;
  const l = Math.hypot(mx, mz);
  if (l > 1) {
    mx /= l;
    mz /= l;
  }
  return { seq, mx, mz, ax, az, b };
}

const ROOM_CODE_RE = /^[A-Z]{5}$/;

/** Parse one raw text frame from a client. Returns null if anything is off. */
export function parseClientMessage(raw: string): ClientMsg | null {
  if (raw.length > 4096) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(m) || typeof m.t !== 'string') return null;
  switch (m.t) {
    case 'hello': {
      const v = int(m.v, 0, 1e6);
      const profile = parseProfile(m.profile);
      return v !== null && profile ? { t: 'hello', v, profile } : null;
    }
    case 'listRooms':
    case 'quickPlay':
    case 'leaveRoom':
    case 'start':
      return { t: m.t };
    case 'createRoom': {
      const name = cleanText(m.name, 28) || 'Hook Wars room';
      const config = parseConfig(m.config);
      const isPrivate = typeof m.isPrivate === 'boolean' ? m.isPrivate : null;
      return config && isPrivate !== null ? { t: 'createRoom', name, isPrivate, config } : null;
    }
    case 'joinRoom': {
      const code = typeof m.code === 'string' ? m.code.trim().toUpperCase() : '';
      return ROOM_CODE_RE.test(code) ? { t: 'joinRoom', code } : null;
    }
    case 'setProfile': {
      const profile = parseProfile(m.profile);
      return profile ? { t: 'setProfile', profile } : null;
    }
    case 'setTeam': {
      const team = int(m.team, -1, 1);
      return team !== null ? { t: 'setTeam', team: team as Team | -1 } : null;
    }
    case 'setConfig': {
      const config = parseConfig(m.config);
      return config ? { t: 'setConfig', config } : null;
    }
    case 'ready':
      return typeof m.ready === 'boolean' ? { t: 'ready', ready: m.ready } : null;
    case 'input': {
      const i = parseInput(m.i);
      return i ? { t: 'input', i } : null;
    }
    case 'buy': {
      const item = oneOf(m.item, ITEM_IDS);
      return item ? { t: 'buy', item } : null;
    }
    case 'sell': {
      const slot = int(m.slot, 0, 3);
      return slot !== null ? { t: 'sell', slot } : null;
    }
    case 'upgrade': {
      const stat = oneOf(m.stat, UPGRADE_STATS);
      return stat ? { t: 'upgrade', stat } : null;
    }
    case 'chat': {
      const text = cleanText(m.text, MAX_CHAT_LEN);
      const team = typeof m.team === 'boolean' ? m.team : false;
      return text ? { t: 'chat', text, team } : null;
    }
    case 'ping': {
      const c = num(m.c, 0, 1e15);
      return c !== null ? { t: 'ping', c } : null;
    }
    default:
      return null;
  }
}

export function defaultProfile(): Profile {
  return { name: 'Pudgy', family: 'brawler', cosmetics: { hat: 0, accent: 0, face: 0 } };
}

export function defaultConfig(): MatchConfig {
  return { ...DEFAULT_CONFIG };
}

export { PROTOCOL_VERSION };
