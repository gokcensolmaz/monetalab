# Slice 2 — Local Verification (S2.3, S2.4, S2.5)

**Date:** 2026-11-17
**Branch:** `slice-2-ci` (local only: **not committed, not pushed, no PR**)
**Scope:** pin Node and Postgres, add CI test scripts with JUnit output, write the GitHub Actions workflow. No application or business logic changed, and no tests were changed.
**Environment:** macOS (Apple Silicon), Node v24.20.0, npm 11.19.0, Docker 29.9.3, Compose v5.7.0, Ruby 2.6.10 (YAML parsing), `xmllint` (libxml2, built into macOS).

## 0. Pre-check: baseline on `origin/main`

| Check | Result |
|---|---|
| `git fetch` + `git status -sb` on `main` | `## main...origin/main`, 0 modified or untracked files |
| Local `main` vs `git ls-remote origin refs/heads/main` | Both `0db5d230a4790685bd66f7b7a1f5114b9dd07483` |
| `git log origin/main` | `0db5d23` feat: … (Slices 0–1), `38d2419` docs: … baseline |

The pre-check passed, so I continued.

## 1. Changed files

| File | Change |
|---|---|
| `.nvmrc` *(new)* | `24.20.0` (D-S2-06) |
| `backend/package.json` | `engines.node`: `>=24` → `>=24.2` (because of `import.meta.main`). New scripts `test:unit:ci` and `test:integration:ci`: `mkdir -p test-results`, then `node --test` with the **spec** reporter to stdout and the **JUnit** reporter to `test-results/<suite>.junit.xml`. Dependencies unchanged. |
| `docker-compose.yml` | `postgres:16-alpine` → `postgres:16.16-alpine` (D-S2-07) |
| `.github/workflows/api-regression.yml` *(new)* | The CI workflow (section 3) |
| `docs/decisions.md` | D-S2-04 (who pushes) and D-S2-05 (commit email) marked **resolved**, as promised in the S2.2 report |
| `docs/slice-2-local-verification.md` *(new)* | This report |

Not changed: `src/**`, `tests/**`, `migrations/**`, `package-lock.json`, the PRD, `CLAUDE.md`.

## 2. Postgres pin without deleting volumes (D-015b)

| Step | Result |
|---|---|
| Volumes before | `monetalab_monetalab-db` |
| `npm run db:up` (`up -d --wait`) | Container **recreated** on the new image tag and reported **Healthy**. No `down -v`, `volume rm` or `prune` was run. |
| Image / `SHOW server_version` | `postgres:16.16-alpine` / `16.16` |
| Existing data | `schema_migrations` still contains `001_m1_foundation.sql`, so the volume data was kept |
| Volumes after | `monetalab_monetalab-db` (same volume) |

## 3. Workflow summary (`.github/workflows/api-regression.yml`)

- **Triggers:** `pull_request` → `main`, `push` → `main`, `workflow_dispatch`. No `paths` filter, and no `pull_request_target`.
- **Permissions:** `contents: read` only, at the top level, with no job-level escalation. Checkout uses `persist-credentials: false`. No `secrets.*` references.
- **Concurrency:** grouped per ref, with `cancel-in-progress`.
- **Shell:** `defaults.run.shell: bash`, so `-eo pipefail` applies. Working directory is `backend`.
- **Job `api-db-regression`:** `ubuntu-24.04`, 15 min timeout, job-level `DATABASE_URL` set to the non-secret local/CI value (D-012).
- **Service:** `postgres:16.16-alpine` on `55432:5432`, gated by a `pg_isready` health check.
- **Official actions pinned by full SHA.** I resolved each tag to its commit with `git ls-remote` against the action's GitHub repo, peeling annotated tags:

| Action | Tag | Commit SHA |
|---|---|---|
| `actions/checkout` | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node` | v7.1.0 | `949feb2413d6458794dcd2491c4babbbce0c15c1` |
| `actions/upload-artifact` | v7.0.2 | `cf430e030ddbb5b0abf93d22962f4752f3646cd9` |

- **Steps:**
  1. Checkout
  2. Set up Node (`.nvmrc`, npm cache)
  3. `npm ci`
  4. Record the Node, npm and Postgres versions
  5. `npm run typecheck`
  6. `npm run db:migrate` (`id: migrate`)
  7. `mkdir -p test-results && npm run test:unit:ci | tee test-results/unit.log`
  8. The same for integration. This step has `if: !cancelled() && steps.migrate.outcome == 'success'`, so a unit failure doesn't hide integration results.
  9. Job summary, with the `ℹ` count lines from both logs (`if: !cancelled()`)
  10. Upload the artifact `test-results-attempt-<n>` from `backend/test-results/`, with `if-no-files-found: warn` and 14-day retention (`if: !cancelled()`)

## 4. Local results

### 4.1 Real project (`backend/`, dev DB on 16.16)
| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | No errors |
| `npm run db:migrate` | 0 | `No pending migrations.` (already applied to the dev DB) |
| `npm run test:unit:ci` (after `rm -rf test-results`) | 0 | **19 pass, 0 fail**. Directory created and JUnit written. |
| `npm run test:integration:ci` | 0 | **32 pass, 0 fail** |
| `npm test` (existing scripts) | 0 | 19/19 and 32/32 |
| Leftover `monetalab_test_*` or simulation databases | — | 0 |

### 4.2 JUnit XML validation (D-015c, local part)
| File | `xmllint --noout` | Root | `count(//testcase)` | failures |
|---|---|---|---|---|
| `unit.junit.xml` | well-formed | `testsuites` | **19** | 0 |
| `integration.junit.xml` | well-formed | `testsuites` | **32** | 0 |

### 4.3 Simulated fresh CI checkout (workflow steps taken from the YAML itself)
A copy of all tracked and new files, **without `node_modules`**, was placed in the session scratch directory. Every `run:` step was **extracted from `api-regression.yml` with Ruby's YAML parser** and run with `bash --noprofile --norc -eo pipefail`. They ran against a **new, empty database** on the 16.16 server, which was dropped afterwards. `GITHUB_STEP_SUMMARY` pointed at a local file.

| Step | Positive run | Negative run (1 assertion deliberately broken in the copy) |
|---|---|---|
| `npm ci` | exit 0 (66 packages from the lockfile) | exit 0 |
| Record versions | `node v24.20.0, npm 11.19.0`, `postgres 16.16` | same |
| Typecheck | exit 0 | exit 0 |
| Migrate (fresh DB) | exit 0, `Applied: 001_m1_foundation.sql` | exit 0 |
| Unit tests | exit 0, 19/19 | **exit 1**: the failure propagated through `tee` |
| Integration tests | exit 0, 32/32 | exit 0, still ran as designed |
| Job summary | 19 pass / 32 pass | `pass 18`, **`fail 1`**, and 32 pass |
| JUnit | 19 and 32 testcases, 0 failures | unit: **1 `<failure>`** on `[BR][D-009] bucket priority …` |
| Artifact dir | `unit.junit.xml`, `unit.log`, `integration.junit.xml`, `integration.log` | same |

The scratch copies were deleted afterwards.

### 4.4 Workflow YAML validation
| Check | Result |
|---|---|
| `YAML.safe_load` (Ruby 2.6) | Parses |
| 18 structural policy checks (Node script over the parsed YAML) | **18/18 pass**: PR trigger on `main`, no `pull_request_target`, no path filter, `contents: read` only, no job-level permissions, job name, runner, Postgres image and port, 3 official actions all pinned to 40-char SHAs, no `secrets.*`, `persist-credentials: false`, all required commands present, `mkdir -p test-results` before `tee`, artifact uploads also on failure |
| `actionlint` | **NOT RUN.** D-S2-14 (run it via a Docker image) is still open. The real GitHub run in S2.6 is the authoritative check. |

## 5. Issue found and fixed during this work
- **Symptom:** the first version of the CI scripts used three `node --test` reporters (spec to stdout, spec to a log file, JUnit to a file). Every run printed a `MaxListenersExceededWarning` to stderr. The tests still passed.
- **Diagnosis:** I compared reporter combinations. With 3 reporters the warning appeared in 5 of 5 runs; with 2 reporters it never appeared, in any combination tried. It's a Node test-runner warning, not a test or application problem.
- **Fix:** the scripts now use 2 reporters (spec to stdout, JUnit to file). The workflow writes the human-readable log with `tee` under `pipefail`, after `mkdir -p test-results`. Re-verified: 0 warnings, and failures still propagate (4.3, negative run).

## 6. Open items and limitations
1. **GitHub Actions has not run.** Every result above is local. The real run, its job summary, and **downloading the artifact and validating its JUnit files** (D-015c) are S2.6, which needs commit and push approval.
2. **`actionlint`: NOT RUN** (D-S2-14 open).
3. **The JUnit XML includes the runner hostname and absolute file paths.** In CI those will be GitHub runner values. On a public repo, artifacts can be downloaded by signed-in GitHub users. No secrets are involved. Local `test-results/` stays git-ignored.
4. **The action SHAs were resolved today from the official repositories.** A Dependabot or update policy for them isn't set up, and is out of scope.
5. **Branch protection** (S2.8) can only be set up after the first CI run reports `api-db-regression`.
6. **Recreating the DB container** on the pinned tag kept the data. Anyone with an older local volume does the same with `npm run db:up`; no volume reset is needed.

**Status:** S2.3–S2.5 are implemented and verified locally. Waiting for review and for approval to commit and push `slice-2-ci` (S2.6).
