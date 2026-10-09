// Client economy (standard edition: Pearls only).
//   local  : the offline locker for solo play, saved in this browser (hookwars.locker.v1)
//   server : the account on the connected server, which is the only authority online. Each server
//            gets its own auth token, kept in hookwars.tokens.v1 keyed by server address. A token
//            is never thrown away: when a server hands out a different one, the old one moves to
//            hookwars.tokens.prev.v1, so an account can still be recovered by hand.
//   cloud  : the Steam build also keeps the offline locker in Steam Cloud (useCloud, ./cloudLocker.ts).
//            localStorage stays the first copy; the newer of the two (savedAt) wins at start.
//   local_only: a server that keeps no accounts (ECONOMY=trust, a lobby a player hosts in the Steam
//            build) says so after hello; this client then keeps using its own locker while connected
//            and pays itself at match end (payLocalMatch, ./payout.ts).
// Premium items are sold in the Steam version only; here they are never owned, bought or worn.
import { COSMETICS, cosmeticById, DEFAULT_ITEM_IDS, DEFAULT_LOADOUT, ownedLoadout, type Loadout } from '../../shared/cosmetics.ts';
import {
  ACCOUNT_STATE_CODES, isPremium, marketLockedText, MAX_LIST_PEARLS, MIN_LIST_PEARLS, wearableLoadout,
  type AccountView, type EconomyClientMsg, type OwnedItem,
} from '../../shared/economy.ts';
import type { ServerMsg } from '../../shared/protocol.ts';
import { FAMILIES, type FamilyId } from '../../shared/types.ts';
import { CLOUD_LOCKER_FILE, CLOUD_MAX_BYTES, CLOUD_RETRY_MAX_MS, CLOUD_RETRY_MS, CloudSaver, cloudTimers, type CloudSaverOptions, type CloudStore } from './cloudLocker.ts';
import type { EconomyClient, EconomyState } from './types.ts';

const LOCKER_KEY = 'hookwars.locker.v1';
/**
 * Steam build: this computer started with no locker of its own and has not read the Steam Cloud copy
 * yet. Kept across restarts, so a new install whose Cloud stays unreadable for a while still takes the
 * Cloud copy once it answers (the locker saved here meanwhile would otherwise be the newer one).
 */
const CLOUD_FIRST_KEY = 'hookwars.locker.cloudfirst.v1';
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
const LOCAL_ONLY_MARKET = 'This lobby is hosted by a player, so it has no Market. The Market is on dedicated servers: connect to one from Play Online.';
/** econError code (no re) a server that keeps no accounts sends after hello (server/economy/trust.ts) */
export const LOCAL_ONLY_CODE = 'local_only';
/** Matches remembered for payLocalMatch's once-per-match guard. */
const PAID_KEEP = 50;

type Re = EconomyClientMsg['t'];

/** Timers must never keep a test process alive (browsers return a number, Node an object). */
function unref<T>(t: T): T {
  (t as { unref?: () => void }).unref?.();
  return t;
}

// ---------------------------------------------------------------------------------------------
// Storage (every access may throw: private mode, blocked storage, full quota)
// ---------------------------------------------------------------------------------------------

/** A saved locker (localStorage or Steam Cloud text) checked field by field; null if it is not one. */
export function parseLocker(raw: string | null | undefined): { account: AccountView; savedAt: number } | null {
  if (!raw || raw.length > CLOUD_MAX_BYTES) return null;
  try {
    const a = JSON.parse(raw) as AccountView & { wallet?: unknown; network?: unknown; savedAt?: unknown };
    if (typeof a !== 'object' || a === null || typeof a.pearls !== 'number' || !Number.isFinite(a.pearls) || a.pearls < 0 || !Array.isArray(a.owned)) return null;
    const loadouts = {} as Record<FamilyId, Loadout>;
    for (const f of FAMILIES) loadouts[f] = a.loadouts && typeof a.loadouts[f] === 'object' ? a.loadouts[f] : { ...DEFAULT_LOADOUT[f] };
    const owned = a.owned
      .filter((o) => o && typeof o.item === 'string' && typeof o.instance === 'string' && cosmeticById(o.item) && !isPremium(o.item))
      .map((o): OwnedItem => ({ instance: o.instance, item: o.item }));
    const stats = a.stats && typeof a.stats === 'object' ? a.stats : { matches: 0, wins: 0, kills: 0, hooksHit: 0 };
    const savedAt = typeof a.savedAt === 'number' && Number.isFinite(a.savedAt) && a.savedAt > 0 ? a.savedAt : 0;
    return { account: { id: 'local', pearls: Math.floor(a.pearls), owned, loadouts, stats }, savedAt };
  } catch {
    return null;
  }
}

function readLocker(): { account: AccountView; savedAt: number } | null {
  try {
    return parseLocker(localStorage.getItem(LOCKER_KEY));
  } catch {
    return null;
  }
}

/** The locker as saved text (localStorage and Steam Cloud use the same format). */
function lockerText(a: AccountView, savedAt: number): string {
  return JSON.stringify({ ...a, savedAt });
}

function writeLocker(text: string): void {
  try {
    localStorage.setItem(LOCKER_KEY, text);
  } catch {
    // storage unavailable: the locker lasts for this session only (and in Steam Cloud, in the Steam build)
  }
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    // storage unavailable: nothing is saved here between runs anyway, so every start takes the Cloud copy
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
  const saved = readLocker();
  const local = saved?.account ?? freshLocal();
  /** when the locker was last saved (ms); the newer of this browser's copy and the Cloud's wins */
  let localSavedAt = saved?.savedAt ?? 0;
  let cloud: CloudSaver | null = null;
  const paid: string[] = []; // matches already paid by payLocalMatch, newest last
  const subs = new Set<(s: EconomyState) => void>();
  let st: EconomyState = { mode: 'local', account: local, listings: [], busy: false, error: null, accountError: null, localOnly: false };
  let send: ((m: EconomyClientMsg) => void) | null = null;
  let serverKey: string | null = null;
  let signInTimer: ReturnType<typeof setTimeout> | null = null;
  /** accountError came from the server's account-state message (the precise reason) */
  let reasonFromServer = false;
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
  const copyLocal = (): AccountView => ({ ...local, owned: [...local.owned], loadouts: { ...local.loadouts } });
  /** Store the locker: localStorage now, Steam Cloud a moment later (Steam build). */
  const persist = () => {
    localSavedAt = Math.max(Date.now(), localSavedAt + 1);
    const text = lockerText(local, localSavedAt);
    writeLocker(text);
    cloud?.schedule(text);
  };
  const saveLocal = () => {
    persist();
    set({ account: copyLocal(), error: null });
  };
  const grant = (pearls: number) => {
    local.pearls += Math.floor(pearls);
    local.stats = { ...local.stats, matches: local.stats.matches + 1 };
    // online, the screen shows the server account: keep it, only store the locker for when the player goes back offline
    if (st.mode === 'server') persist();
    else saveLocal();
  };
  const owns = (id: string) => DEFAULT_ITEM_IDS.includes(id) || (!isPremium(id) && (st.account?.owned.some((o) => o.item === id) ?? false));
  const canWear = (id: string) => DEFAULT_ITEM_IDS.includes(id) || (!isPremium(id) && (st.account?.owned.some((o) => o.item === id && !o.listed) ?? false));

  /** Online with no account yet: the reason to show, or null when there is an account (or offline). */
  const noAccount = (): string | null => (st.mode === 'server' && !st.account ? (st.accountError ?? SIGNING_IN) : null);
  /** Online, and the server has not said it gave this connection no account (it would only answer with an error). */
  const canAskMarket = (): boolean => st.mode === 'server' && send !== null && !(st.account === null && st.accountError !== null);

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
      // solo always pays this browser's locker, even while an online server is attached (the end screen promises it)
      if (!(pearls > 0)) return;
      grant(pearls);
    },
    payLocalMatch(key, pearls) {
      if (paid.includes(key)) return false; // this match was paid already
      paid.push(key);
      if (paid.length > PAID_KEEP) paid.splice(0, paid.length - PAID_KEEP);
      if (pearls > 0) grant(pearls);
      return true;
    },
    refreshMarket() {
      if (canAskMarket()) send!({ t: 'market' });
    },
    watchMarket() {
      let stopped = false;
      const renew = () => {
        if (!stopped && canAskMarket()) send!({ t: 'market' });
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
      if (st.localOnly) return set({ error: LOCAL_ONLY_MARKET });
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
      if (st.localOnly) return set({ error: LOCAL_ONLY_MARKET });
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
          reasonFromServer = false;
          set({ account: msg.a, busy: busyNow(), error: null, accountError: null });
          return;
        }
        case 'market':
          set({ listings: msg.listings });
          return;
        case 'econError': {
          if (!msg.re && msg.code === LOCAL_ONLY_CODE) {
            // a server with no accounts (a lobby a player hosts): this client keeps its own locker,
            // wears it there, and pays itself at match end
            stopSignInTimer();
            inflight.clear();
            reasonFromServer = false;
            set({ mode: 'local', localOnly: true, account: copyLocal(), listings: [], busy: false, error: null, accountError: null });
            return;
          }
          if (!msg.re && ACCOUNT_STATE_CODES.has(msg.code)) {
            // the server gave this connection no account, and says why
            stopSignInTimer();
            reasonFromServer = true;
            set({ account: null, accountError: msg.message, busy: busyNow() });
            return;
          }
          if (msg.re === 'market') {
            // The Market screen's own background request (on open and every 25 s), not a click: never
            // a toast. With no account its answer says why; on a slow line it can arrive before the
            // account-state message above, which then replaces it with the precise reason.
            if (!st.account) {
              stopSignInTimer();
              if (!reasonFromServer) set({ accountError: msg.message });
            }
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
      reasonFromServer = false;
      signInTimer = unref(
        setTimeout(() => {
          signInTimer = null;
          if (st.mode === 'server' && !st.account && !st.accountError) set({ accountError: SIGN_IN_TIMEOUT });
        }, SIGN_IN_MS),
      );
      set({ mode: 'server', account: null, listings: [], busy: false, error: null, accountError: null, localOnly: false });
    },
    detachServer() {
      if (st.mode === 'local' && !send) return;
      send = null;
      serverKey = null;
      inflight.clear();
      stopSignInTimer();
      reasonFromServer = false;
      set({ mode: 'local', account: { ...local }, listings: [], busy: false, error: null, accountError: null, localOnly: false });
    },
    tokenFor(key) {
      return readTokens()[key] ?? null;
    },
    async useCloud(store: CloudStore, o: CloudSaverOptions & { readTries?: number; onLateRead?: (used: 'cloud' | 'local') => void } = {}) {
      if (cloud) return 'local';
      const saver = new CloudSaver(store, o);
      cloud = saver;
      saver.hold(true); // nothing goes to the Cloud before its copy has been read
      const file = o.file ?? CLOUD_LOCKER_FILE;
      const tries = Math.max(1, o.readTries ?? 3);
      // the background re-reads never keep a test process alive; the waits awaited here do
      const timers = o.timers ?? cloudTimers;
      const wait = (ms: number) => new Promise<void>((r) => (o.timers ?? { setTimeout: (fn: () => void, t: number) => globalThis.setTimeout(fn, t) }).setTimeout(() => r(), ms));
      const g = globalThis as { addEventListener?: (t: string, fn: () => void) => void; document?: { visibilityState?: string } };
      g.addEventListener?.('pagehide', () => void saver.flush());
      g.addEventListener?.('visibilitychange', () => {
        if (g.document?.visibilityState === 'hidden') void saver.flush();
      });
      // started with no locker of its own: this run, or an earlier one that never read the Cloud
      const cloudFirst = saved === null || readFlag(CLOUD_FIRST_KEY);
      if (cloudFirst) writeFlag(CLOUD_FIRST_KEY, true);
      const readOnce = async (): Promise<{ ok: true; raw: string | null } | { ok: false }> => {
        try {
          return { ok: true, raw: await store.read(file) };
        } catch {
          return { ok: false };
        }
      };
      /** The Cloud's copy has been read: the newer copy wins, and the Cloud writes may start. */
      const merge = (raw: string | null): 'cloud' | 'local' => {
        const fromCloud = parseLocker(raw);
        let used: 'cloud' | 'local' = 'local';
        // A computer with no locker of its own at start (a new install, or storage that cannot be kept)
        // always takes the Cloud copy, also after restarts while the Cloud could not be read: losing
        // what was earned before the Cloud answered beats losing the locker.
        if (fromCloud && (fromCloud.savedAt > localSavedAt || cloudFirst)) {
          // the Cloud has the newer locker (played on another computer, or this computer's storage was cleared)
          local.pearls = fromCloud.account.pearls;
          local.owned = fromCloud.account.owned;
          local.loadouts = fromCloud.account.loadouts;
          local.stats = fromCloud.account.stats;
          localSavedAt = fromCloud.savedAt;
          writeLocker(lockerText(local, localSavedAt));
          // a change made before the read is waiting to go up: it is older than the Cloud's copy, and
          // sending it would overwrite the locker that just won (with a newer savedAt, for good)
          saver.discard();
          if (st.mode === 'local') set({ account: copyLocal() });
          used = 'cloud';
        } else if (!fromCloud || fromCloud.savedAt < localSavedAt) {
          // this computer has the newer copy, or the Cloud has none yet: send it up
          if (localSavedAt === 0) localSavedAt = Math.max(1, Date.now());
          saver.schedule(lockerText(local, localSavedAt));
        }
        writeFlag(CLOUD_FIRST_KEY, false); // read once: from now on the newer copy wins
        saver.hold(false);
        return used;
      };
      for (let i = 0; i < tries; i++) {
        const r = await readOnce();
        if (r.ok) return merge(r.raw);
        if (i + 1 < tries) await wait((o.retryMs ?? 1000) * (i + 1));
      }
      // The Cloud could not be read. Its copy may be the newer one (another computer, or this one before
      // a new install), so nothing is written there until it has been read: every change stays in
      // localStorage, and the Cloud is read again in the background (waiting longer each time). Once it
      // answers, the same rules decide which copy wins, and onLateRead says which.
      let backoff = Math.max(1, o.retryMs ?? CLOUD_RETRY_MS);
      const maxBackoff = Math.max(backoff, o.retryMaxMs ?? CLOUD_RETRY_MAX_MS);
      const again = (): void => {
        timers.setTimeout(() => {
          void readOnce().then((r) => {
            if (!r.ok) {
              backoff = Math.min(maxBackoff, backoff * 2);
              again();
              return;
            }
            const used = merge(r.raw);
            try {
              o.onLateRead?.(used);
            } catch (err) {
              console.error('[cloud] late read', err);
            }
          });
        }, backoff);
      };
      again();
      return 'failed';
    },
    flushCloud() {
      return cloud ? cloud.flush() : Promise.resolve(true);
    },
  };
}

/** Every catalog item, for screens that list them. */
export const CATALOG = COSMETICS;
