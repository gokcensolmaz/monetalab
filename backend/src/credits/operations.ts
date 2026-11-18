/**
 * Credit spending (PRD §2.3–2.4, CR-01..03, D-007, D-008).
 *
 * POST /operations { action, requestId }
 * One transaction:
 *   1. Lock the user's four bucket rows (SELECT … FOR UPDATE), so spends for one user are serialized.
 *   2. If (user, requestId) already exists: same action → 200 replay of the original result; else 409.
 *   3. allocate() picks debits in SUBSCRIPTION → CONSUMABLE → REWARD → PROMOTIONAL order.
 *      Insufficient total → 402 INSUFFICIENT_CREDITS, nothing written (ROLLBACK).
 *   4. Insert the operation and one OPERATION_DEBIT ledger entry per debited bucket. The ledger trigger updates
 *      balances in the same transaction, and the non-negative CHECK is the last line of defense.
 * D-008: the simulated operation succeeds immediately; there is no reversal workflow in M1.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { authOf, requireAuth } from '../auth/require-auth.ts';
import { OPERATION_ACTIONS, OPERATION_COSTS, type OperationAction } from '../catalog.ts';
import { withTransaction } from '../db/tx.ts';
import { ApiError } from '../http/errors.ts';
import { allocate, BUCKET_PRIORITY, type Bucket } from './allocate.ts';
import { readWallet, type Wallet } from './wallet.ts';

const body = {
  type: 'object',
  required: ['action', 'requestId'],
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: OPERATION_ACTIONS },
    requestId: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9._:-]+$' },
  },
} as const;

type Body = { action: OperationAction; requestId: string };
type OperationRow = { id: string; request_id: string; action: string; cost: number; created_at: Date };

type Outcome =
  | { kind: 'done'; operation: OperationRow; debits: Record<Bucket, number>; wallet: Wallet; replayed: boolean }
  | { kind: 'insufficient'; required: number; available: number }
  | { kind: 'conflict' };

async function debitsOf(tx: pg.PoolClient, operationId: string): Promise<Record<Bucket, number>> {
  const debits = { SUBSCRIPTION: 0, CONSUMABLE: 0, REWARD: 0, PROMOTIONAL: 0 };
  const { rows } = await tx.query<{ bucket: Bucket; delta: number }>(
    `SELECT bucket::text AS bucket, delta FROM credit_ledger WHERE operation_id = $1 AND entry_type = 'OPERATION_DEBIT'`,
    [operationId],
  );
  for (const r of rows) debits[r.bucket] = -r.delta;
  return debits;
}

export function registerOperationRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.post<{ Body: Body }>('/operations', { preHandler: requireAuth(pool), schema: { body } }, async (request, reply) => {
    const userId = authOf(request).user.id;
    const { action, requestId } = request.body;
    const cost = OPERATION_COSTS[action];

    const outcome = await withTransaction<Outcome>(pool, async (tx) => {
      const before = await readWallet(tx, userId, true); // row locks held until COMMIT/ROLLBACK

      const existing = await tx.query<OperationRow>(
        'SELECT id, request_id, action, cost, created_at FROM operations WHERE user_id = $1 AND request_id = $2',
        [userId, requestId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].action !== action) return { kind: 'conflict' };
        return {
          kind: 'done',
          operation: existing.rows[0],
          debits: await debitsOf(tx, existing.rows[0].id),
          wallet: before,
          replayed: true,
        };
      }

      const allocation = allocate(before.balances, cost);
      if (!allocation.ok) return { kind: 'insufficient', required: allocation.required, available: allocation.available };

      const inserted = await tx.query<OperationRow>(
        `INSERT INTO operations (user_id, request_id, action, cost) VALUES ($1, $2, $3, $4)
         RETURNING id, request_id, action, cost, created_at`,
        [userId, requestId, action, cost],
      );
      const operation = inserted.rows[0]!;
      for (const bucket of BUCKET_PRIORITY) {
        const amount = allocation.debits[bucket];
        if (amount > 0) {
          await tx.query(
            `INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, operation_id)
             VALUES ($1, $2, $3, 'OPERATION_DEBIT', $4)`,
            [userId, bucket, -amount, operation.id],
          );
        }
      }
      return { kind: 'done', operation, debits: allocation.debits, wallet: await readWallet(tx, userId), replayed: false };
    });

    if (outcome.kind === 'conflict') {
      throw new ApiError(409, 'REQUEST_ID_CONFLICT', 'This requestId was already used for a different action');
    }
    if (outcome.kind === 'insufficient') {
      throw new ApiError(402, 'INSUFFICIENT_CREDITS', 'Not enough credits for this operation', {
        required: outcome.required,
        available: outcome.available,
      });
    }
    const { operation, debits, wallet, replayed } = outcome;
    return reply.code(replayed ? 200 : 201).send({
      operation: {
        id: operation.id,
        requestId: operation.request_id,
        action: operation.action,
        cost: operation.cost,
        createdAt: operation.created_at.toISOString(),
        debits,
        // Deterministic simulated output (PRD §2.3: no real AI processing in M1).
        result: { status: 'COMPLETED', output: `simulated-${operation.action.toLowerCase()}-${operation.id}` },
      },
      replayed,
      wallet,
    });
  });
}
