import { randomUUID } from 'node:crypto';
import { expect, test } from './support/fixtures.ts';
import { bearer, buy, dbBalances, expectLedgerConsistent, newUser } from './support/helpers.ts';

// Mock consumable purchases: BUY-01..03, D-006, DV-001, DV-002.
// Categories (D-005): [BR] business rule, [INT] integration, [NEG] negative/edge case.

const PACKS: Array<[string, number]> = [
  ['CREDITS_S', 5000],
  ['CREDITS_M', 7000],
  ['CREDITS_L', 10000],
]; // PRD §2.2, independent of the implementation

async function grantRows(db: import('pg').Pool, userId: string) {
  const { rows } = await db.query(
    `SELECT delta FROM credit_ledger WHERE user_id = $1 AND entry_type = 'PURCHASE_GRANT' ORDER BY id`,
    [userId],
  );
  return rows.map((r) => r.delta as number);
}

test.describe('BUY-01 approved purchases', () => {
  for (const [packageId, credits] of PACKS) {
    test(`[BR][BUY-01] ${packageId} grants exactly ${credits} CONSUMABLE credits once`, async ({ api, db }) => {
      const user = await newUser(api);
      const response = await buy(api, user, packageId);
      expect(response.status()).toBe(201);
      const body = await response.json();
      expect(body.purchase).toMatchObject({ packageId, credits, outcome: 'APPROVED' });
      expect(body.creditsGranted).toBe(credits);
      expect(body.replayed).toBe(false);
      expect(body.wallet).toEqual({ balances: { SUBSCRIPTION: 0, CONSUMABLE: credits, REWARD: 0, PROMOTIONAL: 0 }, total: credits });
      expect(await grantRows(db, user.id)).toEqual([credits]);
      expect(await dbBalances(db, user.id)).toEqual({ SUBSCRIPTION: 0, CONSUMABLE: credits, REWARD: 0, PROMOTIONAL: 0 });
      await expectLedgerConsistent(db, user.id);
    });
  }

  test('[BR] consumables can be bought repeatedly; each distinct transaction grants once', async ({ api, db }) => {
    const user = await newUser(api);
    for (const packageId of ['CREDITS_S', 'CREDITS_S', 'CREDITS_L']) expect((await buy(api, user, packageId)).status()).toBe(201);
    expect(await grantRows(db, user.id)).toEqual([5000, 5000, 10000]);
    expect((await dbBalances(db, user.id)).CONSUMABLE).toBe(20000);
  });
});

test.describe('BUY-02 declined / cancelled purchases', () => {
  for (const outcome of ['DECLINED', 'CANCELLED']) {
    test(`[NEG][BUY-02] a ${outcome} purchase is recorded but grants nothing`, async ({ api, db }) => {
      const user = await newUser(api);
      const response = await buy(api, user, 'CREDITS_L', outcome);
      expect(response.status()).toBe(201);
      const body = await response.json();
      expect(body.purchase.outcome).toBe(outcome);
      expect(body.creditsGranted).toBe(0);
      expect(body.wallet.total).toBe(0);
      expect(await grantRows(db, user.id)).toEqual([]);
      const listed = (await (await api.get('/purchases', { headers: bearer(user.token) })).json()).purchases;
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ outcome, creditsGranted: 0, packageId: 'CREDITS_L' });
      expect((await (await api.get('/history', { headers: bearer(user.token) })).json()).entries).toEqual([]);
    });
  }

  test('[NEG] without a mock outcome the mock provider fails closed (DECLINED, no credits)', async ({ api, db }) => {
    const user = await newUser(api);
    const response = await api.post('/purchases', {
      headers: bearer(user.token),
      data: { packageId: 'CREDITS_S', transactionId: `tx-${randomUUID()}` },
    });
    expect((await response.json()).purchase.outcome).toBe('DECLINED');
    expect((await dbBalances(db, user.id)).CONSUMABLE).toBe(0);
  });
});

test.describe('BUY-03 duplicates and idempotency (D-006)', () => {
  test('[NEG][BUY-03] an identical replay returns 200 with the original result and grants nothing more', async ({ api, db }) => {
    const user = await newUser(api);
    const tx = `tx-${randomUUID()}`;
    const first = await buy(api, user, 'CREDITS_M', 'APPROVED', tx);
    expect(first.status()).toBe(201);
    const replay = await buy(api, user, 'CREDITS_M', 'APPROVED', tx);
    expect(replay.status()).toBe(200);
    const [a, b] = [await first.json(), await replay.json()];
    expect(b.purchase).toEqual(a.purchase);
    expect(b.replayed).toBe(true);
    expect(await grantRows(db, user.id)).toEqual([7000]);
  });

  test('[NEG][BUY-03] replaying a DECLINED transaction as APPROVED is a 409 conflict and grants nothing', async ({ api, db }) => {
    const user = await newUser(api);
    const tx = `tx-${randomUUID()}`;
    expect((await buy(api, user, 'CREDITS_S', 'DECLINED', tx)).status()).toBe(201);
    const conflict = await buy(api, user, 'CREDITS_S', 'APPROVED', tx);
    expect(conflict.status()).toBe(409);
    expect((await conflict.json()).error.code).toBe('TRANSACTION_CONFLICT');
    expect((await dbBalances(db, user.id)).CONSUMABLE).toBe(0);
  });

  test('[NEG] the same transaction id with a different package is a 409 conflict', async ({ api, db }) => {
    const user = await newUser(api);
    const tx = `tx-${randomUUID()}`;
    await buy(api, user, 'CREDITS_S', 'APPROVED', tx);
    expect((await buy(api, user, 'CREDITS_L', 'APPROVED', tx)).status()).toBe(409);
    expect((await dbBalances(db, user.id)).CONSUMABLE).toBe(5000);
  });

  test('[NEG] another user cannot reuse a transaction id, and learns nothing about the original', async ({ api, db }) => {
    const [a, b] = await Promise.all([newUser(api, 'a'), newUser(api, 'b')]);
    const tx = `tx-${randomUUID()}`;
    await buy(api, a, 'CREDITS_S', 'APPROVED', tx);
    const response = await buy(api, b, 'CREDITS_S', 'APPROVED', tx);
    expect(response.status()).toBe(409);
    const text = await response.text();
    expect(text).not.toContain(a.id);
    expect(text).not.toContain(a.email);
    expect((await dbBalances(db, b.id)).CONSUMABLE).toBe(0);
  });

  test('[NEG][BUY-03] 10 concurrent submissions of one transaction: one 201, nine 200 replays, a single grant', async ({ api, db }) => {
    const user = await newUser(api);
    const tx = `tx-${randomUUID()}`;
    const statuses = await Promise.all(Array.from({ length: 10 }, async () => (await buy(api, user, 'CREDITS_L', 'APPROVED', tx)).status()));
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(9);
    expect(await grantRows(db, user.id)).toEqual([10000]);
    await expectLedgerConsistent(db, user.id);
  });

  test('[INT] 10 concurrent distinct purchases by one user all grant, and the ledger stays consistent', async ({ api, db }) => {
    const user = await newUser(api);
    const statuses = await Promise.all(Array.from({ length: 10 }, async () => (await buy(api, user, 'CREDITS_S')).status()));
    expect(statuses).toEqual(Array(10).fill(201));
    expect((await dbBalances(db, user.id)).CONSUMABLE).toBe(50000);
    await expectLedgerConsistent(db, user.id);
  });
});

test.describe('purchase validation', () => {
  test('[NEG] purchases require authentication', async ({ api }) => {
    const response = await api.post('/purchases', { data: { packageId: 'CREDITS_S', transactionId: 'tx-1', mockOutcome: 'APPROVED' } });
    expect(response.status()).toBe(401);
  });

  const invalid: Array<[string, Record<string, unknown>, number, string]> = [
    ['unknown package', { packageId: 'CREDITS_XL', transactionId: 'tx-a', mockOutcome: 'APPROVED' }, 400, 'UNKNOWN_PACKAGE'],
    ['unknown outcome', { packageId: 'CREDITS_S', transactionId: 'tx-b', mockOutcome: 'SUCCESS_FORCED' }, 400, 'VALIDATION_ERROR'],
    ['client-supplied credits', { packageId: 'CREDITS_S', transactionId: 'tx-c', mockOutcome: 'APPROVED', credits: 999999 }, 400, 'VALIDATION_ERROR'],
    ['missing transaction id', { packageId: 'CREDITS_S', mockOutcome: 'APPROVED' }, 400, 'VALIDATION_ERROR'],
    ['empty transaction id', { packageId: 'CREDITS_S', transactionId: '', mockOutcome: 'APPROVED' }, 400, 'VALIDATION_ERROR'],
    ['transaction id with spaces', { packageId: 'CREDITS_S', transactionId: 'tx 1', mockOutcome: 'APPROVED' }, 400, 'VALIDATION_ERROR'],
    ['201-character transaction id', { packageId: 'CREDITS_S', transactionId: 'x'.repeat(201), mockOutcome: 'APPROVED' }, 400, 'VALIDATION_ERROR'],
  ];
  for (const [label, data, status, code] of invalid) {
    test(`[NEG] rejects ${label} (${status} ${code}) without changing the wallet`, async ({ api, db }) => {
      const user = await newUser(api);
      const response = await api.post('/purchases', { headers: bearer(user.token), data });
      expect(response.status()).toBe(status);
      expect((await response.json()).error.code).toBe(code);
      expect(await dbBalances(db, user.id)).toEqual({ SUBSCRIPTION: 0, CONSUMABLE: 0, REWARD: 0, PROMOTIONAL: 0 });
      const { rows } = await db.query('SELECT count(*)::int AS n FROM purchases WHERE user_id = $1', [user.id]);
      expect(rows[0].n).toBe(0);
    });
  }
});
