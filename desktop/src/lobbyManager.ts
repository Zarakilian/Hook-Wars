// Steam lobbies for Hook Wars, over any SteamBackend: create (with the metadata every Hook Wars lobby
// carries), join (refusing other games and other versions), leave, list (filtered: app 480 is shared
// by every Steamworks developer), publish metadata (host only), and watch for the host leaving.
//
// Steam hands a lobby to another member when its owner leaves. The game server runs on the ORIGINAL
// host's machine, so for a member the host is the owner at join time, and an ownership change means
// the host left.
import type { SteamLobbySummary } from '../../client/platform.ts';
import {
  LOBBY_GAME_KEY,
  LOBBY_GAME_VALUE,
  LOBBY_VERSION_KEY,
  LOBBY_VERSION_VALUE,
  MAX_LOBBY_MEMBERS,
  MIN_LOBBY_MEMBERS,
  RESERVED_LOBBY_KEYS,
} from './constants.ts';
import type { LobbyListing, SteamBackend } from './steamBackend.ts';

export interface CurrentLobby {
  id: string;
  role: 'host' | 'member';
  /** SteamID of the player whose machine runs the game server */
  hostId: string;
}

export class LobbyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LobbyError';
    this.code = code;
  }
}

export interface LobbyManagerEvents {
  /** member side: the host left, or the lobby is gone */
  onHostLeft?: (reason: string) => void;
  /** host side: a member left (close their relayed connections) */
  onMemberLeft?: (steamId: string) => void;
  /** host side: a member joined */
  onMemberJoined?: (steamId: string) => void;
}

/** The lobby metadata the desktop app writes for a new lobby. */
export function baseLobbyData(name: string, hostName: string, max: number): Record<string, string> {
  return {
    [LOBBY_GAME_KEY]: LOBBY_GAME_VALUE,
    [LOBBY_VERSION_KEY]: LOBBY_VERSION_VALUE,
    name,
    host: hostName,
    max: String(max),
    phase: 'lobby',
  };
}

/** Is this a Hook Wars lobby of our protocol version? */
export function isOurLobby(data: Record<string, string>): boolean {
  return data[LOBBY_GAME_KEY] === LOBBY_GAME_VALUE && data[LOBBY_VERSION_KEY] === LOBBY_VERSION_VALUE;
}

export function toSummary(l: LobbyListing): SteamLobbySummary {
  return {
    id: l.id,
    name: (l.data.name ?? '').slice(0, 64) || 'Hook Wars lobby',
    host: (l.data.host ?? '').slice(0, 64),
    members: l.members,
    max: l.max,
    info: { ...l.data },
  };
}

export class LobbyManager {
  private readonly backend: SteamBackend;
  private readonly events: LobbyManagerEvents;
  private cur: CurrentLobby | null = null;
  private knownMembers = new Set<string>();
  private readonly offChanged: () => void;

  constructor(backend: SteamBackend, events: LobbyManagerEvents = {}) {
    this.backend = backend;
    this.events = events;
    this.offChanged = backend.on('lobbyChanged', (id) => this.onChanged(id));
  }

  get current(): CurrentLobby | null {
    return this.cur;
  }

  isMember(steamId: string): boolean {
    return !!this.cur && this.backend.lobbyMembers(this.cur.id).includes(steamId);
  }

  members(): string[] {
    return this.cur ? this.backend.lobbyMembers(this.cur.id) : [];
  }

  async create(opts: { name: string; maxMembers: number; isPrivate: boolean }): Promise<CurrentLobby> {
    if (this.cur) this.leave();
    const max = Math.max(MIN_LOBBY_MEMBERS, Math.min(MAX_LOBBY_MEMBERS, Math.floor(opts.maxMembers)));
    const id = await this.backend.createLobby(opts.isPrivate ? 'private' : 'public', max);
    const me = this.backend.me();
    this.cur = { id, role: 'host', hostId: me.steamId };
    this.knownMembers = new Set([me.steamId]);
    if (!this.backend.setLobbyData(id, baseLobbyData(opts.name, me.name, max))) {
      this.leave();
      throw new LobbyError('metadata', 'Steam would not store the lobby details.');
    }
    return this.cur;
  }

  async join(lobbyId: string): Promise<CurrentLobby> {
    if (this.cur?.id === lobbyId) return this.cur;
    if (this.cur) this.leave();
    await this.backend.joinLobby(lobbyId);
    const fail = (code: string, message: string): never => {
      this.backend.leaveLobby(lobbyId);
      throw new LobbyError(code, message);
    };
    const data = this.backend.lobbyData(lobbyId);
    if (data[LOBBY_GAME_KEY] !== LOBBY_GAME_VALUE) fail('not_hookwars', 'That is not a Hook Wars lobby.');
    if (data[LOBBY_VERSION_KEY] !== LOBBY_VERSION_VALUE) fail('version', 'That lobby runs a different version of Hook Wars. Update the game (or ask the host to).');
    const owner = this.backend.lobbyOwner(lobbyId);
    const me = this.backend.me().steamId;
    if (!owner) fail('no_owner', 'That lobby has no host.');
    if (owner === me) fail('own', 'That is your own lobby.');
    this.cur = { id: lobbyId, role: 'member', hostId: owner! };
    this.knownMembers = new Set(this.backend.lobbyMembers(lobbyId));
    return this.cur;
  }

  leave(): void {
    const c = this.cur;
    this.cur = null;
    this.knownMembers.clear();
    if (c) this.backend.leaveLobby(c.id);
  }

  /** Hook Wars lobbies of this version, plus the one we are in (private lobbies are never listed by Steam). */
  async list(): Promise<SteamLobbySummary[]> {
    const all = await this.backend.listLobbies();
    const ours = all.filter((l) => isOurLobby(l.data));
    const cur = this.cur;
    if (cur && !ours.some((l) => l.id === cur.id)) {
      const data = this.backend.lobbyData(cur.id);
      if (isOurLobby(data)) {
        ours.unshift({ id: cur.id, owner: cur.hostId, members: this.backend.lobbyMembers(cur.id).length, max: this.backend.lobbyMemberLimit(cur.id), data });
      }
    }
    return ours.map(toSummary);
  }

  /** Host only: publish metadata for the lobby browser. The reserved keys stay as the app set them. */
  publish(info: Record<string, string>): boolean {
    const c = this.cur;
    if (!c || c.role !== 'host') return false;
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(info)) if (!RESERVED_LOBBY_KEYS.includes(k)) clean[k] = v;
    if (Object.keys(clean).length === 0) return true;
    return this.backend.setLobbyData(c.id, clean);
  }

  setJoinable(joinable: boolean): void {
    if (this.cur?.role === 'host') this.backend.setLobbyJoinable(this.cur.id, joinable);
  }

  private onChanged(lobbyId: string): void {
    const c = this.cur;
    if (!c || c.id !== lobbyId) return;
    const members = this.backend.lobbyMembers(lobbyId);
    const me = this.backend.me().steamId;
    if (c.role === 'member') {
      const owner = this.backend.lobbyOwner(lobbyId);
      if (!members.includes(me)) return this.hostLeft('You are no longer in the lobby.');
      if (owner !== c.hostId || !members.includes(c.hostId)) return this.hostLeft('The host left the lobby.');
      this.knownMembers = new Set(members);
      return;
    }
    const now = new Set(members);
    for (const id of this.knownMembers) if (!now.has(id) && id !== me) this.events.onMemberLeft?.(id);
    for (const id of now) if (!this.knownMembers.has(id) && id !== me) this.events.onMemberJoined?.(id);
    this.knownMembers = now;
  }

  private hostLeft(reason: string): void {
    const c = this.cur;
    this.cur = null;
    this.knownMembers.clear();
    if (c) this.backend.leaveLobby(c.id);
    this.events.onHostLeft?.(reason);
  }

  dispose(): void {
    this.offChanged();
    this.leave();
  }
}
