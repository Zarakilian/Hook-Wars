// The economy service: guest accounts, Pearls, the Pearl store, match rewards, the Pearl
// marketplace, the wallet link (Sign in with Solana) and Limited items bought with devnet USDC.
//
// The game server calls this through the ServerEconomy contract (./api.ts). Everything here is
// the source of truth: prices and supplies come from the catalog (shared/cosmetics.ts), never
// from a client message. Node runs one message at a time, so every Pearl step below (check, then
// deduct) runs without interruption; a double click simply finds the work already done.
//
// Async work (chain calls) is tracked so tests can await idle(). Every timer is unref'd and
// cleared on close(), so the service never keeps a process alive on its own.
import { randomBytes } from 'node:crypto';
import { cosmeticById, DEFAULT_ITEM_IDS, DEFAULT_LOADOUT, ownedLoadout, matchPearls, type Loadout } from '../../shared/cosmetics.ts';
import {
  base58Decode, base58Encode, canTradeForPearls, DAILY_PEARL_CAP, MAX_LISTINGS_PER_ACCOUNT, sellerProceeds, SOLO_PEARL_RATE, STARTING_PEARLS,
  walletChallengeText, wearableLoadout, type AccountView, type EconomyClientMsg, type Listing, type OwnedItem, type Price,
} from '../../shared/economy.ts';
import type { Profile } from '../../shared/protocol.ts';
import { FAMILIES, type FamilyId } from '../../shared/types.ts';
import type { EconomyConn, MatchResult, ServerEconomy } from './api.ts';
import { ChainError, type ChainAdapter, type StoredTransfer } from './chain.ts';
import { newId, randomToken, sha256Hex, splitWireTx, verifyEd25519 } from './crypto.ts';
import type { AccountRec, AccountStore, OrderRec } from './store.ts';

/** A wallet-link challenge lives this long (Sign in with Solana nonces are short lived). */
export const CHALLENGE_MS = 5 * 60_000;
/** New guest accounts one IP address may create per hour. */
export const NEW_ACCOUNTS_PER_IP_HOUR = 20;
/** Empty guest accounts (nothing earned, owned or linked) not seen for this long are dropped at start. */
export const EMPTY_GUEST_TTL_MS = 30 * 24 * 3600_000;
/** Listings sent to one client: all of their own plus the newest of everyone else's. */
export const MARKET_SEND_LIMIT = 200;
/** Grace after an order's blockhash expiry before the server asks the chain whether it landed. */
const ORDER_SWEEP_GRACE_MS = 5_000;
const MARKET_PUSH_MS = 150;

type Re = EconomyClientMsg['t'];
type Stats = AccountRec['stats'];

export interface EconomyServiceOptions {
  store: AccountStore;
  chain: ChainAdapter;
  /** shown in the wallet-link message */
  domain: string;
  /** what clients are told the chain runs on */
  network: 'off' | 'devnet';
  /** off-chain metadata base URL; minted assets get <base>/<item id>.json ('' = no uri) */
  metadataBaseUrl?: string;
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

const DEFAULT_SET: ReadonlySet<string> = new Set(DEFAULT_ITEM_IDS);
/** Chain errors raised before anything reached the network: the order can be signed again. */
const RETRYABLE_SUBMIT: ReadonlySet<string> = new Set(['bad_tx', 'tx_modified', 'not_signed', 'insufficient_usdc', 'rejected']);

export class EconomyService implements ServerEconomy {
  private readonly store: AccountStore;
  private readonly chain: ChainAdapter;
  private readonly domain: string;
  private readonly network: 'off' | 'devnet';
  private readonly metadataBaseUrl: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly newPerIp: number;

  private readonly conns = new Map<number, EconomyConn>();
  private readonly byAccount = new Map<string, Set<EconomyConn>>();
  private readonly tokenIndex = new Map<string, string>(); // sha256(token) -> account id
  private readonly walletIndex = new Map<string, string>(); // wallet -> account id
  private readonly challenges = new Map<string, { message: string; expires: number }>(); // by account id
  private readonly newByIp = new Map<string, { n: number; since: number }>();
  private readonly marketWatchers = new Set<EconomyConn>();
  private readonly building = new Map<string, Promise<void>>(); // order id -> transaction being built
  private readonly pending = new Set<Promise<unknown>>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly mintTries = new Map<string, number>();
  private readonly recheckTries = new Map<string, number>();
  private marketTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSweep = 0;
  private closed = false;

  constructor(opts: EconomyServiceOptions) {
    this.store = opts.store;
    this.chain = opts.chain;
    this.domain = opts.domain;
    this.network = opts.network;
    this.metadataBaseUrl = (opts.metadataBaseUrl ?? '').replace(/\/+$/, '');
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((s) => console.log(s));
    this.newPerIp = opts.newAccountsPerIpHour ?? NEW_ACCOUNTS_PER_IP_HOUR;
    this.reconcile();
    // finish anything a previous run left half done (paid but not minted, submitted but unconfirmed)
    if (Object.keys(this.store.db.orders).length) this.later(0, () => this.sweepOrders(true));
  }

  private get db() {
    return this.store.db;
  }

  // ------------------------------------------------------------------------------------------
  // Start-up: indexes and consistency
  // ------------------------------------------------------------------------------------------

  private reconcile(): void {
    const db = this.db;
    const now = this.now();
    let changed = false;
    const listedInstances = new Set<string>();
    for (const [id, l] of Object.entries(db.listings)) {
      const owner = db.accounts[l.seller];
      const o = owner?.owned.find((x) => x.instance === l.instance);
      if (!owner || !o || (o.listed && o.listed !== id)) {
        delete db.listings[id];
        changed = true;
        continue;
      }
      o.listed = id;
      listedInstances.add(o.instance);
    }
    const busyAccounts = new Set(Object.values(db.orders).filter((o) => o.status === 'open' || o.status === 'submitted' || o.status === 'paid').map((o) => o.account));
    for (const [id, a] of Object.entries(db.accounts)) {
      if (this.isEmptyGuest(a) && !busyAccounts.has(id) && now - a.seen > EMPTY_GUEST_TTL_MS) {
        delete db.accounts[id];
        changed = true;
        continue;
      }
      this.normalise(a);
      for (const o of a.owned) {
        if (o.listed && !listedInstances.has(o.instance)) {
          delete o.listed;
          changed = true;
        }
      }
      this.tokenIndex.set(a.tokenHash, id);
      if (a.wallet) this.walletIndex.set(a.wallet, id);
    }
    if (changed) this.store.markDirty();
  }

  /** Fill fields an older file or a hand edit may lack. */
  private normalise(a: AccountRec): void {
    if (!Array.isArray(a.owned)) a.owned = [];
    if (typeof a.pearls !== 'number' || !Number.isFinite(a.pearls) || a.pearls < 0) a.pearls = 0;
    a.pearls = Math.floor(a.pearls);
    const lo = (a.loadouts ?? {}) as Partial<Record<FamilyId, Loadout>>;
    a.loadouts = defaultLoadouts();
    for (const f of FAMILIES) if (lo[f]) a.loadouts[f] = lo[f];
    const s = (a.stats ?? {}) as Partial<Stats>;
    a.stats = { matches: s.matches ?? 0, wins: s.wins ?? 0, kills: s.kills ?? 0, hooksHit: s.hooksHit ?? 0 };
    a.wallet = typeof a.wallet === 'string' ? a.wallet : null;
    a.day = typeof a.day === 'string' ? a.day : '';
    a.dayPearls = typeof a.dayPearls === 'number' ? a.dayPearls : 0;
    a.lastPaid = typeof a.lastPaid === 'number' ? a.lastPaid : 0;
    a.name = typeof a.name === 'string' ? a.name : 'Pudgy';
  }

  private isEmptyGuest(a: AccountRec): boolean {
    return a.pearls === 0 && a.owned.length === 0 && !a.wallet && (a.stats?.matches ?? 0) === 0;
  }

  // ------------------------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------------------------

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p)).catch(() => {});
    return p;
  }

  /** Run fn after ms (unref'd, tracked, cancelled by close). */
  private later(ms: number, fn: () => Promise<void> | void): void {
    if (this.closed) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.closed) return;
      this.track(Promise.resolve().then(fn)).catch((err: unknown) => this.log(`[economy] background task failed: ${(err as Error).message}`));
    }, ms);
    t.unref?.();
    this.timers.add(t);
  }

  /** Resolves when no chain work or scheduled task is running (tests). Timers waiting to fire are not awaited. */
  async idle(): Promise<void> {
    for (let i = 0; i < 100 && this.pending.size; i++) await Promise.allSettled([...this.pending]);
  }

  private fail(c: EconomyConn, code: string, message: string, re?: Re): void {
    c.send(re ? { t: 'econError', code, message, re } : { t: 'econError', code, message });
  }

  private account(c: EconomyConn): AccountRec | null {
    return c.accountId ? (this.db.accounts[c.accountId] ?? null) : null;
  }

  view(a: AccountRec): AccountView {
    const loadouts = {} as Record<FamilyId, Loadout>;
    for (const f of FAMILIES) loadouts[f] = { ...a.loadouts[f] };
    return {
      id: a.id,
      pearls: a.pearls,
      owned: a.owned.map((o) => ({ ...o })),
      loadouts,
      wallet: a.wallet,
      network: this.network,
      stats: { ...a.stats },
      earnedToday: a.day === utcDay(this.now()) ? a.dayPearls : 0,
    };
  }

  /** Send the account to every open connection on it. */
  private sendAccount(a: AccountRec): void {
    const v = this.view(a);
    for (const c of this.byAccount.get(a.id) ?? []) c.send({ t: 'account', a: v });
  }

  private owns(a: AccountRec, item: string): boolean {
    return DEFAULT_SET.has(item) || a.owned.some((o) => o.item === item);
  }

  /** Can this account wear the item right now? (owned and not held in market escrow) */
  private canWear(a: AccountRec, item: string): boolean {
    return DEFAULT_SET.has(item) || a.owned.some((o) => o.item === item && !o.listed);
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
        this.store.markDirty();
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
      this.store.markDirty();
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

  private allowNewAccount(ip: string): boolean {
    const now = this.now();
    const e = this.newByIp.get(ip);
    if (!e || now - e.since > 3600_000) {
      if (this.newByIp.size > 10_000) this.newByIp.clear(); // bounded; a reset only loosens the limit
      this.newByIp.set(ip, { n: 1, since: now });
      return true;
    }
    if (e.n >= this.newPerIp) return false;
    e.n++;
    return true;
  }

  private createAccount(name: string): { a: AccountRec; token: string } {
    const token = randomToken();
    const now = this.now();
    let id = newId('acc');
    while (this.db.accounts[id]) id = newId('acc');
    const a: AccountRec = {
      id, tokenHash: sha256Hex(token), created: now, seen: now, name, pearls: STARTING_PEARLS, owned: [], loadouts: defaultLoadouts(),
      wallet: null, stats: { matches: 0, wins: 0, kills: 0, hooksHit: 0 }, day: '', dayPearls: 0, lastPaid: 0,
    };
    this.db.accounts[id] = a;
    this.tokenIndex.set(a.tokenHash, id);
    this.store.markDirty();
    return { a, token };
  }

  // ------------------------------------------------------------------------------------------
  // ServerEconomy
  // ------------------------------------------------------------------------------------------

  onHello(c: EconomyConn, token: string | undefined): Profile {
    let a: AccountRec | null = null;
    if (token) {
      const id = this.tokenIndex.get(sha256Hex(token));
      a = id ? (this.db.accounts[id] ?? null) : null;
    }
    let newToken: string | undefined;
    if (!a) {
      if (!this.allowNewAccount(c.ip)) {
        c.accountId = null;
        return { ...c.profile, loadout: ownedLoadout(c.profile.loadout, (id) => DEFAULT_SET.has(id)) };
      }
      const made = this.createAccount(c.profile.name);
      a = made.a;
      newToken = made.token;
    }
    this.attach(c, a);
    a.seen = this.now();
    a.name = c.profile.name;
    this.store.markDirty();
    // A known account wears what it last equipped online: the hello loadout comes from this
    // browser's saved profile, which the offline locker may have trimmed to what it owns. A new
    // account starts from the hello loadout, clamped to the defaults it owns.
    const loadout = newToken ? this.adoptLoadout(a, c.profile.family, c.profile.loadout) : this.storedLoadout(a, c.profile.family);
    const profile: Profile = { ...c.profile, loadout };
    const acc = a;
    // after 'welcome', which the game server sends as soon as this returns
    queueMicrotask(() => c.send(newToken ? { t: 'account', a: this.view(acc), token: newToken } : { t: 'account', a: this.view(acc) }));
    return profile;
  }

  sanitize(c: EconomyConn, p: Profile): Profile {
    const a = this.account(c);
    if (!a) return { ...p, loadout: ownedLoadout(p.loadout, (id) => DEFAULT_SET.has(id)) };
    if (a.name !== p.name) {
      a.name = p.name;
      for (const l of Object.values(this.db.listings)) if (l.seller === a.id) l.sellerName = p.name;
      this.store.markDirty();
    }
    const loadout = this.adoptLoadout(a, p.family, p.loadout);
    if (!sameLoadout(loadout, p.loadout)) queueMicrotask(() => c.send({ t: 'account', a: this.view(a) }));
    return { ...p, loadout };
  }

  route(c: EconomyConn, msg: EconomyClientMsg): void {
    const a = this.account(c);
    if (!a) return this.fail(c, 'no_account', 'You are not signed in to this server. Reconnect to get an account.', msg.t);
    a.seen = this.now();
    switch (msg.t) {
      case 'equip':
        return this.equip(c, a, msg.family, msg.loadout);
      case 'storeBuy':
        return this.storeBuy(c, a, msg.item);
      case 'market':
        this.marketWatchers.add(c);
        c.send({ t: 'market', listings: this.listingsFor(a) });
        return;
      case 'marketSell':
        return this.marketSell(c, a, msg.instance, msg.price);
      case 'marketBuy':
        return this.marketBuy(c, a, msg.listing);
      case 'marketCancel':
        return this.marketCancel(c, a, msg.listing);
      case 'walletChallenge':
        return this.walletChallenge(c, a);
      case 'walletLink':
        return this.walletLink(c, a, msg.address, msg.signature);
      case 'usdcOrder':
        return this.usdcOrder(c, a, msg.item);
      case 'usdcSubmit':
        return this.usdcSubmit(c, a, msg.order, msg.tx);
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
    // Anti-farm: a match needs humans on at least two different IP addresses to pay the full rate.
    const ips = new Set(entries.map((e) => e.c.ip)).size;
    const rate = ips >= 2 ? 1 : SOLO_PEARL_RATE;
    for (const { r, a } of entries) {
      a.stats.matches++;
      if (r.won) a.stats.wins++;
      a.stats.kills += r.row.k;
      a.stats.hooksHit += r.row.hh;
      if (a.day !== day) {
        a.day = day;
        a.dayPearls = 0;
      }
      const afk = r.row.ht === 0; // never threw a hook: no Pearls
      const earned = afk ? 0 : Math.round(matchPearls(r.won, r.row.k, r.row.hh, r.row.sv) * rate);
      const room = Math.max(0, DAILY_PEARL_CAP - a.dayPearls);
      const pay = Math.min(earned, room);
      a.pearls += pay;
      a.dayPearls += pay;
      if (pay > 0) a.lastPaid = now;
      const reason = afk
        ? 'no hooks thrown, no Pearls'
        : pay < earned
          ? `daily limit of ${DAILY_PEARL_CAP} reached`
          : `${r.won ? 'win' : 'match'}${rate < 1 ? ', half rate: no other players online' : ''}`;
      for (const cc of this.byAccount.get(a.id) ?? []) cc.send({ t: 'reward', pearls: pay, reason });
      this.sendAccount(a);
    }
    if (entries.length) this.store.markDirty();
  }

  onDisconnect(c: EconomyConn): void {
    this.conns.delete(c.id);
    this.marketWatchers.delete(c);
    if (c.accountId) {
      const set = this.byAccount.get(c.accountId);
      set?.delete(c);
      if (set && set.size === 0) this.byAccount.delete(c.accountId);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.marketTimer) clearTimeout(this.marketTimer);
    this.marketTimer = null;
    this.store.close();
    this.chain.close();
  }

  // ------------------------------------------------------------------------------------------
  // Locker and store
  // ------------------------------------------------------------------------------------------

  private equip(c: EconomyConn, a: AccountRec, family: FamilyId, loadout: Loadout): void {
    const wear = wearableLoadout(family, loadout, (id) => this.canWear(a, id));
    a.loadouts[family] = wear;
    this.store.markDirty();
    for (const cc of this.byAccount.get(a.id) ?? []) if (cc.profile.family === family) cc.profile = { ...cc.profile, loadout: { ...wear } };
    if (c.profile.family === family) c.profile = { ...c.profile, loadout: { ...wear } };
    this.sendAccount(a);
  }

  private storeBuy(c: EconomyConn, a: AccountRec, item: string): void {
    const def = cosmeticById(item);
    if (!def || def.pearls === undefined || def.rarity === 'default' || def.rarity === 'limited') return this.fail(c, 'not_for_sale', 'That item is not sold for Pearls.', 'storeBuy');
    if (this.owns(a, item)) return this.fail(c, 'owned', `You already own ${def.name}.`, 'storeBuy');
    const price = def.pearls; // from the catalog, never from the client
    if (a.pearls < price) return this.fail(c, 'pearls', `You need ${price - a.pearls} more Pearls for ${def.name}.`, 'storeBuy');
    a.pearls -= price;
    a.owned.push({ instance: newId('itm'), item });
    this.store.commit();
    this.sendAccount(a);
  }

  // ------------------------------------------------------------------------------------------
  // Marketplace (Pearls, settled here)
  // ------------------------------------------------------------------------------------------

  private listingsFor(a: AccountRec | null): Listing[] {
    const all = Object.values(this.db.listings).sort((x, y) => y.created - x.created);
    const mine = a ? all.filter((l) => l.seller === a.id) : [];
    const others = all.filter((l) => !a || l.seller !== a.id).slice(0, MARKET_SEND_LIMIT);
    return [...mine, ...others].map((l) => ({ ...l, price: { ...l.price } }));
  }

  /** Push the market to everyone watching it, at most every MARKET_PUSH_MS. */
  private pushMarket(): void {
    if (this.marketTimer || this.closed) return;
    this.marketTimer = setTimeout(() => {
      this.marketTimer = null;
      for (const c of this.marketWatchers) c.send({ t: 'market', listings: this.listingsFor(this.account(c)) });
    }, MARKET_PUSH_MS);
    this.marketTimer.unref?.();
  }

  /** Send the market right away (tests and the acting client get an immediate answer). */
  flushMarket(): void {
    if (!this.marketTimer) return;
    clearTimeout(this.marketTimer);
    this.marketTimer = null;
    for (const c of this.marketWatchers) c.send({ t: 'market', listings: this.listingsFor(this.account(c)) });
  }

  private marketSell(c: EconomyConn, a: AccountRec, instance: string, price: Price): void {
    const o = a.owned.find((x) => x.instance === instance);
    if (!o) return this.fail(c, 'not_owned', 'You do not own that item.', 'marketSell');
    const def = cosmeticById(o.item);
    if (price.cur !== 'pearls' || def?.rarity === 'limited') {
      return this.fail(c, 'usdc_later', 'Limited items will trade on-chain for USDC in a later update. Epic items can be sold for Pearls now.', 'marketSell');
    }
    if (!canTradeForPearls(def)) return this.fail(c, 'not_tradable', 'Only Epic items can be sold on the marketplace.', 'marketSell');
    if (o.listed) return this.fail(c, 'listed', 'That item is already for sale.', 'marketSell');
    const mine = Object.values(this.db.listings).filter((l) => l.seller === a.id).length;
    if (mine >= MAX_LISTINGS_PER_ACCOUNT) return this.fail(c, 'too_many', `You can have ${MAX_LISTINGS_PER_ACCOUNT} items for sale at once.`, 'marketSell');
    let id = newId('lst');
    while (this.db.listings[id]) id = newId('lst');
    const l: Listing = { id, seller: a.id, sellerName: a.name, instance: o.instance, item: o.item, price: { cur: 'pearls', amount: price.amount }, created: this.now() };
    if (o.serial !== undefined) l.serial = o.serial;
    this.db.listings[id] = l;
    o.listed = id; // escrow: it stays in the inventory but cannot be worn until the listing ends
    this.reclampAll(a);
    this.store.commit();
    this.sendAccount(a);
    this.pushMarket();
  }

  private marketBuy(c: EconomyConn, a: AccountRec, listingId: string): void {
    const l = this.db.listings[listingId];
    if (!l) return this.fail(c, 'gone', 'That item was just sold or taken off the market.', 'marketBuy');
    if (l.seller === a.id) return this.fail(c, 'own_listing', 'That is your own listing. Cancel it instead.', 'marketBuy');
    if (this.owns(a, l.item)) return this.fail(c, 'owned', `You already own ${cosmeticById(l.item)?.name ?? 'that item'}.`, 'marketBuy');
    const seller = this.db.accounts[l.seller];
    const o = seller?.owned.find((x) => x.instance === l.instance && x.listed === l.id);
    if (!seller || !o || l.price.cur !== 'pearls') {
      delete this.db.listings[l.id];
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
    if (o.serial !== undefined) moved.serial = o.serial;
    if (o.asset !== undefined) moved.asset = o.asset;
    a.owned.push(moved);
    delete this.db.listings[l.id];
    this.store.commit();
    this.sendAccount(a);
    this.sendAccount(seller); // the seller's client shows "Sold" when the listed item leaves its inventory
    this.pushMarket();
  }

  private marketCancel(c: EconomyConn, a: AccountRec, listingId: string): void {
    const l = this.db.listings[listingId];
    if (!l || l.seller !== a.id) return this.fail(c, 'gone', 'That listing is no longer on the market.', 'marketCancel');
    delete this.db.listings[l.id];
    const o = a.owned.find((x) => x.instance === l.instance);
    if (o) delete o.listed;
    this.store.commit();
    this.sendAccount(a);
    this.pushMarket();
  }

  // ------------------------------------------------------------------------------------------
  // Wallet link (Sign in with Solana)
  // ------------------------------------------------------------------------------------------

  private walletChallenge(c: EconomyConn, a: AccountRec): void {
    if (a.wallet) return this.fail(c, 'linked', 'This account already has a wallet linked.', 'walletChallenge');
    const now = this.now();
    if (this.challenges.size > 5000) for (const [k, v] of this.challenges) if (v.expires < now) this.challenges.delete(k);
    const nonce = randomBytes(16).toString('hex');
    const message = walletChallengeText(this.domain, a.id, nonce, new Date(now).toISOString());
    this.challenges.set(a.id, { message, expires: now + CHALLENGE_MS }); // a new challenge replaces the old one
    c.send({ t: 'walletChallenge', message });
  }

  private walletLink(c: EconomyConn, a: AccountRec, address: string, signature: string): void {
    const ch = this.challenges.get(a.id);
    this.challenges.delete(a.id); // one use only, right or wrong
    if (!ch || this.now() > ch.expires) return this.fail(c, 'challenge', 'The wallet sign-in expired. Press Connect Wallet again.', 'walletLink');
    if (a.wallet) return this.fail(c, 'linked', 'This account already has a wallet linked.', 'walletLink');
    const pk = base58Decode(address);
    const sig = base58Decode(signature);
    if (!pk || pk.length !== 32 || !sig || sig.length !== 64 || !verifyEd25519(pk, new TextEncoder().encode(ch.message), sig)) {
      return this.fail(c, 'bad_signature', 'The wallet signature did not check out, so nothing was linked. Try again.', 'walletLink');
    }
    const other = this.walletIndex.get(address);
    if (other && other !== a.id) return this.fail(c, 'wallet_taken', 'That wallet is already linked to another Hook Wars account.', 'walletLink');
    a.wallet = address;
    this.walletIndex.set(address, a.id);
    this.store.commit();
    this.sendAccount(a);
  }

  // ------------------------------------------------------------------------------------------
  // Limited items for devnet USDC
  // ------------------------------------------------------------------------------------------

  private stored(o: OrderRec): StoredTransfer {
    return { orderId: o.id, payer: o.wallet, cents: o.cents, message: new Uint8Array(Buffer.from(o.message, 'base64')), meta: o.meta };
  }

  private sendOrder(c: EconomyConn, o: OrderRec): void {
    const def = cosmeticById(o.item);
    c.send({ t: 'usdcOrder', order: o.id, tx: o.tx, expires: o.expires, item: o.item, usdc: def?.usdc });
  }

  private usdcOrder(c: EconomyConn, a: AccountRec, item: string): void {
    const def = cosmeticById(item);
    if (!def || def.rarity !== 'limited' || !def.usdc || !def.supply) return this.fail(c, 'not_limited', 'That item is not sold for USDC.', 'usdcOrder');
    if (!this.chain.purchases) return this.fail(c, 'network_off', 'Limited items are not sold on this server (its Solana connection is switched off).', 'usdcOrder');
    if (!a.wallet) return this.fail(c, 'no_wallet', 'Link a Solana wallet first.', 'usdcOrder');
    if (this.owns(a, item)) return this.fail(c, 'owned', `You already own ${def.name}.`, 'usdcOrder');
    const now = this.now();
    if (now - this.lastSweep > 10_000) this.track(this.sweepOrders(false)).catch(() => {});
    const mine = Object.values(this.db.orders).filter((o) => o.account === a.id && (o.status === 'open' || o.status === 'submitted' || o.status === 'paid'));
    // idempotent: the same item again (a double click, or a retry) gets the same order back
    const same = mine.find((o) => o.item === item && o.status === 'open' && o.wallet === a.wallet && o.expires - now > 15_000);
    if (same) {
      const b = this.building.get(same.id);
      if (b) this.track(b.then(() => (same.status === 'open' && same.tx ? this.sendOrder(c, same) : undefined))).catch(() => {});
      else this.sendOrder(c, same);
      return;
    }
    if (mine.some((o) => o.status === 'submitted' || o.status === 'paid')) return this.fail(c, 'busy', 'Your last payment is still being confirmed. Give it a moment.', 'usdcOrder');
    if (mine.some((o) => o.status === 'open' && o.expires + ORDER_SWEEP_GRACE_MS > now)) {
      return this.fail(c, 'busy', 'You have another purchase open in your wallet. Finish it, or wait about a minute for it to expire.', 'usdcOrder');
    }
    // supply: serials issued plus orders that could still be paid
    const reserved = Object.values(this.db.orders).filter((o) => o.item === item && (o.status === 'open' || o.status === 'submitted')).length;
    if ((this.db.serials[item] ?? 0) + reserved >= def.supply) return this.fail(c, 'sold_out', `${def.name} is sold out.`, 'usdcOrder');
    let id = newId('ord');
    while (this.db.orders[id]) id = newId('ord');
    const o: OrderRec = {
      id, account: a.id, item, wallet: a.wallet, cents: Math.round(def.usdc * 100), status: 'open', created: now, expires: now + 90_000,
      tx: '', message: '', meta: '', updated: now,
    };
    this.db.orders[id] = o;
    const job = this.chain
      .buildUsdcTransfer({ orderId: id, payer: o.wallet, cents: o.cents })
      .then((built) => {
        o.tx = Buffer.from(built.tx).toString('base64');
        o.message = Buffer.from(built.message).toString('base64');
        o.meta = built.meta;
        o.expires = built.expires;
        // the transaction id is the fee payer's signature, known now: the order can be found on chain
        // even if the player submits the signed transaction somewhere else
        const wire = splitWireTx(built.tx);
        if (wire) o.signature = base58Encode(wire.signatures[0]);
        o.updated = this.now();
        this.store.commit();
        this.sendOrder(c, o);
      })
      .catch((err: unknown) => {
        o.status = 'failed';
        o.error = (err as Error).message;
        o.updated = this.now();
        this.store.commit();
        this.fail(c, err instanceof ChainError ? err.code : 'chain', err instanceof ChainError ? err.message : 'The Solana network did not answer. Nothing was charged. Try again in a minute.', 'usdcOrder');
        if (!(err instanceof ChainError)) this.log(`[economy] building order ${id} failed: ${(err as Error).message}`);
      })
      .finally(() => this.building.delete(id));
    this.building.set(id, job);
    this.track(job);
  }

  private usdcSubmit(c: EconomyConn, a: AccountRec, orderId: string, txB64: string): void {
    const o = this.db.orders[orderId];
    if (!o || o.account !== a.id) return this.fail(c, 'no_order', 'That purchase was not found. Press Buy again.', 'usdcSubmit');
    if (o.status === 'paid' || o.status === 'minted') return this.sendAccount(a); // already done: same answer again
    if (o.status === 'submitted') return; // in flight: the result goes to every connection on the account
    if (o.status !== 'open' || !o.tx) return this.fail(c, 'expired', 'That purchase expired. Nothing was charged. Press Buy again.', 'usdcSubmit');
    if (this.now() > o.expires) return this.fail(c, 'expired', 'The payment took too long and expired. Nothing was charged. Press Buy again.', 'usdcSubmit');
    o.status = 'submitted';
    o.updated = this.now();
    this.store.commit();
    let sent = false;
    const bytes = new Uint8Array(Buffer.from(txB64, 'base64'));
    const job = this.chain
      .submitUsdcTransfer(this.stored(o), bytes, (signature) => {
        sent = true;
        o.signature = signature;
        o.updated = this.now();
        this.store.commit(); // on disk before the transaction can land
      })
      .then(async (res) => {
        if (res.status === 'paid') return this.finalizePaid(o, res.signature);
        if (res.status === 'pending') return this.scheduleRecheck(o);
        o.status = 'failed';
        o.error = res.reason;
        o.updated = this.now();
        this.store.commit();
        this.fail(c, res.code, `The payment did not go through: ${res.reason}`, 'usdcSubmit');
      })
      .catch((err: unknown) => {
        if (err instanceof ChainError && (RETRYABLE_SUBMIT.has(err.code) || err.code === 'expired')) {
          o.status = err.code !== 'expired' && this.now() < o.expires ? 'open' : 'expired';
          o.error = err.message;
          o.updated = this.now();
          this.store.commit();
          return this.fail(c, err.code, err.message, 'usdcSubmit');
        }
        this.log(`[economy] submitting order ${o.id} failed: ${(err as Error).message}`);
        if (sent) {
          // it may have landed: keep checking the chain rather than guessing
          this.scheduleRecheck(o);
          return this.fail(c, 'confirming', 'Your payment was sent but is not confirmed yet. Your item appears as soon as it is.', 'usdcSubmit');
        }
        o.status = this.now() < o.expires ? 'open' : 'expired';
        o.updated = this.now();
        this.store.commit();
        this.fail(c, 'chain', 'The Solana network did not answer. Nothing was charged. Try again.', 'usdcSubmit');
      });
    this.track(job);
  }

  /** Payment confirmed and verified: issue the serial, give the item, then mint its NFT twin. */
  private async finalizePaid(o: OrderRec, signature: string): Promise<void> {
    if (o.status === 'paid' || o.status === 'minted') return;
    const a = this.db.accounts[o.account];
    const def = cosmeticById(o.item);
    o.signature = signature;
    o.updated = this.now();
    if (!a || !def?.supply) {
      o.status = 'failed';
      o.error = 'paid, but the account or item is gone: refund by hand';
      this.store.commit();
      this.log(`[economy] order ${o.id} was paid (${signature}) but its account or item no longer exists. Refund it by hand.`);
      return;
    }
    const serial = (this.db.serials[o.item] ?? 0) + 1;
    if (serial > def.supply) {
      o.status = 'failed';
      o.error = 'paid after the edition sold out: refund by hand';
      this.store.commit();
      this.log(`[economy] order ${o.id} was paid (${signature}) after ${o.item} sold out. Refund it by hand.`);
      for (const cc of this.byAccount.get(a.id) ?? []) this.fail(cc, 'sold_out', `${def.name} sold out while you paid. Your payment will be refunded.`, 'usdcSubmit');
      return;
    }
    this.db.serials[o.item] = serial;
    o.serial = serial;
    o.status = 'paid';
    o.instance = newId('itm');
    a.owned.push({ instance: o.instance, item: o.item, serial });
    this.store.commit();
    this.sendAccount(a); // the item is theirs now; the NFT follows
    await this.mint(o);
  }

  private async mint(o: OrderRec): Promise<void> {
    const a = this.db.accounts[o.account];
    const def = cosmeticById(o.item);
    if (!a || !def?.supply || o.serial === undefined || o.status !== 'paid') return;
    try {
      const { asset } = await this.chain.mintLimited({
        orderId: o.id,
        owner: o.wallet,
        name: `Hook Wars: ${def.name} #${o.serial}/${def.supply}`,
        uri: this.metadataBaseUrl ? `${this.metadataBaseUrl}/${def.id}.json` : '',
        serial: o.serial,
        supply: def.supply,
        item: def.id,
      });
      o.asset = asset;
      o.status = 'minted';
      delete o.error;
      o.updated = this.now();
      const owned = a.owned.find((x) => x.instance === o.instance);
      if (owned) owned.asset = asset;
      this.mintTries.delete(o.id);
      this.store.commit();
      this.sendAccount(a);
    } catch (err) {
      const n = (this.mintTries.get(o.id) ?? 0) + 1;
      this.mintTries.set(o.id, n);
      o.error = `mint: ${(err as Error).message}`;
      o.updated = this.now();
      this.store.commit();
      this.log(`[economy] minting order ${o.id} failed (try ${n}): ${(err as Error).message}`);
      this.later(Math.min(10 * 60_000, 15_000 * n), () => this.mint(o)); // the mint is idempotent per order
    }
  }

  private scheduleRecheck(o: OrderRec): void {
    const n = (this.recheckTries.get(o.id) ?? 0) + 1;
    this.recheckTries.set(o.id, n);
    this.later(Math.min(5 * 60_000, 4_000 * n), () => this.recheck(o));
  }

  /** Ask the chain whether a submitted (or abandoned) order's transaction landed. */
  private async recheck(o: OrderRec): Promise<void> {
    if (o.status !== 'submitted' && o.status !== 'open') return;
    if (!o.signature || !o.message) {
      if (o.status === 'open' && this.now() > o.expires) {
        o.status = 'expired';
        this.store.markDirty();
      }
      return;
    }
    let res;
    try {
      res = await this.chain.checkUsdcPayment(this.stored(o), o.signature);
    } catch (err) {
      this.log(`[economy] checking order ${o.id} failed: ${(err as Error).message}`);
      return this.scheduleRecheck(o);
    }
    if (res.status === 'paid') {
      this.recheckTries.delete(o.id);
      return this.finalizePaid(o, res.signature);
    }
    if (res.status === 'pending') return this.scheduleRecheck(o);
    if (this.now() > o.expires) {
      // not on chain and its blockhash has expired: it can never land
      this.recheckTries.delete(o.id);
      o.status = 'expired';
      o.error = res.reason;
      o.updated = this.now();
      this.store.commit();
      const a = this.db.accounts[o.account];
      if (a) for (const cc of this.byAccount.get(a.id) ?? []) this.fail(cc, 'expired', 'Your payment did not go through and has expired. Nothing was charged.', 'usdcSubmit');
      return;
    }
    if (o.status === 'submitted') this.scheduleRecheck(o);
  }

  /** Expired open orders and unconfirmed submissions: settle them against the chain. */
  private async sweepOrders(startup: boolean): Promise<void> {
    this.lastSweep = this.now();
    const now = this.now();
    for (const o of Object.values(this.db.orders)) {
      if (o.status === 'paid') {
        if (startup) await this.mint(o);
        continue;
      }
      if (o.status === 'submitted' && (startup || now - o.updated > 60_000)) await this.recheck(o);
      else if (o.status === 'open' && now > o.expires + ORDER_SWEEP_GRACE_MS) await this.recheck(o);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Introspection for tests and tools
  // ------------------------------------------------------------------------------------------

  accountById(id: string): AccountRec | undefined {
    return this.db.accounts[id];
  }

  orderById(id: string): OrderRec | undefined {
    return this.db.orders[id];
  }
}
