// Entry point the game server calls: builds the economy from environment variables.
//   ECONOMY=off            -> the null economy (default items only, economy messages refused)
//   otherwise              -> accounts, Pearls, the Pearl store and the Pearl market, kept in
//                             <ECONOMY_DATA_DIR>/economy.db (./store.ts)
// If the data folder is held by another server, or cannot be opened, or its data cannot be read
// (a damaged page included), this run gets the null economy too, with an [economy] ERROR log line.
// It never runs from memory, because a memory-only run would hand every returning player a
// brand-new account, and it never stops the game server from starting. See docs/economy.md.
import type { ServerConfig } from '../config.ts';
import { createNullEconomy, type ServerEconomy } from './api.ts';
import { loadEconomyConfig, type EconomyConfig } from './config.ts';
import { EconomyService } from './service.ts';
import { AccountStore, StoreLockedError, StoreUnreadableError, StoreVersionError } from './store.ts';

export interface EconomyDeps {
  env?: NodeJS.ProcessEnv;
  log?: (s: string) => void;
  now?: () => number;
}

const UNAVAILABLE = 'Accounts, the Store and the Market are unavailable on this server right now. You can still play; your items are safe. Try again later.';

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
    const loud = (s: string) => log(`[economy] ERROR: ${s}`);
    if (err instanceof StoreLockedError) {
      loud(`${err.message} This server runs WITHOUT accounts, the Store or the Market until that other server stops (players keep their saved tokens). Stop the other server, then restart this one. Do not point this server at a new folder: returning players would get empty accounts.`);
    } else if (err instanceof StoreUnreadableError) {
      loud(`${err.message} This server runs WITHOUT accounts, the Store or the Market until the data is fixed (players keep their saved tokens).`);
    } else if (err instanceof StoreVersionError) {
      loud(`${err.message} The economy is off until this server is updated.`);
    } else {
      // e.g. a data folder that cannot be created: the game still runs, and still hands out no tokens
      loud(`the economy data in ${ec.dataDir} could not be opened (${(err as Error).name}: ${(err as Error).message}). This server runs WITHOUT accounts, the Store or the Market until that is fixed (players keep their saved tokens).`);
    }
    return createNullEconomy(UNAVAILABLE);
  }
  if (!store.persistent) log('[economy] accounts are kept in memory only on this run (no ECONOMY_DATA_DIR under the test runner).');
  return new EconomyService({ store, log, now: deps.now });
}

export function createServerEconomy(cfg: ServerConfig, deps: EconomyDeps = {}): ServerEconomy {
  const ec = loadEconomyConfig(cfg, deps.env ?? process.env, deps.log);
  return createEconomyFromConfig(ec, deps);
}

export type { ServerEconomy };
