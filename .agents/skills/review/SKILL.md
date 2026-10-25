---
name: review
description: Use when asked to review a diff, branch, PR, or set of files. Reports high-confidence bugs, security issues, and convention violations without editing code.
---

# Review

1. **Get the change.** Use `git diff` (staged and unstaged) or the branch diff against the base, and read the surrounding code. Compare against `AGENTS.md`, `CLAUDE.md`, and `CONTRACTS.md`.
2. **Check, in priority order:**
   - **Correctness:** damage, timing, cooldown, KO, deduped `inputId`, and tracking-loss handling; client sending damage, a winner, or a fighter slot; bot and human paths diverging under the same state
   - **Determinism:** RNG or clock use inside the engine, HTTP or LLM calls from reducers, two matches sharing mutable state
   - **Contract drift:** `CONTRACTS.md` disagreeing with engine punch names or the CV mapping, `engine/engine.ts` out of sync with `spacetimedb/src/engine.ts`, coach advice the active input cannot perform
   - **Safety:** keys or webcam frames leaving the client or landing in git, unbounded profile history, unclamped strategy patches that can set health, damage, or the winner
   - **Conventions:** combat rules leaking into reducers or the scene, new dependencies, invented scripts
3. **Verify claims** by running `bun run test` or reading the cited path; don't report problems you haven't confirmed.
4. **Report** findings ordered by severity, each with file, line, the problem, and a suggested fix. Skip style nitpicks and pre-existing issues. If nothing significant is found, say so.

Findings only, one short entry each. No summary of the diff and no praise or filler.
