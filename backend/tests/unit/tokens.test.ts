import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  hashToken,
  isWellFormedToken,
  newSessionToken,
  SESSION_TOKEN_LENGTH,
  TOKEN_HASH_BYTES,
} from '../../src/auth/tokens.ts';

// Categories (D-005): [BR] business rule, [NEG] negative/edge case. Rules: slice 3 plan §4.2.

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

describe('session tokens: business rules', () => {
  it('[BR] a new token is 43 characters of base64url that decode to exactly 32 bytes', () => {
    const { token } = newSessionToken();
    assert.equal(SESSION_TOKEN_LENGTH, 43);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    assert.equal(isWellFormedToken(token), true);
  });

  it('[BR] the token hash is SHA-256 of the token (independent check) and 32 bytes', () => {
    const { token, tokenHash } = newSessionToken();
    const expected = createHash('sha256').update(token, 'utf8').digest();
    assert.equal(TOKEN_HASH_BYTES, 32);
    assert.equal(tokenHash.length, 32);
    assert.deepEqual(tokenHash, expected);
  });

  it('[BR] hashToken is deterministic', () => {
    const { token } = newSessionToken();
    assert.deepEqual(hashToken(token), hashToken(token));
  });

  it('[BR] the hash never contains the raw token', () => {
    const { token, tokenHash } = newSessionToken();
    assert.equal(tokenHash.toString('base64url').includes(token), false);
    assert.equal(tokenHash.toString('utf8').includes(token), false);
  });

  it('[BR] 10,000 generated tokens and their hashes are all distinct', () => {
    const tokens = new Set<string>();
    const hashes = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const { token, tokenHash } = newSessionToken();
      tokens.add(token);
      hashes.add(tokenHash.toString('hex'));
    }
    assert.equal(tokens.size, 10_000);
    assert.equal(hashes.size, 10_000);
  });

  it('[BR] generated tokens are not trivially patterned (character spread over 10,000 tokens)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) for (const ch of newSessionToken().token.slice(0, 42)) seen.add(ch);
    assert.equal(seen.size, 64, 'all 64 base64url characters should appear in the first 42 positions');
  });
});

describe('session tokens: malformed input', () => {
  const valid = newSessionToken().token;
  const lastIndex = BASE64URL_ALPHABET.indexOf(valid.at(-1)!);
  // 32 bytes -> 43 chars. The last char carries 4 data bits, so its 2 low bits must be 0. Setting one is non-canonical.
  const nonCanonical = valid.slice(0, -1) + BASE64URL_ALPHABET[lastIndex + 1];

  const malformed: Array<[string, unknown]> = [
    ['empty string', ''],
    ['42 characters', valid.slice(0, 42)],
    ['44 characters', `${valid}A`],
    ['standard base64 "+"', `+${valid.slice(1)}`],
    ['standard base64 "/"', `/${valid.slice(1)}`],
    ['padding "="', `${valid.slice(0, 42)}=`],
    ['leading space', ` ${valid.slice(1)}`],
    ['trailing newline', `${valid.slice(0, 42)}\n`],
    ['non-canonical last character', nonCanonical],
    ['non-ASCII character', `é${valid.slice(1)}`],
    ['"Bearer " prefix included', `Bearer ${valid}`],
    ['null', null],
    ['undefined', undefined],
    ['number', 12345],
    ['Buffer', Buffer.from(valid)],
  ];

  for (const [label, value] of malformed) {
    it(`[NEG] isWellFormedToken rejects: ${label}`, () => {
      assert.equal(isWellFormedToken(value), false);
    });
  }

  it('[NEG] the non-canonical test token really decodes to the same bytes (so only the strict check rejects it)', () => {
    assert.notEqual(nonCanonical, valid);
    assert.deepEqual(Buffer.from(nonCanonical, 'base64url'), Buffer.from(valid, 'base64url'));
  });

  it('[NEG] hashToken refuses malformed tokens instead of hashing them', () => {
    for (const [, value] of malformed) {
      assert.throws(() => hashToken(value as string), TypeError);
    }
  });

  it('[NEG] the hashToken error message does not echo the input', () => {
    assert.throws(
      () => hashToken(valid.slice(0, 42)),
      (error: Error) => !error.message.includes(valid.slice(0, 42)),
    );
  });

  it('[NEG] different tokens never share a hash (one-character change)', () => {
    const flipped = (valid[0] === 'A' ? 'B' : 'A') + valid.slice(1);
    assert.notDeepEqual(hashToken(flipped), hashToken(valid));
  });
});
