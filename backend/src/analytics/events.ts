/**
 * Analytics events (PRD §4, D-034). Append-only and deliberately separate from accounting: nothing in the ledger,
 * balances or entitlement logic ever reads this table.
 * Idempotent: UNIQUE (name, dedupe_key), where dedupe_key is the source fact's idempotency key (provider event or
 * ad event). A provider retry therefore never produces a second event.
 */
import type pg from 'pg';

export const ANALYTICS_EVENT_NAMES = [
  'trial_started', 'trial_expired', 'subscription_started', 'subscription_renewed', 'subscription_cancelled',
  'subscription_expired', 'subscription_refunded', 'subscription_upgraded', 'subscription_downgraded', 'reward_granted',
] as const;
export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

export async function recordAnalyticsEvent(
  db: Pick<pg.PoolClient, 'query'>,
  event: { userId: string; name: AnalyticsEventName; dedupeKey: string; occurredAt: Date; properties: Record<string, unknown> },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO analytics_events (user_id, name, dedupe_key, occurred_at, properties)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (name, dedupe_key) DO NOTHING`,
    [event.userId, event.name, event.dedupeKey, event.occurredAt, JSON.stringify(event.properties)],
  );
  return rowCount === 1;
}
