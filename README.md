# MonetaLab

A small, reproducible **QA portfolio fixture** for mobile monetization: a SwiftUI iOS app and a Node.js/TypeScript REST API on PostgreSQL. It demonstrates credit-wallet business rules through independently verifiable API, database, iOS and CI tests.

> **Mock billing only.** M1 uses a deterministic, test-controlled *mock* billing provider. There are **no real payments, no StoreKit/App Store integration, no TestFlight, no ads and no AI processing**. Subscriptions, trials and rewarded ads appear only as unavailable previews. Prices are deliberately not shown. Real Apple integration is milestone M3 (`product-requirements.md`).

**Status:** M1 implementation complete locally. Evidence and the requirement-by-requirement checklist: [`docs/m1-verification.md`](docs/m1-verification.md). Decisions: [`docs/decisions.md`](docs/decisions.md).

## Architecture

```
ios/ (SwiftUI, iOS 17+)  ──HTTP/JSON──►  backend/ (Node 24, TypeScript, Fastify)  ──►  PostgreSQL 16
  register/login/logout                    auth (scrypt, SHA-256 session tokens)        users, sessions
  wallet + history                         wallet / history / catalog                   bucket_balances (CHECK ≥ 0)
  operations + paywall                     purchases (mock BillingProvider)             credit_ledger (append-only)
  mock purchases                           operations (allocator, row locks)            purchases, operations (immutable)
```

- **The backend is the system of record.** The app never computes or grants credits. Costs and pack sizes are decided by the server.
- **Four credit buckets** are spent in the fixed order **SUBSCRIPTION → CONSUMABLE → REWARD → PROMOTIONAL**. One operation may span buckets. Insufficient total credit rejects the whole operation (`402 INSUFFICIENT_CREDITS`) without debiting anything.
- **Integrity is enforced in the database** (migration `002`):
  - every ledger insert updates its balance in the same statement (balance = SUM(ledger)), and the non-negative CHECK rejects overdrafts
  - grants are allowed only for `APPROVED` purchases, at exactly the package amount
  - the ledger, purchases and operations can't be updated or deleted
- **Idempotency:** purchase `transactionId` and operation `requestId`. An identical replay returns 200 with the original result; a conflicting replay returns 409.

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

Errors always have the shape `{ "error": { "code", "message" } }`.

## Prerequisites
- Node.js **24.20.0** (`.nvmrc`)
- Docker Desktop (or another Docker engine with Compose)
- For iOS: Xcode 16.2+ with an iOS 18 simulator

## Run the backend locally
```bash
cd backend
npm ci
npm run db:up        # PostgreSQL 16.16 on 127.0.0.1:55432 (local-only credentials, not secrets)
npm run db:migrate   # applies migrations/001 and 002
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
| `npm run test:api` | Playwright HTTP API tests against the real server on a **disposable database** and an OS-assigned port (no browsers needed) |
| `npm run test:*:ci` | The same tests plus JUnit XML (`test-results/`) and the Playwright HTML report |

Test isolation:
- Integration and API tests create throwaway databases (`monetalab_test_*`, `monetalab_api_test_*`) and drop them afterwards.
- The dev database and Docker volume are never modified by tests.
- Every test uses its own unique users.

Test names carry a category (`[BR]` business rule, `[INT]` integration, `[NEG]` negative/edge) and the PRD acceptance ID.

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
  2. on insufficient credits, the paywall opens with **Subscription | Credits** tabs: plans are previews, packs can be bought (mock), and *Watch an Ad — Earn 100 Credits* is shown but unavailable (M2)
  3. when a purchase makes the balance sufficient, the paywall closes and you're back on the operation screen
  4. the operation is **never run automatically**: you confirm it again

### iOS tests
```bash
# Unit tests (view models, API mapping; no backend needed)
xcodebuild -project ios/MonetaLab.xcodeproj -scheme MonetaLab \
  -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:MonetaLabTests test

# UI journey against a REAL backend on a disposable database:
cd backend && npm run e2e:server      # prints E2E_API_BASE_URL=http://127.0.0.1:<port>; Ctrl-C cleans up
TEST_RUNNER_MONETALAB_API_BASE_URL=<that URL> xcodebuild -project ios/MonetaLab.xcodeproj -scheme MonetaLab \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
```

## CI
`.github/workflows/api-regression.yml` runs on every PR to `main` (required check **`api-db-regression`**):
1. `npm ci`, typecheck, migrations on a fresh `postgres:16.16-alpine` service
2. unit, integration and Playwright API tests
3. a job summary
4. an artifact with JUnit XML, the Playwright HTML report and logs

It uses read-only permissions, SHA-pinned official actions, no secrets and no deployment. iOS isn't built in CI in M1 (see `docs/m1-verification.md`).

## Known limitations (local QA fixture only)
These are accepted for this local M1 fixture only (D-S3-09, D-021). They are **not acceptable for any public or production deployment**:
- no login rate limiting or account lockout
- `POST /auth/register` returns 409 for an existing email, which reveals that it exists
- plain HTTP, on localhost only
- expired and revoked sessions aren't cleaned up
- the database has no CHECK enforcing email normalization: the app normalizes emails and a case-insensitive unique index prevents duplicates (intentionally deferred, D-021)
- billing is mock-only, and the mock provider refuses to start with `NODE_ENV=production`

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

Full evidence, counts and every PASS / FAIL / NOT VERIFIED item: [`docs/m1-verification.md`](docs/m1-verification.md).

## Repository layout
```
backend/   src/ (auth, credits, billing, db, http), migrations/, tests/{unit,integration,api}
ios/       MonetaLab.xcodeproj, MonetaLab/ (app), MonetaLabTests/, MonetaLabUITests/, Config/Info.plist
docs/      plans, decision log, per-slice verification reports, m1-verification.md
```
