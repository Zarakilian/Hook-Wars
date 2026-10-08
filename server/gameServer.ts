// WebSocket front door: connection limits, rate limits, message routing, the shared tick loop.
// Hardened for the open internet: small payloads, per-IP caps, token-bucket rate limits,
// strict validation (shared/protocol.ts), hello and idle deadlines, slow-consumer protection,
// and per-message compression for the snapshot stream.
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { DEFAULT_CONFIG, PROTOCOL_VERSION, TICK_DT } from '../shared/constants.ts';
import { defaultProfile, parseClientMessage, type ClientMsg, type Profile, type ServerMsg } from '../shared/protocol.ts';
import type { MatchConfig } from '../shared/types.ts';
import type { ServerConfig } from './config.ts';
import { makeRoomCode, Room, type RoomClient } from './room.ts';

const MAX_PAYLOAD = 4096;
const HEARTBEAT_MS = 10_000;
const HELLO_MS = 5_000; // the client sends hello as soon as the socket opens
const IDLE_MS = 60_000; // the client pings every 2 s, so a minute of silence is a dead or idle socket
const BUCKET_RATE = 90; // messages per second sustained (inputs are 30/s)
const BUCKET_BURST = 180;
// Lobby messages fan out to the whole room, so they get their own, much smaller bucket.
const LOBBY_RATE = 5;
const LOBBY_BURST = 20;
const LOBBY_MSGS = new Set<ClientMsg['t']>(['listRooms', 'createRoom', 'joinRoom', 'quickPlay', 'leaveRoom', 'setTeam', 'setConfig', 'ready', 'start']);
// bufferedAmount counts compressed bytes (about 150 to 200 B per snapshot with deflate)
const SLOW_BUFFER = 64 * 1024; // skip snapshots above this
const KILL_BUFFER = 512 * 1024; // terminate above this

interface Conn extends RoomClient {
  ws: WebSocket;
  ip: string;
  hello: boolean;
  room: Room | null;
  tokens: number;
  lastRefill: number;
  lobbyTokens: number;
  lobbyRefill: number;
  strikes: number;
  alive: boolean;
  lastChat: number;
  lastCreate: number;
  pingSent: number;
  connectedAt: number;
  lastMsg: number;
}

export class GameServer {
  private readonly cfg: ServerConfig;
  private readonly wss: WebSocketServer;
  private readonly conns = new Map<number, Conn>();
  private readonly perIp = new Map<string, number>();
  private readonly rooms = new Map<string, Room>();
  private readonly roomOwnerIp = new Map<string, string>(); // room code -> creator IP
  private nextId = 1;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private acc = 0;
  private last = 0;

  constructor(cfg: ServerConfig) {
    this.cfg = cfg;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_PAYLOAD, // checked against the inflated size
      // Snapshots are repetitive JSON: deflate with context takeover shrinks them about 8x.
      perMessageDeflate: { zlibDeflateOptions: { level: 1, memLevel: 7 }, serverMaxWindowBits: 13, threshold: 256 },
      clientTracking: false,
    });
  }

  /**
   * Attach to an http server. Upgrades on /ws are handled. With exclusive (production) every other
   * upgrade is refused; without it (dev) they are left for Vite's own HMR socket.
   */
  attach(server: Server, opts: { exclusive?: boolean } = {}): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      // Node drops its own socket error handler before 'upgrade': without this an RST crashes the process.
      socket.on('error', () => socket.destroy());
      const url = req.url ?? '';
      if (!url.startsWith('/ws')) {
        if (opts.exclusive) {
          socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          socket.destroy();
        }
        return;
      }
      this.handleUpgrade(req, socket, head);
    });
    this.start();
  }

  private clientIp(req: IncomingMessage): string {
    const peer = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    if (this.cfg.trustedProxies.includes(peer)) {
      // only our own proxy may tell us the client address; it appends the real peer at the end
      const xf = req.headers['x-forwarded-for'];
      const parts = (Array.isArray(xf) ? xf.join(',') : (xf ?? '')).split(',');
      const last = parts[parts.length - 1]?.trim();
      if (last) return last.replace(/^::ffff:/, '').slice(0, 64);
    }
    return peer.slice(0, 64);
  }

  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients (tests, tools) send no Origin
    if (this.cfg.allowedOrigins.includes(origin)) return true;
    try {
      const o = new URL(origin);
      const host = req.headers.host ?? '';
      return o.host === host;
    } catch {
      return false;
    }
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const ip = this.clientIp(req);
    const reject = (code: number, reason: string) => {
      socket.end(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (!this.originAllowed(req)) return reject(403, 'Forbidden');
    if (this.conns.size >= this.cfg.maxClients) return reject(503, 'Server Full');
    if ((this.perIp.get(ip) ?? 0) >= this.cfg.maxPerIp) return reject(429, 'Too Many Connections');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ip));
  }

  private onConnection(ws: WebSocket, ip: string): void {
    const id = this.allocId();
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    const now = Date.now();
    const conn: Conn = {
      id,
      ws,
      ip,
      profile: defaultProfile(),
      ping: 0,
      hello: false,
      room: null,
      tokens: BUCKET_BURST,
      lastRefill: now,
      lobbyTokens: LOBBY_BURST,
      lobbyRefill: now,
      strikes: 0,
      alive: true,
      lastChat: 0,
      lastCreate: 0,
      pingSent: 0,
      connectedAt: now,
      lastMsg: now,
      send: (msg: ServerMsg) => this.sendRaw(conn, JSON.stringify(msg), false),
      sendRaw: (data: string, droppable: boolean) => this.sendRaw(conn, data, droppable),
    };
    this.conns.set(id, conn);
    ws.on('pong', () => {
      conn.alive = true;
      if (conn.pingSent) conn.ping = Math.min(9999, Date.now() - conn.pingSent);
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return this.strike(conn, 3);
      if (!this.takeToken(conn)) return;
      const raw = typeof data === 'string' ? data : data.toString();
      const msg = parseClientMessage(raw);
      if (!msg) return this.strike(conn, 1);
      conn.lastMsg = Date.now(); // only valid messages keep a socket alive
      if (LOBBY_MSGS.has(msg.t) && !this.takeLobbyToken(conn)) return;
      try {
        this.route(conn, msg);
      } catch (err) {
        console.error(`[ws] handler error for client ${conn.id}:`, err);
      }
    });
    ws.on('close', () => this.onClose(conn));
    ws.on('error', () => ws.terminate());
  }

  private allocId(): number {
    for (let i = 0; i < 1_000_000; i++) {
      const id = this.nextId;
      this.nextId = this.nextId >= 999_999 ? 1 : this.nextId + 1;
      if (!this.conns.has(id)) return id;
    }
    throw new Error('no free client ids');
  }

  private takeToken(c: Conn): boolean {
    const now = Date.now();
    c.tokens = Math.min(BUCKET_BURST, c.tokens + ((now - c.lastRefill) / 1000) * BUCKET_RATE);
    c.lastRefill = now;
    if (c.tokens < 1) {
      this.strike(c, 1);
      return false;
    }
    c.tokens -= 1;
    return true;
  }

  private takeLobbyToken(c: Conn): boolean {
    const now = Date.now();
    c.lobbyTokens = Math.min(LOBBY_BURST, c.lobbyTokens + ((now - c.lobbyRefill) / 1000) * LOBBY_RATE);
    c.lobbyRefill = now;
    if (c.lobbyTokens < 1) {
      this.strike(c, 1);
      return false;
    }
    c.lobbyTokens -= 1;
    return true;
  }

  /** Misbehaviour counter. Enough strikes in a short window closes the connection. */
  private strike(c: Conn, weight: number): void {
    c.strikes += weight;
    if (c.strikes >= 40) c.ws.close(1008, 'policy violation');
  }

  private sendRaw(c: Conn, data: string, droppable: boolean): void {
    if (c.ws.readyState !== c.ws.OPEN) return;
    const buffered = c.ws.bufferedAmount;
    if (buffered > KILL_BUFFER) {
      c.ws.terminate();
      return;
    }
    if (droppable && buffered > SLOW_BUFFER) return;
    c.ws.send(data);
  }

  private onClose(c: Conn): void {
    if (!this.conns.has(c.id)) return;
    this.conns.delete(c.id);
    const n = (this.perIp.get(c.ip) ?? 1) - 1;
    if (n <= 0) this.perIp.delete(c.ip);
    else this.perIp.set(c.ip, n);
    if (c.room) c.room.leave(c.id);
    c.room = null;
  }

  // ------------------------------------------------------------------------------------------
  // Rooms
  // ------------------------------------------------------------------------------------------

  private newRoom(c: Conn, name: string, isPrivate: boolean, config: MatchConfig): Room {
    const code = makeRoomCode((s) => this.rooms.has(s));
    const r = new Room(code, name, isPrivate, config, c, (rr) => {
      this.rooms.delete(rr.code);
      this.roomOwnerIp.delete(rr.code);
    });
    this.rooms.set(code, r);
    this.roomOwnerIp.set(code, c.ip);
    return r;
  }

  /** Open rooms created from this IP (a room this socket is about to empty does not count). */
  private roomsOwnedBy(ip: string, leaving: Room | null): number {
    let n = 0;
    for (const [code, owner] of this.roomOwnerIp) {
      if (owner !== ip) continue;
      if (leaving && leaving.code === code && leaving.members.size === 1) continue;
      n++;
    }
    return n;
  }

  /** Can this connection create one more room? Sends the reason if not. */
  private canCreate(c: Conn): boolean {
    if (this.roomsOwnedBy(c.ip, c.room) >= this.cfg.maxRoomsPerIp) {
      c.send({ t: 'error', code: 'rooms_per_ip', message: 'You already have the maximum number of rooms open.' });
      return false;
    }
    let size = this.rooms.size;
    if (c.room && c.room.members.size === 1) size--; // leaving will close it
    if (size >= this.cfg.maxRooms) {
      c.send({ t: 'error', code: 'rooms_full', message: 'This server has no free rooms right now.' });
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------------------------------------
  // Routing
  // ------------------------------------------------------------------------------------------

  private route(c: Conn, msg: ClientMsg): void {
    if (!c.hello) {
      if (msg.t !== 'hello') return this.strike(c, 2);
      if (msg.v !== PROTOCOL_VERSION) {
        c.send({ t: 'error', code: 'version', message: 'Your game version does not match this server. Refresh the page.' });
        c.ws.close(1000, 'version');
        return;
      }
      c.hello = true;
      c.profile = msg.profile;
      c.send({ t: 'welcome', id: c.id, v: PROTOCOL_VERSION, serverName: this.cfg.serverName, motd: this.cfg.motd });
      return;
    }
    const room = c.room;
    switch (msg.t) {
      case 'hello':
        return;
      case 'ping':
        c.send({ t: 'pong', c: msg.c, s: Date.now() });
        return;
      case 'listRooms':
        c.send({ t: 'rooms', rooms: this.publicRooms() });
        return;
      case 'setProfile':
        c.profile = msg.profile;
        room?.setProfile(c.id, msg.profile);
        return;
      case 'createRoom': {
        const now = Date.now();
        if (now - c.lastCreate < 3000) return;
        c.lastCreate = now;
        if (!this.canCreate(c)) return;
        this.leaveRoom(c);
        const r = this.newRoom(c, msg.name, msg.isPrivate, msg.config);
        c.room = r;
        r.join(c);
        return;
      }
      case 'joinRoom': {
        const r = this.rooms.get(msg.code);
        if (!r) {
          this.strike(c, 2); // guessing private codes gets you disconnected quickly
          c.send({ t: 'error', code: 'no_room', message: `No room with code ${msg.code}.` });
          return;
        }
        if (r.isFull()) {
          c.send({ t: 'error', code: 'room_full', message: 'That room is full.' });
          return;
        }
        if (room === r) return;
        this.leaveRoom(c);
        c.room = r;
        r.join(c);
        return;
      }
      case 'quickPlay': {
        if (room && !room.isPrivate) return; // already in a public room (a double-click): nothing to do
        // leave first, so a room this empties is gone before we pick one
        this.leaveRoom(c);
        let best: Room | null = null;
        for (const r of this.rooms.values()) {
          if (r.isPrivate || r.isFull()) continue;
          if (!best || r.members.size > best.members.size) best = r;
        }
        if (!best) {
          if (!this.canCreate(c)) return;
          best = this.newRoom(c, `${c.profile.name}'s room`, false, { ...DEFAULT_CONFIG });
        }
        c.room = best;
        best.join(c);
        return;
      }
      case 'leaveRoom':
        this.leaveRoom(c);
        c.send({ t: 'leftRoom' });
        return;
      case 'chat': {
        const now = Date.now();
        if (now - c.lastChat < 700) return;
        c.lastChat = now;
        room?.chat(c.id, msg.text, msg.team);
        return;
      }
      default:
        break;
    }
    if (!room) return;
    switch (msg.t) {
      case 'setTeam':
        room.setTeam(c.id, msg.team);
        return;
      case 'setConfig':
        room.setConfig(c.id, msg.config);
        return;
      case 'ready':
        room.setReady(c.id, msg.ready);
        return;
      case 'start': {
        const err = room.start(c.id);
        if (err) c.send(err);
        return;
      }
      case 'input':
        room.input(c.id, msg.i);
        return;
      case 'buy':
        room.buy(c.id, msg.item);
        return;
      case 'sell':
        room.sell(c.id, msg.slot);
        return;
      case 'upgrade':
        room.upgrade(c.id, msg.stat);
        return;
      default:
        return;
    }
  }

  private leaveRoom(c: Conn): void {
    if (c.room) {
      const r = c.room;
      c.room = null;
      r.leave(c.id);
    }
  }

  private publicRooms() {
    return [...this.rooms.values()].filter((r) => !r.isPrivate).map((r) => r.summary()).slice(0, 50);
  }

  // ------------------------------------------------------------------------------------------
  // Loop
  // ------------------------------------------------------------------------------------------

  private start(): void {
    this.last = performance.now();
    const loop = () => {
      const now = performance.now();
      this.acc += (now - this.last) / 1000;
      this.last = now;
      let steps = 0;
      while (this.acc >= TICK_DT && steps < 5) {
        this.acc -= TICK_DT;
        steps++;
        for (const r of this.rooms.values()) {
          try {
            r.tick();
          } catch (err) {
            console.error(`[room ${r.code}] tick error:`, err);
          }
        }
      }
      if (this.acc > TICK_DT * 5) this.acc = 0; // we fell far behind: drop time rather than spiral
      this.loopTimer = setTimeout(loop, 2);
    };
    this.loopTimer = setTimeout(loop, 2);
    this.heartbeat = setInterval(() => {
      const now = Date.now();
      for (const c of this.conns.values()) {
        const helloLate = !c.hello && now - c.connectedAt > HELLO_MS;
        const idle = now - c.lastMsg > IDLE_MS;
        if (!c.alive || helloLate || idle) {
          c.ws.terminate(); // 'close' runs onClose, which frees the slot and the per-IP count
          continue;
        }
        c.alive = false;
        c.pingSent = now;
        c.ws.ping();
        c.strikes = Math.max(0, c.strikes - 10); // strikes decay
      }
      for (const r of this.rooms.values()) {
        if (r.phase === 'lobby' && now - r.lastActivity > 30 * 60_000) {
          for (const id of [...r.members.keys()]) {
            const c = this.conns.get(id);
            if (c) {
              c.room = null;
              c.send({ t: 'leftRoom' });
            }
            r.leave(id);
          }
          this.rooms.delete(r.code);
          this.roomOwnerIp.delete(r.code);
        }
      }
    }, HEARTBEAT_MS);
  }

  close(): void {
    if (this.loopTimer) clearTimeout(this.loopTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.conns.values()) c.ws.terminate();
    this.conns.clear();
  }

  stats(): { clients: number; rooms: number } {
    return { clients: this.conns.size, rooms: this.rooms.size };
  }
}

export type { Profile };
