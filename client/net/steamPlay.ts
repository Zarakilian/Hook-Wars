// Steam lobbies in the Steam build: host, browse, join, invite, leave (client/platform.ts SteamBridge).
//
//   Host : bridge.hostLobby starts the local game server and a Steam lobby and returns its ws url.
//          The page connects there, creates the room by itself (public on that server: the Steam
//          lobby type decides who can get in) and publishes the lobby info whenever the room changes.
//   Join : bridge.joinLobby sets up the P2P relay to the host and returns a local ws url. The page
//          connects there and joins the room by the code the lobby published (from the lobby list;
//          for an invite, by asking the host's server, which only has the lobby's room).
//   A friend's invite (bridge.onJoinRequest) joins at once from the menus or after a match; during a
//   live match it waits for the player to say yes (state.invite).
//   Leaving, or losing the host, always ends in 'idle', with the reason in state.error.
//
// The app owns the websocket (deps.connect / disconnect / send) and forwards every server message
// and the close of a Steam connection here. No DOM, so Node tests drive it with a stand-in bridge.
import type { ClientMsg, RoomState, ServerMsg } from '../../shared/protocol.ts';
import type { MatchConfig } from '../../shared/types.ts';
import type { SteamBridge, SteamLobbySummary, SteamPlayer } from '../platform.ts';
import { isPlainCloseText } from './connection.ts';
import { clampLobbyMax, cleanLobbyName, filterLobbies, LOBBY_ID_RE, lobbyInfoFor, LobbyInfoPublisher, pageLobbyInfo, realTimers, roomCodeFor, type Timers } from './steamLobby.ts';

export type SteamPhase = 'idle' | 'hosting' | 'joining' | 'lobby';

export interface SteamPlayState {
  /** the bridge is the stand-in (no Steam client) */
  fake: boolean;
  player: SteamPlayer | null;
  phase: SteamPhase;
  role: 'host' | 'joiner' | null;
  /** the Steam lobby we are in (or getting into) */
  lobbyId: string | null;
  lobbyName: string;
  /** the browser list, already filtered to Hook Wars lobbies of this version */
  lobbies: SteamLobbySummary[];
  listing: boolean;
  /** Date.now() of the last finished refresh (0 = never) */
  listedAt: number;
  /** why the last host, join or lobby ended, in words for the player */
  error: string | null;
  /** a friend's join request that arrived during a live match, waiting for an answer */
  invite: string | null;
  fullscreen: boolean;
}

export interface SteamPlayDeps {
  /** open the page's websocket to this url (replacing any other connection) */
  connect(url: string): void;
  /** close the page's Steam websocket on purpose (no error screen, no onClosed) */
  disconnect(): void;
  send(m: ClientMsg): void;
  /** the rules a hosted room starts with */
  roomConfig(maxPlayers: number): MatchConfig;
  /** a match is being played right now (not over) */
  inLiveMatch(): boolean;
  changed(s: SteamPlayState): void;
  toast?(text: string, kind: 'info' | 'error'): void;
  timers?: Timers;
}

/** Joining by invite with no published code: ask the host's server for its room this often. */
const FIND_ROOM_TRIES = 6;
const FIND_ROOM_EVERY_MS = 800;
/** Codes the server sends when a join or a create cannot happen. */
const JOIN_FAIL = new Set(['no_room', 'room_full', 'join_limit', 'version']);
const CREATE_FAIL = new Set(['rooms_per_ip', 'rooms_full', 'version']);

type Pending =
  | { kind: 'create'; name: string; config: MatchConfig }
  | { kind: 'join'; code: string }
  | { kind: 'find'; tries: number }
  | { kind: 'wait' } // the room request is sent, its answer not here yet
  | null;

function errText(prefix: string, err: unknown): string {
  const m = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  const clean = m.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 160);
  return clean ? `${prefix}: ${clean}` : `${prefix}.`;
}

function wsUrl(u: unknown): string | null {
  if (typeof u !== 'string' || u.length > 512) return null;
  try {
    const x = new URL(u);
    return x.protocol === 'ws:' || x.protocol === 'wss:' ? u : null;
  } catch {
    return null;
  }
}

export class SteamPlay {
  private readonly bridge: SteamBridge;
  private readonly deps: SteamPlayDeps;
  private readonly timers: Timers;
  private st: SteamPlayState;
  /** bumped by every host, join and leave: an older async step that finds it changed gives up */
  private gen = 0;
  private pending: Pending = null;
  private findTimer: unknown = null;
  private publisher: LobbyInfoPublisher | null = null;
  private unJoin: (() => void) | null = null;
  private listGen = 0;

  constructor(bridge: SteamBridge, deps: SteamPlayDeps) {
    this.bridge = bridge;
    this.deps = deps;
    this.timers = deps.timers ?? realTimers;
    this.st = {
      fake: bridge.fake === true,
      player: null,
      phase: 'idle',
      role: null,
      lobbyId: null,
      lobbyName: '',
      lobbies: [],
      listing: false,
      listedAt: 0,
      error: null,
      invite: null,
      fullscreen: false,
    };
  }

  state(): SteamPlayState {
    return this.st;
  }

  /** In a lobby, or on the way into one: the page's connection belongs to Steam play. */
  get active(): boolean {
    return this.st.phase !== 'idle';
  }

  private set(p: Partial<SteamPlayState>): void {
    this.st = { ...this.st, ...p };
    this.deps.changed(this.st);
  }

  /** Who we are on Steam, join requests from now on, the fullscreen state. */
  start(): void {
    this.unJoin = this.bridge.onJoinRequest((id) => this.joinRequest(id));
    void this.bridge.player().then(
      (p) => this.set({ player: { steamId: String(p.steamId).slice(0, 20), name: cleanLobbyName(p.name) || 'Steam player' } }),
      () => {},
    );
    void this.syncFullscreen();
  }

  dispose(): void {
    this.unJoin?.();
    this.unJoin = null;
    this.publisher?.stop();
    if (this.findTimer !== null) this.timers.clearTimeout(this.findTimer);
  }

  // ------------------------------------------------------------------------------------------
  // Lobby browser
  // ------------------------------------------------------------------------------------------

  async refresh(): Promise<void> {
    if (this.st.listing) return; // one list request at a time
    const g = ++this.listGen;
    this.set({ listing: true });
    try {
      const raw = await this.bridge.listLobbies();
      if (g !== this.listGen) return;
      this.set({ lobbies: filterLobbies(raw), listing: false, listedAt: Date.now() });
    } catch (err) {
      if (g !== this.listGen) return;
      // why a lobby just ended (leave() refreshes the list right after) matters more than a list that
      // did not load: a lost network fails both, and the reason must stay on screen
      this.set({ listing: false, listedAt: Date.now(), error: this.st.error ?? errText('Could not load the Steam lobby list', err) });
    }
  }

  // ------------------------------------------------------------------------------------------
  // Host
  // ------------------------------------------------------------------------------------------

  async host(o: { name: string; maxPlayers: number; isPrivate: boolean }): Promise<void> {
    if (this.st.phase === 'hosting' || this.st.phase === 'joining') return; // a double click
    if (this.st.phase === 'lobby') await this.leave();
    const max = clampLobbyMax(o.maxPlayers);
    const name = cleanLobbyName(o.name) || `${this.st.player?.name ?? 'Steam player'}'s lobby`.slice(0, 40);
    const gen = ++this.gen;
    this.set({ phase: 'hosting', role: 'host', lobbyId: null, lobbyName: name, error: null, invite: null });
    let res: { lobbyId: string; url: string };
    try {
      res = await this.bridge.hostLobby({ name, maxMembers: max, isPrivate: o.isPrivate === true });
    } catch (err) {
      if (gen === this.gen) this.set({ phase: 'idle', role: null, error: errText('Could not start a Steam lobby', err) });
      return;
    }
    if (gen !== this.gen) {
      // left (or started something else) while the lobby was being made: do not keep it
      this.dropStale();
      return;
    }
    const url = wsUrl(res?.url);
    if (!res || typeof res.lobbyId !== 'string' || !LOBBY_ID_RE.test(res.lobbyId) || !url) {
      void this.bridge.leaveLobby().catch(() => {});
      this.set({ phase: 'idle', role: null, error: 'Steam did not return a usable lobby. Try again.' });
      return;
    }
    this.pending = { kind: 'create', name, config: this.deps.roomConfig(max) };
    this.publisher?.stop();
    // game and v are the desktop app's own keys (set when it made the lobby): never sent from here
    this.publisher = new LobbyInfoPublisher((info) => this.bridge.setLobbyInfo(pageLobbyInfo(info)), { timers: this.timers });
    this.set({ lobbyId: res.lobbyId });
    this.deps.connect(url);
  }

  /**
   * A host or join answered after the player had moved on (left, or started another host or join).
   * When nothing newer is under way, leave that lobby. When something is, leave it alone: the desktop
   * app runs host, join and leave one after another and every host or join leaves the old lobby first,
   * so a leaveLobby sent now would run after the newer one and end the lobby the player is going to.
   */
  private dropStale(): void {
    if (this.st.phase === 'idle') void this.bridge.leaveLobby().catch(() => {});
  }

  // ------------------------------------------------------------------------------------------
  // Join
  // ------------------------------------------------------------------------------------------

  async join(lobbyId: string): Promise<void> {
    if (typeof lobbyId !== 'string' || !LOBBY_ID_RE.test(lobbyId)) return;
    if (this.st.lobbyId === lobbyId && this.st.phase !== 'idle') return; // already there or on the way
    if (this.st.phase !== 'idle') await this.leave();
    const gen = ++this.gen;
    let code = roomCodeFor(lobbyId, this.st.lobbies);
    const known = this.st.lobbies.find((l) => l.id === lobbyId);
    this.set({ phase: 'joining', role: 'joiner', lobbyId, lobbyName: known?.name ?? '', error: null, invite: null });
    let res: { url: string };
    try {
      res = await this.bridge.joinLobby(lobbyId);
    } catch (err) {
      if (gen === this.gen) this.set({ phase: 'idle', role: null, lobbyId: null, error: errText('Could not join that Steam lobby', err) });
      return;
    }
    if (gen !== this.gen) {
      this.dropStale();
      return;
    }
    const url = wsUrl(res?.url);
    if (!url) {
      void this.bridge.leaveLobby().catch(() => {});
      this.set({ phase: 'idle', role: null, lobbyId: null, error: 'Steam did not return a way to reach the host. Try again.' });
      return;
    }
    if (!code) {
      // an invite: the lobby was not in our list. Look it up; failing that, the host's server tells us.
      try {
        const list = filterLobbies(await this.bridge.listLobbies());
        if (gen !== this.gen) return;
        code = roomCodeFor(lobbyId, list);
        const l = list.find((x) => x.id === lobbyId);
        if (l) this.set({ lobbyName: l.name });
      } catch {
        // the host's server is asked below
      }
      if (gen !== this.gen) return;
    }
    this.pending = code ? { kind: 'join', code } : { kind: 'find', tries: 0 };
    this.deps.connect(url);
  }

  // ------------------------------------------------------------------------------------------
  // Invites
  // ------------------------------------------------------------------------------------------

  inviteFriends(): void {
    if (this.st.phase !== 'lobby') return;
    try {
      this.bridge.inviteFriends();
    } catch {
      this.deps.toast?.('The Steam overlay did not open. Is it turned on in Steam settings?', 'error');
    }
  }

  /** A join asked for from outside the game: a friend's invite, or "Join game" in Steam. */
  joinRequest(lobbyId: string): void {
    if (typeof lobbyId !== 'string' || !LOBBY_ID_RE.test(lobbyId)) return;
    if (this.st.lobbyId === lobbyId && this.st.phase !== 'idle') return;
    if (this.deps.inLiveMatch()) {
      this.set({ invite: lobbyId }); // the player says yes or no first
      return;
    }
    void this.join(lobbyId);
  }

  acceptInvite(): void {
    const id = this.st.invite;
    if (!id) return;
    this.set({ invite: null });
    void this.join(id);
  }

  dismissInvite(): void {
    if (this.st.invite) this.set({ invite: null });
  }

  // ------------------------------------------------------------------------------------------
  // Leave
  // ------------------------------------------------------------------------------------------

  /** Leave the lobby (and close its connection). error = why, shown on the Steam screen. */
  async leave(error: string | null = null): Promise<void> {
    const wasIn = this.st.phase !== 'idle' || this.st.lobbyId !== null;
    ++this.gen;
    this.pending = null;
    if (this.findTimer !== null) this.timers.clearTimeout(this.findTimer);
    this.findTimer = null;
    this.publisher?.stop();
    this.publisher = null;
    this.set({ phase: 'idle', role: null, lobbyId: null, error });
    if (!wasIn) return;
    try {
      this.deps.disconnect();
    } catch {
      // already closed
    }
    try {
      await this.bridge.leaveLobby();
    } catch {
      // Steam forgets a lobby we stopped talking to anyway
    }
    void this.refresh();
  }

  /**
   * The Steam connection closed without leave(): the host left, its server stopped, or the relay broke.
   * reason = the close frame's words. A joiner's relay (the desktop app) says what happened ("The host
   * left the lobby.", "The host dropped the connection (too many packets).", ...): those are shown as
   * they are, through textContent only; with none, a plain line.
   */
  onClosed(reason?: string): void {
    if (this.st.phase === 'idle') return;
    const said = (reason ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
    const own = said && !isPlainCloseText(said) ? said : '';
    const why = this.st.phase === 'lobby'
      ? this.st.role === 'host'
        ? 'Your lobby server stopped. Host a new lobby to keep playing.'
        : own || 'The host left, or the connection to the host was lost.'
      : this.st.role === 'host'
        ? `Your lobby server did not start${said ? ` (${said.slice(0, 80)})` : ''}.`
        : `Could not reach the host${said ? ` (${said.slice(0, 80)})` : ''}.`;
    void this.leave(why);
  }

  // ------------------------------------------------------------------------------------------
  // Server messages on the Steam connection
  // ------------------------------------------------------------------------------------------

  onServer(m: ServerMsg): void {
    if (this.st.phase === 'idle') return;
    switch (m.t) {
      case 'welcome': {
        const p = this.pending;
        if (!p) return;
        if (p.kind === 'create') {
          // public on the host's own server: only lobby members can reach it, and the lobby browser
          // and invites find it by the code we publish
          this.deps.send({ t: 'createRoom', name: p.name.slice(0, 28), isPrivate: false, config: p.config });
          this.pending = { kind: 'wait' };
        } else if (p.kind === 'join') {
          this.deps.send({ t: 'joinRoom', code: p.code });
          this.pending = { kind: 'wait' };
        } else if (p.kind === 'find') this.deps.send({ t: 'listRooms' });
        return;
      }
      case 'rooms': {
        const p = this.pending;
        if (!p || p.kind !== 'find') return;
        const room = m.rooms.find((r) => r.phase === 'lobby') ?? m.rooms[0];
        if (room) {
          this.deps.send({ t: 'joinRoom', code: room.code });
          this.pending = { kind: 'wait' };
          return;
        }
        if (p.tries + 1 >= FIND_ROOM_TRIES) {
          void this.leave('The host has not opened a room yet. Try again in a moment.');
          return;
        }
        this.pending = { kind: 'find', tries: p.tries + 1 };
        const gen = this.gen;
        this.findTimer = this.timers.setTimeout(() => {
          this.findTimer = null;
          if (gen === this.gen && this.pending?.kind === 'find') this.deps.send({ t: 'listRooms' });
        }, FIND_ROOM_EVERY_MS);
        return;
      }
      case 'room':
        this.onRoom(m.room);
        return;
      case 'error': {
        const p = this.pending;
        if (!p || this.st.phase === 'lobby') return;
        const fail = this.st.role === 'host' ? CREATE_FAIL.has(m.code) : JOIN_FAIL.has(m.code);
        if (fail) void this.leave(m.code === 'room_full' ? 'That lobby is full.' : m.message);
        return;
      }
      default:
        return;
    }
  }

  private onRoom(room: RoomState): void {
    if (this.st.phase === 'hosting' || this.st.phase === 'joining') {
      this.pending = null;
      this.set({ phase: 'lobby', lobbyName: this.st.lobbyName || room.name });
    }
    if (this.st.role === 'host' && this.publisher) this.publisher.update(lobbyInfoFor(room, this.st.lobbyName));
  }

  // ------------------------------------------------------------------------------------------
  // Fullscreen (the desktop window)
  // ------------------------------------------------------------------------------------------

  async syncFullscreen(): Promise<boolean> {
    try {
      const on = (await this.bridge.isFullscreen()) === true;
      if (on !== this.st.fullscreen) this.set({ fullscreen: on });
      return on;
    } catch {
      return this.st.fullscreen;
    }
  }

  setFullscreen(on: boolean): void {
    try {
      this.bridge.setFullscreen(on);
    } catch {
      return;
    }
    this.set({ fullscreen: on });
  }
}
