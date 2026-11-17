/**
 * Test isolation: every integration test file creates its own throwaway database on the local
 * Postgres server, migrates it from scratch, and drops it afterwards. Tests never touch the
 * developer's `monetalab` database or each other's data. No HTTP fixture endpoints are involved.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { databaseUrl } from '../../../src/config.ts';
import { migrate } from '../../../src/db/migrate.ts';

export type TestDb = { url: string; name: string; pool: pg.Pool; drop: () => Promise<void> };

function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: withDatabase(databaseUrl(), 'postgres') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Creates an empty database with a unique name. It is not migrated. */
export async function createEmptyDatabase(): Promise<Omit<TestDb, 'pool'>> {
  const name = `monetalab_test_${randomBytes(6).toString('hex')}`;
  await admin((c) => c.query(`CREATE DATABASE "${name}"`));
  return {
    name,
    url: withDatabase(databaseUrl(), name),
    drop: () => admin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)).then(() => undefined),
  };
}

/** Creates a fresh, fully migrated database plus a pool connected to it. */
export async function createMigratedDatabase(): Promise<TestDb> {
  const db = await createEmptyDatabase();
  await migrate(db.url);
  const pool = new pg.Pool({ connectionString: db.url, max: 20 });
  return {
    ...db,
    pool,
    drop: async () => {
      await pool.end();
      await db.drop();
    },
  };
}

/** Inserts a user with a unique email. The password hash is a placeholder; auth arrives in Slice 3. */
export async function insertUser(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'test-placeholder-hash') RETURNING id`,
    [`user-${randomUUID()}@test.invalid`],
  );
  return rows[0]!.id;
}

/** Runs a query that must fail, and returns the Postgres error so tests can assert on its code and constraint. */
export async function expectPgError(promise: Promise<unknown>): Promise<pg.DatabaseError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof pg.DatabaseError) return error;
    throw error;
  }
  throw new Error('Expected the query to fail, but it succeeded');
}
