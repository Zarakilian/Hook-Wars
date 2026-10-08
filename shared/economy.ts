// Economy contract: accounts, inventory, store, marketplace and the wallet link.
// The game server is the source of truth for ownership (docs/economy.md). Solo play uses a local
// account in the browser with the same shapes. Limited items also exist as Metaplex Core NFTs on
// Solana devnet; mainnet stays off until the legal checklist in docs/economy.md is done.
import { cleanLoadout, COSMETIC_SLOTS, cosmeticById, DEFAULT_LOADOUT, type CosmeticDef, type Loadout } from './cosmetics.ts';
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
  /** Pearls already earned today (UTC) toward DAILY_PEARL_CAP; server accounts only */
  earnedToday?: number;
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
/** Online accounts start empty: a starter grant plus free guest accounts plus the market would mint Pearls from nothing. */
export const STARTING_PEARLS = 0;
/** Most Pearls one online account can earn from matches per UTC day. */
export const DAILY_PEARL_CAP = 2000;
/** Most items one account can have listed at once. */
export const MAX_LISTINGS_PER_ACCOUNT = 20;

export function canTrade(def: CosmeticDef | undefined): boolean {
  return !!def && def.tradable;
}

/** Can this item be sold on the Pearl marketplace? Limited items are NFTs and trade on-chain for USDC (a later phase). */
export function canTradeForPearls(def: CosmeticDef | undefined): boolean {
  return canTrade(def) && def!.rarity !== 'limited';
}

/** Fee kept by the marketplace on a Pearl sale (a Pearl sink). Rounded up, so every sale pays at least 1. */
export function marketFee(price: number): number {
  return Math.ceil((price * MARKET_FEE_BPS) / 10_000);
}

/** What the seller receives for a Pearl sale at this price. */
export function sellerProceeds(price: number): number {
  return price - marketFee(price);
}

/** Base58 alphabet check for Solana addresses and signatures (length is checked by the caller). */
export function isBase58(s: unknown, minLen: number, maxLen: number): s is string {
  return typeof s === 'string' && s.length >= minLen && s.length <= maxLen && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s);
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP: Record<string, number> = Object.fromEntries([...B58].map((ch, i) => [ch, i]));

/** Bitcoin-alphabet base58, as Solana uses for addresses and signatures. Leading zero bytes become '1'. */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = []; // little-endian base58 digits
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

/** Decode base58. Null for an empty string, a character outside the alphabet, or a string over 128 characters. */
export function base58Decode(s: string): Uint8Array | null {
  if (typeof s !== 'string' || s.length === 0 || s.length > 128) return null;
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const bytes: number[] = []; // little-endian base256
  for (let i = zeros; i < s.length; i++) {
    const v = B58_MAP[s[i]];
    if (v === undefined) return null;
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

/** A 32-byte Solana public key in base58. */
export function isSolanaAddress(s: unknown): s is string {
  return isBase58(s, 32, 44) && base58Decode(s)?.length === 32;
}

/** Largest Solana transaction is 1232 bytes, which is 1644 base64 characters. */
export const MAX_TX_BASE64 = 1644;

export function isBase64(s: unknown, minLen: number, maxLen: number): s is string {
  return typeof s === 'string' && s.length >= minLen && s.length <= maxLen && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
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
  // tx = the transaction from 'usdcOrder' after the wallet signed it (solana:signTransaction), base64.
  // The server checks the message is byte-for-byte the one it built, then submits it itself.
  | { t: 'usdcSubmit'; order: string; tx: string }
  | { t: 'market' }
  | { t: 'marketSell'; instance: string; price: Price }
  | { t: 'marketBuy'; listing: string }
  | { t: 'marketCancel'; listing: string };

export type EconomyServerMsg =
  | { t: 'account'; a: AccountView; token?: string } // token only when a new account was created
  | { t: 'market'; listings: Listing[] }
  | { t: 'walletChallenge'; message: string }
  // tx = base64 serialized legacy transaction, partially signed by the server's fee payer
  | { t: 'usdcOrder'; order: string; tx: string; expires: number; item?: string; usdc?: number }
  | { t: 'reward'; pearls: number; reason: string }
  // re = the request this error answers, so the client can fail the right pending action
  | { t: 'econError'; code: string; message: string; re?: EconomyClientMsg['t'] };

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
      return order && isBase64(m.tx, 100, MAX_TX_BASE64) ? { t: 'usdcSubmit', order, tx: m.tx } : null;
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
