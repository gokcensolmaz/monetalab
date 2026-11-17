import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { buildApp } from '../../src/app.ts';
import { createMigratedDatabase, type TestDb } from './helpers/test-db.ts';

// Categories (D-005): [INT] integration, [NEG] negative/edge case.

let db: TestDb;
before(async () => {
  db = await createMigratedDatabase();
});
after(async () => {
  await db?.drop();
});

describe('GET /health', () => {
  it('[INT] returns 200 when the database is reachable', async () => {
    const app = buildApp({ pool: db.pool });
    const res = await app.inject({ method: 'GET', url: '/health' });
    await app.close();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: 'ok', database: 'ok' });
  });

  it('[NEG] returns 503 when the database is unreachable', async () => {
    // Port 1 on localhost: the connection is refused at once.
    const deadPool = new pg.Pool({ connectionString: 'postgres://nobody:nothing@127.0.0.1:1/none', connectionTimeoutMillis: 1000 });
    const app = buildApp({ pool: deadPool });
    const res = await app.inject({ method: 'GET', url: '/health' });
    await app.close();
    await deadPool.end();
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { status: 'error', database: 'unavailable' });
  });
});
