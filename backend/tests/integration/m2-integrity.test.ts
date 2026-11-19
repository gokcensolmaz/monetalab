import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { adProviderFromEnv } from '../../src/ads/provider.ts';
import { recordAnalyticsEvent } from '../../src/analytics/events.ts';
import { eventCounts, paidChurn, trialConversion } from '../../src/analytics/reports.ts';
import { buildApp } from '../../src/app.ts';
import type { Clock } from '../../src/clock.ts';
import { seedCredits } from '../../src/db/seed.ts';
import { createMigratedDatabase, expectPgError, insertUser, type TestDb } from './helpers/test-db.ts';

// Categories (D-005): [BR] business rule, [INT] integration, [NEG] negative/edge case.
// Database-level enforcement for M2 (migration 003) plus in-process API checks with an injected business clock.

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const RESTRICT_VIOLATION = '23001';

let db: TestDb;
before(async () => {
  db = await createMigratedDatabase();
});
after(async () => {
  await db?.drop();
});

/** Inserts a subscription + one period directly (deferred FK), returning their ids. */
async function insertSubscription(userId: string, opts: { kind?: string; credits?: number; disposition?: string; status?: string } = {}) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const periodId = randomUUID();
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO subscriptions (user_id, group_id, provider, status, plan_id, auto_renew, current_period_id)
       VALUES ($1, 'MONETALAB_WEEKLY', 'mock', $2, 'BASIC_WEEKLY', $3, $4) RETURNING id`,
      [userId, opts.status ?? 'ACTIVE', (opts.status ?? 'ACTIVE') === 'ACTIVE', periodId],
    );
    await client.query(
      `INSERT INTO subscription_periods (id, subscription_id, user_id, provider, transaction_id, plan_id, kind, starts_at, ends_at, credits, disposition)
       VALUES ($1, $2, $3, 'mock', $4, 'BASIC_WEEKLY', $5, now(), now() + interval '7 days', $6, $7)`,
      [periodId, rows[0]!.id, userId, `tx-${randomUUID()}`, opts.kind ?? 'INITIAL', opts.credits ?? 3000, opts.disposition ?? 'APPLIED'],
    );
    await client.query('COMMIT');
    return { subscriptionId: rows[0]!.id, periodId };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function addPeriod(userId: string, subscriptionId: string, over: { kind?: string; credits?: number; disposition?: string } = {}) {
  const id = randomUUID();
  await db.pool.query(
    `INSERT INTO subscription_periods (id, subscription_id, user_id, provider, transaction_id, plan_id, kind, starts_at, ends_at, credits, disposition)
     VALUES ($1, $2, $3, 'mock', $4, 'BASIC_WEEKLY', $5, now(), now() + interval '7 days', $6, $7)`,
    [id, subscriptionId, userId, `tx-${randomUUID()}`, over.kind ?? 'RENEWAL', over.credits ?? 3000, over.disposition ?? 'APPLIED'],
  );
  return id;
}

const subGrant = (userId: string, periodId: string, delta: number, bucket = 'SUBSCRIPTION') =>
  db.pool.query(
    `INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, subscription_period_id) VALUES ($1, $2, $3, 'SUBSCRIPTION_GRANT', $4)`,
    [userId, bucket, delta, periodId],
  );
const subExpire = (userId: string, periodId: string, delta: number, reason = 'EXPIRED') =>
  db.pool.query(
    `INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, subscription_period_id, expiration_reason) VALUES ($1, 'SUBSCRIPTION', $2, 'SUBSCRIPTION_EXPIRATION', $3, $4)`,
    [userId, delta, periodId, reason],
  );

async function insertAd(userId: string, over: { status?: string; slot?: number | null; credits?: number; day?: string; outcome?: string; businessTime?: string } = {}) {
  const day = over.day ?? '2031-03-01';
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO ad_rewards (user_id, provider, ad_event_id, action, ad_outcome, status, utc_day, reward_slot, credits, business_time)
     VALUES ($1, 'mock', $2, 'BASIC', $3, $4, $5, $6, $7, $8) RETURNING id`,
    [userId, `ad-${randomUUID()}`, over.outcome ?? 'COMPLETED', over.status ?? 'REWARDED', day,
      over.slot === undefined ? 1 : over.slot, over.credits ?? 100, over.businessTime ?? `${day}T12:00:00Z`],
  );
  return rows[0]!.id;
}

async function balance(userId: string, bucket: string): Promise<number> {
  const { rows } = await db.pool.query<{ balance: number }>('SELECT balance FROM bucket_balances WHERE user_id = $1 AND bucket = $2', [userId, bucket]);
  return rows[0]!.balance;
}

describe('M2 catalog', () => {
  it('[BR][PRD §2.1] plans Basic/Premium/Ultra = 3,000/6,000/12,000 weekly in one group; only Basic has the 3-day 1,000 trial', async () => {
    const plans = await db.pool.query('SELECT id, group_id, tier, period_days, credits_per_period FROM subscription_plans ORDER BY tier');
    assert.deepEqual(plans.rows, [
      { id: 'BASIC_WEEKLY', group_id: 'MONETALAB_WEEKLY', tier: 1, period_days: 7, credits_per_period: 3000 },
      { id: 'PREMIUM_WEEKLY', group_id: 'MONETALAB_WEEKLY', tier: 2, period_days: 7, credits_per_period: 6000 },
      { id: 'ULTRA_WEEKLY', group_id: 'MONETALAB_WEEKLY', tier: 3, period_days: 7, credits_per_period: 12000 },
    ]);
    const offers = await db.pool.query('SELECT plan_id, kind, days, credits FROM subscription_intro_offers');
    assert.deepEqual(offers.rows, [{ plan_id: 'BASIC_WEEKLY', kind: 'FREE_TRIAL', days: 3, credits: 1000 }]);
  });
});

describe('subscription ledger integrity', () => {
  it('[BR] a subscription grant of exactly the period credits updates the SUBSCRIPTION balance', async () => {
    const userId = await insertUser(db.pool);
    const { periodId } = await insertSubscription(userId);
    await subGrant(userId, periodId, 3000);
    assert.equal(await balance(userId, 'SUBSCRIPTION'), 3000);
  });

  it('[NEG] grant amount must match the period; one grant per period; never into another bucket', async () => {
    const userId = await insertUser(db.pool);
    const { periodId } = await insertSubscription(userId);
    let err = await expectPgError(subGrant(userId, periodId, 3001));
    assert.equal(err.constraint, 'credit_ledger_grant_amount_matches_period');
    err = await expectPgError(subGrant(userId, periodId, 3000, 'CONSUMABLE'));
    assert.equal(err.constraint, 'credit_ledger_entry_shape');
    await subGrant(userId, periodId, 3000);
    err = await expectPgError(subGrant(userId, periodId, 3000));
    assert.equal(err.code, UNIQUE_VIOLATION);
    assert.equal(err.constraint, 'credit_ledger_one_grant_per_period_uq');
    assert.equal(await balance(userId, 'SUBSCRIPTION'), 3000);
  });

  it('[NEG] a SUPERSEDED (out-of-order) period can never grant credits', async () => {
    const userId = await insertUser(db.pool);
    const { subscriptionId } = await insertSubscription(userId);
    const stale = await addPeriod(userId, subscriptionId, { disposition: 'SUPERSEDED' });
    const err = await expectPgError(subGrant(userId, stale, 3000));
    assert.equal(err.constraint, 'credit_ledger_grant_requires_applied_period');
  });

  it('[NEG] expiration only removes SUBSCRIPTION credits, once per period, never below zero, with a valid reason', async () => {
    const userId = await insertUser(db.pool);
    const { periodId } = await insertSubscription(userId);
    await subGrant(userId, periodId, 3000);
    let err = await expectPgError(subExpire(userId, periodId, -3001));
    assert.equal(err.constraint, 'bucket_balances_non_negative');
    err = await expectPgError(subExpire(userId, periodId, -10, 'BECAUSE'));
    assert.equal(err.constraint, 'credit_ledger_entry_shape');
    err = await expectPgError(subExpire(userId, periodId, 10));
    assert.equal(err.constraint, 'credit_ledger_entry_shape');
    await subExpire(userId, periodId, -3000);
    err = await expectPgError(subExpire(userId, periodId, -1));
    assert.equal(err.constraint, 'credit_ledger_one_expiration_per_period_uq');
    assert.equal(await balance(userId, 'SUBSCRIPTION'), 0);
  });

  it('[NEG] consumable/reward/promotional balances are untouched by subscription entries (bucket-scoped CHECK)', async () => {
    const userId = await insertUser(db.pool);
    await seedCredits(db.pool, { userId, bucket: 'REWARD', amount: 400, reason: 'integration' });
    const { periodId } = await insertSubscription(userId);
    await subGrant(userId, periodId, 3000);
    await subExpire(userId, periodId, -3000, 'REVOKED');
    assert.equal(await balance(userId, 'REWARD'), 400);
    const err = await expectPgError(db.pool.query(
      `INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, subscription_period_id, expiration_reason) VALUES ($1, 'REWARD', -400, 'SUBSCRIPTION_EXPIRATION', $2, 'REVOKED')`,
      [userId, periodId],
    ));
    assert.equal(err.constraint, 'credit_ledger_entry_shape');
  });
});

describe('trial and subscription records', () => {
  it('[NEG][TRIAL-02] at most one TRIAL period per user, ever; one redemption per user and group', async () => {
    const userId = await insertUser(db.pool);
    const { subscriptionId, periodId } = await insertSubscription(userId, { kind: 'TRIAL', credits: 1000, status: 'TRIAL' });
    const err = await expectPgError(addPeriod(userId, subscriptionId, { kind: 'TRIAL', credits: 1000 }));
    assert.equal(err.constraint, 'subscription_periods_one_trial_per_user_uq');
    await db.pool.query(`INSERT INTO trial_redemptions (user_id, group_id, period_id, source, redeemed_at) VALUES ($1, 'MONETALAB_WEEKLY', $2, 'MOCK_PROVIDER', now())`, [userId, periodId]);
    const again = await expectPgError(db.pool.query(
      `INSERT INTO trial_redemptions (user_id, group_id, period_id, source, redeemed_at) VALUES ($1, 'MONETALAB_WEEKLY', $2, 'MOCK_PROVIDER', now())`, [userId, periodId]));
    assert.equal(again.code, UNIQUE_VIOLATION);
  });

  it('[NEG] transaction ids are unique per provider across users (no replay into another account)', async () => {
    const a = await insertUser(db.pool);
    const b = await insertUser(db.pool);
    const { periodId } = await insertSubscription(a);
    const { rows } = await db.pool.query<{ transaction_id: string }>('SELECT transaction_id FROM subscription_periods WHERE id = $1', [periodId]);
    const { subscriptionId } = await insertSubscription(b);
    const err = await expectPgError(db.pool.query(
      `INSERT INTO subscription_periods (subscription_id, user_id, provider, transaction_id, plan_id, kind, starts_at, ends_at, credits, disposition)
       VALUES ($1, $2, 'mock', $3, 'BASIC_WEEKLY', 'RENEWAL', now(), now() + interval '7 days', 3000, 'APPLIED')`,
      [subscriptionId, b, rows[0]!.transaction_id]));
    assert.equal(err.constraint, 'subscription_periods_provider_tx_uq');
  });

  it('[NEG] a revoked subscription cannot be re-activated in place, and a revoked current period cannot be active', async () => {
    const userId = await insertUser(db.pool);
    const { subscriptionId, periodId } = await insertSubscription(userId);
    await db.pool.query(`INSERT INTO subscription_revocations (period_id, user_id, reason, revoked_at) VALUES ($1, $2, 'REFUNDED', now())`, [periodId, userId]);
    let err = await expectPgError(db.pool.query(`UPDATE subscriptions SET status = 'ACTIVE' WHERE id = $1`, [subscriptionId]));
    assert.equal(err.constraint, 'subscriptions_current_period_not_revoked');
    await db.pool.query(`UPDATE subscriptions SET status = 'REVOKED', auto_renew = false WHERE id = $1`, [subscriptionId]);
    err = await expectPgError(db.pool.query(`UPDATE subscriptions SET status = 'ACTIVE', auto_renew = true WHERE id = $1`, [subscriptionId]));
    assert.equal(err.constraint, 'subscriptions_revoked_needs_new_period');
    err = await expectPgError(db.pool.query(`UPDATE subscriptions SET pending_plan_id = 'PREMIUM_WEEKLY' WHERE id = $1`, [subscriptionId]));
    assert.equal(err.constraint, 'subscriptions_ended_shape');
  });

  it('[NEG] history tables are immutable; the subscription state row cannot be deleted', async () => {
    const userId = await insertUser(db.pool);
    const { subscriptionId, periodId } = await insertSubscription(userId);
    await db.pool.query(`INSERT INTO subscription_revocations (period_id, user_id, reason, revoked_at) VALUES ($1, $2, 'REVOKED', now())`, [periodId, userId]);
    await recordAnalyticsEvent(db.pool, { userId, name: 'trial_started', dedupeKey: `k-${randomUUID()}`, occurredAt: new Date(), properties: {} });
    await insertAd(userId);
    for (const sql of [
      `UPDATE subscription_periods SET credits = 1 WHERE user_id = $1`,
      `DELETE FROM subscription_periods WHERE user_id = $1`,
      `DELETE FROM subscription_revocations WHERE user_id = $1`,
      `UPDATE analytics_events SET name = 'trial_expired' WHERE user_id = $1`,
      `DELETE FROM ad_rewards WHERE user_id = $1`,
      `DELETE FROM subscriptions WHERE user_id = $1`,
    ]) {
      const err = await expectPgError(db.pool.query(sql, [userId]));
      assert.equal(err.code, RESTRICT_VIOLATION, sql);
    }
    for (const sql of [`UPDATE subscription_plans SET credits_per_period = 1`, `DELETE FROM subscription_intro_offers`]) {
      assert.equal((await expectPgError(db.pool.query(sql))).code, RESTRICT_VIOLATION, sql);
    }
    assert.ok(subscriptionId);
  });
});

describe('rewarded ads: DB-enforced daily cap and exactly-once grants', () => {
  it('[NEG][ADS-03] an 11th reward slot is impossible (CHECK), and a slot cannot be reused within a UTC day (UNIQUE)', async () => {
    const userId = await insertUser(db.pool);
    for (let slot = 1; slot <= 10; slot++) await insertAd(userId, { slot });
    let err = await expectPgError(insertAd(userId, { slot: 11 }));
    assert.equal(err.code, CHECK_VIOLATION);
    err = await expectPgError(insertAd(userId, { slot: 10 }));
    assert.equal(err.constraint, 'ad_rewards_daily_slot_uq');
    // A new UTC day has its own 10 slots.
    await insertAd(userId, { slot: 1, day: '2031-03-02' });
  });

  it('[NEG][ADS-04] 20 concurrent inserts racing for the same slot: exactly one wins', async () => {
    const userId = await insertUser(db.pool);
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => insertAd(userId, { slot: 1 })));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  });

  it('[NEG] attempt shape: non-rewarded rows hold no slot or credits; utc_day must equal the UTC date of business time', async () => {
    const userId = await insertUser(db.pool);
    let err = await expectPgError(insertAd(userId, { status: 'NOT_REWARDED', outcome: 'INCOMPLETE', slot: 1, credits: 0 }));
    assert.equal(err.constraint, 'ad_rewards_status_shape');
    err = await expectPgError(insertAd(userId, { status: 'REWARDED', outcome: 'INCOMPLETE' }));
    assert.equal(err.constraint, 'ad_rewards_status_shape');
    // 2031-03-02T01:30+03:00 is 2031-03-01 in UTC.
    err = await expectPgError(insertAd(userId, { day: '2031-03-02', businessTime: '2031-03-02T01:30:00+03:00' }));
    assert.equal(err.constraint, 'ad_rewards_utc_day_matches');
    await insertAd(userId, { day: '2031-03-01', businessTime: '2031-03-02T01:30:00+03:00' });
  });

  it('[NEG] a reward grant needs a REWARDED attempt, is exactly 100 into REWARD, and happens once per attempt', async () => {
    const userId = await insertUser(db.pool);
    const failed = await insertAd(userId, { status: 'NOT_REWARDED', outcome: 'FAILED', slot: null, credits: 0 });
    const grant = (adId: string, delta = 100, bucket = 'REWARD') => db.pool.query(
      `INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, ad_reward_id) VALUES ($1, $2, $3, 'REWARD_GRANT', $4)`, [userId, bucket, delta, adId]);
    assert.equal((await expectPgError(grant(failed))).constraint, 'credit_ledger_reward_requires_rewarded_ad');
    const ok = await insertAd(userId, { slot: 1 });
    assert.equal((await expectPgError(grant(ok, 200))).constraint, 'credit_ledger_entry_shape');
    assert.equal((await expectPgError(grant(ok, 100, 'CONSUMABLE'))).constraint, 'credit_ledger_entry_shape');
    await grant(ok);
    assert.equal((await expectPgError(grant(ok))).constraint, 'credit_ledger_one_grant_per_ad_reward_uq');
    assert.equal(await balance(userId, 'REWARD'), 100);
  });

  it('[NEG] the mock ad provider is refused with NODE_ENV=production; unknown providers are rejected', () => {
    assert.throws(() => adProviderFromEnv({ NODE_ENV: 'production' }), /must not run with NODE_ENV=production/);
    assert.throws(() => adProviderFromEnv({ AD_PROVIDER: 'admob' }), /Unsupported AD_PROVIDER/);
    assert.equal(adProviderFromEnv({}).name, 'mock');
  });
});

describe('analytics events', () => {
  it('[BR] idempotent per (name, source key); separate names for the same source are kept; unknown names rejected', async () => {
    const userId = await insertUser(db.pool);
    const key = `notification:${randomUUID()}`;
    const event = { userId, dedupeKey: key, occurredAt: new Date('2031-01-01T00:00:00Z'), properties: { planId: 'BASIC_WEEKLY' } };
    assert.equal(await recordAnalyticsEvent(db.pool, { ...event, name: 'subscription_renewed' }), true);
    assert.equal(await recordAnalyticsEvent(db.pool, { ...event, name: 'subscription_renewed' }), false);
    assert.equal(await recordAnalyticsEvent(db.pool, { ...event, name: 'subscription_downgraded' }), true);
    const err = await expectPgError(db.pool.query(
      `INSERT INTO analytics_events (user_id, name, dedupe_key, occurred_at) VALUES ($1, 'paywall_viewed', 'x', now())`, [userId]));
    assert.equal(err.code, CHECK_VIOLATION);
  });
});

describe('in-process API with an injected business clock', () => {
  const mutable = (iso: string) => {
    let now = new Date(iso);
    const clock: Clock = { now: () => now };
    return { clock, set: (next: string) => { now = new Date(next); } };
  };

  async function registerAndLogin(app: ReturnType<typeof buildApp>) {
    const email = `m2-${randomUUID()}@test.invalid`;
    const password = 'correct horse battery staple';
    const reg = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password } });
    assert.equal(reg.statusCode, 201);
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
    return { token: login.json().token as string, userId: reg.json().user.id as string };
  }

  it('[NEG] no HTTP route can change time, grant/seed credits or read cross-user analytics', async () => {
    const app = buildApp({ pool: db.pool });
    await app.ready();
    const routes = app.printRoutes({ commonPrefix: false }).split('\n').map((l) => l.replace(/^[\s│├└─]+/, '').trim()).filter(Boolean);
    await app.close();
    const text = routes.join('\n');
    for (const forbidden of ['clock', 'time', 'seed', 'grant', 'admin', 'analytics', 'report', 'debug', 'fixture']) {
      assert.doesNotMatch(text, new RegExp(forbidden, 'i'), `unexpected route containing "${forbidden}"`);
    }
    for (const expected of ['/subscriptions/current', '/subscriptions/purchase', '/subscriptions/mock-notifications', '/ads/rewards', '/ads/quota']) {
      assert.ok(routes.some((r) => r.startsWith(expected)), `missing route ${expected}`);
    }
  });

  it('[BR][ADS-03] the quota boundary is the UTC midnight of the server clock', async () => {
    const t = mutable('2031-09-30T23:59:59.999Z');
    const app = buildApp({ pool: db.pool, clock: t.clock });
    try {
      const { token } = await registerAndLogin(app);
      const auth = { authorization: `Bearer ${token}` };
      for (let i = 0; i < 10; i++) {
        const ad = await app.inject({ method: 'POST', url: '/ads/rewards', headers: auth, payload: { adEventId: `ad-${randomUUID()}`, action: 'BASIC', mockOutcome: 'COMPLETED' } });
        assert.equal(ad.statusCode, 201, ad.body);
        assert.equal((await app.inject({ method: 'POST', url: '/operations', headers: auth, payload: { action: 'BASIC', requestId: `r-${randomUUID()}` } })).statusCode, 201);
      }
      const capped = await app.inject({ method: 'POST', url: '/ads/rewards', headers: auth, payload: { adEventId: `ad-${randomUUID()}`, action: 'BASIC', mockOutcome: 'COMPLETED' } });
      assert.equal(capped.statusCode, 429);
      t.set('2031-10-01T00:00:00.000Z');
      const q = (await app.inject({ method: 'GET', url: '/ads/quota', headers: auth })).json();
      assert.deepEqual([q.quota.utcDay, q.quota.used, q.quota.remaining], ['2031-10-01', 0, 10]);
    } finally {
      await app.close();
    }
  });

  it('[BR][PRD §4] conversion and working-definition churn reports are deterministic over a controlled history', async () => {
    const t = mutable('2032-01-01T00:00:00.000Z');
    const app = buildApp({ pool: db.pool, clock: t.clock });
    const post = (token: string, url: string, payload: unknown) =>
      app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload: payload as object });
    try {
      // A: trial → converts at day 3 → still paid at window end.
      // B: trial → expires unconverted.
      // C: paid Premium → cancels → expires at day 7 (churn).
      // D: paid Ultra → expires day 7 → resubscribes day 8 (paid replacement within the window: not churn).
      const [a, b, c, d] = [await registerAndLogin(app), await registerAndLogin(app), await registerAndLogin(app), await registerAndLogin(app)];
      const tx = (p: string) => `${p}-${randomUUID()}`;
      const bTrial = tx('b');
      const cTx = tx('c');
      const dTx = tx('d');
      assert.equal((await post(a.token, '/subscriptions/purchase', { planId: 'BASIC_WEEKLY', transactionId: tx('a'), mockOutcome: 'APPROVED' })).statusCode, 201);
      assert.equal((await post(b.token, '/subscriptions/purchase', { planId: 'BASIC_WEEKLY', transactionId: bTrial, mockOutcome: 'APPROVED' })).statusCode, 201);
      assert.equal((await post(c.token, '/subscriptions/purchase', { planId: 'PREMIUM_WEEKLY', transactionId: cTx, mockOutcome: 'APPROVED' })).statusCode, 201);
      assert.equal((await post(d.token, '/subscriptions/purchase', { planId: 'ULTRA_WEEKLY', transactionId: dTx, mockOutcome: 'APPROVED' })).statusCode, 201);
      assert.equal((await post(c.token, '/subscriptions/cancel', { requestId: tx('cc') })).statusCode, 201);
      t.set('2032-01-04T00:00:00.000Z');
      assert.equal((await post(a.token, '/subscriptions/mock-notifications', { eventId: tx('e'), type: 'RENEWED', transactionId: tx('a2') })).json().result, 'TRIAL_CONVERTED');
      assert.equal((await post(b.token, '/subscriptions/mock-notifications', { eventId: tx('e'), type: 'EXPIRED', transactionId: bTrial })).json().result, 'EXPIRED');
      t.set('2032-01-08T00:00:00.000Z');
      assert.equal((await post(c.token, '/subscriptions/mock-notifications', { eventId: tx('e'), type: 'EXPIRED', transactionId: cTx })).json().result, 'EXPIRED');
      assert.equal((await post(d.token, '/subscriptions/mock-notifications', { eventId: tx('e'), type: 'EXPIRED', transactionId: dTx })).json().result, 'EXPIRED');
      t.set('2032-01-09T00:00:00.000Z');
      assert.equal((await post(d.token, '/subscriptions/purchase', { planId: 'ULTRA_WEEKLY', transactionId: tx('d2'), mockOutcome: 'APPROVED' })).json().result, 'SUBSCRIPTION_STARTED');

      // Trial cohort started in [01-01, 01-02): A and B → 1 of 2 converted by 01-15 (A converted on 01-04).
      const cohort = { from: new Date('2032-01-01T00:00:00Z'), to: new Date('2032-01-02T00:00:00Z') };
      assert.deepEqual(await trialConversion(db.pool, { ...cohort, asOf: new Date('2032-01-15T00:00:00Z') }),
        { trialsStarted: 2, converted: 1, conversionRate: 0.5 });
      // Measured as of the cohort window end, nobody had converted yet.
      assert.deepEqual(await trialConversion(db.pool, cohort), { trialsStarted: 2, converted: 0, conversionRate: 0 });
      // Paid at 01-02: C and D (trials are not paid). In [01-02, 01-15): C churned, D replaced → 1 / 2.
      const churn = await paidChurn(db.pool, { from: new Date('2032-01-02T00:00:00Z'), to: new Date('2032-01-15T00:00:00Z') });
      assert.deepEqual([churn.paidSubscribersAtStart, churn.churned, churn.churnRate], [2, 1, 0.5]);
      assert.match(churn.definition, /not approved/);
      // Cancelling auto-renew alone is not churn: in [01-01, 01-05) only C cancelled, nobody expired.
      const early = await paidChurn(db.pool, { from: new Date('2032-01-01T12:00:00Z'), to: new Date('2032-01-05T00:00:00Z') });
      assert.deepEqual([early.paidSubscribersAtStart, early.churned], [2, 0]);
      const counts = await eventCounts(db.pool, { from: new Date('2032-01-01T00:00:00Z'), to: new Date('2032-01-15T00:00:00Z') });
      assert.deepEqual(counts, {
        subscription_cancelled: 1, subscription_expired: 2, subscription_started: 4, trial_expired: 1, trial_started: 2,
      });
      await assert.rejects(trialConversion(db.pool, { from: new Date('2032-01-02T00:00:00Z'), to: new Date('2032-01-01T00:00:00Z') }), /from < to/);
    } finally {
      await app.close();
    }
  });
});
