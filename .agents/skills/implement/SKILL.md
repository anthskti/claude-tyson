---
name: implement
description: Use when asked to build a feature, make a code change, or carry out an approved plan in this repo. Makes the edits and verifies them.
---

# Implement

1. **Read before writing.** Read `AGENTS.md`, `CLAUDE.md`, and the neighboring modules. Mirror their naming, types, and error handling. Use the repo's actual scripts; don't invent commands or add dependencies without asking first.
2. **Make surgical edits.** Keep pure combat rules in `engine/`, reducers in `spacetimedb/src/`, camera classification in `input/`, coach logic in `coach/`, and rendering in `src/game/`. Don't reformat or refactor unrelated code. After editing `engine/engine.ts`, run `./sync-engine.sh` so `spacetimedb/src/engine.ts` matches.
3. **Honor the boundaries.**
   - Design-contract changes belong in `CONTRACTS.md`. Don't silently change combat vocabulary, damage, or action names.
   - The client never sends damage, hit decisions, a winner, or raw webcam frames. Server time decides hits.
   - No HTTP or LLM calls from deterministic combat reducers. Clamp model output; on timeout or a stale patch, keep the previous safe tactics.
   - Coach only what the active input can do (CV kit: punch_coarse, dodge, lean; keyboard: punch types, guard, dodge, lean).
   - API keys stay server-side (`.env.local`). Tracking loss pauses the fight; unscorable in-flight attacks stay out of stats.
4. **Verify.** Run `bun run test` (install `spacetimedb/` deps first if vitest can't start). For client, HUD, or arena changes, exercise the flow in the browser (arena: `bun dev/server.ts` at http://localhost:8787). Fix failures caused by your change; report pre-existing ones without fixing them.
5. **Update docs** only where the change makes `README.md`, `CLAUDE.md`, or `AGENTS.md` wrong.
6. **Report:** root cause or approach, files changed, tests run, remaining risks. Stop after the requested change. Don't push.

Keep the final report to those four items. Don't re-explain the request or narrate edits.
