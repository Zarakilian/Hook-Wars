// FakeSteam: a stand-in for Steam lobbies, P2P packets and Steam Cloud, so the desktop app runs and is
// tested without a Steam client. Two or more app windows on ONE machine meet through a small hub:
//   FakeHub           the shared state (players, lobbies) and packet routing; pure logic
//   FakeHubServer     the hub on a 127.0.0.1 TCP port (default 27999). The first app window that finds
//                     no hub starts one; the others connect to it. Messages are length-prefixed JSON.
//   memoryLink(hub)   an in-process link for tests
//   FakeSteamBackend  the SteamBackend the app uses, over either link
// The hub copies the semantics the app relies on: the sender of a packet is the hub's record of who
// sent it (never the packet's claim), lobby data is owner-only, a lobby passes to the next member when
// its owner leaves, and a packet from someone you have no session with waits for acceptSession.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { DEV_APP_ID, isSteamId64 } from './constants.ts';
import { Emitter, type BackendEvents, type LobbyListing, type LobbyVisibility, type SteamBackend } from './steamBackend.ts';

export const DEFAULT_HUB_PORT = 27999;
const MAX_HUB_FRAME = 1024 * 1024;
const MAX_PACKET_B64 = Math.ceil((300 * 1024 * 4) / 3);
const MAX_DATA_KEYS = 64;
const MAX_KEY_LEN = 255;
const MAX_VALUE_LEN = 8192;
const MAX_PENDING_PACKETS = 64;
const REQUEST_TIMEOUT_MS = 5000;

// ------------------------------------------------------------------------------------------------
// Hub wire messages
// ------------------------------------------------------------------------------------------------

interface LobbyState {
  id: string;
  owner: string;
  members: string[];
  max: number;
  data: Record<string, string>;
  joinable: boolean;
  visibility: LobbyVisibility;
}

type ToHub =
  | { op: 'hello'; steamId: string; name: string }
  | { op: 'create'; rid: number; visibility: LobbyVisibility; max: number }
  | { op: 'join'; rid: number; lobby: string }
  | { op: 'leave'; lobby: string }
  | { op: 'setData'; lobby: string; data: Record<string, string> }
  | { op: 'setJoinable'; lobby: string; joinable: boolean }
  | { op: 'list'; rid: number }
  | { op: 'send'; to: string; data: string }
  | { op: 'invite'; lobby: string };

type FromHub =
  | { op: 'welcome' }
  | { op: 'refused'; reason: string }
  | { op: 'reply'; rid: number; ok: true; lobby?: string; lobbies?: LobbyListing[] }
  | { op: 'reply'; rid: number; ok: false; error: string }
  | { op: 'lobby'; lobby: LobbyState }
  | { op: 'gone'; lobby: string }
  | { op: 'packet'; from: string; data: string }
  | { op: 'joinRequested'; lobby: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isRid = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < 2 ** 31;

function cleanData(v: unknown): Record<string, string> | null {
  if (!isObj(v)) return null;
  const out: Record<string, string> = {};
  const keys = Object.keys(v);
  if (keys.length > MAX_DATA_KEYS) return null;
  for (const k of keys) {
    const val = v[k];
    if (!k || k.length > MAX_KEY_LEN || typeof val !== 'string' || val.length > MAX_VALUE_LEN) return null;
    out[k] = val;
  }
  return out;
}

/** Strict check of a message sent to the hub; null if anything is off. */
export function parseToHub(v: unknown): ToHub | null {
  if (!isObj(v) || typeof v.op !== 'string') return null;
  switch (v.op) {
    case 'hello':
      return isSteamId64(v.steamId) && typeof v.name === 'string' && v.name.length > 0 && v.name.length <= 64 ? { op: 'hello', steamId: v.steamId, name: v.name } : null;
    case 'create':
      return isRid(v.rid) && (v.visibility === 'public' || v.visibility === 'private') && Number.isInteger(v.max) && (v.max as number) >= 1 && (v.max as number) <= 250
        ? { op: 'create', rid: v.rid, visibility: v.visibility, max: v.max as number }
        : null;
    case 'join':
      return isRid(v.rid) && isSteamId64(v.lobby) ? { op: 'join', rid: v.rid, lobby: v.lobby } : null;
    case 'leave':
      return isSteamId64(v.lobby) ? { op: 'leave', lobby: v.lobby } : null;
    case 'setData': {
      const data = cleanData(v.data);
      return isSteamId64(v.lobby) && data ? { op: 'setData', lobby: v.lobby, data } : null;
    }
    case 'setJoinable':
      return isSteamId64(v.lobby) && typeof v.joinable === 'boolean' ? { op: 'setJoinable', lobby: v.lobby, joinable: v.joinable } : null;
    case 'list':
      return isRid(v.rid) ? { op: 'list', rid: v.rid } : null;
    case 'send':
      return isSteamId64(v.to) && typeof v.data === 'string' && v.data.length <= MAX_PACKET_B64 && /^[A-Za-z0-9+/]*={0,2}$/.test(v.data) ? { op: 'send', to: v.to, data: v.data } : null;
    case 'invite':
      return isSteamId64(v.lobby) ? { op: 'invite', lobby: v.lobby } : null;
    default:
      return null;
  }
}

// ------------------------------------------------------------------------------------------------
// The hub
// ------------------------------------------------------------------------------------------------

/** One connected app window, as the hub sees it. */
export interface HubPeer {
  deliver(msg: FromHub): void;
  /** the hub refuses this peer (bad message, duplicate id): close its link */
  kick(reason: string): void;
}

interface PeerRec {
  peer: HubPeer;
  steamId: string | null;
  name: string;
  lobbies: Set<string>;
}

function newLobbyId(): string {
  // Steam lobby ids are 64-bit numbers starting 1097...; anything unique and valid will do here
  const n = 109_775_240_000_000_000n + (BigInt(`0x${randomBytes(6).toString('hex')}`) % 9_999_999_999n);
  return n.toString();
}

export class FakeHub {
  private readonly peers = new Set<PeerRec>();
  private readonly byId = new Map<string, PeerRec>();
  private readonly lobbies = new Map<string, LobbyState>();

  /** Register a connected link. Returns the function its messages go to and the one to call when it closes. */
  attach(peer: HubPeer): { receive: (raw: unknown) => void; detach: () => void } {
    const rec: PeerRec = { peer, steamId: null, name: '', lobbies: new Set() };
    this.peers.add(rec);
    return {
      receive: (raw) => this.receive(rec, raw),
      detach: () => this.detach(rec),
    };
  }

  stats(): { players: number; lobbies: number } {
    return { players: this.byId.size, lobbies: this.lobbies.size };
  }

  private detach(rec: PeerRec): void {
    if (!this.peers.delete(rec)) return;
    for (const id of [...rec.lobbies]) this.leave(rec, id);
    if (rec.steamId && this.byId.get(rec.steamId) === rec) this.byId.delete(rec.steamId);
  }

  private receive(rec: PeerRec, raw: unknown): void {
    const msg = parseToHub(raw);
    if (!msg) return rec.peer.kick('malformed message');
    if (msg.op === 'hello') {
      if (rec.steamId) return rec.peer.kick('hello twice');
      if (this.byId.has(msg.steamId)) {
        rec.peer.deliver({ op: 'refused', reason: 'that player id is already connected' });
        return rec.peer.kick('duplicate id');
      }
      rec.steamId = msg.steamId;
      rec.name = msg.name;
      this.byId.set(msg.steamId, rec);
      rec.peer.deliver({ op: 'welcome' });
      return;
    }
    const me = rec.steamId;
    if (!me) return rec.peer.kick('no hello');
    switch (msg.op) {
      case 'create': {
        const lobby: LobbyState = { id: newLobbyId(), owner: me, members: [me], max: msg.max, data: {}, joinable: true, visibility: msg.visibility };
        this.lobbies.set(lobby.id, lobby);
        rec.lobbies.add(lobby.id);
        this.push(lobby);
        rec.peer.deliver({ op: 'reply', rid: msg.rid, ok: true, lobby: lobby.id });
        return;
      }
      case 'join': {
        const lobby = this.lobbies.get(msg.lobby);
        if (!lobby) return rec.peer.deliver({ op: 'reply', rid: msg.rid, ok: false, error: 'not_found' });
        if (!lobby.members.includes(me)) {
          if (!lobby.joinable) return rec.peer.deliver({ op: 'reply', rid: msg.rid, ok: false, error: 'not_joinable' });
          if (lobby.members.length >= lobby.max) return rec.peer.deliver({ op: 'reply', rid: msg.rid, ok: false, error: 'full' });
          lobby.members.push(me);
          rec.lobbies.add(lobby.id);
        }
        this.push(lobby);
        rec.peer.deliver({ op: 'reply', rid: msg.rid, ok: true, lobby: lobby.id });
        return;
      }
      case 'leave':
        this.leave(rec, msg.lobby);
        return;
      case 'setData': {
        const lobby = this.lobbies.get(msg.lobby);
        if (!lobby || lobby.owner !== me) return;
        const merged = { ...lobby.data, ...msg.data };
        if (Object.keys(merged).length > MAX_DATA_KEYS) return;
        lobby.data = merged;
        this.push(lobby);
        return;
      }
      case 'setJoinable': {
        const lobby = this.lobbies.get(msg.lobby);
        if (!lobby || lobby.owner !== me) return;
        lobby.joinable = msg.joinable;
        this.push(lobby);
        return;
      }
      case 'list': {
        const lobbies: LobbyListing[] = [];
        for (const l of this.lobbies.values()) {
          if (l.visibility !== 'public' || !l.joinable || l.members.length >= l.max) continue;
          lobbies.push({ id: l.id, owner: l.owner, members: l.members.length, max: l.max, data: { ...l.data } });
          if (lobbies.length >= 50) break; // Steam returns at most 50 by default
        }
        rec.peer.deliver({ op: 'reply', rid: msg.rid, ok: true, lobbies });
        return;
      }
      case 'send': {
        const to = this.byId.get(msg.to);
        if (to && to !== rec) to.peer.deliver({ op: 'packet', from: me, data: msg.data });
        return;
      }
      case 'invite': {
        // the stand-in's "invite friends": every other player on this hub is a friend
        const lobby = this.lobbies.get(msg.lobby);
        if (!lobby || !lobby.members.includes(me)) return;
        for (const p of this.byId.values()) if (p !== rec && !lobby.members.includes(p.steamId!)) p.peer.deliver({ op: 'joinRequested', lobby: lobby.id });
        return;
      }
      default:
        return;
    }
  }

  private leave(rec: PeerRec, lobbyId: string): void {
    const lobby = this.lobbies.get(lobbyId);
    rec.lobbies.delete(lobbyId);
    if (!lobby || !rec.steamId) return;
    const i = lobby.members.indexOf(rec.steamId);
    if (i < 0) return;
    lobby.members.splice(i, 1);
    rec.peer.deliver({ op: 'gone', lobby: lobbyId });
    if (lobby.members.length === 0) {
      this.lobbies.delete(lobbyId);
      return;
    }
    if (lobby.owner === rec.steamId) lobby.owner = lobby.members[0]; // like Steam: the next member owns it
    this.push(lobby);
  }

  private push(lobby: LobbyState): void {
    const snapshot: LobbyState = { ...lobby, members: [...lobby.members], data: { ...lobby.data } };
    for (const id of lobby.members) this.byId.get(id)?.peer.deliver({ op: 'lobby', lobby: snapshot });
  }
}

// ------------------------------------------------------------------------------------------------
// Links between a backend and the hub
// ------------------------------------------------------------------------------------------------

export interface HubLink {
  send(msg: ToHub): void;
  onMessage(cb: (msg: unknown) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): void;
}

/** In-process link (tests): messages are copied through JSON and delivered on a later tick, like a socket. */
export function memoryLink(hub: FakeHub): HubLink {
  let toClient: ((msg: unknown) => void) | null = null;
  let closeCb: ((reason: string) => void) | null = null;
  let attached = true; // the hub still takes this link's messages
  let open = true; // the client still gets the hub's messages (those queued before a close arrive first)
  const shut = (reason: string) => {
    if (!attached) return;
    attached = false;
    handle.detach();
    setImmediate(() => {
      open = false;
      closeCb?.(reason);
    });
  };
  const handle = hub.attach({
    deliver: (msg) => {
      const copy = JSON.stringify(msg);
      setImmediate(() => {
        if (open) toClient?.(JSON.parse(copy));
      });
    },
    kick: (reason) => shut(reason),
  });
  return {
    send: (msg) => {
      if (!attached) return;
      const copy = JSON.stringify(msg);
      setImmediate(() => {
        if (attached) handle.receive(JSON.parse(copy));
      });
    },
    onMessage: (cb) => {
      toClient = cb;
    },
    onClose: (cb) => {
      closeCb = cb;
    },
    close: () => shut('closed'),
  };
}

/** Length-prefixed JSON frames on a TCP socket. Calls onFrame per message; false from it (or a bad frame) ends the socket. */
function frameReader(socket: Socket, onFrame: (msg: unknown) => void): void {
  let buf: Buffer = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len === 0 || len > MAX_HUB_FRAME) {
        socket.destroy();
        return;
      }
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let msg: unknown;
      try {
        msg = JSON.parse(body.toString('utf8'));
      } catch {
        socket.destroy();
        return;
      }
      onFrame(msg);
      if (socket.destroyed) return;
    }
  });
}

function writeFrame(socket: Socket, msg: unknown): void {
  if (socket.destroyed) return;
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(body.length, 0);
  socket.write(Buffer.concat([head, body]));
}

export class FakeHubServer {
  readonly hub = new FakeHub();
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  /** Listen on 127.0.0.1:port. Rejects with EADDRINUSE when another window already runs the hub. */
  listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.onSocket(socket));
      server.once('error', reject);
      server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
        server.off('error', reject);
        server.on('error', () => {});
        this.server = server;
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });
  }

  private onSocket(socket: Socket): void {
    // only this machine: the server listens on 127.0.0.1, but check the peer anyway
    if (socket.remoteAddress !== '127.0.0.1' && socket.remoteAddress !== '::ffff:127.0.0.1') {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setNoDelay(true);
    const handle = this.hub.attach({
      deliver: (msg) => writeFrame(socket, msg),
      kick: () => socket.end(),
    });
    frameReader(socket, (msg) => handle.receive(msg));
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      this.sockets.delete(socket);
      handle.detach();
    });
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    const server = this.server;
    this.server = null;
    return new Promise((r) => (server ? server.close(() => r()) : r()));
  }
}

/** Connect to a hub on 127.0.0.1:port. Rejects (ECONNREFUSED) when there is none. */
export function tcpLink(port: number): Promise<HubLink> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    let msgCb: ((msg: unknown) => void) | null = null;
    let closeCb: ((reason: string) => void) | null = null;
    const early: unknown[] = [];
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.off('error', reject);
      socket.on('error', () => socket.destroy());
      socket.setNoDelay(true);
      frameReader(socket, (msg) => (msgCb ? msgCb(msg) : early.push(msg)));
      socket.on('close', () => closeCb?.('the FakeSteam hub closed'));
      resolve({
        send: (msg) => writeFrame(socket, msg),
        onMessage: (cb) => {
          msgCb = cb;
          for (const m of early.splice(0)) cb(m);
        },
        onClose: (cb) => {
          closeCb = cb;
        },
        close: () => socket.destroy(),
      });
    });
  });
}

/**
 * Find the hub on this machine, or become it: the first window to bind the port runs the hub (and
 * keeps it for the others until it quits). Returns the link and, if this process started it, the server.
 */
export async function connectOrHostHub(port = DEFAULT_HUB_PORT): Promise<{ link: HubLink; server: FakeHubServer | null }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return { link: await tcpLink(port), server: null };
    } catch {
      // no hub yet: try to be it
    }
    const server = new FakeHubServer();
    try {
      await server.listen(port);
      return { link: await tcpLink(port), server };
    } catch {
      await server.close(); // someone else won the race: connect to theirs
    }
  }
  throw new Error(`could not reach or start the FakeSteam hub on 127.0.0.1:${port}`);
}

// ------------------------------------------------------------------------------------------------
// The backend
// ------------------------------------------------------------------------------------------------

export interface FakeSteamOptions {
  link: HubLink;
  /** the hub server this process runs, if any (closed with the backend) */
  server?: FakeHubServer | null;
  steamId?: string;
  name?: string;
  /** folder for the stand-in's Steam Cloud files */
  cloudDir: string;
  log?: (s: string) => void;
}

const CLOUD_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function randomFakeSteamId(): string {
  const n = 76_561_190_000_000_000n + (BigInt(`0x${randomBytes(5).toString('hex')}`) % 9_999_999_999n);
  return n.toString();
}

export class FakeSteamBackend implements SteamBackend {
  readonly appId = DEV_APP_ID;
  readonly fake = true;
  private readonly link: HubLink;
  private readonly server: FakeHubServer | null;
  private readonly steamId: string;
  private readonly name: string;
  private readonly cloudDir: string;
  private readonly log: (s: string) => void;
  private readonly events = new Emitter<BackendEvents>();
  private readonly lobbies = new Map<string, LobbyState>();
  private readonly requests = new Map<number, { resolve: (m: Extract<FromHub, { op: 'reply' }>) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextRid = 1;
  /** players whose packets we take: accepted, or ones we sent to first */
  private readonly sessions = new Set<string>();
  private readonly pending = new Map<string, Buffer[]>();
  private closed = false;
  private welcomed: Promise<void>;

  private constructor(opts: FakeSteamOptions) {
    this.link = opts.link;
    this.server = opts.server ?? null;
    this.steamId = opts.steamId ?? randomFakeSteamId();
    this.name = (opts.name ?? `Lunker-${this.steamId.slice(-4)}`).slice(0, 32);
    this.cloudDir = opts.cloudDir;
    this.log = opts.log ?? ((s) => console.log(s));
    let welcome!: () => void;
    let refuse!: (e: Error) => void;
    this.welcomed = new Promise<void>((res, rej) => {
      welcome = res;
      refuse = rej;
    });
    this.link.onMessage((raw) => this.onHub(raw as FromHub, welcome, refuse));
    this.link.onClose((reason) => {
      refuse(new Error(reason));
      this.onLost(reason);
    });
    this.link.send({ op: 'hello', steamId: this.steamId, name: this.name });
  }

  /** Connect a backend over a link and wait for the hub's welcome. */
  static async connect(opts: FakeSteamOptions): Promise<FakeSteamBackend> {
    const b = new FakeSteamBackend(opts);
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('the FakeSteam hub did not answer')), REQUEST_TIMEOUT_MS).unref());
    try {
      await Promise.race([b.welcomed, timeout]);
    } catch (err) {
      b.close();
      throw err;
    }
    return b;
  }

  me() {
    return { steamId: this.steamId, name: this.name };
  }

  private onHub(msg: FromHub, welcome: () => void, refuse: (e: Error) => void): void {
    if (!isObj(msg)) return;
    switch (msg.op) {
      case 'welcome':
        welcome();
        return;
      case 'refused':
        refuse(new Error(String(msg.reason)));
        return;
      case 'reply': {
        const r = this.requests.get(msg.rid);
        if (!r) return;
        this.requests.delete(msg.rid);
        clearTimeout(r.timer);
        r.resolve(msg);
        return;
      }
      case 'lobby':
        this.lobbies.set(msg.lobby.id, msg.lobby);
        this.events.emit('lobbyChanged', msg.lobby.id);
        return;
      case 'gone':
        if (this.lobbies.delete(msg.lobby)) this.events.emit('lobbyChanged', msg.lobby);
        return;
      case 'joinRequested':
        if (isSteamId64(msg.lobby)) this.events.emit('joinRequested', msg.lobby);
        return;
      case 'packet': {
        if (!isSteamId64(msg.from) || typeof msg.data !== 'string') return;
        const data = Buffer.from(msg.data, 'base64');
        if (this.sessions.has(msg.from)) {
          this.events.emit('packet', msg.from, data);
          return;
        }
        // no session yet: hold the packets and ask once; acceptSession delivers them in order
        const first = !this.pending.has(msg.from);
        const queue = this.pending.get(msg.from) ?? [];
        this.pending.set(msg.from, queue);
        if (queue.length < MAX_PENDING_PACKETS) queue.push(data);
        if (first) this.events.emit('sessionRequest', msg.from);
        return;
      }
      default:
        return;
    }
  }

  private onLost(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const r of this.requests.values()) {
      clearTimeout(r.timer);
      r.resolve({ op: 'reply', rid: 0, ok: false, error: 'disconnected' });
    }
    this.requests.clear();
    this.lobbies.clear();
    if (reason !== 'closed') this.log(`[fakesteam] lost the hub: ${reason}`);
    this.events.emit('disconnected', reason);
  }

  private request(msg: ToHub & { rid: number }): Promise<Extract<FromHub, { op: 'reply' }>> {
    if (this.closed) return Promise.resolve({ op: 'reply', rid: msg.rid, ok: false, error: 'disconnected' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.requests.delete(msg.rid);
        resolve({ op: 'reply', rid: msg.rid, ok: false, error: 'timeout' });
      }, REQUEST_TIMEOUT_MS);
      this.requests.set(msg.rid, { resolve, timer });
      this.link.send(msg);
    });
  }

  private rid(): number {
    const r = this.nextRid;
    this.nextRid = this.nextRid >= 2 ** 30 ? 1 : this.nextRid + 1;
    return r;
  }

  async createLobby(visibility: LobbyVisibility, maxMembers: number): Promise<string> {
    const r = await this.request({ op: 'create', rid: this.rid(), visibility, max: maxMembers });
    if (!r.ok || !r.lobby) throw new Error(`could not create a lobby (${r.ok ? 'no id' : r.error})`);
    return r.lobby;
  }

  async joinLobby(lobbyId: string): Promise<void> {
    const r = await this.request({ op: 'join', rid: this.rid(), lobby: lobbyId });
    if (!r.ok) throw new Error(r.error === 'full' ? 'That lobby is full.' : r.error === 'not_found' ? 'That lobby does not exist any more.' : `Could not join the lobby (${r.error}).`);
  }

  leaveLobby(lobbyId: string): void {
    this.lobbies.delete(lobbyId);
    if (!this.closed) this.link.send({ op: 'leave', lobby: lobbyId });
  }

  async listLobbies(): Promise<LobbyListing[]> {
    const r = await this.request({ op: 'list', rid: this.rid() });
    return r.ok && Array.isArray(r.lobbies) ? r.lobbies : [];
  }

  lobbyOwner(lobbyId: string): string | null {
    return this.lobbies.get(lobbyId)?.owner ?? null;
  }

  lobbyMembers(lobbyId: string): string[] {
    return [...(this.lobbies.get(lobbyId)?.members ?? [])];
  }

  lobbyMemberLimit(lobbyId: string): number {
    return this.lobbies.get(lobbyId)?.max ?? 0;
  }

  lobbyData(lobbyId: string): Record<string, string> {
    return { ...(this.lobbies.get(lobbyId)?.data ?? {}) };
  }

  setLobbyData(lobbyId: string, data: Record<string, string>): boolean {
    const l = this.lobbies.get(lobbyId);
    if (!l || l.owner !== this.steamId || this.closed) return false;
    l.data = { ...l.data, ...data }; // the hub confirms with a push
    this.link.send({ op: 'setData', lobby: lobbyId, data });
    return true;
  }

  setLobbyJoinable(lobbyId: string, joinable: boolean): void {
    if (!this.closed) this.link.send({ op: 'setJoinable', lobby: lobbyId, joinable });
  }

  openInviteDialog(lobbyId: string): void {
    // no overlay here: invite every other window on this machine
    if (!this.closed) this.link.send({ op: 'invite', lobby: lobbyId });
  }

  sendPacket(to: string, data: Buffer): boolean {
    if (this.closed || !isSteamId64(to)) return false;
    this.sessions.add(to); // sending opens the session from our side, as in Steam
    this.link.send({ op: 'send', to, data: data.toString('base64') });
    return true;
  }

  acceptSession(from: string): void {
    this.sessions.add(from);
    const queue = this.pending.get(from);
    this.pending.delete(from);
    for (const p of queue ?? []) this.events.emit('packet', from, p);
  }

  closeSession(with_: string): void {
    this.sessions.delete(with_);
    this.pending.delete(with_);
  }

  cloudRead(name: string): string | null {
    if (!CLOUD_NAME.test(name)) return null;
    try {
      return readFileSync(join(this.cloudDir, name), 'utf8');
    } catch {
      return null;
    }
  }

  cloudWrite(name: string, data: string): boolean {
    if (!CLOUD_NAME.test(name)) return false;
    try {
      mkdirSync(this.cloudDir, { recursive: true });
      const file = join(this.cloudDir, name);
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, data, 'utf8');
      renameSync(tmp, file);
      return true;
    } catch {
      return false;
    }
  }

  openOverlayUrl(url: string): void {
    this.log(`[fakesteam] (no overlay in the stand-in) would open ${url}`);
  }

  on<E extends keyof BackendEvents>(event: E, cb: BackendEvents[E]): () => void {
    return this.events.on(event, cb);
  }

  close(): void {
    if (!this.closed) for (const id of [...this.lobbies.keys()]) this.leaveLobby(id);
    this.events.clear(); // a deliberate close is not a lost hub: nobody is told
    this.onLost('closed');
    this.link.close();
    void this.server?.close();
  }
}
