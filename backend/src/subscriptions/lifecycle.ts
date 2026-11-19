/**
 * Pure subscription lifecycle rules (PRD §2.1, §4; decisions D-027..D-031). No I/O: given the current state, the
 * customer's history and one verified command, decide() returns what must happen. The database layer
 * (src/subscriptions/service.ts) applies the decision atomically under a per-user lock.
 *
 * Time: `now` is the server's business clock (src/clock.ts), never the client's.
 */

export const SUBSCRIPTION_GROUP = 'MONETALAB_WEEKLY';
export const PLAN_IDS = ['BASIC_WEEKLY', 'PREMIUM_WEEKLY', 'ULTRA_WEEKLY'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export type Plan = { id: PlanId; name: string; tier: number; periodDays: number; credits: number };
export const PLANS: Record<PlanId, Plan> = {
  BASIC_WEEKLY: { id: 'BASIC_WEEKLY', name: 'Basic', tier: 1, periodDays: 7, credits: 3000 },
  PREMIUM_WEEKLY: { id: 'PREMIUM_WEEKLY', name: 'Premium', tier: 2, periodDays: 7, credits: 6000 },
  ULTRA_WEEKLY: { id: 'ULTRA_WEEKLY', name: 'Ultra', tier: 3, periodDays: 7, credits: 12000 },
};
/** The only introductory offer (PRD §2.1; open decision #4: no Premium/Ultra offers are assumed). */
export const TRIAL_OFFER = { planId: 'BASIC_WEEKLY' as PlanId, kind: 'FREE_TRIAL' as const, days: 3, credits: 1000 };

const DAY_MS = 24 * 60 * 60 * 1000;
export const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

export type Status = 'TRIAL' | 'ACTIVE' | 'EXPIRED' | 'REVOKED';
export type PeriodKind = 'TRIAL' | 'INITIAL' | 'RENEWAL' | 'UPGRADE';
export type ExpirationReason = 'SUPERSEDED' | 'PERIOD_ENDED' | 'EXPIRED' | 'REVOKED';

export type Period = {
  id: string;
  transactionId: string;
  planId: PlanId;
  kind: PeriodKind;
  startsAt: Date;
  endsAt: Date;
  credits: number;
  revoked: boolean;
};

export type State = {
  status: Status;
  planId: PlanId;
  pendingPlanId: PlanId | null;
  autoRenew: boolean;
  current: Period;
};

/** Persistent facts about the customer in this subscription group (from immutable records). */
export type History = { trialRedeemed: boolean; hadAnyPeriod: boolean };

export type Command =
  | { type: 'PURCHASE'; planId: PlanId; transactionId: string }
  | { type: 'CHANGE_PLAN'; planId: PlanId; transactionId: string }
  | { type: 'CANCEL_AUTO_RENEW' }
  | { type: 'RESUME_AUTO_RENEW' }
  | { type: 'RENEWED'; transactionId: string; periodStart?: Date }
  | { type: 'EXPIRED'; transactionId: string }
  | { type: 'REFUNDED' | 'REVOKED'; transactionId: string; period: Period | null };

export type AnalyticsName =
  | 'trial_started' | 'trial_expired' | 'subscription_started' | 'subscription_renewed' | 'subscription_cancelled'
  | 'subscription_expired' | 'subscription_refunded' | 'subscription_upgraded' | 'subscription_downgraded';
export type AnalyticsEvent = { name: AnalyticsName; properties: Record<string, unknown> };

export type NewPeriod = Omit<Period, 'id' | 'revoked'> & { disposition: 'APPLIED' | 'SUPERSEDED' };

export type Decision =
  | { kind: 'reject'; status: 404 | 409; code: string; message: string }
  | { kind: 'ignore'; result: string; message: string; newPeriod?: NewPeriod }
  | {
      kind: 'apply';
      result: string;
      /** A new verified period (becomes current when its disposition is APPLIED). */
      newPeriod?: NewPeriod;
      /** Grant the new period's credits (false when the period had already ended on arrival). */
      grant?: boolean;
      /** Expire the remaining SUBSCRIPTION credits of the current period, with this reason. */
      expireCurrent?: ExpirationReason;
      redeemTrial?: boolean;
      revokePeriod?: { periodId: string; reason: 'REFUNDED' | 'REVOKED' };
      next: Partial<Omit<State, 'current'>> & { status?: Status };
      analytics: AnalyticsEvent[];
    };

export type TrialEligibility =
  | { eligible: true; reason: 'FIRST_TIME_SUBSCRIBER' }
  | { eligible: false; reason: 'TRIAL_ALREADY_USED' | 'PREVIOUS_SUBSCRIBER' };

/**
 * Backend eligibility for the Basic introductory trial. "First-time subscriber" (PRD §2.1): no trial redeemed and no
 * earlier period of any plan in the group. This is the backend's anti-duplication record only. With StoreKit (M3)
 * the effective rule is: Apple-verified eligibility AND this backend check (PRD open decision #9).
 */
export function trialEligibility(history: History): TrialEligibility {
  if (history.trialRedeemed) return { eligible: false, reason: 'TRIAL_ALREADY_USED' };
  if (history.hadAnyPeriod) return { eligible: false, reason: 'PREVIOUS_SUBSCRIBER' };
  return { eligible: true, reason: 'FIRST_TIME_SUBSCRIBER' };
}

/** Entitlement is active only while the provider-confirmed current period has not ended and was not revoked. */
export function isEntitled(state: State | null, now: Date): boolean {
  return !!state && (state.status === 'TRIAL' || state.status === 'ACTIVE') && !state.current.revoked && now < state.current.endsAt;
}

const reject = (status: 404 | 409, code: string, message: string): Decision => ({ kind: 'reject', status, code, message });

export function decide(state: State | null, history: History, command: Command, now: Date): Decision {
  switch (command.type) {
    case 'PURCHASE': {
      if (isEntitled(state, now)) {
        // PRD open decision #7 (same/other tier while subscribed) is unresolved: plan changes go through CHANGE_PLAN.
        return reject(409, 'ALREADY_SUBSCRIBED', 'An active subscription exists; use a plan change instead');
      }
      const trial = command.planId === TRIAL_OFFER.planId && trialEligibility(history).eligible;
      const plan = PLANS[command.planId];
      const newPeriod: NewPeriod = trial
        ? { transactionId: command.transactionId, planId: plan.id, kind: 'TRIAL', startsAt: now, endsAt: addDays(now, TRIAL_OFFER.days), credits: TRIAL_OFFER.credits, disposition: 'APPLIED' }
        : { transactionId: command.transactionId, planId: plan.id, kind: 'INITIAL', startsAt: now, endsAt: addDays(now, plan.periodDays), credits: plan.credits, disposition: 'APPLIED' };
      return {
        kind: 'apply',
        result: trial ? 'TRIAL_STARTED' : 'SUBSCRIPTION_STARTED',
        newPeriod,
        grant: true,
        // A lapsed earlier period may still hold unexpired credits if nothing reconciled it yet.
        ...(state && { expireCurrent: 'SUPERSEDED' as const }),
        redeemTrial: trial,
        next: { status: trial ? 'TRIAL' : 'ACTIVE', planId: plan.id, pendingPlanId: null, autoRenew: true },
        analytics: [
          trial
            ? { name: 'trial_started', properties: { planId: plan.id, credits: TRIAL_OFFER.credits, days: TRIAL_OFFER.days } }
            : { name: 'subscription_started', properties: { planId: plan.id, fromTrial: false, resubscribe: !!state } },
        ],
      };
    }

    case 'CHANGE_PLAN': {
      if (!state || !isEntitled(state, now)) return reject(409, 'NO_ACTIVE_SUBSCRIPTION', 'There is no active subscription to change');
      const from = PLANS[state.planId];
      const to = PLANS[command.planId];
      if (to.id === from.id) {
        if (state.pendingPlanId) {
          return { kind: 'apply', result: 'DOWNGRADE_CANCELLED', next: { pendingPlanId: null }, analytics: [] };
        }
        return reject(409, 'SAME_PLAN', 'You are already on this plan');
      }
      if (to.tier < from.tier) {
        // SUB-04: a downgrade never changes credits now; it takes effect at the next renewal.
        if (!state.autoRenew) return reject(409, 'AUTO_RENEW_DISABLED', 'Auto-renew is off, so there is no next renewal to downgrade');
        return { kind: 'apply', result: 'DOWNGRADE_SCHEDULED', next: { pendingPlanId: to.id }, analytics: [] };
      }
      // SUB-03: an effective upgrade starts a new paid period now with the full new allotment.
      const fromTrial = state.current.kind === 'TRIAL';
      return {
        kind: 'apply',
        result: 'UPGRADED',
        newPeriod: { transactionId: command.transactionId, planId: to.id, kind: 'UPGRADE', startsAt: now, endsAt: addDays(now, to.periodDays), credits: to.credits, disposition: 'APPLIED' },
        grant: true,
        expireCurrent: 'SUPERSEDED',
        next: { status: 'ACTIVE', planId: to.id, pendingPlanId: null },
        analytics: [
          { name: 'subscription_upgraded', properties: { fromPlanId: from.id, toPlanId: to.id, fromTrial } },
          ...(fromTrial ? [{ name: 'subscription_started' as const, properties: { planId: to.id, fromTrial: true, resubscribe: false } }] : []),
        ],
      };
    }

    case 'CANCEL_AUTO_RENEW': {
      if (!state || !isEntitled(state, now)) return reject(409, 'NO_ACTIVE_SUBSCRIPTION', 'There is no active subscription to cancel');
      if (!state.autoRenew) return { kind: 'ignore', result: 'ALREADY_CANCELLED', message: 'Auto-renew is already off' };
      // Entitlement and credits stay until the period ends (PRD §2.1).
      return {
        kind: 'apply',
        result: 'AUTO_RENEW_DISABLED',
        next: { autoRenew: false, pendingPlanId: null },
        analytics: [{ name: 'subscription_cancelled', properties: { planId: state.planId, periodEndsAt: state.current.endsAt.toISOString(), duringTrial: state.status === 'TRIAL' } }],
      };
    }

    case 'RESUME_AUTO_RENEW': {
      if (!state || !isEntitled(state, now)) return reject(409, 'NO_ACTIVE_SUBSCRIPTION', 'There is no active subscription to resume');
      if (state.autoRenew) return { kind: 'ignore', result: 'ALREADY_AUTO_RENEWING', message: 'Auto-renew is already on' };
      return { kind: 'apply', result: 'AUTO_RENEW_ENABLED', next: { autoRenew: true }, analytics: [] };
    }

    case 'RENEWED': {
      if (!state) return reject(409, 'NO_SUBSCRIPTION', 'There is no subscription to renew');
      const planId = state.pendingPlanId ?? state.planId;
      const plan = PLANS[planId];
      const startsAt = command.periodStart ?? state.current.endsAt;
      if (startsAt > now) return reject(409, 'RENEWAL_NOT_DUE', 'A renewal cannot start in the future');
      const newPeriod: NewPeriod = { transactionId: command.transactionId, planId, kind: 'RENEWAL', startsAt, endsAt: addDays(startsAt, plan.periodDays), credits: plan.credits, disposition: 'APPLIED' };
      if (state.status === 'REVOKED') {
        // Ordering can never restore a revoked entitlement (D-030).
        return { kind: 'ignore', result: 'IGNORED_REVOKED', message: 'The subscription was revoked', newPeriod: { ...newPeriod, disposition: 'SUPERSEDED' } };
      }
      if (startsAt <= state.current.startsAt) {
        // Delayed / out-of-order: an older period than the current one. Audit only, no credits.
        return { kind: 'ignore', result: 'IGNORED_SUPERSEDED', message: 'A newer period is already in effect', newPeriod: { ...newPeriod, disposition: 'SUPERSEDED' } };
      }
      const fromTrial = state.current.kind === 'TRIAL';
      const downgraded = !fromTrial && plan.tier < PLANS[state.planId].tier;
      const analytics: AnalyticsEvent[] = fromTrial
        ? [{ name: 'subscription_started', properties: { planId, fromTrial: true, resubscribe: false } }]
        : [
            ...(downgraded ? [{ name: 'subscription_downgraded' as const, properties: { fromPlanId: state.planId, toPlanId: planId } }] : []),
            { name: 'subscription_renewed', properties: { planId, reactivated: state.status === 'EXPIRED' } },
          ];
      return {
        kind: 'apply',
        result: fromTrial ? 'TRIAL_CONVERTED' : downgraded ? 'RENEWED_DOWNGRADED' : 'RENEWED',
        newPeriod,
        // SUB-01/02: expire the previous period's remainder, grant the new allotment once. A period that already
        // ended before its notification arrived grants nothing (its credits could never be spent).
        grant: newPeriod.endsAt > now,
        expireCurrent: 'SUPERSEDED',
        next: { status: 'ACTIVE', planId, pendingPlanId: null },
        analytics,
      };
    }

    case 'EXPIRED': {
      if (!state) return reject(409, 'NO_SUBSCRIPTION', 'There is no subscription to expire');
      if (command.transactionId !== state.current.transactionId) {
        return { kind: 'ignore', result: 'IGNORED_STALE', message: 'The notification refers to an older period' };
      }
      if (state.status === 'EXPIRED' || state.status === 'REVOKED') {
        return { kind: 'ignore', result: 'IGNORED_ALREADY_ENDED', message: 'The subscription already ended' };
      }
      if (now < state.current.endsAt) {
        // Cancellation never shortens a paid period; an expiry can only follow the period end (PRD §2.1).
        return reject(409, 'PERIOD_NOT_ENDED', 'The current period has not ended yet');
      }
      const trial = state.current.kind === 'TRIAL';
      return {
        kind: 'apply',
        result: 'EXPIRED',
        expireCurrent: 'EXPIRED',
        next: { status: 'EXPIRED', pendingPlanId: null, autoRenew: false },
        analytics: [trial
          ? { name: 'trial_expired', properties: { planId: state.planId } }
          : { name: 'subscription_expired', properties: { planId: state.planId } }],
      };
    }

    case 'REFUNDED':
    case 'REVOKED': {
      if (!state || !command.period) return reject(409, 'UNKNOWN_TRANSACTION', 'No period with this transaction id');
      if (command.period.revoked) return { kind: 'ignore', result: 'IGNORED_ALREADY_REVOKED', message: 'This period was already revoked' };
      const isCurrent = command.period.id === state.current.id;
      return {
        kind: 'apply',
        result: isCurrent ? 'REVOKED_CURRENT' : 'REVOKED_PAST_PERIOD',
        revokePeriod: { periodId: command.period.id, reason: command.type },
        // SUB-06: remove remaining subscription credits only; consumed credits are never clawed back.
        ...(isCurrent && { expireCurrent: 'REVOKED' as const }),
        next: isCurrent ? { status: 'REVOKED', pendingPlanId: null, autoRenew: false } : {},
        analytics: [{ name: 'subscription_refunded', properties: { reason: command.type, planId: command.period.planId, currentPeriod: isCurrent } }],
      };
    }
  }
}
