import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { randomBytes, scryptSync } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import {
  hashPassword,
  isPasswordWithinPolicy,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
} from '../../src/auth/password.ts';

// Categories (D-005): [BR] business rule, [NEG] negative/edge case. Rules: D-S3-03 (policy), D-S3-04 (scrypt).
// Expected values are computed independently in the test (crypto.scryptSync), not read back from the implementation.

const PASSWORD = 'correct horse battery staple';
const FORMAT = /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/; // 16-byte salt -> 22 chars, 64-byte key -> 86 chars

/** Builds a valid stored hash independently of the implementation, for any scrypt parameters. */
function referenceHash(password: string, n: number, r: number, p: number): string {
  const salt = randomBytes(16);
  const key = scryptSync(Buffer.from(password, 'utf8'), salt, 64, { N: n, r, p, maxmem: 256 * 1024 * 1024 });
  return ['scrypt', n, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

function replacePart(stored: string, index: number, value: string): string {
  const parts = stored.split('$');
  parts[index] = value;
  return parts.join('$');
}

describe('password hashing: business rules', () => {
  it('[BR][D-S3-04] produces scrypt$N$r$p$salt$key with the approved parameters and sizes', async () => {
    assert.match(await hashPassword(PASSWORD), FORMAT);
  });

  it('[BR][D-S3-04] the stored key equals an independently computed scrypt(password, salt)', async () => {
    const stored = await hashPassword(PASSWORD);
    const [, , , , saltText, keyText] = stored.split('$') as [string, string, string, string, string, string];
    const expected = scryptSync(Buffer.from(PASSWORD, 'utf8'), Buffer.from(saltText, 'base64url'), 64, {
      N: 2 ** 15,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    assert.equal(keyText, expected.toString('base64url'));
  });

  it('[BR] the correct password verifies', async () => {
    assert.equal(await verifyPassword(PASSWORD, await hashPassword(PASSWORD)), true);
  });

  it('[BR] unique salts: the same password hashes differently each time, and both verify', async () => {
    const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
    assert.notEqual(a, b);
    assert.notEqual(a.split('$')[4], b.split('$')[4], 'salts must differ');
    assert.equal(await verifyPassword(PASSWORD, a), true);
    assert.equal(await verifyPassword(PASSWORD, b), true);
  });

  it('[BR] the stored hash never contains the raw password', async () => {
    const stored = await hashPassword(PASSWORD);
    assert.equal(stored.includes(PASSWORD), false);
    assert.equal(stored.includes(Buffer.from(PASSWORD).toString('base64url')), false);
  });

  it('[BR] hashes made with other in-bounds parameters (future upgrade) still verify', async () => {
    assert.equal(await verifyPassword(PASSWORD, referenceHash(PASSWORD, 2 ** 14, 8, 1)), true);
  });

  it('[BR] Unicode passwords round-trip', async () => {
    const unicode = 'pässwörd-密码-🔐';
    assert.equal(await verifyPassword(unicode, await hashPassword(unicode)), true);
  });
});

describe('password verification: failed attempts', () => {
  it('[NEG] wrong passwords are rejected (case change, one character, prefix, suffix)', async () => {
    const stored = await hashPassword(PASSWORD);
    for (const wrong of ['Correct horse battery staple', 'correct horse battery stapla', 'correct horse', `${PASSWORD}!`]) {
      assert.equal(await verifyPassword(wrong, stored), false, `"${wrong.length}-char variant" must not verify`);
    }
  });

  it('[NEG] candidate passwords outside the policy are rejected without error', async () => {
    const stored = await hashPassword(PASSWORD);
    for (const candidate of ['', 'short', 'x'.repeat(PASSWORD_MAX_LENGTH + 1), null, undefined, 12345678, {}]) {
      assert.equal(await verifyPassword(candidate, stored), false);
    }
  });

  it('[NEG] a tampered key or salt fails verification', async () => {
    const stored = await hashPassword(PASSWORD);
    const flipFirst = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    assert.equal(await verifyPassword(PASSWORD, replacePart(stored, 5, flipFirst(stored.split('$')[5]!))), false);
    assert.equal(await verifyPassword(PASSWORD, replacePart(stored, 4, flipFirst(stored.split('$')[4]!))), false);
  });
});

describe('password verification: malformed stored hashes fail closed', () => {
  it('[NEG] non-string and structurally broken values return false', async () => {
    const valid = await hashPassword(PASSWORD);
    const cases: unknown[] = [
      undefined,
      null,
      42,
      {},
      Buffer.from(valid),
      '',
      'garbage',
      '$$$$$',
      valid.split('$').slice(0, 5).join('$'), // missing key
      `${valid}$extra`, // extra part
      valid.replace(/^scrypt/, 'bcrypt'), // wrong scheme
      valid.replace(/^scrypt/, 'SCRYPT'),
      `${valid}${'A'.repeat(600)}`, // over the length limit
    ];
    for (const stored of cases) {
      assert.equal(await verifyPassword(PASSWORD, stored), false, `expected false for ${typeof stored} input`);
    }
  });

  it('[NEG] invalid or unsafe parameters return false (including oversized cost, rejected quickly)', async () => {
    const valid = await hashPassword(PASSWORD);
    const badParams: Array<[number, string]> = [
      [1, 'abc'], // non-numeric N
      [1, '32768.0'],
      [1, '-32768'],
      [1, '032768'], // leading zero
      [1, '30000'], // not a power of two
      [1, String(2 ** 13)], // below the minimum
      [1, String(2 ** 30)], // above the maximum: must not attempt a 128 GiB derivation
      [2, '0'], // r = 0
      [2, '17'], // r above the maximum
      [3, '0'], // p = 0
      [3, '5'], // p above the maximum
    ];
    const started = performance.now();
    for (const [index, value] of badParams) {
      assert.equal(await verifyPassword(PASSWORD, replacePart(valid, index, value)), false, `part ${index}=${value}`);
    }
    assert.ok(performance.now() - started < 1000, 'rejected parameters must not trigger expensive scrypt work');
  });

  it('[NEG] an internal scrypt failure during verification returns false (fail closed), not an exception', async () => {
    const stored = await hashPassword(PASSWORD);
    // Make crypto.scrypt report an error. syncBuiltinESMExports propagates the mock to the ESM named import.
    const scryptMock = mock.method(crypto, 'scrypt', (...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null) => void;
      process.nextTick(() => callback(new Error('simulated scrypt failure')));
    });
    syncBuiltinESMExports();
    try {
      assert.equal(await verifyPassword(PASSWORD, stored), false);
      assert.equal(scryptMock.mock.callCount(), 1, 'the failure path must actually have been exercised');
    } finally {
      scryptMock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(await verifyPassword(PASSWORD, stored), true, 'mock restored: verification works again');
  });

  it('[NEG] invalid salt or key encodings return false', async () => {
    const valid = await hashPassword(PASSWORD);
    const [, , , , salt, key] = valid.split('$') as [string, string, string, string, string, string];
    const nonCanonicalSaltEnd = (s: string) => {
      // 16 bytes -> 22 chars. The last char carries 2 data bits, so its 4 low bits must be 0. Set one.
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      return s.slice(0, -1) + alphabet[alphabet.indexOf(s.at(-1)!) + 1];
    };
    const cases: Array<[number, string]> = [
      [4, salt.slice(0, -1)], // salt too short
      [4, `${salt}AAAA`], // salt too long
      [4, `${salt.slice(0, -2)}+/`], // standard base64 characters
      [4, `${salt}==`], // padding
      [4, nonCanonicalSaltEnd(salt)], // non-canonical encoding
      [5, key.slice(0, -2)], // key too short
      [5, `${key}AAAA`], // key too long
      [5, `${key.slice(0, -1)}!`], // illegal character
      [5, ''],
    ];
    for (const [index, value] of cases) {
      assert.equal(await verifyPassword(PASSWORD, replacePart(valid, index, value)), false, `part ${index} variant`);
    }
  });
});

describe('password policy boundaries (D-S3-03)', () => {
  it('[NEG] length boundaries: 7 rejected, 8 accepted, 128 accepted, 129 rejected', async () => {
    assert.equal(isPasswordWithinPolicy('a'.repeat(PASSWORD_MIN_LENGTH - 1)), false);
    assert.equal(isPasswordWithinPolicy('a'.repeat(PASSWORD_MIN_LENGTH)), true);
    assert.equal(isPasswordWithinPolicy('a'.repeat(PASSWORD_MAX_LENGTH)), true);
    assert.equal(isPasswordWithinPolicy('a'.repeat(PASSWORD_MAX_LENGTH + 1)), false);
    await assert.rejects(hashPassword('a'.repeat(7)), RangeError);
    await assert.rejects(hashPassword('a'.repeat(129)), RangeError);
    assert.match(await hashPassword('a'.repeat(8)), FORMAT);
    assert.match(await hashPassword('a'.repeat(128)), FORMAT);
  });

  it('[NEG] length counts characters (code points), not UTF-16 units', () => {
    // Each emoji is 2 UTF-16 units: 7 emoji = 14 units but 7 characters.
    assert.equal(isPasswordWithinPolicy('🔐'.repeat(7)), false);
    assert.equal(isPasswordWithinPolicy('🔐'.repeat(8)), true);
    assert.equal(isPasswordWithinPolicy('🔐'.repeat(128)), true);
    assert.equal(isPasswordWithinPolicy('🔐'.repeat(129)), false);
  });

  it('[NEG] non-string input is rejected by hashPassword', async () => {
    for (const value of [undefined, null, 12345678, ['password1']]) {
      await assert.rejects(hashPassword(value as unknown as string), RangeError);
    }
  });

  it('[NEG] error messages never include the password', async () => {
    const secret = 'Sh0rt!'; // 6 chars -> rejected
    await assert.rejects(hashPassword(secret), (error: Error) => !error.message.includes(secret));
  });

  it('[NEG] hashing and verification never write to the console', async () => {
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const spies = methods.map((m) => mock.method(console, m));
    try {
      const stored = await hashPassword(PASSWORD);
      await verifyPassword(PASSWORD, stored);
      await verifyPassword('wrong-password', stored);
      await verifyPassword(PASSWORD, 'scrypt$garbage');
      await hashPassword('short').catch(() => {});
      for (const [i, spy] of spies.entries()) assert.equal(spy.mock.callCount(), 0, `console.${methods[i]} was called`);
    } finally {
      for (const spy of spies) spy.mock.restore();
    }
  });
});
