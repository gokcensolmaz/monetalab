# MonetaLab — Claude Code Project Instructions

## Mission
Build a small, reproducible **QA portfolio fixture**, not a production app or a feature-rich consumer product. The implementation must demonstrate monetization business rules through independently verifiable API, database, iOS, and CI tests.

**Product and QA owner:** the human user. **Implementation assistant:** Claude Code. Product decisions and acceptance always belong to the human.

## Sources of truth
- `product-requirements.md`: approved product requirements, phased scope, acceptance criteria, and explicitly unresolved decisions.
- This `CLAUDE.md`: engineering and working rules.
- If a requirement is ambiguous or unresolved, identify it rather than inventing policy. Do not silently change product requirements.
- Do not interpret future-milestone requirements as permission to implement them now.

## Current delivery gate: M1 ONLY
The first release must include authentication, wallet with four credit buckets, deterministic mock consumable purchasing, ordered atomic credit spending, insufficient-credit paywall, history, API/DB tests, and GitHub Actions PR regression. A minimal iOS user interface should exercise these paths.

Do **not** implement subscription lifecycle, rewarded ads, Apple StoreKit/App Store Connect, TestFlight, Android, real payment providers, AI image generation, advanced agent orchestration, analytics dashboards, or live infrastructure in M1. Those are later milestones.

## Technology direction (proposed, subject to initial planning approval)
- iOS: SwiftUI.
- Backend: Node.js + TypeScript with a small REST API.
- Database: PostgreSQL.
- Tests: Playwright API tests and direct database assertions where appropriate.
- CI: GitHub Actions; Docker Compose for local isolated backend/database.
- Prefer stable, minimal dependencies. Explain any departure before proceeding.
- Do not claim commands are available until scripts/configurations have actually been created.

## Architecture rules
1. The backend is authoritative for credit balances, package fulfillment, and ledger history. The iOS app cannot grant credits directly.
2. Bucket priority is `SUBSCRIPTION -> CONSUMABLE -> REWARD -> PROMOTIONAL`; trial credits belong to SUBSCRIPTION.
3. Insufficient total credit must reject the whole operation without debiting any bucket.
4. All balance/ledger changes must be atomic; prohibit negative balances and duplicate fulfillment. Use database constraints, transactions, idempotency identifiers, and concurrency tests.
5. Preserve transaction history. Expiration/reversal is auditable; do not erase ledger events.
6. Mock purchase responses must be deterministic and test-controlled, and mock endpoints/fixtures must not become public production backdoors.
7. Separate billing provider contracts from implementations so later StoreKit integration does not require a rewrite.
8. Store no real secrets, signing material, personal credentials, proprietary app source, or Apple test credentials in Git.

## Delivery workflow: small verified slices
- Before implementation: read the relevant sections of `product-requirements.md`, identify the smallest slice, state acceptance criteria, and propose the exact files/commands to change.
- At the beginning of this project: **planning only until the user approves the first implementation task.** No project scaffolding, dependency installation, file modifications, or commits during the initial review.
- After approval: implement ONE bounded slice at a time, with tests close to the behavior being added.
- Avoid excessive abstractions, speculative frameworks, premature refactors, and unrelated improvements.
- Prefer readable implementation and independent test oracles over high test counts.
- For each finished slice, report changed files, what was tested, exact commands and results, known gaps, and next smallest slice.
- Never claim tests passed without executing them. If execution is unavailable, say `NOT RUN` and explain why.
- Do not use destructive shell commands, force pushes, or git history rewrites without explicit approval.

## QA evidence requirements
- Each story needs testable acceptance criteria and at least one meaningful positive or negative automated assertion.
- Explicitly test insufficient credits, duplicate purchases, concurrency/atomicity, cross-user isolation, and immutable/auditable history where applicable.
- Isolate test data between users and CI runs; make regressions reproducible.
- Keep README instructions truthful and runnable; distinguish mock behavior from real Apple integration.

## AI tooling policy
- Start with this file and ordinary Claude Code tools only.
- Add skills, subagents, hooks, MCP servers, project rules, and auto-memory workflows **only after** a specific repetitive problem has been identified and the user approves the addition.
- For each addition, explain purpose, invocation, context impact, security/permission needs, and a concrete demonstration of benefit.
- Keep a brief decision trail in documentation so AI workflow improvements are reviewable on GitHub.

## When stuck
- First try a small evidence-based diagnosis; do not iterate blindly or create large speculative changes.
- Surface a blocking decision, suggest a minimal option, and wait for the human when product semantics would change.
- Remember: a small, working, published M1 is more valuable than an unfinished comprehensive system.
