// Entry point the game server calls: builds the economy from environment variables.
//   ECONOMY=off            -> the null economy (default items only, economy messages refused)
//   ECONOMY_NETWORK=off    -> accounts, Pearls, store and market; Limited items are not sold
//   ECONOMY_NETWORK=devnet -> as above, plus Limited items for devnet USDC through ./solanaDevnet.ts,
//                             which (with its Solana packages) is only loaded by a dynamic import()
// See server/economy/config.ts for every variable, and docs/economy.md for setup.
import type { ServerConfig } from '../config.ts';
import { createNullEconomy, type ServerEconomy } from './api.ts';
import { ChainError, MockChain, type BuiltTransfer, type ChainAdapter, type MintSpec, type PaymentResult, type StoredTransfer, type UsdcOrderSpec } from './chain.ts';
import { loadEconomyConfig, type DevnetConfig, type EconomyConfig } from './config.ts';
import { EconomyService } from './service.ts';
import { AccountStore, StoreVersionError } from './store.ts';

/**
 * Loads the devnet adapter on first use. A failed load is retried after a short pause instead of
 * being cached forever, so a server started while the RPC was down recovers on its own.
 */
export class LazyDevnetChain implements ChainAdapter {
  readonly network = 'devnet' as const;
  readonly purchases = true;
  private readonly cfg: DevnetConfig;
  private readonly log: (s: string) => void;
  private inner: Promise<ChainAdapter> | null = null;
  private failedAt = 0;
  private closed = false;

  constructor(cfg: DevnetConfig, log: (s: string) => void) {
    this.cfg = cfg;
    this.log = log;
  }

  private load(): Promise<ChainAdapter> {
    if (this.inner) return this.inner;
    if (Date.now() - this.failedAt < 15_000) return Promise.reject(new ChainError('chain_unavailable', 'The Solana devnet connection is starting. Try again in a moment. Nothing was charged.'));
    this.inner = import('./solanaDevnet.ts')
      .then((m) => m.createSolanaDevnet(this.cfg, this.log))
      .catch((err: unknown) => {
        this.inner = null;
        this.failedAt = Date.now();
        this.log(`[economy] could not load the devnet adapter: ${(err as Error).message}`);
        throw new ChainError('chain_unavailable', 'This server could not start its Solana devnet connection. Nothing was charged.');
      });
    return this.inner;
  }

  async ready(): Promise<void> {
    await (await this.load()).ready();
  }
  async buildUsdcTransfer(spec: UsdcOrderSpec): Promise<BuiltTransfer> {
    return (await this.load()).buildUsdcTransfer(spec);
  }
  async submitUsdcTransfer(order: StoredTransfer, signedTx: Uint8Array, onSent: (signature: string) => void): Promise<PaymentResult> {
    return (await this.load()).submitUsdcTransfer(order, signedTx, onSent);
  }
  async checkUsdcPayment(order: StoredTransfer, signature: string): Promise<PaymentResult> {
    return (await this.load()).checkUsdcPayment(order, signature);
  }
  async mintLimited(spec: MintSpec): Promise<{ asset: string }> {
    return (await this.load()).mintLimited(spec);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.inner?.then((c) => c.close()).catch(() => {});
  }
}

export interface EconomyDeps {
  /** override the chain (tests) */
  chain?: ChainAdapter;
  env?: NodeJS.ProcessEnv;
  log?: (s: string) => void;
  now?: () => number;
}

export function createEconomyFromConfig(ec: EconomyConfig, deps: EconomyDeps = {}): ServerEconomy {
  const log = deps.log ?? ((s: string) => console.log(s));
  if (!ec.enabled) {
    log('[economy] ECONOMY=off: no accounts; everyone wears the default sets.');
    return createNullEconomy();
  }
  let store: AccountStore;
  try {
    store = new AccountStore({ dir: ec.dataDir, log });
  } catch (err) {
    if (err instanceof StoreVersionError) {
      log(`[economy] ${err.message} The economy is off until this server is updated.`);
      return createNullEconomy();
    }
    throw err;
  }
  if (!store.persistent) log('[economy] accounts are kept in memory only on this run.');
  const chain = deps.chain ?? (ec.devnet ? new LazyDevnetChain(ec.devnet, log) : new MockChain({ purchases: false }));
  const network = ec.devnet ? 'devnet' : 'off';
  if (ec.devnet && !deps.chain) {
    // check the devnet setup in the background so problems show in the log at start
    chain.ready().then(
      () => log('[economy] Solana devnet is ready: Limited items can be bought with devnet USDC.'),
      (err: unknown) => log(`[economy] Solana devnet is not ready: ${(err as Error).message}`),
    );
  }
  return new EconomyService({ store, chain, domain: ec.domain, network, metadataBaseUrl: ec.devnet?.metadataBaseUrl ?? '', log, now: deps.now });
}

export function createServerEconomy(cfg: ServerConfig, deps: EconomyDeps = {}): ServerEconomy {
  const ec = loadEconomyConfig(cfg, deps.env ?? process.env, deps.log);
  return createEconomyFromConfig(ec, deps);
}

export type { ServerEconomy };
