# Slice 2 — GitHub Repository & CI Plan

**Status:** PLANNING ONLY. Awaiting owner approval. Nothing in this document is implemented yet.
**Date:** 2026-11-17
**Inputs read:** `CLAUDE.md`, `product-requirements.md` (§1 M1, §5 CI-01, §6, §8), `docs/decisions.md`, `docs/initial-implementation-plan.md`, `docs/slice-1-verification.md`
**Acceptance target:** PRD **CI-01**: an open PR runs a deterministic API/DB regression and produces a report in GitHub Actions.

> **Scope note: "CI/CD".** M1 excludes real deployed infrastructure (`CLAUDE.md`, PRD §1), so Slice 2 is **CI only**. There's no deployment, release, container publishing or environment promotion. The iOS CI job belongs to Slice 7.

---

## 1. Current state (inspected 2026-11-17)

| Item | Finding |
|---|---|
| Git | Repo initialized on `main`, **no commits**, everything untracked. No remote. |
| Git identity | `user.name` and `user.email` are set. The email will appear publicly in commit metadata (see D-S2-05). |
| Files to be committed | 24 files: root docs, `prompts/`, `docs/` (4 files), `docker-compose.yml`, `backend/` (src, tests, migrations, `package.json`, `package-lock.json`, `tsconfig.json`). |
| Ignored correctly | `backend/node_modules/` and five `.DS_Store` files. |
| Secret scan | No secrets. The only credential is the documented local-only `monetalab_local_only` default in `docker-compose.yml`. |
| `backend/package.json` scripts | `typecheck`, `db:up`, `db:down`, `db:migrate`, `start`, `test:unit`, `test:integration`, `test`. **There's no CI or reporter script yet.** |
| Versions | Local Node **24.20.0** (`engines: >=24`), npm 11.19.0. Dependencies pinned exactly: `fastify 5.12.8`, `pg 8.23.1`, `typescript 7.0.2`, `@types/node 24.19.2`, `@types/pg 8.23.1`. Lockfile v3. |
| TypeScript 7 native binaries | The lockfile contains the optional `@typescript/typescript-linux-x64@7.0.2` entry, so `npm ci` on `ubuntu` should resolve the compiler. This must still be confirmed in the first real run. |
| Postgres | Compose uses the **floating** tag `postgres:16-alpine`. The running server is **16.16**. |
| Missing files | No `.nvmrc`, `.github/`, or `README.md`. |
| Tools | `gh` CLI **not installed**. `actionlint` not installed. Docker is available (with `~/.docker/bin` added to PATH). |

### `.gitignore` gaps to fix **before the first push**
Currently covered: `node_modules/`, `npm-debug.log*`, `playwright-report/`, `test-results/`, `coverage/`, `.env`/`.env.*` (with `!.env.example`), `.DS_Store`, `DerivedData/`, `xcuserdata/`, `*.xcuserstate`.

Proposed additions:
- **Apple signing material** (`CLAUDE.md` rule 8, needed before Slice 7): `*.p8`, `*.p12`, `*.cer`, `*.mobileprovision`, `*.provisionprofile`
- **Generic key material:** `*.pem`, `*.key`
- **Logs and test output:** `*.log`, `blob-report/`, `playwright/.cache/`
- **Personal Claude Code settings:** `.claude/settings.local.json`

`test-results/` is already ignored, which suits the JUnit output proposed below.

---

## 2. Proposed CI architecture

```
PR → main ──► GitHub Actions: workflow "API/DB regression"
              job: api-db-regression (ubuntu-24.04, 15 min timeout)
              ├─ service: postgres:16.16-alpine  (health-checked, 127.0.0.1:55432)
              ├─ checkout → setup-node (.nvmrc = 24.20.0, npm cache)
              ├─ npm ci → typecheck → db:migrate (fresh DB)
              ├─ test:unit:ci        → spec log + unit.junit.xml
              ├─ test:integration:ci → spec log + integration.junit.xml
              └─ always(): job summary + upload artifact "test-results"
```

### 2.1 Repository and visibility
- **Recommendation: a public repository named `monetalab`.** Reasons:
  1. It's a portfolio piece, and reviewers need to see the code, PRs and Actions runs.
  2. On **GitHub Free, branch protection and rulesets are only available for public repos.** A private repo would need GitHub Pro to meet the "required status check" part of this slice.
  3. Standard GitHub-hosted runners are free for public repos. Private repos have a monthly minutes quota.
- **Consequences of going public:** `CLAUDE.md`, the PRD, `prompts/` and `docs/` all become public. Nothing in them is secret, but this is your call. Also the commit author email, see D-S2-05.
- **You create it** in the GitHub web UI, **empty**: no README, license or `.gitignore`, so the first push doesn't conflict. Claude Code doesn't create remote repos. A license is optional and your decision; I'm not proposing one.

### 2.2 Branch structure and first commits
- `main` is the protected integration branch. All work after the baseline arrives through **one feature branch and PR per slice** (`slice-2-ci`, `slice-3-auth`, …). Branches are deleted after merge.
- `package.json` and `package-lock.json` already contain both Slice 0 and Slice 1, so the baseline is **two commits on `main`**, pushed *before* branch protection exists:

| # | Commit message | Contents |
|---|---|---|
| 1 | `docs: project instructions and planning baseline` | `.gitignore` (hardened), `CLAUDE.md`, `product-requirements.md`, `START-HERE.md`, `prompts/01-first-session.md`, `docs/initial-implementation-plan.md` |
| 2 | `feat: credit allocator and PostgreSQL foundation (Slices 0–1)` | `backend/**` (minus ignored files), `docker-compose.yml`, `docs/decisions.md`, `docs/slice-0-verification.md`, `docs/slice-1-verification.md`, `docs/slice-2-plan.md` |

- All Slice 2 changes then go on `slice-2-ci`, and the **PR into `main` is the CI-01 evidence.**
- No force pushes and no history rewrites. Each commit or push only happens with explicit approval.

### 2.3 Workflow triggers and permissions
- File: `.github/workflows/api-regression.yml`, workflow name `API/DB regression`, job ID and name **`api-db-regression`** (this becomes the required check name).
- Triggers:
  - `pull_request` to `main`, which is the required path.
  - `push` to `main`, to check the merged result.
  - `workflow_dispatch`, for manual re-runs.
- **No `paths` filter.** A required check with a path filter never reports on docs-only PRs, and that blocks merging.
- **`pull_request`, not `pull_request_target`.** Fork PRs run with a read-only token and no secrets.
- `permissions: contents: read` at the top level. Nothing else.
- `concurrency: { group: api-regression-${{ github.ref }}, cancel-in-progress: true }`.
- `defaults.run`: `shell: bash`, which makes `-eo pipefail` explicit so a failing test can't be hidden by `tee`. Also `working-directory: backend`.

### 2.4 PostgreSQL 16 service container
```yaml
services:
  postgres:
    image: postgres:16.16-alpine        # same version as the local server
    env:
      POSTGRES_USER: monetalab
      POSTGRES_PASSWORD: monetalab_local_only   # disposable CI-only value, not a secret
      POSTGRES_DB: monetalab
    ports: ["55432:5432"]
    options: >-
      --health-cmd "pg_isready -U monetalab -d monetalab"
      --health-interval 2s --health-timeout 3s --health-retries 30
```
- The runner waits for the health check before running any steps.
- The same port as local (P-004) means `DATABASE_URL` is identical everywhere.
- The service user is a superuser, which P-003 needs: each test file runs `CREATE DATABASE` and `DROP DATABASE`.
- **Also pin `docker-compose.yml` to `postgres:16.16-alpine`,** so local and CI use the same server version. This is a one-line infra change, not application code.

### 2.5 Version pinning
| What | How |
|---|---|
| Node | New `.nvmrc` containing `24.20.0`, the version verified locally. `setup-node` uses `node-version-file: .nvmrc`. Change `engines.node` to `>=24.2`, because `migrate.ts` uses `import.meta.main`, added in 24.2. |
| npm dependencies | Already pinned exactly. CI uses `npm ci`, which fails if the lockfile and `package.json` disagree. Cache via `setup-node` with `cache: npm` and `cache-dependency-path: backend/package-lock.json`. |
| npm itself | Comes bundled with the Node version. No separate pin, to keep it simple. |
| GitHub Actions | `actions/checkout`, `actions/setup-node` and `actions/upload-artifact` pinned to a **full commit SHA** with a `# vX.Y.Z` comment. The SHAs will be looked up when the workflow is written. |
| Runner OS | `ubuntu-24.04`, not `ubuntu-latest`, so OS upgrades are deliberate. |
| Postgres | `16.16-alpine` (see 2.4). |

### 2.6 Workflow steps
| # | Step | Command | Purpose |
|---|---|---|---|
| 1 | Checkout | `actions/checkout@<sha>` | — |
| 2 | Node | `actions/setup-node@<sha>` | Exact Node version and npm cache |
| 3 | Install | `npm ci` | Install exactly what the lockfile says |
| 4 | Typecheck | `npm run typecheck` | Strict TypeScript |
| 5 | Migrate | `npm run db:migrate` | Proves the schema applies to a **fresh** server |
| 6 | Unit tests | `npm run test:unit:ci` | 19 tests today |
| 7 | Integration tests | `npm run test:integration:ci` | 32 tests today, each file in its own throwaway DB (P-003) |
| 8 | Summary | `if: always()`, add the `ℹ tests/pass/fail` lines from both spec logs to `$GITHUB_STEP_SUMMARY` | Results readable without opening logs |
| 9 | Artifact | `if: always()`, `actions/upload-artifact@<sha>` | See 2.7 |

**New npm scripts** (the only `package.json` changes besides `engines`):
```
"test:unit:ci":        node --test --test-reporter=spec --test-reporter-destination=stdout
                         --test-reporter=junit --test-reporter-destination=test-results/unit.junit.xml
                         "tests/unit/**/*.test.ts"
"test:integration:ci": (same, writing test-results/integration.junit.xml)
```
These use only Node's built-in reporters, with no new dependency. Locally, `npm run db:up && npm run test:integration:ci` reproduces CI exactly.

### 2.7 Test reporting and artifacts
- **Artifact** `test-results-attempt-${{ github.run_attempt }}`, which avoids name clashes on re-runs:
  - Contents: `backend/test-results/*.junit.xml` and the two spec logs.
  - `retention-days: 14`, `if-no-files-found: warn`, so a crash before any reports are written still shows the real error.
- **Job summary:** test, pass and fail counts per suite, shown on the run page.
- **Correction to the original plan:** it said "Playwright HTML report". Playwright isn't used until Slice 3 (P-002), so Slice 2 reports JUnit XML. The Playwright HTML report joins the same artifact in Slice 3.
- **Not adding** third-party JUnit annotation actions. They need `checks: write` and add a supply-chain dependency.

### 2.8 Environment variables and credentials
- One job-level variable: `DATABASE_URL: postgres://monetalab:monetalab_local_only@127.0.0.1:55432/monetalab`.
- **GitHub Secrets are deliberately not used for these.** The credentials are disposable and only valid inside an ephemeral, localhost-only container. Using secrets would:
  1. suggest a sensitivity that isn't there, and
  2. break CI for fork PRs, which don't receive secrets.
- No secret is printed or stored. `config.ts` already defaults to the same URL. `.env*` stays ignored.
- **Future real secrets** (M3 Apple credentials) must use GitHub Environments with protection rules. They must never be available to PR-triggered workflows, and are out of scope here.

### 2.9 Branch protection (owner action in repo Settings → Rules)
A **ruleset** (or classic branch protection) on `main`:
- Require a pull request before merging, with **0 required approvals**. A solo owner can't approve their own PR on GitHub, so requiring 1 would block every merge.
- Require the status check **`api-db-regression`**, and require branches to be up to date before merging.
- Block force pushes and branch deletion.
- **Don't allow bypass,** including for admins, so the CI evidence is honest. You can relax this later.
- The check only appears in the picker **after the workflow has run once.** That's why the order is: push branch → run → configure → verify.

---

## 3. Implementation steps (each ends with a checkpoint)

| Step | Who | Change | Verification | Approval gate |
|---|---|---|---|---|
| **S2.0** | Owner | Create the empty public repo `monetalab`. Decide on the commit email. Have push credentials (HTTPS token or SSH key) ready. | You send the repo URL. | — |
| **S2.1** | Claude | Harden `.gitignore` (section 1). | `git status --ignored`. `git check-ignore -v` on a dummy `x.p8`, `x.log`, `.claude/settings.local.json`. Re-run the secret scan. | Show the diff |
| **S2.2** | Claude, then owner | `git remote add origin <url>`, the two baseline commits (2.2), and a push to `main`. | `git log --oneline`, `git ls-files` has no ignored or secret files, the remote shows 2 commits. | **Explicit commit and push approval** |
| **S2.3** | Claude | Create branch `slice-2-ci`. Add `.nvmrc` (24.20.0), `engines >=24.2`, and the Postgres pin in compose. | `npm run db:down && npm run db:up` (the 16.16 image), `SHOW server_version` = 16.16, then `npm run typecheck && npm test`. | — |
| **S2.4** | Claude | Add `test:unit:ci` and `test:integration:ci`. | Run both locally. The XML files exist, are well-formed (`xmllint --noout`, built into macOS), and report 19 and 32 tests. | — |
| **S2.5** | Claude | Write `.github/workflows/api-regression.yml` (section 2). | YAML parses. *Optional:* `actionlint` via its Docker image (pulls an image, needs your OK). Check against the review list: permissions, SHA pins, no secrets, no path filter. | — |
| **S2.6** | Claude, then owner | Commit, push `slice-2-ci`, open the PR. Without `gh`, you open it via the URL GitHub prints. | The Actions run is green, the job summary shows 19/19 and 32/32, and the artifact downloads with both XML files. Logs show Postgres 16.16 and Node 24.20.0. | **Commit and push approval** |
| **S2.7** *(optional, recommended)* | Claude, then owner | Throwaway branch `ci-negative-demo` that breaks one assertion. | The PR shows a **red** `api-db-regression`. The PR is closed **without merging** and the branch deleted. | Push approval |
| **S2.8** | Owner | Configure the ruleset (2.9). | The `slice-2-ci` PR shows "Required" next to `api-db-regression`. A direct push to `main` is rejected. (A test push of an empty commit is optional and needs your OK.) | — |
| **S2.9** | Claude, then owner | Write `docs/slice-2-verification.md` (run URLs, counts, artifact, screenshot references) and commit it to the PR. You merge the PR. | The `push`-to-`main` run after merging is green. | Commit approval and owner merge |

---

## 4. Definition of Done (Slice 2)
1. A public (or owner-chosen) GitHub repo exists, and `main` contains the reviewed baseline. `git ls-files` contains no secrets, signing material, `node_modules`, `.env` files or `.DS_Store`.
2. `.github/workflows/api-regression.yml` runs on every PR to `main`. It has `contents: read` only, SHA-pinned actions, no secrets, and no path filter.
3. CI runs `npm ci`, typecheck, migrations against a fresh Postgres 16.16 service, and unit and integration tests, using Node 24.20.0 from `.nvmrc`.
4. A green run on the `slice-2-ci` PR, with **19/19 unit** and **32/32 integration** (or the current counts), visible in the job summary.
5. The JUnit artifact is downloadable from that run.
6. *(If S2.7 is approved)* a failing test turns the check red, and that PR is closed unmerged.
7. `main` requires a PR and the passing `api-db-regression` check. Force push and deletion are blocked.
8. The local `npm run test:*:ci` commands reproduce CI. The README stub, if approved, documents them truthfully.
9. `docs/slice-2-verification.md` records exact commands, run URLs and results. Anything not run is marked NOT RUN.

---

## 5. Review of proposals P-001 to P-004
These are recommendations only. Their status in `docs/decisions.md` is unchanged.

| ID | Recommendation | Reasoning |
|---|---|---|
| **P-001** (seed via DB, no HTTP endpoint) | **Approve in principle. Finalize details before Slice 4/6, not now.** | It's the right shape for DV-003: no backdoor, and seeds are auditable. Suggested details for later: (a) a new migration adds `SEED` to the ledger `entry_type` with a mandatory reason; (b) seeding goes through one function used by both the test helpers and a `db:seed:demo` CLI; (c) the CLI refuses to run when `NODE_ENV=production` or against a DB not on an allowlist; (d) a test proves no HTTP route can seed. Slice 2 doesn't need it. |
| **P-002** (`node:test` for DB tests, Playwright for HTTP from Slice 3) | **Approve.** | DB constraint tests aren't HTTP tests, and `node:test` adds no dependency and already gives JUnit output for CI. The cost is two runners and two report formats from Slice 3 on, which is manageable in one artifact. |
| **P-003** (one throwaway DB per test file) | **Approve.** | It ran cleanly 4 times locally with nothing left behind. It works the same with the CI service container, because the service user is a superuser. Risk: if CI ever uses a restricted DB role, that role needs `CREATEDB`. |
| **P-004** (`127.0.0.1:55432`, local password `monetalab_local_only`) | **Approve, with the addition of pinning the image to `16.16-alpine`** (D-S2-07). | Avoids clashes with other local Postgres instances. CI reuses the same URL, so there's no environment-specific config. The password is documented as non-secret. |

Approving P-002 to P-004 before S2.6 is recommended, because CI will make them part of the published process.

---

## 6. Risks, blockers and missing dependencies

| # | Item | Type | Impact | Mitigation |
|---|---|---|---|---|
| R1 | No GitHub repo, remote or push credentials | **Blocker** | Steps S2.2 onward | S2.0 (owner) |
| R2 | `gh` CLI not installed | Missing tool (optional) | PRs and rulesets are done in the web UI | Use the web UI. Install `gh` only if you want it. |
| R3 | TypeScript 7 (a new major, native binary) | Risk | `tsc` could fail on Linux | The lockfile has the `linux-x64` entry. The first CI run confirms it. Fallback: pin 5.x (D-S2-11). |
| R4 | Making `CLAUDE.md`, PRD, prompts and docs public | Owner decision | Content becomes public | No secrets found. Owner confirms visibility (D-S2-01). |
| R5 | Commit author email public | Privacy | Email exposed in history | Switch to the GitHub noreply address before commit 1 (D-S2-05). It can't be changed later without rewriting history. |
| R6 | Required check name mismatch, or check never reported | CI config | PRs can't be merged | Stable job ID `api-db-regression` and no path filter. Configure protection only after the first run (S2.8). |
| R7 | Concurrency tests flaky on a slower shared runner | Test risk | Intermittent red | The tests check outcome counts, not timing. 4 local runs were stable. If it does happen, investigate rather than retry blindly. |
| R8 | Postgres version drift | Reproducibility | "Works locally, fails in CI" | Pin `16.16-alpine` in both places (D-S2-07). |
| R9 | Third-party action supply chain | Security | Compromised action | Use official `actions/*` only, pinned by SHA, with least-privilege permissions. |
| R10 | Branch protection unavailable on private Free repos | Plan limitation | DoD item 7 can't be met | Public repo, or GitHub Pro (D-S2-01). |
| R11 | `actionlint` not installed | Missing tool (optional) | Weaker static check | Optional Docker run, or rely on the real run (S2.6). |

---

## 7. Decisions requiring owner approval

| ID | Decision | Recommendation |
|---|---|---|
| D-S2-01 | Repo visibility | **Public** (needed for free branch protection and the portfolio) |
| D-S2-02 | Repo name and who creates it | `monetalab`, created by the owner, empty |
| D-S2-03 | Two baseline commits pushed directly to `main` before protection | Approve |
| D-S2-04 | Who runs `git push`: owner or Claude | Your choice. Claude runs it only when told to each time. |
| D-S2-05 | Commit author email | Use the GitHub noreply address |
| D-S2-06 | Pin Node `24.20.0` in `.nvmrc`, and `engines >=24.2` | Approve |
| D-S2-07 | Pin Postgres `16.16-alpine` in compose and CI | Approve |
| D-S2-08 | Actions pinned by full SHA, `ubuntu-24.04` | Approve |
| D-S2-09 | JUnit XML and job summary as the report until Playwright arrives in Slice 3 | Approve |
| D-S2-10 | Branch protection: required PR, 0 approvals, required `api-db-regression`, up-to-date branch, no bypass | Approve |
| D-S2-11 | TypeScript 7.0.2 vs 5.x (open since Slice 0) | Keep 7.0.2 unless CI shows a problem |
| D-S2-12 | Optional negative-demo PR (S2.7) | Approve. Strong QA evidence at low cost. |
| D-S2-13 | Optional minimal `README.md` stub with real local and CI commands. The full README stays in Slice 9. | Approve. A public repo needs at least truthful run instructions. |
| D-S2-14 | Optional `actionlint` via Docker image | Optional, low priority |
| — | P-001 to P-004 | See section 5 |

Once approved, the agreed decisions should be recorded in `docs/decisions.md` as part of S2.1. I haven't done that yet.
