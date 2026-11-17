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

## Approved in principle (details deferred)

| ID | Status | Decision | Next action |
|---|---|---|---|
| P-001 | **Approved in principle 2026-11-17.** Implementation details deferred. | Seed SUBSCRIPTION/REWARD/PROMOTIONAL credits directly in the DB with an auditable ledger entry, never through an HTTP endpoint. A `db:seed:demo` script serves the iOS demo. | Present a detailed design (migration for a `SEED` entry type, guard rails, tests) for approval before Slice 4/6. Linked to DV-003. |

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
| DV-001 | A purchase grant is allowed **only for an `APPROVED` purchase**, and the credited amount **equals the purchased package's credits** (S/M/L = 5,000/7,000/10,000). Declined or cancelled purchases never produce a grant. | Slice 5 | `[NEG]` tests: no grant for a declined or cancelled purchase; a grant amount that doesn't match the package is rejected. `[BR]` test: each package grants its exact amount. Enforcement at the DB level where practical, not only in application code. |
| DV-002 | Balance and ledger changes are **atomic** (both commit or neither does), and their **consistency is validated**: per user and bucket, the balance equals the sum of ledger deltas. | Slices 5–6 | `[INT]` tests: the invariant holds after grants, debits, rejected operations and concurrent operations. A failure injected mid-transaction leaves both the balance and the ledger unchanged. |
| DV-003 | Add a **safe, controlled test/demo seeding mechanism** for the SUBSCRIPTION/REWARD/PROMOTIONAL buckets, with **no public HTTP backdoor**. Seeded credits must be auditable in the ledger. See proposal P-001. | Before the credit-spending integration tests (Slice 6) | Owner approval of the mechanism. A test showing seeding writes a ledger entry and a balance together. A test or check showing no HTTP route can seed credits. |

## AI tooling decisions

None so far. Only plain `CLAUDE.md` and standard Claude Code tools are used.

## Backlog (not authorized)

Empty.
