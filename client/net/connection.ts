// Online connection to a Hook Wars server. Typed send/receive, ping, and clean shutdown.
import { PROTOCOL_VERSION } from '../../shared/constants.ts';
import type { ClientMsg, Profile, ServerMsg } from '../../shared/protocol.ts';

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

export class Connection {
  readonly url: string;
  status: ConnStatus = 'connecting';
  rtt = 0;
  onMessage: ((m: ServerMsg) => void) | null = null;
  onStatus: ((s: ConnStatus, reason?: string) => void) | null = null;
  private ws: WebSocket;
  private pingTimer: number;

  constructor(url: string, profile: Profile, account: string | null = null) {
    this.url = url;
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
      this.onMessage?.(m);
    });
    this.ws.addEventListener('close', (ev) => {
      this.status = 'closed';
      window.clearInterval(this.pingTimer);
      this.onStatus?.('closed', ev.reason || (ev.code === 1006 ? 'Could not reach the server.' : `Disconnected (${ev.code}).`));
    });
    this.ws.addEventListener('error', () => {
      // 'close' follows with the details
    });
    this.pingTimer = window.setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000);
  }

  send(m: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close(): void {
    window.clearInterval(this.pingTimer);
    try {
      this.ws.close(1000, 'bye');
    } catch {
      // already closed
    }
  }
}
