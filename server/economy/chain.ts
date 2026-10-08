// The chain behind Limited items. The economy service only ever talks to ChainAdapter:
//   MockChain     in memory and deterministic: tests, and servers with ECONOMY_NETWORK=off (purchases refused there)
//   SolanaDevnet  ./solanaDevnet.ts, loaded with dynamic import() only when ECONOMY_NETWORK=devnet
import { base58Decode, base58Encode } from '../../shared/economy.ts';
import { bytesEqual, ed25519FromSeed, joinWireTx, requiredSigners, sha256Hex, splitWireTx, verifyEd25519 } from './crypto.ts';

export interface UsdcOrderSpec {
  orderId: string;
  /** the player's linked wallet (base58): it signs the USDC transfer and receives the NFT */
  payer: string;
  /** price in whole US cents, from the catalog */
  cents: number;
}

export interface BuiltTransfer {
  /** serialized transaction, partially signed by the fee payer */
  tx: Uint8Array;
  /** the exact message bytes the wallet must sign unchanged */
  message: Uint8Array;
  /** epoch ms after which the transaction can no longer land */
  expires: number;
  /** adapter data kept with the order (blockhash, fee payer signature, amounts) */
  meta: string;
}

export interface StoredTransfer extends UsdcOrderSpec {
  message: Uint8Array;
  meta: string;
}

export type PaymentResult =
  | { status: 'paid'; signature: string }
  | { status: 'pending'; signature?: string }
  | { status: 'failed'; code: string; reason: string };

export interface MintSpec {
  orderId: string;
  owner: string;
  /** "Hook Wars: <item> #n/N" */
  name: string;
  uri: string;
  serial: number;
  supply: number;
  item: string;
}

export interface ChainAdapter {
  readonly network: 'off' | 'devnet';
  /** false: USDC purchases are refused with a clear message */
  readonly purchases: boolean;
  /** resolves when the adapter can be used; rejects with a ChainError when it cannot */
  ready(): Promise<void>;
  buildUsdcTransfer(spec: UsdcOrderSpec): Promise<BuiltTransfer>;
  /**
   * Check the wallet-signed bytes against the stored order, submit, confirm and verify on chain.
   * onSent runs with the transaction signature before the transaction is sent, so the caller can
   * persist it and recover after a crash.
   */
  submitUsdcTransfer(order: StoredTransfer, signedTx: Uint8Array, onSent: (signature: string) => void): Promise<PaymentResult>;
  /** Look a submitted payment up again (recovery after a restart or a confirmation timeout). */
  checkUsdcPayment(order: StoredTransfer, signature: string): Promise<PaymentResult>;
  /** Mint the Limited item. Idempotent per orderId: a retry never mints a second asset. */
  mintLimited(spec: MintSpec): Promise<{ asset: string }>;
  close(): void;
}

export class ChainError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ChainError';
  }
}

/**
 * The wallet must return the exact message the server built, signed by the linked wallet.
 * Returns the final wire bytes with the fee payer's signature in place.
 */
export function checkSignedTransfer(order: StoredTransfer, signedTx: Uint8Array, feePayerSig: Uint8Array): Uint8Array {
  const wire = splitWireTx(signedTx);
  if (!wire) throw new ChainError('bad_tx', 'The wallet returned something that is not a transaction. Nothing was charged.');
  if (!bytesEqual(wire.message, order.message)) {
    throw new ChainError('tx_modified', 'Your wallet changed the transaction before signing it, so the server cannot accept it. Nothing was charged.');
  }
  const signers = requiredSigners(wire.message);
  const payer = base58Decode(order.payer);
  if (!signers || !payer || signers.length !== wire.signatures.length) throw new ChainError('bad_tx', 'The transaction has the wrong signatures. Nothing was charged.');
  const payerAt = signers.findIndex((k) => bytesEqual(k, payer));
  if (payerAt <= 0) throw new ChainError('bad_tx', 'The transaction is not paid by your linked wallet. Nothing was charged.');
  wire.signatures[0] = feePayerSig; // our own signature, whatever the wallet put in slot 0
  for (let i = 0; i < signers.length; i++) {
    if (!verifyEd25519(signers[i], wire.message, wire.signatures[i])) {
      throw new ChainError(i === payerAt ? 'not_signed' : 'bad_tx', i === payerAt ? 'Your wallet did not sign the payment. Nothing was charged.' : 'The transaction signatures do not check out. Nothing was charged.');
    }
  }
  return joinWireTx(wire);
}

// ---------------------------------------------------------------------------------------------
// MockChain
// ---------------------------------------------------------------------------------------------

export interface MockChainOptions {
  /** default true; false = the stand-in used when ECONOMY_NETWORK=off, which refuses purchases */
  purchases?: boolean;
  now?: () => number;
}

interface MockPayment {
  orderId: string;
  payer: string;
  cents: number;
}

/**
 * In-memory chain with the real signing rules: the "transaction" uses the Solana wire framing and a
 * message whose header names the fee payer and the player's wallet as signers, so the wallet-side
 * signing and every server check run exactly as on devnet. Deterministic: same inputs, same bytes.
 */
export class MockChain implements ChainAdapter {
  readonly network = 'off' as const;
  readonly purchases: boolean;
  /** cents held by each wallet; a wallet that was never funded has unlimited test money */
  readonly balances = new Map<string, number>();
  readonly payments = new Map<string, MockPayment>(); // by transaction signature
  readonly assets = new Map<string, { asset: string; owner: string; name: string; serial: number }>(); // by order id
  /** how many mint calls created a new asset (idempotency checks in tests) */
  mintCount = 0;
  private readonly feePayer = ed25519FromSeed(Buffer.from(sha256Hex('hookwars-mockchain-fee-payer'), 'hex'));
  private readonly now: () => number;

  constructor(opts: MockChainOptions = {}) {
    this.purchases = opts.purchases ?? true;
    this.now = opts.now ?? Date.now;
  }

  get feePayerAddress(): string {
    return base58Encode(this.feePayer.publicKey);
  }

  async ready(): Promise<void> {
    if (!this.purchases) throw new ChainError('network_off', 'Limited items are not sold on this server (its chain is switched off).');
  }

  async buildUsdcTransfer(spec: UsdcOrderSpec): Promise<BuiltTransfer> {
    await this.ready();
    const payer = base58Decode(spec.payer);
    if (!payer || payer.length !== 32) throw new ChainError('bad_wallet', 'Your linked wallet address is not valid.');
    const bal = this.balances.get(spec.payer);
    if (bal !== undefined && bal < spec.cents) throw new ChainError('insufficient_usdc', 'Your wallet does not have enough devnet USDC for this item.');
    // legacy header: 2 signers (fee payer, player), 0 read-only signed, 1 read-only unsigned (the "program")
    const memo = new TextEncoder().encode(`mock-usdc-transfer|${spec.orderId}|${spec.cents}`);
    const blockhash = Buffer.from(sha256Hex(`blockhash|${spec.orderId}`), 'hex');
    const message = new Uint8Array([2, 0, 1, 3, ...this.feePayer.publicKey, ...payer, ...new Uint8Array(32).fill(7), ...blockhash, ...memo]);
    const feeSig = this.feePayer.sign(message);
    const tx = joinWireTx({ signatures: [feeSig, new Uint8Array(64)], message });
    return { tx, message, expires: this.now() + 75_000, meta: JSON.stringify({ feeSig: Buffer.from(feeSig).toString('base64'), expires: this.now() + 75_000 }) };
  }

  async submitUsdcTransfer(order: StoredTransfer, signedTx: Uint8Array, onSent: (signature: string) => void): Promise<PaymentResult> {
    await this.ready();
    const meta = JSON.parse(order.meta) as { feeSig: string; expires: number };
    if (this.now() > meta.expires) throw new ChainError('expired', 'The payment took too long and expired. Nothing was charged. Press Buy again.');
    const raw = checkSignedTransfer(order, signedTx, new Uint8Array(Buffer.from(meta.feeSig, 'base64')));
    const signature = base58Encode(splitWireTx(raw)!.signatures[0]);
    if (this.payments.has(signature)) return { status: 'paid', signature }; // the same bytes again: already landed
    const bal = this.balances.get(order.payer);
    if (bal !== undefined && bal < order.cents) throw new ChainError('insufficient_usdc', 'Your wallet does not have enough devnet USDC for this item. Nothing was charged.');
    onSent(signature);
    if (bal !== undefined) this.balances.set(order.payer, bal - order.cents);
    this.payments.set(signature, { orderId: order.orderId, payer: order.payer, cents: order.cents });
    return { status: 'paid', signature };
  }

  async checkUsdcPayment(order: StoredTransfer, signature: string): Promise<PaymentResult> {
    const p = this.payments.get(signature);
    if (p && p.orderId === order.orderId && p.cents === order.cents && p.payer === order.payer) return { status: 'paid', signature };
    return { status: 'failed', code: 'not_found', reason: 'No payment with that signature.' };
  }

  async mintLimited(spec: MintSpec): Promise<{ asset: string }> {
    const had = this.assets.get(spec.orderId);
    if (had) return { asset: had.asset };
    const asset = base58Encode(Buffer.from(sha256Hex(`mock-asset|${spec.orderId}`), 'hex'));
    this.assets.set(spec.orderId, { asset, owner: spec.owner, name: spec.name, serial: spec.serial });
    this.mintCount++;
    return { asset };
  }

  close(): void {}
}
