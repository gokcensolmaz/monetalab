# Slice 2 — CI Verification (S2.6–S2.9)

**Date:** 2026-11-17
**Acceptance target:** PRD **CI-01**: an open PR runs a deterministic API/DB regression with an accessible report.
**Related:** `docs/slice-2-plan.md`, `docs/slice-2-local-verification.md`, `docs/slice-2-git-review.md`, decisions D-013 to D-015.

## Evidence sources

Each result below is labelled with its source:

| Label | Meaning |
|---|---|
| **[API]** | Claude Code checked it independently through GitHub's **public, unauthenticated REST API** on 2026-11-17. |
| **[OWNER]** | The product/QA owner reported it. Claude Code could **not** check it independently: it needs authentication (artifact download, job logs, job summary, some repository settings), and the `gh` CLI isn't installed. |
| **[LOCAL]** | Claude Code checked it locally. See `docs/slice-2-local-verification.md`. |

## 1. Links

| Item | URL |
|---|---|
| Repository | https://github.com/gokcensolmaz/monetalab |
| Pull request #1 | https://github.com/gokcensolmaz/monetalab/pull/1 |
| Workflow run (first PR run) | https://github.com/gokcensolmaz/monetalab/actions/runs/44099978573 |

## 2. First PR run: results

| Check | Result | Source |
|---|---|---|
| Workflow, event | `API/DB regression`, `pull_request` | [API] |
| Head | `slice-2-ci` @ `18bd98c58b91b2e68bfecf4d5b0dc14db81c93f1`, linked to PR #1 | [API] |
| Status / conclusion | `completed` / **`success`**, attempt 1 | [API] |
| Timing | Created 14:09:08Z, job 14:09:12Z to 14:09:37Z (about 25 s) | [API] |
| Job | `api-db-regression` on `ubuntu-24.04`, conclusion `success` | [API] |
| Steps | All **12** workflow steps `success`: Checkout, Set up Node (`.nvmrc`), `npm ci`, Record versions, Typecheck, Migrate fresh DB, Unit tests, Integration tests, Job summary, Upload artifact (plus setup and teardown) | [API] |
| Artifact | `test-results-attempt-1`, 5,036 bytes, not expired, expires **2026-12-01T14:09:31Z** (14-day retention as designed), digest `sha256:4cc831041d4148e0b3eaab1b5b23c7f267c98c4a765561348c7ca30bd9a28220` | [API] |
| Artifact contents | **19 passing unit tests and 32 passing integration tests, valid JUnit XML, no failures** (D-015c) | [OWNER] |
| Job summary content; Node 24.20.0 and Postgres 16.16 in the logs | Not independently viewed: logs and summary need authentication | Not checked by Claude |
| Same commands in a simulated fresh checkout | 19/19 and 32/32, Node 24.20.0, Postgres 16.16, well-formed JUnit | [LOCAL] |

## 3. Branch protection (`main`)

| Check | Result | Source |
|---|---|---|
| `main` protected | `protected: true`, `protection.enabled: true` (classic branch protection; no rulesets apply) | [API] |
| Required status check | **`api-db-regression`**, bound to app ID 15368 (GitHub Actions) | [API] |
| Enforcement level | `everyone` (applies to admins too) | [API] |
| `api-db-regression` configured as required | Confirmed | [OWNER] |
| Require PR before merging, require up-to-date branch, block force pushes and deletion (D-S2-10) | **Not visible to the anonymous API.** Not independently checked. | Not checked by Claude |

## 4. Re-run after this document's commit

This document was committed alone to `slice-2-ci` and pushed. The resulting PR check run is recorded in the PR itself and summarized in Claude Code's S2.9 report to the owner. It isn't repeated here, because a file can't contain the result of the run its own commit triggers.

## 5. Definition of Done (from `docs/slice-2-plan.md` §4)

| # | DoD item | Status |
|---|---|---|
| 1 | Public repo, reviewed baseline on `main`, no secrets or generated files | ✅ [LOCAL] scans, commit history, D-013 |
| 2 | Workflow on PRs to `main`, `contents: read`, SHA-pinned, no secrets, no path filter | ✅ [LOCAL] policy checks 18/18. Triggered by the PR [API]. |
| 3 | `npm ci`, typecheck, migrations on fresh Postgres 16.16, unit and integration tests, Node 24.20.0 | ✅ steps succeeded [API]. Versions in the CI log not independently viewed. |
| 4 | Green run on the PR with 19/19 and 32/32 | ✅ green [API], counts [OWNER] |
| 5 | Downloadable JUnit artifact | ✅ exists [API], contents [OWNER] |
| 6 | *(optional S2.7)* Red check on a failing test | ⏸ Not done on GitHub (D-S2-12 open). Failure propagation verified locally only [LOCAL]. |
| 7 | `main` requires PR and passing check; force push and deletion blocked | ◐ Required check verified [API]. The other settings are [OWNER] / not checked. |
| 8 | Local `npm run test:*:ci` reproduces CI | ✅ [LOCAL]. A README stub isn't created (D-S2-13 open). |
| 9 | Verification doc with commands, URLs and results | ✅ this document |

## 6. Limitations

1. Claude Code had **no authenticated GitHub access**. Artifact contents, job logs and the job summary are owner-verified only.
2. **S2.7 (negative-demo PR) wasn't run on GitHub.** That a failing test turns the check red is shown only in a local simulation.
3. **`actionlint` wasn't run** (D-S2-14 open). The successful GitHub run is the practical validation of the workflow.
4. **The JUnit artifacts include runner hostnames and absolute runner paths.** Public-repo artifacts can be downloaded by signed-in GitHub users. No secrets are involved.
5. **No update policy (for example Dependabot) for SHA-pinned actions or npm dependencies.** Updates are manual and deliberate.
6. **No iOS CI** yet (Slice 7). **No Playwright HTML report** yet (Slice 3).

## 6a. Post-merge run on `main` (added 2026-11-17, after PR #1 was merged)

| Check | Result | Source |
|---|---|---|
| PR #1 | `closed`, `merged=true`, merge commit `0d463312888502692768d1aa5f867f90f7b30f51`, merged 2026-11-17T14:32:32Z | [API] |
| Local `main` | Fast-forwarded with `git pull --ff-only` from `0db5d23` to `0d46331`. Equal to `origin/main`, clean tree, nothing reset or forced. | [LOCAL] |
| Run | https://github.com/gokcensolmaz/monetalab/actions/runs/44104246387 | [API] |
| Event / branch / head | `push` / `main` / `0d46331` (the merge commit) | [API] |
| Status / conclusion | `completed` / **`success`**, attempt 1, 14:32:35Z to 14:33:14Z | [API] |
| Job | `api-db-regression` on `ubuntu-24.04`: `success`. All 12 workflow steps (Checkout to Upload test results) plus setup and teardown `success`. | [API] |
| Artifact | `test-results-attempt-1`, 5,010 bytes, not expired, expires 2026-12-01T14:33:06Z, digest `sha256:493fef64c6063b007d5dbebcc12a938e941072ec94c9808e7cf3b561c457a498` | [API] |
| Test counts (19 unit / 32 integration) in this run | **NOT VERIFIED.** The anonymous API refused the artifact download (`HTTP 401`) and the job logs (`HTTP 403`). The successful Unit tests and Integration tests steps mean no test failed, but the counts weren't seen. | — |

## 7. Remaining work

- **Owner:** review PR #1 and merge it. Merging is the owner's decision. After the merge, the `push`-to-`main` run should be checked.
- **Open decisions:** D-S2-12 (negative-demo PR), D-S2-13 (README stub), D-S2-14 (`actionlint`).
- **Deferred verification:** DV-001 and DV-002 (Slices 5–6). DV-003 / P-001 seeding design (before Slice 6).
- **Next slice:** Slice 3 (auth). Not started; needs owner approval.
