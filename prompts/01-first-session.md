# Claude Code — first session (planning only)

You are the implementation engineer for MonetaLab, a deliberately small mobile monetization QA portfolio project.

Before doing anything else, read `CLAUDE.md` and `product-requirements.md` completely. The human user is the product owner and QA owner; do not make unapproved product decisions.

**This session is PLANNING ONLY. Do not create/edit files, install packages, run generators, make commits, or begin implementation.** You may inspect the repository and read documentation.

Produce the following, concisely:

1. Your understanding of the M1 objective and what is explicitly OUT OF SCOPE until M2/M3/M4.
2. Proposed minimum architecture and repository layout for SwiftUI, Node.js/TypeScript REST API, PostgreSQL, API/database tests, and GitHub Actions. Explain only meaningful trade-offs.
3. A sequence of small, independently verifiable implementation tasks (aim for PR-sized slices), with acceptance criteria and commands/tests that will validate each slice once implemented.
4. The **single smallest first implementation task** you recommend, describing exactly what files you expect to create and how we will verify it.
5. Any requirements that genuinely block that *first task*; do not ask for decisions that can wait for a later milestone.
6. Your proposed strategy to avoid large context windows and feature creep. Do not create agents, skills, hooks, or MCP connections yet.

Constraints:
- Treat `product-requirements.md` as the product source of truth.
- Preserve credit consumption priority: SUBSCRIPTION > CONSUMABLE > REWARD > PROMOTIONAL.
- Do not claim StoreKit or Apple sandbox functionality exists in M1.
- Never invent test results or assume a working environment before checking.

Stop after the plan and ask for approval before implementing the first slice.
