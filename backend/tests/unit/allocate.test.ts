import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, BUCKET_PRIORITY, type BucketAmounts } from '../../src/credits/allocate.ts';

// Test categories (decision D-005): [BR] business rule, [NEG] negative/edge case.
// Expected values below are calculated by hand from product-requirements.md §2.3/§2.4,
// not produced by running the implementation.

const b = (SUBSCRIPTION: number, CONSUMABLE: number, REWARD: number, PROMOTIONAL: number): BucketAmounts => ({
  SUBSCRIPTION,
  CONSUMABLE,
  REWARD,
  PROMOTIONAL,
});

describe('allocate: business rules', () => {
  it('[BR][D-009] bucket priority is SUBSCRIPTION -> CONSUMABLE -> REWARD -> PROMOTIONAL', () => {
    assert.deepEqual([...BUCKET_PRIORITY], ['SUBSCRIPTION', 'CONSUMABLE', 'REWARD', 'PROMOTIONAL']);
  });

  it('[BR][CR-01] PRD §2.4 example: 200/300/400/1000, cost 800 -> debits 200+300+300+0', () => {
    const result = allocate(b(200, 300, 400, 1000), 800);
    assert.deepEqual(result, {
      ok: true,
      debits: b(200, 300, 300, 0),
      remaining: b(0, 0, 100, 1000),
    });
  });

  it('[BR][CR-01] cost fully covered by SUBSCRIPTION leaves lower buckets untouched', () => {
    const result = allocate(b(1000, 5000, 100, 50), 500);
    assert.deepEqual(result, { ok: true, debits: b(500, 0, 0, 0), remaining: b(500, 5000, 100, 50) });
  });

  it('[BR][CR-01] empty higher-priority buckets are skipped', () => {
    const result = allocate(b(0, 0, 0, 800), 800);
    assert.deepEqual(result, { ok: true, debits: b(0, 0, 0, 800), remaining: b(0, 0, 0, 0) });
  });

  it('[BR][CR-01] PROMOTIONAL is used only after REWARD is exhausted', () => {
    const result = allocate(b(0, 0, 100, 1000), 500);
    assert.deepEqual(result, { ok: true, debits: b(0, 0, 100, 400), remaining: b(0, 0, 0, 600) });
  });

  it('[BR][CR-01][CR-02] invariants hold for every combination in a deterministic grid', () => {
    const values = [0, 1, 2, 5];
    const costs = [1, 2, 3, 4, 5, 6, 7, 10, 13];
    let checked = 0;
    let rejected = 0;
    for (const s of values)
      for (const c of values)
        for (const r of values)
          for (const p of values)
            for (const cost of costs) {
              const balances = b(s, c, r, p);
              const total = s + c + r + p;
              const result = allocate(balances, cost);
              const label = `balances=${JSON.stringify(balances)} cost=${cost}`;

              if (total < cost) {
                // Expected values come from the test's own sum, not from the implementation.
                assert.deepEqual(
                  result,
                  { ok: false, code: 'INSUFFICIENT_CREDITS', required: cost, available: total },
                  `expected INSUFFICIENT_CREDITS with required=${cost} available=${total} for ${label}`,
                );
                rejected++;
                continue;
              }
              assert.ok(result.ok, `expected success for ${label}`);
              let debitSum = 0;
              let lowerBucketMayBeDebited = true;
              for (const bucket of BUCKET_PRIORITY) {
                const debit: number = result.debits[bucket];
                debitSum += debit;
                assert.ok(debit >= 0 && debit <= balances[bucket], `debit out of range in ${bucket} for ${label}`);
                assert.equal(result.remaining[bucket], balances[bucket] - debit, `remaining mismatch in ${bucket} for ${label}`);
                if (!lowerBucketMayBeDebited) {
                  assert.equal(debit, 0, `${bucket} debited before a higher bucket was exhausted for ${label}`);
                }
                // A lower bucket may only be touched if this bucket was fully drained.
                if (result.remaining[bucket] > 0) lowerBucketMayBeDebited = false;
              }
              assert.equal(debitSum, cost, `debits must sum to cost for ${label}`);
              checked++;
            }
    assert.ok(checked > 0, 'grid produced no successful allocations');
    assert.ok(rejected > 0, 'grid produced no insufficient-credit cases');
  });
});

describe('allocate: negative and edge cases', () => {
  it('[NEG][CR-02] one credit short across all buckets: rejected, nothing debited', () => {
    const result = allocate(b(200, 300, 199, 100), 800);
    assert.deepEqual(result, { ok: false, code: 'INSUFFICIENT_CREDITS', required: 800, available: 799 });
    assert.equal('debits' in result, false, 'a rejected allocation must not carry debits');
  });

  it('[NEG][CR-02] all buckets empty: rejected', () => {
    assert.deepEqual(allocate(b(0, 0, 0, 0), 100), {
      ok: false,
      code: 'INSUFFICIENT_CREDITS',
      required: 100,
      available: 0,
    });
  });

  it('[NEG] exact total balance is sufficient and drains every bucket', () => {
    const result = allocate(b(100, 200, 300, 200), 800);
    assert.deepEqual(result, { ok: true, debits: b(100, 200, 300, 200), remaining: b(0, 0, 0, 0) });
  });

  for (const badCost of [0, -100, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    it(`[NEG] rejects invalid cost ${badCost}`, () => {
      assert.throws(() => allocate(b(1000, 0, 0, 0), badCost), RangeError);
    });
  }

  for (const [label, balances] of [
    ['negative balance', b(-1, 1000, 0, 0)],
    ['fractional balance', b(0, 10.5, 0, 0)],
    ['NaN balance', b(0, 0, Number.NaN, 0)],
  ] as const) {
    it(`[NEG] rejects ${label}`, () => {
      assert.throws(() => allocate(balances, 100), RangeError);
    });
  }

  it('[NEG] does not mutate the input balances', () => {
    const balances = Object.freeze(b(200, 300, 400, 1000));
    const snapshot = { ...balances };
    allocate(balances, 800);
    allocate(balances, 5000);
    assert.deepEqual(balances, snapshot);
  });
});
