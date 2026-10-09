// Rejoin tokens, kept per server and room in sessionStorage (so each tab has its own, and a token
// never outlives the tab). The server hands one out in every MatchStart; a new connection that
// presents it within REJOIN_GRACE_MS takes its old unit back with gold, upgrades, items and K/D.
import { REJOIN_GRACE_MS } from '../../shared/protocol.ts';

export interface RejoinEntry {
  url: string;
  code: string;
  token: string;
  /** Date.now() when the token was issued */
  at: number;
  /** Date.now() when the socket dropped mid-match; 0 while connected or after leaving on purpose */
  dropped: number;
}

/** The part of the Web Storage API this needs (sessionStorage in the browser, a stub in tests). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY = 'hookwars.rejoin';
/** a token is useless once its match is over; matches last at most 30 min plus overtime */
const MAX_AGE_MS = 45 * 60_000;

function defaultStore(): KeyValueStore | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null; // storage blocked (privacy mode, sandboxed frame)
  }
}

export class RejoinStore {
  private readonly store: KeyValueStore | null;
  private readonly now: () => number;

  constructor(store: KeyValueStore | null = defaultStore(), now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  private load(): RejoinEntry[] {
    if (!this.store) return [];
    try {
      const raw = this.store.getItem(KEY);
      const list = raw ? (JSON.parse(raw) as unknown) : [];
      if (!Array.isArray(list)) return [];
      const t = this.now();
      return list.filter(
        (e): e is RejoinEntry =>
          !!e && typeof e.url === 'string' && typeof e.code === 'string' && typeof e.token === 'string' &&
          typeof e.at === 'number' && typeof e.dropped === 'number' && t - e.at < MAX_AGE_MS &&
          (e.dropped === 0 || t - e.dropped < REJOIN_GRACE_MS),
      );
    } catch {
      return [];
    }
  }

  private save(list: RejoinEntry[]): void {
    if (!this.store) return;
    try {
      if (list.length === 0) this.store.removeItem(KEY);
      else this.store.setItem(KEY, JSON.stringify(list.slice(-8)));
    } catch {
      // quota or blocked storage: rejoin just will not be offered
    }
  }

  /** The token for this room, if it can still be used. */
  get(url: string, code: string): RejoinEntry | null {
    return this.load().find((e) => e.url === url && e.code === code) ?? null;
  }

  /** A match on this server that dropped mid-play and can still be reclaimed (newest first). */
  dropped(url: string): RejoinEntry | null {
    const list = this.load().filter((e) => e.url === url && e.dropped > 0);
    list.sort((a, b) => b.dropped - a.dropped);
    return list[0] ?? null;
  }

  /** Remember a freshly issued token (replaces any older one for the room). */
  put(url: string, code: string, token: string): void {
    const list = this.load().filter((e) => !(e.url === url && e.code === code));
    list.push({ url, code, token, at: this.now(), dropped: 0 });
    this.save(list);
  }

  /** The socket dropped mid-match: start the grace clock (this is what auto-rejoin looks for). */
  markDropped(url: string, code: string): void {
    const list = this.load();
    const e = list.find((x) => x.url === url && x.code === code);
    if (!e) return;
    e.dropped = this.now();
    this.save(list);
  }

  /** Left on purpose: keep the token for a manual rejoin by code, but never auto-rejoin. */
  markLeft(url: string, code: string): void {
    const list = this.load();
    const e = list.find((x) => x.url === url && x.code === code);
    if (!e) return;
    e.dropped = 0;
    this.save(list);
  }

  remove(url: string, code: string): void {
    this.save(this.load().filter((e) => !(e.url === url && e.code === code)));
  }

  /**
   * The player moved on (started a solo match): no dropped match on any server may be auto-rejoined
   * any more. Tokens stay, so a manual rejoin by room code still takes the unit back inside the grace
   * window. Returns how many entries were dropped before.
   */
  cancelAuto(): number {
    const list = this.load();
    let n = 0;
    for (const e of list) {
      if (e.dropped > 0) {
        e.dropped = 0;
        n++;
      }
    }
    if (n > 0) this.save(list);
    return n;
  }
}
