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

// ---- M2 helpers --------------------------------------------------------------------------------------------------

export const uid = (prefix: string) => `${prefix}-${randomUUID()}`;

export async function subscribe(api: APIRequestContext, user: TestUser, planId: string, mockOutcome = 'APPROVED', transactionId = uid('sub')) {
  return api.post('/subscriptions/purchase', { headers: bearer(user.token), data: { planId, transactionId, mockOutcome } });
}

export async function changePlan(api: APIRequestContext, user: TestUser, planId: string, mockOutcome = 'APPROVED', transactionId = uid('chg')) {
  return api.post('/subscriptions/change-plan', { headers: bearer(user.token), data: { planId, transactionId, mockOutcome } });
}

export async function cancelAutoRenew(api: APIRequestContext, user: TestUser, requestId = uid('cancel')) {
  return api.post('/subscriptions/cancel', { headers: bearer(user.token), data: { requestId } });
}

export async function notify(
  api: APIRequestContext,
  user: TestUser,
  data: { type: 'RENEWED' | 'EXPIRED' | 'REFUNDED' | 'REVOKED'; transactionId: string; eventId?: string; periodStart?: string },
) {
  return api.post('/subscriptions/mock-notifications', { headers: bearer(user.token), data: { eventId: uid('evt'), ...data } });
}

export async function current(api: APIRequestContext, user: TestUser) {
  const response = await api.get('/subscriptions/current', { headers: bearer(user.token) });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

export async function watchAd(api: APIRequestContext, user: TestUser, mockOutcome = 'COMPLETED', action = 'ADVANCED', adEventId = uid('ad')) {
  return api.post('/ads/rewards', { headers: bearer(user.token), data: { adEventId, action, mockOutcome } });
}

/** Independent oracle: ledger rows of one type for one user, oldest first. */
export async function dbLedger(db: pg.Pool, userId: string, entryType?: string) {
  const { rows } = await db.query<{ entry_type: string; bucket: string; delta: number; expiration_reason: string | null }>(
    `SELECT entry_type, bucket::text AS bucket, delta, expiration_reason FROM credit_ledger
      WHERE user_id = $1 AND ($2::text IS NULL OR entry_type = $2) ORDER BY id`,
    [userId, entryType ?? null],
  );
  return rows;
}

export async function dbAnalytics(db: pg.Pool, userId: string) {
  const { rows } = await db.query<{ name: string; properties: Record<string, unknown> }>(
    'SELECT name, properties FROM analytics_events WHERE user_id = $1 ORDER BY id',
    [userId],
  );
  return rows;
}

export async function dbSubscription(db: pg.Pool, userId: string) {
  const { rows } = await db.query<{ status: string; plan_id: string; pending_plan_id: string | null; auto_renew: boolean }>(
    'SELECT status, plan_id, pending_plan_id, auto_renew FROM subscriptions WHERE user_id = $1',
    [userId],
  );
  return rows[0] ?? null;
}
