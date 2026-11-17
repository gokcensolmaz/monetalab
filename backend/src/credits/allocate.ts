/**
 * Pure credit allocation: decides how much to debit from each bucket for an
 * operation cost. No I/O. The database layer (a later slice) applies the result
 * atomically under row locks.
 *
 * Rules (product-requirements.md §2.4, decisions D-007, D-009):
 * - Debit in fixed priority order SUBSCRIPTION -> CONSUMABLE -> REWARD -> PROMOTIONAL.
 * - One operation may debit several buckets.
 * - If the total available balance is less than the cost, nothing is debited.
 */

export const BUCKET_PRIORITY = ['SUBSCRIPTION', 'CONSUMABLE', 'REWARD', 'PROMOTIONAL'] as const;

export type Bucket = (typeof BUCKET_PRIORITY)[number];

export type BucketAmounts = Readonly<Record<Bucket, number>>;

export type AllocationResult =
  | { readonly ok: true; readonly debits: BucketAmounts; readonly remaining: BucketAmounts }
  | {
      readonly ok: false;
      readonly code: 'INSUFFICIENT_CREDITS';
      readonly required: number;
      readonly available: number;
    };

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer, got ${value}`);
  }
}

export function allocate(balances: BucketAmounts, cost: number): AllocationResult {
  if (!Number.isSafeInteger(cost) || cost <= 0) {
    throw new RangeError(`cost must be a positive safe integer, got ${cost}`);
  }
  for (const bucket of BUCKET_PRIORITY) {
    assertNonNegativeInteger(balances[bucket], `balance ${bucket}`);
  }

  const available = BUCKET_PRIORITY.reduce((sum, bucket) => sum + balances[bucket], 0);
  if (available < cost) {
    return { ok: false, code: 'INSUFFICIENT_CREDITS', required: cost, available };
  }

  const debits = { SUBSCRIPTION: 0, CONSUMABLE: 0, REWARD: 0, PROMOTIONAL: 0 };
  const remaining = { ...debits };
  let outstanding = cost;
  for (const bucket of BUCKET_PRIORITY) {
    const take = Math.min(balances[bucket], outstanding);
    debits[bucket] = take;
    remaining[bucket] = balances[bucket] - take;
    outstanding -= take;
  }

  return { ok: true, debits, remaining };
}
