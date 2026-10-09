// The Steam side of the desktop app, without Electron: what each SteamBridge call (client/platform.ts)
// does in the main process. main.ts forwards the page's IPC calls here unchanged; every argument is
// checked here (./validate.ts) before it is used.
//
//   hostLobby  start the local game server (./serverLauncher.ts), create the Steam lobby
//              (./lobbyManager.ts) and relay remote members to the server (./hostRelay.ts)
//   joinLobby  join the lobby and run the local relay the page connects to (./joinerRelay.ts)
//   leaveLobby leave; as host this ends the joiners cleanly and stops the local server
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SteamLobbySummary, SteamPlayer } from '../../client/platform.ts';
import { HostRelay } from './hostRelay.ts';
import { HOST_LEFT_CODE, HOST_LOST_CODE, JoinerRelay } from './joinerRelay.ts';
import { LobbyManager } from './lobbyManager.ts';
import { ServerLauncher, type EconomyMode, type SpawnServer } from './serverLauncher.ts';
import type { SteamBackend } from './steamBackend.ts';
import * as check from './validate.ts';

export interface DesktopBridgeOptions {
  backend: SteamBackend;
  spawnServer: SpawnServer;
  /** this player's app data folder (the server gets an empty static folder and a data folder inside it) */
  dataDir: string;
  economy?: EconomyMode;
  /** a join asked for from outside the game (Steam invite, "Join game") */
  onJoinRequest?: (lobbyId: string) => void;
  log?: (s: string) => void;
  /** how long the host waits after telling the joiners it is leaving before it stops the server */
  leaveFlushMs?: number;
}

type Role =
  | { kind: 'host'; lobbyId: string; relay: HostRelay; launcher: ServerLauncher; url: string }
  | { kind: 'member'; lobbyId: string; relay: JoinerRelay; hostId: string };

const HOST_LEAVING = 'The host left the lobby.';
/** retries for a session request from someone Steam has not shown in our lobby yet */
const MEMBER_RECHECK_MS = [300, 1000, 2500];

function unwrap<T>(c: check.Checked<T>): T {
  if (!c.ok) throw new Error(c.error);
  return c.value;
}

export class DesktopBridge {
  private readonly backend: SteamBackend;
  private readonly spawnServer: SpawnServer;
  private readonly dataDir: string;
  private readonly economy: EconomyMode;
  private readonly log: (s: string) => void;
  private readonly leaveFlushMs: number;
  private readonly lobbies: LobbyManager;
  private readonly offs: (() => void)[] = [];
  private role: Role | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  onJoinRequest: ((lobbyId: string) => void) | null;

  constructor(opts: DesktopBridgeOptions) {
    this.backend = opts.backend;
    this.spawnServer = opts.spawnServer;
    this.dataDir = opts.dataDir;
    this.economy = opts.economy ?? 'trust';
    this.log = opts.log ?? ((s) => console.log(s));
    this.leaveFlushMs = opts.leaveFlushMs ?? 300;
    this.onJoinRequest = opts.onJoinRequest ?? null;
    this.lobbies = new LobbyManager(this.backend, {
      onHostLeft: (reason) => {
        const r = this.role;
        if (r?.kind !== 'member') return;
        this.role = null;
        r.relay.end(HOST_LEFT_CODE, reason);
      },
      onMemberLeft: (id) => {
        const r = this.role;
        if (r?.kind !== 'host') return;
        r.relay.dropPeer(id, 'left the lobby');
        this.backend.closeSession(id);
      },
      onMemberJoined: (id) => {
        // accept their packets now: their first Open may beat Steam's session request
        if (this.role?.kind === 'host') this.backend.acceptSession(id);
      },
    });
    const b = this.backend;
    this.offs.push(
      b.on('packet', (from, data) => this.role?.relay.onPacket(from, data)),
      b.on('sessionRequest', (from) => this.onSessionRequest(from, 0)),
      b.on('sessionFailed', (from) => {
        const r = this.role;
        if (r?.kind === 'host') r.relay.dropPeer(from, 'Steam could not reach them');
        else if (r?.kind === 'member' && from === r.hostId) {
          this.role = null;
          r.relay.end(HOST_LOST_CODE, 'Lost the connection to the host.');
          this.lobbies.leave();
        }
      }),
      b.on('joinRequested', (id) => {
        if (check.lobbyId(id).ok) this.onJoinRequest?.(id);
      }),
      b.on('disconnected', (reason) => {
        const r = this.role;
        if (r?.kind === 'member') {
          this.role = null;
          r.relay.end(HOST_LOST_CODE, 'Lost the connection to the host.');
        } else if (r?.kind === 'host') {
          this.log(`[steam] lost Steam (${reason}): remote players are cut off; the local match keeps running`);
          r.relay.close('The host lost its connection to Steam.');
        }
      }),
    );
  }

  /** One host/join/leave at a time, in call order (a double click must not start two servers). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  private onSessionRequest(from: string, attempt: number): void {
    const r = this.role;
    if (!r) return;
    if (r.kind === 'member') {
      if (from === r.hostId) this.backend.acceptSession(from);
      return;
    }
    if (this.lobbies.isMember(from) && from !== this.backend.me().steamId) {
      this.backend.acceptSession(from);
      return;
    }
    const wait = MEMBER_RECHECK_MS[attempt];
    if (wait !== undefined) setTimeout(() => this.role === r && this.onSessionRequest(from, attempt + 1), wait).unref?.();
  }

  get info(): { appId: number; fake: boolean } {
    return { appId: this.backend.appId, fake: this.backend.fake };
  }

  /** Which lobby we are in, and as what (for logs and tests). */
  get state(): { kind: 'host' | 'member'; lobbyId: string; url: string } | null {
    const r = this.role;
    if (!r) return null;
    return { kind: r.kind, lobbyId: r.lobbyId, url: r.kind === 'host' ? r.url : r.relay.url };
  }

  /** The host's relay (tests read its per-peer byte counts). */
  get hostRelay(): HostRelay | null {
    return this.role?.kind === 'host' ? this.role.relay : null;
  }

  async player(): Promise<SteamPlayer> {
    return this.backend.me();
  }

  async hostLobby(raw: unknown): Promise<{ lobbyId: string; url: string }> {
    const opts = unwrap(check.hostOpts(raw));
    return this.serial(async () => {
      await this.leaveNow();
      const staticDir = join(this.dataDir, 'server-static');
      const serverData = join(this.dataDir, 'server-data');
      mkdirSync(staticDir, { recursive: true });
      mkdirSync(serverData, { recursive: true });
      const launcher = new ServerLauncher({ spawn: this.spawnServer, serverName: opts.name, economy: this.economy, staticDir, dataDir: serverData, log: this.log });
      const url = await launcher.start();
      let lobbyId: string;
      try {
        lobbyId = (await this.lobbies.create(opts)).id;
      } catch (err) {
        await launcher.stop();
        throw err;
      }
      const me = this.backend.me().steamId;
      const relay = new HostRelay({
        serverUrl: url,
        relaySecret: launcher.secret,
        send: (to, p) => this.backend.sendPacket(to, p),
        isMember: (id) => id !== me && this.lobbies.isMember(id),
        log: this.log,
      });
      const role: Role = { kind: 'host', lobbyId, relay, launcher, url };
      launcher.onRestart = (u) => {
        relay.setServerUrl(u);
        role.url = u;
      };
      launcher.onFailed = (reason) => {
        this.log(`[server] ${reason}`);
        if (this.role !== role) return;
        void this.serial(() => this.leaveNow(`The host's game server stopped. ${reason}`));
      };
      this.role = role;
      this.log(`[steam] hosting lobby ${lobbyId} on ${url}`);
      return { lobbyId, url };
    });
  }

  async joinLobby(raw: unknown): Promise<{ url: string }> {
    const id = unwrap(check.lobbyId(raw));
    return this.serial(async () => {
      const r = this.role;
      if (r?.kind === 'member' && r.lobbyId === id && !r.relay.isEnded) return { url: r.relay.url };
      await this.leaveNow();
      const cur = await this.lobbies.join(id);
      this.backend.acceptSession(cur.hostId);
      const relay = new JoinerRelay({ hostId: cur.hostId, send: (to, p) => this.backend.sendPacket(to, p), log: this.log });
      const role: Role = { kind: 'member', lobbyId: id, relay, hostId: cur.hostId };
      relay.onEnded = () => {
        if (this.role !== role) return;
        this.role = null;
        this.lobbies.leave();
      };
      let url: string;
      try {
        url = await relay.start();
      } catch (err) {
        this.lobbies.leave();
        throw err;
      }
      this.role = role;
      this.log(`[steam] joined lobby ${id} (host ${cur.hostId}); page relay on 127.0.0.1`);
      return { url };
    });
  }

  leaveLobby(): Promise<void> {
    return this.serial(() => this.leaveNow());
  }

  private async leaveNow(reason = HOST_LEAVING): Promise<void> {
    const r = this.role;
    this.role = null;
    if (!r) {
      this.lobbies.leave();
      return;
    }
    if (r.kind === 'member') {
      r.relay.close();
      this.lobbies.leave();
      return;
    }
    r.relay.close(reason, this.lobbies.members());
    this.lobbies.leave();
    r.launcher.onFailed = null;
    r.launcher.onRestart = null;
    // give the Byes a moment on the wire before the server (and every relayed socket) goes
    if (this.leaveFlushMs > 0) await new Promise((res) => setTimeout(res, this.leaveFlushMs));
    await r.launcher.stop();
  }

  listLobbies(): Promise<SteamLobbySummary[]> {
    return this.lobbies.list();
  }

  async setLobbyInfo(raw: unknown): Promise<void> {
    const info = unwrap(check.lobbyInfo(raw));
    if (this.role?.kind !== 'host') throw new Error('Only the host of a lobby can set its details.');
    if (!this.lobbies.publish(info)) throw new Error('Steam would not store the lobby details.');
  }

  inviteFriends(): void {
    const r = this.role;
    if (r) this.backend.openInviteDialog(r.lobbyId);
  }

  async cloudRead(rawName: unknown): Promise<string | null> {
    return this.backend.cloudRead(unwrap(check.cloudName(rawName)));
  }

  async cloudWrite(rawName: unknown, rawData: unknown): Promise<boolean> {
    const name = unwrap(check.cloudName(rawName));
    const data = unwrap(check.cloudData(rawData));
    return this.backend.cloudWrite(name, data);
  }

  openOverlayUrl(raw: unknown): void {
    this.backend.openOverlayUrl(unwrap(check.overlayUrl(raw)));
  }

  /** App quit: leave without waiting, stop the server, close Steam. */
  async shutdown(): Promise<void> {
    const r = this.role;
    this.role = null;
    if (r?.kind === 'host') {
      r.relay.close(HOST_LEAVING, this.lobbies.members());
      r.launcher.onFailed = null;
      await r.launcher.stop(1500);
    } else if (r?.kind === 'member') r.relay.close();
    for (const off of this.offs.splice(0)) off();
    this.lobbies.dispose();
    this.backend.close();
  }
}

/**
 * Join requests that arrive before the page listens (Steam started us with +connect_lobby, or an
 * invite came in while the page was loading) wait here until the page subscribes.
 */
export class JoinRequestQueue {
  private pending: string | null = null;
  private listening = false;
  private readonly deliver: (lobbyId: string) => void;

  constructor(deliver: (lobbyId: string) => void) {
    this.deliver = deliver;
  }

  push(lobbyId: string): void {
    if (!check.lobbyId(lobbyId).ok) return;
    if (this.listening) this.deliver(lobbyId);
    else this.pending = lobbyId; // only the newest request matters
  }

  /** The page subscribed: hand over what waited, deliver the rest directly. */
  take(): string | null {
    this.listening = true;
    const p = this.pending;
    this.pending = null;
    return p;
  }

  /** The page is (re)loading: hold requests again until it subscribes. */
  reset(): void {
    this.listening = false;
  }
}
