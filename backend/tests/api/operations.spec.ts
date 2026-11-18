import { randomUUID } from 'node:crypto';
import { expect, test } from './support/fixtures.ts';
import { bearer, buy, dbBalances, expectLedgerConsistent, newUser, seed, spend, type TestUser } from './support/helpers.ts';

// Credit spending: CR-01..03, PRD §2.3–2.4, D-007, D-008, D-009, DV-002.
// Categories (D-005): [BR] business rule, [INT] integration, [NEG] negative/edge case.
// Expected balances are calculated by hand in each test from PRD rules, not read back from the API.

type Balances = { SUBSCRIPTION: number; CONSUMABLE: number; REWARD: number; PROMOTIONAL: number };

async function fund(api: import('@playwright/test').APIRequestContext, db: import('pg').Pool, user: TestUser, target: Balances) {
  // CONSUMABLE can only come from purchases (DV-001/003): buy CREDITS_S (5,000), then spend the excess down
  // with SUBSCRIPTION/REWARD/PROMOTIONAL still empty, so the debits come only from CONSUMABLE.
  if (target.CONSUMABLE > 0) {
    expect((await buy(api, user, 'CREDITS_S')).status()).toBe(201);
    let excess = 5000 - target.CONSUMABLE;
    for (const [action, cost] of [['ADVANCED', 800], ['STANDARD', 500], ['BASIC', 100]] as const) {
      while (excess >= cost) {
        expect((await spend(api, user, action)).status()).toBe(201);
        excess -= cost;
      }
    }
    expect(excess).toBe(0);
  }
  await seed(db, user, { SUBSCRIPTION: target.SUBSCRIPTION, REWARD: target.REWARD, PROMOTIONAL: target.PROMOTIONAL });
  expect(await dbBalances(db, user.id)).toEqual(target);
}

async function operationCount(db: import('pg').Pool, userId: string): Promise<number> {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM operations WHERE user_id = $1', [userId]);
  return rows[0].n;
}

test.describe('CR-01 ordered, atomic debits', () => {
  test('[BR][CR-01] PRD §2.4 example: 200/300/400/1000, 800 → debits 200+300+300+0, leaves 0/0/100/1000', async ({ api, db }) => {
    const user = await newUser(api);
    await fund(api, db, user, { SUBSCRIPTION: 200, CONSUMABLE: 300, REWARD: 400, PROMOTIONAL: 1000 });
    const response = await spend(api, user, 'ADVANCED');
    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.operation).toMatchObject({ action: 'ADVANCED', cost: 800 });
    expect(body.operation.debits).toEqual({ SUBSCRIPTION: 200, CONSUMABLE: 300, REWARD: 300, PROMOTIONAL: 0 });
    expect(body.operation.result.status).toBe('COMPLETED');
    expect(body.wallet.balances).toEqual({ SUBSCRIPTION: 0, CONSUMABLE: 0, REWARD: 100, PROMOTIONAL: 1000 });
    expect(await dbBalances(db, user.id)).toEqual({ SUBSCRIPTION: 0, CONSUMABLE: 0, REWARD: 100, PROMOTIONAL: 1000 });
    const { rows } = await db.query(
      // Order by the enum column (priority order), not by the text alias.
      `SELECT l.bucket::text AS bucket, l.delta FROM credit_ledger l WHERE l.operation_id = $1 ORDER BY l.bucket`,
      [body.operation.id],
    );
    expect(rows).toEqual([
      { bucket: 'SUBSCRIPTION', delta: -200 },
      { bucket: 'CONSUMABLE', delta: -300 },
      { bucket: 'REWARD', delta: -300 },
    ]);
    await expectLedgerConsistent(db, user.id);
  });

  const cases: Array<[string, Balances, 'BASIC' | 'STANDARD' | 'ADVANCED', Balances]> = [
    ['SUBSCRIPTION covers everything', { SUBSCRIPTION: 1000, CONSUMABLE: 0, REWARD: 500, PROMOTIONAL: 500 }, 'STANDARD', { SUBSCRIPTION: 500, CONSUMABLE: 0, REWARD: 500, PROMOTIONAL: 500 }],
    ['REWARD before PROMOTIONAL', { SUBSCRIPTION: 0, CONSUMABLE: 0, REWARD: 100, PROMOTIONAL: 1000 }, 'STANDARD', { SUBSCRIPTION: 0, CONSUMABLE: 0, REWARD: 0, PROMOTIONAL: 600 }],
    ['only PROMOTIONAL', { SUBSCRIPTION: 0, CONSUMABLE: 0, REWARD: 0, PROMOTIONAL: 800 }, 'ADVANCED', { SUBSCRIPTION: 0, CONSUMABLE: 0, REWARD: 0, PROMOTIONAL: 0 }],
    ['exact total across all four buckets', { SUBSCRIPTION: 100, CONSUMABLE: 100, REWARD: 100, PROMOTIONAL: 500 }, 'ADVANCED', { SUBSCRIPTION: 0, CONSUMABLE: 0, REWARD: 0, PROMOTIONAL: 0 }],
    ['BASIC 100 from SUBSCRIPTION', { SUBSCRIPTION: 100, CONSUMABLE: 5000, REWARD: 0, PROMOTIONAL: 0 }, 'BASIC', { SUBSCRIPTION: 0, CONSUMABLE: 5000, REWARD: 0, PROMOTIONAL: 0 }],
  ];
  for (const [label, start, action, end] of cases) {
    test(`[BR][CR-01] ${label}`, async ({ api, db }) => {
      const user = await newUser(api);
      await fund(api, db, user, start);
      const response = await spend(api, user, action);
      expect(response.status()).toBe(201);
      expect(await dbBalances(db, user.id)).toEqual(end);
      await expectLedgerConsistent(db, user.id);
    });
  }

  test('[BR] operation costs are exactly 100 / 500 / 800 and cannot be set by the client', async ({ api, db }) => {
    const user = await newUser(api);
    await seed(db, user, { PROMOTIONAL: 1400 });
    for (const [action, cost] of [['BASIC', 100], ['STANDARD', 500], ['ADVANCED', 800]] as const) {
      const body = await (await spend(api, user, action)).json();
      expect(body.operation.cost).toBe(cost);
    }
    expect((await dbBalances(db, user.id)).PROMOTIONAL).toBe(0);
    const response = await api.post('/operations', { headers: bearer(user.token), data: { action: 'BASIC', requestId: 'r-cost', cost: 1 } });
    expect(response.status()).toBe(400);
  });
});

test.describe('CR-02 insufficient credits', () => {
  test('[NEG][CR-02] one credit short: 402 INSUFFICIENT_CREDITS, zero debits, no operation or ledger rows', async ({ api, db }) => {
    const user = await newUser(api);
    await seed(db, user, { SUBSCRIPTION: 200, REWARD: 199, PROMOTIONAL: 400 }); // total 799
    const before = await dbBalances(db, user.id);
    const ledgerBefore = await db.query('SELECT count(*)::int AS n FROM credit_ledger WHERE user_id = $1', [user.id]);
    const response = await spend(api, user, 'ADVANCED');
    expect(response.status()).toBe(402);
    expect(await response.json()).toEqual({
      error: { code: 'INSUFFICIENT_CREDITS', message: 'Not enough credits for this operation', required: 800, available: 799 },
    });
    expect(await dbBalances(db, user.id)).toEqual(before);
    const ledgerAfter = await db.query('SELECT count(*)::int AS n FROM credit_ledger WHERE user_id = $1', [user.id]);
    expect(ledgerAfter.rows[0].n).toBe(ledgerBefore.rows[0].n);
    expect(await operationCount(db, user.id)).toBe(0);
  });

  test('[NEG][CR-02] a new user with no credits gets 402 for every action', async ({ api }) => {
    const user = await newUser(api);
    for (const [action, cost] of [['BASIC', 100], ['STANDARD', 500], ['ADVANCED', 800]] as const) {
      const response = await spend(api, user, action);
      expect(response.status()).toBe(402);
      expect((await response.json()).error).toMatchObject({ code: 'INSUFFICIENT_CREDITS', required: cost, available: 0 });
    }
  });

  test('[BR][PW-02] after a 402, buying credits makes the same operation succeed only when explicitly retried', async ({ api, db }) => {
    const user = await newUser(api);
    const blocked = await spend(api, user, 'STANDARD', 'req-blocked');
    expect(blocked.status()).toBe(402);
    expect((await buy(api, user, 'CREDITS_S')).status()).toBe(201);
    // The server never runs the blocked operation by itself: nothing was debited by the purchase.
    expect(await operationCount(db, user.id)).toBe(0);
    expect((await dbBalances(db, user.id)).CONSUMABLE).toBe(5000);
    // An explicit new confirmation (same request id is fine: a 402 records nothing) now succeeds.
    expect((await spend(api, user, 'STANDARD', 'req-blocked')).status()).toBe(201);
    expect((await dbBalances(db, user.id)).CONSUMABLE).toBe(4500);
  });
});

test.describe('CR-03 concurrency and idempotency', () => {
  test('[NEG][CR-03] 10 concurrent 800-credit operations with 5,000 credits: exactly 6 succeed, 4 get 402, never negative', async ({ api, db }) => {
    const user = await newUser(api);
    expect((await buy(api, user, 'CREDITS_S')).status()).toBe(201);
    const statuses = await Promise.all(Array.from({ length: 10 }, async () => (await spend(api, user, 'ADVANCED')).status()));
    expect(statuses.filter((s) => s === 201)).toHaveLength(6); // floor(5000 / 800) = 6
    expect(statuses.filter((s) => s === 402)).toHaveLength(4);
    expect(await dbBalances(db, user.id)).toEqual({ SUBSCRIPTION: 0, CONSUMABLE: 200, REWARD: 0, PROMOTIONAL: 0 });
    expect(await operationCount(db, user.id)).toBe(6);
    await expectLedgerConsistent(db, user.id);
  });

  test('[NEG][CR-03] 20 concurrent mixed operations across split buckets never overspend and conserve credits', async ({ api, db }) => {
    const user = await newUser(api);
    await seed(db, user, { SUBSCRIPTION: 300, REWARD: 700, PROMOTIONAL: 1000 }); // 2,000 total
    const actions = Array.from({ length: 20 }, (_, i) => (['BASIC', 'STANDARD', 'ADVANCED'] as const)[i % 3]!);
    const results = await Promise.all(actions.map(async (a) => ({ a, status: (await spend(api, user, a)).status() })));
    const costs = { BASIC: 100, STANDARD: 500, ADVANCED: 800 };
    const spent = results.filter((r) => r.status === 201).reduce((sum, r) => sum + costs[r.a], 0);
    expect(results.every((r) => r.status === 201 || r.status === 402)).toBe(true);
    const after = await dbBalances(db, user.id);
    const remaining = Object.values(after).reduce((a, b) => a + b, 0);
    expect(spent + remaining).toBe(2000); // no credit created or lost
    expect(Object.values(after).every((v) => v >= 0)).toBe(true);
    // Every rejected request was truly unaffordable at its turn: what's left is below the cheapest rejected cost.
    const rejectedCosts = results.filter((r) => r.status === 402).map((r) => costs[r.a]);
    if (rejectedCosts.length) expect(remaining).toBeLessThan(Math.min(...rejectedCosts));
    await expectLedgerConsistent(db, user.id);
  });

  test('[NEG] an identical replay (same requestId) returns 200 with the original result and debits nothing more', async ({ api, db }) => {
    const user = await newUser(api);
    await seed(db, user, { REWARD: 1000 });
    const first = await spend(api, user, 'STANDARD', 'req-replay');
    expect(first.status()).toBe(201);
    const replay = await spend(api, user, 'STANDARD', 'req-replay');
    expect(replay.status()).toBe(200);
    const [a, b] = [await first.json(), await replay.json()];
    expect(b.operation).toEqual(a.operation);
    expect(b.replayed).toBe(true);
    expect((await dbBalances(db, user.id)).REWARD).toBe(500);
  });

  test('[NEG] 10 concurrent submissions of one requestId debit exactly once', async ({ api, db }) => {
    const user = await newUser(api);
    await seed(db, user, { REWARD: 1000 });
    const requestId = `req-${randomUUID()}`;
    const statuses = await Promise.all(Array.from({ length: 10 }, async () => (await spend(api, user, 'BASIC', requestId)).status()));
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(9);
    expect((await dbBalances(db, user.id)).REWARD).toBe(900);
    expect(await operationCount(db, user.id)).toBe(1);
  });

  test('[NEG] reusing a requestId for a different action is a 409 conflict and debits nothing', async ({ api, db }) => {
    const user = await newUser(api);
    await seed(db, user, { REWARD: 1000 });
    await spend(api, user, 'BASIC', 'req-x');
    const conflict = await spend(api, user, 'ADVANCED', 'req-x');
    expect(conflict.status()).toBe(409);
    expect((await conflict.json()).error.code).toBe('REQUEST_ID_CONFLICT');
    expect((await dbBalances(db, user.id)).REWARD).toBe(900);
  });

  test('[NEG][AUTH-01] request ids and spending are isolated per user', async ({ api, db }) => {
    const [a, b] = await Promise.all([newUser(api, 'a'), newUser(api, 'b')]);
    await seed(db, a, { REWARD: 500 });
    await seed(db, b, { REWARD: 500 });
    expect((await spend(api, a, 'BASIC', 'shared-id')).status()).toBe(201);
    expect((await spend(api, b, 'STANDARD', 'shared-id')).status()).toBe(201);
    expect((await dbBalances(db, a.id)).REWARD).toBe(400);
    expect((await dbBalances(db, b.id)).REWARD).toBe(0);
  });
});

test.describe('operation validation', () => {
  test('[NEG] operations require authentication', async ({ api }) => {
    expect((await api.post('/operations', { data: { action: 'BASIC', requestId: 'r' } })).status()).toBe(401);
  });

  for (const [label, data] of [
    ['unknown action', { action: 'ULTRA', requestId: 'r1' }],
    ['lowercase action', { action: 'basic', requestId: 'r1' }],
    ['missing requestId', { action: 'BASIC' }],
    ['empty requestId', { action: 'BASIC', requestId: '' }],
    ['requestId with spaces', { action: 'BASIC', requestId: 'a b' }],
    ['201-char requestId', { action: 'BASIC', requestId: 'x'.repeat(201) }],
    ['numeric action', { action: 100, requestId: 'r1' }],
  ] as const) {
    test(`[NEG] rejects ${label} with 400 and no debit`, async ({ api, db }) => {
      const user = await newUser(api);
      await seed(db, user, { REWARD: 1000 });
      const response = await api.post('/operations', { headers: bearer(user.token), data });
      expect(response.status()).toBe(400);
      expect((await dbBalances(db, user.id)).REWARD).toBe(1000);
    });
  }
});
