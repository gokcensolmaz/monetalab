/**
 * Playwright fixtures for HTTP API tests.
 * - `api`: request context bound to the harness-owned server (base URL from global setup).
 * - `harness`: identity of the owned server and disposable DB, for ownership assertions.
 * - `db`: a direct connection to the disposable test DB, for assertions only. Any future direct DB writes must
 *   be scoped to rows created by the same test (D-017b), and must never be unscoped UPDATE/DELETE/TRUNCATE.
 */
import { test as base, expect, type APIRequestContext } from '@playwright/test';
import pg from 'pg';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: global setup did not run or failed`);
  return value;
}

export type Harness = { baseUrl: string; pid: number; port: number; serverAppName: string; dbName: string };

export const test = base.extend<{ api: APIRequestContext; harness: Harness }, { db: pg.Pool }>({
  harness: async ({}, use) => {
    await use({
      baseUrl: requireEnv('API_BASE_URL'),
      pid: Number(requireEnv('API_SERVER_PID')),
      port: Number(requireEnv('API_SERVER_PORT')),
      serverAppName: requireEnv('API_SERVER_APP_NAME'),
      dbName: requireEnv('API_TEST_DB_NAME'),
    });
  },
  api: async ({ playwright, harness }, use) => {
    const context = await playwright.request.newContext({ baseURL: harness.baseUrl });
    await use(context);
    await context.dispose();
  },
  db: [
    async ({}, use) => {
      const pool = new pg.Pool({ connectionString: requireEnv('API_TEST_DATABASE_URL'), max: 4 });
      await use(pool);
      await pool.end();
    },
    { scope: 'worker' },
  ],
});

export { expect };
