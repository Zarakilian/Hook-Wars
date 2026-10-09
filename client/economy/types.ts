// Contract between the UI (Locker, Store, Marketplace) and the client economy.
// Offline (solo) the account lives in this browser; online it lives on the server you connect to.
// Standard edition: Pearls only. Premium items are sold in the Steam version, never here.
import type { Loadout } from '../../shared/cosmetics.ts';
import type { AccountView, Listing } from '../../shared/economy.ts';
import type { ServerMsg } from '../../shared/protocol.ts';
import type { FamilyId } from '../../shared/types.ts';
import type { CloudSaverOptions, CloudStore } from './cloudLocker.ts';

export interface EconomyState {
  /** 'local' = this browser's offline locker, 'server' = the account on the connected server */
  mode: 'local' | 'server';
  /** null online while signing in, or when the server gave no account (see accountError) */
  account: AccountView | null;
  listings: Listing[];
  busy: boolean;
  /** last error to show, cleared on the next successful action */
  error: string | null;
  /**
   * Online only: why this server gave you no account, in words for the player. Set when the server
   * refused one (too many new accounts from your internet connection this hour), runs without
   * accounts (also when that is the answer to the Market's request), or did not sign you in within
   * a few seconds. null while signing in and once signed in.
   * Show it where the screens would otherwise say "Signing in...".
   */
  accountError: string | null;
  /**
   * Connected to a server that keeps no accounts (ECONOMY=trust: a lobby a player hosts in the Steam
   * build). mode is 'local' then: the offline locker is what this player wears and spends there, and
   * the client pays its own Pearls at match end (payLocalMatch). False or absent everywhere else.
   */
  localOnly?: boolean;
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
  /** ask the server for the market list once (it also sends live updates for the next 60 s) */
  refreshMarket(): void;
  /**
   * Call when the Market screen opens: asks for the list and keeps live updates coming while the
   * screen is open. Call the returned function when the screen closes, so the server stops pushing
   * market updates to this connection (they would share the line with a match).
   */
  watchMarket(): () => void;
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
  /**
   * Pearls for an online match on a local_only server, paid into the offline locker once per match
   * key (client/economy/payout.ts matchKey). False when that match was paid already.
   */
  payLocalMatch(key: string, pearls: number): boolean;
  /**
   * Steam build: also keep the offline locker in Steam Cloud. Reads the Cloud copy first (the newer of
   * it and this computer's copy wins), then every change is written to localStorage at once and to the
   * Cloud a moment later; a failed Cloud write keeps the data and retries. Resolves with which copy
   * is used: 'cloud', 'local', or 'failed' (the Cloud could not be read; the local copy is used).
   */
  useCloud(store: CloudStore, opts?: CloudSaverOptions & { readTries?: number }): Promise<'cloud' | 'local' | 'failed'>;
  /** Write a pending Cloud save now (true when the Cloud has the newest copy, or there is no Cloud). */
  flushCloud(): Promise<boolean>;
}
