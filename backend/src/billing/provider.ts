/**
 * Billing provider boundary (CLAUDE.md rule 7). Fulfillment code depends only on this interface.
 * Per D-004, a future StoreKit integration is NOT assumed to implement this interface directly: real purchases
 * will need server-side transaction verification and idempotent fulfillment, designed in M3.
 *
 * M1 ships only the deterministic, test-controlled mock (CLAUDE.md rule 6). It is refused in production,
 * so it can never become a public backdoor that grants credits.
 */
export type PurchaseOutcome = 'APPROVED' | 'DECLINED' | 'CANCELLED';
export const PURCHASE_OUTCOMES: readonly PurchaseOutcome[] = ['APPROVED', 'DECLINED', 'CANCELLED'];

export type VerifyRequest = { transactionId: string; packageId: string; mockOutcome: PurchaseOutcome | undefined };

export type SubscriptionVerifyRequest = { transactionId: string; planId: string; mockOutcome: PurchaseOutcome | undefined };

/**
 * M2 subscription boundary. Lifecycle code depends only on these verified results, never on how they were obtained.
 * - verifySubscriptionTransaction: a purchase/upgrade the customer initiated (StoreKit 2 in M3: a signed transaction
 *   verified server-side).
 * - verifyNotification: a lifecycle notification (renewal, expiry, refund/revocation). In M3 this becomes App Store
 *   Server Notifications v2 with JWS signature verification; the mock trusts its own deterministic test input.
 * Trial eligibility stays a backend record here; M3 must also require Apple-verified intro-offer eligibility.
 */
export interface BillingProvider {
  readonly name: 'mock';
  verifyConsumablePurchase(request: VerifyRequest): Promise<{ outcome: PurchaseOutcome }>;
  verifySubscriptionTransaction(request: SubscriptionVerifyRequest): Promise<{ outcome: PurchaseOutcome }>;
  verifyNotification<T extends { eventId: string }>(notification: T): Promise<{ verified: true; notification: T }>;
}

/** Deterministic: the outcome is exactly the requested mock scenario. Without one, the purchase is DECLINED (fail closed). */
export const mockBillingProvider: BillingProvider = {
  name: 'mock',
  async verifyConsumablePurchase({ mockOutcome }) {
    return { outcome: mockOutcome ?? 'DECLINED' };
  },
  async verifySubscriptionTransaction({ mockOutcome }) {
    return { outcome: mockOutcome ?? 'DECLINED' };
  },
  async verifyNotification(notification) {
    return { verified: true, notification };
  },
};

export function billingProviderFromEnv(env: NodeJS.ProcessEnv = process.env): BillingProvider {
  const name = env.BILLING_PROVIDER ?? 'mock';
  if (name !== 'mock') throw new Error(`Unsupported BILLING_PROVIDER "${name}": only "mock" exists in M1/M2`);
  if (env.NODE_ENV === 'production') {
    throw new Error('The mock billing provider must not run with NODE_ENV=production');
  }
  return mockBillingProvider;
}
