# Claude Tyson

Browser-based boxing game using Next.js, Three.js, Bun, and SpacetimeDB.
Repo: github.com/anthskti/claude-tyson. Do not push without asking Abdullah.

## Architecture

- `src/app/` contains the Next.js page and API routes.
- `src/game/` contains browser rendering, HUD, CV provider, and SpacetimeDB client.
- `spacetimedb/src/` owns match state, validation, combat resolution, profiles, and persistence.
- CV processing stays on the client. Send classified actions and tracking state; never send frames or raw landmark streams.
- Client animation may respond immediately, but server state decides accepted actions, damage, health, KO, and results.
- `input/` and `engine/` also support the standalone local arena in `dev/`; that arena is not the authoritative online game.
- Adaptive opponent strategy remains separate from live coaching. Model output may adjust bounded tactics, never health, damage, hit outcomes, or winner.

## Commands

- `bun run dev` serves Next.js at http://localhost:3001.
- `bun run build` builds the Next.js app.
- `bun run test` runs the engine/input tests and SpacetimeDB module tests.
- `bun run build:arena` builds the standalone arena; `bun run arena` serves it at http://localhost:8787.
- Local database: `spacetime start`, then `spacetime publish --anonymous --server local --module-path spacetimedb claude-tyson`.
- Regenerate bindings after schema changes with `spacetime generate --lang typescript --out-dir src/game/module_bindings --module-path spacetimedb`.

## Current notes

- The live game currently uses `SimulatedCvProvider`; connect the real CV provider through the same local input boundary before a webcam demo.
- The standalone arena uses its own local engine and is for input/animation experiments.
- `.env.example` contains the local SpacetimeDB host and database settings.
