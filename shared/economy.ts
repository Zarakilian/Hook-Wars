// Economy contract: accounts, inventory, the Pearl store and the Pearl marketplace.
// The game server is the source of truth for ownership online (docs/economy.md). Solo play uses a
// local account in the browser with the same shapes.
//
// Standard edition: Pearls are the only currency here. Premium items are sold for real money only
// in the Steam version (Steam Item Store and Community Market, a later phase); this build never
// sells, grants, trades or lets anyone wear them.
import { cleanLoadout, COSMETIC_SLOTS, cosmeticById, DEFAULT_LOADOUT, type CosmeticDef, type Loadout } from './cosmetics.ts';
import { FAMILIES, type FamilyId } from './types.ts';

/** One owned copy of a catalog item. Default items are implied and never listed here. */
export interface OwnedItem {
  instance: string; // unique id of this copy (server generated)
  item: string; // CosmeticDef.id
  listed?: string; // listing id while it is for sale
}

export interface AccountView {
  id: string; // public account id (not the auth token)
  pearls: number;
  owned: OwnedItem[];
  loadouts: Record<FamilyId, Loadout>;
  stats: { matches: number; wins: number; kills: number; hooksHit: number };
  /** Pearls already earned today (UTC) toward DAILY_PEARL_CAP; server accounts only */
  earnedToday?: number;
  /** epoch ms the account was made; server accounts only (market trading opens with age) */
  created?: number;
}

export type Price = { cur: 'pearls'; amount: number };

export interface Listing {
  id: string;
  seller: string; // account id
  sellerName: string;
  instance: string;
  item: string;
  price: Price;
  created: number; // epoch ms
}

/** Marketplace fee taken on every resale, in basis points (5%). The fee leaves the economy. */
export const MARKET_FEE_BPS = 500;
/** Pearls earned in solo are reduced so offline farming cannot flood the Pearl economy. */
export const SOLO_PEARL_RATE = 0.5;
export const MIN_LIST_PEARLS = 50;
export const MAX_LIST_PEARLS = 1_000_000;
/** Online accounts start empty: a starter grant plus free guest accounts plus the market would mint Pearls from nothing. */
export const STARTING_PEARLS = 0;
/** Most Pearls one online account can earn from matches per UTC day. */
export const DAILY_PEARL_CAP = 2000;
/**
 * Most Pearls all accounts on one internet connection can earn from matches per UTC day (an IPv4
 * address, or an IPv6 /64). Two accounts' worth, so two people at one address both reach their cap,
 * while throwaway accounts on one connection add nothing past it.
 */
export const DAILY_PEARL_CAP_PER_IP = 2 * DAILY_PEARL_CAP;
/** Most items one account can have listed at once. */
export const MAX_LISTINGS_PER_ACCOUNT = 20;
/** An account can buy or sell on the market once it is this old... */
export const MARKET_MIN_AGE_MS = 24 * 3600_000;
/** ...and has played this many online matches. Stops throwaway accounts moving Pearls to a main account. */
export const MARKET_MIN_MATCHES = 10;

/** Premium items belong to the Steam version: this build never counts them as owned. */
export function isPremium(itemId: string): boolean {
  return cosmeticById(itemId)?.rarity === 'premium';
}

export function canTrade(def: CosmeticDef | undefined): boolean {
  return !!def && def.tradable;
}

/** Can this item be sold on the Pearl marketplace? Epic items only; premium items trade on Steam. */
export function canTradeForPearls(def: CosmeticDef | undefined): boolean {
  return canTrade(def) && def!.rarity !== 'premium';
}

/** Fee kept by the marketplace on a Pearl sale (a Pearl sink). Rounded up, so every sale pays at least 1. */
export function marketFee(price: number): number {
  return Math.ceil((price * MARKET_FEE_BPS) / 10_000);
}

/** What the seller receives for a Pearl sale at this price. */
export function sellerProceeds(price: number): number {
  return price - marketFee(price);
}

/** Can this account trade on the market yet? (see MARKET_MIN_AGE_MS and MARKET_MIN_MATCHES) */
export function marketOpenFor(a: { created?: number; stats: { matches: number } }, now: number): boolean {
  return a.stats.matches >= MARKET_MIN_MATCHES && a.created !== undefined && now - a.created >= MARKET_MIN_AGE_MS;
}

/** Why the market is still closed for this account, in words for the player (null = open). */
export function marketLockedText(a: { created?: number; stats: { matches: number } }, now: number): string | null {
  if (marketOpenFor(a, now)) return null;
  const age = a.created === undefined ? 0 : now - a.created;
  const hours = Math.ceil(Math.max(0, MARKET_MIN_AGE_MS - age) / 3600_000);
  const games = Math.max(0, MARKET_MIN_MATCHES - a.stats.matches);
  const need = [hours > 0 ? `${hours} more hour${hours === 1 ? '' : 's'}` : '', games > 0 ? `${games} more online match${games === 1 ? '' : 'es'}` : ''].filter(Boolean).join(' and ');
  return `The market opens for an account once it is a day old and has played ${MARKET_MIN_MATCHES} online matches. Yours needs ${need}.`;
}

// ---------------------------------------------------------------------------------------------
// Messages (parsed here; shared/protocol.ts delegates every type in ECONOMY_MSG_TYPES)
// ---------------------------------------------------------------------------------------------

export type EconomyClientMsg =
  | { t: 'equip'; family: FamilyId; loadout: Loadout }
  | { t: 'storeBuy'; item: string }
  // the market list, and live updates to it for a couple of minutes (send it again to keep them coming)
  | { t: 'market' }
  | { t: 'marketSell'; instance: string; price: Price }
  | { t: 'marketBuy'; listing: string }
  | { t: 'marketCancel'; listing: string };

export type EconomyServerMsg =
  | { t: 'account'; a: AccountView; token?: string } // token only when a new account was created
  | { t: 'market'; listings: Listing[] }
  | { t: 'reward'; pearls: number; reason: string }
  // re = the request this error answers, so the client can fail the right pending action.
  // Without re, ACCOUNT_STATE_CODES say why this connection has no account (see below).
  | { t: 'econError'; code: string; message: string; re?: EconomyClientMsg['t'] };

/**
 * econError codes sent once after hello when the server gives this connection no account:
 *   account_limit = too many new accounts from this internet connection in the last hour
 *   disabled      = this server runs without accounts, the Store or the Market
 */
export const ACCOUNT_STATE_CODES: ReadonlySet<string> = new Set(['account_limit', 'disabled']);

export const ECONOMY_MSG_TYPES: ReadonlySet<string> = new Set<EconomyClientMsg['t']>(['equip', 'storeBuy', 'market', 'marketSell', 'marketBuy', 'marketCancel']);

// Server ids carry a prefix (lst_, itm_), so names like __proto__ or constructor never parse.
const LISTING_ID_RE = /^lst_[A-Za-z0-9_-]{4,40}$/;
const INSTANCE_ID_RE = /^itm_[A-Za-z0-9_-]{4,40}$/;

function itemId(v: unknown): string | null {
  return typeof v === 'string' && v.length <= 64 && cosmeticById(v) ? v : null;
}

function parsePrice(v: unknown): Price | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  if (p.cur !== 'pearls') return null;
  const amount = typeof p.amount === 'number' && Number.isInteger(p.amount) && p.amount >= MIN_LIST_PEARLS && p.amount <= MAX_LIST_PEARLS ? p.amount : null;
  return amount === null ? null : { cur: 'pearls', amount };
}

/** Validate one economy message (already JSON-parsed, m.t in ECONOMY_MSG_TYPES). Null = drop it. */
export function parseEconomyClientMsg(m: Record<string, unknown>): EconomyClientMsg | null {
  switch (m.t) {
    case 'equip': {
      const family = typeof m.family === 'string' && (FAMILIES as readonly string[]).includes(m.family) ? (m.family as FamilyId) : null;
      return family ? { t: 'equip', family, loadout: cleanLoadout(family, m.loadout) } : null;
    }
    case 'storeBuy': {
      const item = itemId(m.item);
      return item ? { t: 'storeBuy', item } : null;
    }
    case 'market':
      return { t: 'market' };
    case 'marketSell': {
      const instance = typeof m.instance === 'string' && INSTANCE_ID_RE.test(m.instance) ? m.instance : null;
      const price = parsePrice(m.price);
      return instance && price ? { t: 'marketSell', instance, price } : null;
    }
    case 'marketBuy':
    case 'marketCancel': {
      const listing = typeof m.listing === 'string' && LISTING_ID_RE.test(m.listing) ? m.listing : null;
      return listing ? { t: m.t, listing } : null;
    }
    default:
      return null;
  }
}

/**
 * Clamp a loadout to what the player may wear. An item they cannot wear (not owned, or listed for sale)
 * falls back to the family's default item for that slot; a slot left empty on purpose stays bare.
 */
export function wearableLoadout(family: FamilyId, loadout: Loadout, canWear: (id: string) => boolean): Loadout {
  const clean = cleanLoadout(family, loadout);
  const out: Loadout = {};
  for (const slot of COSMETIC_SLOTS) {
    if (!(slot in loadout) || loadout[slot] === undefined) continue; // bare on purpose
    const id = clean[slot];
    if (id && canWear(id)) out[slot] = id;
    else if (DEFAULT_LOADOUT[family][slot]) out[slot] = DEFAULT_LOADOUT[family][slot];
  }
  return out;
}
