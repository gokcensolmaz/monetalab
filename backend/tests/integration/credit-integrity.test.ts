import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { seedCredits, assertLocalSeedingAllowed } from '../../src/db/seed.ts';
import { buildApp } from '../../src/app.ts';
import { billingProviderFromEnv } from '../../src/billing/provider.ts';
import { createMigratedDatabase, expectPgError, insertUser, type TestDb } from './helpers/test-db.ts';

// Categories (D-005): [BR] business rule, [INT] integration, [NEG] negative/edge case.
// Database-level enforcement of DV-001 (approved purchases grant their exact amount), DV-002 (ledger/balance
// consistency and atomic overdraft rejection) and DV-003 (auditable seeding, no HTTP route), from migration 002.

const CHECK_VIOLATION = '23514';
const FK_VIOLATION = '23503';
const RESTRICT_VIOLATION = '23001';

let db: TestDb;
before(async () => {
  db = await createMigratedDatabase();
});
after(async () => {
  await db?.drop();
});

async function purchase(userId: string, outcome: string, packageId = 'CREDITS_S', credits = 5000): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO purchases (user_id, provider, provider_transaction_id, package_id, credits, outcome)
     VALUES ($1, 'mock', $2, $3, $4, $5) RETURNING id`,
    [userId, `tx-${randomUUID()}`, packageId, credits, outcome],
  );
  return rows[0]!.id;
}

const grant = (userId: string, purchaseId: string, delta: number) =>
  db.pool.query(
    `INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, purchase_id) VALUES ($1, 'CONSUMABLE', $2, 'PURCHASE_GRANT', $3)`,
    [userId, delta, purchaseId],
  );

async function balances(userId: string): Promise<Record<string, number>> {
  const { rows } = await db.pool.query<{ bucket: string; balance: number }>(
    'SELECT bucket::text AS bucket, balance FROM bucket_balances WHERE user_id = $1',
    [userId],
  );
  return Object.fromEntries(rows.map((r) => [r.bucket, r.balance]));
}

async function ledgerSums(userId: string): Promise<Record<string, number>> {
  const { rows } = await db.pool.query<{ bucket: string; total: number }>(
    'SELECT bucket::text AS bucket, COALESCE(SUM(delta), 0)::int AS total FROM credit_ledger WHERE user_id = $1 GROUP BY bucket',
    [userId],
  );
  const sums: Record<string, number> = { SUBSCRIPTION: 0, CONSUMABLE: 0, REWARD: 0, PROMOTIONAL: 0 };
  for (const r of rows) sums[r.bucket] = r.total;
  return sums;
}

describe('consumable package catalog', () => {
  it('[BR][PRD §2.2] contains exactly S/M/L = 5,000 / 7,000 / 10,000 credits', async () => {
    const { rows } = await db.pool.query('SELECT id, credits FROM credit_packages ORDER BY sort_order');
    assert.deepEqual(rows, [
      { id: 'CREDITS_S', credits: 5000 },
      { id: 'CREDITS_M', credits: 7000 },
      { id: 'CREDITS_L', credits: 10000 },
    ]);
  });

  it('[NEG] a purchase whose credits differ from its package is rejected', async () => {
    const userId = await insertUser(db.pool);
    const err = await expectPgError(purchase(userId, 'APPROVED', 'CREDITS_S', 7000));
    assert.equal(err.code, FK_VIOLATION);
    assert.equal(err.constraint, 'purchases_package_fk');
  });

  it('[NEG] an unknown package is rejected', async () => {
    const userId = await insertUser(db.pool);
    const err = await expectPgError(purchase(userId, 'APPROVED', 'CREDITS_XL', 5000));
    assert.equal(err.constraint, 'purchases_package_fk');
  });

  it('[NEG] the catalog is immutable', async () => {
    const err = await expectPgError(db.pool.query(`UPDATE credit_packages SET credits = 1 WHERE id = 'CREDITS_S'`));
    assert.equal(err.code, RESTRICT_VIOLATION);
  });
});

describe('DV-001: only approved purchases grant, for exactly their amount', () => {
  for (const outcome of ['DECLINED', 'CANCELLED']) {
    it(`[NEG][BUY-02] a ${outcome} purchase cannot grant credits, and the balance stays 0`, async () => {
      const userId = await insertUser(db.pool);
      const err = await expectPgError(grant(userId, await purchase(userId, outcome), 5000));
      assert.equal(err.code, CHECK_VIOLATION);
      assert.equal(err.constraint, 'credit_ledger_grant_requires_approved_purchase');
      assert.equal((await balances(userId)).CONSUMABLE, 0);
    });
  }

  for (const delta of [4999, 5001, 10000]) {
    it(`[NEG][BUY-01] an approved 5,000 purchase cannot grant ${delta}`, async () => {
      const userId = await insertUser(db.pool);
      const err = await expectPgError(grant(userId, await purchase(userId, 'APPROVED'), delta));
      assert.equal(err.constraint, 'credit_ledger_grant_amount_matches_purchase');
    });
  }

  it('[BR][BUY-01] an approved purchase grants exactly its amount and updates the balance in the same statement', async () => {
    const userId = await insertUser(db.pool);
    await grant(userId, await purchase(userId, 'APPROVED', 'CREDITS_L', 10000), 10000);
    assert.deepEqual(await balances(userId), { SUBSCRIPTION: 0, CONSUMABLE: 10000, REWARD: 0, PROMOTIONAL: 0 });
  });

  it('[NEG] purchases are immutable (outcome cannot be flipped to APPROVED later)', async () => {
    const userId = await insertUser(db.pool);
    const id = await purchase(userId, 'DECLINED');
    for (const sql of [`UPDATE purchases SET outcome = 'APPROVED' WHERE id = $1`, `DELETE FROM purchases WHERE id = $1`]) {
      const err = await expectPgError(db.pool.query(sql, [id]));
      assert.equal(err.code, RESTRICT_VIOLATION);
    }
  });
});

describe('DV-002: balance equals the ledger, overdrafts are rejected atomically', () => {
  it('[INT] after grants, seeds and debits, every balance equals the sum of its ledger entries', async () => {
    const userId = await insertUser(db.pool);
    await grant(userId, await purchase(userId, 'APPROVED', 'CREDITS_M', 7000), 7000);
    await seedCredits(db.pool, { userId, bucket: 'REWARD', amount: 400, reason: 'test' });
    await seedCredits(db.pool, { userId, bucket: 'PROMOTIONAL', amount: 1000, reason: 'test' });
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO operations (user_id, request_id, action, cost) VALUES ($1, 'r1', 'STANDARD', 500) RETURNING id`,
      [userId],
    );
    await db.pool.query(
      `INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, operation_id) VALUES ($1, 'CONSUMABLE', -500, 'OPERATION_DEBIT', $2)`,
      [userId, rows[0]!.id],
    );
    const expected = { SUBSCRIPTION: 0, CONSUMABLE: 6500, REWARD: 400, PROMOTIONAL: 1000 };
    assert.deepEqual(await balances(userId), expected);
    assert.deepEqual(await ledgerSums(userId), expected);
  });

  it('[NEG] an overdrafting debit fails, and neither the ledger row nor the balance change survives', async () => {
    const userId = await insertUser(db.pool);
    await seedCredits(db.pool, { userId, bucket: 'REWARD', amount: 100, reason: 'test' });
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO operations (user_id, request_id, action, cost) VALUES ($1, 'r1', 'BASIC', 100) RETURNING id`,
      [userId],
    );
    const err = await expectPgError(
      db.pool.query(
        `INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, operation_id) VALUES ($1, 'REWARD', -101, 'OPERATION_DEBIT', $2)`,
        [userId, rows[0]!.id],
      ),
    );
    assert.equal(err.constraint, 'bucket_balances_non_negative');
    assert.equal((await balances(userId)).REWARD, 100);
    const count = await db.pool.query(`SELECT count(*)::int AS n FROM credit_ledger WHERE user_id = $1 AND entry_type = 'OPERATION_DEBIT'`, [userId]);
    assert.equal(count.rows[0].n, 0);
  });

  it('[NEG] a multi-row transaction that overdraws one bucket rolls back every row', async () => {
    const userId = await insertUser(db.pool);
    await seedCredits(db.pool, { userId, bucket: 'SUBSCRIPTION', amount: 200, reason: 'test' });
    await seedCredits(db.pool, { userId, bucket: 'REWARD', amount: 50, reason: 'test' });
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const op = await client.query<{ id: string }>(
        `INSERT INTO operations (user_id, request_id, action, cost) VALUES ($1, 'r1', 'BASIC', 100) RETURNING id`,
        [userId],
      );
      await client.query(
        `INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, operation_id) VALUES ($1, 'SUBSCRIPTION', -200, 'OPERATION_DEBIT', $2)`,
        [userId, op.rows[0]!.id],
      );
      await assert.rejects(
        client.query(
          `INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, operation_id) VALUES ($1, 'REWARD', -60, 'OPERATION_DEBIT', $2)`,
          [userId, op.rows[0]!.id],
        ),
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    assert.deepEqual(await balances(userId), { SUBSCRIPTION: 200, CONSUMABLE: 0, REWARD: 50, PROMOTIONAL: 0 });
    const ops = await db.pool.query('SELECT count(*)::int AS n FROM operations WHERE user_id = $1', [userId]);
    assert.equal(ops.rows[0].n, 0);
  });

  it('[NEG] operations are immutable', async () => {
    const userId = await insertUser(db.pool);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO operations (user_id, request_id, action, cost) VALUES ($1, 'r1', 'BASIC', 100) RETURNING id`,
      [userId],
    );
    const err = await expectPgError(db.pool.query('UPDATE operations SET cost = 1 WHERE id = $1', [rows[0]!.id]));
    assert.equal(err.code, RESTRICT_VIOLATION);
  });
});

describe('DV-003: controlled, auditable seeding', () => {
  it('[INT] seedCredits writes one SEED ledger entry with its reason and updates the balance', async () => {
    const userId = await insertUser(db.pool);
    await seedCredits(db.pool, { userId, bucket: 'PROMOTIONAL', amount: 250, reason: 'qa fixture' });
    const { rows } = await db.pool.query(
      `SELECT entry_type, bucket::text AS bucket, delta, seed_reason FROM credit_ledger WHERE user_id = $1`,
      [userId],
    );
    assert.deepEqual(rows, [{ entry_type: 'SEED', bucket: 'PROMOTIONAL', delta: 250, seed_reason: 'qa fixture' }]);
    assert.equal((await balances(userId)).PROMOTIONAL, 250);
  });

  it('[NEG] seeding CONSUMABLE is rejected by the database (consumables only come from purchases)', async () => {
    const userId = await insertUser(db.pool);
    const err = await expectPgError(
      db.pool.query(`INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, seed_reason) VALUES ($1, 'CONSUMABLE', 100, 'SEED', 'x')`, [userId]),
    );
    assert.equal(err.code, CHECK_VIOLATION);
  });

  for (const [label, reason, delta] of [
    ['without a reason', null, 100],
    ['with an empty reason', '', 100],
    ['with a negative amount', 'x', -100],
  ] as const) {
    it(`[NEG] a SEED entry ${label} is rejected`, async () => {
      const userId = await insertUser(db.pool);
      const err = await expectPgError(
        db.pool.query(`INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, seed_reason) VALUES ($1, 'REWARD', $2, 'SEED', $3)`, [userId, delta, reason]),
      );
      assert.equal(err.code, CHECK_VIOLATION);
    });
  }

  it('[NEG] the seed CLI guard refuses production and non-local databases', () => {
    assert.throws(() => assertLocalSeedingAllowed({ NODE_ENV: 'production' }, 'postgres://u:p@127.0.0.1:5432/db'), /production/);
    assert.throws(() => assertLocalSeedingAllowed({}, 'postgres://u:p@db.example.com:5432/db'), /non-local/);
    assert.doesNotThrow(() => assertLocalSeedingAllowed({}, 'postgres://u:p@127.0.0.1:55432/monetalab'));
  });

  it('[NEG] no HTTP route can seed or grant credits: the route table is exactly the M1 API', async () => {
    const app = buildApp({ pool: db.pool });
    await app.ready();
    const routes = app
      .printRoutes({ commonPrefix: false })
      .split('\n')
      .map((l) => l.replace(/^[\s│├└─]+/, '').trim())
      .filter(Boolean)
      .sort();
    await app.close();
    const text = routes.join('\n');
    for (const forbidden of ['seed', 'grant', 'admin', 'test', 'fixture', 'debug']) {
      assert.doesNotMatch(text, new RegExp(forbidden, 'i'), `unexpected route containing "${forbidden}"`);
    }
    for (const expected of ['/auth/login', '/auth/logout', '/auth/register', '/catalog', '/health', '/history', '/me', '/operations', '/purchases', '/wallet']) {
      assert.ok(routes.some((r) => r.startsWith(expected)), `missing route ${expected}`);
    }
  });

  it('[NEG] the mock billing provider refuses to run with NODE_ENV=production, and unknown providers are rejected', () => {
    assert.throws(() => billingProviderFromEnv({ NODE_ENV: 'production' }), /must not run with NODE_ENV=production/);
    assert.throws(() => billingProviderFromEnv({ BILLING_PROVIDER: 'storekit' }), /Unsupported BILLING_PROVIDER/);
    assert.equal(billingProviderFromEnv({}).name, 'mock');
  });
});
