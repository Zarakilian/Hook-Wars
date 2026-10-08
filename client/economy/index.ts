// Client economy. This first version is local-only (an offline locker in localStorage).
// The economy pass adds the server account, the marketplace and the Solana wallet.
import { COSMETICS, cosmeticById, DEFAULT_ITEM_IDS, DEFAULT_LOADOUT, ownedLoadout, type Loadout } from '../../shared/cosmetics.ts';
import type { AccountView, OwnedItem } from '../../shared/economy.ts';
import type { ServerMsg } from '../../shared/protocol.ts';
import { FAMILIES, type FamilyId } from '../../shared/types.ts';
import type { EconomyClient, EconomyState } from './types.ts';

const KEY = 'hookwars.locker.v1';

function read(): AccountView | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const a = JSON.parse(raw) as AccountView;
    if (typeof a.pearls !== 'number' || !Array.isArray(a.owned)) return null;
    return a;
  } catch {
    return null;
  }
}

function write(a: AccountView): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    // storage unavailable: the locker lasts for this session only
  }
}

function freshLocal(): AccountView {
  const loadouts = {} as Record<FamilyId, Loadout>;
  for (const f of FAMILIES) loadouts[f] = { ...DEFAULT_LOADOUT[f] };
  return { id: 'local', pearls: 500, owned: [], loadouts, wallet: null, network: 'off', stats: { matches: 0, wins: 0, kills: 0, hooksHit: 0 } };
}

export function createEconomy(): EconomyClient {
  let local = read() ?? freshLocal();
  const subs = new Set<(s: EconomyState) => void>();
  let st: EconomyState = { mode: 'local', account: local, listings: [], busy: false, error: null, walletAvailable: false, network: 'off' };
  const emit = () => {
    for (const cb of subs) cb(st);
  };
  const set = (p: Partial<EconomyState>) => {
    st = { ...st, ...p };
    emit();
  };
  const saveLocal = () => {
    write(local);
    set({ account: { ...local }, error: null });
  };
  const owns = (id: string) => DEFAULT_ITEM_IDS.includes(id) || (st.account?.owned.some((o) => o.item === id) ?? false);

  return {
    state: () => st,
    onChange(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    owns,
    equip(family, loadout) {
      if (st.mode !== 'local') return;
      local.loadouts[family] = ownedLoadout(loadout, owns);
      saveLocal();
    },
    buyWithPearls(itemId) {
      const def = cosmeticById(itemId);
      if (st.mode !== 'local' || !def || def.pearls === undefined) return;
      if (owns(itemId)) return set({ error: 'You already own that.' });
      if (local.pearls < def.pearls) return set({ error: 'Not enough Pearls.' });
      local.pearls -= def.pearls;
      const item: OwnedItem = { instance: `L${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`, item: itemId };
      local.owned.push(item);
      saveLocal();
    },
    grantLocal(pearls) {
      if (st.mode !== 'local' || pearls <= 0) return;
      local.pearls += Math.floor(pearls);
      saveLocal();
    },
    async connectWallet() {
      set({ error: 'Wallets arrive with the store update.' });
    },
    async buyWithUsdc() {
      set({ error: 'Limited items arrive with the store update.' });
    },
    refreshMarket() {},
    listForSale() {
      set({ error: 'The marketplace needs an online server.' });
    },
    buyListing() {},
    cancelListing() {},
    receive(_msg: ServerMsg) {},
    attachServer() {},
    detachServer() {},
    tokenFor() {
      return null;
    },
  };
}

/** Every catalog item, for screens that list them. */
export const CATALOG = COSMETICS;
