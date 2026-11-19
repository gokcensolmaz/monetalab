import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { mockAdProvider, type AdProvider } from './ads/provider.ts';
import { registerAdRoutes } from './ads/routes.ts';
import { registerAuthRoutes } from './auth/routes.ts';
import { mockBillingProvider, type BillingProvider } from './billing/provider.ts';
import { registerCatalogRoutes } from './catalog.ts';
import { systemClock, type Clock } from './clock.ts';
import { registerOperationRoutes } from './credits/operations.ts';
import { registerPurchaseRoutes } from './credits/purchases.ts';
import { registerWalletRoutes } from './credits/wallet.ts';
import { installErrorHandling } from './http/errors.ts';
import { registerSubscriptionRoutes } from './subscriptions/routes.ts';

export const BODY_LIMIT_BYTES = 16 * 1024;

export type AppDeps = { pool: pg.Pool; billing?: BillingProvider; ads?: AdProvider; clock?: Clock };

export function buildApp(deps: AppDeps): FastifyInstance {
  const billing = deps.billing ?? mockBillingProvider;
  const ads = deps.ads ?? mockAdProvider;
  const clock = deps.clock ?? systemClock;
  const app = Fastify({
    logger: false,
    bodyLimit: BODY_LIMIT_BYTES,
    // Reject unknown properties and wrong types instead of silently stripping or coercing them.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: true } },
  });
  app.decorateRequest('auth', null);
  installErrorHandling(app);

  // Balances, tokens and history must never be cached by clients or proxies.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
  });

  app.get('/health', async (_request, reply) => {
    try {
      await deps.pool.query('SELECT 1');
      return { status: 'ok', database: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'error', database: 'unavailable' });
    }
  });

  registerAuthRoutes(app, deps.pool);
  registerCatalogRoutes(app, deps.pool);
  registerWalletRoutes(app, deps.pool, clock);
  registerPurchaseRoutes(app, deps.pool, billing);
  registerOperationRoutes(app, deps.pool, clock);
  registerSubscriptionRoutes(app, deps.pool, { billing, clock });
  registerAdRoutes(app, deps.pool, { ads, clock });
  return app;
}
