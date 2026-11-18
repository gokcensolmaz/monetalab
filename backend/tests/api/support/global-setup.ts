/**
 * Playwright global setup for HTTP API tests.
 *
 * Lifecycle:
 *   1. Create a uniquely named disposable database (monetalab_api_test_<hex>).
 *   2. Apply the real migrations from backend/migrations.
 *   3. Start the real server (node src/server.ts) on an OS-assigned port and verify ownership (server-harness.ts).
 *   4. Publish connection details to the test workers through environment variables.
 *   5. Teardown (the returned function): stop the server (SIGTERM, then SIGKILL after 5 s), then drop the database.
 * If any step fails, everything created so far is cleaned up before the error is re-thrown.
 * The developer `monetalab` database and Docker volumes are never modified.
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { databaseUrl } from '../../../src/config.ts';
import { migrate } from '../../../src/db/migrate.ts';
import { createDisposableDatabase, dropDisposableDatabase, urlForDatabase } from './disposable-db.ts';
import { startOwnedServer, type OwnedServer } from './server-harness.ts';

const BACKEND_DIR = fileURLToPath(new URL('../../../', import.meta.url));

export default async function globalSetup(): Promise<() => Promise<void>> {
  let dbName: string | undefined;
  let server: OwnedServer | undefined;

  const teardown = async () => {
    const problems: string[] = [];
    if (server) {
      const result = await server.stop();
      if (result.forced) problems.push(`server pid ${server.pid} ignored SIGTERM and was killed`);
      server = undefined;
    }
    if (dbName) {
      try {
        await dropDisposableDatabase(dbName);
      } catch (error) {
        problems.push(`could not drop ${dbName}: ${(error as Error).message}`);
      }
      dbName = undefined;
    }
    if (problems.length) console.warn(`[api-test teardown] ${problems.join('; ')}`);
  };

  try {
    dbName = await createDisposableDatabase();
    await migrate(urlForDatabase(databaseUrl(), dbName));

    // A unique application_name lets tests prove (via pg_stat_activity) that the server answering them
    // is connected to *this* disposable database.
    const serverAppName = `monetalab_api_server_${randomBytes(6).toString('hex')}`;
    server = await startOwnedServer({
      cwd: BACKEND_DIR,
      env: { ...process.env, DATABASE_URL: urlForDatabase(databaseUrl(), dbName, serverAppName) },
    });

    process.env.API_BASE_URL = server.baseUrl;
    process.env.API_SERVER_PID = String(server.pid);
    process.env.API_SERVER_PORT = String(server.port);
    process.env.API_SERVER_APP_NAME = serverAppName;
    process.env.API_TEST_DB_NAME = dbName;
    process.env.API_TEST_DATABASE_URL = urlForDatabase(databaseUrl(), dbName, 'monetalab_api_test_client');
  } catch (error) {
    await teardown();
    throw error;
  }

  return teardown;
}
