// Small helpers on node:crypto: auth tokens, record ids and token hashes.
import { createHash, randomBytes } from 'node:crypto';

/** Shape of every token this server issues: 32 random bytes in base64url (43 characters). */
export const ISSUED_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function randomToken(): string {
  return randomBytes(32).toString('base64url'); // 43 characters, matches TOKEN_RE in shared/protocol.ts
}

/** Random id like `acc_Xy3...` (16 base64url characters after the prefix), matches the id rules in shared/economy.ts. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

export function sha256Hex(s: string | Uint8Array): string {
  return createHash('sha256').update(s).digest('hex');
}
