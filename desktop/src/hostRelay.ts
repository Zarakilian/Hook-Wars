// HOST side of the Steam P2P relay. For every connection a remote lobby member opens (a joiner's page
// connecting its WebSocket), this opens one WebSocket to the local game server, marked with the relay
// headers so the server keys its limits on the Steam player instead of 127.0.0.1, and carries the
// messages both ways as frames (./framing.ts) over Steam P2P.
//
// Trust rules: packets from players who are not in our lobby are ignored. A member whose packet is
// malformed, oversized, or breaks the frame rules is dropped (all their connections closed, a Bye sent)
// and ignored for DROP_COOLDOWN_MS.
import WebSocket from 'ws';
import { RELAY_PEER_HEADER, RELAY_PEER_PREFIX, RELAY_SECRET_HEADER, isSteamId64 } from './constants.ts';
import {
  FrameType,
  HOST_TO_JOINER,
  JOINER_TO_HOST,
  clipUtf8,
  closeInfo,
  dataText,
  decodeFrame,
  encodeBye,
  encodeClose,
  encodeData,
  encodeDeflatedData,
  encodeFrame,
  encodePong,
  sendableCloseCode,
} from './framing.ts';
import { StreamDeflater } from './streamCodec.ts';

export const MAX_CONNS_PER_PEER = 4;
/** Opens a member may ask for per minute (a reconnecting page needs a handful). */
export const MAX_OPENS_PER_MINUTE = 30;
/** Messages a member may queue while its server connection is still opening. */
const MAX_QUEUED = 32;
const OPEN_TIMEOUT_MS = 5000;
export const PEER_SILENCE_MS = 30_000;
export const DROP_COOLDOWN_MS = 30_000;
/**
 * Packets a member may send per second (sustained, and in one burst). A real joiner sends about 35 a
 * second (inputs at 30/s, pings, the odd lobby message) and the game server cuts a connection off
 * above 90/s anyway; this budget is for what the relay answers by itself (Pongs, Close for unknown
 * or refused connections), so a flood cannot make the host send a reply per packet.
 */
export const PEER_PACKET_RATE = 500;
export const PEER_PACKET_BURST = 1000;
const SWEEP_MS = 5000;

/** Something that can open a WebSocket to the local server (tests may wrap it to inspect headers). */
export type WsFactory = (url: string, headers: Record<string, string>) => WebSocket;

const defaultWsFactory: WsFactory = (url, headers) =>
  // loopback: no compression (the relay deflates for the P2P leg itself), and a generous cap
  new WebSocket(url, { headers, perMessageDeflate: false, maxPayload: HOST_TO_JOINER.maxMessage });

export interface HostRelayOptions {
  /** ws URL of the local game server, e.g. ws://127.0.0.1:52011/ws */
  serverUrl: string;
  /** the per-run RELAY_SECRET the server was started with */
  relaySecret: string;
  /** send one reliable P2P packet */
  send: (to: string, packet: Buffer) => boolean;
  /** is this player in our lobby right now? */
  isMember: (steamId: string) => boolean;
  wsFactory?: WsFactory;
  /** deflate host -> joiner messages with a stream per connection (default true) */
  compress?: boolean;
  now?: () => number;
  log?: (s: string) => void;
}

interface RelayConn {
  id: number;
  ws: WebSocket;
  open: boolean;
  queue: string[];
  timer: ReturnType<typeof setTimeout> | null;
  /** this connection's deflate stream (host -> joiner) */
  deflater: StreamDeflater | null;
  /** every frame of this connection goes out in order behind the one being compressed */
  sending: Promise<void>;
  /** a compressed piece was lost (Steam refused it): nothing more goes out on this connection */
  broken: boolean;
}

interface Peer {
  id: string;
  conns: Map<number, RelayConn>;
  lastSeen: number;
  opens: number;
  opensSince: number;
  /** packet budget (token bucket: PEER_PACKET_RATE a second, at most PEER_PACKET_BURST) */
  tokens: number;
  refilled: number;
  bytesIn: number;
  bytesOut: number;
}

export interface PeerStats {
  steamId: string;
  conns: number;
  bytesIn: number;
  bytesOut: number;
}

export class HostRelay {
  private serverUrl: string;
  private readonly secret: string;
  private readonly sendPacket: (to: string, packet: Buffer) => boolean;
  private readonly isMember: (steamId: string) => boolean;
  private readonly wsFactory: WsFactory;
  private readonly compress: boolean;
  private readonly now: () => number;
  private readonly log: (s: string) => void;
  private readonly peers = new Map<string, Peer>();
  private readonly droppedUntil = new Map<string, number>();
  private readonly ignoredLogged = new Map<string, number>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(opts: HostRelayOptions) {
    this.serverUrl = opts.serverUrl;
    this.secret = opts.relaySecret;
    this.sendPacket = opts.send;
    this.isMember = opts.isMember;
    this.wsFactory = opts.wsFactory ?? defaultWsFactory;
    this.compress = opts.compress ?? true;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((s) => console.log(s));
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  /** The local server moved (it was restarted on a new port): new connections go there. */
  setServerUrl(url: string): void {
    this.serverUrl = url;
  }

  /** The headers each relayed connection carries. */
  headersFor(steamId: string): Record<string, string> {
    return { [RELAY_SECRET_HEADER]: this.secret, [RELAY_PEER_HEADER]: `${RELAY_PEER_PREFIX}${steamId}` };
  }

  stats(): PeerStats[] {
    return [...this.peers.values()].map((p) => ({ steamId: p.id, conns: p.conns.size, bytesIn: p.bytesIn, bytesOut: p.bytesOut }));
  }

  /** One packet from Steam P2P. */
  onPacket(from: string, packet: Buffer): void {
    if (this.closed || !isSteamId64(from)) return;
    const now = this.now();
    const until = this.droppedUntil.get(from);
    if (until !== undefined) {
      if (until > now) return;
      this.droppedUntil.delete(from);
    }
    if (!this.isMember(from)) {
      const last = this.ignoredLogged.get(from) ?? 0;
      if (now - last > 60_000) {
        this.ignoredLogged.set(from, now);
        if (this.ignoredLogged.size > 1000) this.ignoredLogged.clear();
        this.log(`[relay] ignored packets from ${from}: not in the lobby`);
      }
      return;
    }
    let peer = this.peers.get(from);
    if (!peer) {
      peer = { id: from, conns: new Map(), lastSeen: now, opens: 0, opensSince: now, tokens: PEER_PACKET_BURST, refilled: now, bytesIn: 0, bytesOut: 0 };
      this.peers.set(from, peer);
    }
    peer.tokens = Math.min(PEER_PACKET_BURST, peer.tokens + (Math.max(0, now - peer.refilled) / 1000) * PEER_PACKET_RATE);
    peer.refilled = now;
    if (peer.tokens < 1) return this.dropPeer(from, 'too many packets', true, 'The host dropped the connection (too many packets).');
    peer.tokens -= 1;
    const d = decodeFrame(packet, JOINER_TO_HOST);
    if (!d.ok) return this.dropPeer(from, `bad packet (${d.reason})`, true);
    const f = d.frame;
    peer.lastSeen = now;
    peer.bytesIn += packet.length;
    switch (f.type) {
      case FrameType.Ping:
        this.out(peer, encodePong(f));
        return;
      case FrameType.Pong:
        return;
      case FrameType.Open:
        return this.open(peer, f.conn);
      case FrameType.Data: {
        const text = dataText(f, JOINER_TO_HOST);
        if (text === null) return this.dropPeer(from, 'bad message', true);
        const c = peer.conns.get(f.conn);
        if (!c) {
          this.out(peer, encodeClose(f.conn, 4004, 'Unknown connection.'));
          return;
        }
        if (c.open) {
          c.ws.send(text);
          return;
        }
        if (c.queue.length >= MAX_QUEUED) return this.dropPeer(from, 'too many messages before the connection opened', true);
        c.queue.push(text);
        return;
      }
      case FrameType.Close: {
        const info = closeInfo(f);
        if (!info) return this.dropPeer(from, 'bad close', true);
        const c = peer.conns.get(f.conn);
        if (!c) return;
        this.forget(peer, c);
        closeWs(c.ws, info.code, info.reason);
        return;
      }
      case FrameType.Bye:
        // the member is leaving: their connections go now, not when the server notices
        return this.dropPeer(from, 'left', false);
      default:
        return;
    }
  }

  private open(peer: Peer, connId: number): void {
    const existing = peer.conns.get(connId);
    if (existing) {
      if (existing.open) this.out(peer, encodeFrame(FrameType.Open, connId)); // a repeated open: ack again
      return;
    }
    const now = this.now();
    if (now - peer.opensSince > 60_000) {
      peer.opens = 0;
      peer.opensSince = now;
    }
    if (++peer.opens > MAX_OPENS_PER_MINUTE || peer.conns.size >= MAX_CONNS_PER_PEER) {
      this.out(peer, encodeClose(connId, 4008, 'Too many connections.'));
      return;
    }
    let ws: WebSocket;
    try {
      ws = this.wsFactory(this.serverUrl, this.headersFor(peer.id));
    } catch (err) {
      this.log(`[relay] could not connect to the local server: ${(err as Error).message}`);
      this.out(peer, encodeClose(connId, 4002, 'The game server is not running.'));
      return;
    }
    const c: RelayConn = { id: connId, ws, open: false, queue: [], timer: null, deflater: this.compress ? new StreamDeflater() : null, sending: Promise.resolve(), broken: false };
    peer.conns.set(connId, c);
    c.timer = setTimeout(() => {
      if (c.open || peer.conns.get(connId) !== c) return;
      this.forget(peer, c);
      ws.terminate();
      this.out(peer, encodeClose(connId, 4002, 'The game server did not answer.'));
    }, OPEN_TIMEOUT_MS);
    ws.on('open', () => {
      if (peer.conns.get(connId) !== c) return ws.close(1000);
      c.open = true;
      if (c.timer) clearTimeout(c.timer);
      c.timer = null;
      this.out(peer, encodeFrame(FrameType.Open, connId));
      for (const m of c.queue.splice(0)) ws.send(m);
    });
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary || peer.conns.get(connId) !== c) return; // the game server only sends text
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      const d = c.deflater;
      if (!d) return this.inOrder(c, () => void this.out(peer, encodeData(connId, bytes)));
      const piece = d.deflate(bytes); // starts now; sent in order
      this.inOrder(c, async () => {
        const p = await piece;
        if (c.broken) return;
        // a lost piece breaks the joiner's inflate stream for good: end this connection cleanly
        // (the page reconnects on a fresh one) rather than send it data it cannot read
        if (!this.out(peer, encodeDeflatedData(connId, p))) this.breakConn(peer, c);
      });
    });
    ws.on('close', (code: number, reason: Buffer) => {
      if (c.timer) clearTimeout(c.timer);
      if (peer.conns.get(connId) !== c) return; // closed from the joiner's side: already forgotten
      this.forget(peer, c);
      const why = reason.toString('utf8');
      // after the messages still being compressed
      const closeCode = sendableCloseCode(code) ? code : 4002; // 1006: the server went away
      this.inOrder(c, () => {
        if (!c.broken) this.out(peer, encodeClose(connId, closeCode, closeCode === code ? why : why || 'Lost the game server.'));
      });
    });
    ws.on('error', (err: Error) => {
      // 'close' follows; log only the first failure to reach the server
      if (!c.open) this.log(`[relay] connection for ${peer.id} failed: ${err.message}`);
    });
  }

  private forget(peer: Peer, c: RelayConn): void {
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    peer.conns.delete(c.id);
    const d = c.deflater;
    if (d) this.inOrder(c, () => d.close());
  }

  /** Run a send for this connection after the ones before it (compression is asynchronous). */
  private inOrder(c: RelayConn, fn: () => void | Promise<void>): void {
    c.sending = c.sending.then(fn).catch((err: Error) => this.log(`[relay] send failed: ${err.message}`));
  }

  /** Send one packet to a member; false when Steam would not take it. */
  private out(peer: Peer, packet: Buffer): boolean {
    if (this.closed) return false;
    peer.bytesOut += packet.length;
    if (this.sendPacket(peer.id, packet)) return true;
    this.log(`[relay] Steam would not send a packet to ${peer.id}`);
    return false;
  }

  /** A compressed piece of this connection was lost: close it on both sides, with 4002 to the page. */
  private breakConn(peer: Peer, c: RelayConn): void {
    if (c.broken) return;
    c.broken = true;
    if (peer.conns.get(c.id) === c) this.forget(peer, c);
    closeWs(c.ws, 1000, 'relay lost data');
    this.out(peer, encodeClose(c.id, 4002, 'Lost data on the way to you.'));
  }

  /**
   * Close every connection of this member. With `ban` (a protocol violation) the member gets a Bye and
   * is ignored for DROP_COOLDOWN_MS; without it (they left, or went silent) nothing is sent.
   */
  dropPeer(steamId: string, reason: string, ban = false, byeText = 'The host dropped the connection (bad data).'): void {
    const peer = this.peers.get(steamId);
    if (ban) {
      this.droppedUntil.set(steamId, this.now() + DROP_COOLDOWN_MS);
      this.log(`[relay] dropped ${steamId}: ${reason}`);
      this.sendPacket(steamId, encodeBye(byeText));
    }
    if (!peer) return;
    this.peers.delete(steamId);
    for (const c of [...peer.conns.values()]) {
      this.forget(peer, c);
      closeWs(c.ws, 1000, 'relay closed');
    }
  }

  /** Members who have gone silent (no packet for PEER_SILENCE_MS) lose their connections. */
  private sweep(): void {
    const now = this.now();
    for (const p of [...this.peers.values()]) {
      if (now - p.lastSeen > PEER_SILENCE_MS) this.dropPeer(p.id, 'silent');
      else if (!this.isMember(p.id)) this.dropPeer(p.id, 'not in the lobby any more');
    }
    for (const [id, until] of this.droppedUntil) if (until <= now) this.droppedUntil.delete(id);
  }

  /** The host is leaving: tell everyone (and anyone in `notify`), then close every relayed connection. */
  close(reason: string, notify: Iterable<string> = []): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweepTimer);
    const told = new Set<string>();
    const bye = encodeBye(reason);
    for (const id of [...this.peers.keys(), ...notify]) {
      if (told.has(id) || !isSteamId64(id)) continue;
      told.add(id);
      this.sendPacket(id, bye);
    }
    for (const id of [...this.peers.keys()]) this.dropPeer(id, 'host closed');
  }
}

function closeWs(ws: WebSocket, code: number, reason: string): void {
  try {
    if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    else ws.close(sendableCloseCode(code) ? code : 1000, clipUtf8(reason));
  } catch {
    ws.terminate();
  }
}
