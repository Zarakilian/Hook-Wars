// The real Steam, through steamworks.js (npm, MIT, by ceifa). Kept thin: it maps the SteamBackend
// interface onto the steamworks.js calls one to one, converts ids between bigint and decimal strings,
// and polls on timers: Steam callbacks about 30 times a second and the P2P packet queue every few ms.
//
// The module is loaded by the caller (main.ts uses require from the app folder) and handed in, so this
// file has no import of steamworks.js and runs in the tests against a stand-in object of the same shape.
// The shapes below are the parts of steamworks.js 0.4.0's client.d.ts this app uses.
import { Emitter, type BackendEvents, type LobbyListing, type LobbyVisibility, type SteamBackend } from './steamBackend.ts';

/** steamworks.js `SteamId` / `PlayerSteamId` */
export interface SwSteamId {
  steamId64: bigint;
}

export interface SwLobby {
  readonly id: bigint;
  join(): Promise<SwLobby>;
  leave(): void;
  openInviteDialog(): void;
  getMembers(): SwSteamId[];
  getOwner(): SwSteamId;
  getMemberCount(): bigint | number;
  getMemberLimit(): bigint | number | null;
  getData(key: string): string | null;
  setData(key: string, value: string): boolean;
  getFullData(): Record<string, string>;
  mergeFullData(data: Record<string, string>): boolean;
  setJoinable(joinable: boolean): boolean;
}

export interface SwClient {
  localplayer: { getSteamId(): SwSteamId; getName(): string };
  matchmaking: {
    createLobby(type: number, maxMembers: number): Promise<SwLobby>;
    joinLobby(lobbyId: bigint): Promise<SwLobby>;
    getLobbies(): Promise<SwLobby[]>;
  };
  networking: {
    sendP2PPacket(steamId64: bigint, sendType: number, data: Buffer): boolean;
    isP2PPacketAvailable(): number;
    readP2PPacket(size: number): { data: Buffer; size?: number; steamId: SwSteamId };
    acceptP2PSession(steamId64: bigint): void;
  };
  cloud: { readFile(name: string): string; writeFile(name: string, content: string): boolean; fileExists(name: string): boolean };
  overlay: { activateToWebPage(url: string): void; activateInviteDialog(lobbyId: bigint): void };
  callback: { register(event: number, handler: (value: unknown) => void): { disconnect(): void } };
}

export interface SwModule {
  init(appId?: number): SwClient;
  runCallbacks?: () => void;
  electronEnableSteamOverlay?: (disableEachFrameInvalidation?: boolean) => void;
  SteamCallback?: Record<string, number>;
}

/** matchmaking.LobbyType in steamworks.js (a const enum in the .d.ts, so the numbers are copied here). */
export const LOBBY_TYPE = { Private: 0, FriendsOnly: 1, Public: 2, Invisible: 3 } as const;
/** networking.SendType: Reliable is ordered and retransmitted. */
export const SEND_RELIABLE = 2;
/**
 * callback.SteamCallback ids, used when the module does not export the enum object at run time
 * (0.4.0's index.js does export it as SteamCallback). Checked against the published 0.4.0
 * client.d.ts and callbacks.d.ts on 2026-10-09, including the payload field names used below.
 */
export const STEAM_CALLBACK_FALLBACK = {
  LobbyDataUpdate: 4,
  LobbyChatUpdate: 5,
  P2PSessionRequest: 6,
  P2PSessionConnectFail: 7,
  GameLobbyJoinRequested: 8,
} as const;
type CallbackName = keyof typeof STEAM_CALLBACK_FALLBACK;

const PACKET_POLL_MS = 4;
const CALLBACK_POLL_MS = 33;
/** packets read per poll at most, so one flood cannot stall the main process */
const MAX_READS_PER_POLL = 512;
const MAX_PACKET = 512 * 1024;

/** A steamworks.js id value (a bigint, a number, a decimal string or a SteamId object) as a decimal string. */
export function idString(v: unknown): string | null {
  if (typeof v === 'bigint') return v > 0n ? v.toString() : null;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return String(v);
  if (typeof v === 'string' && /^[1-9]\d{0,19}$/.test(v)) return v;
  if (typeof v === 'object' && v !== null && 'steamId64' in v) return idString((v as SwSteamId).steamId64);
  return null;
}

/** The first field of a callback payload that holds an id (steamworks.js uses snake_case names). */
function field(payload: unknown, names: string[]): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  for (const n of names) {
    const id = idString((payload as Record<string, unknown>)[n]);
    if (id) return id;
  }
  return null;
}

export interface SteamworksOptions {
  module: SwModule;
  appId?: number;
  log?: (s: string) => void;
}

export class SteamworksBackend implements SteamBackend {
  readonly appId: number;
  readonly fake = false;
  private readonly sw: SwModule;
  private readonly client: SwClient;
  private readonly log: (s: string) => void;
  private readonly events = new Emitter<BackendEvents>();
  private readonly lobbies = new Map<string, SwLobby>();
  /** lobbies we created or joined (their objects are the only ones the map above keeps) */
  private readonly joined = new Set<string>();
  private readonly handles: { disconnect(): void }[] = [];
  private readonly packetTimer: ReturnType<typeof setInterval>;
  private readonly callbackTimer: ReturnType<typeof setInterval> | null;
  private closed = false;

  /** Throws when Steam is not running (the caller falls back to the stand-in). */
  constructor(opts: SteamworksOptions) {
    this.sw = opts.module;
    this.log = opts.log ?? ((s) => console.log(s));
    this.client = this.sw.init(opts.appId);
    this.appId = opts.appId ?? 0;
    this.register('P2PSessionRequest', (p) => {
      const from = field(p, ['remote', 'steam_id_remote', 'steamIDRemote']);
      if (from) this.events.emit('sessionRequest', from);
    });
    this.register('P2PSessionConnectFail', (p) => {
      const from = field(p, ['remote', 'steam_id_remote', 'steamIDRemote']);
      if (from) this.events.emit('sessionFailed', from);
    });
    this.register('LobbyChatUpdate', (p) => {
      const lobby = field(p, ['lobby', 'steam_id_lobby', 'lobby_id']);
      if (lobby) this.events.emit('lobbyChanged', lobby);
    });
    this.register('LobbyDataUpdate', (p) => {
      const lobby = field(p, ['lobby', 'steam_id_lobby', 'lobby_id']);
      if (lobby) this.events.emit('lobbyChanged', lobby);
    });
    this.register('GameLobbyJoinRequested', (p) => {
      const lobby = field(p, ['lobby_steam_id', 'steam_id_lobby', 'lobby']);
      if (lobby) this.events.emit('joinRequested', lobby);
    });
    this.packetTimer = setInterval(() => this.readPackets(), PACKET_POLL_MS);
    // steamworks.js 0.4.0's init() already runs callbacks 30 times a second and does not export
    // runCallbacks, so this timer only starts with a build of the module that leaves that to us
    this.callbackTimer = typeof this.sw.runCallbacks === 'function' ? setInterval(() => this.sw.runCallbacks?.(), CALLBACK_POLL_MS) : null;
  }

  private register(name: CallbackName, handler: (payload: unknown) => void): void {
    const id = this.sw.SteamCallback?.[name] ?? STEAM_CALLBACK_FALLBACK[name];
    try {
      this.handles.push(this.client.callback.register(id, handler));
    } catch (err) {
      this.log(`[steam] could not register ${name}: ${(err as Error).message}`);
    }
  }

  private readPackets(): void {
    if (this.closed) return;
    for (let n = 0; n < MAX_READS_PER_POLL; n++) {
      let size: number;
      try {
        size = this.client.networking.isP2PPacketAvailable();
      } catch {
        return;
      }
      if (!size || size <= 0) return;
      let pkt: { data: Buffer; steamId: SwSteamId };
      try {
        pkt = this.client.networking.readP2PPacket(size);
      } catch {
        return;
      }
      const from = idString(pkt?.steamId);
      if (!from || !pkt.data || pkt.data.length > MAX_PACKET) continue;
      this.events.emit('packet', from, Buffer.from(pkt.data));
    }
  }

  me() {
    const p = this.client.localplayer;
    return { steamId: idString(p.getSteamId()) ?? '0', name: String(p.getName() ?? '').slice(0, 64) };
  }

  async createLobby(visibility: LobbyVisibility, maxMembers: number): Promise<string> {
    const lobby = await this.client.matchmaking.createLobby(visibility === 'public' ? LOBBY_TYPE.Public : LOBBY_TYPE.Private, maxMembers);
    const id = idString(lobby.id);
    if (!id) throw new Error('Steam returned a lobby without an id.');
    this.lobbies.set(id, lobby);
    this.joined.add(id);
    return id;
  }

  async joinLobby(lobbyId: string): Promise<void> {
    const lobby = await this.client.matchmaking.joinLobby(BigInt(lobbyId));
    this.lobbies.set(lobbyId, lobby);
    this.joined.add(lobbyId);
  }

  leaveLobby(lobbyId: string): void {
    const lobby = this.lobbies.get(lobbyId);
    this.lobbies.delete(lobbyId);
    if (!this.joined.delete(lobbyId)) return;
    try {
      lobby?.leave();
    } catch (err) {
      this.log(`[steam] leaving lobby ${lobbyId}: ${(err as Error).message}`);
    }
  }

  async listLobbies(): Promise<LobbyListing[]> {
    const found = await this.client.matchmaking.getLobbies();
    const out: LobbyListing[] = [];
    for (const l of found) {
      const id = idString(l.id);
      if (!id) continue;
      // not kept: joining goes through matchmaking.joinLobby, and keeping every listed lobby of the
      // shared app 480 would grow this map with each refresh
      let data: Record<string, string> = {};
      try {
        data = l.getFullData() ?? {};
      } catch {
        // a lobby whose data did not arrive: skip its details
      }
      out.push({ id, owner: idString(safe(() => l.getOwner())) ?? '', members: Number(safe(() => l.getMemberCount()) ?? 0), max: Number(safe(() => l.getMemberLimit()) ?? 0), data });
    }
    return out;
  }

  lobbyOwner(lobbyId: string): string | null {
    const l = this.lobbies.get(lobbyId);
    return l ? idString(safe(() => l.getOwner())) : null;
  }

  lobbyMembers(lobbyId: string): string[] {
    const l = this.lobbies.get(lobbyId);
    if (!l) return [];
    return (safe(() => l.getMembers()) ?? []).map((m) => idString(m)).filter((s): s is string => s !== null);
  }

  lobbyMemberLimit(lobbyId: string): number {
    const l = this.lobbies.get(lobbyId);
    return l ? Number(safe(() => l.getMemberLimit()) ?? 0) : 0;
  }

  lobbyData(lobbyId: string): Record<string, string> {
    const l = this.lobbies.get(lobbyId);
    return (l && safe(() => l.getFullData())) || {};
  }

  setLobbyData(lobbyId: string, data: Record<string, string>): boolean {
    const l = this.lobbies.get(lobbyId);
    return !!l && safe(() => l.mergeFullData(data)) === true;
  }

  setLobbyJoinable(lobbyId: string, joinable: boolean): void {
    const l = this.lobbies.get(lobbyId);
    if (l) safe(() => l.setJoinable(joinable));
  }

  openInviteDialog(lobbyId: string): void {
    safe(() => this.client.overlay.activateInviteDialog(BigInt(lobbyId)));
  }

  sendPacket(to: string, data: Buffer): boolean {
    if (this.closed) return false;
    return safe(() => this.client.networking.sendP2PPacket(BigInt(to), SEND_RELIABLE, data)) === true;
  }

  acceptSession(from: string): void {
    safe(() => this.client.networking.acceptP2PSession(BigInt(from)));
  }

  closeSession(_with: string): void {
    // steamworks.js 0.4.0 has no CloseP2PSessionWithUser; Steam ends idle sessions by itself
  }

  /**
   * null only when the file is not there. A failure throws: the page reads null as "no Cloud copy
   * yet" and uploads its own locker over it, so an error must never look like a missing file.
   */
  cloudRead(name: string): string | null {
    const c = this.client.cloud;
    let exists: boolean;
    let v: unknown;
    try {
      exists = c.fileExists(name);
      if (!exists) return null;
      v = c.readFile(name);
    } catch (err) {
      throw new Error(`Steam Cloud could not read ${name}: ${(err as Error).message}`);
    }
    if (typeof v !== 'string') throw new Error(`Steam Cloud could not read ${name}`);
    return v;
  }

  cloudWrite(name: string, data: string): boolean {
    return safe(() => this.client.cloud.writeFile(name, data)) === true;
  }

  openOverlayUrl(url: string): void {
    safe(() => this.client.overlay.activateToWebPage(url));
  }

  on<E extends keyof BackendEvents>(event: E, cb: BackendEvents[E]): () => void {
    return this.events.on(event, cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.packetTimer);
    if (this.callbackTimer) clearInterval(this.callbackTimer);
    for (const id of [...this.joined]) this.leaveLobby(id);
    for (const h of this.handles.splice(0)) safe(() => h.disconnect());
    this.events.clear();
  }
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
