/**
 * Password hashing with Node's built-in scrypt (decision D-S3-04).
 *
 * Stored format (self-describing, so parameters can be upgraded later without a migration):
 *   scrypt$<N>$<r>$<p>$<salt base64url>$<key base64url>
 *
 * Security rules:
 * - Salts come from crypto.randomBytes (CSPRNG). Keys are compared with timingSafeEqual.
 * - verifyPassword fails closed: any malformed, unsupported or out-of-bounds stored hash returns false and never throws.
 * - This module never logs, and its error messages never include the password or the hash.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

export const PASSWORD_MIN_LENGTH = 8; // D-S3-03
export const PASSWORD_MAX_LENGTH = 128; // D-S3-03

const SCHEME = 'scrypt';
const COST_N = 2 ** 15;
const BLOCK_SIZE_R = 8;
const PARALLELISM_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

// Bounds applied to *stored* parameters, so a corrupted or hostile hash string can't force huge CPU or memory use.
const MIN_N = 2 ** 14;
const MAX_N = 2 ** 17;
const MAX_R = 16;
const MAX_P = 4;
const MAX_MEMORY_BYTES = 256 * 1024 * 1024;

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const POSITIVE_INT = /^[1-9][0-9]{0,9}$/;

/** Counts Unicode code points, so a 2-unit emoji counts as one character. */
function characterCount(value: string): number {
  return Array.from(value).length;
}

export function isPasswordWithinPolicy(password: unknown): password is string {
  if (typeof password !== 'string') return false;
  const length = characterCount(password);
  return length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH;
}

function deriveKey(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(Buffer.from(password, 'utf8'), salt, keyLength, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

function memoryFor(n: number, r: number): number {
  // scrypt needs roughly 128 * N * r bytes. Allow 2x headroom.
  return 2 * 128 * n * r;
}

function encode(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/** Strict base64url decoding: rejects padding, foreign characters and non-canonical encodings. */
function decodeStrict(value: string, expectedBytes: number): Buffer | null {
  if (!BASE64URL.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== expectedBytes || encode(decoded) !== value) return null;
  return decoded;
}

export async function hashPassword(password: string): Promise<string> {
  if (!isPasswordWithinPolicy(password)) {
    throw new RangeError(`password must be a string of ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`);
  }
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(password, salt, KEY_BYTES, {
    N: COST_N,
    r: BLOCK_SIZE_R,
    p: PARALLELISM_P,
    maxmem: memoryFor(COST_N, BLOCK_SIZE_R),
  });
  return [SCHEME, COST_N, BLOCK_SIZE_R, PARALLELISM_P, encode(salt), encode(key)].join('$');
}

type ParsedHash = { n: number; r: number; p: number; salt: Buffer; key: Buffer };

function parseStoredHash(stored: unknown): ParsedHash | null {
  if (typeof stored !== 'string' || stored.length > 512) return null;
  const parts = stored.split('$');
  if (parts.length !== 6) return null;
  const [scheme, nText, rText, pText, saltText, keyText] = parts as [string, string, string, string, string, string];
  if (scheme !== SCHEME) return null;
  if (!POSITIVE_INT.test(nText) || !POSITIVE_INT.test(rText) || !POSITIVE_INT.test(pText)) return null;

  const n = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  const isPowerOfTwo = (n & (n - 1)) === 0;
  if (!isPowerOfTwo || n < MIN_N || n > MAX_N) return null;
  if (r > MAX_R || p > MAX_P) return null;
  if (memoryFor(n, r) > MAX_MEMORY_BYTES) return null;

  const salt = decodeStrict(saltText, SALT_BYTES);
  const key = decodeStrict(keyText, KEY_BYTES);
  if (!salt || !key) return null;
  return { n, r, p, salt, key };
}

/** Returns true only for a correct password against a well-formed stored hash. Never throws. */
export async function verifyPassword(password: unknown, stored: unknown): Promise<boolean> {
  try {
    if (!isPasswordWithinPolicy(password)) return false;
    const parsed = parseStoredHash(stored);
    if (!parsed) return false;
    const candidate = await deriveKey(password, parsed.salt, parsed.key.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
      maxmem: memoryFor(parsed.n, parsed.r),
    });
    return candidate.length === parsed.key.length && timingSafeEqual(candidate, parsed.key);
  } catch {
    return false; // fail closed
  }
}
