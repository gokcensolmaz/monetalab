/**
 * Local end-to-end backend for the iOS UI tests (and manual QA): the real server on a fresh disposable database.
 *   npm run e2e:server            → OS-assigned free port (the harness never uses fixed ports)
 * Prints `E2E_API_BASE_URL=http://127.0.0.1:<port>`. On SIGINT/SIGTERM it stops the server and drops the database.
 * Never touches the developer `monetalab` database or Docker volumes.
 */
import { fileURLToPath } from 'node:url';
import { databaseUrl } from '../../../src/config.ts';
import { migrate } from '../../../src/db/migrate.ts';
import { createDisposableDatabase, dropDisposableDatabase, urlForDatabase } from './disposable-db.ts';
import { startOwnedServer } from './server-harness.ts';

const BACKEND_DIR = fileURLToPath(new URL('../../../', import.meta.url));
const dbName = await createDisposableDatabase();
let stopping = false;

async function shutdown(code: number): Promise<never> {
  if (!stopping) {
    stopping = true;
    await server?.stop().catch(() => {});
    await dropDisposableDatabase(dbName).catch((e) => console.error(`could not drop ${dbName}: ${(e as Error).message}`));
    console.log(`E2E backend stopped; dropped ${dbName}`);
  }
  process.exit(code);
}

let server: Awaited<ReturnType<typeof startOwnedServer>> | undefined;
try {
  await migrate(urlForDatabase(databaseUrl(), dbName));
  server = await startOwnedServer({
    cwd: BACKEND_DIR,
    env: { ...process.env, DATABASE_URL: urlForDatabase(databaseUrl(), dbName) },
  });
} catch (error) {
  console.error((error as Error).message);
  await shutdown(1);
}
console.log(`E2E_API_BASE_URL=${server!.baseUrl}`);
console.log(`(database ${dbName}; press Ctrl-C to stop and clean up)`);
process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));
