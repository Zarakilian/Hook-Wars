// Solana wallets through the Wallet Standard: discovery plus the three calls the economy needs.
//
// @wallet-standard/app is loaded with a dynamic import() the first time wallets are looked for, so
// it is a small separate chunk. Feature names are plain strings (no runtime import from
// @solana/wallet-standard-features). The client never builds a transaction itself and never ships
// @solana/web3.js: the server builds the transaction bytes, the wallet only signs them.
//
// Why solana:signTransaction and not solana:signAndSendTransaction: the server's key pays the
// network fee and has already signed the transaction. A wallet that sends the transaction itself
// may add instructions first (priority fees, safety checks), which changes the message and breaks
// the server's signature. Signing and handing the bytes back keeps the message exactly as built,
// and the server sends and confirms it on its own RPC.

export const SOLANA_CHAIN = 'solana:devnet';
const F_CONNECT = 'standard:connect';
const F_SIGN_MESSAGE = 'solana:signMessage';
const F_SIGN_TX = 'solana:signTransaction';

/** The parts of a Wallet Standard account this module uses. */
export interface WalletAccountLike {
  readonly address: string;
  readonly publicKey: Uint8Array;
  readonly chains: readonly string[];
}

/** The parts of a Wallet Standard wallet this module uses. */
export interface WalletLike {
  readonly name: string;
  readonly chains: readonly string[];
  readonly features: Readonly<Record<string, unknown>>;
  readonly accounts: readonly WalletAccountLike[];
}

interface ConnectFeature {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccountLike[] }>;
}
interface SignMessageFeature {
  signMessage(...inputs: { account: WalletAccountLike; message: Uint8Array }[]): Promise<readonly { signedMessage: Uint8Array; signature: Uint8Array }[]>;
}
interface SignTxFeature {
  supportedTransactionVersions?: readonly ('legacy' | 0 | 1)[];
  signTransaction(...inputs: { account: WalletAccountLike; transaction: Uint8Array; chain?: string }[]): Promise<readonly { signedTransaction: Uint8Array }[]>;
}

function feature<T>(w: WalletLike, name: string): T | null {
  const f = w.features[name];
  return typeof f === 'object' && f !== null ? (f as T) : null;
}

/** Can this wallet link an account and pay for a Limited item on devnet? */
export function isSuitableWallet(w: WalletLike): boolean {
  const tx = feature<SignTxFeature>(w, F_SIGN_TX);
  const versions = tx?.supportedTransactionVersions;
  return (
    Array.isArray(w.chains) &&
    w.chains.includes(SOLANA_CHAIN) &&
    typeof feature<ConnectFeature>(w, F_CONNECT)?.connect === 'function' &&
    typeof feature<SignMessageFeature>(w, F_SIGN_MESSAGE)?.signMessage === 'function' &&
    typeof tx?.signTransaction === 'function' &&
    (!versions || versions.includes('legacy')) // the server builds legacy transactions
  );
}

/** Turn wallet errors into something a player understands. */
function friendly(err: unknown, what: string): Error {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (/reject|denied|declin|cancel|closed/i.test(msg)) return new Error(`You cancelled ${what} in your wallet. Nothing was charged.`);
  return new Error(`Your wallet could not finish ${what}${msg ? `: ${msg.slice(0, 120)}` : '.'}`);
}

let watching = false;
let current: WalletLike[] = [];
const listeners = new Set<(wallets: readonly WalletLike[]) => void>();

/** Start looking for wallets (once) and report the suitable ones now and whenever one registers. */
export function watchWallets(cb: (wallets: readonly WalletLike[]) => void): () => void {
  listeners.add(cb);
  cb(current);
  if (!watching && typeof window !== 'undefined') {
    watching = true;
    import('@wallet-standard/app')
      .then(({ getWallets }) => {
        const api = getWallets();
        const refresh = () => {
          current = (api.get() as unknown as readonly WalletLike[]).filter(isSuitableWallet);
          for (const l of listeners) l(current);
        };
        refresh();
        api.on('register', refresh);
        api.on('unregister', refresh);
      })
      .catch(() => {
        // no wallet discovery in this browser: walletAvailable stays false
      });
  }
  return () => listeners.delete(cb);
}

/** Ask the wallet for an account, preferring `prefer` (the address already linked to this game account). */
export async function connectWallet(w: WalletLike, prefer?: string | null): Promise<WalletAccountLike> {
  let accounts: readonly WalletAccountLike[];
  try {
    accounts = (await feature<ConnectFeature>(w, F_CONNECT)!.connect()).accounts;
  } catch (err) {
    throw friendly(err, 'connecting');
  }
  const usable = accounts.filter((a) => !a.chains?.length || a.chains.includes(SOLANA_CHAIN));
  if (!usable.length) throw new Error(`${w.name} did not share a Solana devnet account.`);
  if (prefer) {
    const match = usable.find((a) => a.address === prefer);
    if (!match) throw new Error(`Switch ${w.name} to the wallet linked to this account (${prefer.slice(0, 4)}...${prefer.slice(-4)}), then try again.`);
    return match;
  }
  return usable[0];
}

/** Sign the exact message bytes. A wallet that changes the message is refused (the server checks the exact text). */
export async function signMessage(w: WalletLike, account: WalletAccountLike, message: Uint8Array): Promise<Uint8Array> {
  let out: readonly { signedMessage: Uint8Array; signature: Uint8Array }[];
  try {
    out = await feature<SignMessageFeature>(w, F_SIGN_MESSAGE)!.signMessage({ account, message });
  } catch (err) {
    throw friendly(err, 'the sign-in');
  }
  const first = out[0];
  if (!first || first.signature.length !== 64) throw new Error(`${w.name} returned no signature.`);
  const signed = first.signedMessage;
  if (signed && (signed.length !== message.length || signed.some((b, i) => b !== message[i]))) {
    throw new Error(`${w.name} changed the sign-in message before signing it, so it cannot be checked. Try another wallet.`);
  }
  return first.signature;
}

/** Sign the server-built transaction and hand the bytes back (the server sends it). */
export async function signTransaction(w: WalletLike, account: WalletAccountLike, tx: Uint8Array): Promise<Uint8Array> {
  let out: readonly { signedTransaction: Uint8Array }[];
  try {
    out = await feature<SignTxFeature>(w, F_SIGN_TX)!.signTransaction({ account, transaction: tx, chain: SOLANA_CHAIN });
  } catch (err) {
    throw friendly(err, 'the payment');
  }
  const signed = out[0]?.signedTransaction;
  if (!signed || signed.length < 100) throw new Error(`${w.name} returned no signed transaction.`);
  return signed;
}
