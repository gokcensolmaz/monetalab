# MonetaLab — Initial Implementation Plan (M1)

**Status:** Architecture approved with corrections by the product/QA owner on 2026-11-16. Slice 0 authorized; later slices still need individual approval.
**Date:** 2026-11-16
**Sources:** `CLAUDE.md`, `product-requirements.md`, `prompts/01-first-session.md`, `START-HERE.md`
**Decision log:** `docs/decisions.md` (D-001 to D-009)

## 0. Owner review outcome (2026-11-16)

The owner approved the overall M1 architecture with these decisions and corrections. They override anything below that conflicts with them.

1. **Stack approved:** Node 24, TypeScript, Fastify, PostgreSQL, `pg`, Playwright API tests, plain SQL migrations.
2. **Git:** `git init` approved. No commits or pushes without explicit approval.
3. **Paywall in M1:** the Subscription tab stays visible, with Basic, Premium and Ultra shown as unavailable preview plans. The Credits tab supports mock consumable purchases. UI space is reserved for Watch Ad, but real rewarded ads are M2.
4. **StoreKit correction:** do not assume StoreKit will implement the backend mock `BillingProvider` interface. Future iOS StoreKit purchases need server-side transaction verification and idempotent fulfillment. That infrastructure is not built in M1.
5. **Test organization:** tests are organized and documented by **business rules**, **integration**, and **negative/edge cases**.
6. **Duplicate purchase replay:** an identical payload returns the original result with HTTP `200`. A conflicting payload returns `409`.
7. **Insufficient credits:** HTTP `402` with code `INSUFFICIENT_CREDITS`.
8. **Operation billing in M1:** the simulated operation succeeds immediately and credits are deducted atomically. No reversal workflow yet. This resolves PRD open decision #3 for M1 only.
9. **Bucket priority preserved:** SUBSCRIPTION > CONSUMABLE > REWARD > PROMOTIONAL.

## Local environment check (2026-11-16)

| Tool | Status |
|---|---|
| Node / npm | ✅ v24.20.0 / 11.19.0 |
| Xcode | ✅ 16.2 |
| git | ✅ 2.39.5, but **this directory is not a git repo yet** |
| Docker | ❌ not found |
| psql | ❌ not found |
| GitHub CLI (`gh`) | ❌ not found |

---

## 1. M1 objective and what's out of scope

**M1 goal:** another engineer can clone the repo, start the API and database with documented commands, run the automated tests, and use a basic iOS app to go from login to a mock purchase, spending credits and the paywall. Every pull request runs a repeatable API/DB regression in GitHub Actions.

**In M1:**
- Sign up, sign in, sign out, and "who am I".
- A wallet with four credit buckets, plus itemized history.
- Mock consumable purchases with approved, declined, cancelled and duplicate outcomes.
- Spending credits on the three predefined actions, always in the order SUBSCRIPTION → CONSUMABLE → REWARD → PROMOTIONAL. A spend either fully succeeds or changes nothing.
- An insufficient-credit error that opens the paywall.
- API and database tests, and a PR workflow.

**Not in M1:**
- M2: subscriptions, trials, renewals, upgrades/downgrades and refunds; rewarded ads and quotas; lifecycle and analytics events.
- M3: StoreKit 2, App Store Connect, Sandbox, TestFlight, server-side Apple verification.
- M4: skills, subagents, hooks, MCP.
- Never in M1: real payments, Android, AI processing, real deployed infrastructure, real prices.

Acceptance IDs in M1: AUTH-01, BUY-01–03, CR-01–03, CI-01, and the M1 parts of PW-01/PW-02. TRIAL-, SUB- and ADS- are M2.

---

## 2. Architecture

```
monetalab/
├── backend/                  Node 24 + TypeScript REST API
│   ├── src/
│   │   ├── server.ts, app.ts       routes + error mapping
│   │   ├── auth/                   register/login/logout/me
│   │   ├── credits/                allocate.ts (pure), spend.ts, wallet.ts
│   │   ├── billing/                BillingProvider interface + MockBillingProvider
│   │   └── db/                     pool, migrate runner
│   ├── migrations/*.sql            plain SQL, applied in order
│   └── tests/
│       ├── unit/                   node:test (pure logic)
│       └── api/                    Playwright API tests + direct pg assertions
├── ios/MonetaLab/            SwiftUI app + unit tests (later slices)
├── docker-compose.yml        Postgres 16 only
├── .github/workflows/api-regression.yml
├── docs/decisions.md         decision trail (product + AI tooling)
└── README.md                 setup, test matrix, evidence, mock-vs-Apple disclaimer
```

These are the choices that matter:

- **How balances are stored:** one `bucket_balances` table with a row per (user, bucket) and a `CHECK (balance >= 0)` rule. Next to it, an append-only `credit_ledger` table. A database trigger rejects any UPDATE or DELETE on the ledger.
  - Each spend locks that user's bucket rows (`SELECT … FOR UPDATE`), then writes the debits and ledger entries in one transaction.
  - The alternative is computing balances from the ledger every time. That makes the "never negative" rule harder to enforce under concurrent requests.
  - To cover the risk of the two tables drifting apart, tests check that the ledger sum always equals the balance.
- **Preventing duplicates:** a unique `(provider, transaction_id)` on purchases and a unique `(user_id, request_id)` on spend operations.
  - Replaying the same ID returns the original result and grants nothing new.
  - Reusing an ID with a different payload returns `409`.
- **Mock billing:** a `BillingProvider` interface and a `MockBillingProvider` whose outcome is chosen by the request.
  - It only loads when `BILLING_PROVIDER=mock`.
  - The server refuses to start with the mock when `NODE_ENV=production`.
  - *Corrected (D-004):* this interface is **not** assumed to be what StoreKit implements. Real StoreKit purchases will need server-side transaction verification and idempotent fulfillment, designed in M3. M1 only keeps the mock separate from fulfillment logic.
- **Auth:** email and password, hashed with Node's built-in `crypto.scrypt`, so no extra dependency.
  - Sessions use random tokens stored hashed in a `sessions` table, which makes logout a real revocation.
  - JWTs are not used: they add a dependency and make logout weaker.
- **Dependencies:**
  - Runtime: `fastify` (built-in JSON schema validation, simple to test) and `pg`.
  - Dev: `typescript`, `@types/node`, `@playwright/test`.
  - TypeScript runs directly on Node 24, with no `tsx` or `ts-node`. That requires `erasableSyntaxOnly` in the TypeScript config, so no enums.
  - Migrations use a ~30-line runner over plain SQL files instead of a migration library.
- **Funding buckets that M1 can't fill yet:** CR-01 needs credits in all four buckets, but only consumable purchases exist in M1. Proposal: tests seed the other buckets **directly in the database** (balance row plus a ledger entry marked `SEED`), and a `db:seed:demo` script seeds data for the iOS demo. There is **no HTTP endpoint for this**, so it can't become a production backdoor.
- **CI:** the required PR check is API/DB only (Ubuntu runner, Postgres service container). iOS build and test runs as a separate, path-filtered macOS job, because macOS runners are slow and expensive.
- **Test isolation:** each test creates its own user with a unique email, and nothing is cleared globally. Tests can run in parallel, and CI always starts from a fresh database.
- **Test organization (D-005):** every test belongs to one category, shown as a prefix in its name. The test runners can filter by these prefixes.
  - `[BR]` **business rules:** expected behavior of a product rule, such as debit order or the grant amount.
  - `[INT]` **integration:** behavior across API, database and transactions, such as atomic commits, constraints, auth and isolation.
  - `[NEG]` **negative/edge cases:** rejection paths, boundaries, invalid input, duplicates and concurrency.
  - Where they apply, names also include the PRD acceptance ID, for example `[NEG][CR-02]`.

---

## 3. Slices (each one PR-sized)

| # | Slice | Acceptance criteria | How it will be verified |
|---|---|---|---|
| **0** | Repo bootstrap and pure debit allocator | `allocate(balances, cost)` returns debits per bucket in priority order, or `INSUFFICIENT` with zero debits. The PRD example (200/300/400/1000, cost 800 → 200+300+300+0) passes. | `npm run typecheck`, `npm run test:unit` |
| 1 | Postgres via Compose, migration runner, schema, `/health` | Migrations apply from scratch. The DB rejects a negative balance, a ledger UPDATE or DELETE, a duplicate purchase transaction ID, and a duplicate request ID. | `docker compose up -d db`, `npm run db:migrate`, `npm run test:api` (DB constraint tests) |
| 2 | GitHub Actions PR workflow | A PR runs typecheck plus unit, migration and API tests against a service Postgres, and uploads the Playwright report as an artifact (CI-01). | The workflow's first run on a PR |
| 3 | Auth (AUTH-01) | Register, login, `/me` and logout work. Bad password returns 401. A revoked token returns 401. Duplicate email returns 409. | `test:api` auth spec |
| 4 | Wallet and history (read only) | `GET /wallet` shows four buckets and the total. `GET /history` is per user, newest first. User B can't see user A's data. | `test:api` with a seeded user and an isolation test |
| 5 | Catalog and mock consumable purchase (BUY-01–03) | S/M/L grant 5,000/7,000/10,000 into CONSUMABLE exactly once. Declined or cancelled changes nothing. A duplicate transaction ID, including 10 sent at once, grants once. | `test:api` purchase spec, with DB checks on the ledger and balances |
| 6 | Spend operation (CR-01–03) | `POST /operations {action, requestId}`: exact debits in order, all in one transaction. Insufficient credit returns `402 INSUFFICIENT_CREDITS` with zero debits and no ledger rows. Replaying a request ID doesn't charge twice. N parallel spends never go negative and the ledger sum equals the balance. | `test:api` spend and concurrency specs |
| 7 | iOS: login, wallet, history | The app talks to the local API. Login and logout work, and the wallet and history display. | `xcodebuild test` (view-model tests with a stubbed `URLProtocol`) plus a manual run on the simulator |
| 8 | iOS: action, paywall, mock purchase | Insufficient credit opens the paywall with two tabs. The Subscription tab shows Basic/Premium/Ultra as unavailable previews with no prices. The Credits tab runs mock consumable purchases. Space for Watch Ad is reserved but has no ad behavior (D-003). A purchase re-fetches the balance and dismisses the paywall if credit is now enough. The blocked action is **never** run automatically. Cancel leaves the balance unchanged. | View-model unit tests, plus an optional XCUITest of the happy path |
| 9 | README, test matrix, evidence, demo seed | A fresh clone works using only the README. A table maps each acceptance ID to its test. | Follow the README from a clean checkout and record the results |

---

## 4. Recommended first task: Slice 0

Start with the core business rule, because it needs only Node, which is already installed:

- `.gitignore`
- `backend/package.json`: scripts `typecheck` and `test:unit`; dev dependencies `typescript` and `@types/node` only
- `backend/tsconfig.json`: strict, `noEmit`, `erasableSyntaxOnly`
- `backend/src/credits/allocate.ts`: a pure function with no database code. Buckets are a literal union type and the priority order is one exported constant.
- `backend/tests/unit/allocate.test.ts`: `node:test` cases with hand-calculated expected values:
  - the PRD example
  - an exact total balance
  - one credit short (zero debits, `INSUFFICIENT`)
  - everything coming from one bucket
  - empty buckets being skipped
  - cost validation (rejects 0, negative and non-integer costs)
  - not changing the input
- `docs/decisions.md`: records the stack choice and the "seed via DB, no backdoor endpoint" decision once approved.

Verification: `cd backend && npm install && npm run typecheck && npm run test:unit`, with the actual output reported.

This also needs `git init`. Commits happen only when the owner asks.

---

## 5. Blockers and open items

**Resolved on 2026-11-16 (see section 0 and `docs/decisions.md`):**
- Stack approved (D-001).
- `git init` approved, with no commits or pushes without approval (D-002).
- Open decision #3 for M1: the operation succeeds immediately with an atomic debit and no reversal (D-008).
- Insufficient credit returns `402 INSUFFICIENT_CREDITS` (D-007).
- Duplicate purchase: identical replay returns `200` with the original result, a conflicting payload returns `409` (D-006).
- Subscription tab: unavailable preview plans, with Watch Ad space reserved (D-003).

**Still open (each blocks only a later slice):**

| Item | Blocks |
|---|---|
| A container runtime (Docker Desktop, Colima or OrbStack) or a Homebrew Postgres install | Slice 1 |
| A GitHub repo, plus pushing with plain `git` or installing `gh` | Slice 2 |
| Creating the Xcode project: the owner creates it once in Xcode, or XcodeGen is used (one extra tool) | Slice 7 |

---

## 6. Keeping context small and avoiding scope creep

- One slice per PR. Start a fresh session or `/clear` between slices, and each one starts by reading only the relevant PRD sections and `docs/decisions.md`.
- Each slice report covers: files changed, the exact commands run and their real output, known gaps, and the next slice. Anything not run is marked NOT RUN.
- New ideas go to a backlog section in `docs/decisions.md`, not into the code.
- No agents, skills, hooks or MCP until a repeated problem shows up and the owner approves an addition.
- No M2 tables or columns. The only exception is the four-value bucket type, which M1 needs anyway.

---

**Approval state:** Slice 0, `git init` and the stack were approved on 2026-11-16. Slices 1–9 each need approval before work starts.
