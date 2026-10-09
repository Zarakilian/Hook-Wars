// Client economy (standard edition: Pearls only).
//   local  : the offline locker for solo play, saved in this browser (hookwars.locker.v1)
//   server : the account on the connected server, which is the only authority online. Each server
//            gets its own auth token, kept in hookwars.tokens.v1 keyed by server address. A token
//            is never thrown away: when a server hands out a different one, the old one moves to
//            hookwars.tokens.prev.v1, so an account can still be recovered by hand.
// Premium items are sold in the Steam version only; here they are never owned, bought or worn.
import { COSMETICS, cosmeticById, DEFAULT_ITEM_IDS, DEFAULT_LOADOUT, ownedLoadout, type Loadout } from '../../shared/cosmetics.ts';
import {
  ACCOUNT_STATE_CODES, isPremium, marketLockedText, MAX_LIST_PEARLS, MIN_LIST_PEARLS, wearableLoadout,
  type AccountView, type EconomyClientMsg, type OwnedItem,
} from '../../shared/economy.ts';
import type { ServerMsg } from '../../shared/protocol.ts';
import { FAMILIES, type FamilyId } from '../../shared/types.ts';
import type { EconomyClient, EconomyState } from './types.ts';

const LOCKER_KEY = 'hookwars.locker.v1';
const TOKENS_KEY = 'hookwars.tokens.v1';
const PREV_TOKENS_KEY = 'hookwars.tokens.prev.v1';
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const MAX_TOKENS = 20;
const MAX_PREV_PER_SERVER = 5;
/** No account and no reason from the server after this long: say so instead of "Signing in..." forever. */
export const SIGN_IN_MS = 15_000;
/** The server keeps market updates coming for 60 s per request; renew well inside that. */
export const MARKET_RENEW_MS = 25_000;

const SIGNING_IN = 'Still signing in to the server. Try again in a moment.';
const SIGN_IN_TIMEOUT = 'This server did not sign you in. You can still play, but Pearls, the Store and the Market need an account. Reconnect to try again.';
const STEAM_ONLY = 'Premium items are sold in the Steam version of Hook Wars.';

type Re = EconomyClientMsg['t'];

/** Timers must never keep a test process alive (browsers return a number, Node an object). */
function unref<T>(t: T): T {
  (t as { unref?: () => void }).unref?.();
  return t;
}

// ---------------------------------------------------------------------------------------------
// Storage (every access may throw: private mode, blocked storage, full quota)
// ---------------------------------------------------------------------------------------------

function readLocker(): AccountView | null {
  try {
    const raw = localStorage.getItem(LOCKER_KEY);
    if (!raw) return null;
    const a = JSON.parse(raw) as AccountView & { wallet?: unknown; network?: unknown };
    if (typeof a !== 'object' || a === null || typeof a.pearls !== 'number' || !Array.isArray(a.owned)) return null;
    const loadouts = {} as Record<FamilyId, Loadout>;
    for (const f of FAMILIES) loadouts[f] = a.loadouts && typeof a.loadouts[f] === 'object' ? a.loadouts[f] : { ...DEFAULT_LOADOUT[f] };
    const owned = a.owned
      .filter((o) => o && typeof o.item === 'string' && typeof o.instance === 'string' && cosmeticById(o.item) && !isPremium(o.item))
      .map((o): OwnedItem => ({ instance: o.instance, item: o.item }));
    const stats = a.stats && typeof a.stats === 'object' ? a.stats : { matches: 0, wins: 0, kills: 0, hooksHit: 0 };
    return { id: 'local', pearls: a.pearls, owned, loadouts, stats };
  } catch {
    return null;
  }
}

function writeLocker(a: AccountView): void {
  try {
    localStorage.setItem(LOCKER_KEY, JSON.stringify(a));
  } catch {
    // storage unavailable: the locker lasts for this session only
  }
}

function readMap(key: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(key);
    const j: unknown = raw ? JSON.parse(raw) : {};
    return typeof j === 'object' && j !== null && !Array.isArray(j) ? (j as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readTokens(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(readMap(TOKENS_KEY))) if (k.length <= 512 && typeof v === 'string' && TOKEN_RE.test(v)) out[k] = v;
  return out;
}

/** Keep a token this browser is about to replace, newest first, a few per server. */
function keepPrevious(serverKey: string, token: string): void {
  try {
    const all: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(readMap(PREV_TOKENS_KEY))) if (k.length <= 512 && Array.isArray(v)) all[k] = v.filter((t): t is string => typeof t === 'string' && TOKEN_RE.test(t));
    const list = [token, ...(all[serverKey] ?? []).filter((t) => t !== token)].slice(0, MAX_PREV_PER_SERVER);
    delete all[serverKey];
    all[serverKey] = list;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TOKENS))) delete all[k];
    localStorage.setItem(PREV_TOKENS_KEY, JSON.stringify(all));
  } catch {
    // storage unavailable
  }
}

function writeToken(serverKey: string, token: string): void {
  try {
    const all = readTokens();
    const old = all[serverKey];
    if (old && old !== token) keepPrevious(serverKey, old);
    delete all[serverKey];
    all[serverKey] = token; // newest last
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TOKENS))) delete all[k];
    localStorage.setItem(TOKENS_KEY, JSON.stringify(all));
  } catch {
    // storage unavailable: this visit gets a fresh guest account next time
  }
}

function freshLocal(): AccountView {
  const loadouts = {} as Record<FamilyId, Loadout>;
  for (const f of FAMILIES) loadouts[f] = { ...DEFAULT_LOADOUT[f] };
  return { id: 'local', pearls: 500, owned: [], loadouts, stats: { matches: 0, wins: 0, kills: 0, hooksHit: 0 } };
}

// ---------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------

export function createEconomy(): EconomyClient {
  const local = readLocker() ?? freshLocal();
  const subs = new Set<(s: EconomyState) => void>();
  let st: EconomyState = { mode: 'local', account: local, listings: [], busy: false, error: null, accountError: null };
  let send: ((m: EconomyClientMsg) => void) | null = null;
  let serverKey: string | null = null;
  let signInTimer: ReturnType<typeof setTimeout> | null = null;
  const inflight = new Set<string>(); // Pearl actions sent and not answered yet (stops double sends)

  const emit = () => {
    for (const cb of subs) {
      try {
        cb(st);
      } catch (err) {
        console.error('[economy] listener', err);
      }
    }
  };
  const set = (p: Partial<EconomyState>) => {
    st = { ...st, ...p };
    emit();
  };
  const busyNow = () => inflight.size > 0;
  const stopSignInTimer = () => {
    if (signInTimer) clearTimeout(signInTimer);
    signInTimer = null;
  };
  const saveLocal = () => {
    writeLocker(local);
    set({ account: { ...local, owned: [...local.owned], loadouts: { ...local.loadouts } }, error: null });
  };
  const owns = (id: string) => DEFAULT_ITEM_IDS.includes(id) || (!isPremium(id) && (st.account?.owned.some((o) => o.item === id) ?? false));
  const canWear = (id: string) => DEFAULT_ITEM_IDS.includes(id) || (!isPremium(id) && (st.account?.owned.some((o) => o.item === id && !o.listed) ?? false));

  /** Online with no account yet: the reason to show, or null when there is an account (or offline). */
  const noAccount = (): string | null => (st.mode === 'server' && !st.account ? (st.accountError ?? SIGNING_IN) : null);

  function sendAction(key: string, m: EconomyClientMsg): void {
    if (!send) return;
    if (inflight.has(key)) return; // a double click: the first request is still on its way
    inflight.add(key);
    set({ busy: true, error: null });
    send(m);
  }

  return {
    state: () => st,
    onChange(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    owns,
    equip(family, loadout) {
      if (st.mode === 'local') {
        local.loadouts[family] = ownedLoadout(loadout, owns);
        saveLocal();
        return;
      }
      if (!send || !st.account) return;
      const wear = wearableLoadout(family, loadout, canWear);
      // show it at once; the server's 'account' answer is the final word
      set({ account: { ...st.account, loadouts: { ...st.account.loadouts, [family]: wear } }, error: null });
      send({ t: 'equip', family, loadout: wear });
    },
    buyWithPearls(itemId) {
      const def = cosmeticById(itemId);
      if (def?.rarity === 'premium') return set({ error: STEAM_ONLY });
      if (!def || def.pearls === undefined) return;
      const missing = noAccount();
      if (missing) return set({ error: missing });
      if (owns(itemId)) return set({ error: `You already own ${def.name}.` });
      const pearls = st.account?.pearls ?? 0;
      if (pearls < def.pearls) return set({ error: `You need ${def.pearls - pearls} more Pearls for ${def.name}.` });
      if (st.mode === 'local') {
        local.pearls -= def.pearls;
        const item: OwnedItem = { instance: `L${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`, item: itemId };
        local.owned.push(item);
        saveLocal();
        return;
      }
      sendAction(`storeBuy:${itemId}`, { t: 'storeBuy', item: itemId }); // the server charges the catalog price
    },
    grantLocal(pearls) {
      if (st.mode !== 'local' || !(pearls > 0)) return;
      local.pearls += Math.floor(pearls);
      local.stats = { ...local.stats, matches: local.stats.matches + 1 };
      saveLocal();
    },
    refreshMarket() {
      if (st.mode === 'server' && send) send({ t: 'market' });
    },
    watchMarket() {
      let stopped = false;
      const renew = () => {
        if (!stopped && st.mode === 'server' && send) send({ t: 'market' });
      };
      renew();
      const timer = unref(setInterval(renew, MARKET_RENEW_MS));
      return () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
      };
    },
    listForSale(instance, pearls) {
      if (st.mode !== 'server' || !send) return set({ error: 'The marketplace needs an online server. Connect to one from Play Online first.' });
      const missing = noAccount();
      if (missing) return set({ error: missing });
      if (!Number.isInteger(pearls) || pearls < MIN_LIST_PEARLS || pearls > MAX_LIST_PEARLS) {
        return set({ error: `Prices are whole Pearls from ${MIN_LIST_PEARLS} to ${MAX_LIST_PEARLS.toLocaleString('en')}.` });
      }
      const locked = st.account ? marketLockedText(st.account, Date.now()) : null;
      if (locked) return set({ error: locked });
      sendAction(`marketSell:${instance}`, { t: 'marketSell', instance, price: { cur: 'pearls', amount: pearls } });
    },
    buyListing(listing) {
      if (st.mode !== 'server' || !send) return set({ error: 'The marketplace needs an online server.' });
      const missing = noAccount();
      if (missing) return set({ error: missing });
      const locked = st.account ? marketLockedText(st.account, Date.now()) : null;
      if (locked) return set({ error: locked });
      const l = st.listings.find((x) => x.id === listing);
      if (l && (st.account?.pearls ?? 0) < l.price.amount) return set({ error: `You need ${l.price.amount - (st.account?.pearls ?? 0)} more Pearls.` });
      sendAction(`marketBuy:${listing}`, { t: 'marketBuy', listing });
    },
    cancelListing(listing) {
      if (st.mode !== 'server' || !send) return;
      sendAction(`marketCancel:${listing}`, { t: 'marketCancel', listing });
    },
    receive(msg: ServerMsg) {
      if (st.mode !== 'server') return;
      switch (msg.t) {
        case 'account': {
          if (msg.token && serverKey && TOKEN_RE.test(msg.token)) writeToken(serverKey, msg.token);
          inflight.clear(); // every Pearl action is answered with the account (or an error)
          stopSignInTimer();
          set({ account: msg.a, busy: busyNow(), error: null, accountError: null });
          return;
        }
        case 'market':
          set({ listings: msg.listings });
          return;
        case 'econError': {
          if (!msg.re && ACCOUNT_STATE_CODES.has(msg.code)) {
            // the server gave this connection no account, and says why
            stopSignInTimer();
            set({ account: null, accountError: msg.message, busy: busyNow() });
            return;
          }
          const re: Re | undefined = msg.re;
          if (re) for (const k of [...inflight]) if (k.startsWith(`${re}:`)) inflight.delete(k);
          set({ error: msg.message, busy: busyNow() });
          return;
        }
        default:
          return;
      }
    },
    attachServer(fn, key) {
      send = fn as (m: EconomyClientMsg) => void;
      serverKey = key;
      inflight.clear();
      stopSignInTimer();
      signInTimer = unref(
        setTimeout(() => {
          signInTimer = null;
          if (st.mode === 'server' && !st.account && !st.accountError) set({ accountError: SIGN_IN_TIMEOUT });
        }, SIGN_IN_MS),
      );
      set({ mode: 'server', account: null, listings: [], busy: false, error: null, accountError: null });
    },
    detachServer() {
      if (st.mode === 'local' && !send) return;
      send = null;
      serverKey = null;
      inflight.clear();
      stopSignInTimer();
      set({ mode: 'local', account: { ...local }, listings: [], busy: false, error: null, accountError: null });
    },
    tokenFor(key) {
      return readTokens()[key] ?? null;
    },
  };
}

/** Every catalog item, for screens that list them. */
export const CATALOG = COSMETICS;
