// Player-facing helpers for the cosmetic economy: rarity colours and names, prices, the market fee,
// wallet addresses. One place, so the Locker, Store, Market and Career say the same thing.
import { COSMETICS, cosmeticById, type CosmeticDef, type CosmeticSlot, type Rarity } from '../../shared/cosmetics.ts';
import { MARKET_FEE_BPS, MAX_LIST_PEARLS, MIN_LIST_PEARLS, type AccountView, type ChainNetwork, type OwnedItem, type Price } from '../../shared/economy.ts';
import type { FamilyId } from '../../shared/types.ts';
import type { IconId } from './icons.ts';

export const RARITY_INFO: Record<Rarity, { name: string; color: string; glow: string; order: number }> = {
  default: { name: 'Default', color: '#c9b48c', glow: 'rgba(201,180,140,0.35)', order: 0 },
  common: { name: 'Common', color: '#7fd99a', glow: 'rgba(127,217,154,0.4)', order: 1 },
  rare: { name: 'Rare', color: '#5cb4ff', glow: 'rgba(92,180,255,0.45)', order: 2 },
  epic: { name: 'Epic', color: '#c27cff', glow: 'rgba(194,124,255,0.5)', order: 3 },
  limited: { name: 'Limited', color: '#ffb43a', glow: 'rgba(255,180,58,0.55)', order: 4 },
};

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

export function fmtUsdc(n: number): string {
  return `${n.toFixed(2)} USDC`;
}

export function fmtPrice(p: Price): string {
  return p.cur === 'pearls' ? `${fmtPearls(p.amount)} Pearls` : fmtUsdc(p.amount);
}

/**
 * Seller proceeds after the 5% market fee. The fee is rounded down to whole Pearls (whole cents for
 * USDC), so the seller never gets less than 95%. The server is the authority; see contractConcerns.
 */
export function sellerReceives(p: Price): number {
  if (p.cur === 'pearls') return p.amount - Math.floor((p.amount * MARKET_FEE_BPS) / 10_000);
  const cents = Math.round(p.amount * 100);
  return (cents - Math.floor((cents * MARKET_FEE_BPS) / 10_000)) / 100;
}

export function marketFee(p: Price): number {
  return p.cur === 'pearls' ? p.amount - sellerReceives(p) : Math.round((p.amount - sellerReceives(p)) * 100) / 100;
}

export const LIST_LIMITS = { min: MIN_LIST_PEARLS, max: MAX_LIST_PEARLS };

/** A suggested starting price for a listing (the store price, or a rarity floor). */
export function suggestPrice(def: CosmeticDef): number {
  const base = def.pearls ?? (def.rarity === 'epic' ? 2400 : def.rarity === 'rare' ? 900 : 300);
  return Math.max(MIN_LIST_PEARLS, Math.min(MAX_LIST_PEARLS, Math.round(base * 0.9)));
}

export function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

export function networkLabel(n: ChainNetwork): string {
  return n === 'devnet' ? 'Devnet' : n === 'mainnet' ? 'Mainnet' : 'Off';
}

export function catalogFor(family: FamilyId, slot?: CosmeticSlot): CosmeticDef[] {
  return COSMETICS.filter((c) => c.family === family && (!slot || c.slot === slot)).sort(byRarity);
}

export function byRarity(a: CosmeticDef, b: CosmeticDef): number {
  return RARITY_INFO[a.rarity].order - RARITY_INFO[b.rarity].order || (a.pearls ?? 0) - (b.pearls ?? 0) || a.name.localeCompare(b.name);
}

/** Owned copies of an item (Limited items carry serials). */
export function copiesOf(account: AccountView | null | undefined, itemId: string): OwnedItem[] {
  return account ? account.owned.filter((o) => o.item === itemId) : [];
}

export function serialText(o: { serial?: number }, def: CosmeticDef | undefined): string {
  if (o.serial === undefined) return '';
  return def?.supply ? `#${o.serial} / ${def.supply}` : `#${o.serial}`;
}

export function defOf(id: string): CosmeticDef | undefined {
  return cosmeticById(id);
}

/** Where the item is from, for the detail panels. */
export function sourceLine(def: CosmeticDef): string {
  switch (def.rarity) {
    case 'default':
      return 'Part of the starting look. Everyone has it.';
    case 'limited':
      return `Limited edition of ${def.supply ?? '?'}. Minted as an NFT on Solana devnet. Tradable.`;
    case 'epic':
      return 'Bought with Pearls. Epic items can be traded on the Market.';
    default:
      return 'Bought with Pearls in the Store.';
  }
}
