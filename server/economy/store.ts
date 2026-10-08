// AccountStore: the economy's JSON database in <dataDir>/economy.json.
//
// Writes are atomic: the whole file goes to a per-process temp file, is fsynced, then renamed over
// economy.json (rename replaces in one step on Windows and POSIX). A crash mid-write leaves the old
// file untouched. Saves are debounced; money-critical steps call flush() for an immediate write.
//
// Recovery on load, in order: economy.json -> the newest temp file that parses -> economy.json.bak
// (a copy taken at every start). A file that exists but does not parse is never overwritten: it is
// moved aside to economy.json.corrupt-<time> and logged.
//
// One process owns a data folder at a time (economy.lock holds its pid). A second server pointed at
// the same folder keeps its accounts in memory only and says so in the log.
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Loadout } from '../../shared/cosmetics.ts';
import type { Listing, OwnedItem } from '../../shared/economy.ts';
import type { FamilyId } from '../../shared/types.ts';

export const SCHEMA_VERSION = 1;
const FILE = 'economy.json';
const LOCK = 'economy.lock';

export interface AccountRec {
  id: string;
  tokenHash: string; // sha256 hex of the auth token; the token itself is never stored
  created: number;
  seen: number;
  name: string; // last profile name, shown on market listings
  pearls: number;
  owned: OwnedItem[];
  loadouts: Record<FamilyId, Loadout>;
  wallet: string | null;
  stats: { matches: number; wins: number; kills: number; hooksHit: number };
  day: string; // UTC day of dayPearls, YYYY-MM-DD
  dayPearls: number; // Pearls earned from matches on that day
  lastPaid: number; // epoch ms of the last paid match
}

export type OrderStatus = 'open' | 'submitted' | 'paid' | 'minted' | 'expired' | 'failed';

export interface OrderRec {
  id: string;
  account: string;
  item: string;
  wallet: string;
  cents: number;
  status: OrderStatus;
  created: number;
  expires: number;
  tx: string; // base64 partially signed transaction handed to the wallet ('' while it is being built)
  message: string; // base64 message bytes the wallet must sign unchanged
  meta: string; // chain adapter data
  signature?: string; // payment transaction signature
  serial?: number;
  asset?: string;
  instance?: string;
  error?: string;
  updated: number;
}

export interface EconomyDb {
  v: number;
  accounts: Record<string, AccountRec>;
  listings: Record<string, Listing>;
  orders: Record<string, OrderRec>;
  /** item id -> highest serial issued (Limited editions) */
  serials: Record<string, number>;
}

export function emptyDb(): EconomyDb {
  return { v: SCHEMA_VERSION, accounts: {}, listings: {}, orders: {}, serials: {} };
}

export class StoreVersionError extends Error {}

export interface StoreOptions {
  /** null = memory only */
  dir: string | null;
  debounceMs?: number;
  log?: (line: string) => void;
  /** accounts that are not worth a line on disk (untouched guests) */
  skipAccount?: (a: AccountRec) => boolean;
}

/** Synchronous sleep for the short Windows rename retries (no busy loop). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'; // exists but not ours
  }
}

export class AccountStore {
  db: EconomyDb = emptyDb();
  /** false when running from memory (no folder, or another process owns it) */
  readonly persistent: boolean;
  readonly dir: string | null;
  private readonly debounceMs: number;
  private readonly log: (line: string) => void;
  private readonly skipAccount: (a: AccountRec) => boolean;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private locked = false;
  private closed = false;
  private readonly tmpName = `${FILE}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  /** count of successful writes (tests) */
  writes = 0;

  constructor(opts: StoreOptions) {
    this.debounceMs = opts.debounceMs ?? 500;
    this.log = opts.log ?? ((s) => console.log(s));
    this.skipAccount = opts.skipAccount ?? (() => false);
    this.dir = opts.dir;
    let persistent = false;
    if (opts.dir) {
      mkdirSync(opts.dir, { recursive: true });
      if (this.takeLock(opts.dir)) {
        persistent = true;
        this.db = this.load(opts.dir); // throws StoreVersionError for a newer schema; the caller disables the economy
      }
    }
    this.persistent = persistent;
  }

  private takeLock(dir: string): boolean {
    const path = join(dir, LOCK);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, 'wx');
        writeSync(fd, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
        closeSync(fd);
        this.locked = true;
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        let pid = 0;
        try {
          pid = Number((JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }).pid);
        } catch {
          // unreadable lock: treat as stale
        }
        if (pidAlive(pid)) {
          this.log(`[economy] ${dir} is in use by process ${pid}. This server keeps accounts in memory only (set ECONOMY_DATA_DIR to give it its own folder).`);
          return false;
        }
        try {
          unlinkSync(path); // stale lock from a crashed process
        } catch {
          // someone else removed it first
        }
      }
    }
    return false;
  }

  private parse(raw: string): EconomyDb | null {
    let j: unknown;
    try {
      j = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof j !== 'object' || j === null || typeof (j as EconomyDb).v !== 'number') return null;
    const d = j as EconomyDb;
    if (d.v > SCHEMA_VERSION) throw new StoreVersionError(`economy.json has schema ${d.v}, newer than this server (${SCHEMA_VERSION}). Refusing to touch it.`);
    // v1 is the only schema so far; later migrations go here (if (d.v === 1) { ...; d.v = 2 })
    const obj = (v: unknown) => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, never>) : {});
    return { v: SCHEMA_VERSION, accounts: obj(d.accounts), listings: obj(d.listings), orders: obj(d.orders), serials: obj(d.serials) };
  }

  private load(dir: string): EconomyDb {
    const main = join(dir, FILE);
    const bak = join(dir, `${FILE}.bak`);
    const tmps = readdirSync(dir).filter((f) => f.startsWith(`${FILE}.tmp-`)).map((f) => join(dir, f));
    let db: EconomyDb | null = null;
    let from = '';
    if (existsSync(main)) {
      db = this.parse(readFileSync(main, 'utf8'));
      if (db) from = FILE;
      else {
        const aside = join(dir, `${FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        renameSync(main, aside);
        this.log(`[economy] ${main} could not be read. It was moved to ${aside} untouched; trying the newest temp file, then the backup.`);
      }
    }
    if (!db) {
      // newest complete temp file (a crash between fsync and rename leaves a good one behind)
      const sorted = tmps
        .map((p) => {
          try {
            return { p, d: this.parse(readFileSync(p, 'utf8')), t: statSync(p).mtimeMs };
          } catch (err) {
            if (err instanceof StoreVersionError) throw err;
            return { p, d: null, t: 0 };
          }
        })
        .filter((x): x is { p: string; d: EconomyDb; t: number } => !!x.d);
      const best = sorted.sort((a, b) => b.t - a.t)[0];
      if (best) {
        db = best.d;
        from = best.p;
      }
    }
    if (!db && existsSync(bak)) {
      db = this.parse(readFileSync(bak, 'utf8'));
      if (db) from = `${FILE}.bak`;
    }
    for (const t of tmps) {
      try {
        unlinkSync(t);
      } catch {
        // already gone
      }
    }
    if (!db) return emptyDb();
    if (from !== FILE) {
      this.log(`[economy] recovered the economy data from ${from}`);
      this.db = db;
      this.writeNow(dir);
    }
    try {
      copyFileSync(main, bak); // one backup per start
    } catch {
      // no main file yet
    }
    const n = Object.keys(db.accounts).length;
    this.log(`[economy] loaded ${n} account${n === 1 ? '' : 's'} from ${main}`);
    return db;
  }

  /** Something changed: write it soon. */
  markDirty(): void {
    if (!this.persistent || this.closed) return;
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Write now if anything changed (money-critical steps and shutdown). */
  flush(): void {
    if (!this.persistent || !this.dir) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.writeNow(this.dir);
  }

  /** Mark dirty and write immediately. */
  commit(): void {
    if (!this.persistent) return;
    this.dirty = true;
    this.flush();
  }

  private serialize(): string {
    const accounts: Record<string, AccountRec> = {};
    for (const [id, a] of Object.entries(this.db.accounts)) if (!this.skipAccount(a)) accounts[id] = a;
    return JSON.stringify({ ...this.db, v: SCHEMA_VERSION, savedAt: new Date().toISOString(), accounts });
  }

  private writeNow(dir: string): void {
    const tmp = join(dir, this.tmpName);
    const main = join(dir, FILE);
    try {
      const data = this.serialize();
      const fd = openSync(tmp, 'w');
      try {
        writeSync(fd, data);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      for (let attempt = 0; ; attempt++) {
        try {
          renameSync(tmp, main);
          break;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          // Windows: a virus scanner or indexer can hold the target open for a moment
          if (attempt >= 8 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
          sleepSync(10 + attempt * 15);
        }
      }
      this.dirty = false;
      this.writes++;
    } catch (err) {
      this.log(`[economy] could not save ${main}: ${(err as Error).message}. Will retry.`);
      this.dirty = true;
      if (!this.closed && !this.timer) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.flush();
        }, 2000);
        this.timer.unref?.();
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.locked && this.dir) {
      try {
        unlinkSync(join(this.dir, LOCK));
      } catch {
        // already gone
      }
      this.locked = false;
    }
  }
}
