/**
 * M2 mock subscriptions over HTTP against the real server (system clock). Time-travel cases (renewal, expiry, UTC
 * boundaries) are in lifecycle-time.spec.ts. Expected amounts come from PRD §2.1, not from the implementation.
 */
import { test, expect } from './support/fixtures.ts';
import {
  bearer, buy, cancelAutoRenew, changePlan, current, dbAnalytics, dbBalances, dbLedger, dbSubscription,
  expectLedgerConsistent, newUser, notify, seed, spend, subscribe, uid,
} from './support/helpers.ts';

test.describe('trial (TRIAL-01/02)', () => {
  test('[BR][TRIAL-01] a first-time customer sees the trial message and gets 1,000 SUBSCRIPTION credits once', async ({ api, db }) => {
    const user = await newUser(api, 'trial');
    const before = await current(api, user);
    expect(before.subscription).toBeNull();
    expect(before.trial).toMatchObject({ eligible: true, reason: 'FIRST_TIME_SUBSCRIBER', source: 'BACKEND_RECORD' });
    expect(before.trial.offer).toMatchObject({ planId: 'BASIC_WEEKLY', days: 3, credits: 1000 });
    expect(before.trial.offer.message).toMatch(/3-day free trial with 1,000 credits/);

    const response = await subscribe(api, user, 'BASIC_WEEKLY');
    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.result).toBe('TRIAL_STARTED');
    expect(body.period).toMatchObject({ kind: 'TRIAL', planId: 'BASIC_WEEKLY', credits: 1000, disposition: 'APPLIED' });
    expect(Date.parse(body.period.endsAt) - Date.parse(body.period.startsAt)).toBe(3 * 24 * 3600 * 1000);
    expect(body.subscription).toMatchObject({ status: 'TRIAL', planId: 'BASIC_WEEKLY', entitled: true, autoRenew: true });
    expect(body.subscription.renewsAt).toBe(body.period.endsAt);
    expect(body.wallet.balances).toEqual({ SUBSCRIPTION: 1000, CONSUMABLE: 0, REWARD: 0, PROMOTIONAL: 0 });
    // After redemption, no trial messaging is presented any more (PRD §3.1).
    expect(body.trial).toEqual({ eligible: false, reason: 'TRIAL_ALREADY_USED', source: 'BACKEND_RECORD', offer: null });

    expect(await dbLedger(db, user.id, 'SUBSCRIPTION_GRANT')).toEqual([
      { entry_type: 'SUBSCRIPTION_GRANT', bucket: 'SUBSCRIPTION', delta: 1000, expiration_reason: null },
    ]);
    const redemptions = await db.query('SELECT source FROM trial_redemptions WHERE user_id = $1', [user.id]);
    expect(redemptions.rows).toEqual([{ source: 'MOCK_PROVIDER' }]);
    expect((await dbAnalytics(db, user.id)).map((e) => e.name)).toEqual(['trial_started']);
    await expectLedgerConsistent(db, user.id);
  });

  test('[NEG][BUY-02] declined and cancelled trial purchases grant nothing and do NOT consume the trial', async ({ api, db }) => {
    const user = await newUser(api, 'trial-decline');
    for (const outcome of ['DECLINED', 'CANCELLED']) {
      const response = await subscribe(api, user, 'BASIC_WEEKLY', outcome);
      expect(response.status()).toBe(201);
      const body = await response.json();
      expect(body.result).toBe(outcome);
      expect(body.subscription).toBeNull();
      expect(body.trial.eligible).toBe(true);
    }
    expect(await dbBalances(db, user.id)).toEqual({ SUBSCRIPTION: 0, CONSUMABLE: 0, REWARD: 0, PROMOTIONAL: 0 });
    const ok = await (await subscribe(api, user, 'BASIC_WEEKLY')).json();
    expect(ok.result).toBe('TRIAL_STARTED');
  });

  test('[NEG][TRIAL-02] cancel + revoke, then resubscribe: no second trial, paid Basic 3,000 instead', async ({ api, db }) => {
    const user = await newUser(api, 'trial-again');
    const trialTx = uid('trial');
    await subscribe(api, user, 'BASIC_WEEKLY', 'APPROVED', trialTx);
    expect((await cancelAutoRenew(api, user)).status()).toBe(201);
    expect((await notify(api, user, { type: 'REVOKED', transactionId: trialTx })).status()).toBe(201);
    const again = await subscribe(api, user, 'BASIC_WEEKLY');
    expect(again.status()).toBe(201);
    const body = await again.json();
    expect(body.result).toBe('SUBSCRIPTION_STARTED');
    expect(body.period).toMatchObject({ kind: 'INITIAL', credits: 3000 });
    expect(body.trial.reason).toBe('TRIAL_ALREADY_USED');
    // DB: exactly one TRIAL period ever for this user (unique index), and one redemption.
    const trials = await db.query(`SELECT count(*)::int AS n FROM subscription_periods WHERE user_id = $1 AND kind = 'TRIAL'`, [user.id]);
    expect(trials.rows[0].n).toBe(1);
  });

  test('[NEG][TRIAL-02] a previous paid subscriber is not a first-time subscriber: Basic is paid, no trial message', async ({ api }) => {
    const user = await newUser(api, 'paid-first');
    const premiumTx = uid('prem');
    await subscribe(api, user, 'PREMIUM_WEEKLY', 'APPROVED', premiumTx);
    await notify(api, user, { type: 'REFUNDED', transactionId: premiumTx });
    const state = await current(api, user);
    expect(state.trial).toEqual({ eligible: false, reason: 'PREVIOUS_SUBSCRIBER', source: 'BACKEND_RECORD', offer: null });
    expect((await (await subscribe(api, user, 'BASIC_WEEKLY')).json()).period.kind).toBe('INITIAL');
  });

  test('[NEG][TRIAL-02] concurrent trial purchases with different transaction ids: exactly one trial, one grant', async ({ api, db }) => {
    const user = await newUser(api, 'trial-race');
    const responses = await Promise.all(Array.from({ length: 8 }, () => subscribe(api, user, 'BASIC_WEEKLY')));
    const statuses = responses.map((r) => r.status()).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
    for (const r of responses.filter((r) => r.status() === 409)) expect((await r.json()).error.code).toBe('ALREADY_SUBSCRIBED');
    expect(await dbLedger(db, user.id, 'SUBSCRIPTION_GRANT')).toHaveLength(1);
    expect((await dbBalances(db, user.id)).SUBSCRIPTION).toBe(1000);
  });
});

test.describe('purchase idempotency and isolation', () => {
  test('[BR] an identical replay returns 200 with the original result and grants nothing more', async ({ api, db }) => {
    const user = await newUser(api, 'sub-replay');
    const tx = uid('sub');
    const first = await subscribe(api, user, 'PREMIUM_WEEKLY', 'APPROVED', tx);
    expect(first.status()).toBe(201);
    const replay = await subscribe(api, user, 'PREMIUM_WEEKLY', 'APPROVED', tx);
    expect(replay.status()).toBe(200);
    const body = await replay.json();
    expect(body).toMatchObject({ result: 'SUBSCRIPTION_STARTED', replayed: true });
    expect(body.period).toEqual((await first.json()).period);
    expect(await dbLedger(db, user.id, 'SUBSCRIPTION_GRANT')).toHaveLength(1);
    expect((await dbBalances(db, user.id)).SUBSCRIPTION).toBe(6000);
  });

  test('[NEG] the same transaction id with a different plan, or by another user, is a 409 TRANSACTION_CONFLICT', async ({ api, db }) => {
    const alice = await newUser(api, 'alice');
    const mallory = await newUser(api, 'mallory');
    const tx = uid('sub');
    await subscribe(api, alice, 'BASIC_WEEKLY', 'APPROVED', tx);
    for (const [user, plan] of [[alice, 'ULTRA_WEEKLY'], [mallory, 'BASIC_WEEKLY']] as const) {
      const response = await subscribe(api, user, plan, 'APPROVED', tx);
      expect(response.status()).toBe(409);
      expect((await response.json()).error.code).toBe('TRANSACTION_CONFLICT');
    }
    expect(await dbBalances(db, mallory.id)).toEqual({ SUBSCRIPTION: 0, CONSUMABLE: 0, REWARD: 0, PROMOTIONAL: 0 });
    expect(await dbSubscription(db, mallory.id)).toBeNull();
  });

  test('[NEG] concurrent duplicate deliveries of one purchase grant exactly once', async ({ api, db }) => {
    const user = await newUser(api, 'sub-dupes');
    const tx = uid('sub');
    const responses = await Promise.all(Array.from({ length: 10 }, () => subscribe(api, user, 'ULTRA_WEEKLY', 'APPROVED', tx)));
    expect(responses.map((r) => r.status()).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    expect(await dbLedger(db, user.id, 'SUBSCRIPTION_GRANT')).toHaveLength(1);
    expect((await dbBalances(db, user.id)).SUBSCRIPTION).toBe(12000);
    await expectLedgerConsistent(db, user.id);
  });

  test('[NEG] an active subscriber cannot purchase again (PRD §7 #7 unresolved): 409 ALREADY_SUBSCRIBED, no change', async ({ api, db }) => {
    const user = await newUser(api, 'double');
    await subscribe(api, user, 'PREMIUM_WEEKLY');
    for (const plan of ['PREMIUM_WEEKLY', 'BASIC_WEEKLY', 'ULTRA_WEEKLY']) {
      const response = await subscribe(api, user, plan);
      expect(response.status()).toBe(409);
      expect((await response.json()).error.code).toBe('ALREADY_SUBSCRIBED');
    }
    expect((await dbBalances(db, user.id)).SUBSCRIPTION).toBe(6000);
  });

  test('[NEG] validation: unknown plan, bad ids, extra fields, client-supplied dates/credits are rejected', async ({ api }) => {
    const user = await newUser(api, 'sub-validate');
    const bad = [
      { planId: 'GOLD_WEEKLY', transactionId: uid('t'), mockOutcome: 'APPROVED' },
      { planId: 'BASIC_WEEKLY', transactionId: 'has space', mockOutcome: 'APPROVED' },
      { planId: 'BASIC_WEEKLY', transactionId: uid('t'), mockOutcome: 'MAYBE' },
      { planId: 'BASIC_WEEKLY', transactionId: uid('t'), mockOutcome: 'APPROVED', credits: 999999 },
      { planId: 'BASIC_WEEKLY', transactionId: uid('t'), mockOutcome: 'APPROVED', startsAt: '2020-01-01T00:00:00Z' },
      { planId: 'BASIC_WEEKLY' },
    ];
    for (const data of bad) {
      const response = await api.post('/subscriptions/purchase', { headers: bearer(user.token), data });
      expect(response.status(), JSON.stringify(data)).toBe(400);
      expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
    }
    expect((await current(api, user)).subscription).toBeNull();
  });

  test('[NEG] every subscription route requires authentication', async ({ api }) => {
    for (const [method, path] of [
      ['get', '/subscriptions/current'], ['get', '/subscriptions/history'], ['post', '/subscriptions/purchase'],
      ['post', '/subscriptions/change-plan'], ['post', '/subscriptions/cancel'], ['post', '/subscriptions/resume'],
      ['post', '/subscriptions/restore'], ['post', '/subscriptions/mock-notifications'],
    ] as const) {
      const response = await api[method](path, method === 'post' ? { data: {} } : {});
      expect(response.status(), path).toBe(401);
    }
  });

  test('[NEG] cross-user isolation: notifications can only target the caller\'s own transactions', async ({ api, db }) => {
    const alice = await newUser(api, 'alice');
    const mallory = await newUser(api, 'mallory');
    const aliceTx = uid('sub');
    await subscribe(api, alice, 'ULTRA_WEEKLY', 'APPROVED', aliceTx);
    for (const type of ['REFUNDED', 'REVOKED', 'EXPIRED'] as const) {
      const response = await notify(api, mallory, { type, transactionId: aliceTx });
      expect(response.status(), type).toBe(409);
      expect((await response.json()).error.code).toBe('UNKNOWN_TRANSACTION');
    }
    expect(await dbSubscription(db, alice.id)).toMatchObject({ status: 'ACTIVE', plan_id: 'ULTRA_WEEKLY' });
    expect((await dbBalances(db, alice.id)).SUBSCRIPTION).toBe(12000);
    expect((await current(api, mallory)).subscription).toBeNull();
    const history = await (await api.get('/subscriptions/history', { headers: bearer(mallory.token) })).json();
    expect(history).toEqual({ periods: [], events: expect.any(Array) });
    expect(JSON.stringify(history)).not.toContain(aliceTx);
  });
});

test.describe('plan changes (SUB-03/04)', () => {
  test('[BR][SUB-03] upgrade: remaining Basic credits expire, full Premium 6,000 granted; consumables untouched', async ({ api, db }) => {
    const user = await newUser(api, 'upgrade');
    await buy(api, user, 'CREDITS_S'); // 5,000 consumable
    await subscribe(api, user, 'PREMIUM_WEEKLY'); // no trial on Premium
    await notify(api, user, { type: 'REFUNDED', transactionId: (await current(api, user)).subscription.currentPeriod.transactionId });
    // Paid Basic now (user had a period already, so no trial): 3,000, then spend 500 → 2,500 left.
    await subscribe(api, user, 'BASIC_WEEKLY');
    expect((await spend(api, user, 'STANDARD')).status()).toBe(201);
    expect(await dbBalances(db, user.id)).toEqual({ SUBSCRIPTION: 2500, CONSUMABLE: 5000, REWARD: 0, PROMOTIONAL: 0 });

    const response = await changePlan(api, user, 'PREMIUM_WEEKLY');
    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.result).toBe('UPGRADED');
    expect(body.period).toMatchObject({ kind: 'UPGRADE', planId: 'PREMIUM_WEEKLY', credits: 6000 });
    expect(body.subscription).toMatchObject({ planId: 'PREMIUM_WEEKLY', status: 'ACTIVE', entitled: true });
    expect(await dbBalances(db, user.id)).toEqual({ SUBSCRIPTION: 6000, CONSUMABLE: 5000, REWARD: 0, PROMOTIONAL: 0 });
    const expirations = await dbLedger(db, user.id, 'SUBSCRIPTION_EXPIRATION');
    expect(expirations.at(-1)).toEqual({ entry_type: 'SUBSCRIPTION_EXPIRATION', bucket: 'SUBSCRIPTION', delta: -2500, expiration_reason: 'SUPERSEDED' });
    expect((await dbAnalytics(db, user.id)).map((e) => e.name)).toContain('subscription_upgraded');
    await expectLedgerConsistent(db, user.id);
  });

  test('[BR] upgrading during the trial expires the trial remainder and grants the full new plan', async ({ api, db }) => {
    const user = await newUser(api, 'trial-upgrade');
    await subscribe(api, user, 'BASIC_WEEKLY');
    await spend(api, user, 'BASIC'); // 900 trial credits left
    const body = await (await changePlan(api, user, 'ULTRA_WEEKLY')).json();
    expect(body.result).toBe('UPGRADED');
    expect(body.subscription.status).toBe('ACTIVE');
    expect((await dbBalances(db, user.id)).SUBSCRIPTION).toBe(12000);
    expect((await dbLedger(db, user.id, 'SUBSCRIPTION_EXPIRATION')).map((e) => e.delta)).toEqual([-900]);
    expect((await dbAnalytics(db, user.id)).map((e) => e.name)).toEqual(['trial_started', 'subscription_upgraded', 'subscription_started']);
  });

  test('[NEG] a declined or cancelled upgrade changes nothing', async ({ api, db }) => {
    const user = await newUser(api, 'upgrade-declined');
    await subscribe(api, user, 'BASIC_WEEKLY');
    for (const outcome of ['DECLINED', 'CANCELLED']) {
      const body = await (await changePlan(api, user, 'ULTRA_WEEKLY', outcome)).json();
      expect(body.result).toBe(outcome);
      expect(body.subscription.planId).toBe('BASIC_WEEKLY');
    }
    expect(await dbBalances(db, user.id)).toEqual({ SUBSCRIPTION: 1000, CONSUMABLE: 0, REWARD: 0, PROMOTIONAL: 0 });
    expect(await dbLedger(db, user.id, 'SUBSCRIPTION_EXPIRATION')).toEqual([]);
  });

  test('[BR][SUB-04] downgrade request: no immediate credit change; plan and credits kept until renewal', async ({ api, db }) => {
    const user = await newUser(api, 'downgrade');
    await subscribe(api, user, 'ULTRA_WEEKLY');
    await spend(api, user, 'ADVANCED');
    const before = await dbLedger(db, user.id);
    const response = await changePlan(api, user, 'BASIC_WEEKLY');
    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.result).toBe('DOWNGRADE_SCHEDULED');
    expect(body.period).toBeNull();
    expect(body.subscription).toMatchObject({ planId: 'ULTRA_WEEKLY', pendingPlanId: 'BASIC_WEEKLY', entitled: true });
    expect(await dbLedger(db, user.id)).toEqual(before);
    expect((await dbBalances(db, user.id)).SUBSCRIPTION).toBe(11200);
    // Choosing the current plan again cancels the scheduled downgrade.
    const undo = await (await changePlan(api, user, 'ULTRA_WEEKLY')).json();
    expect(undo.result).toBe('DOWNGRADE_CANCELLED');
    expect(undo.subscription.pendingPlanId).toBeNull();
  });

  test('[NEG] plan change errors: no subscription, same plan', async ({ api }) => {
    const user = await newUser(api, 'change-errors');
    let response = await changePlan(api, user, 'PREMIUM_WEEKLY');
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe('NO_ACTIVE_SUBSCRIPTION');
    await subscribe(api, user, 'PREMIUM_WEEKLY');
    response = await changePlan(api, user, 'PREMIUM_WEEKLY');
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe('SAME_PLAN');
  });
});

test.describe('cancellation, refund and revocation (SUB-06)', () => {
  test('[BR] cancelling auto-renew keeps the paid entitlement and credits; repeat is a no-op; resume restores', async ({ api, db }) => {
    const user = await newUser(api, 'cancel');
    await subscribe(api, user, 'PREMIUM_WEEKLY');
    const requestId = uid('cancel');
    const response = await cancelAutoRenew(api, user, requestId);
    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.result).toBe('AUTO_RENEW_DISABLED');
    expect(body.subscription).toMatchObject({ status: 'ACTIVE', entitled: true, autoRenew: false, renewsAt: null });
    expect(body.subscription.expiresAt).toBe(body.subscription.currentPeriod.endsAt);
    expect((await dbBalances(db, user.id)).SUBSCRIPTION).toBe(6000);
    // Same request id → replay; new id → no-op.
    expect((await cancelAutoRenew(api, user, requestId)).status()).toBe(200);
    expect((await (await cancelAutoRenew(api, user)).json()).result).toBe('ALREADY_CANCELLED');
    expect((await dbAnalytics(db, user.id)).filter((e) => e.name === 'subscription_cancelled')).toHaveLength(1);
    // Downgrade needs a next renewal.
    expect((await (await changePlan(api, user, 'BASIC_WEEKLY')).json()).error.code).toBe('AUTO_RENEW_DISABLED');
    const resumed = await api.post('/subscriptions/resume', { headers: bearer(user.token), data: { requestId: uid('resume') } });
    expect((await resumed.json()).subscription).toMatchObject({ autoRenew: true, entitled: true });
  });

  test('[BR][SUB-06] refund of the current period: remaining credits expire, spent credits stay spent, never negative', async ({ api, db }) => {
    const user = await newUser(api, 'refund');
    await buy(api, user, 'CREDITS_M'); // 7,000 consumable, must survive
    const tx = uid('sub');
    await subscribe(api, user, 'PREMIUM_WEEKLY', 'APPROVED', tx);
    await spend(api, user, 'ADVANCED'); // 800 from SUBSCRIPTION
    const eventId = uid('evt');
    const response = await notify(api, user, { type: 'REFUNDED', transactionId: tx, eventId });
    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.result).toBe('REVOKED_CURRENT');
    expect(body.subscription).toMatchObject({ status: 'REVOKED', entitled: false, autoRenew: false });
    expect(await dbBalances(db, user.id)).toEqual({ SUBSCRIPTION: 0, CONSUMABLE: 7000, REWARD: 0, PROMOTIONAL: 0 });
    // History preserved: the grant, the debit and the expiration are all still there.
    expect((await dbLedger(db, user.id)).map((e) => [e.entry_type, e.delta])).toEqual([
      ['PURCHASE_GRANT', 7000], ['SUBSCRIPTION_GRANT', 6000], ['OPERATION_DEBIT', -800], ['SUBSCRIPTION_EXPIRATION', -5200],
    ]);
    // Same event again → replay; another event for the same refund → ignored; nothing changes.
    expect((await notify(api, user, { type: 'REFUNDED', transactionId: tx, eventId })).status()).toBe(200);
    expect((await (await notify(api, user, { type: 'REVOKED', transactionId: tx })).json()).result).toBe('IGNORED_ALREADY_REVOKED');
    expect((await dbLedger(db, user.id, 'SUBSCRIPTION_EXPIRATION'))).toHaveLength(1);
    expect((await dbAnalytics(db, user.id)).filter((e) => e.name === 'subscription_refunded')).toHaveLength(1);
    await expectLedgerConsistent(db, user.id);
  });

  test('[NEG] event ordering cannot restore a revoked entitlement (renewal / upgrade / cancel after refund)', async ({ api, db }) => {
    const user = await newUser(api, 'revoked-order');
    const tx = uid('sub');
    await subscribe(api, user, 'BASIC_WEEKLY', 'APPROVED', tx); // trial
    await notify(api, user, { type: 'REVOKED', transactionId: tx });
    const start = (await current(api, user)).subscription.currentPeriod.startsAt;
    // A delayed renewal claiming to start just after the trial start.
    const late = await notify(api, user, { type: 'RENEWED', transactionId: uid('ren'), periodStart: new Date(Date.parse(start) + 1).toISOString() });
    expect(late.status()).toBe(200);
    expect((await late.json()).result).toBe('IGNORED_REVOKED');
    expect((await changePlan(api, user, 'ULTRA_WEEKLY')).status()).toBe(409);
    expect((await cancelAutoRenew(api, user)).status()).toBe(409);
    expect(await dbSubscription(db, user.id)).toMatchObject({ status: 'REVOKED', auto_renew: false });
    expect((await dbBalances(db, user.id)).SUBSCRIPTION).toBe(0);
    expect(await dbLedger(db, user.id, 'SUBSCRIPTION_GRANT')).toHaveLength(1);
    // The DB itself refuses to re-activate a revoked subscription without a new period.
    await expect(db.query(`UPDATE subscriptions SET status = 'ACTIVE', auto_renew = true WHERE user_id = $1`, [user.id]))
      .rejects.toThrow(/revoked subscription can only be reactivated by a new purchase/);
  });

  test('[NEG] notifications: duplicate event id with a different payload is a 409; unknown transaction 409', async ({ api }) => {
    const user = await newUser(api, 'notif-errors');
    const tx = uid('sub');
    await subscribe(api, user, 'BASIC_WEEKLY', 'APPROVED', tx);
    const eventId = uid('evt');
    expect((await notify(api, user, { type: 'REVOKED', transactionId: tx, eventId })).status()).toBe(201);
    const conflict = await notify(api, user, { type: 'REFUNDED', transactionId: tx, eventId });
    expect(conflict.status()).toBe(409);
    expect((await conflict.json()).error.code).toBe('EVENT_CONFLICT');
    const unknown = await notify(api, user, { type: 'REFUNDED', transactionId: uid('none') });
    expect((await unknown.json()).error.code).toBe('UNKNOWN_TRANSACTION');
    const early = await notify(api, user, { type: 'RENEWED', transactionId: uid('ren') });
    expect(early.status()).toBe(409);
    expect((await early.json()).error.code).toBe('RENEWAL_NOT_DUE');
  });
});

test.describe('spending, history and restore', () => {
  test('[BR][CR-01] subscription credits are spent first, then consumable; ordering unchanged in M2', async ({ api, db }) => {
    const user = await newUser(api, 'spend-order');
    await seed(db, user, { REWARD: 400, PROMOTIONAL: 1000 });
    await buy(api, user, 'CREDITS_S');
    await subscribe(api, user, 'BASIC_WEEKLY'); // trial: 1,000 SUBSCRIPTION
    const body = await (await spend(api, user, 'ADVANCED')).json();
    expect(body.operation.debits).toEqual({ SUBSCRIPTION: 800, CONSUMABLE: 0, REWARD: 0, PROMOTIONAL: 0 });
    const second = await (await spend(api, user, 'STANDARD')).json();
    expect(second.operation.debits).toEqual({ SUBSCRIPTION: 200, CONSUMABLE: 300, REWARD: 0, PROMOTIONAL: 0 });
    await expectLedgerConsistent(db, user.id);
  });

  test('[BR] /history itemizes subscription grants/expirations with their period; /subscriptions/history lists periods and events', async ({ api }) => {
    const user = await newUser(api, 'sub-history');
    await subscribe(api, user, 'BASIC_WEEKLY');
    await changePlan(api, user, 'PREMIUM_WEEKLY');
    const ledger = (await (await api.get('/history', { headers: bearer(user.token) })).json()).entries;
    expect(ledger.map((e: { type: string; delta: number; expirationReason?: string; subscriptionPeriod?: { kind: string; planId: string } }) =>
      [e.type, e.delta, e.expirationReason ?? null, e.subscriptionPeriod?.kind, e.subscriptionPeriod?.planId])).toEqual([
      ['SUBSCRIPTION_GRANT', 6000, null, 'UPGRADE', 'PREMIUM_WEEKLY'],
      ['SUBSCRIPTION_EXPIRATION', -1000, 'SUPERSEDED', 'TRIAL', 'BASIC_WEEKLY'],
      ['SUBSCRIPTION_GRANT', 1000, null, 'TRIAL', 'BASIC_WEEKLY'],
    ]);
    const history = await (await api.get('/subscriptions/history', { headers: bearer(user.token) })).json();
    expect(history.periods.map((p: { kind: string; creditsGranted: number; creditsExpired: number }) => [p.kind, p.creditsGranted, p.creditsExpired]))
      .toEqual([['UPGRADE', 6000, 0], ['TRIAL', 1000, 1000]]);
    expect(history.events.map((e: { type: string; result: string }) => [e.type, e.result])).toEqual([
      ['CHANGE_PLAN', 'UPGRADED'], ['PURCHASE', 'TRIAL_STARTED'],
    ]);
  });

  test('[BR] restore re-syncs the authoritative backend state without changing it', async ({ api, db }) => {
    const user = await newUser(api, 'restore');
    await subscribe(api, user, 'ULTRA_WEEKLY');
    const before = await dbLedger(db, user.id);
    const response = await api.post('/subscriptions/restore', { headers: bearer(user.token) });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ restored: true, subscription: { planId: 'ULTRA_WEEKLY', entitled: true } });
    expect(body.wallet.balances.SUBSCRIPTION).toBe(12000);
    expect(await dbLedger(db, user.id)).toEqual(before);
  });
});
