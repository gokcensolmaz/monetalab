# MonetaLab — M2 Verification Report

**Date:** 2026-11-18
**Branch:** `m2-subscriptions-rewards`, based on `origin/main` @ `3e51fbf` (M1 merged via PR #2). Committed and pushed for one PR into `main` on 2026-11-19 with owner approval; the GitHub Actions run is reported in the PR, not here.
**Scope:** the complete M2 milestone (PRD §1 M2, §2.1, §3, §4; acceptance IDs TRIAL-01/02, SUB-01…06, ADS-01…04, PW-01…03), done in one continuous run as authorized by the owner. A single final owner QA review is pending.
**Environment:**
- macOS 27.2.1, Apple Silicon
- Node v24.20.0, npm 11.19.0
- Docker 29.9.3, `postgres:16.16-alpine`
- Xcode 27.2 (27B52), installed on 2026-11-18 after the macOS update and replacing Xcode 16.2. Simulators: iPhone 17 (iOS 27.2) and iPhone 16 (iOS 18.3). The first iOS build rows were originally measured with Xcode 16.2; §4 has the history.

**Labels:**
- **PASS:** executed here, with evidence below
- **FAIL:** executed and failing
- **NOT VERIFIED / NOT RUN:** not executed, with the reason given
- **M3:** the PRD assigns it to a later milestone

Nothing below is marked PASS based on code alone.

---

## 1. Automated results (all actually executed unless marked NOT RUN)

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `npm run typecheck` (backend, `tsc --noEmit`, strict) | 0 | No errors |
| 2 | `npm run test:unit` | 0 | **104 / 104**. M1: 63. New in M2: `lifecycle.test.ts` 35, `clock.test.ts` 6 |
| 3 | `npm run test:integration` | 0 | **92 / 92**. M1: 73, with `migrations.test.ts` updated for `003` (D-036). New in M2: `m2-integrity.test.ts` 19 |
| 4 | `npm run test:api` (Playwright, 2 harness-owned servers, disposable DB) | 0 | **145 / 145**. M1: 102. New in M2: `subscriptions.spec.ts` 24, `ads.spec.ts` 11, `lifecycle-time.spec.ts` 8 (controlled clock, serial) |
| 5 | The full API suite run 3× | 0 | 144/144 on all three runs (before the extra concurrency test), then 145/145. No flakes |
| 6 | CI simulation: workflow steps in a clean copy, fresh `npm ci`, fresh disposable DB | 0 | See the detail below |
| 7 | Mutation checks (14 deliberate defects, §3) | — | **13 caught, 1 equivalent mutant** (explained) |
| 8 | `xcodebuild … clean build-for-testing` (app, unit-test and UI-test targets) | 0 | `TEST BUILD SUCCEEDED`. Xcode 16.2: 0 Swift warnings. Xcode 27.2 first showed **4 warnings**, all `'weak' ownership of capture 'app' differs from implicitly-captured strong reference in outer scope [#ImplicitStrongCapture]`, at `WalletView.swift:44:89`, `WalletView.swift:45:72`, `OperationView.swift:64:129` and `OperationView.swift:65:72`. **Fixed on 2026-11-19** (§4a). After the fix: **0 Swift warnings** (only Xcode's informational `appintentsmetadataprocessor` notes, which aren't from project code) |
| 9 | `xcodebuild … -configuration Release -destination 'generic/platform=iOS Simulator' build` | 0 | `BUILD SUCCEEDED` (Xcode 16.2; Xcode 27.2 with 4 warnings before the fix; **Xcode 27.2 with 0 Swift warnings after the fix**, 2026-11-19) |
| 10 | `xcodebuild … test` (iOS unit + UI tests, real disposable backend from `npm run e2e:server`) | 0 | **36 / 36 unit + 3 / 3 UI** (22 M1 + 14 `M2FlowTests`; 2 M1 + 1 M2 journey). Xcode 27.2, 2026-11-18: **3 consecutive full passes** on iPhone 17 / iOS 27.2 (runs 8–10) and **1 full pass** on iPhone 16 / iOS 18.3 (run 11). Earlier runs 1–7 failed in the UI tests (§4). **Final code, 2026-11-19 (§4a):** run 12 **FAILED** (38/39), then **39/39** on runs 13 and 14 (iOS 27.2) and run 15 (iOS 18.3.1) |
| 12 | Backend rerun on the final tree, 2026-11-19 (`typecheck`, `test:unit`, `test:integration`, `test:api`) | 0 | typecheck clean; **104 / 104**, **92 / 92**, **145 / 145** (341 total). The backend code is identical to the 2026-11-18 runs |
| 11 | Dev server smoke test on the migrated dev DB (`node src/server.ts`) | 0 | See the detail below |

**CI simulation detail (row 6):**
- Typecheck: exit 0.
- Migrations: `001`, `002` and `003` applied.
- JUnit files: unit 104, integration 92 and API 145 test cases, **0 failures** in each.
- Playwright HTML report: `playwright-report/index.html` (684 KB).
- Analytics-report smoke step: valid JSON.
- No browsers were downloaded: the existing Playwright cache folders date from Aug–Sep 2026.
- The disposable DB was dropped; only `monetalab` remains.

**Dev server smoke detail (row 11):**
- `/health` 200; the catalog shows 3 plans and the ad as available.
- `/subscriptions/current` and `/ads/quota` without auth: 401.
- `NODE_ENV=production`: exits 1 (the mock provider is refused).
- An unreadable `MONETALAB_TEST_CLOCK_FILE`: exits 1.
- `npm run analytics:report`: OK.

**Dev database:** migration `003` was applied to the local `monetalab` database. It's additive, and the volume `monetalab_monetalab-db` is intact. No test database or server is left behind.

## 2. Requirement-by-requirement checklist

### A. Mock subscription provider
| Requirement | Status | Evidence |
|---|---|---|
| Basic 3,000 / Premium 6,000 / Ultra 12,000 weekly, one group | **PASS** | integration "M2 catalog"; API `[BR][PW-01] catalog…`; plans enforced by the immutable `subscription_plans` table |
| Activation, active entitlement, cancellation, expiration, weekly renewal | **PASS** | `subscriptions.spec` (start, cancel/resume), `lifecycle-time.spec` (renewal at exact boundaries, expiry only at the end); unit `purchase`, `cancel`, `renewal`, `expiration` |
| Deterministic mock outcomes, verifiable events | **PASS** | `mockOutcome` APPROVED/DECLINED/CANCELLED (missing = DECLINED); every request and notification stored in `subscription_events` with its result; `GET /subscriptions/history` |
| Idempotent event and transaction ids, safe under concurrent delivery | **PASS** | API: replay → 200, conflict → 409; 10 concurrent duplicates → 1 grant; 10× same notification and 10× same transaction under new ids → 1 grant; unique `(provider, transaction_id)` across users (integration) |
| State, renewal dates, cancellation status, history | **PASS** | `GET /subscriptions/current` (`renewsAt`, `expiresAt`, `autoRenew`, `pendingPlanId`, `entitled`), `/subscriptions/history` |
| API contract defined; mock replaceable by StoreKit | **PASS** (design) | D-027; the `BillingProvider.verifySubscriptionTransaction / verifyNotification` boundary. The M3 StoreKit implementation is **M3** |

### B. Introductory free trial
| Requirement | Status | Evidence |
|---|---|---|
| TRIAL-01: Basic trial, 3 days, 1,000 SUBSCRIPTION credits, once | **PASS** | API `[BR][TRIAL-01]` (exact 3-day period, ledger grant 1,000, redemption row); unit |
| Once per customer in the group; persistent authoritative record | **PASS** | `trial_redemptions` (immutable, PK user+group) + unique index "one TRIAL period per user" (integration `[NEG][TRIAL-02]`) |
| Trial credits expire when the confirmed paid period begins; first paid period grants 3,000 | **PASS** | `lifecycle-time.spec` `[BR][SUB-01]`: at the trial end the remainder expires; the verified `RENEWED` grants 3,000; the local clock alone grants nothing |
| No repeated trial via cancel/revoke, resubscribe, account or transaction replay | **PASS** | API: cancel+revoke → paid Basic; previous paid subscriber → `PREVIOUS_SUBSCRIBER`; 8 concurrent trial purchases → 1; another account replaying a transaction → 409 |
| Declined/cancelled trial purchase does not consume eligibility | **PASS** | API `[NEG][BUY-02]` |
| Ready for StoreKit eligibility; no false claim of Apple-ID detection | **PASS** (design) | `source: BACKEND_RECORD`; D-037 (M3 = Apple eligibility AND backend record); README limitations |
| Correct eligibility and display messaging | **PASS** | API: the message is present only when eligible and `offer: null` afterwards. iOS: `M2FlowTests.testTrialMessageIsShownOnlyWhenTheServerSaysEligible` passes, and the UI journeys assert `paywall.trialMessage` for a new user and its absence on the Plan tab after the trial starts (§4) |

### C. Plan changes and renewal
| Requirement | Status | Evidence |
|---|---|---|
| SUB-03: effective upgrade expires the remainder and grants the full new allotment | **PASS** | API (−2,500 SUPERSEDED, +6,000, consumable 5,000 unchanged); upgrade during the trial; declined upgrade changes nothing |
| SUB-04: downgrade requested → no immediate credit change | **PASS** | API: the ledger is byte-identical before and after; `pendingPlanId` set |
| SUB-05: downgrade effective at the next renewal; no consumable loss | **PASS** | `lifecycle-time.spec` `[BR][SUB-05]`: 12,000 at 23:59:59.999, then Premium 6,000 at renewal, consumable 10,000 kept |
| SUB-02: renewal expires unused credits and grants the new allotment once | **PASS** | `lifecycle-time.spec` (full ledger sequence asserted) |
| Cancelling auto-renew keeps the paid entitlement | **PASS** | API + `lifecycle-time.spec` (credits spendable 1 ms before the end; expiry rejected before the end) |
| Expired entitlement, delayed, duplicate, out-of-order and concurrent events | **PASS** | `lifecycle-time.spec`: week 3 before week 2 (SUPERSEDED), stale expiry ignored, a late renewal grants nothing, redelivery ignored; stale entitlement expires credits at the exact end (402 afterwards); concurrent upgrade/refund/cancel/spend → consistent ledger |
| Other buckets unaffected | **PASS** | `credit_ledger_entry_shape`: expirations are SUBSCRIPTION-only (integration); API assertions on CONSUMABLE/REWARD |

### D. Refunds and revocation
| Requirement | Status | Evidence |
|---|---|---|
| SUB-06: refund/revocation invalidates the remaining subscription credits | **PASS** | API: Premium 6,000 − 800 spent → −5,200 REVOKED; consumable 7,000 kept |
| Immutable history; never negative; no retroactive removal of consumed credits | **PASS** | full ledger sequence asserted; immutability triggers (integration); non-negative CHECK |
| Repeated refunds idempotent; ordering cannot restore a revoked entitlement | **PASS** | API: replay 200, a second refund event is ignored; a delayed renewal after a revoke → `IGNORED_REVOKED`; the **DB trigger** rejects in-place reactivation (API + integration) |

### E. Rewarded ads
| Requirement | Status | Evidence |
|---|---|---|
| ADS-01: verified completion → +100 REWARD, quota +1 | **PASS** | API + DB (slot 1, `reward_granted`) |
| ADS-02: incomplete/failed → no credit, quota unchanged, audited | **PASS** | API (`NOT_REWARDED` rows; a missing outcome counts as FAILED) |
| ADS-03: 10 per UTC day; 11th rejected; new UTC day resets | **PASS** | API (10 then 429, eligibility `DAILY_LIMIT_REACHED`); controlled clock: 23:59:59.999 rejected, 00:00:00.000 fresh; in-process clock test; DB CHECK slot ≤ 10 |
| ADS-04: duplicate and concurrent claims never exceed limits | **PASS** | API: same `adEventId` ×10 concurrently → 1 grant and 9 replays; 9/10 used + 10 parallel → exactly 1; 20 concurrent slot inserts → 1 (integration) |
| Free, trial and subscribed users with insufficient credits are eligible; no ad farm | **PASS** | API (trial user eligible; sufficient credits → 409 `AD_NOT_ELIGIBLE`, audited) |
| Server-authoritative UTC; client time ignored | **PASS** | no client time field accepted (400); a misleading `Date` header has no effect; `utc_day` CHECK |
| Audit of successful and unsuccessful attempts | **PASS** | immutable `ad_rewards` with all four statuses asserted |

### F. iOS M2 features
| Requirement | Status | Evidence |
|---|---|---|
| Subscriptions, trial eligibility, entitlement status, plans, trial offer, renewal/cancel, plan changes | **PASS** | `SubscriptionView` (Plan tab), `SubscriptionModel`, `PaywallView`/`PaywallModel` subscription tab. `M2FlowTests` (14) pass. The UI journey `testRewardedAdThenTrialFromPaywallThenCancelAutoRenew` passes against the real backend: Basic trial from the paywall, the Plan tab shows `Basic · Free trial`, and Cancel Auto-Renew keeps the entitlement (§4). Renewal, expiry and plan changes in the UI are covered by unit tests with fakes; their server behaviour is covered by the API tests |
| Ad action enabled when eligible, quota shown | **PASS** (unit + UI) | `PaywallView.adSection`, `PaywallModel.canWatchAd` (server eligibility) |
| Paywall behavior preserved (tabs; return when sufficient; never auto-run) | **PASS** | the M1 UI journey (purchase → return → explicit confirm) and the M2 journey (ad and trial each close the paywall; `operation.result` is absent until an explicit confirm) pass on the simulator against the real backend |
| Labelled test controls (not real Apple/ad network) | **Implemented** | "Mock billing outcome (test only)", "Mock ad … (test only)", "Mock provider test controls … not App Store events" |
| Loading, errors, repeated navigation, stale entitlement, interrupted flows, retries | **PASS** (unit) | the paywall reloads on each presentation; idempotent-id reuse on transport errors; selection frozen in flight; stale entitlement from the server (`entitled`) |

### G. Analytics and churn
| Requirement | Status | Evidence |
|---|---|---|
| PRD §4 events captured | **PASS** | each event's emission asserted in API/integration tests (trial_started, trial_expired, subscription_started (incl. conversion), _renewed, _cancelled, _expired, _refunded, _upgraded, _downgraded, reward_granted) |
| Idempotent for provider retries | **PASS** | UNIQUE (name, dedupe_key); concurrent duplicate deliveries → 1 event (API); integration |
| Separate from ledger accounting | **PASS** (design) | no FK or read path from money logic; D-034 |
| Deterministic conversion/churn queries | **PASS** | integration `[BR][PRD §4]`: a controlled 4-user history → conversion 1/2, churn 1/2, cancel ≠ churn, exact event counts |
| No invented KPIs; open definitions documented | **PASS** | the churn result is labelled "working definition … not approved"; there's no paywall-conversion event because the PRD defines none (D-034/D-035) |

### H. Automated QA coverage
| Requirement | Status | Evidence |
|---|---|---|
| Unit tests for all lifecycle transitions and eligibility | **PASS** | 35 lifecycle + 6 clock |
| PostgreSQL integration tests (integrity, idempotency, uniqueness, UTC caps) | **PASS** | 19 in `m2-integrity.test.ts` |
| Playwright API tests (happy, failure, trial, changes, renewals, refunds, concurrency, isolation, ads, analytics, paywall) | **PASS** | 43 new specs; cross-user isolation for notifications, ad ids and history |
| Independent DB assertions and mutation/negative checks | **PASS** | the ledger/balance oracle in every money test; §3 |
| Exact UTC and weekly boundaries with controlled time, no HTTP backdoor | **PASS** | `lifecycle-time.spec` + route-table test (no `clock`/`time` routes) |
| Full M1 regression still green | **PASS** | 63/73/102 M1 tests inside the totals |
| CI job extended, check name kept, JUnit + HTML preserved | **PASS locally / NOT VERIFIED on GitHub** | row 6; needs a push and a PR run |
| Swift unit and simulator UI tests for subscription/ad flows | **PASS** | 36/36 unit + 3/3 UI; final code: runs 13–15 (§4a) |

### I. Documentation
| Requirement | Status | Evidence |
|---|---|---|
| README: subscriptions, ads, analytics, setup, reproduction | **PASS** | README (API table, time control, analytics CLI, iOS flows, limitations, feature matrix) |
| Decisions, data lifecycle, StoreKit boundary | **PASS** | D-027…D-037; migration 003 header comment |
| No secrets, signing material or build artifacts in Git | **PASS** | §5 |

## 3. Mutation checks (each applied to a copy, the target suite run, then the file restored)
| # | Deliberate defect | Result |
|---|---|---|
| 1 | Ad route without the per-user lock | **Caught** (after adding the "same ad event ×10 concurrently" test, which the first run showed was missing) |
| 2 | Daily ad limit 11 | Caught (4 failures) |
| 3 | Trial always eligible | Caught (2) |
| 4 | No stale-entitlement reconciliation | Caught |
| 5 | A revoked subscription can be renewed | Caught |
| 6 | Upgrade doesn't expire the remainder | Caught (3) |
| 7 | Out-of-order renewal applied | Caught |
| 8 | Expiry before the period end allowed | Caught |
| 9 | Incomplete ad rewarded | Caught (2) |
| 10 | Downgrade applied immediately | Caught (2) |
| 11 | Duplicate-transaction check removed | Caught |
| 12 | Ad eligibility (no-farm) check removed | Caught (2) |
| 13 | Lifecycle without the per-user lock | Caught (3) |
| 14 | Operations without the new per-user lock | **Not caught: equivalent mutant.** Spends are still serialized by the bucket-row locks, and the lifecycle path locks user → buckets. Kept as defense in depth (D-031) |

Two **real defects** were found and fixed during the run:
1. A renewal transaction redelivered under a new notification id was checked against the period rules before the duplicate check. The duplicate check now runs first.
2. Unauthenticated requests with an invalid body got 400 instead of 401. Auth now runs in `onRequest` (D-036).

## 4. iOS simulator tests: blocker resolved, suite passes (2026-11-18)

**Outcome:** the iOS suite runs and passes against the real disposable backend (`npm run e2e:server`): **36 / 36 unit + 3 / 3 UI tests**.
- **iPhone 17, iOS 27.2:** 3 consecutive full passes (runs 8, 9 and 10).
- **iPhone 16, iOS 18.3:** 1 full pass (run 11).
- **Backend effects:** checked directly in the disposable database after the runs. The totals match exactly the 7 passing M2 journeys (7 incomplete ads with 0 credits, 7 completed ads with +100 REWARD each, 7 trial redemptions with 1,000 SUBSCRIPTION credits each, each journey's 500 debited from SUBSCRIPTION first, auto-renew off with status TRIAL) and the 5 passing M1 journeys (5 × 5,000 approved CONSUMABLE purchases and 5 × −500 debits). The database was then dropped by the harness.

**Diagnosis, step 1: the test runner (the original blocker).**
- *Original symptom (Xcode 16.2 on macOS 27.2.1):* `Test runner never began executing tests after launching`, with a `DTServiceHubClient … Handshake process failed` error. The merged M1 code on `main` failed the same way.
- *Cause:* Xcode 16.2 is not compatible with macOS 27.2.1's developer services.
- *Resolution (environment only, no project change):* Xcode 27.2 (build 27B52) is now installed at `/Applications/Xcode.app`, dated 2026-11-18 17:44 local time, after the earlier diagnosis. It brings the iOS 27.2 simulator runtimes, and `xcode-select -p` points at it.
- *Checks:*
  - `xcodebuild -checkFirstLaunchStatus` returns exit 0.
  - Runtimes present: iOS 18.1, 18.3 and 27.2.
  - Nothing was reinstalled or deleted, and no simulator data was erased.
  - With Xcode 27.2 the runner attaches and all 36 unit tests passed on the first run.

**Diagnosis, step 2: UI-test failures on iOS 27 (runs 1–7).** Each one was diagnosed from the result bundle (failure hierarchies, activity logs and frames from the screen recordings). Each was fixed in **test code only** (`PrimaryJourneyUITests.swift` helpers); no app code or assertion changed.

| # | Observed on iOS 27.2 | Evidence | Fix (test helper) |
|---|---|---|---|
| 1 | `Failed to tap "Confirm" Button: Multiple matching elements` | `confirmationDialog` is now a popover. Its accessibility tree has the Confirm button twice, with the same `operation.confirm` identifier and frame | `confirmSpend()` queries `operation.confirm` and taps `firstMatch` |
| 2 | A tab tap was silently dropped | Log: `Computed hit point {-1, -1}`. `isHittable` stays false and the tab bar's frame is reported as `{inf, inf}`, while nothing covers it in the app hierarchy | `selectTab()` taps the centre of the button's reported frame. It repeats the tap only while the tab is still not selected (at most 3 times; selecting a tab is idempotent), then **asserts `isSelected`** |
| 3 | `paywall.adQuota` missing | The ad section starts below the fold (`paywall.watchAd` at y=841 on an 874-pt screen). The lazy `List` doesn't load lower cells | `reveal()` scrolls the paywall in small steps until the element lies fully inside the visible band, and fails otherwise. It drags along the right margin so it never moves a segmented control. Visibility is judged from the frame because `isHittable` is unreliable for segments (run 7) |
| 4 | Taps lost about 18–50 s after sign-up | Screen recordings show iOS's **"Save Password?"** sheet (Passwords app) over the app. Its delay is variable: within 30 s in run 5, later than 30 s in run 6. A UI interruption monitor was tried in run 7 and never fired, because the prompt appeared during scroll drags, which aren't checked for interruptions | `answerSavePasswordPromptAfterSignUp()` waits up to 90 s for the prompt after Create Account and answers **Not Now**. `dismissSavePasswordPromptIfShown()` is also called inside every helper as a backstop. The monitor was removed. On iOS 18.3 the prompt never appears, so the wait simply times out |

- **What was not changed:**
  - application business logic
  - the app's `textContentType` (username/password AutoFill is real product behaviour)
  - test assertions: none removed or weakened. The only differences from `HEAD` are the M2 contract changes made earlier (the ad is enabled, new plan identifiers) and raw taps or queries routed through these helpers
- **Cost:** the UI suite takes about 6 min on iOS 27.2 (the prompt wait is up to 90 s per journey).

**Commands (actually executed):**
1. `cd backend && npm run e2e:server`. This printed `E2E_API_BASE_URL=http://127.0.0.1:60126` with a disposable `monetalab_api_test_*` database, which was dropped on stop.
2. `TEST_RUNNER_MONETALAB_API_BASE_URL=http://127.0.0.1:60126 xcodebuild -project ios/MonetaLab.xcodeproj -scheme MonetaLab -destination 'platform=iOS Simulator,id=<iPhone 17 iOS 27.2 udid>' -resultBundlePath <scratch>.xcresult test`. Runs 8–10: exit 0, `** TEST SUCCEEDED **`.
3. The same command with the iPhone 16 / iOS 18.3 device. Run 11: exit 0.
4. `xcodebuild … clean build-for-testing` and the Release `generic/platform=iOS Simulator` build on Xcode 27.2. Both succeeded with exit 0 and 4 warnings (row 8).

## 4a. Final iOS changes and reruns (2026-11-19)

**Warning fix (app code, no behavior change).** Xcode 27.2 reported, at `WalletView.swift:44:89`, `WalletView.swift:45:72`, `OperationView.swift:64:129` and `OperationView.swift:65:72`:

> `warning: 'weak' ownership of capture 'app' differs from implicitly-captured strong reference in outer scope [#ImplicitStrongCapture]`

- *Origin:* the paywall `.sheet { … }` content closure reads `app` through the view, so it already holds `app` strongly; the inner `token`/`onUnauthenticated` closures then capture it `[weak app]`.
- *Fix:* the sheet closures now name that capture explicitly: `.sheet(isPresented: $showStore) { [app] in` and `.sheet(item: $operation.paywall) { [app] context in`. The ownership is exactly what it was before (the outer closure was already strong; the inner closures stay weak). No logic changed.
- *Result:* clean `build-for-testing` and the Release simulator build both succeed with **0 Swift warnings** (the only remaining lines are Xcode's `appintentsmetadataprocessor` notes about the AppIntents framework, which aren't from project code).

**Rerun of the full suite on the final code** (fresh `npm run e2e:server` backend; its database was dropped on stop):

| Run | Device | Result | Passed | Failed | Skipped |
|---|---|---|---|---|---|
| 12 | iPhone 17, iOS 27.2 | **FAILED** | 38 | 1 | 0 |
| 13 | iPhone 17, iOS 27.2 | PASS | 39 | 0 | 0 |
| 14 | iPhone 17, iOS 27.2 | PASS | 39 | 0 | 0 |
| 15 | iPhone 16, iOS 18.3.1 | PASS | 39 | 0 | 0 |

- *Run 12 failure:* `testRegisterBuyThroughPaywallReturnWithoutAutoRunThenConfirmAndSignOut`, `XCTAssertEqual failed … Save Password prompt still shown`. The prompt appeared about 13 s after Create Account and the test tapped **Not Now** within 1 s. Video frames show the prompt still fading in just before the tap and unchanged 10 s later: iOS ignored a tap made during the appear animation. It isn't related to the warning fix.
- *Fix (test helper only):* `dismissSavePasswordPromptIfShown()` re-taps **Not Now** only while the prompt still exists (at most 3 attempts, 5 s each) and still **asserts that the prompt is gone**. No assertion was removed.
- **Remaining risk:** the system prompt's timing varies; this is the second iOS 26+ workaround for it (§6).

## 4b. Evidence locations

Result bundles and logs are **not committed** (`*.xcresult`, `*.log` and `local-evidence/` are git-ignored). They are kept on the owner's machine:
- `local-evidence/m2-ios-xcode27-2026-11-18/`: runs 1–11 (`xcresult/`), their `xcodebuild` logs, the Xcode 27.2 build logs before the fix, and extracted attachments/frames used for the §4 diagnosis. `MANIFEST.md` lists each bundle's summary as read by `xcrun xcresulttool get test-results summary`.
- `local-evidence/m2-ios-xcode27-2026-11-19/`: runs 12–15, the post-fix build logs, the backend rerun log (row 12), the run 12 activity log and video frames. Also with a `MANIFEST.md`.

## 5. Security and hygiene
- No HTTP route can change time, seed or grant credits, or read cross-user analytics. A route-table test (integration) checks this.
- Mock billing, the mock ad provider and the test clock file all refuse `NODE_ENV=production` (unit/integration tests and the dev smoke test).
- `/subscriptions/mock-notifications` acts only on the caller's own transactions. Another user's transaction → 409 `UNKNOWN_TRANSACTION` with no data leaked (API).
- No secrets, signing files, personal emails or local paths in the changed files. Generated output (`test-results/`, `*.xcresult`, DerivedData) is git-ignored. The scan is in the final report.

## 6. Known risks and limitations
- **iOS UI tests depend on iOS 26+ simulator workarounds** (§4): coordinate taps on the tab bar, `firstMatch` on the duplicated Confirm button, scrolling the lazy paywall list, and answering the system "Save Password?" prompt, re-tapping Not Now when a tap lands during its appear animation (§4a). A future Xcode/iOS update could change these behaviours again. The suite isn't in CI, so it's only as fresh as its last local run (2026-11-19, Xcode 27.2, runs 13–15). One of the four post-fix runs failed (run 12) before that helper fix.
- **Xcode 27.2 compiler warnings:** resolved (§4a). A future Swift version could add new diagnostics; the build is warning-free on Xcode 27.2 as of 2026-11-19.
- **Local evidence is not in Git.** The result bundles and logs live only in the git-ignored `local-evidence/` folder on the owner's machine (§4b). If that folder is lost, the evidence is gone; rerunning the commands in §4 regenerates it.
- **The GitHub Actions run of the M2 workflow is NOT VERIFIED** until the PR run is observed. The M1 artifact contents (JUnit counts) also remain NOT VERIFIED (`docs/m1-verification.md` §6).
- **The mock notification route is user-triggered.** In mock mode a user can simulate their own renewals and refunds. Mock-only, refused in production, replaced by signed App Store Server Notifications in M3.
- **`ads.spec` uses the real server clock.** A run crossing UTC midnight could change the day mid-test. The exact boundary is covered deterministically in `lifecycle-time.spec` and the in-process test.
- **Open product decisions with conservative defaults, pending approval (D-037).** `docs/decisions.md` now separates, for D-034, D-035 and D-037, the approved PRD requirement from the provisional mock-only assumption and the open product question. None of them is approved by the acceptance of the test evidence:
  - #2 consumable refunds
  - #6 grace period
  - #7 buying while subscribed (rejected) and cross-account restore (not implemented)
  - #9 trial identity
  - #10 the churn definition
- The `subscription_downgraded` emission timing and the `trial_expired` meaning are interpretations (D-034).
- The M1 accepted gaps (D-S3-09) still apply, local fixture only.
