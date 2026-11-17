# MonetaLab — Product Requirements

**Version:** 1.0 (initial scope freeze)  
**Status:** Ready for implementation planning; unresolved decisions are explicitly listed below  
**Product:** iOS-first QA automation lab for mobile monetization  
**Primary objective:** Publish a small, working, reproducible GitHub portfolio demonstrating API/database/mobile QA, risk-based automated tests, and CI regression.  
**Development owner:** Claude Code (AI-assisted implementation).  
**Product/QA owner:** Human reviewer makes product decisions and accepts verified output.

## 1. Scope and delivery priorities

This is a **testable product fixture**, not a production commercial application. It must support deterministic mock purchase/ad paths while preserving boundaries needed for later real Apple StoreKit 2 testing.

### M1 — First publishable release (required for first portfolio milestone)
- Create account, sign in/out, identify the current user.
- Display credit wallet and itemized transaction history.
- Mock consumable purchases: approved, declined, cancelled, duplicate/retried requests.
- Consume credits for predefined actions; block insufficient credit; open paywall.
- Support all four credit buckets with ordered, atomic deductions.
- Provide API + database automated tests and GitHub Actions PR regression.
- Basic iOS app capable of exercising the core paths.
- Repository setup, setup instructions, test matrix and evidence in README.

### M2 — Controlled monetization lifecycle
- Mock subscription offers and state machine, including the three-day Basic introductory trial, recurring weekly plans, renewal, expiration, cancellation, upgrade/downgrade, restore and refund.
- Mock rewarded advertisement flow, quota tracking and paywall interaction.
- Emit server-side lifecycle events for churn and conversion analysis.
- Comprehensive API/database tests of lifecycle invariants and concurrency.

### M3 — Real Apple platform integration
- StoreKit 2 subscription group, introductory offer, consumables, locally configured StoreKit tests, Apple Sandbox / TestFlight where account access permits.
- Verify transaction and entitlement status server-side; use actual StoreKit purchase states and App Store Server APIs/Notifications as appropriate.
- Keep tests that require Apple services separate from fast, deterministic PR checks.

### M4 — AI workflow evidence
- Add practical, versioned Claude Code instructions, skills, review subagents, hooks and MCP integrations **incrementally**, only when used and verified.
- Maintain examples showing AI-assisted implementation, test review and QA decisions. Do not introduce complex agent orchestration into M1.

### Explicit non-goals for M1
- Real payments, live ad network, AI photo processing, Android app, complex design system, customer-scale deployment, extensive observability, multiple repositories or custom framework building.

## 2. Product model

### 2.1 Subscription plans and credit grants

| Plan / stage | Period | Credits granted | Notes |
|---|---|---:|---|
| Basic introductory free trial | 3 days | 1,000 | Apple's introductory offer for eligible first-time subscribers in the subscription group |
| Basic | Weekly | 3,000 | First paid period and each successful renewal |
| Premium | Weekly | 6,000 | Each successful entitlement period |
| Ultra | Weekly | 12,000 | Each successful entitlement period |

- Basic, Premium and Ultra belong to **one Apple subscription group** in the real integration.
- A customer who has already consumed an introductory trial must not receive a second introductory trial. This applies to attempts to re-subscribe and switch plan. Eligibility must be confirmed with Apple; backend records must enforce its own grants and prevent duplicate credits. Do not claim the app can conclusively identify all distinct Apple IDs by local app-user IDs alone.
- During the three-day Basic trial, grant **1,000 subscription credits**. At the start of the first successfully verified paid Basic period, expire the remaining trial subscription credits and grant **3,000** new credits. Do not grant paid credits merely because the local clock shows the trial ended.
- At successful renewal, expire unused credits from the previous subscription period and grant the new period allocation.
- Subscription credits do not roll over. Each event must be processed idempotently.
- On an **effective** upgrade, invalidate the prior plan's unused subscription credits and grant the full new plan allocation. In the real integration, use the effective entitlement change confirmed by Apple rather than a tapped UI button.
- A downgrade request does **not** immediately replace credits. Keep the current plan and credits until Apple's confirmed effective transition, generally the next renewal; then expire unused subscription credits and grant the lower plan allocation.
- On subscription expiration or verified refund/revocation, invalidate unused subscription credits, while keeping historical ledger records.
- Consumable credits must not change because of renewals, upgrades or downgrades.
- Cancellation of auto-renew by itself does not immediately expire a still-valid entitlement; subscription benefits persist to the valid end date unless otherwise revoked.

### 2.2 Consumable packages

| Package ID (working name) | Credits |
|---|---:|
| Credits S | 5,000 |
| Credits M | 7,000 |
| Credits L | 10,000 |

- Consumables can be purchased multiple times; each **verified distinct** purchase produces exactly one grant.
- A declined, cancelled, unverified, or duplicate transaction may not grant credits.
- Consumable credits are preserved across plan renewals, upgrades, downgrades, expiration and cancellation. Refund handling for previously purchased consumable credit packs is **not yet specified**; see decisions.

### 2.3 Processing actions

| Action (placeholder name) | Credit cost |
|---|---:|
| Basic processing | 100 |
| Standard processing | 500 |
| Advanced processing | 800 |

- Processing itself can return a deterministic simulated output; third-party AI processing is not required.
- Debit credits only when the backend accepts an eligible billable operation (exact completion/refund-on-failure policy is an open decision).
- Negative credit balances are prohibited.

### 2.4 Credit buckets and consumption ordering

**Mandatory priority:** `SUBSCRIPTION -> CONSUMABLE -> REWARD -> PROMOTIONAL`.

- Trial credits are tracked in `SUBSCRIPTION` because they originate from the introductory subscription offer.
- Rewarded ads grant into `REWARD`. `PROMOTIONAL` is reserved for future, independent promotions.
- A single operation may debit multiple buckets in this order.
- Insufficient *total available* balance blocks the **entire** operation; do not debit any bucket.
- All bucket debits and the operation ledger must commit atomically; concurrent consumption must never overdraw or double-spend.
- Historical records must be immutable/auditable; expiration should be represented through ledger entries or equivalent durable accounting, not by deleting records.
- Entitlement periods, purchase transaction IDs, ad reward IDs and operation request IDs must be safely idempotent.

**Example:** A user has 200 subscription, 300 consumable, 400 reward and 1,000 promotional credits. An 800-credit action debits 200 + 300 + 300 + 0, leaving 0 + 0 + 100 + 1,000.

## 3. Paywall and rewarded ads

### 3.1 Insufficient-credit paywall
- If a requested operation costs more than the sum of currently available credits, the backend rejects the operation with an explicit insufficient-credits error. The iOS app opens a paywall.
- Paywall has two tabs: **Subscription | Credits**.
- Subscription tab lists Basic Weekly (3,000), Premium Weekly (6,000), Ultra Weekly (12,000). Only present introductory-trial messaging when genuinely eligible.
- Credits tab lists 5,000 / 7,000 / 10,000 consumable packs.
- A **Continue** button initiates purchase for the selected item; purchase cancellation/failure leaves balances unchanged.
- Beneath Continue, show **Watch an Ad — Earn 100 Credits** when the user is eligible under ad rules.
- Ads are allowed for free, trial, expired and actively subscribed users when their available credits are insufficient for the requested operation; a paid plan is **not** an ad exclusion.
- After a successful purchase or ad reward, re-fetch the balance. If the user now has enough credits for the original operation, **dismiss the paywall and return to the original screen**.
- **Never auto-execute the originally blocked operation.** It requires explicit fresh user confirmation.
- If credits remain insufficient, stay on paywall and allow further eligible purchase/ad options.
- Handle closing paywall without changes, stale balance and repeated navigation gracefully.

### 3.2 Rewarded ad limits
- A successfully completed and verified rewarded ad grants **100 `REWARD` credits**.
- Limit: **10 rewarded ads per user per UTC calendar day**; maximum **1,000 reward credits/day**.
- Quota counts only successfully verified rewarded events. Unloaded ads and early closures grant no credits and consume no quota.
- On reaching 10/10, disable the UI option; server must independently reject further reward fulfillment.
- The new UTC day restores a new 10-ad quota. Device time/timezone changes must not change the server-enforced quota.
- Duplicate reward events must grant zero additional credit and use zero additional quota.
- Concurrent rewards must not exceed 10 grants. Implement a unique event identifier and transactional server-side quota guard.
- In M2, use a controlled mock ad provider; in any future live network integration, verify ad rewards using supported server-side verification rather than trusting client-only `completed=true`.

## 4. Subscription lifecycle and analytics

Required events for QA and analytics:
- `trial_started`, `trial_expired`, `subscription_started`, `subscription_renewed`, `subscription_cancelled`, `subscription_expired`, `subscription_refunded`, `subscription_upgraded`, `subscription_downgraded`, `reward_granted`.

- Distinguish **cancellation of auto-renew** from **expiration of paid entitlement**.
- Measure trial-to-paid conversion separately from paid subscriber churn.
- **Working churn definition** (to confirm before analytics implementation): paid subscriptions that expire without an active paid replacement within the reporting interval, divided by paid subscribers at period start. Specify window, reinstatement handling and cohort boundaries before publishing metrics.
- Notifications can arrive late, duplicate or out of order; derive effective state from authoritative, verified subscription/transaction state rather than blindly replaying messages in arrival order.

## 5. Core QA acceptance criteria

| ID | Behavior | Expected result |
|---|---|---|
| AUTH-01 | New account / login | Secure user-specific wallet and history |
| BUY-01 | Mock approved pack purchase | Single correct consumable grant |
| BUY-02 | Declined/cancelled purchase | No credit change |
| BUY-03 | Duplicate verified purchase | Grant exactly once |
| CR-01 | Operation with sufficient credit | Exact ordered, atomic bucket debits |
| CR-02 | Operation with insufficient credit | Zero debit; insufficient-credit error; paywall opens |
| CR-03 | Concurrent operations | No negative balances or double spending |
| TRIAL-01 | Eligible first trial | 1,000 subscription credits, once |
| TRIAL-02 | Previously used trial | No second intro offer or duplicate grant |
| SUB-01 | First paid Basic period | Old trial remainder expires; 3,000 granted after verification |
| SUB-02 | Renewal | Old subscription credits expire; one new grant |
| SUB-03 | Effective upgrade | Prior subscription remainder expires; full new plan grant |
| SUB-04 | Requested downgrade | No immediate credit change |
| SUB-05 | Effective downgrade | New plan amount granted; no consumable loss |
| SUB-06 | Expiration/refund revocation | Subscription entitlement/unused credits invalidated; historical ledger preserved |
| ADS-01 | Verified ad completion | +100 reward; quota +1 |
| ADS-02 | Incomplete/failed ad | No reward, quota unchanged |
| ADS-03 | 11th ad in UTC day | Server rejects, UI disables |
| ADS-04 | Duplicate/concurrent reward claims | No duplicate credit, no quota overflow |
| PW-01 | Subscription/Credits tabs | Correct plans and packs shown |
| PW-02 | Sufficient credit after reward/purchase | Paywall closes to prior screen; operation awaits user confirmation |
| PW-03 | Still insufficient after reward | Paywall remains open |
| CI-01 | Open PR | Deterministic API/DB regression and report run in GitHub Actions |

## 6. Engineering and QA guardrails

- Keep mock providers and later Apple implementations behind testable billing/reward boundaries; do not build the real Apple integration before M1 is accepted.
- Backend owns balance calculation, quota enforcement and fulfillment; UI is not the system of record.
- Keep test fixtures deterministic and isolated across users and CI runs.
- Provide explicit error codes, stable API contracts and controllable fixtures for success, decline, cancel, delayed, duplicate and out-of-order events.
- Keep secrets, live credentials and proprietary code out of the public repository.
- Tests need independently calculated expectations and meaningful failure messages, not assertions that simply mirror implementation output.
- Prioritize a fully working end-to-end slice over broad, unfinished architecture. Never claim unrun tests passed.

## 7. Decisions still open (do NOT invent product requirements)

1. **Pricing/currency:** Apple prices for Basic/Premium/Ultra and consumable packs, including localization, are not yet selected. For M1 use clearly labeled placeholder UI prices or omit prices where possible; never present them as live App Store amounts.
2. **Refund of consumable packs:** Define credit clawback behavior if already spent and whether negative debt is allowed (initial rule says negative balances are prohibited).
3. **Billable operation failure:** Decide whether charging happens at request acceptance, success, or with reversal on failure.
4. **Plan trial and upgraded eligibility:** Free trial is defined for Basic first-time eligible users; do not assume Premium/Ultra intro offers exist. The group may contain multiple tiers but offer configuration must be verified at App Store Connect setup.
5. **Ad visibility outside the insufficient-credit paywall:** Currently specified for insufficient credit; do not add a persistent ad farm elsewhere without approval.
6. **Trial end with failed billing / grace period:** Follow verified Apple entitlement behavior; detailed handling belongs to M3 specification.
7. **Existing subscriber buying the same tier, restore account conflicts, and account deletion:** Define product policy before implementing these edge cases.
8. **Promotional credit grants and expiration:** Bucket is defined, but campaign grant rules are not.
9. **Trial eligibility cross-account enforcement:** Require Apple-verified eligibility plus backend anti-duplication; do not promise global detection of every Apple identity across separate app accounts without a privacy-safe account-link policy.
10. **Churn formula/reporting interval:** Working definition only; approve before presenting metrics.

## 8. Milestone completion policy

**M1 done** means another engineer can clone the repository, start API + DB locally using documented commands, run automated tests, and exercise an iOS UI path from login through mock purchase, credit spending and paywall. A PR triggers deterministic regression with accessible results. Features from M2–M4 do not block M1.

**Change policy:** New product ideas go into a backlog unless they fix a critical inconsistency. Update this file intentionally, record the decision, then ask Claude Code to implement only the authorized small slice.
