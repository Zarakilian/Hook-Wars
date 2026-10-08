// Economy contract: accounts, inventory, store, marketplace and the wallet link.
// The game server is the source of truth for ownership (docs/economy.md). Solo play uses a local
// account in the browser with the same shapes. Limited items also exist as Metaplex Core NFTs on
// Solana devnet; mainnet stays off until the legal checklist in docs/economy.md is done.
import type { CosmeticDef, Loadout } from './cosmetics.ts';
import type { FamilyId } from './types.ts';

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
// Messages (validated in shared/protocol.ts)
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
