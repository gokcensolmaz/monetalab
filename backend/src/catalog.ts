/**
 * Server-side product catalog (PRD §2.1–2.3). Clients never send prices or costs; the server decides them.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

/** PRD §2.3. Placeholder action names; costs are authoritative here. */
export const OPERATION_COSTS = { BASIC: 100, STANDARD: 500, ADVANCED: 800 } as const;
export type OperationAction = keyof typeof OPERATION_COSTS;
export const OPERATION_ACTIONS = Object.keys(OPERATION_COSTS) as OperationAction[];
const OPERATION_NAMES: Record<OperationAction, string> = {
  BASIC: 'Basic processing',
  STANDARD: 'Standard processing',
  ADVANCED: 'Advanced processing',
};

/**
 * PRD §2.1 subscription plans: shown as **unavailable previews** in M1 (D-003). No prices (PRD open decision #1).
 * Trial information is descriptive only. M1 cannot determine trial eligibility, so it is never presented as an offer.
 */
export const SUBSCRIPTION_PREVIEWS = [
  {
    id: 'BASIC_WEEKLY',
    name: 'Basic',
    period: 'WEEKLY',
    creditsPerPeriod: 3000,
    introductoryOffer: { description: 'Planned: a 3-day trial with 1,000 credits. Not offered in M1; trial eligibility arrives in M2.', credits: 1000, days: 3 },
  },
  { id: 'PREMIUM_WEEKLY', name: 'Premium', period: 'WEEKLY', creditsPerPeriod: 6000, introductoryOffer: null },
  { id: 'ULTRA_WEEKLY', name: 'Ultra', period: 'WEEKLY', creditsPerPeriod: 12000, introductoryOffer: null },
].map((plan) => ({ ...plan, available: false, availability: 'Subscriptions are not available in this release (M2).' }));

export const REWARDED_AD_PREVIEW = {
  label: 'Watch an Ad — Earn 100 Credits',
  credits: 100,
  available: false,
  availability: 'Rewarded ads are not available in this release (M2).',
};

export function registerCatalogRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.get('/catalog', async () => {
    const { rows } = await pool.query<{ id: string; credits: number; display_name: string }>(
      'SELECT id, credits, display_name FROM credit_packages ORDER BY sort_order',
    );
    return {
      consumables: rows.map((r) => ({ id: r.id, name: r.display_name, credits: r.credits, available: true })),
      subscriptions: SUBSCRIPTION_PREVIEWS,
      rewardedAd: REWARDED_AD_PREVIEW,
      operations: OPERATION_ACTIONS.map((id) => ({ id, name: OPERATION_NAMES[id], cost: OPERATION_COSTS[id] })),
    };
  });
}
