/**
 * Disposable PostgreSQL databases for HTTP API tests.
 *
 * Safety: databases are created and dropped only under the name pattern `monetalab_api_test_<12 hex>`.
 * dropDisposableDatabase refuses any other name, so the dev `monetalab` database (and anything else)
 * can never be dropped through this module. Docker volumes are never touched.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { databaseUrl } from '../../../src/config.ts';

export const DISPOSABLE_DB_PATTERN = /^monetalab_api_test_[0-9a-f]{12}$/;

export function urlForDatabase(baseUrl: string, dbName: string, applicationName?: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  url.search = '';
  if (applicationName) url.searchParams.set('application_name', applicationName);
  return url.toString();
}

async function withAdminClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: urlForDatabase(databaseUrl(), 'postgres', 'monetalab_api_test_admin') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function createDisposableDatabase(): Promise<string> {
  const name = `monetalab_api_test_${randomBytes(6).toString('hex')}`;
  await withAdminClient((c) => c.query(`CREATE DATABASE "${name}"`));
  return name;
}

export async function dropDisposableDatabase(name: string): Promise<void> {
  if (!DISPOSABLE_DB_PATTERN.test(name)) {
    throw new Error(`Refusing to drop "${name}": not a disposable API test database`);
  }
  await withAdminClient((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
}
