/**
 * Shared helpers for HTTP API specs.
 * D-017b: every direct DB write here is scoped to rows owned by the calling test (its own user id and token hash).
 * There are no unscoped UPDATE/DELETE/TRUNCATE statements.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import type pg from 'pg';
import { seedCredits, type SeedableBucket } from '../../../src/db/seed.ts';
import { expect } from './fixtures.ts';

export const PASSWORD = 'correct horse battery staple';

export const uniqueEmail = (tag = 'user') => `${tag}-${randomUUID()}@test.invalid`;
export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
export const sha256 = (token: string) => createHash('sha256').update(token, 'utf8').digest();

export type TestUser = { id: string; email: string; password: string; token: string };

export async function register(api: APIRequestContext, email = uniqueEmail(), password = PASSWORD) {
  const response = await api.post('/auth/register', { data: { email, password } });
  return { response, email, password };
}

export async function login(api: APIRequestContext, email: string, password = PASSWORD): Promise<string> {
  const response = await api.post('/auth/login', { data: { email, password } });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).token as string;
}

/** Registers and logs in a fresh, unique user. */
export async function newUser(api: APIRequestContext, tag = 'user'): Promise<TestUser> {
  const { response, email, password } = await register(api, uniqueEmail(tag));
  expect(response.status(), await response.text()).toBe(201);
  const { user } = await response.json();
  return { id: user.id, email, password, token: await login(api, email, password) };
}

/** Test-controlled time: move one session of this test's user into the past (scoped by user id AND token hash). */
export async function expireSession(db: pg.Pool, user: TestUser, token = user.token): Promise<void> {
  const { rowCount } = await db.query(
    `UPDATE sessions SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day'
      WHERE user_id = $1 AND token_hash = $2`,
    [user.id, sha256(token)],
  );
  expect(rowCount).toBe(1);
}

/** DV-003: controlled seeding of this test's own user (no HTTP route exists for this). */
export async function seed(db: pg.Pool, user: TestUser, amounts: Partial<Record<SeedableBucket, number>>): Promise<void> {
  for (const [bucket, amount] of Object.entries(amounts) as Array<[SeedableBucket, number]>) {
    if (amount > 0) await seedCredits(db, { userId: user.id, bucket, amount, reason: 'api test fixture' });
  }
}

export async function dbBalances(db: pg.Pool, userId: string): Promise<Record<string, number>> {
  const { rows } = await db.query<{ bucket: string; balance: number }>(
    'SELECT bucket::text AS bucket, balance FROM bucket_balances WHERE user_id = $1',
    [userId],
  );
  return Object.fromEntries(rows.map((r) => [r.bucket, r.balance]));
}

/** Independent oracle for DV-002: per-bucket SUM(ledger.delta) computed directly from the ledger. */
export async function dbLedgerSums(db: pg.Pool, userId: string): Promise<Record<string, number>> {
  const { rows } = await db.query<{ bucket: string; total: number }>(
    'SELECT bucket::text AS bucket, SUM(delta)::int AS total FROM credit_ledger WHERE user_id = $1 GROUP BY bucket',
    [userId],
  );
  const sums: Record<string, number> = { SUBSCRIPTION: 0, CONSUMABLE: 0, REWARD: 0, PROMOTIONAL: 0 };
  for (const r of rows) sums[r.bucket] = r.total;
  return sums;
}

export async function expectLedgerConsistent(db: pg.Pool, userId: string): Promise<void> {
  expect(await dbBalances(db, userId)).toEqual(await dbLedgerSums(db, userId));
}

export async function buy(api: APIRequestContext, user: TestUser, packageId: string, mockOutcome = 'APPROVED', transactionId = `tx-${randomUUID()}`) {
  return api.post('/purchases', { headers: bearer(user.token), data: { packageId, transactionId, mockOutcome } });
}

export async function spend(api: APIRequestContext, user: TestUser, action: string, requestId = `req-${randomUUID()}`) {
  return api.post('/operations', { headers: bearer(user.token), data: { action, requestId } });
}
