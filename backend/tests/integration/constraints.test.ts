import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createMigratedDatabase, expectPgError, insertUser, type TestDb } from './helpers/test-db.ts';

// Categories (D-005): [INT] integration, [NEG] negative/edge case.
// This file uses its own fresh database, and each test creates its own users.

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';
const RESTRICT_VIOLATION = '23001';

let db: TestDb;
before(async () => {
  db = await createMigratedDatabase();
});
after(async () => {
  await db?.drop();
});

async function insertPurchase(userId: string, txId = `tx-${randomUUID()}`, outcome = 'APPROVED'): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO purchases (user_id, provider, provider_transaction_id, package_id, credits, outcome)
     VALUES ($1, 'mock', $2, 'CREDITS_S', 5000, $3) RETURNING id`,
    [userId, txId, outcome],
  );
  return rows[0]!.id;
}

async function insertOperation(userId: string, requestId = `req-${randomUUID()}`): Promise<string> {
  const { rows } = await db.pool.query<{ id: string }>(
    `INSERT INTO operations (user_id, request_id, action, cost) VALUES ($1, $2, 'BASIC', 100) RETURNING id`,
    [userId, requestId],
  );
  return rows[0]!.id;
}

async function insertGrant(userId: string, purchaseId: string, delta = 5000) {
  return db.pool.query(
    `INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, purchase_id)
     VALUES ($1, 'CONSUMABLE', $2, 'PURCHASE_GRANT', $3) RETURNING id`,
    [userId, delta, purchaseId],
  );
}

describe('users and bucket balances', () => {
  it('[INT] a new user automatically gets exactly four zero-balance buckets', async () => {
    const userId = await insertUser(db.pool);
    const { rows } = await db.pool.query<{ bucket: string; balance: number }>(
      // Order by the enum column itself (declaration order), not by the text alias.
      `SELECT bb.bucket::text AS bucket, bb.balance FROM bucket_balances bb WHERE bb.user_id = $1 ORDER BY bb.bucket`,
      [userId],
    );
    assert.deepEqual(rows, [
      { bucket: 'SUBSCRIPTION', balance: 0 },
      { bucket: 'CONSUMABLE', balance: 0 },
      { bucket: 'REWARD', balance: 0 },
      { bucket: 'PROMOTIONAL', balance: 0 },
    ]);
  });

  it('[NEG] a negative bucket balance is rejected', async () => {
    const userId = await insertUser(db.pool);
    const err = await expectPgError(
      db.pool.query(`UPDATE bucket_balances SET balance = -1 WHERE user_id = $1 AND bucket = 'CONSUMABLE'`, [userId]),
    );
    assert.equal(err.code, CHECK_VIOLATION);
    assert.equal(err.constraint, 'bucket_balances_non_negative');
  });

  it('[NEG] a decrement below zero is rejected and leaves the balance unchanged', async () => {
    const userId = await insertUser(db.pool);
    await db.pool.query(`UPDATE bucket_balances SET balance = 100 WHERE user_id = $1 AND bucket = 'REWARD'`, [userId]);
    const err = await expectPgError(
      db.pool.query(`UPDATE bucket_balances SET balance = balance - 101 WHERE user_id = $1 AND bucket = 'REWARD'`, [userId]),
    );
    assert.equal(err.constraint, 'bucket_balances_non_negative');
    const { rows } = await db.pool.query(`SELECT balance FROM bucket_balances WHERE user_id = $1 AND bucket = 'REWARD'`, [userId]);
    assert.equal(rows[0].balance, 100);
  });

  it('[NEG] a duplicate bucket row for the same user is rejected', async () => {
    const userId = await insertUser(db.pool);
    const err = await expectPgError(
      db.pool.query(`INSERT INTO bucket_balances (user_id, bucket) VALUES ($1, 'REWARD')`, [userId]),
    );
    assert.equal(err.code, UNIQUE_VIOLATION);
  });

  it('[NEG] email uniqueness is case-insensitive', async () => {
    const email = `Case-${randomUUID()}@test.invalid`;
    await db.pool.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'h')`, [email]);
    const err = await expectPgError(
      db.pool.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'h')`, [email.toLowerCase()]),
    );
    assert.equal(err.code, UNIQUE_VIOLATION);
    assert.equal(err.constraint, 'users_email_lower_uq');
  });

  it('[NEG] duplicate session token hashes are rejected', async () => {
    const userId = await insertUser(db.pool);
    const hash = createHash('sha256').update(randomBytes(32)).digest();
    const insert = () =>
      db.pool.query(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [userId, hash]);
    await insert();
    const err = await expectPgError(insert());
    assert.equal(err.constraint, 'sessions_token_hash_uq');
  });
});

describe('purchase and operation idempotency keys', () => {
  it('[NEG][BUY-03] a duplicate (provider, transaction ID) is rejected', async () => {
    const userId = await insertUser(db.pool);
    const txId = `tx-${randomUUID()}`;
    await insertPurchase(userId, txId);
    const err = await expectPgError(insertPurchase(userId, txId));
    assert.equal(err.code, UNIQUE_VIOLATION);
    assert.equal(err.constraint, 'purchases_provider_transaction_uq');
  });

  it('[NEG][BUY-03] another user cannot reuse an existing transaction ID', async () => {
    const userA = await insertUser(db.pool);
    const userB = await insertUser(db.pool);
    const txId = `tx-${randomUUID()}`;
    await insertPurchase(userA, txId);
    const err = await expectPgError(insertPurchase(userB, txId));
    assert.equal(err.constraint, 'purchases_provider_transaction_uq');
  });

  it('[NEG][BUY-03] 10 concurrent inserts of one transaction ID: exactly one succeeds', async () => {
    const userId = await insertUser(db.pool);
    const txId = `tx-${randomUUID()}`;
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => insertPurchase(userId, txId)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const dupes = results.filter(
      (r) => r.status === 'rejected' && (r.reason as { code?: string }).code === UNIQUE_VIOLATION,
    ).length;
    assert.deepEqual({ ok, dupes }, { ok: 1, dupes: 9 });
  });

  it('[NEG] a duplicate (user, request ID) operation is rejected', async () => {
    const userId = await insertUser(db.pool);
    const requestId = `req-${randomUUID()}`;
    await insertOperation(userId, requestId);
    const err = await expectPgError(insertOperation(userId, requestId));
    assert.equal(err.code, UNIQUE_VIOLATION);
    assert.equal(err.constraint, 'operations_user_request_uq');
  });

  it('[INT] request IDs are scoped per user: two users may use the same request ID', async () => {
    const requestId = `req-${randomUUID()}`;
    await insertOperation(await insertUser(db.pool), requestId);
    await insertOperation(await insertUser(db.pool), requestId);
  });
});

describe('credit ledger', () => {
  it('[INT] a valid purchase grant is accepted', async () => {
    const userId = await insertUser(db.pool);
    const { rows } = await insertGrant(userId, await insertPurchase(userId));
    assert.equal(rows.length, 1);
  });

  it('[NEG][BUY-03] a purchase can be fulfilled only once (second grant rejected)', async () => {
    const userId = await insertUser(db.pool);
    const purchaseId = await insertPurchase(userId);
    await insertGrant(userId, purchaseId);
    const err = await expectPgError(insertGrant(userId, purchaseId));
    assert.equal(err.code, UNIQUE_VIOLATION);
    assert.equal(err.constraint, 'credit_ledger_one_grant_per_purchase_uq');
  });

  it('[NEG][BUY-03] 10 concurrent grants for one purchase: exactly one succeeds', async () => {
    const userId = await insertUser(db.pool);
    const purchaseId = await insertPurchase(userId);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => insertGrant(userId, purchaseId)));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM credit_ledger WHERE purchase_id = $1`, [purchaseId]);
    assert.equal(rows[0].n, 1);
  });

  it("[NEG] a ledger entry cannot reference another user's purchase", async () => {
    const owner = await insertUser(db.pool);
    const other = await insertUser(db.pool);
    const purchaseId = await insertPurchase(owner);
    const err = await expectPgError(insertGrant(other, purchaseId));
    assert.equal(err.code, FK_VIOLATION);
    assert.equal(err.constraint, 'credit_ledger_purchase_fk');
  });

  it("[NEG] a ledger debit cannot reference another user's operation", async () => {
    const owner = await insertUser(db.pool);
    const other = await insertUser(db.pool);
    const operationId = await insertOperation(owner);
    const err = await expectPgError(
      db.pool.query(
        `INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, operation_id) VALUES ($1, 'CONSUMABLE', -100, 'OPERATION_DEBIT', $2)`,
        [other, operationId],
      ),
    );
    assert.equal(err.constraint, 'credit_ledger_operation_fk');
  });

  it('[NEG] an operation debits each bucket at most once', async () => {
    const userId = await insertUser(db.pool);
    const operationId = await insertOperation(userId);
    const debit = () =>
      db.pool.query(
        `INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, operation_id) VALUES ($1, 'SUBSCRIPTION', -50, 'OPERATION_DEBIT', $2)`,
        [userId, operationId],
      );
    await debit();
    const err = await expectPgError(debit());
    assert.equal(err.constraint, 'credit_ledger_one_debit_per_operation_bucket_uq');
  });

  const badShapes: Array<[string, string, string, number, 'purchase' | 'operation']> = [
    ['a zero delta', 'PURCHASE_GRANT', 'CONSUMABLE', 0, 'purchase'],
    ['a negative purchase grant', 'PURCHASE_GRANT', 'CONSUMABLE', -5000, 'purchase'],
    ['a purchase grant into a non-CONSUMABLE bucket', 'PURCHASE_GRANT', 'REWARD', 5000, 'purchase'],
    ['a positive operation debit', 'OPERATION_DEBIT', 'CONSUMABLE', 100, 'operation'],
    ['a debit linked to a purchase instead of an operation', 'OPERATION_DEBIT', 'CONSUMABLE', -100, 'purchase'],
    ['an unknown entry type', 'MANUAL_ADJUSTMENT', 'CONSUMABLE', 100, 'purchase'],
  ];
  for (const [label, entryType, bucket, delta, ref] of badShapes) {
    it(`[NEG] rejects ${label}`, async () => {
      const userId = await insertUser(db.pool);
      const refId = ref === 'purchase' ? await insertPurchase(userId) : await insertOperation(userId);
      const err = await expectPgError(
        db.pool.query(
          `INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, ${ref}_id) VALUES ($1, $2, $3, $4, $5)`,
          [userId, bucket, delta, entryType, refId],
        ),
      );
      assert.equal(err.code, CHECK_VIOLATION, `expected check violation for ${label}, got ${err.code} ${err.message}`);
    });
  }

  it('[NEG] ledger rows cannot be updated, deleted, or truncated, and stay unchanged', async () => {
    const userId = await insertUser(db.pool);
    const { rows } = await insertGrant(userId, await insertPurchase(userId));
    const entryId = rows[0].id;

    for (const sql of [
      `UPDATE credit_ledger SET delta = 1 WHERE id = $1`,
      `UPDATE credit_ledger SET delta = delta WHERE id = $1`,
      `DELETE FROM credit_ledger WHERE id = $1`,
    ]) {
      const err = await expectPgError(db.pool.query(sql, [entryId]));
      assert.equal(err.code, RESTRICT_VIOLATION, `${sql} should be rejected`);
      assert.match(err.message, /append-only/);
    }
    const truncateErr = await expectPgError(db.pool.query('TRUNCATE credit_ledger'));
    assert.match(truncateErr.message, /append-only: TRUNCATE/);

    const after = await db.pool.query(`SELECT delta FROM credit_ledger WHERE id = $1`, [entryId]);
    assert.deepEqual(after.rows, [{ delta: 5000 }], 'ledger row must be unchanged');
  });

  it('[NEG] a user with ledger history cannot be deleted', async () => {
    const userId = await insertUser(db.pool);
    await insertGrant(userId, await insertPurchase(userId));
    const err = await expectPgError(db.pool.query(`DELETE FROM users WHERE id = $1`, [userId]));
    assert.equal(err.code, FK_VIOLATION);
  });
});
