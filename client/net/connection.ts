// Online connection to a Hook Wars server. Typed send/receive, ping, and clean shutdown.
import { PROTOCOL_VERSION } from '../../shared/constants.ts';
import type { ClientMsg, Profile, ServerMsg } from '../../shared/protocol.ts';
import { RejoinStore } from './rejoin.ts';

export type ConnStatus = 'connecting' | 'open' | 'closed';

/** The parts of the page's address that pick a default server (window.location in the browser). */
export interface PageOrigin {
  protocol: string;
  host: string;
}

function currentPage(): PageOrigin | null {
  const l = (globalThis as { location?: { protocol: string; host: string } }).location;
  return l ? { protocol: l.protocol, host: l.host } : null;
}

/** Set by a build that is not served by the game server (a desktop app): see setDefaultServerUrl. */
let configuredDefault: string | null = null;

/**
 * The server an empty address means. A build that is not served by a game server (the desktop app
 * loads the page from disk) sets it with setDefaultServerUrl: a dedicated server or one on this machine.
 * Otherwise it is the host that served the page (the browser build). Null when there is neither, and
 * the player has to type an address.
 */
export function defaultServerUrl(page: PageOrigin | null = currentPage()): string | null {
  if (configuredDefault) return configuredDefault;
  if (!page || (page.protocol !== 'http:' && page.protocol !== 'https:') || !page.host) return null;
  const proto = page.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${page.host}/ws`;
}

/** Point the empty address at a fixed server (null: back to the page's own host). False for a bad address. */
export function setDefaultServerUrl(url: string | null): boolean {
  const wanted = url?.trim() ?? '';
  // without a page to resolve against: a bare host gets wss, localhost and LAN addresses get ws
  const full = wanted ? normaliseServerUrl(wanted, null) : null;
  if (wanted && !full) return false;
  configuredDefault = full;
  return true;
}

/** localhost, loopback and private LAN addresses: servers there rarely have a TLS certificate. */
function isLocalHost(hostPort: string): boolean {
  const v6 = /^\[([^\]]*)\]/.exec(hostPort);
  const host = (v6 ? v6[1] : hostPort.replace(/:\d*$/, '')).toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.lan') || host === '::1' ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

/**
 * Accepts "host:port", "ws://host:port", "https://host" etc. and returns a ws(s) URL ending in /ws
 * (null when it is not a server address, or when it is empty and there is no default server).
 * Without a scheme: wss on an https page, ws on an http page; a page that was not served over http
 * (the desktop app) uses ws for localhost and LAN addresses and wss for everything else.
 */
export function normaliseServerUrl(input: string, page: PageOrigin | null = currentPage()): string | null {
  let s = input.trim();
  if (!s) return defaultServerUrl(page);
  if (!/^[a-z]+:\/\//i.test(s)) {
    const web = page && (page.protocol === 'http:' || page.protocol === 'https:');
    const secure = web ? page.protocol === 'https:' : !isLocalHost(s.split('/')[0]);
    s = (secure ? 'wss://' : 'ws://') + s;
  }
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

/** What onStatus('closed') says: the close frame's own reason, else a plain line for its code. */
export function closeText(code: number, reason: string): string {
  return reason || (code === 1006 ? 'Could not reach the server.' : `Disconnected (${code}).`);
}

/** True for the plain lines closeText makes up when the other side gave no reason. */
export function isPlainCloseText(text: string): boolean {
  return text === 'Could not reach the server.' || /^Disconnected \(\d{1,5}\)\.$/.test(text);
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
  private readonly pingTimer: unknown;
  private readonly rejoin: RejoinStore;
  private readonly autoRejoin: boolean;
  /** close() was called: anything the socket still delivers is ignored, and its close is not a drop */
  private closing = false;

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
      // after close() (the player left, or started a solo match over a rejoin in flight) a late 'start'
      // must not mark the match as ours again, or the next connection would auto-rejoin it
      if (this.closing || typeof ev.data !== 'string') return;
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
      globalThis.clearInterval(this.pingTimer as number);
      // a drop mid-match starts the grace clock; the next connection to this server can take the unit back
      if (!this.closing && this.inMatch && this.roomCode) this.rejoin.markDropped(this.url, this.roomCode);
      this.inMatch = false;
      this.onStatus?.('closed', closeText(ev.code, ev.reason));
    });
    this.ws.addEventListener('error', () => {
      // 'close' follows with the details
    });
    this.pingTimer = globalThis.setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000);
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
        if (this.autoRejoining && (m.code === 'no_room' || m.code === 'room_full' || m.code === 'join_limit')) {
          this.rejoin.remove(this.url, this.autoRejoining);
          this.autoRejoining = null;
        }
        return;
      default:
        return;
    }
  }

  close(): void {
    this.closing = true;
    globalThis.clearInterval(this.pingTimer as number);
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
