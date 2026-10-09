// AccountStore: the economy's database, <dataDir>/economy.db, through node:sqlite (built into
// Node, nothing to install).
//
// The Maps in `db` are the working copy. The database keeps one row per account and one per
// listing. The service names the records it changed (dirtyAccount / dirtyListing). flush() writes
// only those rows, in one transaction, so a save costs the same with 10 accounts or 100,000.
// Money steps call commit() to write at once; everything else waits up to debounceMs. The journal
// runs in WAL mode with synchronous=FULL: a committed transaction survives a crash or a power cut.
//
// One server owns a data folder at a time. The database opens in EXCLUSIVE locking mode and takes
// its write lock straight away, and the operating system holds that lock until the process ends,
// however it ends: Ctrl+C, a crash, Task Manager, a power cut. There is no pid file that can go
// stale or name a reused pid. A second server on the same folder gets StoreLockedError, and
// ./index.ts runs it with no economy (no accounts, no tokens) instead of from memory.
//
// It never starts empty over data it could not read. A database that does not open, or an old
// economy.json that does not parse, raises StoreUnreadableError and the file is left untouched.
//
// Empty guest accounts (no Pearls, no items, no matches) are never written: the browser keeps its
// token, and a returning empty guest is simply bound to a fresh empty account again.
//
// First start after the old JSON store: economy.json (or a newer complete temp file a crash left
// behind) is imported once, then renamed to economy.json.imported-<time>. Wallet addresses, orders
// and edition serials from the old Solana build are not imported.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Loadout } from '../../shared/cosmetics.ts';
import type { Listing, OwnedItem } from '../../shared/economy.ts';
import type { FamilyId } from '../../shared/types.ts';

/** 1 = economy.json (old), 2 = economy.db */
export const SCHEMA_VERSION = 2;
export const DB_FILE = 'economy.db';
const LEGACY_FILE = 'economy.json';
const LEGACY_LOCK = 'economy.lock';

export interface AccountRec {
  id: string;
  tokenHash: string; // sha256 hex of the auth token; the token itself is never stored
  created: number;
  seen: number;
  name: string; // last profile name, shown on market listings
  pearls: number;
  owned: OwnedItem[];
  loadouts: Record<FamilyId, Loadout>;
  stats: { matches: number; wins: number; kills: number; hooksHit: number };
  day: string; // UTC day of dayPearls, YYYY-MM-DD
  dayPearls: number; // Pearls earned from matches on that day
  lastPaid: number; // epoch ms of the last paid match
}

export interface EconomyDb {
  accounts: Map<string, AccountRec>;
  listings: Map<string, Listing>;
}

export function emptyDb(): EconomyDb {
  return { accounts: new Map(), listings: new Map() };
}

/** Nothing earned, owned or played: not worth a row on disk. */
export function isEmptyGuest(a: AccountRec): boolean {
  return a.pearls === 0 && (a.owned?.length ?? 0) === 0 && (a.stats?.matches ?? 0) === 0;
}

/** The data was written by a newer server. */
export class StoreVersionError extends Error {}
/** Another process holds the data folder. */
export class StoreLockedError extends Error {}
/** The data exists but cannot be read. Nothing was changed. */
export class StoreUnreadableError extends Error {}

export interface StoreOptions {
  /** null = memory only (tests) */
  dir: string | null;
  debounceMs?: number;
  log?: (line: string) => void;
}

const openStores = new Set<AccountStore>();
let exitHook = false;
/** A crash that still reaches process exit (an uncaught exception) writes what is pending. */
function closeOnExit(s: AccountStore): void {
  openStores.add(s);
  if (exitHook) return;
  exitHook = true;
  process.once('exit', () => {
    for (const st of [...openStores]) {
      try {
        st.close();
      } catch {
        // exiting anyway
      }
    }
  });
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Keep only what this edition stores for an owned copy (old serial / asset fields are dropped). */
function cleanOwned(v: unknown): OwnedItem[] {
  if (!Array.isArray(v)) return [];
  const out: OwnedItem[] = [];
  for (const o of v) {
    if (!isObj(o) || typeof o.instance !== 'string' || typeof o.item !== 'string') continue;
    const c: OwnedItem = { instance: o.instance, item: o.item };
    if (typeof o.listed === 'string') c.listed = o.listed;
    out.push(c);
  }
  return out;
}

/** An account record from the old JSON store, without the wallet address. */
function legacyAccount(id: string, v: unknown): AccountRec | null {
  if (!isObj(v) || typeof v.tokenHash !== 'string') return null;
  const { wallet: _wallet, ...rest } = v;
  return { ...(rest as unknown as AccountRec), id, owned: cleanOwned(v.owned) };
}

function legacyListing(id: string, v: unknown): Listing | null {
  if (!isObj(v) || typeof v.seller !== 'string' || typeof v.instance !== 'string' || typeof v.item !== 'string') return null;
  const p = v.price;
  if (!isObj(p) || p.cur !== 'pearls' || typeof p.amount !== 'number') return null; // USDC listings are not imported
  return {
    id, seller: v.seller, sellerName: typeof v.sellerName === 'string' ? v.sellerName : '', instance: v.instance, item: v.item,
    price: { cur: 'pearls', amount: p.amount }, created: typeof v.created === 'number' ? v.created : 0,
  };
}

export class AccountStore {
  db: EconomyDb = emptyDb();
  /** false when running from memory (tests) */
  readonly persistent: boolean;
  readonly dir: string | null;
  /** the database file, null in memory */
  readonly file: string | null;
  /** transactions committed (tests) */
  writes = 0;
  /** rows inserted, replaced or deleted (tests) */
  rowsWritten = 0;
  private readonly debounceMs: number;
  private readonly log: (line: string) => void;
  private sql: DatabaseSync | null = null;
  private putAccount: StatementSync | null = null;
  private delAccount: StatementSync | null = null;
  private putListing: StatementSync | null = null;
  private delListing: StatementSync | null = null;
  private readonly dirtyAccounts = new Set<string>();
  private readonly dirtyListings = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(opts: StoreOptions) {
    this.debounceMs = opts.debounceMs ?? 500;
    this.log = opts.log ?? ((s) => console.log(s));
    this.dir = opts.dir;
    this.file = opts.dir ? join(opts.dir, DB_FILE) : null;
    if (opts.dir && this.file) {
      mkdirSync(opts.dir, { recursive: true });
      this.open(opts.dir, this.file); // throws StoreLockedError / StoreUnreadableError / StoreVersionError
      this.persistent = true;
      closeOnExit(this);
    } else {
      this.persistent = false;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Opening, locking, loading
  // ------------------------------------------------------------------------------------------

  private open(dir: string, file: string): void {
    let sql: DatabaseSync | null = null;
    try {
      sql = new DatabaseSync(file);
      sql.exec('PRAGMA busy_timeout = 0');
      sql.exec('PRAGMA locking_mode = EXCLUSIVE');
      sql.exec('PRAGMA journal_mode = WAL');
      sql.exec('PRAGMA synchronous = FULL');
      // The first write takes the exclusive lock, and EXCLUSIVE mode keeps it until close.
      sql.exec('BEGIN IMMEDIATE');
      sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
      sql.exec('CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
      sql.exec('CREATE TABLE IF NOT EXISTS listings (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
      const row = sql.prepare("SELECT v FROM meta WHERE k = 'schema'").get() as { v?: string } | undefined;
      const v = row?.v === undefined ? null : Number(row.v);
      if (v !== null && !(v >= 1)) throw new StoreUnreadableError(`${file} has an unknown schema mark (${String(row?.v).slice(0, 20)}).`);
      if (v !== null && v > SCHEMA_VERSION) throw new StoreVersionError(`${file} has schema ${v}, newer than this server (${SCHEMA_VERSION}). Refusing to touch it.`);
      if (v === null) sql.prepare("INSERT INTO meta (k, v) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
      sql.exec('COMMIT');
    } catch (err) {
      try {
        if (sql?.isTransaction) sql.exec('ROLLBACK');
      } catch {
        // closing anyway
      }
      try {
        sql?.close();
      } catch {
        // closing anyway
      }
      if (err instanceof StoreVersionError || err instanceof StoreUnreadableError) throw err;
      const msg = (err as Error).message;
      if (/locked|busy/i.test(msg)) throw new StoreLockedError(`${file} is in use by another Hook Wars server (or another program has it open).`);
      throw new StoreUnreadableError(`${file} could not be opened (${msg}). It was not changed.`);
    }
    this.sql = sql;
    this.putAccount = sql.prepare('INSERT INTO accounts (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data');
    this.delAccount = sql.prepare('DELETE FROM accounts WHERE id = ?');
    this.putListing = sql.prepare('INSERT INTO listings (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data');
    this.delListing = sql.prepare('DELETE FROM listings WHERE id = ?');
    try {
      this.importLegacy(dir, sql);
      this.db = this.loadRows(sql);
    } catch (err) {
      this.sql = null;
      try {
        sql.close();
      } catch {
        // closing anyway
      }
      throw err;
    }
    this.backup(dir, sql);
    const n = this.db.accounts.size;
    this.log(`[economy] loaded ${n} account${n === 1 ? '' : 's'} from ${file}`);
  }

  private loadRows(sql: DatabaseSync): EconomyDb {
    const db = emptyDb();
    let bad = 0;
    for (const r of sql.prepare('SELECT id, data FROM accounts').all() as { id: string; data: string }[]) {
      try {
        const a = JSON.parse(r.data) as AccountRec;
        if (!isObj(a) || typeof a.tokenHash !== 'string') throw new Error('not an account');
        a.id = r.id;
        db.accounts.set(r.id, a);
      } catch {
        bad++; // left on disk untouched; it is never rewritten because it is not loaded
      }
    }
    for (const r of sql.prepare('SELECT id, data FROM listings').all() as { id: string; data: string }[]) {
      try {
        const l = JSON.parse(r.data) as Listing;
        if (!isObj(l) || typeof l.seller !== 'string') throw new Error('not a listing');
        l.id = r.id;
        db.listings.set(r.id, l);
      } catch {
        bad++;
      }
    }
    if (bad) this.log(`[economy] ${bad} row${bad === 1 ? '' : 's'} in ${this.file} could not be read and were skipped (left on disk as they are).`);
    return db;
  }

  /** One copy of the database per start: economy.db.bak. */
  private backup(dir: string, sql: DatabaseSync): void {
    const bak = join(dir, `${DB_FILE}.bak`);
    try {
      if (existsSync(bak)) unlinkSync(bak);
      sql.prepare('VACUUM INTO ?').run(bak);
    } catch (err) {
      this.log(`[economy] could not write the start-up backup ${bak}: ${(err as Error).message}`);
    }
  }

  /**
   * First start on a folder from the JSON store: import economy.json once. The newest complete file
   * wins among economy.json and any temp files a crash left (a crash after fsync but before the
   * rename leaves a temp file newer than the main file). If economy.json exists and nothing parses,
   * refuse to start rather than start empty.
   */
  private importLegacy(dir: string, sql: DatabaseSync): void {
    const imported = sql.prepare("SELECT v FROM meta WHERE k = 'imported'").get();
    const hasRows = (sql.prepare('SELECT EXISTS(SELECT 1 FROM accounts) AS a, EXISTS(SELECT 1 FROM listings) AS l').get() as { a: number; l: number });
    const main = join(dir, LEGACY_FILE);
    const tmps = readdirSync(dir).filter((f) => f.startsWith(`${LEGACY_FILE}.tmp-`)).map((f) => join(dir, f));
    if (imported || hasRows.a || hasRows.l || (!existsSync(main) && !tmps.length)) return;
    const found: { path: string; j: Record<string, unknown>; savedAt: string }[] = [];
    for (const p of [main, ...tmps]) {
      if (!existsSync(p)) continue;
      let j: unknown;
      try {
        j = JSON.parse(readFileSync(p, 'utf8'));
      } catch {
        continue;
      }
      if (!isObj(j) || typeof j.v !== 'number') continue;
      if (j.v > 1) throw new StoreVersionError(`${p} has schema ${j.v}, which this server does not know. Refusing to touch it.`);
      found.push({ path: p, j, savedAt: typeof j.savedAt === 'string' ? j.savedAt : '' });
    }
    found.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : a.path === main ? -1 : 1));
    const best = found[0];
    if (!best) {
      throw new StoreUnreadableError(
        `${main} could not be read, so the economy did not start (nothing was changed). Repair it, or replace it with ${LEGACY_FILE}.bak (accounts made after that backup are lost), then restart.`,
      );
    }
    const accounts = isObj(best.j.accounts) ? best.j.accounts : {};
    const listings = isObj(best.j.listings) ? best.j.listings : {};
    let na = 0;
    let nl = 0;
    sql.exec('BEGIN');
    try {
      for (const [id, v] of Object.entries(accounts)) {
        const a = legacyAccount(id, v);
        if (!a || isEmptyGuest(a)) continue;
        this.putAccount!.run(id, JSON.stringify(a));
        na++;
      }
      for (const [id, v] of Object.entries(listings)) {
        const l = legacyListing(id, v);
        if (!l) continue;
        this.putListing!.run(id, JSON.stringify(l));
        nl++;
      }
      sql.prepare("INSERT INTO meta (k, v) VALUES ('imported', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(`${new Date().toISOString()} from ${best.path}`);
      sql.exec('COMMIT');
    } catch (err) {
      sql.exec('ROLLBACK');
      throw new StoreUnreadableError(`importing ${best.path} failed (${(err as Error).message}). Nothing was changed.`);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const p of [main, ...tmps]) {
      if (!existsSync(p)) continue;
      try {
        renameSync(p, `${p}.imported-${stamp}`);
      } catch (err) {
        this.log(`[economy] imported, but could not rename ${p}: ${(err as Error).message}. Move it away by hand.`);
      }
    }
    try {
      unlinkSync(join(dir, LEGACY_LOCK)); // the old store's pid lock; this store does not use one
    } catch {
      // none left
    }
    this.log(`[economy] imported ${na} account${na === 1 ? '' : 's'} and ${nl} listing${nl === 1 ? '' : 's'} from ${best.path} (kept as ${LEGACY_FILE}.imported-${stamp}).`);
  }

  // ------------------------------------------------------------------------------------------
  // Writing
  // ------------------------------------------------------------------------------------------

  /** This account changed (or was removed from db.accounts): write it soon. */
  dirtyAccount(id: string): void {
    if (!this.persistent || this.closed) return;
    this.dirtyAccounts.add(id);
    this.schedule();
  }

  /** This listing changed (or was removed from db.listings): write it soon. */
  dirtyListing(id: string): void {
    if (!this.persistent || this.closed) return;
    this.dirtyListings.add(id);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Write the changed rows now, in one transaction (money steps). */
  commit(): void {
    this.flush();
  }

  /** Write every changed row now, if any. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const sql = this.sql;
    if (!sql || (!this.dirtyAccounts.size && !this.dirtyListings.size)) return;
    let rows = 0;
    try {
      sql.exec('BEGIN');
      for (const id of this.dirtyAccounts) {
        const a = this.db.accounts.get(id);
        rows += Number((a && !isEmptyGuest(a) ? this.putAccount!.run(id, JSON.stringify(a)) : this.delAccount!.run(id)).changes);
      }
      for (const id of this.dirtyListings) {
        const l = this.db.listings.get(id);
        rows += Number((l ? this.putListing!.run(id, JSON.stringify(l)) : this.delListing!.run(id)).changes);
      }
      sql.exec('COMMIT');
      this.dirtyAccounts.clear();
      this.dirtyListings.clear();
      if (rows > 0) this.writes++; // a transaction that changed nothing writes nothing
      this.rowsWritten += rows;
    } catch (err) {
      try {
        if (sql.isTransaction) sql.exec('ROLLBACK');
      } catch {
        // the retry below starts a fresh transaction
      }
      this.log(`[economy] could not save to ${this.file}: ${(err as Error).message}. Will retry.`);
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
    openStores.delete(this);
    if (this.sql) {
      try {
        this.sql.close(); // releases the folder lock
      } catch (err) {
        this.log(`[economy] closing ${this.file}: ${(err as Error).message}`);
      }
      this.sql = null;
    }
  }
}
