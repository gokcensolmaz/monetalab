import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';

export function buildApp(deps: { pool: pg.Pool }): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/health', async (_request, reply) => {
    try {
      await deps.pool.query('SELECT 1');
      return { status: 'ok', database: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'error', database: 'unavailable' });
    }
  });

  return app;
}
