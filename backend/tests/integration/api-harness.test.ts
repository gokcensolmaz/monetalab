import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { databaseUrl } from '../../src/config.ts';
import { migrate } from '../../src/db/migrate.ts';
import { createDisposableDatabase, dropDisposableDatabase, urlForDatabase } from '../api/support/disposable-db.ts';
import { startOwnedServer } from '../api/support/server-harness.ts';

// Categories (D-005): [INT] integration, [NEG] negative/edge case.
// Verifies the Playwright API harness itself (slice 3 plan §0.1, D-017a): server ownership, startup failures,
// timeouts, teardown, and database-drop safety.

const BACKEND_DIR = fileURLToPath(new URL('../../', import.meta.url));
let dbName: string;
let serverEnv: NodeJS.ProcessEnv;

before(async () => {
  dbName = await createDisposableDatabase();
  await migrate(urlForDatabase(databaseUrl(), dbName));
  serverEnv = { ...process.env, DATABASE_URL: urlForDatabase(databaseUrl(), dbName) };
});
after(async () => {
  if (dbName) await dropDisposableDatabase(dbName);
});

function processesMatching(marker: string): number {
  const result = spawnSync('pgrep', ['-f', marker]);
  return result.stdout.toString().trim().split('\n').filter(Boolean).length;
}

async function isPortClosed(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
    return false;
  } catch {
    return true;
  }
}

describe('API test harness: owned server lifecycle', () => {
  it('[INT] starts the real server on an OS-assigned port, verifies ownership, and stops it gracefully', async () => {
    const server = await startOwnedServer({ cwd: BACKEND_DIR, env: serverEnv });
    assert.ok(server.port > 0, 'an ephemeral port was assigned');
    assert.doesNotThrow(() => process.kill(server.pid, 0), 'child is alive');
    const health = await fetch(`${server.baseUrl}/health`);
    assert.equal(health.status, 200);

    const result = await server.stop();
    assert.deepEqual(result, { exitCode: 0, signal: null, forced: false }, 'SIGTERM must lead to a clean exit 0');
    assert.ok(await isPortClosed(server.port), 'port must be closed after stop');
    assert.throws(() => process.kill(server.pid, 0), 'process must be gone');
  });

  it('[INT] two harness servers run side by side on different ports without collision', async () => {
    const [a, b] = await Promise.all([
      startOwnedServer({ cwd: BACKEND_DIR, env: serverEnv }),
      startOwnedServer({ cwd: BACKEND_DIR, env: serverEnv }),
    ]);
    try {
      assert.notEqual(a.port, b.port);
      assert.notEqual(a.pid, b.pid);
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
  });

  it('[INT] the server also shuts down gracefully on SIGINT', async () => {
    const server = await startOwnedServer({ cwd: BACKEND_DIR, env: serverEnv });
    process.kill(server.pid, 'SIGINT');
    const result = await server.stop(); // already exiting; stop just waits for it
    assert.equal(result.exitCode, 0);
    assert.equal(result.forced, false);
  });
});

describe('API test harness: explicit startup failures (child always cleaned up)', () => {
  it('[NEG] server exits before ready: rejects with the exit code', async () => {
    await assert.rejects(
      startOwnedServer({ cwd: BACKEND_DIR, env: serverEnv, args: ['-e', 'process.exit(3)'] }),
      /exited before it was ready \(exit code 3/,
    );
  });

  it('[NEG] no ready line within the timeout: rejects and kills the child', async () => {
    const marker = `harness_timeout_${randomBytes(4).toString('hex')}`;
    await assert.rejects(
      startOwnedServer({
        cwd: BACKEND_DIR,
        env: serverEnv,
        args: ['-e', `/* ${marker} */ setInterval(() => {}, 1000)`],
        readyTimeoutMs: 300,
      }),
      /no ready line within 300 ms/,
    );
    assert.equal(processesMatching(marker), 0, 'timed-out child must not be left running');
  });

  it('[NEG] ready line with a foreign PID: rejects (not our server) and kills the child', async () => {
    const marker = `harness_pid_${randomBytes(4).toString('hex')}`;
    const script = `/* ${marker} */ console.log('MonetaLab API listening on http://127.0.0.1:1 (pid 1)'); setInterval(() => {}, 1000)`;
    await assert.rejects(
      startOwnedServer({ cwd: BACKEND_DIR, env: serverEnv, args: ['-e', script] }),
      /reported pid 1, but the spawned child is pid \d+/,
    );
    assert.equal(processesMatching(marker), 0);
  });

  it('[NEG] health check never returns 200 (database unreachable): rejects and stops the server', async () => {
    const env = { ...process.env, DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none' };
    const marker = `src/server.ts`;
    const before = processesMatching(marker);
    await assert.rejects(
      startOwnedServer({ cwd: BACKEND_DIR, env, healthTimeoutMs: 1_000 }),
      /health check did not succeed before the deadline \(GET \/health returned 503\)/,
    );
    assert.equal(processesMatching(marker), before, 'no extra server process may remain');
  });

  it('[NEG] invalid PORT makes server.ts exit 1 with a clear message (no listen)', () => {
    const result = spawnSync(process.execPath, ['src/server.ts'], {
      cwd: BACKEND_DIR,
      env: { ...serverEnv, PORT: 'abc' },
      timeout: 10_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /Invalid PORT "abc"/);
    assert.doesNotMatch(result.stderr.toString(), /postgres:\/\//, 'must not print the database URL');
  });
});

describe('API test harness: teardown escalation', () => {
  it('[NEG] a child that ignores SIGTERM is killed with SIGKILL after the stop timeout', async () => {
    // Fake server: valid ready line with its own pid and a real /health 200, but it ignores SIGTERM.
    const script = `
      const http = require('node:http');
      process.on('SIGTERM', () => {});
      const s = http.createServer((q, r) => { r.writeHead(200); r.end('{}'); });
      s.listen(0, '127.0.0.1', () => console.log('MonetaLab API listening on http://127.0.0.1:' + s.address().port + ' (pid ' + process.pid + ')'));`;
    const server = await startOwnedServer({ cwd: BACKEND_DIR, env: serverEnv, args: ['-e', script], stopTimeoutMs: 300 });
    const result = await server.stop();
    assert.equal(result.forced, true);
    assert.equal(result.signal, 'SIGKILL');
    assert.ok(await isPortClosed(server.port));
  });
});

describe('disposable database safety', () => {
  for (const name of ['monetalab', 'postgres', 'template1', 'monetalab_test_abc', 'monetalab_api_test_', 'monetalab_api_test_ZZZZZZZZZZZZ', 'monetalab_api_test_0123456789ab"; DROP DATABASE monetalab; --']) {
    it(`[NEG] refuses to drop "${name.slice(0, 40)}"`, async () => {
      await assert.rejects(dropDisposableDatabase(name), /Refusing to drop/);
    });
  }

  it('[NEG] the development database still exists after the refusal tests', async () => {
    const client = new pg.Client({ connectionString: urlForDatabase(databaseUrl(), 'postgres') });
    await client.connect();
    try {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM pg_database WHERE datname = 'monetalab'`);
      assert.equal(rows[0].n, 1);
    } finally {
      await client.end();
    }
  });

  it('[INT] a created disposable database matches the safe pattern and can be dropped', async () => {
    const name = await createDisposableDatabase();
    assert.match(name, /^monetalab_api_test_[0-9a-f]{12}$/);
    await dropDisposableDatabase(name);
    const out = execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import pg from 'pg'; const c = new pg.Client({ connectionString: process.argv[1] }); await c.connect();
       const r = await c.query("SELECT count(*)::int AS n FROM pg_database WHERE datname = $1", [process.argv[2]]);
       console.log(r.rows[0].n); await c.end();`,
      urlForDatabase(databaseUrl(), 'postgres'),
      name,
    ], { cwd: BACKEND_DIR });
    assert.equal(out.toString().trim(), '0');
  });
});
