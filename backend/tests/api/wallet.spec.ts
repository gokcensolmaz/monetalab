import { expect, test } from './support/fixtures.ts';
import { bearer, buy, expectLedgerConsistent, newUser, seed, spend } from './support/helpers.ts';

// Wallet + history (PRD §1 "Display credit wallet and itemized transaction history", AUTH-01 user-specific wallet).
// Categories (D-005): [BR] business rule, [INT] integration, [NEG] negative/edge case.

const ZERO = { SUBSCRIPTION: 0, CONSUMABLE: 0, REWARD: 0, PROMOTIONAL: 0 };

test.describe('wallet', () => {
  test('[BR][AUTH-01] a new user has four zero buckets, total 0, and an empty history', async ({ api }) => {
    const user = await newUser(api);
    const wallet = await (await api.get('/wallet', { headers: bearer(user.token) })).json();
    expect(wallet).toEqual({ wallet: { balances: ZERO, total: 0 }, bucketPriority: ['SUBSCRIPTION', 'CONSUMABLE', 'REWARD', 'PROMOTIONAL'] });
    const history = await (await api.get('/history', { headers: bearer(user.token) })).json();
    expect(history).toEqual({ entries: [], nextBefore: null });
    const purchases = await (await api.get('/purchases', { headers: bearer(user.token) })).json();
    expect(purchases).toEqual({ purchases: [] });
  });

  test('[BR] all four pools are reported separately and the total is their sum', async ({ api, db }) => {
    const user = await newUser(api);
    await seed(db, user, { SUBSCRIPTION: 200, REWARD: 400, PROMOTIONAL: 1000 });
    expect((await buy(api, user, 'CREDITS_M')).status()).toBe(201);
    const { wallet } = await (await api.get('/wallet', { headers: bearer(user.token) })).json();
    expect(wallet.balances).toEqual({ SUBSCRIPTION: 200, CONSUMABLE: 7000, REWARD: 400, PROMOTIONAL: 1000 });
    expect(wallet.total).toBe(200 + 7000 + 400 + 1000);
    await expectLedgerConsistent(db, user.id);
  });

  test('[NEG] wallet, history and purchases require authentication', async ({ api }) => {
    for (const path of ['/wallet', '/history', '/purchases']) {
      const response = await api.get(path);
      expect(response.status()).toBe(401);
      expect((await response.json()).error.code).toBe('UNAUTHENTICATED');
    }
  });

  test('[NEG][AUTH-01] users never see each other’s wallet, history or purchases', async ({ api, db }) => {
    const [a, b] = await Promise.all([newUser(api, 'a'), newUser(api, 'b')]);
    await seed(db, a, { REWARD: 300 });
    expect((await buy(api, a, 'CREDITS_S')).status()).toBe(201);
    expect((await buy(api, a, 'CREDITS_M', 'DECLINED')).status()).toBe(201);

    const walletB = (await (await api.get('/wallet', { headers: bearer(b.token) })).json()).wallet;
    expect(walletB).toEqual({ balances: ZERO, total: 0 });
    expect((await (await api.get('/history', { headers: bearer(b.token) })).json()).entries).toEqual([]);
    expect((await (await api.get('/purchases', { headers: bearer(b.token) })).json()).purchases).toEqual([]);
    // A's own view is unaffected
    expect((await (await api.get('/wallet', { headers: bearer(a.token) })).json()).wallet.total).toBe(5300);
  });
});

test.describe('credit history', () => {
  test('[BR] history is itemized per ledger entry, newest first, with linked purchase/operation details', async ({ api, db }) => {
    const user = await newUser(api);
    await seed(db, user, { SUBSCRIPTION: 200 });
    const purchase = await (await buy(api, user, 'CREDITS_S', 'APPROVED', 'tx-history-1-' + user.id)).json();
    const op = await (await spend(api, user, 'STANDARD', 'req-history-1')).json();

    const { entries } = await (await api.get('/history', { headers: bearer(user.token) })).json();
    // Expected sequence, computed by hand: seed +200 SUB; grant +5000 CONS; STANDARD 500 = 200 SUB + 300 CONS.
    expect(entries.map((e: { type: string; bucket: string; delta: number }) => [e.type, e.bucket, e.delta])).toEqual([
      ['OPERATION_DEBIT', 'CONSUMABLE', -300],
      ['OPERATION_DEBIT', 'SUBSCRIPTION', -200],
      ['PURCHASE_GRANT', 'CONSUMABLE', 5000],
      ['SEED', 'SUBSCRIPTION', 200],
    ]);
    const ids = entries.map((e: { id: number }) => e.id);
    expect([...ids].sort((x: number, y: number) => y - x)).toEqual(ids);
    expect(entries[0].operation).toEqual({ id: op.operation.id, action: 'STANDARD', requestId: 'req-history-1', cost: 500 });
    expect(entries[2].purchase).toEqual({ id: purchase.purchase.id, packageId: 'CREDITS_S', transactionId: 'tx-history-1-' + user.id });
    expect(entries[3].seedReason).toBe('api test fixture');
    // History deltas reconcile with the wallet total
    const total = entries.reduce((sum: number, e: { delta: number }) => sum + e.delta, 0);
    expect((await (await api.get('/wallet', { headers: bearer(user.token) })).json()).wallet.total).toBe(total);
  });

  test('[BR] pagination with limit/before returns every entry exactly once', async ({ api, db }) => {
    const user = await newUser(api);
    await seed(db, user, { REWARD: 1000 });
    for (let i = 0; i < 6; i++) expect((await spend(api, user, 'BASIC')).status()).toBe(201);
    const seen: number[] = [];
    let before: number | null = null;
    do {
      const query: string = before ? `?limit=3&before=${before}` : '?limit=3';
      const page: { entries: Array<{ id: number }>; nextBefore: number | null } = await (
        await api.get(`/history${query}`, { headers: bearer(user.token) })
      ).json();
      expect(page.entries.length).toBeLessThanOrEqual(3);
      seen.push(...page.entries.map((e) => e.id));
      before = page.nextBefore;
    } while (before);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  for (const query of ['?limit=0', '?limit=101', '?limit=999', '?limit=abc', '?limit=1.5', '?limit=01', '?before=0', '?before=-5', '?unknown=1']) {
    test(`[NEG] history rejects invalid query ${query} with 400`, async ({ api }) => {
      const user = await newUser(api);
      const response = await api.get(`/history${query}`, { headers: bearer(user.token) });
      expect(response.status()).toBe(400);
      expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
    });
  }

  test('[NEG] history entries are append-only: earlier entries are unchanged after later activity', async ({ api, db }) => {
    const user = await newUser(api);
    await seed(db, user, { PROMOTIONAL: 500 });
    const first = (await (await api.get('/history', { headers: bearer(user.token) })).json()).entries;
    await spend(api, user, 'BASIC');
    const second = (await (await api.get('/history', { headers: bearer(user.token) })).json()).entries;
    expect(second.slice(1)).toEqual(first);
  });
});

test.describe('catalog', () => {
  test('[BR][PW-01] catalog lists the 3 packs, the 3 weekly plans (mock, available), the rewarded ad and 3 operations', async ({ api }) => {
    const catalog = await (await api.get('/catalog')).json();
    expect(catalog.consumables).toEqual([
      { id: 'CREDITS_S', name: 'Credits S', credits: 5000, available: true },
      { id: 'CREDITS_M', name: 'Credits M', credits: 7000, available: true },
      { id: 'CREDITS_L', name: 'Credits L', credits: 10000, available: true },
    ]);
    // PRD §2.1 (M2, D-027): Basic 3,000 / Premium 6,000 / Ultra 12,000 per week, one group, purchasable via the mock.
    expect(catalog.subscriptionGroup).toBe('MONETALAB_WEEKLY');
    expect(catalog.subscriptions.map((p: { id: string; name: string; creditsPerPeriod: number; periodDays: number; available: boolean }) =>
      [p.id, p.name, p.creditsPerPeriod, p.periodDays, p.available])).toEqual([
      ['BASIC_WEEKLY', 'Basic', 3000, 7, true],
      ['PREMIUM_WEEKLY', 'Premium', 6000, 7, true],
      ['ULTRA_WEEKLY', 'Ultra', 12000, 7, true],
    ]);
    // Only Basic has an introductory offer (PRD §7 #4). The catalog states terms only: no marketing message, because
    // trial messaging is per customer and only shown when eligible (GET /subscriptions/current, PRD §3.1).
    expect(catalog.subscriptions.map((p: { introductoryOffer: unknown }) => p.introductoryOffer)).toEqual([
      { kind: 'FREE_TRIAL', days: 3, credits: 1000 }, null, null,
    ]);
    expect(JSON.stringify(catalog.subscriptions)).not.toMatch(/start|claim|eligible/i);
    expect(catalog.rewardedAd).toMatchObject({ label: 'Watch an Ad — Earn 100 Credits', credits: 100, dailyLimit: 10, available: true });
    expect(catalog.operations).toEqual([
      { id: 'BASIC', name: 'Basic processing', cost: 100 },
      { id: 'STANDARD', name: 'Standard processing', cost: 500 },
      { id: 'ADVANCED', name: 'Advanced processing', cost: 800 },
    ]);
    // PRD open decision #1: no prices are presented
    expect(JSON.stringify(catalog)).not.toMatch(/price|\$|€|USD/i);
  });
});
