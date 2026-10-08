// Economy contract: accounts, inventory, store, marketplace and the wallet link.
// The game server is the source of truth for ownership (docs/economy.md). Solo play uses a local
// account in the browser with the same shapes. Limited items also exist as Metaplex Core NFTs on
// Solana devnet; mainnet stays off until the legal checklist in docs/economy.md is done.
import { cleanLoadout, cosmeticById, type CosmeticDef, type Loadout } from './cosmetics.ts';
import { FAMILIES, type FamilyId } from './types.ts';

export type ChainNetwork = 'off' | 'devnet' | 'mainnet';

/** One owned copy of a catalog item. Default items are implied and never listed here. */
export interface OwnedItem {
  instance: string; // unique id of this copy (server generated)
  item: string; // CosmeticDef.id
  serial?: number; // limited editions: #serial / supply
  asset?: string; // limited editions: the on-chain asset address (base58)
  listed?: string; // listing id while it is for sale
}

export interface AccountView {
  id: string; // public account id (not the auth token)
  pearls: number;
  owned: OwnedItem[];
  loadouts: Record<FamilyId, Loadout>;
  wallet: string | null; // linked Solana address (base58)
  network: ChainNetwork; // what the server's chain adapter runs on
  stats: { matches: number; wins: number; kills: number; hooksHit: number };
}

export type Price = { cur: 'pearls'; amount: number } | { cur: 'usdc'; amount: number };

export interface Listing {
  id: string;
  seller: string; // account id
  sellerName: string;
  instance: string;
  item: string;
  serial?: number;
  price: Price;
  created: number; // epoch ms
}

/** Marketplace fee taken on every resale, in basis points (5%). Enforced on-chain by the royalty plugin too. */
export const MARKET_FEE_BPS = 500;
/** Pearls earned in solo are reduced so offline farming cannot flood the Pearl economy. */
export const SOLO_PEARL_RATE = 0.5;
export const MIN_LIST_PEARLS = 50;
export const MAX_LIST_PEARLS = 1_000_000;

export function canTrade(def: CosmeticDef | undefined): boolean {
  return !!def && def.tradable;
}

/** Base58 alphabet check for Solana addresses and signatures (length is checked by the caller). */
export function isBase58(s: unknown, minLen: number, maxLen: number): s is string {
  return typeof s === 'string' && s.length >= minLen && s.length <= maxLen && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

// ---------------------------------------------------------------------------------------------
// Messages (parsed here; shared/protocol.ts delegates every type in ECONOMY_MSG_TYPES)
// ---------------------------------------------------------------------------------------------

export type EconomyClientMsg =
  | { t: 'equip'; family: FamilyId; loadout: Loadout }
  | { t: 'storeBuy'; item: string }
  | { t: 'walletChallenge' }
  | { t: 'walletLink'; address: string; signature: string } // both base58
  | { t: 'usdcOrder'; item: string }
  | { t: 'usdcSubmit'; order: string; signature: string } // the transaction signature (base58)
  | { t: 'market' }
  | { t: 'marketSell'; instance: string; price: Price }
  | { t: 'marketBuy'; listing: string }
  | { t: 'marketCancel'; listing: string };

export type EconomyServerMsg =
  | { t: 'account'; a: AccountView; token?: string } // token only when a new account was created
  | { t: 'market'; listings: Listing[] }
  | { t: 'walletChallenge'; message: string }
  | { t: 'usdcOrder'; order: string; tx: string; expires: number } // tx = base64 serialized, partially signed
  | { t: 'reward'; pearls: number; reason: string }
  | { t: 'econError'; code: string; message: string };

export const ECONOMY_MSG_TYPES: ReadonlySet<string> = new Set<EconomyClientMsg['t']>([
  'equip', 'storeBuy', 'walletChallenge', 'walletLink', 'usdcOrder', 'usdcSubmit', 'market', 'marketSell', 'marketBuy', 'marketCancel',
]);

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;

function itemId(v: unknown): string | null {
  return typeof v === 'string' && v.length <= 64 && cosmeticById(v) ? v : null;
}

function parsePrice(v: unknown): Price | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  if (p.cur === 'pearls') {
    const amount = typeof p.amount === 'number' && Number.isInteger(p.amount) && p.amount >= MIN_LIST_PEARLS && p.amount <= MAX_LIST_PEARLS ? p.amount : null;
    return amount === null ? null : { cur: 'pearls', amount };
  }
  if (p.cur === 'usdc') {
    // whole cents only, 0.10 to 10 000 USDC
    const amount = typeof p.amount === 'number' && Number.isFinite(p.amount) && Math.round(p.amount * 100) === p.amount * 100 && p.amount >= 0.1 && p.amount <= 10_000 ? p.amount : null;
    return amount === null ? null : { cur: 'usdc', amount };
  }
  return null;
}

/** Validate one economy message (already JSON-parsed, m.t in ECONOMY_MSG_TYPES). Null = drop it. */
export function parseEconomyClientMsg(m: Record<string, unknown>): EconomyClientMsg | null {
  switch (m.t) {
    case 'equip': {
      const family = typeof m.family === 'string' && (FAMILIES as readonly string[]).includes(m.family) ? (m.family as FamilyId) : null;
      return family ? { t: 'equip', family, loadout: cleanLoadout(family, m.loadout) } : null;
    }
    case 'storeBuy':
    case 'usdcOrder': {
      const item = itemId(m.item);
      return item ? { t: m.t, item } : null;
    }
    case 'walletChallenge':
    case 'market':
      return { t: m.t };
    case 'walletLink':
      return isBase58(m.address, 32, 44) && isBase58(m.signature, 64, 100) ? { t: 'walletLink', address: m.address, signature: m.signature } : null;
    case 'usdcSubmit': {
      const order = typeof m.order === 'string' && ID_RE.test(m.order) ? m.order : null;
      return order && isBase58(m.signature, 64, 100) ? { t: 'usdcSubmit', order, signature: m.signature } : null;
    }
    case 'marketSell': {
      const instance = typeof m.instance === 'string' && ID_RE.test(m.instance) ? m.instance : null;
      const price = parsePrice(m.price);
      return instance && price ? { t: 'marketSell', instance, price } : null;
    }
    case 'marketBuy':
    case 'marketCancel': {
      const listing = typeof m.listing === 'string' && ID_RE.test(m.listing) ? m.listing : null;
      return listing ? { t: m.t, listing } : null;
    }
    default:
      return null;
  }
}

/** Message the wallet signs to prove it owns the address (Sign in with Solana style). */
export function walletChallengeText(domain: string, accountId: string, nonce: string, issuedAt: string): string {
  return [
    `${domain} wants you to link your Solana wallet to Hook Wars.`,
    '',
    `Account: ${accountId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    '',
    'Signing this costs nothing and does not allow any transaction.',
  ].join('\n');
}
