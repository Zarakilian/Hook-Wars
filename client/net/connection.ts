// Online connection to a Hook Wars server. Typed send/receive, ping, and clean shutdown.
import { PROTOCOL_VERSION } from '../../shared/constants.ts';
import type { ClientMsg, Profile, ServerMsg } from '../../shared/protocol.ts';
import { RejoinStore } from './rejoin.ts';

export type ConnStatus = 'connecting' | 'open' | 'closed';

/** Default server address: the same host that served the page. */
export function defaultServerUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/** Accepts "host:port", "ws://host:port", "https://host" etc. and returns a ws(s) URL ending in /ws. */
export function normaliseServerUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return defaultServerUrl();
  if (!/^[a-z]+:\/\//i.test(s)) s = (location.protocol === 'https:' ? 'wss://' : 'ws://') + s;
  try {
    const u = new URL(s);
    if (u.protocol === 'http:') u.protocol = 'ws:';
    if (u.protocol === 'https:') u.protocol = 'wss:';
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
    if (!u.pathname || u.pathname === '/') u.pathname = '/ws';
    return u.toString();
  } catch {
    return null;
  }
}

export interface ConnectionOptions {
  /**
   * After a dropped connection, the next Connection to the same server rejoins the dropped match by
   * itself (right after 'welcome') if it is still inside the grace window. Default true.
   */
  autoRejoin?: boolean;
  /** token storage (sessionStorage by default); tests pass a stub */
  rejoinStore?: RejoinStore;
}

export class Connection {
  readonly url: string;
  status: ConnStatus = 'connecting';
  rtt = 0;
  onMessage: ((m: ServerMsg) => void) | null = null;
  onStatus: ((s: ConnStatus, reason?: string) => void) | null = null;
  /** Room code this socket is in (from the server's room messages), null in the browser. */
  roomCode: string | null = null;
  /** True while this socket drives a unit in a running match. */
  inMatch = false;
  /** Set while an automatic rejoin of a dropped match is in flight (the room code). */
  autoRejoining: string | null = null;
  private ws: WebSocket;
  private pingTimer: number;
  private readonly rejoin: RejoinStore;
  private readonly autoRejoin: boolean;

  constructor(url: string, profile: Profile, account: string | null = null, opts: ConnectionOptions = {}) {
    this.url = url;
    this.rejoin = opts.rejoinStore ?? new RejoinStore();
    this.autoRejoin = opts.autoRejoin ?? true;
    this.ws = new WebSocket(url);
    this.ws.addEventListener('open', () => {
      this.status = 'open';
      this.send(account ? { t: 'hello', v: PROTOCOL_VERSION, profile, account } : { t: 'hello', v: PROTOCOL_VERSION, profile });
      this.onStatus?.('open');
    });
    this.ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      let m: ServerMsg;
      try {
        m = JSON.parse(ev.data) as ServerMsg;
      } catch {
        return;
      }
      if (m.t === 'pong') {
        const sample = performance.now() - m.c;
        this.rtt = this.rtt === 0 ? sample : this.rtt * 0.8 + sample * 0.2;
        return;
      }
      this.track(m);
      this.onMessage?.(m);
    });
    this.ws.addEventListener('close', (ev) => {
      this.status = 'closed';
      window.clearInterval(this.pingTimer);
      // a drop mid-match starts the grace clock; the next connection to this server can take the unit back
      if (this.inMatch && this.roomCode) this.rejoin.markDropped(this.url, this.roomCode);
      this.inMatch = false;
      this.onStatus?.('closed', ev.reason || (ev.code === 1006 ? 'Could not reach the server.' : `Disconnected (${ev.code}).`));
    });
    this.ws.addEventListener('error', () => {
      // 'close' follows with the details
    });
    this.pingTimer = window.setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000);
  }

  send(m: ClientMsg): void {
    if (m.t === 'joinRoom' && !m.rejoin) {
      // joining a room we were playing in: bring the token so the server hands our unit back
      const e = this.rejoin.get(this.url, m.code);
      if (e) m = { ...m, rejoin: e.token };
    } else if (m.t === 'leaveRoom' && this.roomCode) {
      this.rejoin.markLeft(this.url, this.roomCode);
      this.inMatch = false;
    }
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** A dropped match on this server that a new connection can still take back, if any. */
  rejoinable(): { code: string; droppedAt: number } | null {
    const e = this.rejoin.dropped(this.url);
    return e ? { code: e.code, droppedAt: e.dropped } : null;
  }

  /** Room and match bookkeeping for rejoin tokens, from every server message. */
  private track(m: ServerMsg): void {
    switch (m.t) {
      case 'welcome': {
        const e = this.autoRejoin ? this.rejoin.dropped(this.url) : null;
        if (e) {
          this.autoRejoining = e.code;
          this.send({ t: 'joinRoom', code: e.code, rejoin: e.token });
        }
        return;
      }
      case 'room':
        this.roomCode = m.room.code;
        if (m.room.phase === 'lobby') this.inMatch = false;
        return;
      case 'leftRoom':
        this.roomCode = null;
        this.inMatch = false;
        return;
      case 'start':
        this.autoRejoining = null;
        this.inMatch = m.m.you >= 0;
        if (m.m.room) this.roomCode = m.m.room;
        if (this.roomCode && m.m.rejoin) this.rejoin.put(this.url, this.roomCode, m.m.rejoin);
        else if (this.roomCode) this.rejoin.remove(this.url, this.roomCode);
        return;
      case 'end':
        this.inMatch = false;
        if (this.roomCode) this.rejoin.remove(this.url, this.roomCode); // nothing left to reclaim
        return;
      case 'error':
        if (this.autoRejoining && (m.code === 'no_room' || m.code === 'room_full')) {
          this.rejoin.remove(this.url, this.autoRejoining);
          this.autoRejoining = null;
        }
        return;
      default:
        return;
    }
  }

  close(): void {
    window.clearInterval(this.pingTimer);
    // closing on purpose is leaving: keep the token for a manual rejoin by code, but no auto-rejoin
    if (this.inMatch && this.roomCode) this.rejoin.markLeft(this.url, this.roomCode);
    this.inMatch = false;
    try {
      this.ws.close(1000, 'bye');
    } catch {
      // already closed
    }
  }
}
