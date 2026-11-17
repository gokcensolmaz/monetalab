# Slice 2 — Git Security Review & Commit Preparation (S2.1 + S2.2 prep)

**Date:** 2026-11-17
**Scope:** S2.1 (harden `.gitignore`) and preparation for S2.2 (baseline commits). **No commits, branches, pushes, PRs or workflow files were created.**
**Inputs:** `CLAUDE.md`, `docs/decisions.md`, `docs/slice-2-plan.md`

> This file will be public. It deliberately leaves out the local git author name and email.

## 1. Remote

| Check | Result |
|---|---|
| Remotes before | None (`git remote -v` printed nothing) |
| Action | `git remote add origin https://github.com/gokcensolmaz/monetalab` |
| `git remote -v` after | `origin https://github.com/gokcensolmaz/monetalab (fetch)` / `(push)` |
| `GIT_TERMINAL_PROMPT=0 git ls-remote origin` (read-only) | Exit 0, **no refs**. The repo can be read without credentials (consistent with **public**) and is **empty**, as S2.0 requires. |

## 2. `.gitignore` hardening (S2.1)

Added, as in `docs/slice-2-plan.md` §1: `*.log`, `blob-report/`, `playwright/.cache/`, `*.pem`, `*.key`, `*.p8`, `*.p12`, `*.cer`, `*.mobileprovision`, `*.provisionprofile`, `.claude/settings.local.json`. All existing rules are kept.

`git check-ignore -v --no-index` on hypothetical paths (no files were created):

| Expected | Paths | Result |
|---|---|---|
| Ignored | `.env`, `.env.local` | ✅ ignored |
| Ignored | `AuthKey_ABC123.p8`, `ios/dist.p12`, `ios/cert.cer`, `ios/Dev.mobileprovision`, `ios/x.provisionprofile`, `server.pem`, `private.key` | ✅ ignored |
| Ignored | `backend/npm-debug.log`, `backend/server.log`, `backend/test-results/unit.junit.xml`, `backend/playwright-report/index.html`, `blob-report/x`, `playwright/.cache/x`, `coverage/x` | ✅ ignored |
| Ignored | `.claude/settings.local.json`, `.DS_Store`, `backend/node_modules/…`, `ios/DerivedData/x`, `…/xcuserdata/x` | ✅ ignored |
| **Allowed** | `backend/.env.example`, `.claude/settings.json`, `backend/package-lock.json`, `backend/src/app.ts`, `docs/decisions.md`, `docker-compose.yml` | ✅ not ignored |

`backend/test-results/` is ignored, which fits CI: JUnit files are uploaded as artifacts, never committed.

## 3. Security inspection of the commit candidates

Candidates (`git ls-files --others --exclude-standard`) are **26 files**: the 25 found during the scan plus this report.

| # | Check | Result |
|---|---|---|
| 1 | Private key blocks (`-----BEGIN`) | None |
| 2 | Token patterns (GitHub `ghp_`/`github_pat_`, `sk-…`, AWS `AKIA…`, Slack `xox?-`, JWT-shaped strings) | None |
| 3 | Password/secret assignments | Only the documented, **non-secret local/CI** value `monetalab_local_only` (`docker-compose.yml`, `docs/slice-2-plan.md`; also inside the default URL in `backend/src/config.ts`). `health.test.ts` uses a dummy `nobody:nothing@127.0.0.1:1` URL that can't connect anywhere. Acceptable (D-012). |
| 4 | Email addresses | Only generated `@test.invalid` fixture addresses. **No personal email in any file.** |
| 5 | Absolute local paths or local username | None |
| 6 | Non-localhost IP addresses | None (only `127.0.0.1`) |
| 7 | Lockfile registries | Only `registry.npmjs.org`, no private registry URLs |
| 8 | Binary files or files > 100 KB | None |
| 9 | Generated artifacts (`node_modules`, `test-results`, logs, `.DS_Store`, coverage, build output) | None among the candidates. Five `.DS_Store` files and `backend/node_modules/` exist locally and are ignored. |
| 10 | Local configuration | No `.env`, IDE or Claude Code local settings among the candidates |

**Environment details that will become public** (low sensitivity, kept on purpose as QA evidence): OS family, Apple Silicon, Node, Docker and Postgres versions in the verification reports.

**Content made public by D-013:** `CLAUDE.md`, `product-requirements.md`, `START-HERE.md`, `prompts/`, `docs/`. Nothing secret was found in them.

## 4. Git author identity (D-S2-05, still open)

| Item | Finding |
|---|---|
| `user.name` | Set, in global `~/.gitconfig`. |
| `user.email` | Set, in global `~/.gitconfig`. It's a **personal `gmail.com` address, not a GitHub noreply address.** |
| Effect if unchanged | That address would be **permanently public** in the commit metadata of this public repo. Changing it later needs a history rewrite, which is forbidden without approval. |

**Recommendation:** commit with the account's GitHub noreply address. I won't guess it: its exact form depends on the account's numeric ID. To verify it:

1. On GitHub, go to **Settings → Emails**.
2. Enable **"Keep my email addresses private"**. GitHub then shows the exact address, in the form `<numeric-id>+<username>@users.noreply.github.com`.
3. *(Recommended)* Enable **"Block command line pushes that expose my email"**. GitHub will then reject any push whose commits contain the private address.
4. Set it for **this repository only**, so other projects aren't affected:
   `git config user.email "<address copied from GitHub>"`
   This is run by the owner, or by Claude once you give the verified address. It only writes `.git/config`, not the global `~/.gitconfig`.
5. Check: `git config user.email` inside the repo shows the noreply address.

Optionally, set `user.name` for this repo too, if the public display name should differ from the global one.

## 5. Prepared baseline commits (S2.2, not created)

`git add --dry-run` was used to confirm the exact file sets without staging anything.

### Commit 1: planning baseline
```
git add .gitignore CLAUDE.md product-requirements.md START-HERE.md \
        prompts/01-first-session.md docs/initial-implementation-plan.md
git commit -F - <<'EOF'
docs: project instructions and planning baseline

Product requirements, Claude Code project instructions, first-session
prompt, approved M1 implementation plan, and hardened .gitignore.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```
6 files.

### Commit 2: Slices 0–1
```
git add backend docker-compose.yml docs/decisions.md \
        docs/slice-0-verification.md docs/slice-1-verification.md \
        docs/slice-2-plan.md docs/slice-2-git-review.md
git commit -F - <<'EOF'
feat: credit allocator and PostgreSQL foundation (Slices 0–1)

- Pure credit allocator with bucket priority SUBSCRIPTION -> CONSUMABLE
  -> REWARD -> PROMOTIONAL and all-or-nothing insufficient-credit result
  (19 unit tests).
- PostgreSQL 16 via Docker Compose, plain-SQL migration runner, M1 schema
  with non-negative balances, idempotency keys, cross-user FKs and an
  append-only credit ledger (32 integration tests).
- Minimal GET /health.
- Decision log, Slice 0/1 verification reports, Slice 2 plan and Git
  security review.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```
20 files: 13 in `backend/` (including `package-lock.json`, excluding `node_modules`), plus `docker-compose.yml` and 5 docs.

**One addition to the plan's file list:** this report (`docs/slice-2-git-review.md`) didn't exist when the plan was written. It goes into commit 2 with the other Slice 2 docs.

### Push (S2.2, needs separate approval)
```
git push -u origin main
```
Precondition: D-S2-05 is resolved (the email is set), and D-S2-04 is decided (who pushes). Neither commit nor push will run without your explicit approval.

## 6. Verification commands run

| Command | Result |
|---|---|
| `git remote -v` | `origin` → `https://github.com/gokcensolmaz/monetalab` (fetch and push) |
| `git ls-remote origin` | Exit 0, no refs (empty public repo) |
| `git check-ignore -v --no-index …` | Section 2: all expected paths ignored, all expected tracked paths allowed |
| `git status --short` | Section 7 |
| `git add --dry-run` (both sets) | Section 7 |
| `git log` | `main` has no commits (unchanged) |

## 7. Final state (command output, 2026-11-17)

```
$ git status --short
?? .gitignore
?? CLAUDE.md
?? START-HERE.md
?? backend/
?? docker-compose.yml
?? docs/
?? product-requirements.md
?? prompts/

$ git remote -v
origin  https://github.com/gokcensolmaz/monetalab (fetch)
origin  https://github.com/gokcensolmaz/monetalab (push)

$ git log --oneline
fatal: your current branch 'main' does not have any commits yet

$ git diff --cached --name-only | wc -l      # index untouched
0
```

| Check | Result |
|---|---|
| `git add --dry-run` for the commit 1 set | 6 files |
| `git add --dry-run` for the commit 2 set | 20 files |
| Union of both sets vs `git ls-files --others --exclude-standard` | **Identical: 26 files.** Nothing is left out and nothing extra. |
| Docker volume `monetalab_monetalab-db` | Still present, untouched (D-015b) |

## 8. Decision log updates
`docs/decisions.md`:
- P-002, P-003 and P-004 are now **D-010, D-011, D-012** (approved).
- The repo is recorded as **D-013**.
- The Slice 2 plan approval is **D-014**, and your three additions are **D-015** (create the `test-results` dir, preserve Docker volumes, check artifact JUnit validity).
- **P-001** has moved to "Approved in principle, details deferred".
- **D-S2-04, 05, 12, 13 and 14** are listed as still open.

## 9. Needed from the owner before S2.2
1. **The verified GitHub noreply address** (section 4), or confirmation that you'll set it yourself.
2. **Who pushes** (D-S2-04).
3. **Explicit approval** to create the two commits as written in section 5, and to push.
