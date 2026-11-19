/**
 * Time-dependent M2 rules against the real server with a CONTROLLED business clock (D-033): the harness's second
 * server reads its time from a file this spec rewrites. There is no HTTP endpoint for time. Serial: the clock is
 * shared by everything talking to that server.
 *
 * Expected instants are written out literally (PRD §2.1: trial 3 days, plans 7 days; §3.2: UTC calendar day).
 */
import { test, expect } from './support/fixtures.ts';
import {
  bearer, buy, cancelAutoRenew, changePlan, dbAnalytics, dbBalances, dbLedger, dbSubscription, expectLedgerConsistent,
  newUser, notify, spend, subscribe, uid, watchAd, type TestUser,
} from './support/helpers.ts';
import type { APIRequestContext } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

async function state(api: APIRequestContext, user: TestUser) {
  const response = await api.get('/subscriptions/current', { headers: bearer(user.token) });
  expect(response.status()).toBe(200);
  return response.json();
}
const periodOf = async (api: APIRequestContext, user: TestUser) => (await state(api, user)).subscription.currentPeriod;

test.describe('subscription periods on a controlled clock', () => {
  test('[BR][SUB-01] trial → exact end boundary → verified conversion grants 3,000 → renewal grants once more', async ({ clock, db }) => {
    const api = clock.api;
    clock.set('2031-02-01T09:00:00.000Z');
    const user = await newUser(api, 'clock-trial');
    const trialTx = uid('trial');
    const started = await (await subscribe(api, user, 'BASIC_WEEKLY', 'APPROVED', trialTx)).json();
    expect(started.period).toMatchObject({ kind: 'TRIAL', startsAt: '2031-02-01T09:00:00.000Z', endsAt: '2031-02-04T09:00:00.000Z', credits: 1000 });
    await spend(api, user, 'BASIC'); // 900 trial credits left

    // 1 ms before the end: still entitled; a renewal cannot start in the future; trial credits still spendable.
    clock.set('2031-02-04T08:59:59.999Z');
    expect((await state(api, user)).subscription).toMatchObject({ status: 'TRIAL', entitled: true });
    const early = await notify(api, user, { type: 'RENEWED', transactionId: uid('paid') });
    expect((await early.json()).error.code).toBe('RENEWAL_NOT_DUE');
    expect((await dbBalances(db, user.id)).SUBSCRIPTION).toBe(900);

    // Exactly at the end: no entitlement; the remaining trial credits expire (stale entitlement) even though no
    // provider event arrived. The local clock does NOT grant paid credits (PRD §2.1).
    clock.set('2031-02-04T09:00:00.000Z');
    const atEnd = await state(api, user);
    expect(atEnd.subscription).toMatchObject({ status: 'TRIAL', entitled: false });
    expect(atEnd.wallet.balances.SUBSCRIPTION).toBe(0);
    const blocked = await spend(api, user, 'BASIC');
    expect(blocked.status()).toBe(402);
    expect(await dbLedger(db, user.id, 'SUBSCRIPTION_EXPIRATION')).toEqual([
      { entry_type: 'SUBSCRIPTION_EXPIRATION', bucket: 'SUBSCRIPTION', delta: -900, expiration_reason: 'PERIOD_ENDED' },
    ]);

    // The verified first paid period: 3,000 granted (the trial remainder was already expired, nothing double-expired).
    const paidTx = uid('paid');
    const converted = await notify(api, user, { type: 'RENEWED', transactionId: paidTx });
    expect(converted.status()).toBe(201);
    const body = await converted.json();
    expect(body.result).toBe('TRIAL_CONVERTED');
    expect(body.period).toMatchObject({ kind: 'RENEWAL', planId: 'BASIC_WEEKLY', startsAt: '2031-02-04T09:00:00.000Z', endsAt: '2031-02-11T09:00:00.000Z', credits: 3000 });
    expect(body.subscription).toMatchObject({ status: 'ACTIVE', entitled: true, renewsAt: '2031-02-11T09:00:00.000Z' });
    expect(body.wallet.balances.SUBSCRIPTION).toBe(3000);

    // Next week: the renewal expires the unused 2,500 and grants exactly one new 3,000.
    await spend(api, user, 'STANDARD');
    clock.set('2031-02-11T09:00:00.000Z');
    const renewed = await (await notify(api, user, { type: 'RENEWED', transactionId: uid('ren') })).json();
    expect(renewed.result).toBe('RENEWED');
    expect((await dbLedger(db, user.id)).filter((e) => e.entry_type.startsWith('SUBSCRIPTION')).map((e) => [e.entry_type, e.delta, e.expiration_reason])).toEqual([
      ['SUBSCRIPTION_GRANT', 1000, null],
      ['SUBSCRIPTION_EXPIRATION', -900, 'PERIOD_ENDED'],
      ['SUBSCRIPTION_GRANT', 3000, null],
      ['SUBSCRIPTION_EXPIRATION', -2500, 'PERIOD_ENDED'],
      ['SUBSCRIPTION_GRANT', 3000, null],
    ]);
    expect((await dbAnalytics(db, user.id)).map((e) => [e.name, e.properties.fromTrial ?? null])).toEqual([
      ['trial_started', null], ['subscription_started', true], ['subscription_renewed', null],
    ]);
    await expectLedgerConsistent(db, user.id);
  });

  test('[BR][SUB-06] cancel keeps the paid entitlement until the end; expiry only at/after the end; consumables kept', async ({ clock, db }) => {
    const api = clock.api;
    clock.set('2031-04-10T15:30:00.000Z');
    const user = await newUser(api, 'clock-cancel');
    await buy(api, user, 'CREDITS_S');
    const tx = uid('prem');
    await subscribe(api, user, 'PREMIUM_WEEKLY', 'APPROVED', tx);
    await cancelAutoRenew(api, user);

    clock.set('2031-04-17T15:29:59.999Z');
    const before = await state(api, user);
    expect(before.subscription).toMatchObject({ status: 'ACTIVE', entitled: true, autoRenew: false, renewsAt: null, expiresAt: '2031-04-17T15:30:00.000Z' });
    expect((await (await spend(api, user, 'ADVANCED')).json()).operation.debits.SUBSCRIPTION).toBe(800);
    const tooEarly = await notify(api, user, { type: 'EXPIRED', transactionId: tx });
    expect(tooEarly.status()).toBe(409);
    expect((await tooEarly.json()).error.code).toBe('PERIOD_NOT_ENDED');

    clock.set('2031-04-17T15:30:00.000Z');
    const expired = await notify(api, user, { type: 'EXPIRED', transactionId: tx });
    expect(expired.status()).toBe(201);
    const body = await expired.json();
    expect(body.subscription).toMatchObject({ status: 'EXPIRED', entitled: false });
    expect(body.wallet.balances).toEqual({ SUBSCRIPTION: 0, CONSUMABLE: 5000, REWARD: 0, PROMOTIONAL: 0 });
    expect((await dbAnalytics(db, user.id)).map((e) => e.name)).toEqual(['subscription_started', 'subscription_cancelled', 'subscription_expired']);
    // A second expiry is a no-op.
    expect((await (await notify(api, user, { type: 'EXPIRED', transactionId: tx })).json()).result).toBe('IGNORED_ALREADY_ENDED');
    await expectLedgerConsistent(db, user.id);
  });

  test('[BR][SUB-05] a scheduled downgrade takes effect at the next renewal: lower allotment, no consumable loss', async ({ clock, db }) => {
    const api = clock.api;
    clock.set('2031-05-01T00:00:00.000Z');
    const user = await newUser(api, 'clock-downgrade');
    await buy(api, user, 'CREDITS_L');
    await subscribe(api, user, 'ULTRA_WEEKLY');
    await changePlan(api, user, 'PREMIUM_WEEKLY');
    clock.set('2031-05-07T23:59:59.999Z');
    expect((await dbBalances(db, user.id)).SUBSCRIPTION).toBe(12000); // SUB-04: unchanged until effective
    clock.set('2031-05-08T00:00:00.000Z');
    const body = await (await notify(api, user, { type: 'RENEWED', transactionId: uid('ren') })).json();
    expect(body.result).toBe('RENEWED_DOWNGRADED');
    expect(body.period).toMatchObject({ planId: 'PREMIUM_WEEKLY', credits: 6000, startsAt: '2031-05-08T00:00:00.000Z' });
    expect(body.subscription).toMatchObject({ planId: 'PREMIUM_WEEKLY', pendingPlanId: null, entitled: true });
    expect(await dbBalances(db, user.id)).toEqual({ SUBSCRIPTION: 6000, CONSUMABLE: 10000, REWARD: 0, PROMOTIONAL: 0 });
    expect((await dbAnalytics(db, user.id)).map((e) => e.name)).toEqual(['subscription_started', 'subscription_downgraded', 'subscription_renewed']);
  });

  test('[NEG] out-of-order, delayed and duplicate provider notifications never double-grant or roll state back', async ({ clock, db }) => {
    const api = clock.api;
    clock.set('2031-06-01T12:00:00.000Z');
    const user = await newUser(api, 'clock-order');
    const tx1 = uid('p1');
    await subscribe(api, user, 'PREMIUM_WEEKLY', 'APPROVED', tx1); // 06-01 → 06-08
    clock.set('2031-06-16T00:00:00.000Z');
    // Week 3 arrives first.
    const tx3 = uid('p3');
    const third = await notify(api, user, { type: 'RENEWED', transactionId: tx3, periodStart: '2031-06-15T12:00:00.000Z' });
    expect((await third.json()).result).toBe('RENEWED');
    // Then the delayed week 2: audit only.
    const tx2 = uid('p2');
    const second = await notify(api, user, { type: 'RENEWED', transactionId: tx2, periodStart: '2031-06-08T12:00:00.000Z' });
    expect(second.status()).toBe(200);
    expect((await second.json()).result).toBe('IGNORED_SUPERSEDED');
    // A stale expiry for week 1 cannot end week 3.
    expect((await (await notify(api, user, { type: 'EXPIRED', transactionId: tx1 })).json()).result).toBe('IGNORED_STALE');
    // The week-3 transaction delivered again under a different notification id: no second grant.
    expect((await (await notify(api, user, { type: 'RENEWED', transactionId: tx3, periodStart: '2031-06-15T12:00:00.000Z' })).json()).result)
      .toBe('IGNORED_DUPLICATE_TRANSACTION');

    expect((await periodOf(api, user)).transactionId).toBe(tx3);
    expect(await dbSubscription(db, user.id)).toMatchObject({ status: 'ACTIVE', plan_id: 'PREMIUM_WEEKLY' });
    expect((await dbBalances(db, user.id)).SUBSCRIPTION).toBe(6000);
    const periods = await db.query(`SELECT transaction_id, disposition FROM subscription_periods WHERE user_id = $1 ORDER BY starts_at`, [user.id]);
    expect(periods.rows).toEqual([
      { transaction_id: tx1, disposition: 'APPLIED' },
      { transaction_id: tx2, disposition: 'SUPERSEDED' },
      { transaction_id: tx3, disposition: 'APPLIED' },
    ]);
    expect(await dbLedger(db, user.id, 'SUBSCRIPTION_GRANT')).toHaveLength(2);
    await expectLedgerConsistent(db, user.id);
  });

  test('[NEG] a renewal that arrives after its own period ended updates state but grants no unusable credits', async ({ clock, db }) => {
    const api = clock.api;
    clock.set('2031-07-01T00:00:00.000Z');
    const user = await newUser(api, 'clock-late');
    await subscribe(api, user, 'ULTRA_WEEKLY'); // 07-01 → 07-08
    clock.set('2031-07-20T00:00:00.000Z');
    const late = await (await notify(api, user, { type: 'RENEWED', transactionId: uid('late') })).json(); // 07-08 → 07-15
    expect(late.result).toBe('RENEWED');
    expect(late.subscription.entitled).toBe(false);
    expect(late.wallet.balances.SUBSCRIPTION).toBe(0);
    const current = await (await notify(api, user, { type: 'RENEWED', transactionId: uid('cur') })).json(); // 07-15 → 07-22
    expect(current.subscription.entitled).toBe(true);
    expect(current.wallet.balances.SUBSCRIPTION).toBe(12000);
    expect((await dbLedger(db, user.id, 'SUBSCRIPTION_GRANT')).map((e) => e.delta)).toEqual([12000, 12000]);
  });

  test('[NEG] concurrent delivery: 10x the same notification and 10x the same transaction under new ids → one grant', async ({ clock, db }) => {
    const api = clock.api;
    clock.set('2031-08-01T00:00:00.000Z');
    const user = await newUser(api, 'clock-concurrent');
    await subscribe(api, user, 'PREMIUM_WEEKLY');
    clock.set('2031-08-08T00:00:00.000Z');
    const eventId = uid('evt');
    const transactionId = uid('ren');
    const sameEvent = await Promise.all(Array.from({ length: 10 }, () => notify(api, user, { type: 'RENEWED', transactionId, eventId })));
    expect(sameEvent.map((r) => r.status()).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    const newIds = await Promise.all(Array.from({ length: 10 }, () => notify(api, user, { type: 'RENEWED', transactionId })));
    expect(newIds.every((r) => r.status() === 200)).toBe(true);
    for (const r of newIds) expect((await r.json()).result).toBe('IGNORED_DUPLICATE_TRANSACTION');
    expect((await dbLedger(db, user.id, 'SUBSCRIPTION_GRANT')).map((e) => e.delta)).toEqual([6000, 6000]);
    expect((await dbAnalytics(db, user.id)).filter((e) => e.name === 'subscription_renewed')).toHaveLength(1);
    await expectLedgerConsistent(db, user.id);
  });

  test('[NEG] concurrent conflicting lifecycle operations (upgrade, refund, cancel, spend) leave a consistent state', async ({ clock, db }) => {
    const api = clock.api;
    clock.set('2031-08-20T00:00:00.000Z');
    const user = await newUser(api, 'clock-mixed');
    const tx = uid('basic');
    await subscribe(api, user, 'PREMIUM_WEEKLY', 'APPROVED', tx);
    const results = await Promise.all([
      changePlan(api, user, 'ULTRA_WEEKLY'),
      notify(api, user, { type: 'REFUNDED', transactionId: tx }),
      cancelAutoRenew(api, user),
      spend(api, user, 'ADVANCED'),
      spend(api, user, 'ADVANCED'),
    ]);
    for (const r of results) expect([200, 201, 402, 409]).toContain(r.status());
    // Whatever the order, the books balance and nothing went negative (CHECK) or was granted twice.
    await expectLedgerConsistent(db, user.id);
    const balances = await dbBalances(db, user.id);
    for (const value of Object.values(balances)) expect(value).toBeGreaterThanOrEqual(0);
    const grants = await db.query(`SELECT count(*)::int AS n FROM credit_ledger WHERE user_id = $1 AND entry_type = 'SUBSCRIPTION_GRANT'`, [user.id]);
    expect(grants.rows[0].n).toBeLessThanOrEqual(2);
  });
});

test.describe('rewarded ads on a controlled clock (UTC day)', () => {
  test('[BR][ADS-03] 10 ads until 23:59:59.999 UTC, rejected 11th, fresh quota at 00:00:00.000 UTC', async ({ clock, db }) => {
    const api = clock.api;
    clock.set('2031-03-01T23:59:00.000Z');
    const user = await newUser(api, 'clock-ads');
    for (let i = 0; i < 10; i++) {
      expect((await watchAd(api, user, 'COMPLETED', 'BASIC')).status()).toBe(201);
      expect((await spend(api, user, 'BASIC')).status()).toBe(201);
    }
    clock.set('2031-03-01T23:59:59.999Z');
    const rejected = await watchAd(api, user, 'COMPLETED', 'BASIC');
    expect(rejected.status()).toBe(429);
    expect((await rejected.json()).error.quota).toMatchObject({ utcDay: '2031-03-01', used: 10, resetsAt: '2031-03-02T00:00:00.000Z' });

    clock.set('2031-03-02T00:00:00.000Z');
    const quota = await (await api.get('/ads/quota?action=BASIC', { headers: bearer(user.token) })).json();
    expect(quota.quota).toMatchObject({ utcDay: '2031-03-02', used: 0, remaining: 10 });
    // Device time zone / client clock cannot influence the day: a misleading Date header changes nothing.
    const fresh = await api.post('/ads/rewards', {
      headers: { ...bearer(user.token), Date: 'Sat, 01 Mar 2031 10:00:00 GMT' },
      data: { adEventId: uid('ad'), action: 'BASIC', mockOutcome: 'COMPLETED' },
    });
    expect(fresh.status()).toBe(201);
    expect((await fresh.json()).attempt.utcDay).toBe('2031-03-02');

    const days = await db.query(
      `SELECT utc_day::text AS day, status, count(*)::int AS n FROM ad_rewards WHERE user_id = $1 GROUP BY 1, 2 ORDER BY 1, 2`, [user.id]);
    expect(days.rows).toEqual([
      { day: '2031-03-01', status: 'LIMIT_REACHED', n: 1 },
      { day: '2031-03-01', status: 'REWARDED', n: 10 },
      { day: '2031-03-02', status: 'REWARDED', n: 1 },
    ]);
  });
});
