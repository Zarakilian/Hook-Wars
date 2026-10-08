// Economy settings from environment variables (see .env.example and docs/economy.md).
//   ECONOMY               on | off. Default on. Off = no accounts, everyone wears the default sets.
//   ECONOMY_DATA_DIR      folder for economy.json. Default ./data (gitignored). Under `node --test`
//                         with no value set, accounts stay in memory so the test suite never writes ./data.
//   ECONOMY_DOMAIN        name shown in the wallet-link message, normally your public host (default: SERVER_NAME)
//   ECONOMY_NETWORK       off | devnet. Default off. 'mainnet' is refused until the legal checklist is done.
//   SOLANA_RPC_URL        devnet RPC endpoint. Default https://api.devnet.solana.com
//   ECONOMY_KEYPAIR_PATH  fee payer and mint authority keypair (solana-keygen JSON), kept OUTSIDE the repo
//   TREASURY_ADDRESS      wallet that receives USDC (only its address lives here, never its key)
//   USDC_MINT             the devnet USDC mint address
//   CORE_COLLECTION       the Metaplex Core collection Limited items are minted into
//   NFT_METADATA_BASE_URL optional: off-chain metadata JSON base URL; the asset uri becomes <base>/<item id>.json
import { resolve, sep } from 'node:path';
import type { ChainNetwork } from '../../shared/economy.ts';
import { isSolanaAddress } from '../../shared/economy.ts';
import type { ServerConfig } from '../config.ts';

export const DEFAULT_DEVNET_RPC = 'https://api.devnet.solana.com';

export interface DevnetConfig {
  rpcUrl: string;
  keypairPath: string;
  treasury: string;
  usdcMint: string;
  collection: string;
  metadataBaseUrl: string;
}

export interface EconomyConfig {
  enabled: boolean;
  /** null = keep accounts in memory only */
  dataDir: string | null;
  domain: string;
  /** what clients are told the chain adapter runs on */
  network: Exclude<ChainNetwork, 'mainnet'>;
  /** set when network is devnet and every devnet setting is present and valid */
  devnet: DevnetConfig | null;
  /** problems found while reading the settings, already logged */
  problems: string[];
}

function str(env: NodeJS.ProcessEnv, name: string, maxLen = 512): string {
  return (env[name] ?? '').trim().slice(0, maxLen);
}

/** Is `p` inside `dir` (or equal to it)? Case-insensitive on Windows. */
function isInside(p: string, dir: string): boolean {
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const a = norm(resolve(p));
  const b = norm(resolve(dir));
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

export function loadEconomyConfig(server: Pick<ServerConfig, 'serverName'>, env: NodeJS.ProcessEnv = process.env, log: (s: string) => void = console.log): EconomyConfig {
  const problems: string[] = [];
  const warn = (s: string) => {
    problems.push(s);
    log(`[economy] ${s}`);
  };
  const enabled = str(env, 'ECONOMY').toLowerCase() !== 'off';
  const rawDir = str(env, 'ECONOMY_DATA_DIR');
  const dataDir = rawDir ? resolve(rawDir) : env.NODE_TEST_CONTEXT ? null : resolve('data');
  const domain = (str(env, 'ECONOMY_DOMAIN', 80) || server.serverName).replace(/[\u0000-\u001f\u007f<>]/g, '');

  let network: EconomyConfig['network'] = 'off';
  const rawNet = str(env, 'ECONOMY_NETWORK').toLowerCase();
  if (rawNet === 'mainnet' || rawNet === 'mainnet-beta') {
    warn('ECONOMY_NETWORK=mainnet is refused. Mainnet stays off until every item in the "Legal checklist before mainnet" section of docs/economy.md is done. Running with the chain off.');
  } else if (rawNet === 'devnet') {
    network = 'devnet';
  } else if (rawNet && rawNet !== 'off') {
    warn(`ECONOMY_NETWORK=${rawNet.slice(0, 20)} is not one of off | devnet. Running with the chain off.`);
  }

  let devnet: DevnetConfig | null = null;
  if (network === 'devnet') {
    const rpcUrl = str(env, 'SOLANA_RPC_URL') || DEFAULT_DEVNET_RPC;
    const keypairPath = str(env, 'ECONOMY_KEYPAIR_PATH');
    const treasury = str(env, 'TREASURY_ADDRESS', 64);
    const usdcMint = str(env, 'USDC_MINT', 64);
    const collection = str(env, 'CORE_COLLECTION', 64);
    const metadataBaseUrl = str(env, 'NFT_METADATA_BASE_URL').replace(/\/+$/, '');
    const bad: string[] = [];
    try {
      const u = new URL(rpcUrl);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') bad.push('SOLANA_RPC_URL must be an http(s) URL');
      if (/mainnet/i.test(u.hostname)) bad.push('SOLANA_RPC_URL looks like a mainnet endpoint');
    } catch {
      bad.push('SOLANA_RPC_URL is not a URL');
    }
    if (!keypairPath) bad.push('ECONOMY_KEYPAIR_PATH is not set');
    else if (isInside(keypairPath, process.cwd())) bad.push('ECONOMY_KEYPAIR_PATH points inside the project folder; keep the keypair outside the repo');
    if (!isSolanaAddress(treasury)) bad.push('TREASURY_ADDRESS is missing or not a Solana address');
    if (!isSolanaAddress(usdcMint)) bad.push('USDC_MINT is missing or not a Solana address');
    if (!isSolanaAddress(collection)) bad.push('CORE_COLLECTION is missing or not a Solana address');
    if (metadataBaseUrl && !/^https:\/\//.test(metadataBaseUrl)) bad.push('NFT_METADATA_BASE_URL must start with https://');
    if (bad.length) warn(`devnet store disabled: ${bad.join('; ')}. Limited items cannot be bought until this is fixed (docs/economy.md, "Devnet setup").`);
    else devnet = { rpcUrl, keypairPath: resolve(keypairPath), treasury, usdcMint, collection, metadataBaseUrl };
  }
  return { enabled, dataDir, domain, network, devnet, problems };
}
