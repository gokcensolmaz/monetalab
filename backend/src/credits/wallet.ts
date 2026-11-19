/**
 * Wallet and credit history (PRD §1 M1, AUTH-01 "user-specific wallet and history").
 * All queries are scoped to the authenticated user's id. No route accepts a user id from the client.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authOf, requireAuth } from '../auth/require-auth.ts';
import type { Clock } from '../clock.ts';
import { withTransaction } from '../db/tx.ts';
import { ApiError } from '../http/errors.ts';
import { lockUser, reconcileUser } from '../subscriptions/service.ts';
import { BUCKET_PRIORITY, type Bucket } from './allocate.ts';

type Queryable = Pick<pg.PoolClient, 'query'>;

export type Wallet = { balances: Record<Bucket, number>; total: number };

export async function readWallet(db: Queryable, userId: string, forUpdate = false): Promise<Wallet> {
  // FOR UPDATE locks the user's four bucket rows: concurrent spends for the same user serialize here.
  const { rows } = await db.query<{ bucket: Bucket; balance: number }>(
    `SELECT bucket::text AS bucket, balance FROM bucket_balances WHERE user_id = $1 ORDER BY bucket${forUpdate ? ' FOR UPDATE' : ''}`,
    [userId],
  );
  const balances = { SUBSCRIPTION: 0, CONSUMABLE: 0, REWARD: 0, PROMOTIONAL: 0 };
  for (const row of rows) balances[row.bucket] = row.balance;
  if (rows.length !== BUCKET_PRIORITY.length) throw new Error('wallet is missing bucket rows');
  return { balances, total: BUCKET_PRIORITY.reduce((sum, b) => sum + balances[b], 0) };
}

// Query values arrive as strings, and type coercion is disabled app-wide (so JSON bodies are never coerced).
// Accept canonical positive decimal integers only, and parse them explicitly.
const pageQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' },
    before: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' },
  },
} as const;

function parseLimit(raw: string | undefined): number {
  const limit = raw === undefined ? 50 : Number(raw);
  if (limit > 100) throw new ApiError(400, 'VALIDATION_ERROR', 'limit must be between 1 and 100');
  return limit;
}

type HistoryRow = {
  id: string;
  created_at: Date;
  entry_type: string;
  bucket: string;
  delta: number;
  seed_reason: string | null;
  purchase_id: string | null;
  package_id: string | null;
  transaction_id: string | null;
  operation_id: string | null;
  action: string | null;
  request_id: string | null;
  cost: number | null;
  expiration_reason: string | null;
  period_id: string | null;
  period_plan_id: string | null;
  period_kind: string | null;
  period_transaction_id: string | null;
  ad_reward_id: string | null;
  ad_event_id: string | null;
};

export function registerWalletRoutes(app: FastifyInstance, pool: pg.Pool, clock: Clock): void {
  const guard = requireAuth(pool);

  // Expires an ended subscription period's credits first, so the wallet never shows unspendable credits (D-029).
  app.get('/wallet', { onRequest: guard }, async (request) => {
    const userId = authOf(request).user.id;
    const now = clock.now();
    const wallet = await withTransaction(pool, async (tx) => {
      await lockUser(tx, userId);
      await reconcileUser(tx, userId, now);
      return readWallet(tx, userId);
    });
    return { wallet, bucketPriority: BUCKET_PRIORITY };
  });

  // Itemized, append-only credit history (one row per ledger entry), newest first. Cursor = ledger id.
  app.get<{ Querystring: { limit?: string; before?: string } }>(
    '/history',
    { onRequest: guard, schema: { querystring: pageQuery } },
    async (request) => {
      const limit = parseLimit(request.query.limit);
      const before = request.query.before === undefined ? undefined : Number(request.query.before);
      const { rows } = await pool.query<HistoryRow>(
        `SELECT l.id::text AS id, l.created_at, l.entry_type, l.bucket::text AS bucket, l.delta, l.seed_reason,
                p.id AS purchase_id, p.package_id, p.provider_transaction_id AS transaction_id,
                o.id AS operation_id, o.action, o.request_id, o.cost, l.expiration_reason,
                sp.id AS period_id, sp.plan_id AS period_plan_id, sp.kind AS period_kind, sp.transaction_id AS period_transaction_id,
                ar.id AS ad_reward_id, ar.ad_event_id
           FROM credit_ledger l
           LEFT JOIN purchases p ON p.id = l.purchase_id AND p.user_id = l.user_id
           LEFT JOIN operations o ON o.id = l.operation_id AND o.user_id = l.user_id
           LEFT JOIN subscription_periods sp ON sp.id = l.subscription_period_id AND sp.user_id = l.user_id
           LEFT JOIN ad_rewards ar ON ar.id = l.ad_reward_id AND ar.user_id = l.user_id
          WHERE l.user_id = $1 AND ($2::bigint IS NULL OR l.id < $2::bigint)
          ORDER BY l.id DESC
          LIMIT $3`,
        [authOf(request).user.id, before ?? null, limit + 1],
      );
      const page = rows.slice(0, limit);
      return {
        entries: page.map((r) => ({
          id: Number(r.id),
          createdAt: r.created_at.toISOString(),
          type: r.entry_type,
          bucket: r.bucket,
          delta: r.delta,
          ...(r.purchase_id && { purchase: { id: r.purchase_id, packageId: r.package_id, transactionId: r.transaction_id } }),
          ...(r.operation_id && {
            operation: { id: r.operation_id, action: r.action, requestId: r.request_id, cost: r.cost },
          }),
          ...(r.seed_reason && { seedReason: r.seed_reason }),
          ...(r.period_id && {
            subscriptionPeriod: { id: r.period_id, planId: r.period_plan_id, kind: r.period_kind, transactionId: r.period_transaction_id },
          }),
          ...(r.expiration_reason && { expirationReason: r.expiration_reason }),
          ...(r.ad_reward_id && { adReward: { id: r.ad_reward_id, adEventId: r.ad_event_id } }),
        })),
        nextBefore: rows.length > limit ? Number(page.at(-1)!.id) : null,
      };
    },
  );

  // All purchase attempts, including DECLINED and CANCELLED ones (which never appear in the credit ledger).
  app.get<{ Querystring: { limit?: string } }>(
    '/purchases',
    { onRequest: guard, schema: { querystring: { ...pageQuery, properties: { limit: pageQuery.properties.limit } } } },
    async (request) => {
      const { rows } = await pool.query(
        `SELECT p.id, p.provider_transaction_id AS "transactionId", p.package_id AS "packageId", p.credits,
                p.outcome, p.created_at AS "createdAt",
                COALESCE((SELECT l.delta FROM credit_ledger l
                           WHERE l.purchase_id = p.id AND l.entry_type = 'PURCHASE_GRANT'), 0) AS "creditsGranted"
           FROM purchases p
          WHERE p.user_id = $1
          ORDER BY p.created_at DESC, p.id DESC
          LIMIT $2`,
        [authOf(request).user.id, parseLimit(request.query.limit)],
      );
      return { purchases: rows.map((r) => ({ ...r, createdAt: (r.createdAt as Date).toISOString() })) };
    },
  );
}
