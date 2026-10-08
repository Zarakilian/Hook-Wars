// Small crypto helpers on node:crypto only: tokens, ids, Ed25519 verify/sign with raw 32-byte keys,
// and the Solana transaction wire format (signatures + message) so the server can check that a
// wallet signed exactly the message it was given.
import { createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto';

/** DER prefix that wraps a raw 32-byte Ed25519 public key as SubjectPublicKeyInfo. */
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
/** DER prefix that wraps a raw 32-byte Ed25519 seed as PKCS#8. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function randomToken(): string {
  return randomBytes(32).toString('base64url'); // 43 characters, matches TOKEN_RE in shared/protocol.ts
}

/** Random id like `acc_Xy3...` (16 base64url characters after the prefix), matches the id rule in shared/economy.ts. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

export function sha256Hex(s: string | Uint8Array): string {
  return createHash('sha256').update(s).digest('hex');
}

export function hmacSha256(key: Uint8Array, data: string): Uint8Array {
  return new Uint8Array(createHmac('sha256', key).update(data).digest());
}

export function ed25519PublicKey(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new Error('an Ed25519 public key is 32 bytes');
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** Verify an Ed25519 signature over the exact bytes. False for any malformed input, never throws. */
export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    return verify(null, message, ed25519PublicKey(publicKey), signature);
  } catch {
    return false;
  }
}

/** An Ed25519 key pair from a 32-byte seed, with the raw public key. Used by MockChain and tests. */
export function ed25519FromSeed(seed: Uint8Array): { publicKey: Uint8Array; sign: (msg: Uint8Array) => Uint8Array } {
  if (seed.length !== 32) throw new Error('an Ed25519 seed is 32 bytes');
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  return { publicKey: new Uint8Array(spki.subarray(spki.length - 32)), sign: (msg) => new Uint8Array(sign(null, msg, priv)) };
}

// ---------------------------------------------------------------------------------------------
// Solana wire format: shortvec(signature count) + 64-byte signatures + message bytes.
// The message starts with the header; v0 messages set the top bit of the first byte.
// ---------------------------------------------------------------------------------------------

function readShortVec(b: Uint8Array, at: number): { value: number; next: number } | null {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    if (at + i >= b.length) return null;
    const byte = b[at + i];
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return { value, next: at + i + 1 };
  }
  return null;
}

function writeShortVec(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    let byte = v & 0x7f;
    v >>= 7;
    if (v) byte |= 0x80;
    out.push(byte);
    if (!v) return out;
  }
}

export interface WireTx {
  signatures: Uint8Array[];
  message: Uint8Array;
}

/** Split serialized transaction bytes into signatures and message. Null if the framing is off. */
export function splitWireTx(bytes: Uint8Array): WireTx | null {
  const n = readShortVec(bytes, 0);
  if (!n || n.value < 1 || n.value > 16) return null;
  const msgAt = n.next + 64 * n.value;
  if (bytes.length <= msgAt) return null;
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < n.value; i++) signatures.push(bytes.slice(n.next + 64 * i, n.next + 64 * (i + 1)));
  return { signatures, message: bytes.slice(msgAt) };
}

export function joinWireTx(tx: WireTx): Uint8Array {
  const head = writeShortVec(tx.signatures.length);
  const out = new Uint8Array(head.length + 64 * tx.signatures.length + tx.message.length);
  out.set(head, 0);
  tx.signatures.forEach((s, i) => out.set(s, head.length + 64 * i));
  out.set(tx.message, head.length + 64 * tx.signatures.length);
  return out;
}

/** The public keys that must sign a Solana message (legacy or v0), in signature order. */
export function requiredSigners(message: Uint8Array): Uint8Array[] | null {
  let at = 0;
  if (message.length < 4) return null;
  if (message[0] & 0x80) {
    if ((message[0] & 0x7f) !== 0) return null; // only v0 exists
    at = 1;
  }
  const numRequired = message[at];
  const keys = readShortVec(message, at + 3);
  if (!keys || numRequired < 1 || numRequired > keys.value) return null;
  const out: Uint8Array[] = [];
  for (let i = 0; i < numRequired; i++) {
    const s = keys.next + 32 * i;
    if (s + 32 > message.length) return null;
    out.push(message.slice(s, s + 32));
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
