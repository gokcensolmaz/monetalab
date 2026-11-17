# Slice 0 — Verification Report

**Date:** 2026-11-16
**Scope:** the pure credit allocator (`backend/src/credits/allocate.ts`) and its unit tests. No DB, API, iOS or billing code.
**Environment:** macOS (Darwin 23.5.0), Node v24.20.0, npm 11.19.0, TypeScript 7.0.2, `@types/node` 24.19.2.
**Git:** initialized, nothing committed (D-002).

## 1. Commands and results (run in `backend/`)

| Command | Exit code | Result |
|---|---|---|
| `npm run typecheck` | 0 | No errors |
| `npm run test:unit` | 0 | 19 tests, 2 suites: **19 pass, 0 fail**, 0 cancelled, 0 skipped, 0 todo |

Tests by category (D-005): **6 `[BR]`** business rules and **13 `[NEG]`** negative/edge cases. There are no `[INT]` tests yet because Slice 0 has no database.

## 2. Review of `allocate.ts` against PRD §2.4 and D-007/D-009

| Requirement | Status | Evidence |
|---|---|---|
| Priority SUBSCRIPTION → CONSUMABLE → REWARD → PROMOTIONAL | ✅ | One `BUCKET_PRIORITY` constant drives both the loop and the sum. The test `[BR][D-009]` checks the literal order. |
| One operation may debit several buckets | ✅ | The PRD example 200/300/400/1000, cost 800, gives 200+300+300+0. |
| Insufficient total blocks the **whole** operation | ✅ | The function returns before any debit is calculated. The result has no `debits` field (`[NEG][CR-02]`). |
| Insufficient result shape | ✅ | `{ ok: false, code: 'INSUFFICIENT_CREDITS', required, available }`, which matches the D-007 code. The HTTP 402 mapping is Slice 6. |
| No negative balances | ✅ | Each debit is `min(balance, outstanding)`. Negative, fractional, NaN and missing balances throw `RangeError`. |
| Cost validity | ✅ | Zero, negative, fractional, NaN, Infinity and unsafe-integer costs throw `RangeError`. |
| Input not changed | ✅ | The test runs on a frozen input. |
| Atomicity, concurrency, idempotency, immutable ledger | ⏳ Not in scope | A pure function can't guarantee these. They belong to the DB transaction and row locks in Slices 1 and 6. |

**Observations (no code change made):**
- If the *sum* of the four balances goes above `Number.MAX_SAFE_INTEGER` (about 9×10¹⁵), `available` loses precision. Real balances are far below this. Slice 1 can add a DB column bound if wanted.
- The allocator trusts the caller's `cost`. In Slice 6 the cost must come from the server-side action catalog, never from the client.

## 3. Change made during verification

The deterministic grid test (4⁴ balance combinations × 9 costs = **2,304 cases**: 1,642 sufficient, 662 insufficient) used to check only `ok === false` for insufficient cases. Now each insufficient case asserts the full result:
`{ ok: false, code: 'INSUFFICIENT_CREDITS', required: cost, available: s + c + r + p }`.
The expected `available` is the test's own sum, not a value read back from the implementation. The test also fails if the grid ever produces no insufficient cases. It was renamed `[BR][CR-01][CR-02]` to reflect what it covers now.

## 4. Mutation checks (run on a scratch copy, not the repo)

| Injected defect | Tests failing (of 19) | Grid test caught it |
|---|---|---|
| CONSUMABLE ordered before SUBSCRIPTION *(earlier run)* | 2 | Not applicable: the grid checks against the exported order. The `[BR][D-009]` and "cost covered by SUBSCRIPTION" tests caught it. |
| Insufficient check off by one *(earlier run)* | 2 | ✅ |
| `available` reported as +1 | 3 | ✅ (new assertion) |
| `required` reported as −1 | 3 | ✅ (new assertion) |
| Wrong error code string | 3 | ✅ (new assertion) |

## 5. Known limitations

- TypeScript 7.0.2 came from `npm install`, the latest at install time. It's a major version the owner didn't explicitly choose; 5.x can be pinned on request.
- There's no `.nvmrc` or other Node version pin yet. That's planned with CI in Slice 2.
- Nothing has been committed. CI hasn't run.

**Verdict:** Slice 0 meets its acceptance criteria. Ready for owner review. Slice 1 hasn't been started.
