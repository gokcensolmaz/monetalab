# Slice 3.2 — Verification (Playwright HTTP API test infrastructure)

**Date:** 2026-11-17
**Branch:** `slice-3-auth` (Slice 3.1 changes preserved). **Not committed or pushed. No PR.**
**Scope:** Playwright API test harness, `server.ts` startup and shutdown, a `/health` smoke spec, npm scripts. **No** auth routes, test-only HTTP endpoints, allocator or business-logic changes, migrations, or workflow changes.
**Decisions applied:** D-S3-08 (`@playwright/test` dev dependency, exact pin, no browsers), D-017a (owned server on a dynamic port), D-017b (test-scoped DB writes; none needed yet), D-015b (Docker volume and dev DB never touched), D-005 (test categories).

## 1. Changed files
| File | Change |
|---|---|
| `backend/package.json` / `package-lock.json` | `@playwright/test` **1.65.1** (exact, devDependency; pulls `playwright` and `playwright-core` 1.65.1, no install scripts). Scripts `test:api` = `playwright test`, `test:api:ci` = `mkdir -p test-results && PLAYWRIGHT_REPORTS=1 playwright test`. |
| `backend/tsconfig.json` | `include` adds `playwright.config.ts` (only change) |
| `backend/src/server.ts` | `PORT` validated (`0`–`65535`; `0` = OS-assigned; invalid → stderr message and exit 1). The listen error is reported without printing `DATABASE_URL`, and the pool is closed. Ready line now prints the **actually bound port and the PID**: `MonetaLab API listening on http://127.0.0.1:<port> (pid <pid>)`. **Graceful shutdown** on SIGTERM/SIGINT (`app.close()` → `pool.end()` → exit 0), with a 5 s forced-exit fallback. Default behavior is unchanged: `127.0.0.1:3000` when `PORT` is unset. |
| `backend/playwright.config.ts` *(new)* | `testDir: tests/api`, `*.spec.ts`, **`outputDir: test-results/playwright-artifacts`**, `globalSetup`, `fullyParallel`, `retries: 0`, 30 s timeout. Reporters: `list` locally. With `PLAYWRIGHT_REPORTS=1`: `list` + JUnit `test-results/api.junit.xml` + HTML `test-results/playwright-report` (`open: 'never'`). |
| `backend/tests/api/support/disposable-db.ts` *(new)* | Create and drop `monetalab_api_test_<12 hex>`. **Drop refuses any other name.** |
| `backend/tests/api/support/server-harness.ts` *(new)* | `startOwnedServer`, `stopChild`: spawn, ownership checks, deadlines, teardown escalation |
| `backend/tests/api/support/global-setup.ts` *(new)* | DB, then migrations, then owned server, then env for workers. Returns the teardown. Cleans up on partial failure. |
| `backend/tests/api/support/fixtures.ts` *(new)* | `api` (request context on the owned server), `harness` (identity), `db` (worker-scoped pool to the disposable DB, for assertions) |
| `backend/tests/api/health.spec.ts` *(new)* | 4 smoke specs |
| `backend/tests/integration/api-harness.test.ts` *(new)* | 18 `node:test` tests of the harness itself (lifecycle, failures, escalation, drop safety) |
| `docs/slice-3-plan.md` | Step 3.2 marked done locally, with the as-built file list |
| `docs/slice-3-2-verification.md` *(new)* | This report |

Not touched: `src/app.ts`, `src/auth/**`, `src/credits/**`, `src/db/**`, `migrations/**`, `.github/**`, `docker-compose.yml`.

## 2. Database lifecycle
1. **Create:** global setup connects to the `postgres` maintenance DB and runs `CREATE DATABASE "monetalab_api_test_<random 12 hex>"`. The name is unique per run, so parallel or local and CI runs don't collide.
2. **Migrate:** the **real** runner (`src/db/migrate.ts`) applies `migrations/*.sql` from scratch. A spec checks that `schema_migrations` = `['001_m1_foundation.sql']`.
3. **Use:** the server connects with a unique `application_name=monetalab_api_server_<hex>`. Test assertions connect as `monetalab_api_test_client`.
4. **Drop:** teardown runs `DROP DATABASE IF EXISTS … WITH (FORCE)` **after** stopping the server. `dropDisposableDatabase` throws `Refusing to drop …` for any name not matching `^monetalab_api_test_[0-9a-f]{12}$` (tested against `monetalab`, `postgres`, `template1`, the integration-test prefix, malformed and injection-style names).
5. The **dev DB `monetalab` and the Docker volume `monetalab_monetalab-db` are never modified.** Checked after every run: the dev DB exists with its 1 migration, and the volume is present.

## 3. Server ownership
The harness treats a server as **its own** only when all of these hold:
1. It spawned `node src/server.ts` itself with **`PORT=0`**, so the OS picks a free port. Fixed ports and collisions are impossible.
2. The port comes **only** from the ready line on **this child's own stdout pipe**.
3. The **PID in the ready line equals `child.pid`**. A foreign PID is rejected.
4. The child is still alive, and **`GET /health` returns 200** on that port before a deadline. This is an event-driven wait with a bounded 100 ms retry interval, not a fixed sleep.

The smoke spec checks ownership again from the worker:
- the response URL port equals the harness port
- `process.kill(pid, 0)` succeeds
- `pg_stat_activity` on the disposable DB shows a connection with the harness's **unique server `application_name`**, and `current_database()` matches the disposable name

**No HTTP endpoint was added for this.**

## 4. Failure, timeout and cleanup behavior
| Situation | Behavior | Evidence |
|---|---|---|
| Server exits before ready | Rejects `server exited before it was ready (exit code N…)` with recent stderr | harness test (exit code 3) |
| No ready line in time (default 15 s) | Rejects `no ready line within … ms`, child stopped | harness test (300 ms); `pgrep` finds no leftover |
| Ready line with a foreign PID | Rejects `reported pid X, but the spawned child is pid Y`, child stopped | harness test |
| `/health` never 200 (default 10 s) | Rejects with the last status (for example `GET /health returned 503`), child stopped | harness test (DB unreachable); no extra server process |
| Invalid `PORT` | `server.ts` exits 1, `Invalid PORT "abc"`, no DB URL printed | harness test |
| Normal stop | SIGTERM → graceful exit 0, port closed, process gone | harness test |
| SIGINT | Graceful exit 0 | harness test |
| Child ignores SIGTERM | SIGKILL after the stop timeout (default 5 s), port closed | harness test (300 ms) |
| Two harness servers at once | Different ports and PIDs | harness test |
| Partial global-setup failure | Everything created so far (server, DB) is cleaned up, then the error is re-thrown | code path in `global-setup.ts` (each step is covered by the tests above) |
| **A spec fails** | Teardown still runs: **0 leftover DBs, 0 servers** | scratch-copy run with a deliberately failing spec: 1 failed, 4 passed, then a clean state |
| **Runner interrupted (SIGINT)** mid-run | Teardown runs: **0 DBs, 0 servers** (1 DB + 1 server existed during the run) | scratch-copy run, SIGINT to `playwright test` |
| **Runner killed (SIGKILL)** | **Not cleaned up:** 1 orphan server + 1 DB remained. No handler can run on SIGKILL, and the `process.on('exit')` fallback doesn't fire either. | scratch-copy run. Then cleaned up manually (stop the orphan `src/server.ts`, drop via the guarded `dropDisposableDatabase`), and the final state was 0/0. See §7. |

## 5. Commands and results (in `backend/`, Docker `postgres:16.16-alpine`)
| Command | Exit | Result |
|---|---|---|
| `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --save-dev --save-exact @playwright/test` | 0 | 1.65.1. **Browser cache `~/Library/Caches/ms-playwright` unchanged** (listing diff before and after; it already held unrelated browsers from other projects). |
| `npm run typecheck` | 0 | No errors |
| `npm run test:unit` | 0 | **63/63 pass** (unchanged from 3.1) |
| `npm run test:integration` | 0 | **50/50 pass**: 32 existing + **18 harness tests** |
| `PLAYWRIGHT_BROWSERS_PATH=<empty dir> npm run test:api` | 0 | **4/4 pass** (~0.7 s). The empty browsers dir still had 0 files afterwards, so **no browser binaries are needed or downloaded.** |
| CI sequence from an empty `test-results/`: `test:unit:ci`, `test:integration:ci`, `test:api:ci` | 0 / 0 / 0 | All three run |
| Report validation (`xmllint --noout`, XPath counts) | — | `unit.junit.xml` 63 testcases, 0 failures; `integration.junit.xml` 50 / 0; **`api.junit.xml` 4 / 0**; `playwright-report/index.html` present |
| **Earlier reports preserved** | — | The unit and integration JUnit files had the **same mtime** before and after `test:api:ci`. Playwright only writes into `test-results/playwright-artifacts/` and `test-results/playwright-report/`. |
| Leftovers after all runs | — | `monetalab_api_test_*` / `monetalab_test_*` DBs: **0**. `src/server.ts` processes: **0**. Dev DB: present. Volume: present. |

### API smoke specs (`tests/api/health.spec.ts`)
| Spec | Asserts |
|---|---|
| `[INT]` GET /health ok | 200, JSON content type, body `{status:'ok', database:'ok'}` |
| `[INT]` response from the owned server on the disposable DB | URL port = harness port; PID alive; `pg_stat_activity` has the unique server `application_name` on this DB; DB name matches the disposable pattern |
| `[INT]` real migrations applied | `schema_migrations` = `['001_m1_foundation.sql']` |
| `[NEG]` unknown route | 404, no `x-powered-by` header |

### Mutation checks (scratch copies only)
| Injected defect | Result |
|---|---|
| PID ownership check removed | **Caught**: the foreign-PID test fails |
| Graceful SIGTERM handler removed from `server.ts` | **Caught**: 2 lifecycle tests fail (exit by signal instead of 0) |
| SIGKILL escalation removed from the harness | **Detected as a hang**: the SIGTERM-ignoring child keeps the test process alive, and it never finishes. The run was stopped manually; no leftover processes or DBs were found. In CI this would fail through the 15-min job timeout, not a clear assertion. See §7. |
| Drop-name guard removed | **Not run, deliberately.** The permission check refused the command: with the guard removed, the refusal tests would have run a real `DROP DATABASE monetalab WITH (FORCE)` against the dev DB, which D-015b forbids. Coverage relies on the 7 refusal tests passing against the real guard. |

## 6. Security notes
- **No test-only HTTP endpoints.** Ownership is proven via stdout, the PID and `pg_stat_activity`.
- `server.ts` never prints `DATABASE_URL` (tested for the invalid-port path). Fastify logging stays off.
- The harness keeps at most 50 recent output lines in memory, for error messages only. The server doesn't log requests.
- The test DB credentials are the existing non-secret local/CI values (D-012).

## 7. Known limitations
1. **A SIGKILL'd runner** (or a machine crash) leaves an orphan server and a `monetalab_api_test_*` DB. Manual recovery: stop the orphan `node src/server.ts` process, then drop each leftover DB through `dropDisposableDatabase(name)`. That only works on matching names, so the dev DB is never at risk. CI runners are discarded after each job, so this only affects local machines.
2. **Escalation-removal regression shows up as a hang,** not a failing assertion. The harness test could get its own test timeout plus a direct check for leftover processes. That's a small hardening for a later step if wanted.
3. The harness tests use **`pgrep`** to check for leftover processes. It exists on macOS and on `ubuntu-24.04` runners (procps), but that hasn't been checked in CI yet.
4. **CI doesn't run the Playwright API tests yet.** The workflow is unchanged (step 3.7). CI *will* run the 18 new harness tests through `test:integration:ci` on the next push, and `npm ci` will install Playwright without browsers. **NOT VERIFIED on GitHub**, because nothing has been pushed.
5. Only `/health` is covered. The auth specs (1–19) come with steps 3.3–3.6.
6. `fullyParallel` with 4 local workers. The worker count on CI runners will differ. Isolation relies on per-test users (from 3.3) and test-scoped DB writes (D-017b).

**Status:** Slice 3.2 is complete locally and waiting for QA review. Step 3.3 (register) hasn't been started.
