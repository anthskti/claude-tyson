---
name: debug
description: Use when investigating a bug, error, failing build, or unexpected behavior in this repo. Finds the root cause with evidence, then applies a minimal fix.
---

# Debug

1. **Reproduce.** Get the exact error, input, or fight sequence. Run the narrowest check: `bun test` on the touched file, or the arena (`bun dev/server.ts`) for client behavior. If you can't reproduce it, say so and list what you need.
2. **Localize.** Trace the path: input (`input/cvKit.ts`, `keyboard.ts`, `motion.ts`) → reducer (`spacetimedb/src/index.ts`) → engine (`engine/engine.ts` and its copy `spacetimedb/src/engine.ts`) → subscribed client (`client/`). For coach bugs, check capabilities, the scheduler, and the offline fallback before blaming the model. If the two engine files differ, the copy is stale.
3. **Form a hypothesis and test it.** Confirm the root cause with evidence (a failing test, logs, a reducer row, reading the code path), not by guessing. Client timestamps are diagnostic; server time decides hits.
4. **Fix minimally.** Change the cause, not the symptom, and don't refactor around it. Add a regression test next to the existing bun or vitest tests when the bug is in combat, input, or coach logic. Re-run `./sync-engine.sh` if the engine changed.
5. **Verify** that the original reproduction now passes and that neighboring cases still pass (`bun run test`, or the same browser flow for UI bugs).
6. **Report:** root cause, fix, verification, and any related risk you noticed but didn't change.

Never print `.env` or `.env.local` contents. Don't call live Claude or Cartesia while debugging; use the offline coach path.

Keep the report to root cause, fix, and verification, one or two lines each. Don't narrate the investigation.
