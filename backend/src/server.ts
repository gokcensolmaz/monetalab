import pg from 'pg';
import { buildApp } from './app.ts';
import { billingProviderFromEnv, type BillingProvider } from './billing/provider.ts';
import { databaseUrl } from './config.ts';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

/** PORT=0 asks the OS for a free ephemeral port (used by the API test harness). */
function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65_535) {
    throw new Error(`Invalid PORT "${value}": expected an integer from 0 to 65535`);
  }
  return Number(value);
}

let port: number;
let billing: BillingProvider;
try {
  port = parsePort(process.env.PORT);
  billing = billingProviderFromEnv(); // refuses the mock provider when NODE_ENV=production
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl() });
const app = buildApp({ pool, billing });

try {
  await app.listen({ host: HOST, port });
} catch (error) {
  // Never print DATABASE_URL: it contains credentials.
  console.error(`Failed to start MonetaLab API: ${(error as Error).message}`);
  await pool.end().catch(() => {});
  process.exit(1);
}

// Report the port actually bound (it differs from the requested one when PORT=0) and our PID.
// The API test harness parses this exact line from its own child's stdout.
const address = app.server.address();
const boundPort = typeof address === 'object' && address !== null ? address.port : port;
console.log(`MonetaLab API listening on http://${HOST}:${boundPort} (pid ${process.pid})`);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const forceExit = setTimeout(() => {
    console.error(`Forced exit: graceful shutdown after ${signal} exceeded ${SHUTDOWN_TIMEOUT_MS} ms`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();
  try {
    await app.close(); // stop accepting connections, finish in-flight requests
    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error(`Shutdown error after ${signal}: ${(error as Error).message}`);
    process.exit(1);
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
