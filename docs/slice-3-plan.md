# Slice 3 — Authentication (AUTH-01) Plan

**Status:** **Approved with amendments on 2026-11-17** (D-016, D-017). Decisions D-S3-01 to D-S3-09 are approved. Implementation proceeds one step at a time, each with its own approval. Step 3.1 is authorized.
**Date:** 2026-11-17

## 0. Owner amendments (2026-11-17, D-017). These override anything below that conflicts.

1. **The harness owns its server, on a dynamic port.** Instead of the fixed port 3917, the harness spawns `node src/server.ts` with `PORT=0`, so the OS assigns a free port. `server.ts` prints the **actual bound address** from `app.server.address()`. The harness reads it **from its own child process's stdout**, and only then:
   - sets the base URL
   - checks that the child is still alive (`exitCode === null`) and that `/health` answers 200 on that port
   - fails clearly if the child exits or prints no address within a timeout

   It never connects to a port it didn't receive from its own child. `API_TEST_PORT` is removed. Base URL and DB URL go to the workers through environment variables set in `globalSetup`.
2. **Test-owned DB mutations only.** Every direct DB write in API tests goes through a helper that requires the **user ID or session ID created by that test**, and every `UPDATE` has a `WHERE` on that ID. No unscoped `UPDATE` or `DELETE`, and no `TRUNCATE`. Reviews check this with a grep before each step is accepted.
3. **Extra negative and boundary specs** (added to §6.2 as specs 15–19):
   - **15 Malformed tokens:** 42- and 44-char tokens, `+` `/` `=` characters, a non-canonical last base64url character, leading or trailing whitespace, two tokens, a tab separator, a bearer scheme with no token. All return 401 `UNAUTHENTICATED`. The scheme name is matched case-insensitively (RFC 7235).
   - **16 Oversized request bodies:** bodies over 16 KB on register and login return **413** `{ "error": { "code": "PAYLOAD_TOO_LARGE" } }` and create no user or session. Passwords of exactly 128 and 129 characters test the policy boundary separately (400).
   - **17 Logout with an expired session** returns 401, and `revoked_at` stays `NULL` (an expired token can't change state).
   - **18 Concurrent sessions:** 10 parallel logins for one user give 10 distinct tokens, all valid on `/me`. Revoking one leaves the other 9 valid.
   - **19 Concurrent logout of one token:** exactly **one** 204, and the rest 401. Implemented as `UPDATE … WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() RETURNING id`.
4. **No scope beyond AUTH-01.** Wallet and history (Slice 4), purchases and spending stay out of Slice 3.
**Inputs read:** `CLAUDE.md`, `product-requirements.md` (§1 M1 "Create account, sign in/out, identify the current user", §5 AUTH-01, §6), `docs/decisions.md`, `docs/slice-2-verification.md`, `backend/migrations/001_m1_foundation.sql`, `backend/src/{app,server,config}.ts`
**Acceptance target:** **AUTH-01**, "New account / login → secure user-specific …". The **wallet and history** part of AUTH-01 belongs to **Slice 4**. Slice 3 delivers identity, sessions and isolation of identity only.

## 1. Current state

| Area | Finding |
|---|---|
| `users` | `id uuid`, `email text` (3–320 chars), **unique on `lower(email)`**, `password_hash text NOT NULL`, `created_at`. An `AFTER INSERT` trigger creates the 4 zero bucket rows. |
| `sessions` | `token_hash bytea` (**exactly 32 bytes**, unique), `user_id`, `created_at`, **`expires_at NOT NULL`**, `revoked_at` nullable, `CHECK (expires_at > created_at)`, index on `user_id`. |
| Fastify app | `buildApp({ pool })` with only `GET /health`. `logger: false`. No auth, no request schemas, no error contract. |
| `server.ts` | Listens on `127.0.0.1:${PORT ?? 3000}`. **No graceful shutdown** (SIGTERM doesn't close the pool). |
| Tests | 19 unit + 32 integration (`node:test`). **Playwright isn't installed yet** (D-001 approved it; D-010 assigns it to HTTP tests from Slice 3). |
| CI | `api-db-regression` runs typecheck, migrate, unit and integration tests. It's a required check on `main`. |

**Fit:** the existing schema already supports everything in this plan (sha256 token hashes = 32 bytes, required expiry, revocation, case-insensitive email uniqueness). **A migration is only needed for the optional hardening in §4.3.**

## 2. Scope

**In:** register, login, authenticated `GET /me`, logout (revoke the current session), scrypt password hashing, sha256 token hashing, absolute session expiry, a reusable auth guard, a uniform error contract, isolation of identity across users, Playwright HTTP API tests, CI integration.

**Out (not M1, or a later slice):**
- password reset or change
- email verification
- refresh tokens or sliding sessions
- "log out everywhere"
- account deletion (PRD open decision #7)
- Sign in with Apple, OAuth
- rate limiting / lockout (see §4.4)
- roles and admin
- wallet and history endpoints (Slice 4)
- iOS (Slice 7)

## 3. Proposed minimal API contract

All bodies are JSON. **Every error uses one shape**, which later slices reuse (for example `402 INSUFFICIENT_CREDITS`, D-007):
```json
{ "error": { "code": "SOME_CODE", "message": "Human-readable, no secrets" } }
```

| Method & path | Auth | Request | Success | Errors |
|---|---|---|---|---|
| `POST /auth/register` | none | `{ "email": string, "password": string }` | **201** `{ "user": { "id", "email", "createdAt" } }` | 400 `VALIDATION_ERROR`; **409 `EMAIL_ALREADY_REGISTERED`** |
| `POST /auth/login` | none | `{ "email", "password" }` | **200** `{ "token": string, "expiresAt": ISO-8601, "user": {…} }` | 400 `VALIDATION_ERROR`; **401 `INVALID_CREDENTIALS`**, with an identical body for an unknown email and a wrong password |
| `GET /me` | Bearer | — | **200** `{ "user": { "id", "email", "createdAt" } }` | **401 `UNAUTHENTICATED`** (missing, malformed, unknown, expired or revoked token: one code, no detail) |
| `POST /auth/logout` | Bearer | — | **204** (current session revoked) | 401 `UNAUTHENTICATED` (including a second logout with the same token) |

- The token goes in `Authorization: Bearer <token>`. Auth responses carry `Cache-Control: no-store`. 401s carry `WWW-Authenticate: Bearer`.
- `password_hash`, `token_hash` and session IDs are **never** returned.
- Request schemas use `additionalProperties: false`. Body limit is **16 KB** on these routes.
- **Proposal (D-S3-02):** register does **not** log in automatically. There's a single place that issues tokens (login), and the iOS app calls login after register.
- No `/v1` prefix in M1, to keep it simple. That's open to change if you want versioned paths now.

## 4. Security design

### 4.1 Passwords
- `crypto.scrypt` (Node built-in, **no new runtime dependency**) with **N=2^15, r=8, p=1**, 16-byte random salt, 64-byte key, `maxmem` 64 MB.
- Stored as a self-describing string: `scrypt$32768$8$1$<salt-b64url>$<key-b64url>`. Parameters can be upgraded later without a migration.
- Verified with `crypto.timingSafeEqual`. A malformed stored hash fails closed (returns false, never throws to the client).
- **Unknown email at login still runs one scrypt** against a fixed dummy hash, so response time doesn't reveal which emails exist.
- Rationale: OWASP suggests higher N (2^17). 2^15 keeps CI and concurrency tests fast for a fixture. **Owner decision D-S3-04.**

### 4.2 Session tokens
- 32 random bytes (`crypto.randomBytes`), sent as base64url (43 chars). Only `sha256(token)` (32 bytes, which matches the existing CHECK) is stored. Lookup is by the unique index.
- A token is valid only when `revoked_at IS NULL AND expires_at > now()`, **evaluated with the database clock** (one authoritative clock that tests can control).
- **Absolute expiry, proposed 7 days (D-S3-01)**, set at login. No sliding renewal.
- Logout sets `revoked_at = now()` on **the current session only**. Rows are never deleted, which keeps an audit trail.

### 4.3 Input rules and email handling
- **Email:** trimmed and **stored lowercased**. A basic format check (one `@`, non-empty local part and domain), max 320 chars.
- **Password:** **8–128 characters**, no composition rules (in line with NIST 800-63B). The upper bound limits CPU abuse via scrypt.
- *Optional hardening (D-S3-05):* migration `002_users_email_normalized.sql` adds `CHECK (email = lower(btrim(email)))`, so the DB enforces normalization too. That's a new migration, never an edit to `001`. It's safe on existing data only if every existing row is already normalized (dev DBs hold only test rows; CI starts fresh).

### 4.4 Other safeguards and accepted gaps
- Map Postgres `23505` on `users_email_lower_uq` to **409**, never 500. That covers concurrent duplicate registrations.
- `logger: false` stays. If logging is ever enabled, it must redact `authorization` and `password`.
- **Accepted for M1, documented, not implemented:**
  1. no rate limiting or brute-force lockout (it would need `@fastify/rate-limit` or custom state, which is scope beyond M1)
  2. `409` on register reveals that an email exists (inherent to the approved contract; low risk for a fixture)
  3. HTTP only, on localhost (no TLS locally; iOS ATS handling belongs to Slice 7)
  4. expired or revoked session rows aren't cleaned up

## 5. Code layout (small, no framework)

| File | Responsibility |
|---|---|
| `src/auth/password.ts` | `hashPassword`, `verifyPassword` (pure crypto, unit-tested) |
| `src/auth/tokens.ts` | `newSessionToken` → `{ token, tokenHash }`, `hashToken` |
| `src/auth/routes.ts` | Register, login, logout, `/me` route handlers and JSON schemas |
| `src/auth/require-auth.ts` | `preHandler` that resolves the bearer token to `request.user` or sends 401. **Reused by Slices 4–6.** |
| `src/http/errors.ts` | `sendError(reply, status, code, message)`, plus a Fastify error handler that maps schema validation to `400 VALIDATION_ERROR` and anything unexpected to `500 INTERNAL_ERROR` with no detail |
| `src/app.ts` | Register the routes. `/health` unchanged. |
| `src/server.ts` | **Graceful shutdown** on SIGTERM/SIGINT (`app.close()` and `pool.end()`), needed by the test harness. Optional `HOST` env. |

## 6. Test design

### 6.1 Unit tests (`node:test`, `tests/unit/`)
| Test | Category |
|---|---|
| hash then verify the correct password → true | [BR] |
| wrong password → false; same password hashed twice → different strings (unique salts) | [NEG]/[BR] |
| malformed or truncated stored hash → false, no throw | [NEG] |
| token: 43-char base64url; `hashToken` is 32 bytes and deterministic; two tokens differ | [BR] |

### 6.2 Playwright HTTP API tests (`tests/api/*.spec.ts`)

**Harness (black-box, isolated, no backdoors):**
- `globalSetup`:
  1. creates a fresh throwaway DB `monetalab_api_test_<random>` (same approach as D-011)
  2. runs migrations
  3. **spawns the real server** (`node src/server.ts`) with that `DATABASE_URL` and **`PORT=0`**, then reads the bound port from the child's stdout (amendment §0.1)
  4. waits for `/health` = 200
  5. exports `API_TEST_DATABASE_URL` for the workers
- Teardown stops the server (SIGTERM) and drops the DB.
- Tests create users with unique `@test.invalid` emails, so they're safe in parallel workers.
- **Direct DB access is used only for assertions and for test-controlled time** (for example, moving a session's `created_at` and `expires_at` into the past). **No HTTP test endpoints.**
- `playwright.config.ts`:
  - `baseURL` comes from the environment variable set by `globalSetup` after it reads the child's bound port
  - **`outputDir: test-results/playwright-artifacts`**: Playwright *empties* its output dir at startup, and the default (`test-results/`) would delete the unit and integration JUnit files in CI
  - reporters: list (stdout), JUnit (`test-results/api.junit.xml`), HTML (`test-results/playwright-report`, `open: 'never'`)
- **No browsers needed.** API tests use Playwright's `request` fixture only, so `npx playwright install` isn't run (to be confirmed during step 3.2).

**Specs (AUTH-01 unless noted):**

| # | Test | Cat. | Key assertions |
|---|---|---|---|
| 1 | Register → login → `/me` → logout → `/me` | [BR] | 201, 200 + token, `/me` id/email equal the registered user, 204, then 401 |
| 2 | Register creates user state correctly | [INT] | DB: email stored lowercased; `password_hash` starts with `scrypt$` and doesn't contain the password; **4 zero bucket rows** |
| 3 | Login creates a hashed session with the configured TTL | [INT] | DB: `token_hash = sha256(token)`; raw token appears nowhere in `sessions`; `expires_at − created_at` = TTL (± 5 s) |
| 4 | Responses never leak secrets | [NEG] | No `password`, `password_hash`, `token_hash` or session ID in any register/login/me body |
| 5 | Duplicate email, including a case/whitespace variant | [NEG] | 409 `EMAIL_ALREADY_REGISTERED`; still exactly 1 user row |
| 6 | 10 concurrent registrations, same email | [NEG] | Exactly 1×201 and 9×409, **no 5xx**; 1 user row |
| 7 | Wrong password vs unknown email | [NEG] | Both 401, **byte-identical bodies** `INVALID_CREDENTIALS`; no session row created |
| 8 | Validation: missing fields, bad email, 7-char and 129-char passwords, extra properties, non-JSON body | [NEG] | 400 `VALIDATION_ERROR`; no user row |
| 9 | `/me` with no header, a `Basic` scheme, an empty bearer, a random 43-char token | [NEG] | 401 `UNAUTHENTICATED` + `WWW-Authenticate: Bearer` |
| 10 | Revoked token | [NEG] | After logout: `/me` 401 and a second logout 401; DB `revoked_at` set, row kept |
| 11 | Logout revokes only the current session | [NEG] | User logs in twice (A, B); logout A → A 401, **B still 200** |
| 12 | Expired session | [NEG] | DB sets the session to the past → `/me` 401 |
| 13 | Identity isolation between users | [NEG] | Users X and Y: each token's `/me` returns only its own id and email; X's token never resolves to Y |
| 14 | Auth responses aren't cacheable | [NEG] | `Cache-Control: no-store` on login and `/me` |

The expected values come from the test's own inputs and independent calculations (sha256 computed in the test, TTL constant from the approved decision), not from echoing server output (PRD §6).

### 6.3 Scripts and CI
- `test:api` (`playwright test`) and `test:api:ci` (`mkdir -p test-results`, plus the JUnit and HTML reporters above).
- `api-regression.yml`: one new step **"API tests (Playwright)"** after the integration tests, with the same `!cancelled() && migrate success` condition. Its log is `tee`'d, it's added to the job summary, and the artifact automatically picks up `api.junit.xml` and `playwright-report/` from `backend/test-results/`.
- **The required check name `api-db-regression` stays the same,** so branch protection keeps working.

## 7. Implementation steps (one PR on branch `slice-3-auth`)

| Step | Change | Verification |
|---|---|---|
| **3.1** | `password.ts`, `tokens.ts` + unit tests | `npm run typecheck`, `npm run test:unit` (19 + new) |
| **3.2** ✅ *local, see `docs/slice-3-2-verification.md`* | **Install `@playwright/test` (exact pin, dev only)**, `playwright.config.ts`, global setup/teardown, graceful shutdown in `server.ts`, one smoke spec (`GET /health` = 200), `test:api` / `test:api:ci`. As built: harness in `tests/api/support/` (`disposable-db.ts`, `server-harness.ts`, `global-setup.ts`, `fixtures.ts`); harness behavior tests in `tests/integration/api-harness.test.ts`. | `npm run test:api` passes. No leftover `monetalab_api_test_*` DB or server process. Unit and integration JUnit files survive a Playwright run. |
| **3.3** | `errors.ts` + `POST /auth/register` (+ optional migration 002) | Specs 2, 4 (register part), 5, 6, 8. Existing tests still green. |
| **3.4** | `POST /auth/login` + session issuance | Specs 3, 7, 4 (login part) |
| **3.5** | `require-auth.ts` + `GET /me` | Specs 9, 12, 13, 14 |
| **3.6** | `POST /auth/logout` | Specs 1, 10, 11 |
| **3.7** | CI step + summary + artifact | Local simulation as in Slice 2. Then a real PR run (**[API]**: conclusion and steps; **[OWNER]**: artifact contents). |
| **3.8** | `docs/slice-3-verification.md` | Commands, results, NOT RUN / NOT VERIFIED where applicable |

Each step ends with typecheck plus all suites green locally. Commit, push and PR only with explicit approval (D-002).

## 8. Definition of Done (Slice 3)
1. The four endpoints follow the §3 contract exactly. No secret material appears in responses.
2. Passwords use scrypt with a per-user salt. Tokens are random, stored only as sha256, and expire and revoke as designed (§4).
3. Unit tests from §6.1 and Playwright specs 1–14 pass locally and in CI. Unit and integration counts don't drop.
4. No HTTP test or fixture endpoints exist. The only test-time DB writes are direct, in test code, against a throwaway DB.
5. The CI job `api-db-regression` stays the required check and now includes the API tests, with JUnit + HTML report in the artifact.
6. The verification doc labels evidence [LOCAL] / [API] / [OWNER] / NOT VERIFIED.

## 9. Risks and blockers

| # | Item | Type | Mitigation |
|---|---|---|---|
| B1 | **Adding `@playwright/test`** (a new dev dependency) needs explicit approval for this slice | Approval | D-S3-08. Exact version pinned; no browser downloads. |
| R1 | Playwright empties its `outputDir`, which could delete earlier JUnit files in CI | CI | `outputDir: test-results/playwright-artifacts`. Verified in step 3.2. |
| R2 | Playwright's TS loader vs the `.ts`-extension imports used in this repo | Tooling | Specs import only helpers and `pg`; the server runs as a real child process. Checked in step 3.2. |
| R3 | A port clash, or connecting to a server the harness didn't start | Env | **Resolved by amendment §0.1:** `PORT=0`, the port is read from the harness's own child, and the harness checks the child is alive plus `/health` |
| R4 | scrypt cost slows tests or causes timeouts under parallel workers | Perf | N=2^15 (about 30–60 ms per hash). Measure in step 3.3. |
| R5 | Optional migration 002 fails on non-normalized existing rows | Data | Only test rows exist. Check before applying (`SELECT … WHERE email <> lower(btrim(email))`). |
| R6 | GitHub artifact and logs can't be inspected without auth | Evidence | Mark as [OWNER] / NOT VERIFIED, as in Slice 2 |
| — | No other blockers. The Docker DB, CI and branch protection are already in place. | | |

## 10. Decisions requiring owner approval

| ID | Decision | Recommendation |
|---|---|---|
| D-S3-01 | Session lifetime | **7 days absolute**, no sliding renewal |
| D-S3-02 | Register auto-login? | **No.** Register returns 201 with the user; login issues tokens. |
| D-S3-03 | Password policy | **8–128 chars**, no composition rules |
| D-S3-04 | scrypt parameters | **N=2^15, r=8, p=1**, 16 B salt, 64 B key, self-describing hash string |
| D-S3-05 | Email normalization | **Trim + lowercase on write.** Optional migration `002` CHECK: recommended. |
| D-S3-06 | Route paths and error shape | `/auth/register`, `/auth/login`, `/auth/logout`, `/me`, with `{ error: { code, message } }`. No `/v1`. |
| D-S3-07 | Logout semantics | Revoke the **current** session only; a repeat logout returns 401 |
| D-S3-08 | Add `@playwright/test` (dev, exact pin) and Playwright reports in the CI artifact | **Approve** (already in the D-001 stack) |
| D-S3-09 | Accepted M1 gaps: no rate limiting/lockout, 409 reveals registered emails, HTTP on localhost, no session cleanup | **Accept and document** |
| — | Open from Slice 2: D-S2-12 (negative-demo PR), D-S2-13 (README stub), D-S2-14 (`actionlint`) | Still open. Not needed for Slice 3. |
