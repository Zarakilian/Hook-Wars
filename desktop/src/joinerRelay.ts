// JOINER side of the Steam P2P relay: a tiny WebSocket server on 127.0.0.1 (random port, a random token
// in the path) that the joiner's own page connects to. Each page connection becomes a relay connection
// to the host (Open, then Data frames over Steam P2P); the host's main process feeds it to the game server.
//
// Who may connect: only a request on the exact path /ws/<token> (compared in constant time) with
// Origin app://hookwars, so a web page in the player's browser cannot reach it. One page connection
// is live at a time; a new one replaces the old (a reconnecting page).
// Who may send to us: only the host whose lobby we joined (its SteamID at join time). A malformed
// packet from the host ends the relay.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';
import { APP_ORIGIN, MAX_CLIENT_MESSAGE } from './constants.ts';
import {
  FrameType,
  HOST_TO_JOINER,
  byeReason,
  clipUtf8,
  closeInfo,
  dataText,
  decodeFrame,
  encodeBye,
  encodeClose,
  encodeData,
  encodeFrame,
  encodePing,
  encodePong,
  sendableCloseCode,
  utf8Text,
} from './framing.ts';
import { StreamInflater } from './streamCodec.ts';

export const HOST_LEFT_CODE = 4000;
export const HOST_LOST_CODE = 4001;
export const HOST_UNREACHABLE_CODE = 4002;
export const HOST_BAD_DATA_CODE = 4003;
export const REPLACED_CODE = 4005;

const MAX_QUEUED = 64;

export interface JoinerRelayOptions {
  /** SteamID of the lobby's host (its owner when we joined) */
  hostId: string;
  send: (to: string, packet: Buffer) => boolean;
  /** Origins a page may connect from (default: only the app's own page) */
  allowedOrigins?: string[];
  pingMs?: number;
  /** nothing from the host for this long: it is gone */
  hostTimeoutMs?: number;
  openRetryMs?: number;
  openAttempts?: number;
  log?: (s: string) => void;
}

interface PageConn {
  id: number;
  ws: WebSocket;
  open: boolean;
  queue: string[];
  attempts: number;
  retry: ReturnType<typeof setInterval> | null;
  /** the host's deflate stream for this connection */
  inflater: StreamInflater;
  /** frames from the host reach the page in order behind the one being inflated */
  delivering: Promise<void>;
}

export class JoinerRelay {
  readonly hostId: string;
  private readonly sendPacket: (to: string, packet: Buffer) => boolean;
  private readonly allowedOrigins: string[];
  private readonly pingMs: number;
  private readonly hostTimeoutMs: number;
  private readonly openRetryMs: number;
  private readonly openAttempts: number;
  private readonly log: (s: string) => void;
  private readonly token = randomBytes(24).toString('hex');
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private conn: PageConn | null = null;
  private nextConn = 1;
  private lastHeard = Date.now();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private ended: string | null = null;
  private port = 0;
  /** called once when the relay ends by itself (host left, lost or misbehaving), with the reason */
  onEnded: ((reason: string) => void) | null = null;
  bytesIn = 0;
  bytesOut = 0;

  constructor(opts: JoinerRelayOptions) {
    this.hostId = opts.hostId;
    this.sendPacket = opts.send;
    this.allowedOrigins = opts.allowedOrigins ?? [APP_ORIGIN];
    this.pingMs = opts.pingMs ?? 3000;
    this.hostTimeoutMs = opts.hostTimeoutMs ?? 20_000;
    this.openRetryMs = opts.openRetryMs ?? 1000;
    this.openAttempts = opts.openAttempts ?? 10;
    this.log = opts.log ?? ((s) => console.log(s));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CLIENT_MESSAGE, perMessageDeflate: false, clientTracking: false });
    this.http = createServer((_req, res) => {
      res.writeHead(404, { 'Content-Length': '0' });
      res.end();
    });
    this.http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => this.onUpgrade(req, socket, head));
  }

  /** Listen on 127.0.0.1 and start pinging the host. Returns the URL the page connects to. */
  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(0, '127.0.0.1', () => {
        this.http.off('error', reject);
        resolve();
      });
    });
    this.port = (this.http.address() as AddressInfo).port;
    this.lastHeard = Date.now();
    this.ping();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastHeard > this.hostTimeoutMs) return this.end(HOST_LOST_CODE, 'Lost the connection to the host.');
      this.ping();
    }, this.pingMs);
    return this.url;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/ws/${this.token}`;
  }

  get isEnded(): boolean {
    return this.ended !== null;
  }

  private ping(): void {
    this.out(encodePing(randomBytes(8)));
  }

  private out(packet: Buffer): void {
    this.bytesOut += packet.length;
    if (!this.sendPacket(this.hostId, packet)) this.log('[relay] Steam would not send a packet to the host');
  }

  private tokenMatches(path: string): boolean {
    const want = Buffer.from(`/ws/${this.token}`);
    const got = Buffer.from(path);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    const reject = (code: number, why: string) => {
      socket.end(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (this.ended) return reject(410, 'Gone');
    const path = (req.url ?? '').split('?')[0];
    if (!this.tokenMatches(path)) return reject(404, 'Not Found');
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !this.allowedOrigins.includes(origin)) {
      this.log(`[relay] refused a page connection from origin ${JSON.stringify(origin ?? null)}`);
      return reject(403, 'Forbidden');
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onPage(ws));
  }

  private allocConn(): number {
    const id = this.nextConn;
    this.nextConn = this.nextConn >= 0xffff ? 1 : this.nextConn + 1;
    return id;
  }

  private onPage(ws: WebSocket): void {
    if (this.ended) return ws.close(HOST_LEFT_CODE, this.ended);
    if (this.conn) this.closePage(this.conn, REPLACED_CODE, 'Replaced by a new connection.', true);
    const c: PageConn = { id: this.allocConn(), ws, open: false, queue: [], attempts: 0, retry: null, inflater: new StreamInflater(), delivering: Promise.resolve() };
    this.conn = c;
    const sendOpen = () => {
      if (this.conn !== c || c.open) return;
      if (++c.attempts > this.openAttempts) return this.closePage(c, HOST_UNREACHABLE_CODE, 'Could not reach the host.', true);
      this.out(encodeFrame(FrameType.Open, c.id));
    };
    sendOpen();
    c.retry = setInterval(sendOpen, this.openRetryMs);
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (this.conn !== c) return;
      if (isBinary) return this.closePage(c, 1003, 'Text messages only.', true);
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (c.open) return this.out(encodeData(c.id, bytes));
      if (c.queue.length >= MAX_QUEUED) return this.closePage(c, 1008, 'Too many messages before the host answered.', true);
      c.queue.push(bytes.toString('utf8'));
    });
    ws.on('close', () => {
      if (this.conn === c) this.closePage(c, 1000, '', true);
    });
    ws.on('error', () => ws.terminate());
  }

  /** Close one page connection; with `tellHost` the host closes its end too. */
  private closePage(c: PageConn, code: number, reason: string, tellHost: boolean): void {
    if (c.retry) clearInterval(c.retry);
    c.retry = null;
    if (this.conn === c) this.conn = null;
    c.inflater.close();
    if (tellHost && !this.ended) this.out(encodeClose(c.id, code === 1005 || code === 1006 ? 1000 : code, ''));
    if (c.ws.readyState === WebSocket.OPEN || c.ws.readyState === WebSocket.CONNECTING) {
      try {
        c.ws.close(sendableCloseCode(code) ? code : 1000, clipUtf8(reason));
      } catch {
        c.ws.terminate();
      }
    }
  }

  /** One packet from Steam P2P. Only the host's count. */
  onPacket(from: string, packet: Buffer): void {
    if (this.ended || from !== this.hostId) return;
    const d = decodeFrame(packet, HOST_TO_JOINER);
    if (!d.ok) return this.end(HOST_BAD_DATA_CODE, `The host sent bad data (${d.reason}).`);
    this.lastHeard = Date.now();
    this.bytesIn += packet.length;
    const f = d.frame;
    const c = this.conn && this.conn.id === f.conn ? this.conn : null;
    switch (f.type) {
      case FrameType.Ping:
        return this.out(encodePong(f));
      case FrameType.Pong:
        return;
      case FrameType.Open:
        if (!c || c.open) return; // an ack for a connection that is gone, or a repeat
        c.open = true;
        if (c.retry) clearInterval(c.retry);
        c.retry = null;
        for (const m of c.queue.splice(0)) this.out(encodeData(c.id, Buffer.from(m, 'utf8')));
        return;
      case FrameType.Data: {
        if (!c || !c.open) return; // for a connection that is gone: its stream went with it
        if (!f.deflated) {
          const text = dataText(f, HOST_TO_JOINER);
          if (text === null) return this.end(HOST_BAD_DATA_CODE, 'The host sent bad data (message).');
          return this.inOrder(c, () => this.toPage(c, text));
        }
        const inflated = c.inflater.inflate(f.payload, HOST_TO_JOINER.maxMessage); // starts now; delivered in order
        return this.inOrder(c, async () => {
          const bytes = await inflated;
          const text = bytes && utf8Text(bytes, HOST_TO_JOINER.maxMessage);
          if (text === null || text === undefined) return this.end(HOST_BAD_DATA_CODE, 'The host sent bad data (compressed message).');
          this.toPage(c, text);
        });
      }
      case FrameType.Close: {
        const info = closeInfo(f);
        if (!info) return this.end(HOST_BAD_DATA_CODE, 'The host sent bad data (close).');
        if (c) this.inOrder(c, () => this.closePage(c, info.code, info.reason, false));
        return;
      }
      case FrameType.Bye:
        return this.end(HOST_LEFT_CODE, byeReason(f) || 'The host left the lobby.');
      default:
        return;
    }
  }

  private toPage(c: PageConn, text: string): void {
    if (this.conn === c && c.ws.readyState === WebSocket.OPEN) c.ws.send(text);
  }

  private inOrder(c: PageConn, fn: () => void | Promise<void>): void {
    c.delivering = c.delivering.then(fn).catch((err: Error) => this.log(`[relay] delivery failed: ${err.message}`));
  }

  /**
   * End the relay: close the page connection with this code and reason, stop listening and call
   * onEnded. Used when the host left, went silent, or sent bad data.
   */
  end(code: number, reason: string): void {
    if (this.ended) return;
    this.ended = reason;
    this.log(`[relay] ended: ${reason}`);
    this.shutdown(code, reason, false);
    const cb = this.onEnded;
    this.onEnded = null;
    cb?.(reason);
  }

  /** We are leaving: tell the host (so it frees our server connections now) and stop. */
  close(): void {
    if (this.ended) return;
    this.ended = 'left';
    this.out(encodeBye('left'));
    this.onEnded = null;
    this.shutdown(1000, 'You left the lobby.', false);
  }

  private shutdown(code: number, reason: string, tellHost: boolean): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.conn) this.closePage(this.conn, code, reason, tellHost);
    this.http.close();
    this.http.closeAllConnections?.();
  }
}
