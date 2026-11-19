/**
 * Rewarded-ad provider boundary (PRD §3.2, D-032). Fulfillment depends only on the verified outcome returned here.
 * A future live ad network must implement this with server-side reward verification (e.g. signed server-to-server
 * callbacks), never by trusting a client-reported `completed=true`.
 *
 * M2 ships only the deterministic mock, refused when NODE_ENV=production.
 */
export type AdOutcome = 'COMPLETED' | 'INCOMPLETE' | 'FAILED';
export const AD_OUTCOMES: readonly AdOutcome[] = ['COMPLETED', 'INCOMPLETE', 'FAILED'];

export interface AdProvider {
  readonly name: 'mock';
  verifyReward(request: { adEventId: string; mockOutcome: AdOutcome | undefined }): Promise<{ outcome: AdOutcome }>;
}

/** Deterministic: the outcome is the requested mock scenario. Without one the ad counts as FAILED (fail closed). */
export const mockAdProvider: AdProvider = {
  name: 'mock',
  async verifyReward({ mockOutcome }) {
    return { outcome: mockOutcome ?? 'FAILED' };
  },
};

export function adProviderFromEnv(env: NodeJS.ProcessEnv = process.env): AdProvider {
  const name = env.AD_PROVIDER ?? 'mock';
  if (name !== 'mock') throw new Error(`Unsupported AD_PROVIDER "${name}": only "mock" exists in M2`);
  if (env.NODE_ENV === 'production') throw new Error('The mock ad provider must not run with NODE_ENV=production');
  return mockAdProvider;
}
