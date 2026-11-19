/**
 * M2 rewarded ads over HTTP (PRD §3.1, §3.2: ADS-01..04). Real server clock; the exact UTC-midnight boundary and the
 * next-day reset are in lifecycle-time.spec.ts (controlled clock).
 */
import { test, expect } from './support/fixtures.ts';
import {
  bearer, buy, dbAnalytics, dbBalances, dbLedger, expectLedgerConsistent, newUser, spend, subscribe, uid, watchAd,
  type TestUser,
} from './support/helpers.ts';
import type pg from 'pg';

async function quota(api: Parameters<typeof watchAd>[0], user: TestUser, action?: string) {
  const response = await api.get(`/ads/quota${action ? `?action=${action}` : ''}`, { headers: bearer(user.token) });
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

/** The realistic paywall loop: ad for BASIC (100), then spend it, so credits stay insufficient for the next ad. */
async function watchAndSpend(api: Parameters<typeof watchAd>[0], user: TestUser, times: number) {
  for (let i = 1; i <= times; i++) {
    expect((await watchAd(api, user, 'COMPLETED', 'BASIC')).status(), `ad ${i}`).toBe(201);
    expect((await spend(api, user, 'BASIC')).status(), `spend ${i}`).toBe(201);
  }
}

async function dbAttempts(db: pg.Pool, userId: string) {
  const { rows } = await db.query<{ ad_outcome: string; status: string; reward_slot: number | null; credits: number }>(
    'SELECT ad_outcome, status, reward_slot, credits FROM ad_rewards WHERE user_id = $1 ORDER BY created_at, id',
    [userId],
  );
  return rows;
}

test.describe('rewarded ads', () => {
  test('[BR][ADS-01] a verified completion grants exactly 100 REWARD credits and uses one quota slot', async ({ api, db }) => {
    const user = await newUser(api, 'ad-ok');
    const q0 = await quota(api, user, 'BASIC');
    expect(q0.quota).toMatchObject({ used: 0, limit: 10, remaining: 10, rewardCredits: 100 });
    expect(q0.quota.utcDay).toBe(q0.serverTime.slice(0, 10));
    expect(q0.eligibility).toMatchObject({ action: 'BASIC', eligible: true, reason: 'INSUFFICIENT_CREDITS', required: 100, available: 0 });

    const response = await watchAd(api, user, 'COMPLETED', 'BASIC');
    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ result: 'REWARDED', replayed: false, creditsGranted: 100 });
    expect(body.quota).toMatchObject({ used: 1, remaining: 9 });
    expect(body.wallet.balances).toEqual({ SUBSCRIPTION: 0, CONSUMABLE: 0, REWARD: 100, PROMOTIONAL: 0 });
    expect(await dbLedger(db, user.id, 'REWARD_GRANT')).toEqual([{ entry_type: 'REWARD_GRANT', bucket: 'REWARD', delta: 100, expiration_reason: null }]);
    expect(await dbAttempts(db, user.id)).toEqual([{ ad_outcome: 'COMPLETED', status: 'REWARDED', reward_slot: 1, credits: 100 }]);
    expect((await dbAnalytics(db, user.id)).map((e) => e.name)).toEqual(['reward_granted']);
    // PW-02 (API side): with 100 credits the BASIC operation is now affordable and the ad is no longer offered.
    expect((await quota(api, user, 'BASIC')).eligibility).toMatchObject({ eligible: false, reason: 'CREDITS_SUFFICIENT' });
    await expectLedgerConsistent(db, user.id);
  });

  test('[NEG][ADS-02] incomplete and failed ads grant nothing and leave the quota unchanged (but are audited)', async ({ api, db }) => {
    const user = await newUser(api, 'ad-incomplete');
    for (const outcome of ['INCOMPLETE', 'FAILED']) {
      const response = await watchAd(api, user, outcome);
      expect(response.status()).toBe(201);
      expect(await response.json()).toMatchObject({ result: 'NOT_REWARDED', creditsGranted: 0, quota: { used: 0, remaining: 10 } });
    }
    // Missing mockOutcome fails closed (FAILED).
    const implicit = await api.post('/ads/rewards', { headers: bearer(user.token), data: { adEventId: uid('ad'), action: 'BASIC' } });
    expect((await implicit.json()).attempt.outcome).toBe('FAILED');
    expect(await dbBalances(db, user.id)).toEqual({ SUBSCRIPTION: 0, CONSUMABLE: 0, REWARD: 0, PROMOTIONAL: 0 });
    expect((await dbAttempts(db, user.id)).map((a) => [a.ad_outcome, a.status])).toEqual([
      ['INCOMPLETE', 'NOT_REWARDED'], ['FAILED', 'NOT_REWARDED'], ['FAILED', 'NOT_REWARDED'],
    ]);
    expect(await dbAnalytics(db, user.id)).toEqual([]);
  });

  test('[NEG][ADS-03] the 11th completed ad in a UTC day is rejected by the server and audited; quota shows 10/10', async ({ api, db }) => {
    const user = await newUser(api, 'ad-cap');
    await watchAndSpend(api, user, 10);
    const q = await quota(api, user, 'BASIC');
    expect(q.quota).toMatchObject({ used: 10, remaining: 0 });
    // The UI disables the option from this flag (eligible=false because the daily limit is reached).
    expect(q.eligibility).toMatchObject({ eligible: false, reason: 'DAILY_LIMIT_REACHED' });
    expect(Date.parse(q.quota.resetsAt)).toBe(Date.parse(`${q.quota.utcDay}T00:00:00.000Z`) + 24 * 3600 * 1000);

    const eleventh = await watchAd(api, user, 'COMPLETED', 'BASIC');
    expect(eleventh.status()).toBe(429);
    const error = (await eleventh.json()).error;
    expect(error.code).toBe('DAILY_AD_LIMIT_REACHED');
    expect(error.quota).toMatchObject({ used: 10, remaining: 0 });
    // 10 x 100 granted, 10 x 100 spent: the ledger, not the response, is the oracle.
    expect((await dbLedger(db, user.id, 'REWARD_GRANT')).length).toBe(10);
    expect(await dbBalances(db, user.id)).toEqual({ SUBSCRIPTION: 0, CONSUMABLE: 0, REWARD: 0, PROMOTIONAL: 0 });
    const attempts = await dbAttempts(db, user.id);
    expect(attempts.filter((a) => a.status === 'REWARDED').map((a) => a.reward_slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(attempts.at(-1)).toEqual({ ad_outcome: 'COMPLETED', status: 'LIMIT_REACHED', reward_slot: null, credits: 0 });
    expect((await dbAnalytics(db, user.id)).filter((e) => e.name === 'reward_granted')).toHaveLength(10);
    // Incomplete ads after the cap are still not rewarded and do not change the count.
    expect((await (await watchAd(api, user, 'INCOMPLETE', 'BASIC')).json()).quota.used).toBe(10);
  });

  test('[NEG][ADS-04] duplicate reward events grant zero additional credit and use zero additional quota', async ({ api, db }) => {
    const user = await newUser(api, 'ad-dupe');
    const adEventId = uid('ad');
    expect((await watchAd(api, user, 'COMPLETED', 'ADVANCED', adEventId)).status()).toBe(201);
    for (let i = 0; i < 3; i++) {
      const replay = await watchAd(api, user, 'COMPLETED', 'ADVANCED', adEventId);
      expect(replay.status()).toBe(200);
      expect(await replay.json()).toMatchObject({ result: 'REWARDED', replayed: true, creditsGranted: 0, quota: { used: 1 } });
    }
    const conflict = await watchAd(api, user, 'INCOMPLETE', 'ADVANCED', adEventId);
    expect(conflict.status()).toBe(409);
    expect((await conflict.json()).error.code).toBe('AD_EVENT_CONFLICT');
    expect((await dbBalances(db, user.id)).REWARD).toBe(100);
    expect(await dbAttempts(db, user.id)).toHaveLength(1);
  });

  test('[NEG][ADS-04] 10 concurrent deliveries of the SAME ad event: one grant, nine idempotent replays (no conflicts)', async ({ api, db }) => {
    const user = await newUser(api, 'ad-same-race');
    const adEventId = uid('ad');
    const responses = await Promise.all(Array.from({ length: 10 }, () => watchAd(api, user, 'COMPLETED', 'ADVANCED', adEventId)));
    expect(responses.map((r) => r.status()).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    for (const r of responses) expect((await r.json()).quota.used).toBe(1);
    expect((await dbBalances(db, user.id)).REWARD).toBe(100);
    expect(await dbAttempts(db, user.id)).toHaveLength(1);
    expect((await dbAnalytics(db, user.id)).filter((e) => e.name === 'reward_granted')).toHaveLength(1);
  });

  test('[NEG][ADS-04] 25 concurrent completed ads for ADVANCED: grants stop exactly when credits suffice (8 x 100)', async ({ api, db }) => {
    const user = await newUser(api, 'ad-race');
    const responses = await Promise.all(Array.from({ length: 25 }, () => watchAd(api, user, 'COMPLETED', 'ADVANCED')));
    const statuses = responses.map((r) => r.status());
    expect(statuses.filter((s) => s === 201)).toHaveLength(8);
    expect(statuses.filter((s) => s !== 201).every((s) => s === 409)).toBe(true);
    expect((await dbBalances(db, user.id)).REWARD).toBe(800);
    await expectLedgerConsistent(db, user.id);
  });

  test('[NEG][ADS-04] concurrent claims at the cap boundary: with 9/10 used, 10 parallel claims grant exactly one', async ({ api, db }) => {
    const user = await newUser(api, 'ad-race-cap');
    await watchAndSpend(api, user, 9);
    const responses = await Promise.all(Array.from({ length: 10 }, () => watchAd(api, user, 'COMPLETED', 'ADVANCED')));
    const statuses = responses.map((r) => r.status()).sort();
    expect(statuses).toEqual([201, 429, 429, 429, 429, 429, 429, 429, 429, 429]);
    const { rows } = await db.query(
      `SELECT count(*)::int AS n, max(reward_slot)::int AS top FROM ad_rewards WHERE user_id = $1 AND status = 'REWARDED'`, [user.id]);
    expect(rows[0]).toEqual({ n: 10, top: 10 });
    expect((await dbBalances(db, user.id)).REWARD).toBe(100);
    await expectLedgerConsistent(db, user.id);
  });

  test('[BR] subscribed and trial users with insufficient credits may watch ads; a paid plan is not an exclusion', async ({ api, db }) => {
    const user = await newUser(api, 'ad-subscribed');
    await subscribe(api, user, 'BASIC_WEEKLY'); // trial: 1,000 SUBSCRIPTION
    await spend(api, user, 'ADVANCED'); // 200 left
    const q = await quota(api, user, 'ADVANCED');
    expect(q.eligibility).toMatchObject({ eligible: true, required: 800, available: 200 });
    expect((await watchAd(api, user, 'COMPLETED', 'ADVANCED')).status()).toBe(201);
    expect(await dbBalances(db, user.id)).toEqual({ SUBSCRIPTION: 200, CONSUMABLE: 0, REWARD: 100, PROMOTIONAL: 0 });
  });

  test('[NEG] ads are not offered when credits already cover the action (no ad farm, PRD §7 #5); the attempt is audited', async ({ api, db }) => {
    const user = await newUser(api, 'ad-farm');
    await buy(api, user, 'CREDITS_S');
    const response = await watchAd(api, user, 'COMPLETED', 'ADVANCED');
    expect(response.status()).toBe(409);
    expect((await response.json()).error).toMatchObject({ code: 'AD_NOT_ELIGIBLE', required: 800, available: 5000 });
    expect((await dbBalances(db, user.id)).REWARD).toBe(0);
    expect(await dbAttempts(db, user.id)).toEqual([{ ad_outcome: 'COMPLETED', status: 'NOT_ELIGIBLE', reward_slot: null, credits: 0 }]);
    expect((await quota(api, user)).quota.used).toBe(0);
  });

  test('[NEG] cross-user: another user cannot reuse an adEventId; quotas are per user', async ({ api, db }) => {
    const alice = await newUser(api, 'alice');
    const mallory = await newUser(api, 'mallory');
    const adEventId = uid('ad');
    await watchAd(api, alice, 'COMPLETED', 'ADVANCED', adEventId);
    const stolen = await watchAd(api, mallory, 'COMPLETED', 'ADVANCED', adEventId);
    expect(stolen.status()).toBe(409);
    expect((await stolen.json()).error.code).toBe('AD_EVENT_CONFLICT');
    expect((await dbBalances(db, mallory.id)).REWARD).toBe(0);
    expect((await quota(api, mallory)).quota.used).toBe(0);
    expect((await quota(api, alice)).quota.used).toBe(1);
  });

  test('[NEG] validation and auth: no client time or credit amount is accepted; unauthenticated is 401', async ({ api }) => {
    const user = await newUser(api, 'ad-validate');
    for (const data of [
      { adEventId: uid('ad'), action: 'BASIC', mockOutcome: 'COMPLETED', utcDay: '2020-01-01' },
      { adEventId: uid('ad'), action: 'BASIC', mockOutcome: 'COMPLETED', credits: 1000 },
      { adEventId: uid('ad'), action: 'MEGA', mockOutcome: 'COMPLETED' },
      { adEventId: uid('ad'), action: 'BASIC', mockOutcome: 'WATCHED' },
      { action: 'BASIC', mockOutcome: 'COMPLETED' },
    ]) {
      const response = await api.post('/ads/rewards', { headers: bearer(user.token), data });
      expect(response.status(), JSON.stringify(data)).toBe(400);
    }
    expect((await api.get('/ads/quota?action=MEGA', { headers: bearer(user.token) })).status()).toBe(400);
    expect((await api.get('/ads/quota')).status()).toBe(401);
    expect((await api.post('/ads/rewards', { data: {} })).status()).toBe(401);
  });
});
