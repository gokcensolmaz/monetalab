# MonetaLab

A small, reproducible **QA portfolio fixture** for mobile monetization: a SwiftUI iOS app and a Node.js/TypeScript REST API on PostgreSQL. It demonstrates credit-wallet business rules through independently verifiable API, database, iOS and CI tests.

> **Mock providers only.** Consumable purchases, weekly subscriptions (with the Basic free trial) and rewarded ads all use deterministic, test-controlled *mock* providers. There are **no real payments, no StoreKit/App Store integration, no TestFlight, no ad network, no external analytics SDK and no AI processing**. Prices are deliberately not shown. Real Apple integration is milestone M3 (`product-requirements.md`).

**Status:** M1 is merged (PR #2). M2 is implemented locally on `m2-subscriptions-rewards` and awaits the owner's QA review.
- Evidence: [`docs/m1-verification.md`](docs/m1-verification.md) and [`docs/m2-verification.md`](docs/m2-verification.md).
- Decisions: [`docs/decisions.md`](docs/decisions.md).

## Architecture

```
ios/ (SwiftUI, iOS 17+)  ──HTTP/JSON──►  backend/ (Node 24, TypeScript, Fastify)  ──►  PostgreSQL 16
  register/login/logout                    auth (scrypt, SHA-256 session tokens)        users, sessions
  wallet + history                         wallet / history / catalog                   bucket_balances (CHECK ≥ 0)
  operations + paywall                     purchases (mock BillingProvider)             credit_ledger (append-only)
  mock purchases                           operations (allocator, row locks)            purchases, operations (immutable)
  plan tab + trial                         subscriptions (mock provider, lifecycle)     subscriptions (state), periods,
  rewarded ads                             ads (mock provider, UTC daily cap)           events, trial_redemptions, revocations,
                                           analytics events + reports                   ad_rewards, analytics_events (immutable)
```

- **The backend is the system of record.** The app never computes or grants credits. Costs and pack sizes are decided by the server.
- **Four credit buckets** are spent in the fixed order **SUBSCRIPTION → CONSUMABLE → REWARD → PROMOTIONAL**. One operation may span buckets. Insufficient total credit rejects the whole operation (`402 INSUFFICIENT_CREDITS`) without debiting anything.
- **Integrity is enforced in the database** (migration `002`):
  - every ledger insert updates its balance in the same statement (balance = SUM(ledger)), and the non-negative CHECK rejects overdrafts
  - grants are allowed only for `APPROVED` purchases, at exactly the package amount
  - the ledger, purchases and operations can't be updated or deleted
- **Idempotency:** purchase `transactionId`, operation `requestId`, subscription `transactionId`/`requestId`, notification `eventId` and ad `adEventId`. An identical replay returns 200 with the original result; a conflicting replay returns 409.
- **Subscriptions (M2):**
  - The lifecycle rules are a pure, unit-tested module; each verified provider transaction becomes one immutable period.
  - Subscription credits never roll over. A renewal, upgrade, expiry or refund expires the remainder and records it in the ledger; nothing is ever deleted.
  - CONSUMABLE, REWARD and PROMOTIONAL credits are never touched by subscription events.
- **Business time:** the server clock decides periods and the rewarded-ad UTC day, never the device.

### API (M1)
| Method & path | Auth | Purpose |
|---|---|---|
| `POST /auth/register` | – | Create an account (email normalized, password 8–128 characters). 201, or 409 on a duplicate. |
| `POST /auth/login` | – | 200 `{ token, expiresAt, user }`. The session lasts 7 days (absolute). A wrong password and an unknown email give the identical 401. |
| `GET /me` | Bearer | Current user |
| `POST /auth/logout` | Bearer | Revoke the current session (204). A repeat logout returns 401. |
| `GET /catalog` | – | Credit packs, subscription previews (unavailable), ad preview (unavailable), operation costs |
| `GET /wallet` | Bearer | Four balances + total |
| `GET /history?limit=&before=` | Bearer | Itemized ledger, newest first |
| `GET /purchases` | Bearer | All purchase attempts, including declined/cancelled |
| `POST /purchases` | Bearer | `{ packageId, transactionId, mockOutcome: APPROVED\|DECLINED\|CANCELLED }` |
| `POST /operations` | Bearer | `{ action: BASIC\|STANDARD\|ADVANCED, requestId }`, costing 100 / 500 / 800 credits |
| `GET /subscriptions/current` | Bearer | Subscription status, entitlement, renewal/expiry date, trial eligibility. The trial message appears only when eligible. |
| `GET /subscriptions/history` | Bearer | Verified periods (granted/expired credits, revocations) and every lifecycle event |
| `POST /subscriptions/purchase` | Bearer | `{ planId: BASIC_WEEKLY\|PREMIUM_WEEKLY\|ULTRA_WEEKLY, transactionId, mockOutcome }`. Basic starts the 3-day / 1,000-credit trial if eligible. |
| `POST /subscriptions/change-plan` | Bearer | Upgrade now (new full allotment) or schedule a downgrade for the next renewal |
| `POST /subscriptions/cancel` / `resume` | Bearer | `{ requestId }`: turn auto-renew off or on. The entitlement lasts until the period end. |
| `POST /subscriptions/restore` | Bearer | Re-sync the authoritative state for this account |
| `POST /subscriptions/mock-notifications` | Bearer | **Mock provider** notifications: `{ eventId, type: RENEWED\|EXPIRED\|REFUNDED\|REVOKED, transactionId, periodStart? }` |
| `GET /ads/quota?action=` | Bearer | Today's UTC quota (10/day) and whether the ad is offered for that blocked action |
| `POST /ads/rewards` | Bearer | `{ adEventId, action, mockOutcome: COMPLETED\|INCOMPLETE\|FAILED }`. A verified completion grants +100 REWARD credits. |

Errors always have the shape `{ "error": { "code", "message" } }`.

M2 error codes:
- `ALREADY_SUBSCRIBED`, `NO_ACTIVE_SUBSCRIPTION`, `SAME_PLAN`, `AUTO_RENEW_DISABLED`
- `RENEWAL_NOT_DUE`, `PERIOD_NOT_ENDED`, `UNKNOWN_TRANSACTION`
- `TRANSACTION_CONFLICT`, `EVENT_CONFLICT`, `REQUEST_ID_CONFLICT`
- `DAILY_AD_LIMIT_REACHED` (429), `AD_NOT_ELIGIBLE` (409), `AD_EVENT_CONFLICT`

## Prerequisites
- Node.js **24.20.0** (`.nvmrc`)
- Docker Desktop (or another Docker engine with Compose)
- For iOS: an Xcode that supports your macOS. Verified on 2026-11-18 with Xcode 27.2 on macOS 27.2.1 (iPhone 17 / iOS 27.2 and iPhone 16 / iOS 18.3). Xcode 16.2's test runner fails on macOS 27.2.1, see `docs/m2-verification.md` §4.

## Run the backend locally
```bash
cd backend
npm ci
npm run db:up        # PostgreSQL 16.16 on 127.0.0.1:55432 (local-only credentials, not secrets)
npm run db:migrate   # applies migrations/001, 002 and 003 (additive; existing data is kept)
npm start            # API on http://127.0.0.1:3000
```
`npm run db:down` stops the database. The data volume is kept.

Optional demo credits for the non-consumable buckets (local only, refuses production and non-local DBs; there's no HTTP route for this):
```bash
npm run db:seed:demo -- --email you@example.test --subscription 200 --reward 400 --promotional 1000
```

## Run the tests
| Command (in `backend/`) | What it runs |
|---|---|
| `npm run typecheck` | Strict TypeScript |
| `npm run test:unit` | `node:test` unit tests: allocator, password hashing, tokens |
| `npm run test:integration` | `node:test` + PostgreSQL: schema constraints, migrations, money integrity (DV-001..003), API test harness |
| `npm run test:api` | Playwright HTTP API tests against the real server on a **disposable database** and an OS-assigned port (no browsers needed). A second server with a **controlled business clock** runs the time-dependent M2 spec (`lifecycle-time.spec.ts`). |
| `npm run test:*:ci` | The same tests plus JUnit XML (`test-results/`) and the Playwright HTML report |

Test isolation:
- Integration and API tests create throwaway databases (`monetalab_test_*`, `monetalab_api_test_*`) and drop them afterwards.
- The dev database and Docker volume are never modified by tests.
- Every test uses its own unique users.

Test names carry a category (`[BR]` business rule, `[INT]` integration, `[NEG]` negative/edge) and the PRD acceptance ID.

### Reproducing M2 time-dependent behavior
There is no HTTP endpoint for time.
- **Automated tests:** the harness gives the second server a temp file through `MONETALAB_TEST_CLOCK_FILE` and rewrites it.
- **Manual QA:**
  1. Run `E2E_TEST_CLOCK=1 npm run e2e:server`. It prints `E2E_CLOCK_FILE=<path>`.
  2. Write an ISO instant into that file, for example `echo 2031-01-08T00:00:00.000Z > <path>`, to move the server's business time. Then a renewal or expiry becomes due.
- **Safeguard:** the server refuses a clock file when `NODE_ENV=production`.

### Analytics report (local only)
```bash
npm run analytics:report -- --from 2026-11-01T00:00:00Z --to 2026-11-08T00:00:00Z
```
- Prints trial-to-paid conversion, paid churn and event counts.
- The churn formula is the PRD's **working definition** (open decision #10) and is not an approved KPI.
- The command refuses `NODE_ENV=production` and non-local databases.

## iOS app
```bash
open ios/MonetaLab.xcodeproj   # scheme MonetaLab
```
- Start the backend with `npm start` first. The simulator reaches it at `http://127.0.0.1:3000`. ATS allows local networking only.
- Override the URL with the launch environment variable `MONETALAB_API_BASE_URL`.

**Flows:**
- register, sign in and sign out; the session persists in the Keychain
- wallet (four balances + total)
- credit and purchase history
- "Get Credits" mock purchases
- **Process** tab:
  1. choose Basic, Standard or Advanced, then **Run**, then **Confirm**
  2. on insufficient credits, the paywall opens with **Subscription | Credits** tabs
     - **Subscription:** the weekly plans. The trial message appears only when the server says you're eligible. Active subscribers can upgrade here.
     - **Credits:** packs.
     - **Below both:** *Watch an Ad — Earn 100 Credits*, with today's UTC quota. It's enabled only when the server says you're eligible.
  3. when a purchase or ad makes the balance sufficient, the paywall closes and you're back on the operation screen
  4. the operation is **never run automatically**: you confirm it again
- **Plan** tab:
  - status, renewal or end date, auto-renew, and a scheduled downgrade
  - subscribe, upgrade or downgrade; cancel or resume auto-renew; restore
  - **Mock provider test controls** (simulate renewal, expiry or refund). These are labelled test-only and are not App Store events.
- **Test-only mock outcome pickers:** purchases (Approved / Declined / Cancelled) and ads (Completed / Closed early / Failed to load).

### iOS tests
```bash
# Unit tests (view models, API mapping; no backend needed)
xcodebuild -project ios/MonetaLab.xcodeproj -scheme MonetaLab \
  -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:MonetaLabTests test

# UI journey against a REAL backend on a disposable database:
cd backend && npm run e2e:server      # prints E2E_API_BASE_URL=http://127.0.0.1:<port>; Ctrl-C cleans up
TEST_RUNNER_MONETALAB_API_BASE_URL=<that URL> xcodebuild -project ios/MonetaLab.xcodeproj -scheme MonetaLab \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
# On Xcode 27.2, 'name=iPhone 17' runs the same suite on iOS 27.2.
```
On iOS 26+ each UI journey waits for iOS's own "Save Password?" prompt after Create Account and answers "Not Now". This takes up to 90 s per journey; `docs/m2-verification.md` §4 explains why.

## CI
`.github/workflows/api-regression.yml` runs on every PR to `main` (required check **`api-db-regression`**):
1. `npm ci`, typecheck, migrations on a fresh `postgres:16.16-alpine` service
2. unit, integration and Playwright API tests
3. a job summary
4. an artifact with JUnit XML, the Playwright HTML report and logs

It uses read-only permissions, SHA-pinned official actions, no secrets and no deployment.
- In M2 the same job also runs the subscription, ad and controlled-clock specs, plus an analytics-report smoke step whose output goes into the artifact.
- iOS isn't built in CI (see `docs/m2-verification.md`).

## Known limitations (local QA fixture only)
These are accepted for this local M1 fixture only (D-S3-09, D-021). They are **not acceptable for any public or production deployment**:
- no login rate limiting or account lockout
- `POST /auth/register` returns 409 for an existing email, which reveals that it exists
- plain HTTP, on localhost only
- expired and revoked sessions aren't cleaned up
- the database has no CHECK enforcing email normalization: the app normalizes emails and a case-insensitive unique index prevents duplicates (intentionally deferred, D-021)
- billing, subscriptions and ads are mock-only. The mock providers and the test clock file refuse to start with `NODE_ENV=production`.
- the mock provider notification route (`/subscriptions/mock-notifications`) lets an authenticated user simulate their **own** renewals, expiries and refunds. That is acceptable only for this mock fixture: M3 replaces it with signed App Store Server Notifications.
- trial eligibility is the backend's own record, and it can't detect the same Apple ID across different app accounts (PRD §7 #9)

## M1 feature matrix
| PRD M1 requirement | Status |
|---|---|
| Create account, sign in/out, identify current user (AUTH-01) | Implemented + tested |
| Wallet with four buckets and itemized history | Implemented + tested |
| Mock consumable purchases: approved / declined / cancelled / duplicate (BUY-01..03) | Implemented + tested |
| Spend credits on 100/500/800 actions, ordered and atomic, blocking insufficient credit (CR-01..03) | Implemented + tested |
| Insufficient credit opens the paywall (Subscription \| Credits), return without auto-run (PW-01/02) | Implemented + tested (iOS) |
| API + DB tests and GitHub Actions PR regression (CI-01) | Implemented. The extended workflow still needs a GitHub run. |
| Basic iOS app exercising the core paths | Implemented + UI-tested on the simulator |
| **M2** Mock subscriptions: activation, renewal, cancellation, expiration, upgrade/downgrade, restore, refund (SUB-01..06) | Implemented + API/DB/unit tested |
| **M2** Basic 3-day / 1,000-credit trial, once per customer (TRIAL-01/02) | Implemented + tested (DB-enforced) |
| **M2** Rewarded ads: +100 REWARD, 10 per UTC day, duplicates and concurrency (ADS-01..04) | Implemented + tested (DB-enforced cap) |
| **M2** Lifecycle analytics events and conversion/churn reports (PRD §4) | Implemented + tested. The churn definition isn't approved. |
| **M2** iOS subscription, trial and ad flows | Implemented and tested: 36 unit + 3 UI tests pass on the simulator against the real backend (`docs/m2-verification.md` §4) |

Full evidence, counts and every PASS / FAIL / NOT VERIFIED item: [`docs/m1-verification.md`](docs/m1-verification.md).

## Repository layout
```
backend/   src/ (auth, credits, billing, subscriptions, ads, analytics, db, http), migrations/, tests/{unit,integration,api}
ios/       MonetaLab.xcodeproj, MonetaLab/ (app), MonetaLabTests/, MonetaLabUITests/, Config/Info.plist
docs/      plans, decision log, per-slice verification reports, m1-verification.md
```
