// The economy service: guest accounts, Pearls, the Pearl store, match rewards and the Pearl
// marketplace (standard edition: no crypto, no real money; premium items belong to the Steam build).
//
// The game server calls this through the ServerEconomy contract (./api.ts). Everything here is
// the source of truth: prices come from the catalog (shared/cosmetics.ts), never from a client
// message. Node runs one message at a time, so every Pearl step below (check, then deduct) runs
// without interruption; a double click simply finds the work already done.
//
// Every lookup by an id a client sent goes through a Map, so ids such as '__proto__' find nothing.
import { cosmeticById, DEFAULT_ITEM_IDS, DEFAULT_LOADOUT, ownedLoadout, matchPearls, type Loadout } from '../../shared/cosmetics.ts';
import { UNIT_NOUN } from '../../shared/constants.ts';
import {
  canTradeForPearls, DAILY_PEARL_CAP, DAILY_PEARL_CAP_PER_IP, isPremium, MAX_LISTINGS_PER_ACCOUNT, marketLockedText,
  sellerProceeds, SOLO_PEARL_RATE, STARTING_PEARLS, wearableLoadout, type AccountView, type EconomyClientMsg, type Listing, type OwnedItem, type Price,
} from '../../shared/economy.ts';
import type { Profile } from '../../shared/protocol.ts';
import { FAMILIES, type FamilyId } from '../../shared/types.ts';
import type { EconomyConn, MatchResult, ServerEconomy } from './api.ts';
import { ISSUED_TOKEN_RE, newId, randomToken, sha256Hex } from './crypto.ts';
import { isEmptyGuest, type AccountRec, type AccountStore } from './store.ts';

/** New guest accounts one internet connection (IPv4 address or IPv6 /64) may create per hour. */
export const NEW_ACCOUNTS_PER_IP_HOUR = 20;
/** Listings sent to one client: all of their own plus the newest of everyone else's. */
export const MARKET_SEND_LIMIT = 200;
/** A {t:'market'} request keeps live market updates coming for this long (the client renews it). */
export const MARKET_WATCH_MS = 60_000;
/** 'seen' alone is written at most this often. */
const SEEN_WRITE_MS = 3600_000;
const MARKET_PUSH_MS = 150;

export const ACCOUNT_LIMIT_MESSAGE =
  'Too many new accounts were made from your internet connection in the last hour, so this server did not give you one. You can still play, but Pearls, the Store and the Market need an account. Try again in an hour.';
const NO_ACCOUNT_MESSAGE = 'You are not signed in to this server, so the Store and the Market are not available. Reconnect to try again.';
const STEAM_ONLY_MESSAGE = 'Premium items are sold in the Steam version of Hook Wars.';

type Re = EconomyClientMsg['t'];
type Stats = AccountRec['stats'];

export interface EconomyServiceOptions {
  store: AccountStore;
  now?: () => number;
  log?: (line: string) => void;
  newAccountsPerIpHour?: number;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function sameLoadout(a: Loadout, b: Loadout): boolean {
  const ka = Object.keys(a).filter((k) => a[k as keyof Loadout]);
  const kb = Object.keys(b).filter((k) => b[k as keyof Loadout]);
  return ka.length === kb.length && ka.every((k) => a[k as keyof Loadout] === b[k as keyof Loadout]);
}

function defaultLoadouts(): Record<FamilyId, Loadout> {
  const out = {} as Record<FamilyId, Loadout>;
  for (const f of FAMILIES) out[f] = { ...DEFAULT_LOADOUT[f] };
  return out;
}

/**
 * One key per internet connection: the IPv4 address itself (IPv4-mapped IPv6 unwrapped), or the
 * /64 network of an IPv6 address, because one IPv6 home has a whole /64 and rotates addresses in it.
 */
export function netKey(ip: string): string {
  let s = ip.trim().toLowerCase();
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7);
  if (!s.includes(':')) return s;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const parts = s.split('::');
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
  const groups = parts.length > 1 ? [...head, ...new Array<string>(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':')}::/64`;
}

const DEFAULT_SET: ReadonlySet<string> = new Set(DEFAULT_ITEM_IDS);

export class EconomyService implements ServerEconomy {
  private readonly store: AccountStore;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly newPerIp: number;

  private readonly conns = new Map<number, EconomyConn>();
  private readonly byAccount = new Map<string, Set<EconomyConn>>();
  private readonly tokenIndex = new Map<string, string>(); // sha256(token) -> account id
  private readonly newByIp = new Map<string, { n: number; since: number; hashes: Set<string> }>();
  /** Pearls paid per internet connection today (memory only: a restart resets it) */
  private readonly ipDay = new Map<string, { day: string; pearls: number }>();
  /** connection -> when its market subscription ends */
  private readonly marketWatchers = new Map<EconomyConn, number>();
  private marketTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(opts: EconomyServiceOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((s) => console.log(s));
    this.newPerIp = opts.newAccountsPerIpHour ?? NEW_ACCOUNTS_PER_IP_HOUR;
    this.reconcile();
  }

  private get db() {
    return this.store.db;
  }

  // ------------------------------------------------------------------------------------------
  // Start-up: indexes and consistency
  // ------------------------------------------------------------------------------------------

  private reconcile(): void {
    const db = this.db;
    for (const a of db.accounts.values()) this.normalise(a);
    const listedInstances = new Set<string>();
    for (const [id, l] of db.listings) {
      const owner = db.accounts.get(l.seller);
      const o = owner?.owned.find((x) => x.instance === l.instance);
      if (!owner || !o || (o.listed && o.listed !== id) || l.price?.cur !== 'pearls' || !canTradeForPearls(cosmeticById(l.item))) {
        db.listings.delete(id);
        this.store.dirtyListing(id);
        continue;
      }
      if (o.listed !== id) {
        o.listed = id;
        this.store.dirtyAccount(owner.id);
      }
      listedInstances.add(o.instance);
    }
    const worth = (a: AccountRec) => a.pearls + a.owned.length * 1000 + a.stats.matches;
    for (const [id, a] of db.accounts) {
      if (isEmptyGuest(a)) {
        // nothing to keep: the browser still has its token and gets a fresh empty account back
        db.accounts.delete(id);
        this.store.dirtyAccount(id);
        continue;
      }
      for (const o of a.owned) {
        if (o.listed && !listedInstances.has(o.instance)) {
          delete o.listed;
          this.store.dirtyAccount(id);
        }
      }
      // two records on one token (only by hand-merged data): the one with more in it keeps it
      const prev = this.tokenIndex.get(a.tokenHash);
      const other = prev ? db.accounts.get(prev) : undefined;
      if (!other || worth(a) > worth(other) || (worth(a) === worth(other) && a.created < other.created)) this.tokenIndex.set(a.tokenHash, id);
    }
  }

  /** Fill fields an older record or a hand edit may lack. */
  private normalise(a: AccountRec): void {
    if (!Array.isArray(a.owned)) a.owned = [];
    if (typeof a.pearls !== 'number' || !Number.isFinite(a.pearls) || a.pearls < 0) a.pearls = 0;
    a.pearls = Math.floor(a.pearls);
    const lo = (a.loadouts ?? {}) as Partial<Record<FamilyId, Loadout>>;
    a.loadouts = defaultLoadouts();
    for (const f of FAMILIES) if (lo[f] && typeof lo[f] === 'object') a.loadouts[f] = lo[f];
    const s = (a.stats ?? {}) as Partial<Stats>;
    a.stats = { matches: s.matches ?? 0, wins: s.wins ?? 0, kills: s.kills ?? 0, hooksHit: s.hooksHit ?? 0 };
    a.day = typeof a.day === 'string' ? a.day : '';
    a.dayPearls = typeof a.dayPearls === 'number' ? a.dayPearls : 0;
    a.lastPaid = typeof a.lastPaid === 'number' ? a.lastPaid : 0;
    a.created = typeof a.created === 'number' ? a.created : this.now();
    a.seen = typeof a.seen === 'number' ? a.seen : 0;
    a.name = typeof a.name === 'string' && a.name ? a.name : UNIT_NOUN.one;
  }

  // ------------------------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------------------------

  private fail(c: EconomyConn, code: string, message: string, re?: Re): void {
    c.send(re ? { t: 'econError', code, message, re } : { t: 'econError', code, message });
  }

  private account(c: EconomyConn): AccountRec | null {
    return c.accountId ? (this.db.accounts.get(c.accountId) ?? null) : null;
  }

  view(a: AccountRec): AccountView {
    const loadouts = {} as Record<FamilyId, Loadout>;
    for (const f of FAMILIES) loadouts[f] = { ...a.loadouts[f] };
    return {
      id: a.id,
      pearls: a.pearls,
      // premium copies (from the old Solana build) stay on the record but do not count here
      owned: a.owned.filter((o) => !isPremium(o.item)).map((o) => (o.listed ? { instance: o.instance, item: o.item, listed: o.listed } : { instance: o.instance, item: o.item })),
      loadouts,
      stats: { ...a.stats },
      earnedToday: a.day === utcDay(this.now()) ? a.dayPearls : 0,
      created: a.created,
    };
  }

  /** Send the account to every open connection on it. */
  private sendAccount(a: AccountRec): void {
    const v = this.view(a);
    for (const c of this.byAccount.get(a.id) ?? []) c.send({ t: 'account', a: v });
  }

  private owns(a: AccountRec, item: string): boolean {
    return DEFAULT_SET.has(item) || (!isPremium(item) && a.owned.some((o) => o.item === item));
  }

  /** Can this account wear the item right now? (owned and not held in market escrow) */
  private canWear(a: AccountRec, item: string): boolean {
    return DEFAULT_SET.has(item) || (!isPremium(item) && a.owned.some((o) => o.item === item && !o.listed));
  }

  /**
   * One stored loadout per family. A requested loadout that is fully wearable becomes the stored
   * one; anything else falls back to the stored loadout (clamped), so the room and the client agree.
   */
  private adoptLoadout(a: AccountRec, family: FamilyId, requested: Loadout): Loadout {
    const wear = wearableLoadout(family, requested, (id) => this.canWear(a, id));
    if (sameLoadout(wear, requested)) {
      if (!sameLoadout(wear, a.loadouts[family])) {
        a.loadouts[family] = wear;
        this.store.dirtyAccount(a.id);
      }
      return wear;
    }
    return this.storedLoadout(a, family);
  }

  /** The stored loadout for a family, clamped to what the account can wear now. */
  private storedLoadout(a: AccountRec, family: FamilyId): Loadout {
    const stored = wearableLoadout(family, a.loadouts[family], (id) => this.canWear(a, id));
    if (!sameLoadout(stored, a.loadouts[family])) {
      a.loadouts[family] = stored;
      this.store.dirtyAccount(a.id);
    }
    return stored;
  }

  /** After an item became unwearable (listed, sold): re-clamp every stored loadout and live profile. */
  private reclampAll(a: AccountRec): void {
    for (const f of FAMILIES) a.loadouts[f] = wearableLoadout(f, a.loadouts[f], (id) => this.canWear(a, id));
    for (const c of this.byAccount.get(a.id) ?? []) c.profile = { ...c.profile, loadout: { ...a.loadouts[c.profile.family] } };
  }

  private attach(c: EconomyConn, a: AccountRec): void {
    c.accountId = a.id;
    this.conns.set(c.id, c);
    let set = this.byAccount.get(a.id);
    if (!set) this.byAccount.set(a.id, (set = new Set()));
    set.add(c);
  }

  /**
   * At most newPerIp new accounts per internet connection per hour. A token this connection already
   * bound in the last hour (an empty guest coming back) does not count twice.
   */
  private allowNewAccount(ip: string, tokenHash: string | null): boolean {
    const now = this.now();
    const key = netKey(ip);
    let e = this.newByIp.get(key);
    if (!e || now - e.since > 3600_000) {
      if (this.newByIp.size > 10_000) this.newByIp.clear(); // bounded; a reset only loosens the limit
      e = { n: 0, since: now, hashes: new Set() };
      this.newByIp.set(key, e);
    }
    if (tokenHash && e.hashes.has(tokenHash)) return true;
    if (e.n >= this.newPerIp) return false;
    e.n++;
    if (tokenHash) e.hashes.add(tokenHash);
    return true;
  }

  private createAccount(name: string, tokenHash: string): AccountRec {
    const now = this.now();
    let id = newId('acc');
    while (this.db.accounts.has(id)) id = newId('acc');
    const a: AccountRec = {
      id, tokenHash, created: now, seen: now, name, pearls: STARTING_PEARLS, owned: [], loadouts: defaultLoadouts(),
      stats: { matches: 0, wins: 0, kills: 0, hooksHit: 0 }, day: '', dayPearls: 0, lastPaid: 0,
    };
    this.db.accounts.set(id, a);
    this.tokenIndex.set(tokenHash, id);
    this.store.dirtyAccount(id); // an empty guest is not written until it has something to keep
    return a;
  }

  private rename(a: AccountRec, name: string): void {
    a.name = name;
    this.store.dirtyAccount(a.id);
    for (const l of this.db.listings.values()) {
      if (l.seller !== a.id) continue;
      l.sellerName = name;
      this.store.dirtyListing(l.id);
    }
  }

  /** Drop an account that has nothing worth keeping once its last connection is gone. */
  private dropIfEmpty(a: AccountRec): void {
    if (!isEmptyGuest(a) || this.byAccount.has(a.id)) return;
    this.db.accounts.delete(a.id);
    if (this.tokenIndex.get(a.tokenHash) === a.id) this.tokenIndex.delete(a.tokenHash);
    this.store.dirtyAccount(a.id);
  }

  // ------------------------------------------------------------------------------------------
  // ServerEconomy
  // ------------------------------------------------------------------------------------------

  onHello(c: EconomyConn, token: string | undefined): Profile {
    let a: AccountRec | null = null;
    const hash = token ? sha256Hex(token) : null;
    if (hash) {
      const id = this.tokenIndex.get(hash);
      a = id ? (this.db.accounts.get(id) ?? null) : null;
    }
    let newToken: string | undefined;
    let made = false;
    if (!a) {
      // A token in the shape this server issues but not known here (an empty guest coming back, or
      // data this server lost) keeps working: it is bound to the new account, so the browser never
      // has to throw it away. Anything else gets a fresh token.
      const rebind = token !== undefined && ISSUED_TOKEN_RE.test(token);
      if (!this.allowNewAccount(c.ip, rebind ? hash : null)) {
        c.accountId = null;
        queueMicrotask(() => c.send({ t: 'econError', code: 'account_limit', message: ACCOUNT_LIMIT_MESSAGE }));
        return { ...c.profile, loadout: ownedLoadout(c.profile.loadout, (id) => DEFAULT_SET.has(id)) };
      }
      if (rebind) a = this.createAccount(c.profile.name, hash!);
      else {
        newToken = randomToken();
        a = this.createAccount(c.profile.name, sha256Hex(newToken));
      }
      made = true;
    }
    this.attach(c, a);
    const now = this.now();
    if (now - a.seen > SEEN_WRITE_MS) this.store.dirtyAccount(a.id);
    a.seen = now;
    if (a.name !== c.profile.name) this.rename(a, c.profile.name);
    // A known account wears what it last equipped online: the hello loadout comes from this
    // browser's saved profile, which the offline locker may have trimmed to what it owns. A new
    // account starts from the hello loadout, clamped to the defaults it owns.
    const loadout = made ? this.adoptLoadout(a, c.profile.family, c.profile.loadout) : this.storedLoadout(a, c.profile.family);
    const profile: Profile = { ...c.profile, loadout };
    const acc = a;
    // after 'welcome', which the game server sends as soon as this returns
    queueMicrotask(() => c.send(newToken ? { t: 'account', a: this.view(acc), token: newToken } : { t: 'account', a: this.view(acc) }));
    return profile;
  }

  sanitize(c: EconomyConn, p: Profile): Profile {
    const a = this.account(c);
    if (!a) return { ...p, loadout: ownedLoadout(p.loadout, (id) => DEFAULT_SET.has(id)) };
    if (a.name !== p.name) this.rename(a, p.name);
    const loadout = this.adoptLoadout(a, p.family, p.loadout);
    if (!sameLoadout(loadout, p.loadout)) queueMicrotask(() => c.send({ t: 'account', a: this.view(a) }));
    return { ...p, loadout };
  }

  route(c: EconomyConn, msg: EconomyClientMsg): void {
    const a = this.account(c);
    if (!a) return this.fail(c, 'no_account', NO_ACCOUNT_MESSAGE, msg.t);
    a.seen = this.now();
    switch (msg.t) {
      case 'equip':
        return this.equip(c, a, msg.family, msg.loadout);
      case 'storeBuy':
        return this.storeBuy(c, a, msg.item);
      case 'market':
        this.marketWatchers.set(c, this.now() + MARKET_WATCH_MS);
        c.send({ t: 'market', listings: this.listingsFor(a) });
        return;
      case 'marketSell':
        return this.marketSell(c, a, msg.instance, msg.price);
      case 'marketBuy':
        return this.marketBuy(c, a, msg.listing);
      case 'marketCancel':
        return this.marketCancel(c, a, msg.listing);
      default:
        return;
    }
  }

  onMatchEnd(results: MatchResult[]): void {
    const now = this.now();
    const day = utcDay(now);
    const entries: { r: MatchResult; c: EconomyConn; a: AccountRec }[] = [];
    const paid = new Set<string>();
    for (const r of results) {
      const c = this.conns.get(r.connId);
      const a = c ? this.account(c) : null;
      if (!c || !a || paid.has(a.id)) continue; // each account is paid once per match (two tabs on one token)
      paid.add(a.id);
      entries.push({ r, c, a });
    }
    // Anti-farm: a match needs humans on at least two different internet connections to pay the full rate.
    const nets = new Set(entries.map((e) => netKey(e.c.ip))).size;
    const rate = nets >= 2 ? 1 : SOLO_PEARL_RATE;
    if (this.ipDay.size > 50_000) for (const [k, v] of this.ipDay) if (v.day !== day) this.ipDay.delete(k);
    for (const { r, c, a } of entries) {
      a.stats.matches++;
      if (r.won) a.stats.wins++;
      a.stats.kills += r.row.k;
      a.stats.hooksHit += r.row.hh;
      if (a.day !== day) {
        a.day = day;
        a.dayPearls = 0;
      }
      const key = netKey(c.ip);
      let ipe = this.ipDay.get(key);
      if (!ipe || ipe.day !== day) this.ipDay.set(key, (ipe = { day, pearls: 0 }));
      const afk = r.row.ht === 0; // never threw a hook: no Pearls
      const earned = afk ? 0 : Math.round(matchPearls(r.won, r.row.k, r.row.hh, r.row.sv) * rate);
      const roomAccount = Math.max(0, DAILY_PEARL_CAP - a.dayPearls);
      const roomIp = Math.max(0, DAILY_PEARL_CAP_PER_IP - ipe.pearls);
      const pay = Math.min(earned, roomAccount, roomIp);
      a.pearls += pay;
      a.dayPearls += pay;
      ipe.pearls += pay;
      if (pay > 0) a.lastPaid = now;
      const reason = afk
        ? 'no hooks thrown, no Pearls'
        : pay < earned
          ? roomAccount <= roomIp
            ? `daily limit of ${DAILY_PEARL_CAP} reached`
            : `daily limit of ${DAILY_PEARL_CAP_PER_IP} for your internet connection reached`
          : `${r.won ? 'win' : 'match'}${rate < 1 ? ', half rate: no other players online' : ''}`;
      for (const cc of this.byAccount.get(a.id) ?? []) cc.send({ t: 'reward', pearls: pay, reason });
      this.store.dirtyAccount(a.id);
      this.sendAccount(a);
    }
    if (entries.length) this.store.commit(); // Pearls are money: every player of the match in one transaction
  }

  unwatchMarket(c: EconomyConn): void {
    this.marketWatchers.delete(c);
  }

  onDisconnect(c: EconomyConn): void {
    this.conns.delete(c.id);
    this.marketWatchers.delete(c);
    if (!c.accountId) return;
    const set = this.byAccount.get(c.accountId);
    set?.delete(c);
    if (set && set.size === 0) this.byAccount.delete(c.accountId);
    const a = this.db.accounts.get(c.accountId);
    if (a) this.dropIfEmpty(a);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.marketTimer) clearTimeout(this.marketTimer);
    this.marketTimer = null;
    this.store.close();
  }

  // ------------------------------------------------------------------------------------------
  // Locker and store
  // ------------------------------------------------------------------------------------------

  private equip(c: EconomyConn, a: AccountRec, family: FamilyId, loadout: Loadout): void {
    const wear = wearableLoadout(family, loadout, (id) => this.canWear(a, id));
    if (!sameLoadout(wear, a.loadouts[family])) this.store.dirtyAccount(a.id);
    a.loadouts[family] = wear;
    for (const cc of this.byAccount.get(a.id) ?? []) if (cc.profile.family === family) cc.profile = { ...cc.profile, loadout: { ...wear } };
    if (c.profile.family === family) c.profile = { ...c.profile, loadout: { ...wear } };
    this.sendAccount(a);
  }

  private storeBuy(c: EconomyConn, a: AccountRec, item: string): void {
    const def = cosmeticById(item);
    if (def?.rarity === 'premium') return this.fail(c, 'steam_only', STEAM_ONLY_MESSAGE, 'storeBuy');
    if (!def || def.pearls === undefined || def.rarity === 'default') return this.fail(c, 'not_for_sale', 'That item is not sold for Pearls.', 'storeBuy');
    if (this.owns(a, item)) return this.fail(c, 'owned', `You already own ${def.name}.`, 'storeBuy');
    const price = def.pearls; // from the catalog, never from the client
    if (a.pearls < price) return this.fail(c, 'pearls', `You need ${price - a.pearls} more Pearls for ${def.name}.`, 'storeBuy');
    a.pearls -= price;
    a.owned.push({ instance: newId('itm'), item });
    this.store.dirtyAccount(a.id);
    this.store.commit();
    this.sendAccount(a);
  }

  // ------------------------------------------------------------------------------------------
  // Marketplace (Pearls, settled here)
  // ------------------------------------------------------------------------------------------

  private listingsFor(a: AccountRec | null): Listing[] {
    const all = [...this.db.listings.values()].sort((x, y) => y.created - x.created);
    const mine = a ? all.filter((l) => l.seller === a.id) : [];
    const others = all.filter((l) => !a || l.seller !== a.id).slice(0, MARKET_SEND_LIMIT);
    return [...mine, ...others].map((l) => ({ ...l, price: { ...l.price } }));
  }

  private sendMarket(): void {
    const now = this.now();
    for (const [c, until] of this.marketWatchers) {
      if (now > until) {
        this.marketWatchers.delete(c); // the Market screen stopped renewing: it was closed
        continue;
      }
      c.send({ t: 'market', listings: this.listingsFor(this.account(c)) });
    }
  }

  /** Push the market to everyone watching it, at most every MARKET_PUSH_MS. */
  private pushMarket(): void {
    if (this.marketTimer || this.closed) return;
    this.marketTimer = setTimeout(() => {
      this.marketTimer = null;
      this.sendMarket();
    }, MARKET_PUSH_MS);
    this.marketTimer.unref?.();
  }

  /** Send a pending market push right away (tests). */
  flushMarket(): void {
    if (!this.marketTimer) return;
    clearTimeout(this.marketTimer);
    this.marketTimer = null;
    this.sendMarket();
  }

  private marketLocked(c: EconomyConn, a: AccountRec, re: Re): boolean {
    const why = marketLockedText(a, this.now());
    if (why) this.fail(c, 'too_new', why, re);
    return why !== null;
  }

  private marketSell(c: EconomyConn, a: AccountRec, instance: string, price: Price): void {
    const o = a.owned.find((x) => x.instance === instance);
    if (!o || isPremium(o.item)) return this.fail(c, 'not_owned', 'You do not own that item.', 'marketSell');
    const def = cosmeticById(o.item);
    if (!canTradeForPearls(def)) return this.fail(c, 'not_tradable', 'Only Epic items can be sold on the marketplace.', 'marketSell');
    if (o.listed) return this.fail(c, 'listed', 'That item is already for sale.', 'marketSell');
    if (this.marketLocked(c, a, 'marketSell')) return;
    let mine = 0;
    for (const l of this.db.listings.values()) if (l.seller === a.id) mine++;
    if (mine >= MAX_LISTINGS_PER_ACCOUNT) return this.fail(c, 'too_many', `You can have ${MAX_LISTINGS_PER_ACCOUNT} items for sale at once.`, 'marketSell');
    let id = newId('lst');
    while (this.db.listings.has(id)) id = newId('lst');
    const l: Listing = { id, seller: a.id, sellerName: a.name, instance: o.instance, item: o.item, price: { cur: 'pearls', amount: price.amount }, created: this.now() };
    this.db.listings.set(id, l);
    o.listed = id; // escrow: it stays in the inventory but cannot be worn until the listing ends
    this.reclampAll(a);
    this.store.dirtyAccount(a.id);
    this.store.dirtyListing(id);
    this.store.commit();
    this.sendAccount(a);
    this.pushMarket();
  }

  private marketBuy(c: EconomyConn, a: AccountRec, listingId: string): void {
    const l = this.db.listings.get(listingId);
    if (!l) return this.fail(c, 'gone', 'That item was just sold or taken off the market.', 'marketBuy'); // nothing changed: no save, no push
    if (l.seller === a.id) return this.fail(c, 'own_listing', 'That is your own listing. Cancel it instead.', 'marketBuy');
    if (this.owns(a, l.item)) return this.fail(c, 'owned', `You already own ${cosmeticById(l.item)?.name ?? 'that item'}.`, 'marketBuy');
    if (this.marketLocked(c, a, 'marketBuy')) return;
    const seller = this.db.accounts.get(l.seller);
    const o = seller?.owned.find((x) => x.instance === l.instance && x.listed === l.id);
    if (!seller || !o) {
      // a stale listing: removing it is a real change, so save and tell the watchers
      this.db.listings.delete(l.id);
      this.store.dirtyListing(l.id);
      this.store.commit();
      this.pushMarket();
      return this.fail(c, 'gone', 'That item is no longer for sale.', 'marketBuy');
    }
    const price = l.price.amount;
    if (a.pearls < price) return this.fail(c, 'pearls', `You need ${price - a.pearls} more Pearls.`, 'marketBuy');
    a.pearls -= price;
    seller.pearls += sellerProceeds(price); // the 5% fee is not paid to anyone: it leaves the economy
    seller.owned = seller.owned.filter((x) => x !== o);
    const moved: OwnedItem = { instance: o.instance, item: o.item };
    a.owned.push(moved);
    this.db.listings.delete(l.id);
    this.store.dirtyAccount(a.id);
    this.store.dirtyAccount(seller.id);
    this.store.dirtyListing(l.id);
    this.store.commit(); // both sides of the trade in one transaction
    this.sendAccount(a);
    this.sendAccount(seller); // the seller's client shows "Sold" when the listed item leaves its inventory
    this.pushMarket();
  }

  private marketCancel(c: EconomyConn, a: AccountRec, listingId: string): void {
    const l = this.db.listings.get(listingId);
    if (!l || l.seller !== a.id) return this.fail(c, 'gone', 'That listing is no longer on the market.', 'marketCancel');
    this.db.listings.delete(l.id);
    const o = a.owned.find((x) => x.instance === l.instance);
    if (o) delete o.listed;
    this.store.dirtyAccount(a.id);
    this.store.dirtyListing(l.id);
    this.store.commit();
    this.sendAccount(a);
    this.pushMarket();
  }

  // ------------------------------------------------------------------------------------------
  // Introspection for tests and tools
  // ------------------------------------------------------------------------------------------

  accountById(id: string): AccountRec | undefined {
    return this.db.accounts.get(id);
  }
}
