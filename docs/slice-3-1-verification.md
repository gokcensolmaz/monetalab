# Slice 3.1 — Verification (password and token primitives)

**Date:** 2026-11-17
**Branch:** `slice-3-auth`, created from `main` @ `0d46331` (in sync with `origin/main`). **Not committed or pushed. No PR.**
**Scope:** `src/auth/password.ts` and `src/auth/tokens.ts`, plus unit tests. **No** HTTP routes, Playwright, migrations, CI workflow changes or business-logic changes.
**Decisions applied:** D-S3-03 (8–128 characters), D-S3-04 (scrypt N=2^15, r=8, p=1, 16 B salt, 64 B key, self-describing format), slice 3 plan §4.2 (32-byte CSPRNG tokens, SHA-256 at rest).

## 1. Pre-checks
| Check | Result |
|---|---|
| `git fetch`; local `main` vs `origin/main` | Both `0d46331` (PR #1 merge commit) |
| Uncommitted changes before branching | Only Claude's own uncommitted docs from the previous step (`docs/slice-2-verification.md` post-merge section, `docs/slice-3-plan.md`). Not at risk: `git switch -c` carries them onto the branch, and nothing was overwritten. |
| `git switch -c slice-3-auth` | OK |

## 2. Changed files
| File | Change |
|---|---|
| `backend/src/auth/password.ts` *(new)* | `hashPassword`, `verifyPassword`, `isPasswordWithinPolicy`, `PASSWORD_MIN_LENGTH`/`MAX_LENGTH` |
| `backend/src/auth/tokens.ts` *(new)* | `newSessionToken`, `hashToken`, `isWellFormedToken`, size constants |
| `backend/tests/unit/password.test.ts` *(new)* | 19 tests |
| `backend/tests/unit/tokens.test.ts` *(new)* | 25 tests |
| `docs/decisions.md` | D-016 (Slice 3 plan approved), D-017 (owner amendments), and the table of approved **D-S3-01 to D-S3-09**. D-S3-09 is explicitly limited to the local M1 QA fixture. |
| `docs/slice-3-plan.md` *(new on this branch)* | Status set to approved. New **§0 Owner amendments**: owned server on a dynamic port (`PORT=0`, port read from the harness's own child), test-scoped DB mutations, new specs 15–19 (malformed tokens, 413 oversized bodies, logout with an expired session, concurrent sessions, concurrent logout), no scope beyond AUTH-01. Port-3917 references replaced. |
| `docs/slice-2-verification.md` | Post-merge section §6a from the previous task (still uncommitted) |
| `docs/slice-3-1-verification.md` *(new)* | This report |

`package.json`, `package-lock.json`, migrations, `app.ts`, `server.ts` and the workflow are **unchanged**. No dependency was installed.

## 3. Design summary
- **`hashPassword(password)`:**
  - rejects non-strings and lengths outside 8–128 **code points** with a `RangeError` whose message never includes the password
  - salt from `crypto.randomBytes(16)`
  - async `crypto.scrypt` with an explicit `maxmem`
  - output `scrypt$32768$8$1$<22-char salt>$<86-char key>`
- **`verifyPassword(candidate, stored)`:** returns a boolean and **never throws**.
  - It **fails closed** on: non-string inputs, out-of-policy candidates, wrong part count or scheme, non-canonical integers, N not a power of two or outside 2^14..2^17, r > 16, p > 4, memory above 256 MB, salt or key not strict canonical base64url of exactly 16 and 64 bytes, stored strings over 512 chars, and any internal scrypt error.
  - Keys are compared with `timingSafeEqual`.
  - Stored parameters inside those bounds still verify, so the cost can be raised later.
- **Tokens:**
  - 32 bytes from `crypto.randomBytes`, sent as canonical base64url (43 chars).
  - `hashToken` = SHA-256 → 32 bytes, matching `sessions.token_hash`.
  - `isWellFormedToken` requires the exact pattern **and** a canonical round-trip.
  - `hashToken` throws `TypeError('malformed session token')` (no echo of the input) rather than hashing malformed input.
- Neither module has any `console`, logger or `Math.random` call. `grep` over `src/auth` and `src` found none, and a test spies on `console.*`.

## 4. Commands and results (run in `backend/`)
| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | No errors |
| `npm run test:unit` | 0 | **63 tests, 8 suites: 63 pass, 0 fail**, 0 cancelled/skipped/todo, about 2.0 s |
| — per file | | `allocate` 19/19 (unchanged), `password` **19/19**, `tokens` **25/25** |
| `npm run test:integration` (Docker `postgres:16.16-alpine`, healthy) | 0 | **32 tests, 5 suites: 32 pass, 0 fail** (unchanged) |
| `npm run test:unit:ci` | 0 | `unit.junit.xml` well-formed, **63** testcases, 0 failures |
| Leftover `monetalab_test_*` DBs | — | 0 |

### New test coverage (44 tests)
| Area | Tests |
|---|---|
| Password business rules `[BR]` | Format and approved parameters; **stored key equals an independent `scryptSync` re-derivation**; correct password verifies; unique salts (two hashes differ, salts differ, both verify); hash doesn't contain the password (raw or base64url); a hash made with other in-bounds parameters verifies (upgrade path); Unicode round-trip |
| Failed verification `[NEG]` | Case change, one character, prefix, suffix; out-of-policy or non-string candidates (`''`, short, 129 chars, null, undefined, number, object); tampered key; tampered salt |
| Malformed stored hashes `[NEG]` | 13 structural cases (non-strings, Buffer, empty, garbage, `$$$$$`, missing or extra part, wrong or upper-case scheme, over 512 chars); 11 parameter cases (non-numeric, decimal, negative, leading zero, not a power of two, below or above bounds, r/p zero or too large), **rejected within 1 s in total, so no huge scrypt work**; 9 encoding cases (salt or key too short or long, `+/`, padding, **non-canonical** last char, illegal char, empty); **a forced internal scrypt error returns false** |
| Policy boundaries `[NEG]` | 7 ✗ / 8 ✓ / 128 ✓ / 129 ✗ for both the policy check and `hashPassword`; **emoji counted as characters** (7 ✗, 8 ✓, 128 ✓, 129 ✗); non-string rejected; error message doesn't include the password; **no console output** during hash, verify and failures |
| Token business rules `[BR]` | 43-char base64url → 32 bytes; hash equals an independent SHA-256, 32 bytes; deterministic; hash doesn't contain the token; 10,000 tokens and hashes all distinct; all 64 base64url characters appear (sanity check against a patterned generator) |
| Malformed tokens `[NEG]` | 15 rejected inputs (empty, 42 and 44 chars, `+`, `/`, `=`, leading space, trailing newline, **non-canonical last char**, non-ASCII, `Bearer ` prefix included, null, undefined, number, Buffer); proof that the non-canonical token decodes to the same bytes; `hashToken` throws for all 15; error doesn't echo the input; a one-char change gives a different hash |

### Mutation checks (scratch copy of `src/auth`, not the repo)
| Injected defect | Result |
|---|---|
| `verifyPassword` always returns true | Caught (2 tests) |
| Constant all-zero salt | Caught (unique-salts test) |
| Weaker cost N=2^14 | Caught (3 tests) |
| Lenient, non-canonical base64url accepted | Caught |
| Length counted in UTF-16 units, not characters | Caught |
| Token hash uses SHA-512 instead of SHA-256 | Caught |
| Token canonical-encoding check removed | Caught (2 tests) |
| **`verifyPassword` throws instead of failing closed** | **Initially survived.** No test reached the catch branch. **Fixed** by adding the forced-scrypt-error test (`mock.method` + `syncBuiltinESMExports`). Re-run: caught. |

## 5. Remaining risks and notes
1. **No Unicode normalization.** A password typed as composed vs decomposed characters (for example `é` as U+00E9 vs `e`+U+0301) hashes differently. The iOS app normally sends NFC, but this isn't enforced. Changing it would be a policy addition (NFC or NFKC before hashing). **Raised for the owner; not implemented** (no scope beyond the approved decisions).
2. **The scrypt cost N=2^15 is below the OWASP recommendation of 2^17.** Accepted by D-S3-04 for the fixture. The self-describing format allows raising it later without a migration.
3. **Timing equalization for unknown emails** (a dummy scrypt) belongs to the login route (step 3.4) and isn't in this step.
4. **scrypt runs on libuv's thread pool** (4 threads by default). Heavy concurrent logins in step 3.4/3.6 tests may queue. Durations will be measured there.
5. **These modules aren't used by any route yet.** Integration with the DB and HTTP starts in step 3.3. The CI workflow is unchanged but runs the new unit tests automatically through `test:unit:ci` (63 testcases confirmed locally). The GitHub run happens only after an approved push.
6. **Not committed or pushed.** CI hasn't run for these changes.

**Status:** Slice 3.1 is complete locally and waiting for QA review. Step 3.2 (Playwright harness) hasn't been started.
