// Contract between the UI (Locker, Store, Marketplace, Wallet) and the client economy.
// Offline (solo) the account lives in this browser; online it lives on the server you connect to.
import type { Loadout } from '../../shared/cosmetics.ts';
import type { AccountView, ChainNetwork, Listing } from '../../shared/economy.ts';
import type { ServerMsg } from '../../shared/protocol.ts';
import type { FamilyId } from '../../shared/types.ts';

export interface EconomyState {
  /** 'local' = this browser's offline locker, 'server' = the account on the connected server */
  mode: 'local' | 'server';
  account: AccountView | null;
  listings: Listing[];
  busy: boolean;
  /** last error to show, cleared on the next successful action */
  error: string | null;
  /** a Solana wallet extension (Wallet Standard) was found in this browser */
  walletAvailable: boolean;
  network: ChainNetwork;
}

export interface EconomyClient {
  state(): EconomyState;
  /** subscribe; returns an unsubscribe function */
  onChange(cb: (s: EconomyState) => void): () => void;
  owns(itemId: string): boolean;
  equip(family: FamilyId, loadout: Loadout): void;
  buyWithPearls(itemId: string): void;
  /** Pearls earned locally (solo match end); ignored in server mode, where the server pays out */
  grantLocal(pearls: number, reason: string): void;
  connectWallet(): Promise<void>;
  buyWithUsdc(itemId: string): Promise<void>;
  refreshMarket(): void;
  listForSale(instance: string, pearls: number): void;
  buyListing(listing: string): void;
  cancelListing(listing: string): void;
  /** the app forwards economy server messages here */
  receive(msg: ServerMsg): void;
  /** the app calls these when an online connection opens or closes */
  attachServer(send: (msg: unknown) => void, serverKey: string): void;
  detachServer(): void;
  /** auth token to send in hello for this server (null = create a new account) */
  tokenFor(serverKey: string): string | null;
}
