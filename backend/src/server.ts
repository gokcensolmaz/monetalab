import pg from 'pg';
import { buildApp } from './app.ts';
import { databaseUrl } from './config.ts';

const pool = new pg.Pool({ connectionString: databaseUrl() });
const app = buildApp({ pool });
const port = Number(process.env.PORT ?? 3000);

await app.listen({ host: '127.0.0.1', port });
console.log(`MonetaLab API listening on http://127.0.0.1:${port}`);
