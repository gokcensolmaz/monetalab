/**
 * Opaque session tokens (slice 3 plan §4.2).
 * - A token is 32 bytes from crypto.randomBytes (CSPRNG), sent to the client as canonical base64url (43 characters).
 * - Only SHA-256(token) is stored (32 bytes, matching the sessions.token_hash CHECK). The raw token is never persisted or logged.
 */
import { createHash, randomBytes } from 'node:crypto';

export const SESSION_TOKEN_BYTES = 32;
export const SESSION_TOKEN_LENGTH = 43; // base64url of 32 bytes, no padding
export const TOKEN_HASH_BYTES = 32;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** True only for a canonical base64url encoding of exactly 32 bytes. */
export function isWellFormedToken(token: unknown): token is string {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false;
  const decoded = Buffer.from(token, 'base64url');
  return decoded.length === SESSION_TOKEN_BYTES && decoded.toString('base64url') === token;
}

/** SHA-256 of the token's UTF-8 bytes. Throws for malformed input, so garbage is never hashed and looked up. */
export function hashToken(token: string): Buffer {
  if (!isWellFormedToken(token)) {
    throw new TypeError('malformed session token');
  }
  return createHash('sha256').update(token, 'utf8').digest();
}

export function newSessionToken(): { token: string; tokenHash: Buffer } {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}
