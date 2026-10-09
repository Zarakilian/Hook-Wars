// Steam lobby metadata for the Steam build (client/platform.ts): what a host publishes for the lobby
// browser, how the browser filters other games' lobbies out, and a publisher that only talks to Steam
// when something actually changed. No DOM and no bridge calls of its own, so Node tests run it.
//
// Development uses Steam's public test app 480 (Spacewar), whose lobbies every developer shares, so
// every Hook Wars lobby says game=hookwars and its protocol version, and the browser shows only those.
import { PROTOCOL_VERSION } from '../../shared/constants.ts';
import type { RoomState } from '../../shared/protocol.ts';
import { MAP_IDS, RIVER_MODES } from '../../shared/types.ts';
import type { SteamLobbySummary } from '../platform.ts';

export const LOBBY_GAME = 'hookwars';
/** Every key a Hook Wars lobby publishes, in this order. */
export const LOBBY_KEYS = ['game', 'v', 'name', 'room', 'map', 'mode', 'phase', 'humans', 'max'] as const;
export type LobbyKey = (typeof LOBBY_KEYS)[number];
export type LobbyInfo = Record<LobbyKey, string>;
/** Longest value published (the lobby name; everything else is far shorter). */
export const LOBBY_NAME_MAX = 40;
/** Players a hosted lobby can be made for (Steam's member limit; the room is half that per team). */
export const LOBBY_MAX_CHOICES = [2, 4, 6, 8, 10] as const;
export const LOBBY_ID_RE = /^[0-9]{1,20}$/;
const ROOM_CODE_RE = /^[A-Z]{5}$/;
/** Lobbies shown at most (the list comes from Steam; app 480's is shared with other games). */
export const LOBBY_LIST_MAX = 50;

/** A lobby name: printable, trimmed, at most LOBBY_NAME_MAX characters. */
export function cleanLobbyName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, LOBBY_NAME_MAX);
}

/** The member limit for a hosted lobby: one of LOBBY_MAX_CHOICES (the nearest one at or above). */
export function clampLobbyMax(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 10;
  return LOBBY_MAX_CHOICES.find((c) => c >= v) ?? LOBBY_MAX_CHOICES[LOBBY_MAX_CHOICES.length - 1];
}

/** Team size for a hosted room of this many players (1 to 5 a side). */
export function teamSizeFor(maxPlayers: number): number {
  return Math.max(1, Math.min(5, Math.ceil(clampLobbyMax(maxPlayers) / 2)));
}

/** What the host publishes for its room (setLobbyInfo). */
export function lobbyInfoFor(room: RoomState, lobbyName: string, version: number = PROTOCOL_VERSION): LobbyInfo {
  return {
    game: LOBBY_GAME,
    v: String(version),
    name: cleanLobbyName(lobbyName) || cleanLobbyName(room.name) || 'Hook Wars lobby',
    room: room.code,
    map: room.config.mapId,
    mode: room.config.riverMode,
    phase: room.phase,
    humans: String(room.players.length),
    max: String(room.config.teamSize * 2),
  };
}

function sameInfo(a: LobbyInfo | null, b: LobbyInfo | null): boolean {
  if (!a || !b) return a === b;
  return LOBBY_KEYS.every((k) => a[k] === b[k]);
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : '');
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(250, Math.floor(v)) : 0);

/**
 * The lobbies the browser shows: only Hook Wars lobbies of this protocol version with a room code,
 * every field checked (they come from strangers), lobbies waiting to start first, then the fullest.
 */
export function filterLobbies(list: unknown, version: number = PROTOCOL_VERSION): SteamLobbySummary[] {
  if (!Array.isArray(list)) return [];
  const out: SteamLobbySummary[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue;
    const l = raw as Record<string, unknown>;
    const id = typeof l.id === 'string' && LOBBY_ID_RE.test(l.id) ? l.id : null;
    const info = typeof l.info === 'object' && l.info !== null && !Array.isArray(l.info) ? (l.info as Record<string, unknown>) : null;
    if (!id || !info || seen.has(id)) continue;
    if (info.game !== LOBBY_GAME || info.v !== String(version)) continue;
    if (typeof info.room !== 'string' || !ROOM_CODE_RE.test(info.room)) continue;
    const clean: Record<string, string> = {};
    for (const k of LOBBY_KEYS) clean[k] = str(info[k], k === 'name' ? LOBBY_NAME_MAX : 16);
    if (!(MAP_IDS as readonly string[]).includes(clean.map)) clean.map = '';
    if (!(RIVER_MODES as readonly string[]).includes(clean.mode)) clean.mode = '';
    if (clean.phase !== 'match') clean.phase = 'lobby';
    seen.add(id);
    out.push({ id, name: cleanLobbyName(l.name) || clean.name || 'Hook Wars lobby', host: str(l.host, 32), members: count(l.members), max: count(l.max), info: clean });
  }
  const full = (l: SteamLobbySummary) => l.max > 0 && l.members >= l.max;
  out.sort((a, b) => Number(a.info.phase === 'match') - Number(b.info.phase === 'match') || Number(full(a)) - Number(full(b)) || b.members - a.members || a.name.localeCompare(b.name));
  return out.slice(0, LOBBY_LIST_MAX);
}

/** The room code a lobby published, from a lobby list, or null. */
export function roomCodeFor(lobbyId: string, lobbies: readonly SteamLobbySummary[]): string | null {
  const code = lobbies.find((l) => l.id === lobbyId)?.info.room;
  return code && ROOM_CODE_RE.test(code) ? code : null;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(t: unknown): void;
  now(): number;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const t = globalThis.setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimeout: (t) => globalThis.clearTimeout(t as number),
  now: () => Date.now(),
};

/** Steam metadata writes at most this often; changes in between go out together. */
export const LOBBY_PUBLISH_MIN_MS = 1000;

/**
 * Publishes lobby info only when it changed since the last successful publish, at most once per
 * minIntervalMs (the newest info wins). A failed publish is tried again after the interval.
 */
export class LobbyInfoPublisher {
  private readonly publish: (info: LobbyInfo) => Promise<void>;
  private readonly minMs: number;
  private readonly timers: Timers;
  private last: LobbyInfo | null = null;
  private want: LobbyInfo | null = null;
  private sentAt = -Infinity;
  private timer: unknown = null;
  private busy = false;
  private stopped = false;
  /** wait before the next try after failed publishes (doubles, up to 30 s) */
  private backoff: number;
  /** publishes attempted (tests) */
  calls = 0;

  constructor(publish: (info: LobbyInfo) => Promise<void>, o: { minIntervalMs?: number; timers?: Timers } = {}) {
    this.publish = publish;
    this.minMs = o.minIntervalMs ?? LOBBY_PUBLISH_MIN_MS;
    this.timers = o.timers ?? realTimers;
    this.backoff = this.minMs;
  }

  /** The info Steam has (the last publish that succeeded). */
  get published(): LobbyInfo | null {
    return this.last;
  }

  update(info: LobbyInfo): void {
    if (this.stopped) return;
    this.want = { ...info };
    this.pump();
  }

  stop(): void {
    this.stopped = true;
    this.want = null;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private pump(): void {
    if (this.stopped || this.busy || this.timer !== null || !this.want) return;
    if (sameInfo(this.want, this.last)) {
      this.want = null;
      return;
    }
    const wait = this.sentAt + this.backoff - this.timers.now();
    if (wait > 0) {
      this.timer = this.timers.setTimeout(() => {
        this.timer = null;
        this.pump();
      }, wait);
      return;
    }
    const info = this.want;
    this.want = null;
    this.busy = true;
    this.sentAt = this.timers.now();
    this.calls++;
    let ok = false;
    void Promise.resolve()
      .then(() => this.publish(info))
      .then(() => (ok = true), () => (ok = false))
      .then(() => {
        this.busy = false;
        if (ok) {
          this.last = info;
          this.backoff = this.minMs;
        } else {
          if (!this.want) this.want = info; // try again after the interval, waiting longer each time
          this.backoff = Math.min(30_000, this.backoff * 2);
        }
        this.pump();
      });
  }
}
