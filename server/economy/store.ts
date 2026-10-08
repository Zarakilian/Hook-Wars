// AccountStore: the economy's JSON database in <dataDir>/economy.json.
//
// Writes are atomic: the whole file goes to a per-process temp file, is fsynced, then renamed over
// economy.json (rename replaces in one step on Windows and POSIX). A crash mid-write leaves the old
// file untouched. Saves are debounced; money-critical steps call flush() for an immediate write.
//
// Recovery on load: the newest complete file (by savedAt) among economy.json and any temp files
// (a crash after fsync but before rename leaves a newer temp file), then economy.json.bak (a copy
// taken at every start). A file that exists but does not parse is never overwritten: it is moved
// aside to economy.json.corrupt-<time> and logged.
//
// One process owns a data folder at a time (economy.lock holds its pid). A second server pointed at
// the same folder keeps its accounts in memory only and says so in the log.
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
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

  /** Parse one file. Null if it is not a complete economy file; throws StoreVersionError for a newer schema. */
  private parse(raw: string): { db: EconomyDb; savedAt: string } | null {
    let j: unknown;
    try {
      j = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof j !== 'object' || j === null || typeof (j as EconomyDb).v !== 'number') return null;
    const d = j as EconomyDb & { savedAt?: unknown };
    if (d.v > SCHEMA_VERSION) throw new StoreVersionError(`economy.json has schema ${d.v}, newer than this server (${SCHEMA_VERSION}). Refusing to touch it.`);
    // v1 is the only schema so far; later migrations go here (if (d.v === 1) { ...; d.v = 2 })
    const obj = (v: unknown) => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, never>) : {});
    return {
      db: { v: SCHEMA_VERSION, accounts: obj(d.accounts), listings: obj(d.listings), orders: obj(d.orders), serials: obj(d.serials) },
      savedAt: typeof d.savedAt === 'string' ? d.savedAt : '',
    };
  }

  private load(dir: string): EconomyDb {
    const main = join(dir, FILE);
    const bak = join(dir, `${FILE}.bak`);
    const tmps = readdirSync(dir).filter((f) => f.startsWith(`${FILE}.tmp-`)).map((f) => join(dir, f));
    // Candidates: the main file and every complete temp file. A crash after fsync but before the
    // rename leaves a temp file that is NEWER than the main file, so the newest savedAt wins.
    const found: { path: string; db: EconomyDb; savedAt: string }[] = [];
    if (existsSync(main)) {
      const got = this.parse(readFileSync(main, 'utf8'));
      if (got) found.push({ path: main, ...got });
      else {
        const aside = join(dir, `${FILE}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        renameSync(main, aside);
        this.log(`[economy] ${main} could not be read. It was moved to ${aside} untouched; trying the temp files, then the backup.`);
      }
    }
    for (const t of tmps) {
      try {
        const got = this.parse(readFileSync(t, 'utf8'));
        if (got) found.push({ path: t, ...got });
      } catch (err) {
        if (err instanceof StoreVersionError) throw err;
        // unreadable temp file: ignore it
      }
    }
    found.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : a.path === main ? -1 : 1));
    let best: { path: string; db: EconomyDb } | null = found[0] ?? null;
    if (!best && existsSync(bak)) {
      const got = this.parse(readFileSync(bak, 'utf8'));
      if (got) best = { path: bak, db: got.db };
    }
    for (const t of tmps) {
      try {
        unlinkSync(t);
      } catch {
        // already gone
      }
    }
    if (!best) return emptyDb();
    const db = best.db;
    if (best.path !== main) {
      this.log(`[economy] recovered the economy data from ${best.path}`);
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
