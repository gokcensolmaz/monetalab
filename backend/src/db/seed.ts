/**
 * Controlled credit seeding (DV-003, P-001 approved in principle; details decided in M1 implementation).
 *
 * - There is NO HTTP route for this. It's callable only from code with direct DB access (test helpers) and from the
 *   local CLI below (`npm run db:seed:demo`).
 * - Seeding writes an auditable SEED ledger entry with a mandatory reason. The ledger trigger updates the balance in
 *   the same statement. The DB forbids SEED into CONSUMABLE: consumable credits only come from verified purchases.
 * - The CLI refuses NODE_ENV=production and any non-loopback database host.
 */
import type pg from 'pg';
import type { Bucket } from '../credits/allocate.ts';
import { databaseUrl } from '../config.ts';

export type SeedableBucket = Exclude<Bucket, 'CONSUMABLE'>;

export async function seedCredits(
  db: Pick<pg.Pool, 'query'>,
  input: { userId: string; bucket: SeedableBucket; amount: number; reason: string },
): Promise<void> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) throw new RangeError('seed amount must be a positive integer');
  await db.query(
    `INSERT INTO credit_ledger (user_id, bucket, delta, entry_type, seed_reason) VALUES ($1, $2, $3, 'SEED', $4)`,
    [input.userId, input.bucket, input.amount, input.reason],
  );
}

export function assertLocalSeedingAllowed(env: NodeJS.ProcessEnv, url: string): void {
  if (env.NODE_ENV === 'production') throw new Error('Refusing to seed credits with NODE_ENV=production');
  const host = new URL(url).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error(`Refusing to seed credits on non-local database host "${host}"`);
  }
}

// CLI: npm run db:seed:demo -- --email you@example.test [--subscription 200] [--reward 400] [--promotional 1000]
if (import.meta.main) {
  const { parseArgs } = await import('node:util');
  const pgModule = (await import('pg')).default;
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      subscription: { type: 'string', default: '0' },
      reward: { type: 'string', default: '0' },
      promotional: { type: 'string', default: '0' },
    },
  });
  const url = databaseUrl();
  assertLocalSeedingAllowed(process.env, url);
  if (!values.email) throw new Error('--email is required (the user must already be registered)');
  const client = new pgModule.Client({ connectionString: url });
  await client.connect();
  try {
    const user = await client.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower($1)', [values.email.trim()]);
    if (!user.rows[0]) throw new Error('No registered user with that email');
    await client.query('BEGIN');
    for (const [bucket, raw] of [
      ['SUBSCRIPTION', values.subscription],
      ['REWARD', values.reward],
      ['PROMOTIONAL', values.promotional],
    ] as const) {
      const amount = Number(raw);
      if (amount > 0) await seedCredits(client, { userId: user.rows[0].id, bucket, amount, reason: 'local demo seed (db:seed:demo)' });
    }
    await client.query('COMMIT');
    console.log('Seeded demo credits.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}
