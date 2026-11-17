# Slice 1 — Verification Report (PostgreSQL Database Foundation)

**Date:** 2026-11-17
**Scope:** Docker Compose Postgres 16, a plain-SQL migration runner, the M1 schema with constraints, DB integration tests, and a minimal `/health`. **Not included:** auth workflows, purchase/spend APIs, iOS, subscriptions, ads, StoreKit, HTTP test endpoints.
**Environment:** macOS (Apple Silicon, Darwin 23.5.0), Node v24.20.0, Docker 29.9.3 (aarch64), Docker Compose v5.7.0, image `postgres:16-alpine`.
**Git:** nothing committed (D-002).

> Note: `docker` was installed at `~/.docker/bin`, but that folder wasn't on the PATH of the shell Claude Code was using, which started before the install. Commands were run with `PATH="$HOME/.docker/bin:$PATH"`. A new terminal will probably pick it up automatically.

## 1. Commands and real results

| # | Command (in `backend/` unless noted) | Result |
|---|---|---|
| 1 | `npm run db:up` (`docker compose up -d --wait db`) | Container `monetalab-db-1` reported **Healthy** |
| 2 | `npm run db:migrate` (first run) | `Applied: 001_m1_foundation.sql` |
| 3 | `npm run db:migrate` (second run) | `No pending migrations.` |
| 4 | `psql \dt` in the container | 7 tables: `bucket_balances`, `credit_ledger`, `operations`, `purchases`, `schema_migrations`, `sessions`, `users` |
| 5 | `npm run typecheck` | Exit 0, no errors |
| 6 | `npm run test:unit` | Exit 0. **19 tests: 19 pass, 0 fail** (unchanged from Slice 0) |
| 7 | `npm run test:integration` | Exit 0. **32 tests in 5 suites: 32 pass, 0 fail**, 0 skipped |
| 8 | `npm test` (unit + integration) | Exit 0. 19/19 and 32/32 |
| 9 | `PORT=3917 npm start`, then `curl /health` | `{"status":"ok","database":"ok"}`, HTTP 200 |
| 10 | `npm run test:integration` × 3 more runs | 32/32 pass each time, so no flakiness seen in the concurrency tests |
| 11 | Leftover `monetalab_test_%` databases after the runs | 0 |

**Failure found and fixed during this slice:** the first integration run had 31/32 pass. The failing test, "new user gets four buckets", had a **bug in the test itself**: `ORDER BY bucket` sorted the `::text` alias alphabetically instead of in enum order. The trigger's actual data was correct. I fixed the query to sort by the enum column and re-ran it (result 7).

## 2. What was built

| File | Purpose |
|---|---|
| `docker-compose.yml` | `postgres:16-alpine`, a `pg_isready` health check, bound to `127.0.0.1:55432`, a named volume. Credentials are non-secret local defaults and can be overridden from the environment. |
| `backend/migrations/001_m1_foundation.sql` | The M1 schema (below). |
| `backend/src/db/migrate.ts` | The runner: applies files in order, one transaction per file, a SHA-256 checksum ledger, an advisory lock, and refusal to run edited migrations. |
| `backend/src/config.ts` | `DATABASE_URL`, with a local-only default. |
| `backend/src/app.ts`, `backend/src/server.ts` | Fastify with `GET /health`: 200 when the DB is reachable, 503 otherwise. |
| `backend/tests/integration/helpers/test-db.ts` | Creates and drops an isolated database for each test file, plus test helpers. |
| `backend/tests/integration/{migrations,constraints,health}.test.ts` | 32 integration tests. |
| `backend/package.json` | Scripts `db:up`, `db:down`, `db:migrate`, `start`, `test:integration`, `test`. Dependencies `fastify@5.12.8`, `pg@8.23.1`, dev dependency `@types/pg@8.23.1` (all pinned exactly). |
| `docs/decisions.md` | Proposals P-002 to P-004 added (awaiting approval). |

### Schema and the rules it enforces

| Rule (source) | DB mechanism | Covered by test |
|---|---|---|
| No negative balances (PRD §2.3, CLAUDE.md #4) | `bucket_balances_non_negative CHECK (balance >= 0)` | `[NEG]` negative balance, `[NEG]` decrement below zero |
| Four buckets, exactly (PRD §2.4) | `credit_bucket` enum. An `AFTER INSERT` trigger on `users` creates the 4 rows. PK `(user_id, bucket)`. | `[INT]` enum values, `[INT]` 4 rows per user, `[NEG]` duplicate bucket row |
| No duplicate purchase transaction (BUY-03, D-006) | `UNIQUE (provider, provider_transaction_id)`, global across users | `[NEG]` duplicate, `[NEG]` cross-user reuse, `[NEG]` 10 concurrent inserts → exactly 1 |
| No duplicate fulfillment (CLAUDE.md #4) | Partial unique index: one `PURCHASE_GRANT` per purchase | `[NEG]` second grant, `[NEG]` 10 concurrent grants → exactly 1 |
| Spend idempotency (PRD §2.4) | `UNIQUE (user_id, request_id)`. Also one debit per (operation, bucket). | `[NEG]` duplicate request, `[INT]` same request ID allowed for different users, `[NEG]` double debit |
| Cross-user integrity | Composite FKs `(purchase_id, user_id)` and `(operation_id, user_id)` | `[NEG]` ledger cannot reference another user's purchase or operation |
| Ledger entry validity | `credit_ledger_entry_shape` CHECK: grant is positive, CONSUMABLE only, and linked to a purchase; debit is negative and linked to an operation; delta ≠ 0 | 6 `[NEG]` shape tests |
| Immutable history (PRD §2.4, CLAUDE.md #5) | `BEFORE UPDATE OR DELETE` and `BEFORE TRUNCATE` triggers raise `restrict_violation` | `[NEG]` UPDATE (including a no-op), DELETE and TRUNCATE are rejected and the row is unchanged |
| History is preserved | FKs block deleting a user who has history | `[NEG]` user delete is rejected |
| Sessions store only token hashes | `token_hash bytea` (32 bytes), unique, `revoked_at` | `[NEG]` duplicate token hash |
| Fresh DB init and repeatable migrations | The runner | `[INT]` fresh DB, `[INT]` re-run no-op, `[NEG]` concurrent runners, `[NEG]` checksum tamper, `[NEG]` failed migration fully rolled back |

Test counts by category (D-005): **9 `[INT]`** and **23 `[NEG]`** integration tests. Plus 19 unit tests (6 `[BR]`, 13 `[NEG]`).

## 3. Mutation checks (scratch copy of the migration, not the repo)

| Constraint removed | Integration tests failing |
|---|---|
| `bucket_balances_non_negative` | 2 |
| Ledger UPDATE/DELETE trigger | 1 |
| One-grant-per-purchase index | 2 |
| `purchases_provider_transaction_uq` | 3 |

Each removed protection is detected.

## 4. Isolation and security notes

- Each test file creates `monetalab_test_<random>`, runs **all migrations from scratch**, and drops it afterwards. Tests never touch the dev `monetalab` database. Each test creates its own users with unique `@test.invalid` emails.
- **No HTTP test or fixture endpoints exist.** The only route is `GET /health`.
- No real secrets: the only credential is the documented local default `monetalab_local_only`, and the port is bound to localhost only.

## 5. Known limitations and gaps

- **Balance ↔ ledger consistency isn't enforced by the DB.** It will come from the Slice 5/6 transactions (row lock, ledger insert and balance update together) and an invariant test (ledger sum = balance).
- **Immutability triggers stop application-level changes, not a superuser** who disables triggers. That's acceptable for this fixture.
- **No `SEED` ledger entry type yet.** Seeding the SUBSCRIPTION/REWARD/PROMOTIONAL buckets (P-001) would need a new migration once approved.
- **Session lifetime** (`expires_at`) is required by the schema, but its duration is chosen in Slice 3.
- **The package catalog** (S/M/L → 5,000/7,000/10,000) isn't in the DB. `purchases.credits` is only checked to be positive. The catalog arrives in Slice 5.
- **Blocking user deletion** follows from preserving history. Account deletion policy is still PRD open decision #7.
- Integration tests use `node:test`, not Playwright (P-002, awaiting approval).
- CI hasn't run yet (Slice 2). No `.nvmrc` yet.
- The DB container is still running. Stop it with `npm run db:down`; the data volume is kept.

**Verdict:** Slice 1's acceptance criteria are met and verified locally. Ready for owner review. Slice 2 hasn't been started.
