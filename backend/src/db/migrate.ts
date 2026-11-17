/**
 * Minimal plain-SQL migration runner.
 * - Applies `NNN_name.sql` files from the migrations directory in filename order.
 * - Records each one in `schema_migrations` with a SHA-256 checksum. Applied files are never re-run.
 * - Each file runs in its own transaction, so a failing file leaves no partial changes.
 * - A Postgres advisory lock serializes concurrent runners.
 * - Refuses to run if an already-applied file was edited (checksum mismatch).
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { databaseUrl } from '../config.ts';

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const MIGRATION_FILE = /^\d{3}_[a-z0-9_]+\.sql$/;
const LOCK_KEY = 47_016_001; // arbitrary constant identifying the MonetaLab migration lock

export async function migrate(connectionString: string, migrationsDir = DEFAULT_MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(migrationsDir)).filter((f) => MIGRATION_FILE.test(f)).sort();
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = done.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(`Migration ${file} was modified after being applied (checksum mismatch). Add a new migration instead.`);
        }
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed and was rolled back: ${(error as Error).message}`, { cause: error });
      }
      applied.push(file);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end();
  }
  return applied;
}

if (import.meta.main) {
  const applied = await migrate(databaseUrl());
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations.');
}
