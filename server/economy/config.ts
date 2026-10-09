// Economy settings from environment variables (see .env.example and docs/economy.md).
//   ECONOMY           on | off | trust. Default on. Off = no accounts, everyone wears the default sets.
//                     trust = a lobby the Steam desktop app hosts for its players: no accounts and no
//                     database; each player's own locker (kept by their client) decides what they wear,
//                     limited to real, non-premium catalog items of their family (./trust.ts).
//   ECONOMY_DATA_DIR  folder for economy.db. Default ./data (gitignored). Under `node --test` with
//                     no value set, accounts stay in memory so the test suite never writes ./data.
import { resolve } from 'node:path';
import type { ServerConfig } from '../config.ts';

export type EconomyMode = 'on' | 'off' | 'trust';

export interface EconomyConfig {
  /** accounts and economy.db (ECONOMY=on); false for off and trust */
  enabled: boolean;
  /** what ECONOMY asked for (absent = 'on' when enabled, else 'off') */
  mode?: EconomyMode;
  /** null = keep accounts in memory only (tests) */
  dataDir: string | null;
  /** problems found while reading the settings, already logged */
  problems: string[];
}

function str(env: NodeJS.ProcessEnv, name: string, maxLen = 512): string {
  return (env[name] ?? '').trim().slice(0, maxLen);
}

/** Settings from the Solana build (branch edition/solana) that this edition ignores. */
const RETIRED = ['ECONOMY_NETWORK', 'SOLANA_RPC_URL', 'ECONOMY_KEYPAIR_PATH', 'TREASURY_ADDRESS', 'USDC_MINT', 'CORE_COLLECTION', 'NFT_METADATA_BASE_URL', 'ECONOMY_DOMAIN'];

export function loadEconomyConfig(_server: Pick<ServerConfig, 'serverName'>, env: NodeJS.ProcessEnv = process.env, log: (s: string) => void = console.log): EconomyConfig {
  const problems: string[] = [];
  const raw = str(env, 'ECONOMY').toLowerCase();
  const mode: EconomyMode = raw === 'off' ? 'off' : raw === 'trust' ? 'trust' : 'on';
  const enabled = mode === 'on';
  const rawDir = str(env, 'ECONOMY_DATA_DIR');
  const dataDir = rawDir ? resolve(rawDir) : env.NODE_TEST_CONTEXT ? null : resolve('data');
  const retired = RETIRED.filter((k) => str(env, k) !== '');
  if (retired.length) {
    const s = `${retired.join(', ')} ${retired.length === 1 ? 'is' : 'are'} not used by this edition and ignored (Pearls only; the Solana build lives on branch edition/solana). Remove ${retired.length === 1 ? 'it' : 'them'} from .env.`;
    problems.push(s);
    log(`[economy] ${s}`);
  }
  return { enabled, mode, dataDir, problems };
}
