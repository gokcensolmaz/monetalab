# MonetaLab — Decision Log

The product/QA owner approves every entry. Claude Code records decisions here and does not change them on its own.
Format: ID, date, decision, scope, and the reason or source.

## Approved decisions

| ID | Date | Decision | Scope / notes |
|---|---|---|---|
| D-001 | 2026-11-16 | Stack: Node 24, TypeScript (Node native type stripping; `tsc` for typecheck only), Fastify, PostgreSQL, `pg`, Playwright API tests, plain SQL migrations. | M1 backend and tests. |
| D-002 | 2026-11-16 | Run `git init`. **No commits or pushes without explicit owner approval.** | The whole project until changed. |
| D-003 | 2026-11-16 | Paywall in M1 has a **Subscription** tab, which shows Basic/Premium/Ultra as unavailable preview plans with no prices, and a **Credits** tab, which supports mock consumable purchases. UI space is reserved for Watch Ad, but rewarded ads are M2. | M1 iOS (Slice 8). Related to PRD open decision #1 (no real prices). |
| D-004 | 2026-11-16 | Do not assume StoreKit will implement the backend mock `BillingProvider` interface. Future StoreKit purchases need server-side transaction verification and idempotent fulfillment. That infrastructure is **not** built in M1. | The M1 mock stays separate from fulfillment. Design happens in M3. |
| D-005 | 2026-11-16 | Tests are organized and documented by category. Each test name starts with `[BR]` (business rules), `[INT]` (integration) or `[NEG]` (negative/edge cases), plus the PRD acceptance ID where one applies. | All test suites. |
| D-006 | 2026-11-16 | Duplicate purchase replay: an identical payload returns the original result with HTTP `200`. A conflicting payload with the same transaction ID returns `409`. | M1 purchase API (Slice 5). |
| D-007 | 2026-11-16 | Insufficient credits returns HTTP `402` with error code `INSUFFICIENT_CREDITS`, and no bucket is debited. | M1 operations API (Slice 6). |
| D-008 | 2026-11-16 | In M1 the simulated operation succeeds immediately and credits are deducted atomically. There is no reversal workflow. | Resolves PRD open decision #3 **for M1 only**. |
| D-009 | 2026-11-16 | Bucket priority is SUBSCRIPTION > CONSUMABLE > REWARD > PROMOTIONAL. Trial credits belong to SUBSCRIPTION. | Every milestone. Restates PRD §2.4. |
| D-010 | 2026-11-17 | *(was P-002)* DB integration tests use `node:test` + `pg` (`test:integration`). Playwright is used for HTTP API tests from Slice 3. | All DB integration tests. |
| D-011 | 2026-11-17 | *(was P-003)* Each integration test file creates its own throwaway database (`monetalab_test_<random>`), migrates it from scratch, and drops it with `WITH (FORCE)`. Tests never touch the dev `monetalab` DB. | Local and CI. The DB role needs `CREATEDB`. |
| D-012 | 2026-11-17 | *(was P-004)* Local Postgres on `127.0.0.1:55432` (override with `MONETALAB_DB_PORT`), with the non-secret local password `monetalab_local_only`. CI uses the same URL. | Local and CI. |
| D-013 | 2026-11-17 | GitHub repository: `https://github.com/gokcensolmaz/monetalab`, **public** (D-S2-01/02). Created by the owner, empty at setup. Remote `origin` configured. | Whole project. |
| D-014 | 2026-11-17 | Slice 2 architecture and CI plan approved (`docs/slice-2-plan.md`). This covers: two baseline commits pushed directly to `main` before protection (D-S2-03); one feature branch and PR per slice afterwards; Node pinned to `24.20.0` via `.nvmrc` and `engines >=24.2` (D-S2-06); `postgres:16.16-alpine` in both compose and CI (D-S2-07); actions pinned by full SHA on `ubuntu-24.04` (D-S2-08); JUnit XML plus job summary as the report until Playwright arrives in Slice 3 (D-S2-09); branch protection with a required PR, 0 approvals, required `api-db-regression`, an up-to-date branch and no bypass (D-S2-10); keep TypeScript 7.0.2 unless CI shows a problem (D-S2-11). | Slice 2. Commits and pushes still need explicit approval each time (D-002). |
| D-015 | 2026-11-17 | Owner additions to Slice 2: (a) CI scripts must **create the `test-results` directory** before writing JUnit XML; (b) **existing Docker volumes are preserved**, and no destructive volume removal (`down -v`, `volume rm`, `prune`) runs without explicit approval; (c) the **downloaded GitHub Actions artifact must be checked** to contain valid JUnit reports with the expected test counts. | Slice 2 verification. (b) applies to the whole project. |
| D-016 | 2026-11-17 | Slice 3 (AUTH-01) plan approved with amendments (`docs/slice-3-plan.md`). Decisions **D-S3-01 to D-S3-09** approved, detailed in the "Slice 3 decisions" table below. | Slice 3. |
| D-017 | 2026-11-17 | Owner amendments to Slice 3: (a) the API test harness must **verify it owns the spawned server** and prefer a **dynamically allocated free port** over assuming 3917 is free; (b) **direct DB mutations in API tests must be scoped to records owned by that test**, so parallel workers can't interfere; (c) extend negative and boundary coverage for **malformed tokens, oversized request bodies, logout with an expired session, and concurrent session behavior**; (d) **no product scope beyond AUTH-01**. | Slice 3 steps 3.2 to 3.8. |

## M1 implementation decisions (2026-11-17, made by Claude Code during the continuous M1 run; for owner review)

The owner authorized completing all remaining M1 slices without intermediate reviews and asked that only *material* new decisions be recorded. These are subject to the final QA review.

| ID | Decision | Why / evidence |
|---|---|---|
| D-018 | **Migration `002_m1_credit_integrity.sql` enforces money invariants in the database:** (a) `credit_packages` catalog (S/M/L = 5,000/7,000/10,000) with a composite FK so a purchase always records its package's exact credits; (b) a trigger allows a `PURCHASE_GRANT` only for an `APPROVED` purchase and only for exactly its credits (**DV-001**); (c) every ledger insert updates the matching balance in the same statement, so balance = SUM(ledger) and the non-negative CHECK rejects overdrafts atomically (**DV-002**); (d) purchases, operations and the catalog are immutable. | Stronger than application-only checks. Tests: `tests/integration/credit-integrity.test.ts`, API specs. |
| D-019 | **P-001 implemented (DV-003):** ledger entry type `SEED` with a mandatory `seed_reason`, allowed only for SUBSCRIPTION/REWARD/PROMOTIONAL (never CONSUMABLE). `src/db/seed.ts` exposes `seedCredits()` (test helpers) and the `npm run db:seed:demo` CLI, which refuses `NODE_ENV=production` and non-loopback DB hosts. **No HTTP route exists**; a test checks the route table. | Needed to test CR-01 across all four buckets in M1, where only CONSUMABLE has a product path. |
| D-020 | **M1 API contracts** beyond auth: `GET /catalog` (packs, subscription previews, ad preview, operation costs; no prices); `GET /wallet`; `GET /history?limit=&before=` (itemized ledger, newest first, cursor = ledger id); `GET /purchases` (all attempts, including declined/cancelled); `POST /purchases {packageId, transactionId, mockOutcome}` → 201 new (any outcome), 200 identical replay, 409 `TRANSACTION_CONFLICT` (different payload or other user), 400 `UNKNOWN_PACKAGE`; a missing `mockOutcome` is treated as DECLINED (fail closed); `POST /operations {action, requestId}` → 201, 200 identical replay, 409 `REQUEST_ID_CONFLICT`, 402 `INSUFFICIENT_CREDITS` with `required`/`available`. Costs and credits are always decided by the server. | Implements D-006/D-007/D-008 and PRD §2.2–2.4. |
| D-021 | **The optional D-S3-05 DB CHECK (`email = lower(btrim(email))`) was NOT added.** The app normalizes emails, and the case-insensitive unique index remains. | Adding it would have changed the premise of the accepted Slice 1 test "email uniqueness is case-insensitive", which inserts mixed case directly. |
| D-022 | **Adjusted earlier test expectations** (not weakened): the migration tests now expect `001` + `002` and the `credit_packages` table; the API smoke spec expects both migrations; the Slice 1 test "an operation debits each bucket at most once" funds the bucket first, because migration 002 now rejects unfunded debits (overdraft). Every assertion is unchanged. | Transparency for review. |
| D-023 | **Paywall trial text:** the Basic plan preview shows "Planned: a 3-day trial with 1,000 credits. Not offered in M1; trial eligibility arrives in M2." as descriptive, non-actionable preview text, with all plans marked unavailable and the Subscription Continue button disabled. No eligibility claim, no call to action, no prices. *Revised 2026-11-18 per the owner's review note; an API test asserts the wording stays non-actionable.* | PRD §3.1 says to show trial messaging only when genuinely eligible; M1 can't determine eligibility, so it's never presented as an offer to the user. |
| D-024 | **iOS client:** SwiftUI, iOS 17+, Xcode 16 project with synchronized folders (app, unit-test and UI-test targets, shared scheme). Token stored in the Keychain (this device only). Base URL comes from the `MONETALAB_API_BASE_URL` launch env, then Info.plist, then `http://127.0.0.1:3000`. ATS allows local networking only. The mock outcome picker is labelled "test only". A "Get Credits" store on the Wallet tab reuses the paywall view. The `--reset-session` launch argument (UI tests) only clears the local token. | Minimal client that exercises all M1 paths against the real backend. |
| D-025 | **HTTP hardening:** Ajv with no type coercion and no property stripping (unknown properties → 400); query parameters validated as canonical digit strings; 16 KB body limit (413); `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` on all responses; uniform `{error:{code,message}}` with 404/415/500 mappings. | D-S3-06, plan §4.4. |
| D-026 | **Owner review notes (2026-11-18), applied before the M1 PR:** (a) the paywall freezes pack and mock-outcome selection while a purchase is in flight, so an unknown-outcome retry reuses the same `transactionId` for the same payload (found while adding the requested test; previously a mid-flight change could drop the pending id); (b) new iOS unit tests for repeated paywall open/close and for tab switching, double taps and selection changes during an in-flight purchase; (c) D-023 wording revised; (d) **D-021 is an intentional deferral**: the email-normalization DB CHECK stays out of M1 and may be added with a data migration later; (e) the D-S3-09 gaps remain **local-fixture-only** limitations. | Review notes on the consolidated M1 report. |

## Slice 3 decisions (approved 2026-11-17, D-016)

| ID | Decision |
|---|---|
| D-S3-01 | Session lifetime: **7 days absolute**, no sliding renewal. |
| D-S3-02 | Register does **not** log in automatically. `POST /auth/register` returns 201 with the user; only login issues tokens. |
| D-S3-03 | Password policy: **8–128 characters**, no composition rules. |
| D-S3-04 | Password hashing: Node `crypto.scrypt`, **N=2^15, r=8, p=1**, 16-byte salt, 64-byte key, self-describing hash string `scrypt$N$r$p$salt$key` (base64url). |
| D-S3-05 | Emails trimmed and stored lowercased. The optional migration `002` CHECK enforcing this is approved for step 3.3. |
| D-S3-06 | Routes `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /me`. Error shape `{ "error": { "code", "message" } }`. No `/v1` prefix. |
| D-S3-07 | Logout revokes the **current** session only. A repeat logout with the same token returns 401. |
| D-S3-08 | Add `@playwright/test` (dev dependency, exact pin, no browser downloads) and Playwright reports in the CI artifact. Installation happens in step 3.2, not earlier. |
| D-S3-09 | Accepted gaps, **limited to the local M1 QA fixture**: no rate limiting or lockout; a register 409 reveals that an email exists; plain HTTP on localhost; no cleanup of expired or revoked sessions. These aren't acceptable for any production or public deployment and must be revisited before one. |

## Approved in principle (details deferred)

| ID | Status | Decision | Next action |
|---|---|---|---|
| P-001 | **Approved in principle 2026-11-17. Implemented in M1 as D-019** (pending final QA review). | Seed SUBSCRIPTION/REWARD/PROMOTIONAL credits directly in the DB with an auditable ledger entry, never through an HTTP endpoint. A `db:seed:demo` script serves the iOS demo. | Present a detailed design (migration for a `SEED` entry type, guard rails, tests) for approval before Slice 4/6. Linked to DV-003. |

## Open Slice 2 decisions (from `docs/slice-2-plan.md` §7)

| ID | Decision | Status |
|---|---|---|
| D-S2-04 | Who runs `git push` (owner or Claude) | **Resolved 2026-11-17:** Claude pushes, but only when the owner gives explicit approval for each push (S2.2 precedent). |
| D-S2-05 | Commit author email: switch to a verified GitHub noreply address before the first commit | **Resolved 2026-11-17:** the owner set and verified the GitHub noreply address in the repo-local git config. Both baseline commits use it. |
| D-S2-12 | Optional negative-demo PR (S2.7) | Open |
| D-S2-13 | Optional minimal `README.md` stub | Open |
| D-S2-14 | Optional `actionlint` via Docker image | Open |

## Deferred verification requirements

The owner recorded these at Slice 1 QA sign-off (2026-11-17). Each must be met and tested before its target slice is accepted.

| ID | Requirement | Target | Expected evidence |
|---|---|---|---|
| DV-001 | *(Implemented: D-018b, evidence in `docs/m1-verification.md`)* A purchase grant is allowed **only for an `APPROVED` purchase**, and the credited amount **equals the purchased package's credits** (S/M/L = 5,000/7,000/10,000). Declined or cancelled purchases never produce a grant. | Slice 5 | `[NEG]` tests: no grant for a declined or cancelled purchase; a grant amount that doesn't match the package is rejected. `[BR]` test: each package grants its exact amount. Enforcement at the DB level where practical, not only in application code. |
| DV-002 | *(Implemented: D-018c, evidence in `docs/m1-verification.md`)* Balance and ledger changes are **atomic** (both commit or neither does), and their **consistency is validated**: per user and bucket, the balance equals the sum of ledger deltas. | Slices 5–6 | `[INT]` tests: the invariant holds after grants, debits, rejected operations and concurrent operations. A failure injected mid-transaction leaves both the balance and the ledger unchanged. |
| DV-003 | *(Implemented: D-019, evidence in `docs/m1-verification.md`)* Add a **safe, controlled test/demo seeding mechanism** for the SUBSCRIPTION/REWARD/PROMOTIONAL buckets, with **no public HTTP backdoor**. Seeded credits must be auditable in the ledger. See proposal P-001. | Before the credit-spending integration tests (Slice 6) | Owner approval of the mechanism. A test showing seeding writes a ledger entry and a balance together. A test or check showing no HTTP route can seed credits. |

## AI tooling decisions

None so far. Only plain `CLAUDE.md` and standard Claude Code tools are used.

## Backlog (not authorized)

Empty.
