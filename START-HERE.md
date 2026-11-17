# MonetaLab — Starting with Claude Code

This is the **planning bootstrap**, not an implemented application.

1. Create an empty local directory named `monetalab` (or unpack the accompanying zip).
2. Place `CLAUDE.md` and `product-requirements.md` at its root, and keep `prompts/01-first-session.md` inside `prompts/`.
3. Open a terminal in the `monetalab` directory and run `claude` (provided Claude Code is installed and authenticated).
4. Copy the contents of `prompts/01-first-session.md` into the Claude Code session, or reference that file with a request to follow it.
5. Review Claude's proposed M1 plan before approving **any** edits or dependency installation.
6. Keep Apple Developer Program, StoreKit/TestFlight, subscriptions, and rewarded ads for their designated later milestones.

`CLAUDE.md` is the always-on instruction file; `product-requirements.md` is the detailed product specification; `prompts/01-first-session.md` is a one-time task prompt.

After the initial plan is approved, add code incrementally, making sure each slice has executable tests and an explicit definition of done. Do not run `/init` in a way that overwrites the prepared `CLAUDE.md`.
