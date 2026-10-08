// Client economy.
//   local  : the offline locker for solo play, saved in this browser (hookwars.locker.v1)
//   server : the account on the connected server, which is the only authority online. Each server
//            gets its own auth token, kept in hookwars.tokens.v1 keyed by server address.
// Wallets come in through the Wallet Standard (./wallet.ts). The client never builds a Solana
// transaction: the server builds it, the wallet signs it, the server sends and verifies it.
import { COSMETICS, cosmeticById, DEFAULT_ITEM_IDS, DEFAULT_LOADOUT, ownedLoadout, type Loadout } from '../../shared/cosmetics.ts';
import {
  base58Encode, isSolanaAddress, MAX_LIST_PEARLS, MIN_LIST_PEARLS, wearableLoadout,
  type AccountView, type EconomyClientMsg, type EconomyServerMsg, type OwnedItem,
} from '../../shared/economy.ts';
import type { ServerMsg } from '../../shared/protocol.ts';
import { FAMILIES, type FamilyId } from '../../shared/types.ts';
import type { EconomyClient, EconomyState } from './types.ts';
import { connectWallet as wsConnect, signMessage as wsSignMessage, signTransaction as wsSignTransaction, watchWallets, type WalletAccountLike, type WalletLike } from './wallet.ts';

const LOCKER_KEY = 'hookwars.locker.v1';
const TOKENS_KEY = 'hookwars.tokens.v1';
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const MAX_TOKENS = 20;
const WALLET_STEP_MS = 20_000; // server answers to wallet steps
const ORDER_MS = 30_000; // building a devnet transaction reads the chain
const PAYMENT_MS = 120_000; // confirmation on devnet usually takes a few seconds

type Re = EconomyClientMsg['t'];

// ---------------------------------------------------------------------------------------------
// Storage (every access may throw: private mode, blocked storage, full quota)
// ---------------------------------------------------------------------------------------------

function readLocker(): AccountView | null {
  try {
    const raw = localStorage.getItem(LOCKER_KEY);
    if (!raw) return null;
    const a = JSON.parse(raw) as AccountView;
    if (typeof a !== 'object' || a === null || typeof a.pearls !== 'number' || !Array.isArray(a.owned)) return null;
    const loadouts = {} as Record<FamilyId, Loadout>;
    for (const f of FAMILIES) loadouts[f] = a.loadouts && typeof a.loadouts[f] === 'object' ? a.loadouts[f] : { ...DEFAULT_LOADOUT[f] };
    return { ...a, loadouts, owned: a.owned.filter((o) => o && typeof o.item === 'string' && cosmeticById(o.item)), wallet: null, network: 'off' };
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

function readTokens(): Record<string, string> {
  try {
    const raw = localStorage.getItem(TOKENS_KEY);
    const j: unknown = raw ? JSON.parse(raw) : {};
    if (typeof j !== 'object' || j === null || Array.isArray(j)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(j as Record<string, unknown>)) if (k.length <= 512 && typeof v === 'string' && TOKEN_RE.test(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function writeToken(serverKey: string, token: string): void {
  try {
    const all = readTokens();
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
  return { id: 'local', pearls: 500, owned: [], loadouts, wallet: null, network: 'off', stats: { matches: 0, wins: 0, kills: 0, hooksHit: 0 } };
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------

interface Waiter {
  match: (m: EconomyServerMsg) => boolean;
  re: ReadonlySet<Re>;
  resolve: (m: EconomyServerMsg) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createEconomy(): EconomyClient {
  const local = readLocker() ?? freshLocal();
  const subs = new Set<(s: EconomyState) => void>();
  let st: EconomyState = { mode: 'local', account: local, listings: [], busy: false, error: null, walletAvailable: false, network: 'off', walletName: null };
  let send: ((m: EconomyClientMsg) => void) | null = null;
  let serverKey: string | null = null;
  let wallets: readonly WalletLike[] = [];
  let connected: { wallet: WalletLike; account: WalletAccountLike } | null = null; // this browser's wallet, this session
  let flows = 0; // wallet flows running
  const inflight = new Set<string>(); // Pearl actions sent and not answered yet (stops double sends)
  const waiters = new Set<Waiter>();

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
  const busyNow = () => flows > 0 || inflight.size > 0;
  const saveLocal = () => {
    writeLocker(local);
    set({ account: { ...local, owned: [...local.owned], loadouts: { ...local.loadouts } }, error: null });
  };
  const owns = (id: string) => DEFAULT_ITEM_IDS.includes(id) || (st.account?.owned.some((o) => o.item === id) ?? false);
  const canWear = (id: string) => DEFAULT_ITEM_IDS.includes(id) || (st.account?.owned.some((o) => o.item === id && !o.listed) ?? false);

  // wallets appear when an extension registers (often a moment after page load)
  watchWallets((list) => {
    wallets = list;
    if (connected && !list.includes(connected.wallet)) connected = null;
    const name = list[0]?.name ?? null;
    if (st.walletAvailable !== list.length > 0 || st.walletName !== name) set({ walletAvailable: list.length > 0, walletName: name });
  });

  function wait(match: (m: EconomyServerMsg) => boolean, re: Re[], ms: number, timeoutMsg: string): Promise<EconomyServerMsg> {
    return new Promise((resolve, reject) => {
      const w: Waiter = {
        match,
        re: new Set(re),
        resolve: (m) => {
          clearTimeout(w.timer);
          waiters.delete(w);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(w.timer);
          waiters.delete(w);
          reject(e);
        },
        timer: setTimeout(() => w.reject(new Error(timeoutMsg)), ms),
      };
      waiters.add(w);
    });
  }

  function rejectAll(msg: string): void {
    for (const w of [...waiters]) w.reject(new Error(msg));
  }

  function sendAction(key: string, m: EconomyClientMsg): void {
    if (!send) return;
    if (inflight.has(key)) return; // a double click: the first request is still on its way
    inflight.add(key);
    set({ busy: true, error: null });
    send(m);
  }

  function requireServer(what: string): (m: EconomyClientMsg) => void {
    if (st.mode !== 'server' || !send) throw new Error(`${what} needs an online server. Connect to one from Play Online first.`);
    if (!st.account) throw new Error('Still signing in to the server. Try again in a moment.');
    return send;
  }

  /** The wallet that already shows this address (when one does), else the first suitable wallet. */
  function pickWallet(prefer?: string | null): WalletLike {
    const w = (prefer ? wallets.find((x) => x.accounts.some((a) => a.address === prefer)) : undefined) ?? wallets[0];
    if (!w) throw new Error('No Solana wallet was found in this browser. Install a wallet extension that supports devnet, then reload the page.');
    return w;
  }

  async function linkWallet(): Promise<void> {
    const out = requireServer('Linking a wallet');
    if (st.account!.wallet) {
      // already linked: just make sure this browser's wallet is on the same address
      const linked = st.account!.wallet;
      const lw = pickWallet(linked);
      connected = { wallet: lw, account: await wsConnect(lw, linked) };
      return;
    }
    const w = pickWallet();
    flows++;
    set({ busy: true, error: null });
    try {
      const account = await wsConnect(w);
      if (!isSolanaAddress(account.address)) throw new Error(`${w.name} gave an address that is not a Solana address.`);
      const chP = wait((m) => m.t === 'walletChallenge', ['walletChallenge'], WALLET_STEP_MS, 'The server did not answer. Try again.');
      out({ t: 'walletChallenge' });
      const ch = (await chP) as Extract<EconomyServerMsg, { t: 'walletChallenge' }>;
      const signature = await wsSignMessage(w, account, new TextEncoder().encode(ch.message));
      const linkP = wait((m) => m.t === 'account' && m.a.wallet === account.address, ['walletLink'], WALLET_STEP_MS, 'The server did not confirm the wallet link. Try again.');
      requireServer('Linking a wallet')({ t: 'walletLink', address: account.address, signature: base58Encode(signature) });
      await linkP;
      connected = { wallet: w, account };
    } finally {
      flows--;
      set({ busy: busyNow() });
    }
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
      if (!def || def.pearls === undefined) return;
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
    async connectWallet() {
      await linkWallet();
    },
    async buyWithUsdc(itemId) {
      const def = cosmeticById(itemId);
      if (!def || def.rarity !== 'limited' || def.usdc === undefined) throw new Error('That item is not sold for USDC.');
      requireServer('Buying a Limited item');
      if (st.network !== 'devnet') throw new Error('This server does not sell Limited items (its Solana devnet connection is off).');
      if (owns(itemId)) throw new Error(`You already own ${def.name}.`);
      if (!st.account!.wallet) await linkWallet();
      const linked = st.account?.wallet ?? null;
      if (!connected || connected.account.address !== linked) {
        const lw = pickWallet(linked);
        connected = { wallet: lw, account: await wsConnect(lw, linked) };
      }
      const { wallet: w, account } = connected;
      flows++;
      set({ busy: true, error: null });
      try {
        const orderP = wait((m) => m.t === 'usdcOrder' && m.item === itemId, ['usdcOrder'], ORDER_MS, 'The server did not prepare the payment in time. Nothing was charged. Try again.');
        requireServer('Buying a Limited item')({ t: 'usdcOrder', item: itemId });
        const order = (await orderP) as Extract<EconomyServerMsg, { t: 'usdcOrder' }>;
        const signed = await wsSignTransaction(w, account, fromBase64(order.tx));
        const doneP = wait(
          (m) => m.t === 'account' && m.a.owned.some((o) => o.item === itemId),
          ['usdcSubmit'],
          PAYMENT_MS,
          'The payment is taking longer than usual. If it went through, your item appears in the Locker as soon as it is confirmed.',
        );
        requireServer('Buying a Limited item')({ t: 'usdcSubmit', order: order.order, tx: toBase64(signed) });
        await doneP;
      } finally {
        flows--;
        set({ busy: busyNow() });
      }
    },
    refreshMarket() {
      if (st.mode === 'server' && send) send({ t: 'market' });
    },
    listForSale(instance, pearls) {
      if (st.mode !== 'server' || !send) return set({ error: 'The marketplace needs an online server. Connect to one from Play Online first.' });
      if (!Number.isInteger(pearls) || pearls < MIN_LIST_PEARLS || pearls > MAX_LIST_PEARLS) {
        return set({ error: `Prices are whole Pearls from ${MIN_LIST_PEARLS} to ${MAX_LIST_PEARLS.toLocaleString('en')}.` });
      }
      sendAction(`marketSell:${instance}`, { t: 'marketSell', instance, price: { cur: 'pearls', amount: pearls } });
    },
    buyListing(listing) {
      if (st.mode !== 'server' || !send) return set({ error: 'The marketplace needs an online server.' });
      const l = st.listings.find((x) => x.id === listing);
      if (l && l.price.cur === 'pearls' && (st.account?.pearls ?? 0) < l.price.amount) return set({ error: `You need ${l.price.amount - (st.account?.pearls ?? 0)} more Pearls.` });
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
          set({ account: msg.a, network: msg.a.network, busy: busyNow(), error: null });
          break;
        }
        case 'market':
          set({ listings: msg.listings });
          break;
        case 'econError': {
          let handled = false;
          for (const w of [...waiters]) {
            if (msg.re && w.re.has(msg.re)) {
              w.reject(new Error(msg.message));
              handled = true;
            }
          }
          if (msg.re) for (const k of [...inflight]) if (k.startsWith(`${msg.re}:`)) inflight.delete(k);
          if (!handled) set({ error: msg.message, busy: busyNow() });
          else set({ busy: busyNow() });
          return;
        }
        default:
          break;
      }
      for (const w of [...waiters]) if (w.match(msg as EconomyServerMsg)) w.resolve(msg as EconomyServerMsg);
    },
    attachServer(fn, key) {
      rejectAll('Switched servers.');
      send = fn as (m: EconomyClientMsg) => void;
      serverKey = key;
      connected = null;
      inflight.clear();
      set({ mode: 'server', account: null, listings: [], busy: false, error: null, network: 'off' });
    },
    detachServer() {
      if (st.mode === 'local' && !send) return;
      send = null;
      serverKey = null;
      connected = null;
      inflight.clear();
      rejectAll('Disconnected from the server.');
      set({ mode: 'local', account: { ...local }, listings: [], busy: flows > 0, error: null, network: 'off' });
    },
    tokenFor(key) {
      return readTokens()[key] ?? null;
    },
  };
}

/** Every catalog item, for screens that list them. */
export const CATALOG = COSMETICS;
