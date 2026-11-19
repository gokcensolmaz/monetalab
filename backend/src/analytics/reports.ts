/**
 * Deterministic analytics reports for QA (PRD §4, D-035). These are SQL over append-only records; they never touch
 * accounting. Windows are half-open [from, to) in UTC.
 *
 * IMPORTANT: PRD open decision #10 says the churn formula and reporting interval are a WORKING definition only and must
 * be approved before metrics are presented. These functions exist so the rules can be tested; they are not
 * published KPIs. Reinstatement handling and cohort boundaries are not specified by the PRD; the choices made here
 * are documented in docs/decisions.md (D-035) and reported back in `definition`.
 *
 * No HTTP route exposes these (they aggregate across users). Use the local CLI: npm run analytics:report.
 */
import type pg from 'pg';

type Db = Pick<pg.Pool, 'query'>;
export type Window = { from: Date; to: Date };

function checkWindow({ from, to }: Window): void {
  if (!(from < to)) throw new RangeError('report window must satisfy from < to');
}

/**
 * Trial-to-paid conversion, measured separately from paid churn (PRD §4).
 * Cohort: customers whose `trial_started` occurred in [from, to). Converted: the same customers with a
 * `subscription_started` event marked fromTrial=true (at any time up to the report's `asOf`).
 */
export async function trialConversion(db: Db, window: Window & { asOf?: Date }) {
  checkWindow(window);
  const asOf = window.asOf ?? window.to;
  const { rows } = await db.query<{ started: number; converted: number }>(
    `WITH cohort AS (
       SELECT DISTINCT user_id FROM analytics_events
        WHERE name = 'trial_started' AND occurred_at >= $1 AND occurred_at < $2)
     SELECT (SELECT count(*) FROM cohort)::int AS started,
            (SELECT count(DISTINCT c.user_id) FROM cohort c JOIN analytics_events e ON e.user_id = c.user_id
              WHERE e.name = 'subscription_started' AND e.properties->>'fromTrial' = 'true' AND e.occurred_at < $3)::int AS converted`,
    [window.from, window.to, asOf],
  );
  const { started, converted } = rows[0]!;
  return { trialsStarted: started, converted, conversionRate: started === 0 ? null : converted / started };
}

/**
 * Paid subscriber churn, PRD §4 working definition:
 *   paid subscriptions that expire without an active paid replacement within the reporting interval,
 *   divided by paid subscribers at period start.
 * Choices (D-035, pending owner approval):
 * - "Paid subscriber at start": a non-trial APPLIED period, not revoked, with starts_at <= from < ends_at.
 * - "Expire": a `subscription_expired` event, or a `subscription_refunded` event for the current period, in [from, to).
 *   Cancelling auto-renew is NOT churn by itself (PRD §4 distinguishes them).
 * - "Paid replacement": a later non-trial APPLIED, non-revoked period starting after that end event and before `to`
 *   (a reactivation within the window is not counted as churn).
 */
export async function paidChurn(db: Db, window: Window) {
  checkWindow(window);
  const { rows } = await db.query<{ base: number; churned: number }>(
    `WITH base AS (
       SELECT DISTINCT p.user_id FROM subscription_periods p
        WHERE p.kind <> 'TRIAL' AND p.disposition = 'APPLIED'
          AND p.starts_at <= $1 AND p.ends_at > $1
          AND NOT EXISTS (SELECT 1 FROM subscription_revocations r WHERE r.period_id = p.id AND r.revoked_at <= $1)),
     ended AS (
       SELECT b.user_id, max(e.occurred_at) AS ended_at FROM base b JOIN analytics_events e ON e.user_id = b.user_id
        WHERE e.occurred_at >= $1 AND e.occurred_at < $2
          AND (e.name = 'subscription_expired' OR (e.name = 'subscription_refunded' AND e.properties->>'currentPeriod' = 'true'))
        GROUP BY b.user_id)
     SELECT (SELECT count(*) FROM base)::int AS base,
            (SELECT count(*) FROM ended d
              WHERE NOT EXISTS (
                SELECT 1 FROM subscription_periods p
                 WHERE p.user_id = d.user_id AND p.kind <> 'TRIAL' AND p.disposition = 'APPLIED'
                   AND p.starts_at >= d.ended_at AND p.starts_at < $2
                   AND NOT EXISTS (SELECT 1 FROM subscription_revocations r WHERE r.period_id = p.id)))::int AS churned`,
    [window.from, window.to],
  );
  const { base, churned } = rows[0]!;
  return {
    paidSubscribersAtStart: base,
    churned,
    churnRate: base === 0 ? null : churned / base,
    definition: 'PRD §4 working definition (open decision #10): not approved for publication',
  };
}

/** Event counts per name in [from, to): a deterministic oracle for the event stream itself. */
export async function eventCounts(db: Db, window: Window): Promise<Record<string, number>> {
  checkWindow(window);
  const { rows } = await db.query<{ name: string; n: number }>(
    `SELECT name, count(*)::int AS n FROM analytics_events WHERE occurred_at >= $1 AND occurred_at < $2 GROUP BY name ORDER BY name`,
    [window.from, window.to],
  );
  return Object.fromEntries(rows.map((r) => [r.name, r.n]));
}

// CLI (local only): npm run analytics:report -- --from 2026-03-01T00:00:00Z --to 2026-03-08T00:00:00Z
if (import.meta.main) {
  const { parseArgs } = await import('node:util');
  const pgModule = (await import('pg')).default;
  const { databaseUrl } = await import('../config.ts');
  const { assertLocalSeedingAllowed } = await import('../db/seed.ts');
  const { values } = parseArgs({ options: { from: { type: 'string' }, to: { type: 'string' } } });
  if (!values.from || !values.to) throw new Error('--from and --to (ISO-8601) are required');
  const window = { from: new Date(values.from), to: new Date(values.to) };
  assertLocalSeedingAllowed(process.env, databaseUrl()); // same local-only guard as the seeding CLI
  const pool = new pgModule.Pool({ connectionString: databaseUrl() });
  try {
    console.log(JSON.stringify({
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      trialConversion: await trialConversion(pool, window),
      paidChurn: await paidChurn(pool, window),
      eventCounts: await eventCounts(pool, window),
    }, null, 2));
  } finally {
    await pool.end();
  }
}
