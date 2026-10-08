// SolanaDevnet: the real ChainAdapter, on Solana devnet only.
//
// Loaded by ./index.ts with a dynamic import() when ECONOMY_NETWORK=devnet, and this file loads the
// Solana packages the same way (only type imports at the top), so a server with the chain off
// never loads @solana/web3.js, @solana/spl-token, umi or mpl-core at all.
//
// Packages: @solana/web3.js 1.99 (connection, legacy transactions), @solana/spl-token 0.4.15
// (USDC transfer), @metaplex-foundation/umi 1.6 + umi-bundle-defaults + mpl-core 1.10 (Core NFTs).
//
// The flow (docs/economy.md, "Buying a Limited item"):
//   build   transferChecked(player USDC account -> treasury USDC account, exact price) + Memo(order id),
//           fee payer = this server's key, which partially signs. Returned to the client unsent.
//   submit  the wallet signs with solana:signTransaction and hands the bytes back; the server checks
//           the message is byte-for-byte the one it built, adds nothing, sends it, confirms it.
//   verify  read the confirmed transaction back and check mint, source, destination, authority,
//           amount and memo.
//   mint    a Metaplex Core asset in CORE_COLLECTION owned by the player's wallet. The asset key is
//           derived from (server key, order id), so a retry finds the asset instead of minting twice.
import { readFileSync } from 'node:fs';
import type * as Web3 from '@solana/web3.js';
import type * as Spl from '@solana/spl-token';
import type * as Umi from '@metaplex-foundation/umi';
import type * as Core from '@metaplex-foundation/mpl-core';
import { base58Encode } from '../../shared/economy.ts';
import { ChainError, checkSignedTransfer, type BuiltTransfer, type ChainAdapter, type MintSpec, type PaymentResult, type StoredTransfer, type UsdcOrderSpec } from './chain.ts';
import type { DevnetConfig } from './config.ts';
import { ed25519FromSeed, hmacSha256, splitWireTx } from './crypto.ts';

/** Devnet's genesis hash (read from api.devnet.solana.com with getGenesisHash on 2026-10-08). */
export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
/**
 * SPL Memo program v2. Not exported by any installed package, so it was checked on devnet on
 * 2026-10-08: getAccountInfo returns an executable account owned by BPFLoader2111...
 */
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
/** USDC has 6 decimals: one cent is 10 000 base units. */
const UNITS_PER_CENT = 10_000n;
const USDC_DECIMALS = 6;
/** About 150 blocks at ~0.4 s: how long a fresh blockhash stays valid, minus a safety margin. */
const ORDER_LIFETIME_MS = 60_000;
const CONFIRM_TIMEOUT_MS = 45_000;
const MIN_FEE_PAYER_LAMPORTS = 10_000_000; // 0.01 SOL

export function memoText(orderId: string): string {
  return `hookwars:order:${orderId}`;
}

interface OrderMeta {
  blockhash: string;
  lastValidBlockHeight: number;
  amount: string; // base units
  payerAta: string;
  treasuryAta: string;
  memo: string;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<'timeout'>((r) => (t = setTimeout(() => r('timeout'), ms)))]).finally(() => clearTimeout(t));
}

/** Read a solana-keygen JSON keypair (an array of 64 numbers). Never logs the contents. */
export function readKeypairFile(path: string): Uint8Array {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ChainError('chain_setup', `ECONOMY_KEYPAIR_PATH (${path}) could not be read as a solana-keygen JSON file.`);
  }
  if (!Array.isArray(raw) || raw.length !== 64 || !raw.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    throw new ChainError('chain_setup', `ECONOMY_KEYPAIR_PATH (${path}) is not a 64-byte solana-keygen keypair.`);
  }
  return Uint8Array.from(raw as number[]);
}

export class SolanaDevnet implements ChainAdapter {
  readonly network = 'devnet' as const;
  readonly purchases = true;
  private readonly cfg: DevnetConfig;
  private readonly log: (s: string) => void;
  private readonly secret: Uint8Array;
  private readonly signer: { publicKey: Uint8Array; sign: (msg: Uint8Array) => Uint8Array };
  private readonly web3: typeof Web3;
  private readonly spl: typeof Spl;
  private readonly umiLib: typeof Umi;
  private readonly core: typeof Core;
  private readonly conn: Web3.Connection;
  private readonly feePayer: Web3.Keypair;
  private readonly mint: Web3.PublicKey;
  private readonly treasury: Web3.PublicKey;
  private readonly treasuryAta: Web3.PublicKey;
  private readonly memoProgram: Web3.PublicKey;
  private readonly umi: Umi.Umi;
  private collection: Core.CollectionV1 | null = null;
  private readyP: Promise<void> | null = null;
  private readyFailedAt = 0;

  constructor(cfg: DevnetConfig, log: (s: string) => void, libs: { web3: typeof Web3; spl: typeof Spl; umi: typeof Umi; core: typeof Core; createUmi: (url: string) => Umi.Umi }) {
    this.cfg = cfg;
    this.log = log;
    this.web3 = libs.web3;
    this.spl = libs.spl;
    this.umiLib = libs.umi;
    this.core = libs.core;
    this.secret = readKeypairFile(cfg.keypairPath);
    this.signer = ed25519FromSeed(this.secret.slice(0, 32));
    this.feePayer = this.web3.Keypair.fromSecretKey(this.secret);
    if (base58Encode(this.signer.publicKey) !== this.feePayer.publicKey.toBase58()) throw new ChainError('chain_setup', 'ECONOMY_KEYPAIR_PATH: the public half of the keypair does not match its secret.');
    this.conn = new this.web3.Connection(cfg.rpcUrl, 'confirmed');
    this.mint = new this.web3.PublicKey(cfg.usdcMint);
    this.treasury = new this.web3.PublicKey(cfg.treasury);
    this.treasuryAta = this.spl.getAssociatedTokenAddressSync(this.mint, this.treasury, true);
    this.memoProgram = new this.web3.PublicKey(MEMO_PROGRAM_ID);
    this.umi = libs.createUmi(cfg.rpcUrl).use(this.core.mplCore());
    this.umi.use(this.umiLib.keypairIdentity(this.umi.eddsa.createKeypairFromSecretKey(this.secret)));
    log(`[economy] devnet adapter: fee payer and mint authority ${this.feePayer.publicKey.toBase58()}, treasury ${cfg.treasury}, collection ${cfg.collection}`);
  }

  /** Check the whole devnet setup once (and again 30 s after a failure). */
  ready(): Promise<void> {
    if (this.readyP) return this.readyP;
    if (Date.now() - this.readyFailedAt < 30_000) return Promise.reject(new ChainError('chain_setup', 'The server\'s Solana devnet setup is not ready yet (see the server log). Nothing was charged.'));
    this.readyP = this.checkSetup().catch((err: unknown) => {
      this.readyP = null;
      this.readyFailedAt = Date.now();
      const msg = err instanceof ChainError ? err.message : `devnet RPC error: ${(err as Error).message}`;
      this.log(`[economy] devnet setup check failed: ${msg}`);
      throw new ChainError('chain_setup', 'Limited items cannot be bought right now: the server\'s Solana devnet setup is not ready. Nothing was charged.');
    });
    return this.readyP;
  }

  private async checkSetup(): Promise<void> {
    const genesis = await this.conn.getGenesisHash();
    if (genesis !== DEVNET_GENESIS_HASH) throw new ChainError('chain_setup', `SOLANA_RPC_URL is not a devnet endpoint (genesis ${genesis}). Mainnet stays off.`);
    const lamports = await this.conn.getBalance(this.feePayer.publicKey, 'confirmed');
    if (lamports < MIN_FEE_PAYER_LAMPORTS) {
      throw new ChainError('chain_setup', `the fee payer ${this.feePayer.publicKey.toBase58()} has ${lamports / 1e9} SOL; airdrop devnet SOL to it (docs/economy.md, "Devnet setup").`);
    }
    const mintInfo = await this.spl.getMint(this.conn, this.mint, 'confirmed');
    if (mintInfo.decimals !== USDC_DECIMALS) throw new ChainError('chain_setup', `USDC_MINT has ${mintInfo.decimals} decimals, expected ${USDC_DECIMALS}.`);
    try {
      const acc = await this.spl.getAccount(this.conn, this.treasuryAta, 'confirmed');
      if (!acc.mint.equals(this.mint) || !acc.owner.equals(this.treasury)) throw new Error('wrong owner or mint');
    } catch {
      throw new ChainError('chain_setup', `the treasury has no USDC token account (${this.treasuryAta.toBase58()}); run the setup script in docs/economy.md, "Devnet setup".`);
    }
    const col = await this.core.fetchCollection(this.umi, this.cfg.collection);
    if (String(col.updateAuthority) !== this.feePayer.publicKey.toBase58()) {
      throw new ChainError('chain_setup', `CORE_COLLECTION's update authority is ${String(col.updateAuthority)}, not this server's key, so it cannot mint into it.`);
    }
    this.collection = col;
  }

  private meta(order: StoredTransfer): OrderMeta {
    return JSON.parse(order.meta) as OrderMeta;
  }

  async buildUsdcTransfer(spec: UsdcOrderSpec): Promise<BuiltTransfer> {
    await this.ready();
    const { web3, spl } = this;
    let payer: Web3.PublicKey;
    try {
      payer = new web3.PublicKey(spec.payer);
    } catch {
      throw new ChainError('bad_wallet', 'Your linked wallet address is not valid.');
    }
    const payerAta = spl.getAssociatedTokenAddressSync(this.mint, payer, false);
    const amount = BigInt(spec.cents) * UNITS_PER_CENT;
    let balance: bigint;
    try {
      balance = (await spl.getAccount(this.conn, payerAta, 'confirmed')).amount;
    } catch (err) {
      if (err instanceof spl.TokenAccountNotFoundError) throw new ChainError('no_usdc', 'Your wallet has no devnet USDC yet. Get some from the devnet USDC faucet, then try again.');
      throw err;
    }
    if (balance < amount) throw new ChainError('insufficient_usdc', `Your wallet has ${Number(balance) / 1e6} devnet USDC; this item costs ${spec.cents / 100}.`);
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash('confirmed');
    const memo = memoText(spec.orderId);
    const tx = new web3.Transaction({ feePayer: this.feePayer.publicKey, blockhash, lastValidBlockHeight });
    tx.add(spl.createTransferCheckedInstruction(payerAta, this.mint, this.treasuryAta, payer, amount, USDC_DECIMALS));
    tx.add(new web3.TransactionInstruction({ programId: this.memoProgram, keys: [], data: Buffer.from(memo, 'utf8') }));
    tx.partialSign(this.feePayer);
    const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const message = tx.serializeMessage();
    const meta: OrderMeta = { blockhash, lastValidBlockHeight, amount: amount.toString(), payerAta: payerAta.toBase58(), treasuryAta: this.treasuryAta.toBase58(), memo };
    return { tx: new Uint8Array(wire), message: new Uint8Array(message), expires: Date.now() + ORDER_LIFETIME_MS, meta: JSON.stringify(meta) };
  }

  async submitUsdcTransfer(order: StoredTransfer, signedTx: Uint8Array, onSent: (signature: string) => void): Promise<PaymentResult> {
    await this.ready();
    const meta = this.meta(order);
    const height = await this.conn.getBlockHeight('confirmed');
    if (height > meta.lastValidBlockHeight) throw new ChainError('expired', 'The payment took too long and expired. Nothing was charged. Press Buy again.');
    // our own signature over the exact message (Ed25519 is deterministic: the same bytes as at build)
    const raw = checkSignedTransfer(order, signedTx, this.signer.sign(order.message));
    const signature = base58Encode(splitWireTx(raw)!.signatures[0]);
    onSent(signature);
    try {
      await this.conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 5 });
    } catch (err) {
      // preflight simulation failed: nothing landed
      const logs = (err as { logs?: string[] }).logs?.slice(-3).join(' | ') ?? '';
      this.log(`[economy] order ${order.orderId} rejected by preflight: ${(err as Error).message} ${logs}`);
      throw new ChainError('rejected', 'The Solana network rejected the payment (check your devnet USDC and try again). Nothing was charged.');
    }
    const confirmed = await withTimeout(
      this.conn.confirmTransaction({ signature, blockhash: meta.blockhash, lastValidBlockHeight: meta.lastValidBlockHeight }, 'confirmed').catch((err: unknown) => err as Error),
      CONFIRM_TIMEOUT_MS,
    );
    if (confirmed === 'timeout') return { status: 'pending', signature };
    if (confirmed instanceof Error) return this.checkUsdcPayment(order, signature); // expiry or RPC trouble: ask the chain
    if (confirmed.value.err) return { status: 'failed', code: 'tx_failed', reason: 'the transaction failed on chain' };
    return this.checkUsdcPayment(order, signature);
  }

  async checkUsdcPayment(order: StoredTransfer, signature: string): Promise<PaymentResult> {
    const meta = this.meta(order);
    const tx = await this.conn.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!tx) {
      const st = await this.conn.getSignatureStatus(signature, { searchTransactionHistory: true });
      if (st.value?.err) return { status: 'failed', code: 'tx_failed', reason: 'the transaction failed on chain' };
      if (st.value) return { status: 'pending', signature }; // seen but not readable yet
      const height = await this.conn.getBlockHeight('confirmed');
      return height > meta.lastValidBlockHeight ? { status: 'failed', code: 'expired', reason: 'the payment never reached the chain and has expired' } : { status: 'pending', signature };
    }
    if (tx.meta?.err) return { status: 'failed', code: 'tx_failed', reason: 'the transaction failed on chain' };
    // Read it back: exactly one USDC transferChecked from the player's account to the treasury, and our memo.
    let transferOk = false;
    let memoOk = false;
    for (const ix of tx.transaction.message.instructions) {
      if (!('parsed' in ix)) continue;
      const p = ix.parsed as { type?: string; info?: Record<string, unknown> } | string;
      if (ix.programId.toBase58() === MEMO_PROGRAM_ID) {
        if (p === meta.memo) memoOk = true;
        continue;
      }
      if (ix.program === 'spl-token' && typeof p === 'object' && p.type === 'transferChecked' && p.info) {
        const info = p.info;
        const amt = (info.tokenAmount as { amount?: string } | undefined)?.amount;
        transferOk =
          info.mint === this.cfg.usdcMint &&
          info.source === meta.payerAta &&
          info.destination === meta.treasuryAta &&
          info.authority === order.payer &&
          amt === meta.amount;
      }
    }
    if (!transferOk || !memoOk) {
      this.log(`[economy] order ${order.orderId}: transaction ${signature} does not match the order (transfer ${transferOk}, memo ${memoOk}).`);
      return { status: 'failed', code: 'mismatch', reason: 'the transaction on chain does not match the order' };
    }
    return { status: 'paid', signature };
  }

  async mintLimited(spec: MintSpec): Promise<{ asset: string }> {
    await this.ready();
    const { umi, umiLib, core } = this;
    // deterministic per order: a retry after a crash or timeout finds the asset instead of minting a second one
    const seed = hmacSha256(this.secret.slice(0, 32), `hookwars-core-asset|${spec.orderId}`);
    const assetSigner = umiLib.createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSeed(seed));
    const asset = String(assetSigner.publicKey);
    const existing = await core.safeFetchAssetV1(umi, assetSigner.publicKey);
    if (existing) return { asset };
    const collection = this.collection ?? (this.collection = await core.fetchCollection(umi, this.cfg.collection));
    await core
      .create(umi, {
        asset: assetSigner,
        collection,
        name: spec.name, // "Hook Wars: <item> #n/N"; Core stores a length-prefixed string (no 32-character cap as in Token Metadata)
        uri: spec.uri,
        owner: umiLib.publicKey(spec.owner),
        plugins: [
          {
            type: 'Attributes',
            attributeList: [
              { key: 'item', value: spec.item },
              { key: 'serial', value: String(spec.serial) },
              { key: 'supply', value: String(spec.supply) },
            ],
          },
        ],
      })
      .sendAndConfirm(umi, { send: { commitment: 'confirmed' }, confirm: { commitment: 'confirmed' } });
    return { asset };
  }

  close(): void {}
}

export async function createSolanaDevnet(cfg: DevnetConfig, log: (s: string) => void): Promise<SolanaDevnet> {
  const [web3, spl, umi, bundle, core] = await Promise.all([
    import('@solana/web3.js'),
    import('@solana/spl-token'),
    import('@metaplex-foundation/umi'),
    import('@metaplex-foundation/umi-bundle-defaults'),
    import('@metaplex-foundation/mpl-core'),
  ]);
  return new SolanaDevnet(cfg, log, { web3, spl, umi, core, createUmi: (url) => bundle.createUmi(url) });
}
