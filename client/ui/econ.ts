// Player-facing helpers for the cosmetic economy: rarity colours and names, Pearl prices, the market
// fee and how Premium items read in each build. One place, so the Locker, Store, Market and Career
// say the same thing. Premium items are sold for real money in the Steam version only; the free
// browser version shows them as "Available in the Steam version".
import { COSMETICS, cosmeticById, type CosmeticDef, type CosmeticSlot, type Rarity } from '../../shared/cosmetics.ts';
import { canTradeForPearls, marketFee as sharedFee, MARKET_FEE_BPS, marketLockedText, MAX_LIST_PEARLS, MIN_LIST_PEARLS, sellerProceeds, type AccountView, type OwnedItem } from '../../shared/economy.ts';
import type { FamilyId } from '../../shared/types.ts';
import { isSteam } from '../platform.ts';
import type { IconId } from './icons.ts';

export const RARITY_INFO: Record<Rarity, { name: string; color: string; glow: string; order: number }> = {
  default: { name: 'Default', color: '#c9b48c', glow: 'rgba(201,180,140,0.35)', order: 0 },
  common: { name: 'Common', color: '#7fd99a', glow: 'rgba(127,217,154,0.4)', order: 1 },
  rare: { name: 'Rare', color: '#5cb4ff', glow: 'rgba(92,180,255,0.45)', order: 2 },
  epic: { name: 'Epic', color: '#c27cff', glow: 'rgba(194,124,255,0.5)', order: 3 },
  premium: { name: 'Premium', color: '#ffb43a', glow: 'rgba(255,180,58,0.55)', order: 4 },
};

/** What the browser build says instead of a price on a Premium item. */
export const STEAM_ONLY = 'Available in the Steam version';

export const SLOT_ICON: Record<CosmeticSlot, IconId> = {
  head: 'slotHead',
  face: 'slotFace',
  body: 'slotBody',
  hands: 'hook',
  feet: 'slotFeet',
  back: 'slotBack',
};

export function fmtPearls(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** A Steam price in US dollars ("US$1.99"). Steam shows each region its own currency. */
export function fmtUsd(n: number): string {
  return `US$${n.toFixed(2)}`;
}

/** Every market price is in Pearls. */
export function fmtPrice(p: { amount: number }): string {
  return `${fmtPearls(p.amount)} Pearls`;
}

/** What the seller receives after the 5% market fee (the shared rule the server applies: rounded up, at least 1 Pearl). */
export function sellerReceives(p: { amount: number }): number {
  return sellerProceeds(p.amount);
}

export function marketFee(p: { amount: number }): number {
  return sharedFee(p.amount);
}

/** The fee as a percentage, for labels ("5%"). */
export const FEE_PCT = MARKET_FEE_BPS / 100;

export const LIST_LIMITS = { min: MIN_LIST_PEARLS, max: MAX_LIST_PEARLS };

/** A suggested starting price for a listing (the store price, or a rarity floor). */
export function suggestPrice(def: CosmeticDef): number {
  const base = def.pearls ?? (def.rarity === 'epic' ? 2400 : def.rarity === 'rare' ? 900 : 300);
  return Math.max(MIN_LIST_PEARLS, Math.min(MAX_LIST_PEARLS, Math.round(base * 0.9)));
}

/** Can this item be listed on the Pearl market? Epic items only: Premium items trade on the Steam Community Market. */
export function marketTradable(def: CosmeticDef | undefined): def is CosmeticDef {
  return canTradeForPearls(def); // the server's own rule (shared/economy.ts)
}

/**
 * Why this account cannot trade on the market yet, in words for the player, or null when it can (or
 * there is nothing to say: offline, or still signing in). The server checks the same rule.
 */
export function marketLockNote(mode: 'local' | 'server', account: Pick<AccountView, 'created' | 'stats'> | null, now = Date.now()): string | null {
  if (mode !== 'server' || !account) return null;
  return marketLockedText(account, now);
}

/**
 * How a Premium item's price reads: the Steam price in the Steam version, a plain "not here"
 * line in the browser. buyable is true only where the Steam Item Store sells it.
 */
export function premiumOffer(def: CosmeticDef, steam = isSteam()): { text: string; buyable: boolean } {
  if (steam && def.usd !== undefined) return { text: fmtUsd(def.usd), buyable: true };
  return { text: STEAM_ONLY, buyable: false };
}

export function catalogFor(family: FamilyId, slot?: CosmeticSlot): CosmeticDef[] {
  return COSMETICS.filter((c) => c.family === family && (!slot || c.slot === slot)).sort(byRarity);
}

export function byRarity(a: CosmeticDef, b: CosmeticDef): number {
  return RARITY_INFO[a.rarity].order - RARITY_INFO[b.rarity].order || (a.pearls ?? 0) - (b.pearls ?? 0) || a.name.localeCompare(b.name);
}

/** Owned copies of an item. */
export function copiesOf(account: AccountView | null | undefined, itemId: string): OwnedItem[] {
  return account ? account.owned.filter((o) => o.item === itemId) : [];
}

export function defOf(id: string): CosmeticDef | undefined {
  return cosmeticById(id);
}

/** Where the item is from, for the detail panels. */
export function sourceLine(def: CosmeticDef, steam = isSteam()): string {
  switch (def.rarity) {
    case 'default':
      return 'Part of the starting look. Everyone has it.';
    case 'premium':
      return steam
        ? 'Premium item, sold through the Steam Item Store. Tradable on the Steam Community Market.'
        : 'Premium item, sold in the Steam version of Hook Wars. It cannot be bought with Pearls.';
    case 'epic':
      return 'Bought with Pearls. Epic items can be traded on the Market.';
    default:
      return 'Bought with Pearls in the Store.';
  }
}
