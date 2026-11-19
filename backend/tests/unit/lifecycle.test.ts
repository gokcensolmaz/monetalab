/**
 * Pure subscription lifecycle rules (src/subscriptions/lifecycle.ts). Expected values are written out from the PRD
 * (§2.1, §4), not computed with the code under test.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decide, isEntitled, trialEligibility,
  type Command, type Decision, type History, type Period, type PlanId, type State,
} from '../../src/subscriptions/lifecycle.ts';

const T0 = new Date('2026-03-02T10:00:00.000Z');
const at = (iso: string) => new Date(iso);
const NEW: History = { trialRedeemed: false, hadAnyPeriod: false };
const USED: History = { trialRedeemed: true, hadAnyPeriod: true };
const PAID_BEFORE: History = { trialRedeemed: false, hadAnyPeriod: true };

function period(over: Partial<Period> = {}): Period {
  return {
    id: 'p1', transactionId: 'tx1', planId: 'BASIC_WEEKLY', kind: 'INITIAL',
    startsAt: T0, endsAt: at('2026-03-09T10:00:00.000Z'), credits: 3000, revoked: false, ...over,
  };
}
function state(over: Partial<State> = {}, p: Partial<Period> = {}): State {
  return { status: 'ACTIVE', planId: 'BASIC_WEEKLY', pendingPlanId: null, autoRenew: true, current: period(p), ...over };
}
const trialState = () => state({ status: 'TRIAL' }, { kind: 'TRIAL', endsAt: at('2026-03-05T10:00:00.000Z'), credits: 1000 });

function applied(d: Decision) {
  assert.equal(d.kind, 'apply', `expected apply, got ${JSON.stringify(d)}`);
  return d as Extract<Decision, { kind: 'apply' }>;
}
function rejected(d: Decision, code: string) {
  assert.equal(d.kind, 'reject', `expected reject ${code}, got ${JSON.stringify(d)}`);
  assert.equal((d as Extract<Decision, { kind: 'reject' }>).code, code);
}
function ignored(d: Decision, result: string) {
  assert.equal(d.kind, 'ignore', `expected ignore ${result}, got ${JSON.stringify(d)}`);
  assert.equal((d as Extract<Decision, { kind: 'ignore' }>).result, result);
}
const purchase = (planId: PlanId, transactionId = 'tx-new'): Command => ({ type: 'PURCHASE', planId, transactionId });
const change = (planId: PlanId, transactionId = 'tx-chg'): Command => ({ type: 'CHANGE_PLAN', planId, transactionId });
const names = (d: Extract<Decision, { kind: 'apply' }>) => d.analytics.map((e) => e.name);

describe('trial eligibility (TRIAL-01/02)', () => {
  it('[BR] a first-time customer is eligible', () => {
    assert.deepEqual(trialEligibility(NEW), { eligible: true, reason: 'FIRST_TIME_SUBSCRIBER' });
  });
  it('[NEG] a customer who redeemed the trial is not eligible', () => {
    assert.deepEqual(trialEligibility(USED), { eligible: false, reason: 'TRIAL_ALREADY_USED' });
  });
  it('[NEG] a previous paid subscriber (no trial) is not a first-time subscriber', () => {
    assert.deepEqual(trialEligibility(PAID_BEFORE), { eligible: false, reason: 'PREVIOUS_SUBSCRIBER' });
  });
});

describe('purchase', () => {
  it('[BR][TRIAL-01] eligible Basic purchase starts a 3-day trial with 1,000 subscription credits', () => {
    const d = applied(decide(null, NEW, purchase('BASIC_WEEKLY'), T0));
    assert.equal(d.result, 'TRIAL_STARTED');
    assert.deepEqual(d.newPeriod, {
      transactionId: 'tx-new', planId: 'BASIC_WEEKLY', kind: 'TRIAL',
      startsAt: T0, endsAt: at('2026-03-05T10:00:00.000Z'), credits: 1000, disposition: 'APPLIED',
    });
    assert.equal(d.grant, true);
    assert.equal(d.redeemTrial, true);
    assert.equal(d.next.status, 'TRIAL');
    assert.deepEqual(names(d), ['trial_started']);
  });
  it('[BR][TRIAL-02] Basic purchase after a used trial is a paid 7-day period with 3,000 credits, no trial', () => {
    const d = applied(decide(null, USED, purchase('BASIC_WEEKLY'), T0));
    assert.equal(d.newPeriod?.kind, 'INITIAL');
    assert.equal(d.newPeriod?.credits, 3000);
    assert.deepEqual(d.newPeriod?.endsAt, at('2026-03-09T10:00:00.000Z'));
    assert.equal(d.redeemTrial, false);
    assert.deepEqual(names(d), ['subscription_started']);
  });
  it('[BR] Premium and Ultra have no introductory offer even for a first-time customer (PRD §7 #4)', () => {
    for (const [plan, credits] of [['PREMIUM_WEEKLY', 6000], ['ULTRA_WEEKLY', 12000]] as const) {
      const d = applied(decide(null, NEW, purchase(plan), T0));
      assert.equal(d.newPeriod?.kind, 'INITIAL', plan);
      assert.equal(d.newPeriod?.credits, credits, plan);
      assert.equal(d.redeemTrial, false, plan);
    }
  });
  it('[NEG] purchase while entitled is rejected (ALREADY_SUBSCRIBED), including during a trial', () => {
    rejected(decide(state(), USED, purchase('ULTRA_WEEKLY'), T0), 'ALREADY_SUBSCRIBED');
    rejected(decide(trialState(), USED, purchase('BASIC_WEEKLY'), T0), 'ALREADY_SUBSCRIBED');
  });
  it('[BR] resubscribing after expiry starts a paid period, expires leftovers, and is not a trial', () => {
    const d = applied(decide(state({ status: 'EXPIRED', autoRenew: false }), USED, purchase('BASIC_WEEKLY'), at('2026-04-01T00:00:00.000Z')));
    assert.equal(d.newPeriod?.kind, 'INITIAL');
    assert.equal(d.expireCurrent, 'SUPERSEDED');
    assert.deepEqual(d.analytics, [{ name: 'subscription_started', properties: { planId: 'BASIC_WEEKLY', fromTrial: false, resubscribe: true } }]);
  });
  it('[NEG][TRIAL-02] a cancelled-then-lapsed trial cannot start a second trial', () => {
    const lapsedTrial = state({ status: 'EXPIRED', autoRenew: false }, { kind: 'TRIAL', credits: 1000 });
    const d = applied(decide(lapsedTrial, USED, purchase('BASIC_WEEKLY'), at('2026-04-01T00:00:00.000Z')));
    assert.notEqual(d.newPeriod?.kind, 'TRIAL');
  });
  it('[BR] a period that has ended (even if still marked ACTIVE) is not an entitlement, so purchase is allowed', () => {
    assert.equal(isEntitled(state(), at('2026-03-09T10:00:00.000Z')), false, 'the end instant is exclusive');
    assert.equal(isEntitled(state(), at('2026-03-09T09:59:59.999Z')), true);
    applied(decide(state(), USED, purchase('PREMIUM_WEEKLY'), at('2026-03-10T00:00:00.000Z')));
  });
});

describe('plan changes (SUB-03/04/05)', () => {
  const mid = at('2026-03-04T10:00:00.000Z');
  it('[BR][SUB-03] upgrade is effective now: expires the remainder and grants the full new allotment', () => {
    const d = applied(decide(state(), USED, change('PREMIUM_WEEKLY'), mid));
    assert.equal(d.result, 'UPGRADED');
    assert.equal(d.expireCurrent, 'SUPERSEDED');
    assert.deepEqual(d.newPeriod, {
      transactionId: 'tx-chg', planId: 'PREMIUM_WEEKLY', kind: 'UPGRADE',
      startsAt: mid, endsAt: at('2026-03-11T10:00:00.000Z'), credits: 6000, disposition: 'APPLIED',
    });
    assert.equal(d.grant, true);
    assert.deepEqual(names(d), ['subscription_upgraded']);
  });
  it('[BR] upgrading during the trial ends the trial: counts as conversion (subscription_started fromTrial)', () => {
    const d = applied(decide(trialState(), USED, change('ULTRA_WEEKLY'), at('2026-03-03T10:00:00.000Z')));
    assert.equal(d.newPeriod?.credits, 12000);
    assert.equal(d.next.status, 'ACTIVE');
    assert.deepEqual(names(d), ['subscription_upgraded', 'subscription_started']);
  });
  it('[BR][SUB-04] downgrade is only scheduled: no new period, no credit change', () => {
    const d = applied(decide(state({ planId: 'ULTRA_WEEKLY' }, { planId: 'ULTRA_WEEKLY', credits: 12000 }), USED, change('BASIC_WEEKLY'), mid));
    assert.equal(d.result, 'DOWNGRADE_SCHEDULED');
    assert.equal(d.newPeriod, undefined);
    assert.equal(d.expireCurrent, undefined);
    assert.equal(d.grant, undefined);
    assert.deepEqual(d.next, { pendingPlanId: 'BASIC_WEEKLY' });
    assert.deepEqual(d.analytics, []);
  });
  it('[BR] choosing the current plan again cancels a scheduled downgrade', () => {
    const d = applied(decide(state({ planId: 'ULTRA_WEEKLY', pendingPlanId: 'BASIC_WEEKLY' }, { planId: 'ULTRA_WEEKLY' }), USED, change('ULTRA_WEEKLY'), mid));
    assert.equal(d.result, 'DOWNGRADE_CANCELLED');
    assert.deepEqual(d.next, { pendingPlanId: null });
  });
  it('[NEG] same plan without a pending change, no subscription, ended entitlement, downgrade with auto-renew off', () => {
    rejected(decide(state(), USED, change('BASIC_WEEKLY'), mid), 'SAME_PLAN');
    rejected(decide(null, NEW, change('PREMIUM_WEEKLY'), mid), 'NO_ACTIVE_SUBSCRIPTION');
    rejected(decide(state({ status: 'EXPIRED', autoRenew: false }), USED, change('PREMIUM_WEEKLY'), mid), 'NO_ACTIVE_SUBSCRIPTION');
    rejected(decide(state(), USED, change('PREMIUM_WEEKLY'), at('2026-03-09T10:00:00.000Z')), 'NO_ACTIVE_SUBSCRIPTION');
    rejected(decide(state({ planId: 'PREMIUM_WEEKLY', autoRenew: false }, { planId: 'PREMIUM_WEEKLY' }), USED, change('BASIC_WEEKLY'), mid), 'AUTO_RENEW_DISABLED');
  });
});

describe('cancel / resume auto-renew', () => {
  it('[BR] cancel keeps status, plan and credits; only auto-renew turns off; emits subscription_cancelled', () => {
    const d = applied(decide(state({ pendingPlanId: null }), USED, { type: 'CANCEL_AUTO_RENEW' }, T0));
    assert.deepEqual(d.next, { autoRenew: false, pendingPlanId: null });
    assert.equal(d.expireCurrent, undefined);
    assert.deepEqual(names(d), ['subscription_cancelled']);
  });
  it('[BR] cancel during the trial is recorded as such', () => {
    const d = applied(decide(trialState(), USED, { type: 'CANCEL_AUTO_RENEW' }, T0));
    assert.equal(d.analytics[0]!.properties.duringTrial, true);
  });
  it('[NEG] repeated cancel is a no-op; resume only when off; nothing without an entitlement', () => {
    ignored(decide(state({ autoRenew: false }), USED, { type: 'CANCEL_AUTO_RENEW' }, T0), 'ALREADY_CANCELLED');
    ignored(decide(state(), USED, { type: 'RESUME_AUTO_RENEW' }, T0), 'ALREADY_AUTO_RENEWING');
    assert.deepEqual(applied(decide(state({ autoRenew: false }), USED, { type: 'RESUME_AUTO_RENEW' }, T0)).next, { autoRenew: true });
    rejected(decide(null, NEW, { type: 'CANCEL_AUTO_RENEW' }, T0), 'NO_ACTIVE_SUBSCRIPTION');
  });
});

describe('renewal (SUB-01/02/05)', () => {
  const end = at('2026-03-09T10:00:00.000Z');
  it('[BR][SUB-02] renewal starts at the previous end, expires leftovers and grants exactly one new allotment', () => {
    const d = applied(decide(state(), USED, { type: 'RENEWED', transactionId: 'tx2' }, end));
    assert.equal(d.result, 'RENEWED');
    assert.equal(d.expireCurrent, 'SUPERSEDED');
    assert.deepEqual(d.newPeriod, {
      transactionId: 'tx2', planId: 'BASIC_WEEKLY', kind: 'RENEWAL', startsAt: end, endsAt: at('2026-03-16T10:00:00.000Z'), credits: 3000, disposition: 'APPLIED',
    });
    assert.equal(d.grant, true);
    assert.deepEqual(names(d), ['subscription_renewed']);
  });
  it('[BR][SUB-01] trial conversion: first paid Basic period grants 3,000 and expires the trial remainder', () => {
    const d = applied(decide(trialState(), USED, { type: 'RENEWED', transactionId: 'tx2' }, at('2026-03-05T10:00:00.000Z')));
    assert.equal(d.result, 'TRIAL_CONVERTED');
    assert.equal(d.newPeriod?.credits, 3000);
    assert.equal(d.newPeriod?.planId, 'BASIC_WEEKLY');
    assert.equal(d.expireCurrent, 'SUPERSEDED');
    assert.deepEqual(d.analytics, [{ name: 'subscription_started', properties: { planId: 'BASIC_WEEKLY', fromTrial: true, resubscribe: false } }]);
  });
  it('[BR][SUB-05] a scheduled downgrade takes effect at renewal with the lower allotment', () => {
    const s = state({ planId: 'ULTRA_WEEKLY', pendingPlanId: 'PREMIUM_WEEKLY' }, { planId: 'ULTRA_WEEKLY', credits: 12000 });
    const d = applied(decide(s, USED, { type: 'RENEWED', transactionId: 'tx2' }, end));
    assert.equal(d.result, 'RENEWED_DOWNGRADED');
    assert.equal(d.newPeriod?.planId, 'PREMIUM_WEEKLY');
    assert.equal(d.newPeriod?.credits, 6000);
    assert.deepEqual(d.next, { status: 'ACTIVE', planId: 'PREMIUM_WEEKLY', pendingPlanId: null });
    assert.deepEqual(names(d), ['subscription_downgraded', 'subscription_renewed']);
  });
  it('[NEG] a renewal cannot start in the future (local clock alone never grants credits)', () => {
    rejected(decide(state(), USED, { type: 'RENEWED', transactionId: 'tx2' }, at('2026-03-09T09:59:59.999Z')), 'RENEWAL_NOT_DUE');
  });
  it('[NEG] out-of-order: an older renewal than the current period is kept for audit only', () => {
    const current = state({}, { startsAt: at('2026-03-16T10:00:00.000Z'), endsAt: at('2026-03-23T10:00:00.000Z') });
    const d = decide(current, USED, { type: 'RENEWED', transactionId: 'tx-old', periodStart: end }, at('2026-03-17T00:00:00.000Z'));
    ignored(d, 'IGNORED_SUPERSEDED');
    assert.equal((d as Extract<Decision, { kind: 'ignore' }>).newPeriod?.disposition, 'SUPERSEDED');
  });
  it('[BR] a renewal delivered after its own period ended is applied for state but grants nothing', () => {
    const d = applied(decide(state(), USED, { type: 'RENEWED', transactionId: 'tx2' }, at('2026-03-20T00:00:00.000Z')));
    assert.equal(d.grant, false);
  });
  it('[BR] a newer renewal reactivates an EXPIRED subscription (late billing success)', () => {
    const d = applied(decide(state({ status: 'EXPIRED', autoRenew: false }), USED, { type: 'RENEWED', transactionId: 'tx2' }, at('2026-03-10T00:00:00.000Z')));
    assert.equal(d.next.status, 'ACTIVE');
    assert.equal(d.analytics.at(-1)!.properties.reactivated, true);
  });
  it('[NEG] no renewal can restore a REVOKED subscription', () => {
    ignored(decide(state({ status: 'REVOKED', autoRenew: false }), USED, { type: 'RENEWED', transactionId: 'tx2' }, end), 'IGNORED_REVOKED');
  });
  it('[NEG] renewal without any subscription is rejected', () => {
    rejected(decide(null, NEW, { type: 'RENEWED', transactionId: 'tx2' }, end), 'NO_SUBSCRIPTION');
  });
});

describe('expiration and refund (SUB-06)', () => {
  const end = at('2026-03-09T10:00:00.000Z');
  it('[BR] expiry after the period end ends the entitlement and expires remaining credits', () => {
    const d = applied(decide(state({ autoRenew: false }), USED, { type: 'EXPIRED', transactionId: 'tx1' }, end));
    assert.equal(d.expireCurrent, 'EXPIRED');
    assert.deepEqual(d.next, { status: 'EXPIRED', pendingPlanId: null, autoRenew: false });
    assert.deepEqual(names(d), ['subscription_expired']);
  });
  it('[BR] a trial that ends without conversion emits trial_expired (not subscription_expired)', () => {
    const d = applied(decide(trialState(), USED, { type: 'EXPIRED', transactionId: 'tx1' }, at('2026-03-05T10:00:00.000Z')));
    assert.deepEqual(names(d), ['trial_expired']);
  });
  it('[NEG] expiry before the period end is rejected: cancellation never shortens a paid period', () => {
    rejected(decide(state({ autoRenew: false }), USED, { type: 'EXPIRED', transactionId: 'tx1' }, at('2026-03-09T09:59:59.999Z')), 'PERIOD_NOT_ENDED');
  });
  it('[NEG] a stale expiry for an older transaction cannot end a newer period; a second expiry is a no-op', () => {
    ignored(decide(state(), USED, { type: 'EXPIRED', transactionId: 'tx-older' }, end), 'IGNORED_STALE');
    ignored(decide(state({ status: 'EXPIRED', autoRenew: false }), USED, { type: 'EXPIRED', transactionId: 'tx1' }, end), 'IGNORED_ALREADY_ENDED');
  });
  it('[BR][SUB-06] refund of the current period revokes it now and expires remaining credits', () => {
    const d = applied(decide(state(), USED, { type: 'REFUNDED', transactionId: 'tx1', period: period() }, T0));
    assert.equal(d.result, 'REVOKED_CURRENT');
    assert.deepEqual(d.revokePeriod, { periodId: 'p1', reason: 'REFUNDED' });
    assert.equal(d.expireCurrent, 'REVOKED');
    assert.deepEqual(d.next, { status: 'REVOKED', pendingPlanId: null, autoRenew: false });
    assert.deepEqual(names(d), ['subscription_refunded']);
  });
  it('[BR] refund of an older period is recorded without touching the current entitlement or credits', () => {
    const d = applied(decide(state(), USED, { type: 'REVOKED', transactionId: 'tx0', period: period({ id: 'p0', transactionId: 'tx0' }) }, T0));
    assert.equal(d.result, 'REVOKED_PAST_PERIOD');
    assert.equal(d.expireCurrent, undefined);
    assert.deepEqual(d.next, {});
  });
  it('[NEG] repeated refund is a no-op; unknown transaction is rejected', () => {
    ignored(decide(state(), USED, { type: 'REFUNDED', transactionId: 'tx1', period: period({ revoked: true }) }, T0), 'IGNORED_ALREADY_REVOKED');
    rejected(decide(state(), USED, { type: 'REFUNDED', transactionId: 'nope', period: null }, T0), 'UNKNOWN_TRANSACTION');
  });
  it('[NEG] a revoked current period is never an entitlement', () => {
    assert.equal(isEntitled(state({}, { revoked: true }), T0), false);
    assert.equal(isEntitled(state({ status: 'REVOKED', autoRenew: false }), T0), false);
  });
});
