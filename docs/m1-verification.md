# MonetaLab — M1 Verification Report

**Date:** 2026-11-17
**Branch:** `slice-3-auth` (local; **not committed, not pushed, no PR**). The base is `main` @ `0d46331` (Slices 0–2 merged).
**Status update (2026-11-18):** pushed as 5 commits, merged via **PR #2** into `main` @ `3e51fbf`. GitHub Actions `api-db-regression` passed on the PR and on `main`; see §6. The original wording above is kept as recorded.
**Scope:** all remaining M1 work (Slices 3–8 of `docs/initial-implementation-plan.md`) done in one continuous run, as authorized by the owner. A single final owner QA review is pending.
**Environment:** macOS (Apple Silicon), Node v24.20.0, npm 11.19.0, Docker 29.9.3 / Compose v5.7.0, `postgres:16.16-alpine`, Xcode 16.2, iPhone 16 simulator (iOS 18.1).

**Labels:**
- **PASS:** executed here, with evidence below
- **FAIL:** executed and failing
- **NOT VERIFIED:** not executed, with the reason given
- **M2 / M3:** the PRD assigns it to a later milestone

Nothing below is marked PASS based on code alone.

---

## 1. Automated results (final run, all actually executed)

| # | Command | Exit | Result |
|---|---|---|---|
| 1 | `cd backend && npm run typecheck` | 0 | No errors (TypeScript 7.0.2, strict) |
| 2 | `npm run test:unit` | 0 | **63 / 63 pass**: allocator 19, password 19, tokens 25 |
| 3 | `npm run test:integration` (Docker Postgres 16.16) | 0 | **73 / 73 pass**: constraints 25, credit-integrity 23, api-harness 18, migrations 5, health 2 |
| 4 | `npm run test:api` (Playwright, real server, disposable DB, `PLAYWRIGHT_BROWSERS_PATH`=empty dir) | 0 | **102 / 102 pass**: auth 36, operations 24, purchases 21, wallet/history/catalog 17, health smoke 4 |
| 5 | Full API suite repeated 3× (concurrency stability) | 0 | 102/102 each run, no flakes |
| 6 | **CI simulation:** every `run:` step parsed from `.github/workflows/api-regression.yml`, run with `bash -eo pipefail` in a fresh copy (`npm ci`, no `node_modules`) against a fresh empty DB | 0 for every step | Node 24.20.0, Postgres 16.16. JUnit: unit **63**, integration **73**, api **102** testcases, all well-formed (`xmllint`), 0 failures/errors/skipped. Playwright HTML report 615 KB. The job summary shows all three suites. 0 browser files downloaded. |
| 7 | Workflow YAML policy checks (parsed YAML) | 0 | **20/20**: PR trigger on `main`, no `pull_request_target`, no path filter, `contents: read` only, job name `api-db-regression` unchanged, 3 official actions pinned to 40-char SHAs, no `secrets.*`, `persist-credentials: false`, API step gated on migration with no browser download, artifact includes JUnit + HTML + logs and uploads on failure |
| 8 | `xcodebuild -scheme MonetaLab … clean test` (iPhone 16, iOS 18.1) against `npm run e2e:server` (real backend, disposable DB) | 0 | **22 / 22 pass**: 20 unit (PaywallFlow 9, APIClient 7, AppModel 4) + 2 UI (primary journey 46–53 s, wrong password). **0 Swift warnings** in app sources. `TEST SUCCEEDED`. |
| 9 | `xcodebuild -configuration Release -destination 'generic/platform=iOS Simulator' build` | 0 | `BUILD SUCCEEDED` |
| 10 | Leftovers after all runs | — | 0 `monetalab_*test*` DBs, 0 server processes. Dev DB present (migrated to 002, no data loss). Volume `monetalab_monetalab-db` present. |

**Total automated tests: 238 backend (63 + 73 + 102) + 22 iOS = 260, all passing.**

### Mutation checks (scratch copies; the repo was never modified)
| Injected defect | Detected by |
|---|---|
| Spend without row locks (`FOR UPDATE` removed) | 3 API specs fail (concurrency) |
| `requestId` idempotency check removed | 3 API specs fail |
| Grant credits for every purchase outcome | 5 API specs fail (the DB DV-001 trigger blocks it) |
| Purchase conflict detection removed | 3 API specs fail |
| Bucket priority swapped | 3 API specs fail (+ unit tests, Slice 0) |
| Logout without the single-revocation guard | spec #19 fails |
| Auth guard ignores revocation and expiry | 5 API specs fail |
| (3.1/3.2) password/token/harness mutations | caught; see `docs/slice-3-1-verification.md` and `docs/slice-3-2-verification.md` |

### Failures found and fixed during this run (root causes)
1. **Query-string coercion (real bug):** Ajv type coercion is off app-wide (so JSON bodies are never coerced), which made `?limit=3` fail the integer schema. Fixed: query values are validated as canonical digit strings and parsed explicitly. Tests cover `0`, `101`, `999`, `abc`, `1.5`, `01`, negative values and unknown keys.
2. **iOS paywall feedback below the fold:** the result message sat in a lazily rendered `List` row at the bottom, so it wasn't visible after **Continue**. Moved it directly under the Continue button (better UX, and found by the UI test).
3. Test-side mistakes, corrected without weakening any assertion:
   - `ORDER BY` on a `::text` alias sorted alphabetically (2 specs)
   - trailing whitespace in `Authorization` is stripped by HTTP itself (RFC 7230 §3.2.4), so it's the same token; this is now a documented positive test, and leading/inner whitespace is still rejected
   - number formatting depends on the simulator locale: the unit test compares against the platform's formatting, and the UI test pins `en_US`
   - migration-count expectations updated for `002` (D-022)

---

## 2. Requirement-by-requirement checklist

### PRD §1 — M1 scope
| Requirement | Result | Evidence |
|---|---|---|
| Create account, sign in/out, identify the current user | **PASS** | `auth.spec.ts` #1–#19 (+ boundaries, malformed tokens, 413, concurrency); iOS UI journey (register → … → sign out); `AppModelTests` |
| Display credit wallet and itemized transaction history | **PASS** | `wallet.spec.ts` (four pools, total, ordering, pagination, isolation, append-only); iOS UI journey checks wallet balances, 2 history entries and 2 purchase attempts |
| Mock consumable purchases: approved, declined, cancelled, duplicate/retried | **PASS** | `purchases.spec.ts` (21); `credit-integrity.test.ts`; iOS UI journey (cancelled, then approved); `PaywallFlowTests` (transaction id reused on network retry) |
| Consume credits for predefined actions; block insufficient; open paywall | **PASS** | `operations.spec.ts` (24); `PaywallFlowTests`; UI journey (402 → paywall) |
| Four credit buckets with ordered, atomic deductions | **PASS** | PRD §2.4 example end-to-end (`[BR][CR-01]`); 5 split-bucket cases; DB-level atomic overdraft rollback (`credit-integrity`) |
| API + database automated tests and GitHub Actions PR regression | **PASS locally / PASS on GitHub (run conclusion, §6); artifact contents NOT VERIFIED** | Tests: §1 rows 1–6. The workflow (now with Playwright) passed a full local simulation. **A GitHub run of the extended workflow needs a push** (owner approval). The Slice 2 version of the workflow already ran green on GitHub (PR #1). |
| Basic iOS app capable of exercising the core paths | **PASS** | Real Xcode project; builds Debug + Release; UI journey on the simulator against the real backend |
| Repository setup, setup instructions, test matrix and evidence in README | **PASS** | `README.md` (commands executed in this run), this report |

### PRD §5 — acceptance criteria
| ID | Expected | Result | Evidence |
|---|---|---|---|
| AUTH-01 | Secure, user-specific wallet and history | **PASS** | scrypt hashes and SHA-256 token storage checked in the DB; identical 401s; expiry/revocation; cross-user isolation for `/me`, wallet, history, purchases, operation request ids; no secrets in responses |
| BUY-01 | Single correct consumable grant | **PASS** | S/M/L grant exactly 5,000/7,000/10,000 once (HTTP + DB); the DB trigger rejects wrong amounts |
| BUY-02 | Declined/cancelled: no credit change | **PASS** | HTTP + DB (no ledger rows, balance 0); the DB rejects grants for non-approved purchases; iOS UI journey (cancelled) |
| BUY-03 | Duplicate verified purchase grants exactly once | **PASS** | identical replay → 200 with no grant; 10 concurrent duplicates → 1×201 + 9×200 and 1 grant; conflicts → 409; cross-user reuse → 409 |
| CR-01 | Exact ordered, atomic bucket debits | **PASS** | PRD example 200/300/400/1000 − 800 → 0/0/100/1000 via the real purchase + seed path; ledger rows per bucket checked |
| CR-02 | Zero debit; insufficient-credit error; paywall opens | **PASS** | 402 `INSUFFICIENT_CREDITS` with `required`/`available`; balances, ledger and operations unchanged; iOS opens the paywall (unit + UI) |
| CR-03 | No negative balances or double spending | **PASS** | 10 concurrent 800-credit ops on 5,000 → exactly 6 succeed, 200 left; 20 mixed concurrent ops conserve credits; 10 concurrent same-`requestId` → one debit; ledger = balance after each |
| PW-01 | Subscription/Credits tabs show correct plans and packs | **PASS** | `/catalog` spec; UI journey (Subscription tab plans, purchase disabled; Credits tab packs) |
| PW-02 | Sufficient after purchase: paywall closes to the prior screen; operation awaits confirmation | **PASS (purchase path)** / reward path **M2** | `PaywallFlowTests.testApprovedPurchaseThatCoversCost…` (run count stays 1); UI journey (no `operation.result` until re-confirmation); server shows exactly 1 operation; API spec `[PW-02]` |
| PW-03 | Still insufficient: paywall stays open | **PASS (purchase path)** / reward path **M2** | `testStillInsufficientAfterPurchaseKeepsPaywallOpen`; declined/cancelled keep it open (unit + UI) |
| CI-01 | PR runs deterministic API/DB regression with a report | **PASS locally / PASS on GitHub (run conclusion, §6); artifact contents NOT VERIFIED** | see §1 rows 6–7; needs an approved push and PR run |
| TRIAL-01/02, SUB-01..06 | Subscription lifecycle | **M2** | Not implemented (PRD §1 M2). Plans shown as unavailable previews only. |
| ADS-01..04 | Rewarded ads | **M2** | Not implemented. "Watch an Ad — Earn 100 Credits" is shown disabled with "not available in this release (M2)". |

### PRD §2–3 rules relevant to M1
| Rule | Result | Evidence / note |
|---|---|---|
| Packs S/M/L = 5,000/7,000/10,000; each verified distinct purchase grants once | **PASS** | DB catalog + FK + trigger; API specs |
| Operation costs 100/500/800; server-side only | **PASS** | `[BR]` cost spec; client-supplied `cost` → 400 |
| Debit only when the backend accepts; immediate success, no reversal (D-008) | **PASS** | operations spec; simulated deterministic output |
| Negative balances prohibited | **PASS** | DB CHECK + trigger; overdraft tests at DB and HTTP level |
| Priority SUBSCRIPTION → CONSUMABLE → REWARD → PROMOTIONAL; may span buckets | **PASS** | allocator unit tests + API split-bucket cases |
| Insufficient total blocks the whole operation | **PASS** | 402 with no rows (HTTP + DB) |
| Atomic commit; no overdraw or double-spend under concurrency | **PASS** | row locks + DB trigger; concurrency specs; mutation check |
| History immutable/auditable | **PASS** | ledger/purchases/operations reject UPDATE/DELETE/TRUNCATE (DB tests); history append-only spec |
| Purchase transaction IDs and operation request IDs idempotent | **PASS** | replay/conflict/concurrent specs |
| Paywall: two tabs; Continue starts the purchase; cancel/fail leaves balances unchanged | **PASS** | UI journey + unit tests |
| Paywall: re-fetch the balance after purchase; dismiss when sufficient | **PASS** | the purchase response carries the server wallet; the wallet model refreshes; unit + UI |
| **Never auto-execute the blocked operation** | **PASS** | unit (call count), UI (no result until confirmed), server (1 operation) |
| Stay on the paywall when still insufficient | **PASS** | unit test |
| Handle closing the paywall without changes | **PASS** | `testClosingPaywallDoesNothing` |
| Handle stale balance and repeated navigation gracefully | **PASS** (updated 2026-11-18, §5) | The balance always comes from the server (purchase response + refresh, pull-to-refresh). New unit tests cover repeated paywall open/close and tab switching, double taps and selection changes during an in-flight purchase. |
| Introductory-trial messaging only when genuinely eligible | **PASS with interpretation (D-023, revised)** | Descriptive, non-actionable preview text on an unavailable plan ("Not offered in M1; trial eligibility arrives in M2"). An API test asserts the wording. |
| Watch Ad shown when eligible | **Preview only** | Ad eligibility rules are M2; the button is visible and disabled |
| No real prices presented (open decision #1) | **PASS** | catalog has no prices (asserted); UI shows none |

### CLAUDE.md architecture rules
| Rule | Result | Evidence |
|---|---|---|
| 1. Backend authoritative; iOS can't grant credits | **PASS** | No client-side balance math; costs and credits set by the server; client-supplied `credits`/`cost` rejected |
| 2. Priority order; trial credits in SUBSCRIPTION | **PASS** (trials M2) | allocator + API |
| 3. Insufficient → reject everything | **PASS** | CR-02 |
| 4. Atomic; no negatives; no duplicate fulfillment; constraints, transactions, idempotency, concurrency tests | **PASS** | migrations 001/002, specs, mutation checks |
| 5. Auditable history, nothing erased | **PASS** | immutability triggers; users with history can't be deleted |
| 6. Mock purchases deterministic and test-controlled; never a production backdoor | **PASS** | outcome chosen by request; a missing outcome fails closed (DECLINED); server refuses the mock with `NODE_ENV=production` (executed: exit 1); no seed or grant HTTP routes (route-table test) |
| 7. Billing contract separate from implementation | **PASS** | `src/billing/provider.ts`; per D-004, StoreKit isn't assumed to implement it |
| 8. No secrets or signing material in Git | **PASS** | scan of all 64 candidate files: no keys, tokens, personal emails or local paths; no `DEVELOPMENT_TEAM`; `.gitignore` covers signing files, `.xcresult` and `ios/build/` |

### Deferred verification requirements
| ID | Result | Evidence |
|---|---|---|
| DV-001 approved-only, exact-amount grants | **PASS** | DB trigger + FK; 8 DB tests; API specs; mutation check |
| DV-002 atomic balance/ledger + consistency | **PASS** | ledger→balance trigger; `expectLedgerConsistent` after grants, debits, rejections and concurrency; multi-row rollback test |
| DV-003 safe seeding without an HTTP backdoor | **PASS** | `SEED` entries with a reason, never into CONSUMABLE; CLI guards tested; route table has no seed/grant/admin/test routes |

### PRD §8 — "M1 done" definition
| Criterion | Result |
|---|---|
| Clone, start API + DB with documented commands | **PASS** (commands in the README executed here: `db:up`, `db:migrate`, `npm start`; health 200, catalog, wallet 401 without auth) |
| Run automated tests | **PASS** (§1) |
| Exercise the iOS UI from login through mock purchase, credit spending and paywall | **PASS** (automated UI journey on the simulator against the real backend; DB state confirmed independently) |
| PR triggers deterministic regression with accessible results | **PASS: the run triggered on PR #2 and succeeded (§6).** Artifact contents NOT VERIFIED; local simulation PASS |

---

## 3. What still requires external verification
1. **GitHub Actions run of the extended workflow** (Playwright step, HTML report in the artifact) on a PR. Then download the artifact and check that the JUnit files hold 63/73/102 testcases and that `playwright-report/index.html` opens (D-015c).
2. **The required check still applies:** the job name `api-db-regression` is unchanged, so branch protection should keep working. This needs to be seen on the PR.
3. **Physical-device build/run:** NOT VERIFIED. No signing team is configured (deliberately: no signing material in Git). Simulator only.
4. **Manual exploratory pass in the simulator by the owner** (visual layout, accessibility), beyond the automated journey.

## 4. Known risks and limitations
- **Accepted M1 fixture gaps (D-S3-09):** no login rate limiting or lockout; register 409 reveals that an email exists; HTTP on localhost only; no cleanup of expired sessions. Not acceptable for any public deployment.
- **No iOS job in CI.** iOS tests run locally only (the UI journey needs a running backend). The PRD's M1 CI requirement covers API/DB regression.
- ~~Repeated-navigation robustness isn't specifically tested~~: covered since 2026-11-18 (§5).
- **`GET /purchases`** returns the most recent attempts (`limit` up to 100) without a cursor. `GET /history` is fully paginated.
- **Unicode normalization of passwords** isn't applied (raised in 3.1, still open for the owner).
- **scrypt N=2^15** (below the OWASP recommendation; D-S3-04, upgradable).
- **TypeScript 7.0.2** (new major); Playwright 1.65.1; both pinned.
- **Harness:** a SIGKILL'd test runner can leave one disposable DB and server behind (documented manual cleanup in `docs/slice-3-2-verification.md`).
- **Direct `UPDATE bucket_balances`** by a DB superuser would bypass the ledger. The application never does this, and tests compare balances to ledger sums.
- **Earlier test expectations adjusted** for migration 002 (D-022). The email-normalization DB CHECK is **intentionally deferred** (D-021, confirmed by the owner's review note; see D-026).
- PRD open decisions still open and **not implemented**: #2 consumable refund/clawback, #4–#10 (M2/M3 topics).

## 5. Pre-PR addendum (2026-11-18): owner review notes and final re-run
§1 above is the original evidence and is unchanged. Changes since then (D-026):
- **Fix (iOS):** the paywall now freezes pack and mock-outcome selection while a purchase is in flight, in both the model and the view. Before, changing either mid-flight cleared the pending `transactionId`, so retrying after a network failure would send a new id; if the first request had succeeded on the server, that could buy twice. The server would still reject a mismatched replay with 409; this fix keeps client retries idempotent.
- **New iOS unit tests:** `testRepeatedPaywallOpenCloseNeverAutoRunsOrPurchases` and `testTabSwitchAndSelectionChangesDuringInFlightPurchaseAreSafe`. They use a gated fake to hold the purchase in flight.
  - Mutation check: with the freeze disabled, the in-flight test fails with 6 assertion failures (selection not frozen, pending id dropped, retry id differs). The code was restored afterwards.
- **Trial wording (D-023 revised):** now "Planned: a 3-day trial with 1,000 credits. Not offered in M1; trial eligibility arrives in M2." `wallet.spec.ts` asserts the wording stays non-actionable (no "free", "eligible", "start" or "claim").
- **Docs:** README "Known limitations (local QA fixture only)"; D-021 confirmed as an intentional deferral; D-026 added.

Final re-run, all executed on 2026-11-18:

| Command | Result |
|---|---|
| `npx tsc --noEmit` (backend) | exit 0 |
| `npm run test:unit` | 63/63 pass |
| `npm run test:integration` | 73/73 pass |
| `npm run test:api` | 102/102 pass |
| `xcodebuild … -scheme MonetaLab clean test` (iPhone 16 simulator, iOS 18.1) against `npm run e2e:server` | **24/24**: 22 unit (PaywallFlow 11, APIClient 7, AppModel 4) + 2 UI. `TEST SUCCEEDED`, 0 Swift warnings in app sources |
| `xcodebuild … -configuration Release -destination 'generic/platform=iOS Simulator' build` | `BUILD SUCCEEDED` |
| Leftovers after the run | Only the dev database `monetalab` exists; volume `monetalab_monetalab-db` intact; no server processes |

**GitHub Actions run of the updated workflow:** NOT VERIFIED until the PR runs.

## 6. GitHub verification after the merge (recorded 2026-11-18)
PR #2 (`slice-3-auth` → `main`, "feat: complete MonetaLab M1 implementation") was merged on 2026-11-18 at 11:37:07 UTC as merge commit `3e51fbf`.
- The merge commit's parents are `0d46331` (previous `main`) and `c059b05` (branch head).
- Its tree is identical to `c059b05`, so all 5 M1 commits landed unchanged.

Workflow runs (`API/DB regression`, job `api-db-regression`), read from the public GitHub REST API (`/repos/gokcensolmaz/monetalab/actions/runs` and `/pulls/2`):

| Run ID | Trigger | Commit | Status | Conclusion |
|---|---|---|---|---|
| 44295097498 | `pull_request` (PR #2, `slice-3-auth`) | `c059b05` | completed | **success** |
| 44296335810 | `push` to `main` (after the merge) | `3e51fbf` | completed | **success** |

**Verified:** both runs completed with conclusion `success` on the commits listed. This covers the extended workflow, including the new Playwright step.

**NOT VERIFIED:**
- **Artifact contents:** the three JUnit files with 63, 73 and 102 test cases, and `playwright-report/index.html`. Downloading the artifact and reading the logs need an authenticated GitHub session, and the `gh` CLI isn't installed on this machine. The per-step results and the job summary weren't inspected either. The owner can confirm them in the run pages, or Claude can once `gh` is authenticated.
- **The required-check gate:** `api-db-regression` was the check the PR needed, but this API read didn't fetch branch protection.

Local environment after a macOS update (2026-11-18, read-only checks):
- Docker 29.9.3; container `monetalab-db-1` is healthy.
- The original volume `monetalab_monetalab-db` (created 2026-11-17T11:53:04Z) is intact.
- Dev database `monetalab`: PostgreSQL 16.16 with migrations 001 and 002 applied.
