---
name: plan
description: Use when asked to plan, scope, design, or break down a feature or change before coding. Produces a written plan; makes no code edits.
---

# Plan

1. **Clarify the goal.** Restate it in one or two sentences. If a decision materially changes the architecture or scope and can't be inferred from the code, `AGENTS.md`, or `CLAUDE.md`, ask before planning. Otherwise use the simplest documented assumption and name it.
2. **Explore.** Read `AGENTS.md`, `CLAUDE.md`, `docs/PROJECT_CONTEXT.md`, and the code involved. Follow the existing pattern. Where `AGENTS.md` / `CONTRACTS.md` disagree with the running code, follow the code and flag the discrepancy. Design shapes live in `CONTRACTS.md`.
3. **Identify the blast radius.** Note which layers change: pure engine (`engine/engine.ts`, must be copied with `./sync-engine.sh`), SpacetimeDB reducers (`spacetimedb/src/`), input (`input/`), coach (`coach/`), or the scene (`src/game/`). Call out contract changes, new dependencies, and new secrets or env vars.
4. **Write the plan:**
   - Goal and non-goals
   - Ordered steps, each naming the files to change and the intent
   - Contract changes in `CONTRACTS.md`, engine-copy sync, new dependencies or env vars
   - Risks: non-determinism, LLM calls inside reducers, coach advice beyond the active input capabilities, tracking-loss / unscorable punches, match state leaking across matches
   - How to verify (`bun run test`; for client or arena UI, the browser flow)
5. Keep it short and concrete. Stop and wait for approval before implementation.

Output stays concise: for a complex task start with the approach, then the numbered plan. No restating the request.
